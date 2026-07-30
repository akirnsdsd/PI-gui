//! W4 设置页「扩展」tab 的后端支撑：散放 skills / 扩展枚举、SKILL.md
//! frontmatter 解析、废纸篓移动、项目信任存储读写、MCP 配置合并与导入映射。
//!
//! 发现与匹配规则与 pi 0.81.1 对齐，证据：
//! - dist/core/skills.js `loadSkillsFromDirInternal`：目录含 SKILL.md 即 skill
//!   根且不再下钻；否则递归子目录（跳过 dot 目录与 node_modules）；仅顶层
//!   `includeRootFiles` 时散放 .md 算 skill。
//! - dist/core/package-manager.js `addAutoDiscoveredResources`：根列表与
//!   override baseDir；`collectAncestorAgentsSkillDirs`：项目 .agents/skills
//!   向上查到 git 根（含），排除 ~/.agents/skills。
//! - dist/core/package-manager.js `isEnabledByOverrides` /
//!   `matchesAnyPattern` / `matchesAnyExactPattern`：settings.json 的
//!   skills/extensions 数组里 `!`(glob) `-`/`+`(精确) 覆盖条目决定启用态。
//! - dist/core/extensions/loader.js `resolveExtensionEntries`：子目录
//!   index.ts/index.js 或 package.json 的 pi.extensions，只下钻一层。
//! - dist/core/trust-manager.js：trust.json { 规范化路径: true|false|null }，
//!   沿父目录向上取最近条目；键为 realpath 规范化路径。
//! - MCP 配置层叠顺序（低→高，同名高者生效）来自 pi-mcp-adapter README：
//!   ~/.config/mcp/mcp.json < ~/.agents/mcp.json < ~/.agents/mcp/mcp.json
//!   < <pi agent dir>/mcp.json < .mcp.json < .pi/mcp.json。

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::safe_config::{atomic_write, read_json_file, DirLock};

const TRUST_LOCK_TIMEOUT_MS: u64 = 10_000;
/// 递归发现 skill 的深度上限（pi 无显式上限；这里防御符号链接环）。
const MAX_SKILL_DEPTH: usize = 8;

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or(std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法确定用户主目录".to_string())
}

fn agent_dir() -> Result<PathBuf, String> {
    crate::get_pi_agent_dir().ok_or_else(|| "无法确定 pi agent 目录".to_string())
}

fn posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn rel_posix(path: &Path, base: &Path) -> String {
    match path.strip_prefix(base) {
        Ok(rel) => posix(rel),
        Err(_) => posix(path),
    }
}

/// 与 pi 的 canonicalizePath 对齐：realpath 失败时保留原路径。
fn canonicalize(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter 解析（极简 YAML 子集，只提取 name/description）
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
pub struct SkillFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

fn unquote(raw: &str) -> &str {
    let bytes = raw.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &raw[1..raw.len() - 1]
    } else {
        raw
    }
}

fn is_block_scalar_header(rest: &str) -> Option<char> {
    match rest {
        "|" | "|-" | "|+" => Some('|'),
        ">" | ">-" | ">+" => Some('>'),
        _ => None,
    }
}

/// 解析 SKILL.md 的 YAML frontmatter。
/// 支持行内值、单/双引号、`|`/`>` 块标量（含 chomping 标记）；嵌套 map
/// （如 `metadata:` 的子行）整体跳过。不是完整 YAML 解析器，只够提取列表
/// 展示所需的 name/description。
pub fn parse_skill_frontmatter(content: &str) -> SkillFrontmatter {
    let mut result = SkillFrontmatter::default();
    let mut lines = content.lines();
    let first = match lines.next() {
        Some(line) => line.trim_end(),
        None => return result,
    };
    if first != "---" {
        return result;
    }
    let collected: Vec<&str> = lines.collect();
    let mut i = 0;
    while i < collected.len() {
        let line = collected[i];
        let trimmed_end = line.trim_end();
        if trimmed_end == "---" || trimmed_end == "..." {
            break;
        }
        // 顶层 key 不允许缩进；缩进行属于上一个 key 的值，已由块标量或
        // 嵌套跳过逻辑消费，这里直接跳过。
        if line.starts_with(' ') || line.starts_with('\t') {
            i += 1;
            continue;
        }
        let Some(colon) = line.find(':') else {
            i += 1;
            continue;
        };
        let key = line[..colon].trim();
        let rest = line[colon + 1..].trim();
        if let Some(indicator) = is_block_scalar_header(rest) {
            let mut block: Vec<&str> = Vec::new();
            let mut j = i + 1;
            while j < collected.len() {
                let block_line = collected[j];
                if block_line.trim().is_empty() {
                    block.push("");
                    j += 1;
                    continue;
                }
                if block_line.starts_with(' ') || block_line.starts_with('\t') {
                    block.push(block_line.trim());
                    j += 1;
                    continue;
                }
                break;
            }
            let joined = if indicator == '|' {
                block.join("\n")
            } else {
                block.join(" ")
            };
            assign_frontmatter(&mut result, key, joined.trim());
            i = j;
            continue;
        }
        if !rest.is_empty() {
            assign_frontmatter(&mut result, key, unquote(rest));
        }
        // rest 为空：可能是嵌套 map（如 metadata:），其子行带缩进，下一轮
        // 循环会被上面的缩进分支跳过。
        i += 1;
    }
    result
}

fn assign_frontmatter(result: &mut SkillFrontmatter, key: &str, value: &str) {
    match key {
        "name" => result.name = Some(value.to_string()),
        "description" => result.description = Some(value.to_string()),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// glob / 覆盖模式匹配（对齐 pi 的 matchesAnyPattern / matchesAnyExactPattern）
// ---------------------------------------------------------------------------

/// 极简 glob：`*` 不跨 `/`，`**` 跨任意字符，`?` 匹配单个非 `/` 字符。
pub fn glob_match(pattern: &str, value: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let v: Vec<char> = value.chars().collect();
    glob_match_inner(&p, &v)
}

fn glob_match_inner(p: &[char], v: &[char]) -> bool {
    if p.is_empty() {
        return v.is_empty();
    }
    match p[0] {
        '*' => {
            let double_star = p.len() >= 2 && p[1] == '*';
            let rest = &p[if double_star { 2 } else { 1 }..];
            let mut idx = 0;
            loop {
                if glob_match_inner(rest, &v[idx..]) {
                    return true;
                }
                if idx >= v.len() || (!double_star && v[idx] == '/') {
                    return false;
                }
                idx += 1;
            }
        }
        '?' => !v.is_empty() && v[0] != '/' && glob_match_inner(&p[1..], &v[1..]),
        c => !v.is_empty() && v[0] == c && glob_match_inner(&p[1..], &v[1..]),
    }
}

fn pattern_matches(pattern: &str, candidates: &[String]) -> bool {
    if pattern.contains('*') || pattern.contains('?') {
        candidates.iter().any(|c| glob_match(pattern, c))
    } else {
        candidates.iter().any(|c| c == pattern)
    }
}

fn exact_pattern_matches(pattern: &str, candidates: &[String]) -> bool {
    let normalized = pattern
        .strip_prefix("./")
        .unwrap_or(pattern)
        .replace('\\', "/");
    candidates.iter().any(|c| *c == normalized)
}

/// 候选匹配串集合：相对 override_base 的路径、文件名、绝对路径；SKILL.md
/// 另加父目录的相对路径/目录名/绝对路径（对齐 pi matchesAnyPattern 对
/// SKILL.md 的特殊处理）。
fn match_candidates(file_path: &Path, override_base: &Path) -> Vec<String> {
    let mut candidates = vec![
        rel_posix(file_path, override_base),
        file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        posix(file_path),
    ];
    if file_path.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
        if let Some(parent) = file_path.parent() {
            candidates.push(rel_posix(parent, override_base));
            if let Some(name) = parent.file_name() {
                candidates.push(name.to_string_lossy().to_string());
            }
            candidates.push(posix(parent));
        }
    }
    candidates
}

/// 对齐 pi `isEnabledByOverrides`：默认启用；`!pattern`(glob) 排除；
/// `+path` 精确强制包含覆盖 `!`；`-path` 精确强制排除覆盖前两者。
pub fn is_enabled_by_overrides(
    file_path: &Path,
    override_base: &Path,
    patterns: &[String],
) -> bool {
    let candidates = match_candidates(file_path, override_base);
    let mut enabled = true;
    for pattern in patterns {
        if let Some(rest) = pattern.strip_prefix('!') {
            if pattern_matches(rest, &candidates) {
                enabled = false;
            }
        }
    }
    for pattern in patterns {
        if let Some(rest) = pattern.strip_prefix('+') {
            if exact_pattern_matches(rest, &candidates) {
                enabled = true;
            }
        }
    }
    for pattern in patterns {
        if let Some(rest) = pattern.strip_prefix('-') {
            if exact_pattern_matches(rest, &candidates) {
                enabled = false;
            }
        }
    }
    enabled
}

fn read_settings_patterns(settings_path: &Path, key: &str) -> Vec<String> {
    let Ok(value) = read_json_file(settings_path) else {
        return Vec::new();
    };
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| entry.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Skills 枚举
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct SkillRoot {
    /// 发现目录，如 ~/.pi/agent/skills。
    dir: PathBuf,
    /// override/相对路径基准，如 ~/.pi/agent（对应 pi 的 baseDir）。
    override_base: PathBuf,
    /// pi 模式根（~/.pi/agent/skills、.pi/skills）顶层散放 .md 算 skill；
    /// agents 模式根（~/.agents/skills、项目 .agents/skills）忽略顶层 .md。
    include_root_files: bool,
    /// global-pi / global-agents / project-pi / project-agents
    origin: &'static str,
    /// 启用态覆盖写在哪份 settings：global（~/.pi/agent/settings.json）或
    /// project（.pi/settings.json）。
    settings_scope: &'static str,
}

fn skill_roots(project_path: Option<&str>) -> Vec<SkillRoot> {
    let mut roots = Vec::new();
    if let Ok(agent) = agent_dir() {
        roots.push(SkillRoot {
            dir: agent.join("skills"),
            override_base: agent.clone(),
            include_root_files: true,
            origin: "global-pi",
            settings_scope: "global",
        });
    }
    if let Ok(home) = home_dir() {
        let agents = home.join(".agents");
        roots.push(SkillRoot {
            dir: agents.join("skills"),
            override_base: agents,
            include_root_files: false,
            origin: "global-agents",
            settings_scope: "global",
        });
    }
    if let Some(project_path) = project_path {
        let project = PathBuf::from(project_path);
        if project.is_dir() {
            roots.push(SkillRoot {
                dir: project.join(".pi").join("skills"),
                override_base: project.join(".pi"),
                include_root_files: true,
                origin: "project-pi",
                settings_scope: "project",
            });
            let user_agents_skills = home_dir().ok().map(|h| h.join(".agents").join("skills"));
            let git_root = find_git_root(&project);
            let mut dir = project.clone();
            loop {
                let candidate = dir.join(".agents").join("skills");
                let is_user_dir = user_agents_skills
                    .as_ref()
                    .map(|u| *u == candidate)
                    .unwrap_or(false);
                if !is_user_dir && candidate.is_dir() {
                    roots.push(SkillRoot {
                        dir: candidate,
                        override_base: dir.join(".agents"),
                        include_root_files: false,
                        origin: "project-agents",
                        settings_scope: "project",
                    });
                }
                if git_root.as_ref().map(|g| *g == dir).unwrap_or(false) {
                    break;
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }
    roots
}

/// 对齐 pi `loadSkillsFromDirInternal`：目录含 SKILL.md 即 skill 根并停止
/// 下钻；否则收集（仅顶层）散放 .md 并递归子目录。返回 SKILL.md / 散放
/// .md 的文件路径。
fn discover_skill_files(
    dir: &Path,
    include_root_files: bool,
    depth: usize,
    out: &mut Vec<PathBuf>,
) {
    if depth > MAX_SKILL_DEPTH || !dir.is_dir() {
        return;
    }
    let skill_md = dir.join("SKILL.md");
    if skill_md.is_file() {
        out.push(skill_md);
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        // metadata 跟随符号链接（与 pi 的 statSync 一致）。
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            subdirs.push(path);
        } else if meta.is_file() && include_root_files && name.ends_with(".md") {
            out.push(path);
        }
    }
    for subdir in subdirs {
        discover_skill_files(&subdir, false, depth + 1, out);
    }
}

#[derive(Debug, Serialize)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    /// frontmatter 缺 description 时 pi 不加载该 skill。
    pub loadable: bool,
    pub file_path: String,
    pub skill_dir: String,
    pub root_path: String,
    pub origin: String,
    pub settings_scope: String,
    /// 写入 settings.json skills 数组的精确禁用模式（`-<pattern>`）。
    pub disable_pattern: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct SkillListResult {
    pub skills: Vec<SkillEntry>,
    pub global_settings_path: String,
    pub project_settings_path: Option<String>,
    /// 项目含需信任资源但尚无信任决定时，项目 skills 实际不会被 pi 加载。
    pub project_trusted: Option<bool>,
}

/// 枚举全局与项目的散放 skills，并解析 frontmatter 与启用态。
#[tauri::command]
pub async fn list_skill_resources(project_path: Option<String>) -> Result<SkillListResult, String> {
    let agent = agent_dir()?;
    let global_settings_path = agent.join("settings.json");
    let project_settings_path = project_path
        .as_ref()
        .map(|p| PathBuf::from(p).join(".pi").join("settings.json"));
    let global_patterns = read_settings_patterns(&global_settings_path, "skills");
    let project_patterns = project_settings_path
        .as_ref()
        .map(|p| read_settings_patterns(p, "skills"))
        .unwrap_or_default();

    let roots = skill_roots(project_path.as_deref());
    let mut skills = Vec::new();
    for root in &roots {
        let mut files = Vec::new();
        discover_skill_files(&root.dir, root.include_root_files, 0, &mut files);
        let patterns = if root.settings_scope == "global" {
            &global_patterns
        } else {
            &project_patterns
        };
        for file in &files {
            let content = fs::read_to_string(file).unwrap_or_default();
            let frontmatter = parse_skill_frontmatter(&content);
            let skill_dir = file
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
            let fallback_name = skill_dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let name = frontmatter
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or(fallback_name);
            let description = frontmatter.description.unwrap_or_default();
            let disable_pattern = if file.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
                rel_posix(&skill_dir, &root.override_base)
            } else {
                rel_posix(file, &root.override_base)
            };
            skills.push(SkillEntry {
                name,
                loadable: !description.trim().is_empty(),
                description,
                file_path: posix(file),
                skill_dir: posix(&skill_dir),
                root_path: posix(&root.dir),
                origin: root.origin.to_string(),
                settings_scope: root.settings_scope.to_string(),
                disable_pattern,
                enabled: is_enabled_by_overrides(file, &root.override_base, patterns),
            });
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name).then(a.file_path.cmp(&b.file_path)));

    let project_trusted = match project_path.as_ref() {
        Some(p) => Some(project_trust_decision(&PathBuf::from(p))?.unwrap_or(false)),
        None => None,
    };

    Ok(SkillListResult {
        skills,
        global_settings_path: posix(&global_settings_path),
        project_settings_path: project_settings_path.as_ref().map(|p| posix(p)),
        project_trusted,
    })
}

/// 把目录（含 SKILL.md）或单个 .md 文件复制进 ~/.pi/agent/skills/。
#[tauri::command]
pub async fn install_skill_from_path(source_path: String) -> Result<String, String> {
    let trimmed = source_path.trim();
    if trimmed.is_empty() {
        return Err("未提供路径".to_string());
    }
    let source = PathBuf::from(trimmed);
    if !source.exists() {
        return Err(format!("路径不存在：{}", trimmed));
    }
    let skills_dir = agent_dir()?.join("skills");
    fs::create_dir_all(&skills_dir).map_err(|e| format!("创建 skills 目录失败：{}", e))?;

    let file_name = source
        .file_name()
        .ok_or_else(|| "路径没有有效的文件名".to_string())?;
    let dest = skills_dir.join(file_name);
    if dest.exists() {
        return Err(format!(
            "目标已存在同名条目：{}。请先重命名或移走现有条目。",
            posix(&dest)
        ));
    }

    if source.is_file() {
        if source.extension().and_then(|e| e.to_str()) != Some("md") {
            return Err("仅支持 .md 文件或包含 SKILL.md 的目录".to_string());
        }
        fs::copy(&source, &dest).map_err(|e| format!("复制文件失败：{}", e))?;
    } else {
        if !source.join("SKILL.md").is_file() {
            return Err("目录中没有 SKILL.md，不是有效的 skill".to_string());
        }
        copy_dir_recursive(&source, &dest, 0)?;
    }
    Ok(posix(&dest))
}

fn copy_dir_recursive(source: &Path, dest: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_SKILL_DEPTH {
        return Err(format!("目录层级过深：{}", posix(source)));
    }
    fs::create_dir_all(dest).map_err(|e| format!("创建目录 {} 失败：{}", posix(dest), e))?;
    let entries =
        fs::read_dir(source).map_err(|e| format!("读取目录 {} 失败：{}", posix(source), e))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let src = entry.path();
        let dst = dest.join(&name);
        // metadata 跟随符号链接：复制链接指向的内容，避免产生悬空链接。
        let Ok(meta) = fs::metadata(&src) else {
            continue;
        };
        if meta.is_dir() {
            copy_dir_recursive(&src, &dst, depth + 1)?;
        } else if meta.is_file() {
            fs::copy(&src, &dst).map_err(|e| format!("复制 {} 失败：{}", posix(&src), e))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 散放扩展枚举
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct LooseExtensionEntry {
    pub name: String,
    pub file_path: String,
    pub root_path: String,
    /// global / project
    pub origin: String,
    pub settings_scope: String,
    pub disable_pattern: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct LooseExtensionListResult {
    pub extensions: Vec<LooseExtensionEntry>,
    pub global_settings_path: String,
    pub project_settings_path: Option<String>,
}

/// 对齐 pi `resolveExtensionEntries`：子目录的 package.json pi.extensions，
/// 否则 index.ts/index.js。
fn resolve_extension_entries(dir: &Path) -> Vec<PathBuf> {
    let package_json = dir.join("package.json");
    if package_json.is_file() {
        if let Ok(value) = read_json_file(&package_json) {
            let manifest_entries = value
                .get("pi")
                .and_then(|pi| pi.get("extensions"))
                .and_then(|ext| ext.as_array());
            if let Some(entries) = manifest_entries {
                let resolved: Vec<PathBuf> = entries
                    .iter()
                    .filter_map(|e| e.as_str())
                    // 去掉 "./" 前缀，避免路径里残留 "/./"。
                    .map(|rel| dir.join(rel.strip_prefix("./").unwrap_or(rel)))
                    .filter(|p| p.exists())
                    .collect();
                if !resolved.is_empty() {
                    return resolved;
                }
            }
        }
    }
    for index_name in ["index.ts", "index.js"] {
        let index = dir.join(index_name);
        if index.is_file() {
            return vec![index];
        }
    }
    Vec::new()
}

/// 对齐 pi `collectAutoExtensionEntries`：根目录自身可作为扩展；否则顶层
/// .ts/.js 与一层子目录，不继续递归。
fn collect_extension_entries(dir: &Path) -> Vec<PathBuf> {
    if !dir.is_dir() {
        return Vec::new();
    }
    let root_entries = resolve_extension_entries(dir);
    if !root_entries.is_empty() {
        return root_entries;
    }
    let mut entries = Vec::new();
    let Ok(read_dir) = fs::read_dir(dir) else {
        return entries;
    };
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.is_file() && (name.ends_with(".ts") || name.ends_with(".js")) {
            entries.push(path);
        } else if meta.is_dir() {
            entries.extend(resolve_extension_entries(&path));
        }
    }
    entries
}

/// 枚举 ~/.pi/agent/extensions 与项目 .pi/extensions 的散放扩展文件。
#[tauri::command]
pub async fn list_loose_extensions(
    project_path: Option<String>,
) -> Result<LooseExtensionListResult, String> {
    let agent = agent_dir()?;
    let global_settings_path = agent.join("settings.json");
    let project_settings_path = project_path
        .as_ref()
        .map(|p| PathBuf::from(p).join(".pi").join("settings.json"));
    let global_patterns = read_settings_patterns(&global_settings_path, "extensions");
    let project_patterns = project_settings_path
        .as_ref()
        .map(|p| read_settings_patterns(p, "extensions"))
        .unwrap_or_default();

    let mut roots: Vec<(PathBuf, PathBuf, &'static str, &'static str)> =
        vec![(agent.join("extensions"), agent.clone(), "global", "global")];
    if let Some(project_path) = project_path.as_ref() {
        let project = PathBuf::from(project_path);
        if project.is_dir() {
            roots.push((
                project.join(".pi").join("extensions"),
                project.join(".pi"),
                "project",
                "project",
            ));
        }
    }

    let mut extensions = Vec::new();
    for (dir, override_base, origin, scope) in &roots {
        let patterns = if *scope == "global" {
            &global_patterns
        } else {
            &project_patterns
        };
        for file in collect_extension_entries(dir) {
            let name = file
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            extensions.push(LooseExtensionEntry {
                name,
                disable_pattern: rel_posix(&file, override_base),
                file_path: posix(&file),
                root_path: posix(dir),
                origin: origin.to_string(),
                settings_scope: scope.to_string(),
                enabled: is_enabled_by_overrides(&file, override_base, patterns),
            });
        }
    }
    extensions.sort_by(|a, b| a.name.cmp(&b.name).then(a.file_path.cmp(&b.file_path)));
    Ok(LooseExtensionListResult {
        extensions,
        global_settings_path: posix(&global_settings_path),
        project_settings_path: project_settings_path.as_ref().map(|p| posix(p)),
    })
}

// ---------------------------------------------------------------------------
// 废纸篓
// ---------------------------------------------------------------------------

/// 计算废纸篓目标路径：无冲突用原名；有冲突加 UTC 时间戳后缀
/// （`name-20260725-195625.ext`）。抽出纯逻辑便于单测。
fn trash_candidate_path(trash: &Path, file_name: &str, timestamp: &str) -> PathBuf {
    let candidate = trash.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let ext = match path.extension() {
        Some(ext) if !ext.is_empty() => format!(".{}", ext.to_string_lossy()),
        _ => String::new(),
    };
    let mut candidate = trash.join(format!("{}-{}{}", stem, timestamp, ext));
    let mut n = 2u32;
    while candidate.exists() {
        candidate = trash.join(format!("{}-{}-{}{}", stem, timestamp, n, ext));
        n += 1;
    }
    candidate
}

fn compact_utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = split_unix_utc(secs);
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", y, mo, d, h, mi, s)
}

/// 与 safe_config.rs 相同的 civil-from-days 换算（避免扩大 safe_config 的
/// 公开面，这里复制一份小实现）。
fn split_unix_utc(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = (secs % 86_400) as u32;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }), m, d, hour, minute, second)
}

/// 防误删：只允许把已知 skills/extensions 根目录、以及 pi 会话目录之内的路径移入废纸篓。
fn is_within_resource_roots(target: &Path, project_path: Option<&str>) -> bool {
    let target_canonical = canonicalize(target);
    let mut roots: Vec<PathBuf> = skill_roots(project_path)
        .iter()
        .map(|r| r.dir.clone())
        .collect();
    if let Ok(agent) = agent_dir() {
        roots.push(agent.join("extensions"));
        // 侧栏「删除会话」把 session JSONL 移入废纸篓（可恢复），会话文件在 agent_dir()/sessions/ 下
        roots.push(agent.join("sessions"));
        // 子智能体定义（agents/）与后台运行记录（subagent-bg-runs/）也走废纸篓删除
        roots.push(agent.join("agents"));
        roots.push(agent.join("subagent-bg-runs"));
    }
    if let Some(project_path) = project_path {
        roots.push(PathBuf::from(project_path).join(".pi").join("extensions"));
    }
    roots.iter().any(|root| {
        let root_canonical = canonicalize(root);
        target_canonical.starts_with(&root_canonical) && target_canonical != root_canonical
    })
}

/// 把 skill / 散放扩展 / 会话文件移入 macOS 废纸篓（可恢复）。同卷 fs::rename；
/// 跨卷回退 `mv`（参数数组，无 shell 拼接）。
#[tauri::command]
pub async fn move_path_to_trash(
    path: String,
    project_path: Option<String>,
) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("未提供路径".to_string());
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(format!("路径不存在：{}", trimmed));
    }
    if !is_within_resource_roots(&target, project_path.as_deref()) {
        return Err(
            "只允许把 skills / 扩展 / 会话 / 子智能体目录内的条目移入废纸篓，该路径不在受管目录内".to_string(),
        );
    }
    let trash = home_dir()?.join(".Trash");
    if !trash.is_dir() {
        fs::create_dir_all(&trash).map_err(|e| format!("无法访问废纸篓：{}", e))?;
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| "路径没有有效的文件名".to_string())?
        .to_string_lossy()
        .to_string();
    let candidate = trash_candidate_path(&trash, &file_name, &compact_utc_now());

    match fs::rename(&target, &candidate) {
        Ok(()) => Ok(posix(&candidate)),
        Err(rename_err) => {
            // 跨卷（EXDEV）等情况：回退 mv（copy + remove）。
            let output = Command::new("mv")
                .arg(&target)
                .arg(&candidate)
                .output()
                .map_err(|e| {
                    format!(
                        "移入废纸篓失败（rename: {}; mv 无法启动: {}）",
                        rename_err, e
                    )
                })?;
            if output.status.success() {
                Ok(posix(&candidate))
            } else {
                Err(format!(
                    "移入废纸篓失败：{}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 项目信任（trust.json）
// ---------------------------------------------------------------------------

/// 与 pi `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` 一致。
const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES: [&str; 7] = [
    "settings.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
];

fn trust_store_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("trust.json"))
}

/// 对齐 pi `hasTrustRequiringProjectResources`：cwd/.pi 下含需信任条目，
/// 或 cwd 及祖先（到文件系统根）含 .agents/skills（排除 ~/.agents/skills）。
fn has_trust_requiring_resources(cwd: &Path) -> bool {
    let user_agents_skills = home_dir()
        .ok()
        .map(|h| canonicalize(&h.join(".agents").join("skills")));
    let mut current = canonicalize(cwd);
    let config_dir = current.join(".pi");
    if TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES
        .iter()
        .any(|entry| config_dir.join(entry).exists())
    {
        return true;
    }
    loop {
        let agents_skills = current.join(".agents").join("skills");
        let is_user_dir = user_agents_skills
            .as_ref()
            .map(|u| *u == agents_skills)
            .unwrap_or(false);
        if !is_user_dir && agents_skills.exists() {
            return true;
        }
        if !current.pop() {
            return false;
        }
    }
}

fn read_trust_store(path: &Path) -> Result<Map<String, Value>, String> {
    let value = read_json_file(path)?;
    if value.is_null() {
        return Ok(Map::new());
    }
    let obj = value
        .as_object()
        .ok_or_else(|| format!("信任存储 {} 格式无效：顶层必须是对象", posix(path)))?;
    for (key, entry) in obj {
        if !(entry.is_boolean() || entry.is_null()) {
            return Err(format!(
                "信任存储 {} 格式无效：{} 的值必须是 true/false/null",
                posix(path),
                key
            ));
        }
    }
    Ok(obj.clone())
}

/// 对齐 pi `findNearestTrustEntry`：从规范化 cwd 向上找最近的 true/false。
fn find_nearest_trust_entry(data: &Map<String, Value>, cwd: &Path) -> Option<bool> {
    let mut current = canonicalize(cwd);
    loop {
        if let Some(value) = data.get(&posix(&current)) {
            if let Some(decision) = value.as_bool() {
                return Some(decision);
            }
        }
        if !current.pop() {
            return None;
        }
    }
}

fn project_trust_decision(cwd: &Path) -> Result<Option<bool>, String> {
    let store = read_trust_store(&trust_store_path()?)?;
    Ok(find_nearest_trust_entry(&store, cwd))
}

#[derive(Debug, Serialize)]
pub struct ProjectTrustStatus {
    pub canonical_path: String,
    pub has_resources: bool,
    /// None = 无保存的决定；Some(true/false) = 已信任/已拒绝（含祖先继承）。
    pub decision: Option<bool>,
    /// RPC 模式下无提示：无保存决定即不加载项目资源（defaultProjectTrust=ask）。
    pub trusted: bool,
}

#[tauri::command]
pub async fn get_project_trust_status(project_path: String) -> Result<ProjectTrustStatus, String> {
    let project = PathBuf::from(project_path.trim());
    if !project.is_dir() {
        return Err(format!("项目目录不存在：{}", project_path));
    }
    let canonical = canonicalize(&project);
    let decision = project_trust_decision(&project)?;
    Ok(ProjectTrustStatus {
        canonical_path: posix(&canonical),
        has_resources: has_trust_requiring_resources(&project),
        decision,
        trusted: decision == Some(true),
    })
}

/// 写入/移除信任决定。trusted: Some(true/false) 保存决定，None 删除条目。
/// 返回规范化路径（写入 trust.json 的键）。
#[tauri::command]
pub async fn set_project_trust(
    project_path: String,
    trusted: Option<bool>,
) -> Result<String, String> {
    let project = PathBuf::from(project_path.trim());
    let canonical = canonicalize(&project);
    let key = posix(&canonical);
    let trust_path = trust_store_path()?;

    let _lock = DirLock::acquire(&trust_path, TRUST_LOCK_TIMEOUT_MS)?;
    let mut store = read_trust_store(&trust_path)?;
    match trusted {
        Some(decision) => {
            store.insert(key.clone(), Value::Bool(decision));
        }
        None => {
            store.remove(&key);
        }
    }
    // 与 pi 的 writeTrustFile 一致：按键排序、pretty JSON、结尾换行。
    let sorted: Map<String, Value> = store
        .into_iter()
        .filter(|(_, v)| v.is_boolean())
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .collect();
    let serialized = serde_json::to_string_pretty(&Value::Object(sorted))
        .map_err(|e| format!("序列化信任存储失败：{}", e))?;
    atomic_write(&trust_path, format!("{}\n", serialized).as_bytes(), None)?;
    Ok(key)
}

#[derive(Debug, Serialize)]
pub struct TrustedProjectEntry {
    pub path: String,
    pub trusted: bool,
    pub exists: bool,
}

#[tauri::command]
pub async fn list_trusted_projects() -> Result<Vec<TrustedProjectEntry>, String> {
    let store = read_trust_store(&trust_store_path()?)?;
    let mut entries: Vec<TrustedProjectEntry> = store
        .iter()
        .filter_map(|(path, value)| {
            value.as_bool().map(|trusted| TrustedProjectEntry {
                path: path.clone(),
                trusted,
                exists: PathBuf::from(path).is_dir(),
            })
        })
        .collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

// ---------------------------------------------------------------------------
// MCP 配置（pi-mcp-adapter 兼容）
// ---------------------------------------------------------------------------

/// 层叠顺序（低→高），同名 server 高层覆盖低层。与 adapter README 一致。
fn mcp_config_files(project_path: Option<&str>) -> Vec<(PathBuf, &'static str)> {
    let mut files: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Ok(home) = home_dir() {
        files.push((
            home.join(".config").join("mcp").join("mcp.json"),
            "user-shared",
        ));
        files.push((home.join(".agents").join("mcp.json"), "user-agents"));
        files.push((
            home.join(".agents").join("mcp").join("mcp.json"),
            "user-agents-dir",
        ));
    }
    if let Ok(agent) = agent_dir() {
        files.push((agent.join("mcp.json"), "pi-global"));
    }
    if let Some(project_path) = project_path {
        let project = PathBuf::from(project_path);
        files.push((project.join(".mcp.json"), "project-shared"));
        files.push((project.join(".pi").join("mcp.json"), "pi-project"));
    }
    files
}

fn layer_label(layer: &str) -> &'static str {
    match layer {
        "user-shared" => "全局共享",
        "user-agents" => "全局 agents",
        "user-agents-dir" => "全局 agents/mcp",
        "pi-global" => "Pi 全局",
        "project-shared" => "项目共享",
        "pi-project" => "Pi 项目",
        _ => "未知",
    }
}

fn mcp_transport(config: &Value) -> &'static str {
    if config.get("command").and_then(|v| v.as_str()).is_some() {
        "stdio"
    } else if config.get("url").and_then(|v| v.as_str()).is_some() {
        "http"
    } else if config.get("socket").and_then(|v| v.as_str()).is_some() {
        "socket"
    } else {
        "unknown"
    }
}

fn mcp_summary(config: &Value) -> String {
    if let Some(command) = config.get("command").and_then(|v| v.as_str()) {
        let args = config
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| a.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        return if args.is_empty() {
            command.to_string()
        } else {
            format!("{} {}", command, args)
        };
    }
    if let Some(url) = config.get("url").and_then(|v| v.as_str()) {
        return url.to_string();
    }
    if let Some(socket) = config.get("socket").and_then(|v| v.as_str()) {
        return socket.to_string();
    }
    String::new()
}

#[derive(Debug, Serialize)]
pub struct McpServerEntry {
    pub name: String,
    /// 生效条目所在文件（最高优先级定义）。
    pub source_file: String,
    pub layer: String,
    pub layer_label: String,
    /// 只有字面 true 才禁用（adapter 语义）。
    pub disabled: bool,
    pub transport: String,
    pub summary: String,
    /// 完整生效配置，宽松保留 adapter 私有字段（directTools/lifecycle 等）。
    pub config: Value,
    /// 同名低优先级定义所在的文件（被覆盖）。
    pub overridden_files: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct McpConfigFileInfo {
    pub path: String,
    pub layer: String,
    pub layer_label: String,
    pub exists: bool,
    pub server_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct McpListResult {
    pub servers: Vec<McpServerEntry>,
    pub files: Vec<McpConfigFileInfo>,
}

struct McpRawEntry {
    config: Value,
    source_file: String,
    layer: &'static str,
}

/// 合并给定层序列（低→高）的 mcp.json：同名高层覆盖低层。
/// 返回（生效条目（保持最低层首次出现顺序）, 文件信息）。
fn merge_mcp_servers_impl(
    files: &[(PathBuf, &'static str)],
) -> (
    Vec<(String, McpRawEntry, Vec<String>)>,
    Vec<McpConfigFileInfo>,
) {
    // 保持插入顺序：第一次出现的文件（最低优先级）排前。
    let mut order: Vec<String> = Vec::new();
    let mut merged: std::collections::HashMap<String, (McpRawEntry, Vec<String>)> =
        std::collections::HashMap::new();
    let mut file_infos = Vec::new();

    for (path, layer) in files {
        let exists = path.is_file();
        let mut server_count = 0usize;
        let mut error = None;
        if exists {
            match read_json_file(path) {
                Ok(value) => {
                    if let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) {
                        server_count = servers.len();
                        for (name, config) in servers {
                            let source_file = posix(path);
                            match merged.get_mut(name) {
                                Some((entry, overridden)) => {
                                    overridden.push(entry.source_file.clone());
                                    *entry = McpRawEntry {
                                        config: config.clone(),
                                        source_file,
                                        layer,
                                    };
                                }
                                None => {
                                    order.push(name.clone());
                                    merged.insert(
                                        name.clone(),
                                        (
                                            McpRawEntry {
                                                config: config.clone(),
                                                source_file,
                                                layer,
                                            },
                                            Vec::new(),
                                        ),
                                    );
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    error = Some(e);
                }
            }
        }
        file_infos.push(McpConfigFileInfo {
            path: posix(path),
            layer: layer.to_string(),
            layer_label: layer_label(layer).to_string(),
            exists,
            server_count,
            error,
        });
    }

    let servers = order
        .into_iter()
        .filter_map(|name| {
            merged
                .remove(&name)
                .map(|(entry, overridden)| (name, entry, overridden))
        })
        .collect();
    (servers, file_infos)
}

#[tauri::command]
pub async fn list_mcp_servers(project_path: Option<String>) -> Result<McpListResult, String> {
    let (servers, files) = merge_mcp_servers_impl(&mcp_config_files(project_path.as_deref()));
    Ok(McpListResult {
        servers: servers
            .into_iter()
            .map(|(name, entry, overridden)| McpServerEntry {
                name,
                source_file: entry.source_file,
                layer: entry.layer.to_string(),
                layer_label: layer_label(entry.layer).to_string(),
                disabled: entry.config.get("disabled").and_then(|v| v.as_bool()) == Some(true),
                transport: mcp_transport(&entry.config).to_string(),
                summary: mcp_summary(&entry.config),
                config: entry.config,
                overridden_files: overridden,
            })
            .collect(),
        files,
    })
}

// ---------------------------------------------------------------------------
// MCP 导入映射（Cursor / Claude Code / Claude Desktop → 标准 .mcp.json）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct McpImportCandidate {
    pub name: String,
    pub transport: String,
    pub summary: String,
    pub config: Value,
    pub source_tool: String,
    pub source_file: String,
    pub already_configured: bool,
}

/// 把宿主工具的 server 配置映射为标准 .mcp.json 条目：保留
/// command/args/env/cwd（stdio）或 url/headers（http），其余宿主私有字段
/// 丢弃。无法识别传输方式的返回 None。
pub fn map_host_mcp_server(config: &Value) -> Option<Value> {
    let obj = config.as_object()?;
    let mut mapped = Map::new();

    let has_command = obj
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_url = obj
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    if has_command {
        mapped.insert("command".to_string(), obj.get("command").unwrap().clone());
        for key in ["args", "env", "cwd"] {
            if let Some(value) = obj.get(key) {
                mapped.insert(key.to_string(), value.clone());
            }
        }
        return Some(Value::Object(mapped));
    }

    if has_url {
        mapped.insert("url".to_string(), obj.get("url").unwrap().clone());
        // Claude/Cursor 的远程条目可能带 "type": "http"/"sse"，标准条目
        // 只需 url；保留 headers 以兼容鉴权。
        if let Some(headers) = obj.get("headers") {
            mapped.insert("headers".to_string(), headers.clone());
        }
        return Some(Value::Object(mapped));
    }

    None
}

fn scan_host_mcp_file(
    path: &Path,
    source_tool: &str,
    existing: &[String],
    out: &mut Vec<McpImportCandidate>,
) {
    if !path.is_file() {
        return;
    }
    let Ok(value) = read_json_file(path) else {
        return;
    };
    let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) else {
        return;
    };
    for (name, config) in servers {
        let Some(mapped) = map_host_mcp_server(config) else {
            continue;
        };
        out.push(McpImportCandidate {
            name: name.clone(),
            transport: mcp_transport(&mapped).to_string(),
            summary: mcp_summary(&mapped),
            config: mapped,
            source_tool: source_tool.to_string(),
            source_file: posix(path),
            already_configured: existing.iter().any(|n| n == name),
        });
    }
}

/// 扫描 Cursor / Claude Code / Claude Desktop 的 MCP 配置，映射成标准
/// .mcp.json 条目供勾选导入。不修改任何宿主文件。
#[tauri::command]
pub async fn scan_mcp_import_sources(
    existing_names: Vec<String>,
) -> Result<Vec<McpImportCandidate>, String> {
    let home = home_dir()?;
    let mut out = Vec::new();
    scan_host_mcp_file(
        &home.join(".cursor").join("mcp.json"),
        "Cursor",
        &existing_names,
        &mut out,
    );
    scan_host_mcp_file(
        &home.join(".claude.json"),
        "Claude Code",
        &existing_names,
        &mut out,
    );
    scan_host_mcp_file(
        &home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json"),
        "Claude Desktop",
        &existing_names,
        &mut out,
    );
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_test_dir(tag: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "extensions_test_{}_{}_{}",
            tag,
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // -- frontmatter ---------------------------------------------------------

    #[test]
    fn frontmatter_basic() {
        let content =
            "---\nname: my-skill\ndescription: Does things. Use when needed.\n---\n\n# Body\n";
        let fm = parse_skill_frontmatter(content);
        assert_eq!(fm.name.as_deref(), Some("my-skill"));
        assert_eq!(
            fm.description.as_deref(),
            Some("Does things. Use when needed.")
        );
    }

    #[test]
    fn frontmatter_quoted_and_extra_keys() {
        let content = "---\nname: \"quoted-skill\"\ndescription: 'single quoted'\nlicense: MIT\nallowed-tools: bash read\n---\n";
        let fm = parse_skill_frontmatter(content);
        assert_eq!(fm.name.as_deref(), Some("quoted-skill"));
        assert_eq!(fm.description.as_deref(), Some("single quoted"));
    }

    #[test]
    fn frontmatter_block_scalars() {
        let folded = "---\nname: s\ndescription: >\n  line one\n  line two\n---\n";
        let fm = parse_skill_frontmatter(folded);
        assert_eq!(fm.description.as_deref(), Some("line one line two"));

        let literal = "---\nname: s\ndescription: |-\n  line one\n  line two\n---\n";
        let fm = parse_skill_frontmatter(literal);
        assert_eq!(fm.description.as_deref(), Some("line one\nline two"));
    }

    #[test]
    fn frontmatter_skips_nested_map() {
        let content = "---\nname: s\nmetadata:\n  author: someone\n  name: not-the-skill\ndescription: real desc\n---\n";
        let fm = parse_skill_frontmatter(content);
        assert_eq!(fm.name.as_deref(), Some("s"));
        assert_eq!(fm.description.as_deref(), Some("real desc"));
    }

    #[test]
    fn frontmatter_missing_or_malformed() {
        assert_eq!(
            parse_skill_frontmatter("# no frontmatter\n"),
            SkillFrontmatter::default()
        );
        assert_eq!(
            parse_skill_frontmatter("---\nname: s\n---\n").description,
            None
        );
        // CRLF
        let fm = parse_skill_frontmatter("---\r\nname: crlf\ndescription: d\r\n---\r\n");
        assert_eq!(fm.name.as_deref(), Some("crlf"));
    }

    // -- glob / override ------------------------------------------------------

    #[test]
    fn glob_match_basics() {
        assert!(glob_match("foo", "foo"));
        assert!(!glob_match("foo", "foobar"));
        assert!(glob_match("foo*", "foobar"));
        assert!(!glob_match("foo*", "foo/bar"));
        assert!(glob_match("foo**", "foo/bar"));
        assert!(glob_match("**/SKILL.md", "skills/a/SKILL.md"));
        assert!(glob_match("skills/?/SKILL.md", "skills/a/SKILL.md"));
        assert!(!glob_match("skills/?/SKILL.md", "skills/a/b/SKILL.md"));
    }

    #[test]
    fn overrides_disable_and_force() {
        let base = Path::new("/home/u/.pi/agent");
        let skill = Path::new("/home/u/.pi/agent/skills/my-skill/SKILL.md");
        // 精确目录名禁用（UI 写入的形式）
        assert!(!is_enabled_by_overrides(
            skill,
            base,
            &["-skills/my-skill".to_string()]
        ));
        // 名称 glob 排除（pi 文档形式）
        assert!(!is_enabled_by_overrides(
            skill,
            base,
            &["!my-skill".to_string()]
        ));
        // + 强制包含覆盖 !
        assert!(is_enabled_by_overrides(
            skill,
            base,
            &["!my-*".to_string(), "+skills/my-skill".to_string()]
        ));
        // - 强制排除覆盖 +
        assert!(!is_enabled_by_overrides(
            skill,
            base,
            &[
                "+skills/my-skill".to_string(),
                "-skills/my-skill".to_string()
            ]
        ));
        // 不相关模式不影响
        assert!(is_enabled_by_overrides(
            skill,
            base,
            &["-skills/other".to_string()]
        ));
        // 普通路径条目不影响启用态
        assert!(is_enabled_by_overrides(
            skill,
            base,
            &["~/elsewhere".to_string()]
        ));
    }

    #[test]
    fn overrides_root_md_file_by_rel_path() {
        let base = Path::new("/home/u/.pi/agent");
        let file = Path::new("/home/u/.pi/agent/skills/foo.md");
        // 根散放 .md 用相对路径精确禁用（"foo" 不匹配 "foo.md"）
        assert!(!is_enabled_by_overrides(
            file,
            base,
            &["-skills/foo.md".to_string()]
        ));
        assert!(is_enabled_by_overrides(
            file,
            base,
            &["-skills/foo".to_string()]
        ));
    }

    // -- skill 发现 ------------------------------------------------------------

    #[test]
    fn discover_skills_rules() {
        let dir = temp_test_dir("discover");
        let root = dir.join("skills");
        // 目录型 skill
        fs::create_dir_all(root.join("a-skill")).unwrap();
        fs::write(
            root.join("a-skill").join("SKILL.md"),
            "---\nname: a-skill\ndescription: A\n---\n",
        )
        .unwrap();
        // 嵌套目录型 skill（二级）
        fs::create_dir_all(root.join("group").join("b-skill")).unwrap();
        fs::write(
            root.join("group").join("b-skill").join("SKILL.md"),
            "---\ndescription: B\n---\n",
        )
        .unwrap();
        // 顶层散放 .md
        fs::write(root.join("loose.md"), "---\ndescription: L\n---\n").unwrap();
        // dot 目录与 node_modules 跳过
        fs::create_dir_all(root.join(".hidden").join("x")).unwrap();
        fs::write(
            root.join(".hidden").join("x").join("SKILL.md"),
            "---\ndescription: X\n---\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("node_modules").join("y")).unwrap();
        fs::write(
            root.join("node_modules").join("y").join("SKILL.md"),
            "---\ndescription: Y\n---\n",
        )
        .unwrap();
        // 含 SKILL.md 的目录不再下钻
        fs::create_dir_all(root.join("a-skill").join("nested")).unwrap();
        fs::write(
            root.join("a-skill").join("nested").join("SKILL.md"),
            "---\ndescription: N\n---\n",
        )
        .unwrap();

        let mut pi_mode = Vec::new();
        discover_skill_files(&root, true, 0, &mut pi_mode);
        let names: Vec<String> = pi_mode
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            pi_mode.len(),
            3,
            "pi 模式：a-skill + b-skill + loose.md，找到 {:?}",
            names
        );
        assert!(pi_mode.iter().any(|p| p.ends_with("loose.md")));

        let mut agents_mode = Vec::new();
        discover_skill_files(&root, false, 0, &mut agents_mode);
        assert_eq!(agents_mode.len(), 2, "agents 模式忽略顶层 .md");
        assert!(!agents_mode.iter().any(|p| p.ends_with("loose.md")));

        let _ = fs::remove_dir_all(&dir);
    }

    // -- 扩展发现 --------------------------------------------------------------

    #[test]
    fn discover_extensions_rules() {
        let dir = temp_test_dir("ext_discover");
        let root = dir.join("extensions");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("top.ts"), "// ext").unwrap();
        fs::write(root.join("note.txt"), "no").unwrap();
        fs::create_dir_all(root.join("pkg")).unwrap();
        fs::write(root.join("pkg").join("index.js"), "// pkg").unwrap();
        fs::create_dir_all(root.join("manifest")).unwrap();
        fs::write(
            root.join("manifest").join("package.json"),
            r#"{"pi":{"extensions":["./main.ts"]}}"#,
        )
        .unwrap();
        fs::write(root.join("manifest").join("main.ts"), "// manifest").unwrap();
        fs::create_dir_all(root.join("deep").join("deeper")).unwrap();
        fs::write(root.join("deep").join("deeper").join("x.ts"), "// too deep").unwrap();

        let entries = collect_extension_entries(&root);
        let posix_paths: Vec<String> = entries.iter().map(|p| posix(p)).collect();
        assert!(posix_paths.iter().any(|p| p.ends_with("top.ts")));
        assert!(posix_paths.iter().any(|p| p.ends_with("pkg/index.js")));
        assert!(posix_paths.iter().any(|p| p.ends_with("manifest/main.ts")));
        assert!(
            !posix_paths.iter().any(|p| p.contains("deeper")),
            "不递归一层以上：{:?}",
            posix_paths
        );
        assert_eq!(entries.len(), 3);

        let _ = fs::remove_dir_all(&dir);
    }

    // -- 废纸篓冲突 ------------------------------------------------------------

    #[test]
    fn trash_candidate_conflict_gets_timestamp() {
        let dir = temp_test_dir("trash");
        let trash = dir.join("Trash");
        fs::create_dir_all(&trash).unwrap();

        // 无冲突：原名
        let candidate = trash_candidate_path(&trash, "my-skill", "20260725-120000");
        assert_eq!(candidate, trash.join("my-skill"));

        // 有冲突：目录（无扩展名）加时间戳
        fs::create_dir_all(trash.join("my-skill")).unwrap();
        let candidate = trash_candidate_path(&trash, "my-skill", "20260725-120000");
        assert_eq!(candidate, trash.join("my-skill-20260725-120000"));

        // 有冲突：文件保留扩展名；同秒冲突再追加序号
        fs::write(trash.join("foo.md"), "x").unwrap();
        fs::write(trash.join("foo-20260725-120000.md"), "x").unwrap();
        let candidate = trash_candidate_path(&trash, "foo.md", "20260725-120000");
        assert_eq!(candidate, trash.join("foo-20260725-120000-2.md"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_rejects_path_outside_roots() {
        let dir = temp_test_dir("trash_scope");
        let outside = dir.join("random.txt");
        fs::write(&outside, "x").unwrap();
        // 不存在的 project：root 集合不含 temp 目录，必须拒绝
        assert!(!is_within_resource_roots(
            &outside,
            Some(dir.to_str().unwrap())
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    // -- 信任存储 --------------------------------------------------------------

    #[test]
    fn trust_nearest_entry_walks_up() {
        let mut store = Map::new();
        store.insert("/repo".to_string(), Value::Bool(true));
        store.insert("/other".to_string(), Value::Bool(false));
        store.insert("/null-entry".to_string(), Value::Null);
        assert_eq!(
            find_nearest_trust_entry(&store, Path::new("/repo/sub/project")),
            Some(true)
        );
        assert_eq!(
            find_nearest_trust_entry(&store, Path::new("/other")),
            Some(false)
        );
        assert_eq!(
            find_nearest_trust_entry(&store, Path::new("/nowhere")),
            None
        );
        // null 不算决定，继续向上
        assert_eq!(
            find_nearest_trust_entry(&store, Path::new("/null-entry/x")),
            None
        );
    }

    #[test]
    fn trust_requiring_resources_detection() {
        let dir = temp_test_dir("trust_detect");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        assert!(!has_trust_requiring_resources(&project));

        fs::create_dir_all(project.join(".pi").join("skills")).unwrap();
        assert!(has_trust_requiring_resources(&project));

        let dir2 = temp_test_dir("trust_detect2");
        let nested = dir2.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(dir2.join(".agents").join("skills")).unwrap();
        assert!(
            has_trust_requiring_resources(&nested),
            "祖先 .agents/skills 也算"
        );

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }

    // -- MCP 合并 / 导入映射 -----------------------------------------------------

    fn mcp_servers_obj(entries: &[(&str, Value)]) -> Value {
        let mut servers = Map::new();
        for (name, config) in entries {
            servers.insert(name.to_string(), config.clone());
        }
        let mut root = Map::new();
        root.insert("mcpServers".to_string(), Value::Object(servers));
        Value::Object(root)
    }

    #[test]
    fn mcp_merge_precedence_and_disabled() {
        let dir = temp_test_dir("mcp_merge");
        let project = dir.join("proj");
        fs::create_dir_all(project.join(".pi")).unwrap();
        // 低层：项目共享 .mcp.json
        fs::write(
            project.join(".mcp.json"),
            serde_json::to_string(&mcp_servers_obj(&[
                ("alpha", serde_json::json!({"command": "alpha-low"})),
                (
                    "beta",
                    serde_json::json!({"command": "beta", "disabled": true}),
                ),
            ]))
            .unwrap(),
        )
        .unwrap();
        // 高层：.pi/mcp.json 覆盖 alpha
        fs::write(
            project.join(".pi").join("mcp.json"),
            serde_json::to_string(&mcp_servers_obj(&[(
                "alpha",
                serde_json::json!({"url": "https://high.example/mcp", "lifecycle": "eager"}),
            )]))
            .unwrap(),
        )
        .unwrap();

        let (servers, files) = merge_mcp_servers_impl(&[
            (project.join(".mcp.json"), "project-shared"),
            (project.join(".pi").join("mcp.json"), "pi-project"),
        ]);
        assert_eq!(servers.len(), 2);
        let alpha = servers.iter().find(|(n, _, _)| n == "alpha").unwrap();
        assert!(
            alpha.1.source_file.ends_with(".pi/mcp.json"),
            "高层覆盖低层"
        );
        assert_eq!(mcp_transport(&alpha.1.config), "http");
        assert_eq!(alpha.2.len(), 1, "记录被覆盖的低层文件");
        assert!(alpha.2[0].ends_with("proj/.mcp.json"));
        let beta = servers.iter().find(|(n, _, _)| n == "beta").unwrap();
        assert_eq!(
            beta.1.config.get("disabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        // disabled 只有字面 true 才禁用
        assert_ne!(
            serde_json::json!({"disabled": "true"})
                .get("disabled")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|f| f.exists));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mcp_import_mapping_stdio_and_http() {
        // Cursor stdio 风格：保留 command/args/env，丢弃宿主私有字段
        let cursor = serde_json::json!({
            "command": "npx",
            "args": ["-y", "some-server"],
            "env": {"KEY": "v"},
            "cursorInternal": {"x": 1}
        });
        let mapped = map_host_mcp_server(&cursor).unwrap();
        assert_eq!(mapped.get("command").and_then(|v| v.as_str()), Some("npx"));
        assert!(mapped.get("args").is_some());
        assert!(mapped.get("env").is_some());
        assert!(mapped.get("cursorInternal").is_none());

        // Claude Desktop 远程风格：type+url → url+headers
        let claude = serde_json::json!({
            "type": "http",
            "url": "https://mcp.example.com/sse",
            "headers": {"Authorization": "Bearer x"}
        });
        let mapped = map_host_mcp_server(&claude).unwrap();
        assert_eq!(
            mapped.get("url").and_then(|v| v.as_str()),
            Some("https://mcp.example.com/sse")
        );
        assert!(mapped.get("headers").is_some());
        assert!(mapped.get("type").is_none(), "标准条目不需要 type 字段");

        // 无法识别 → None
        assert!(map_host_mcp_server(&serde_json::json!({"foo": 1})).is_none());
        assert!(map_host_mcp_server(&serde_json::json!("string")).is_none());
    }

    // -- 真实环境冒烟（只读，不修改任何文件）----------------------------------
    // 手动验证（macOS）:
    //   cd src-tauri && cargo test extensions::tests::real_home_smoke -- --ignored --nocapture

    #[test]
    #[ignore = "reads the real home directory; run manually"]
    fn real_home_smoke() {
        let roots = skill_roots(None);
        println!("skill roots:");
        for root in &roots {
            println!(
                "  [{}] {} (base: {}, root_files: {})",
                root.origin,
                posix(&root.dir),
                posix(&root.override_base),
                root.include_root_files
            );
            let mut files = Vec::new();
            discover_skill_files(&root.dir, root.include_root_files, 0, &mut files);
            for file in &files {
                let content = fs::read_to_string(file).unwrap_or_default();
                let fm = parse_skill_frontmatter(&content);
                println!(
                    "    - {} :: {}",
                    fm.name.unwrap_or_else(|| "(no name)".to_string()),
                    fm.description
                        .map(|d| d.chars().take(60).collect::<String>())
                        .unwrap_or_else(|| "(no description)".to_string())
                );
            }
        }
        assert!(!roots.is_empty(), "至少应有全局 skills 根");

        if let Ok(agent) = agent_dir() {
            let ext_root = agent.join("extensions");
            let entries = collect_extension_entries(&ext_root);
            println!("loose extensions under {}:", posix(&ext_root));
            for entry in &entries {
                println!("    - {}", posix(entry));
            }
        }

        let (servers, files) = merge_mcp_servers_impl(&mcp_config_files(None));
        println!(
            "mcp files: {} checked, servers: {}",
            files.len(),
            servers.len()
        );
        for info in &files {
            println!(
                "  [{}] {} exists={} servers={} err={:?}",
                info.layer, info.path, info.exists, info.server_count, info.error
            );
        }
        for (name, entry, overridden) in &servers {
            println!(
                "  server {} -> {} (transport={}, overridden={:?})",
                name,
                entry.source_file,
                mcp_transport(&entry.config),
                overridden
            );
        }

        if let Ok(store_path) = trust_store_path() {
            let store = read_trust_store(&store_path).unwrap_or_default();
            println!(
                "trust store {}: {} entries",
                posix(&store_path),
                store.len()
            );
            for (path, value) in &store {
                println!("    {} => {}", path, value);
            }
        }
    }
}
