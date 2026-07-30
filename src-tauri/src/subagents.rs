//! 子智能体（subagent）定义的发现与读写。
//!
//! 定义文件是 `<agent dir>/agents/*.md`：YAML-ish frontmatter + 正文当系统提示。
//! 这些文件由用户装的 subagent 扩展消费（`~/.pi/agent/extensions/subagent/`）。
//!
//! 两条必须对齐扩展行为的地方：
//! - **frontmatter 的 `name` 才是标准名**，文件名可以不一致（实际存在
//!   `local-knowledge-maintainer.md` 里写 `name: local_knowledge_maintainer`）。
//! - 扩展对缺 `name`/`description` 的文件是**静默跳过**；本模块反过来把它标成
//!   invalid 并返回，目的是让用户在 GUI 里看到「这个文件坏了」而不是凭空消失。
//!
//! 作用域：**只做 user 作用域**（`<agent dir>/agents/`）。项目作用域
//! （`<project>/.pi/agents/`）不在此列——它不在 pi 的信任白名单里，
//! 展示/执行它需要先定安全承诺，见 design/subagent-panel-plan.md。

use std::path::{Path, PathBuf};

/// 返回条数上限。防「用户目录里塞了几万个 md」把面板冻死。
const MAX_SUBAGENTS: usize = 200;
/// 单个定义文件的读取上限。
const MAX_DEFINITION_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SubagentFrontmatter {
    pub name: String,
    pub display_name: Option<String>,
    pub description: String,
    pub model: Option<String>,
    pub tools: Vec<String>,
    /// 保留本模块不认识的字段（read-modify-write 约定：绝不丢用户/其他工具写的东西）。
    pub extra: Vec<(String, String)>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SubagentEntry {
    pub file_path: String,
    pub file_name: String,
    /// 解析成功时的 frontmatter；为 None 说明这个文件不合法。
    pub frontmatter: Option<SubagentFrontmatter>,
    /// 不合法的原因（中文，直接给用户看）。
    pub error: Option<String>,
    pub body_chars: usize,
    pub size_bytes: u64,
    /// 结构化编辑器能不能安全回写（见 is_round_trip_safe）。
    /// false 时前端必须走原文编辑，否则会改坏用户文件。
    pub round_trip_safe: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SubagentListResult {
    pub dir: String,
    /// 是否检测到 subagent 扩展。false 时这些定义不会被加载，
    /// 面板应明确提示而不是默默列出一堆无效配置。
    pub extension_present: bool,
    pub entries: Vec<SubagentEntry>,
    /// 目录里 .md 的真实数量（可大于 entries.len()，用于 UI 末尾聚合行）。
    pub total: usize,
    pub truncated: bool,
}

/// 拆分 frontmatter 与正文。
///
/// 完全对齐 pi 的 `dist/utils/frontmatter.js`：
/// - 先归一化 CRLF/CR 为 LF；
/// - 必须以 `---` 开头，否则整个文件都是正文；
/// - 以**第一个** `\n---` 作为 frontmatter 结束（不是最后一个）；
/// - 正文 `trim()`。
///
/// 偏离这些细节会导致 GUI 列出的内容与 pi 实际加载的对不上。
fn split_frontmatter(content: &str) -> (Option<String>, String) {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.starts_with("---") {
        return (None, normalized);
    }
    // 从下标 3 开始找，与 JS 的 indexOf("\n---", 3) 一致。
    match normalized.get(3..).and_then(|rest| rest.find("\n---")) {
        Some(offset) => {
            let end = 3 + offset;
            let yaml = normalized.get(4..end).unwrap_or("").to_string();
            let body = normalized.get(end + 4..).unwrap_or("").trim().to_string();
            (Some(yaml), body)
        }
        None => (None, normalized),
    }
}

/// 解析一行 `key: value`。子智能体定义的 frontmatter 是扁平的标量表，
/// 不引入 YAML 依赖；遇到嵌套/列表语法就当作不支持并保原。
fn parse_scalar_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (key, value) = trimmed.split_once(':')?;
    let key = key.trim();
    if key.is_empty() || key.contains(' ') {
        return None;
    }
    let mut value = value.trim().to_string();
    // 去成对的引号
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        let quoted = (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'');
        if quoted {
            value = value[1..value.len() - 1].to_string();
        }
    }
    Some((key.to_string(), value))
}

/// 名称校验，对齐扩展的 `/^[A-Za-z0-9_-]+$/`。
pub fn validate_subagent_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("名称只能包含字母、数字、下划线和连字符".to_string());
    }
    Ok(())
}

/// 解析完整定义文件。返回 Err 说明这个文件 pi 不会加载。
pub fn parse_subagent_definition(content: &str) -> Result<(SubagentFrontmatter, String), String> {
    let (yaml, body) = split_frontmatter(content);
    let yaml = yaml.ok_or_else(|| "缺少 frontmatter（文件需以 --- 开头并以 --- 结束）".to_string())?;

    let mut name = String::new();
    let mut display_name = None;
    let mut description = String::new();
    let mut model = None;
    let mut tools = Vec::new();
    let mut extra = Vec::new();

    for line in yaml.lines() {
        let Some((key, value)) = parse_scalar_line(line) else {
            continue;
        };
        match key.as_str() {
            "name" => name = value,
            "display_name" => display_name = Some(value).filter(|v| !v.is_empty()),
            "description" => description = value,
            "model" => model = Some(value).filter(|v| !v.is_empty()),
            "tools" => {
                tools = value
                    .split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
            }
            _ => extra.push((key, value)),
        }
    }

    // 扩展对缺这两项的文件是静默跳过，所以这里报错等于告诉用户「pi 不会加载它」。
    if name.is_empty() {
        return Err("frontmatter 缺少 name，pi 不会加载该子智能体".to_string());
    }
    validate_subagent_name(&name)?;
    if description.is_empty() {
        return Err("frontmatter 缺少 description，pi 不会加载该子智能体".to_string());
    }
    if body.trim().is_empty() {
        return Err("系统提示（正文）不能为空".to_string());
    }

    Ok((
        SubagentFrontmatter {
            name,
            display_name,
            description,
            model,
            tools,
            extra,
        },
        body,
    ))
}

/// 序列化回定义文件。
///
/// **只用于「结构化编辑器能安全接管」的文件**，安全与否由
/// `is_round_trip_safe` 判定。本函数自身不是 YAML 序列化器：它不做 quoting，
/// 也不保留注释/空行/引号风格。对包含多行标量、列表语法、值内冒号等
/// 结构的文件，绝不能拿它回写——那会默默改坏用户手写的配置。
pub fn serialize_subagent_definition(fm: &SubagentFrontmatter, body: &str) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", fm.name));
    if let Some(display) = fm.display_name.as_ref().filter(|d| !d.is_empty()) {
        out.push_str(&format!("display_name: {}\n", display));
    }
    out.push_str(&format!("description: {}\n", fm.description));
    if let Some(model) = fm.model.as_ref().filter(|m| !m.is_empty()) {
        out.push_str(&format!("model: {}\n", model));
    }
    if !fm.tools.is_empty() {
        out.push_str(&format!("tools: {}\n", fm.tools.join(",")));
    }
    for (key, value) in &fm.extra {
        out.push_str(&format!("{}: {}\n", key, value));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim());
    out.push('\n');
    out
}

/// 判定一个定义文件能不能安全地用结构化编辑器编辑。
///
/// 做法：解析 → 序列化 → 与原文逐字节比对。完全相等才算安全。
///
/// 为什么需要这个：本模块的行解析器不是真 YAML。pi 用的是 `yaml` 包，
/// 能正确读出 `description: "review #1: high"`、`tools: [read, bash]`、
/// `description: |` 多行块；而本模块会把前者在冒号处截断、把后者读成
/// `["[read", "bash]"]`。若直接回写，用户的文件就被静默改坏了。
///
/// 回写安全的充分条件就是「解析再序列化能原文重现」：成立时说明这个文件
/// 只用了本模块能完整表达的那个子集（扁平的、无引号、无注释的标量行）。
/// 不成立则强制走原文编辑，一个字节也不替用户改。
pub fn is_round_trip_safe(content: &str) -> bool {
    let Ok((fm, body)) = parse_subagent_definition(content) else {
        return false;
    };
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    serialize_subagent_definition(&fm, &body) == normalized
}

/// 检测 subagent 扩展是否存在。它可能是目录（subagent/index.ts）或单文件
/// （subagent-bg.ts 这类）；只看文件名前缀，不试图解析它的内容。
fn detect_subagent_extension() -> bool {
    let Some(agent) = crate::get_pi_agent_dir() else {
        return false;
    };
    let ext_dir = agent.join("extensions");
    let Ok(read) = std::fs::read_dir(&ext_dir) else {
        return false;
    };
    read.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("subagent"))
    })
}

fn agents_dir() -> Result<PathBuf, String> {
    let dir = crate::get_pi_agent_dir().ok_or_else(|| "无法确定 pi agent 目录".to_string())?;
    Ok(dir.join("agents"))
}

/// 把前端传来的文件名解成 agents 目录内的真实路径。
///
/// **只收文件名，不收路径**。前端绝不能传绝对路径——那等于把任意文件写入/
/// 删除的能力交给 renderer。这里同时拦路径穿越、绝对路径和非 .md 扩展名。
fn resolve_agent_file(file_name: &str) -> Result<PathBuf, String> {
    if file_name.is_empty() {
        return Err("文件名不能为空".to_string());
    }
    // 拒绝任何分隔符、上级引用和绝对路径
    if file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || Path::new(file_name).is_absolute()
    {
        return Err(format!("不合法的文件名：{}", file_name));
    }
    if !file_name.ends_with(".md") {
        return Err("子智能体定义文件必须以 .md 结尾".to_string());
    }
    let base = agents_dir()?;
    // 资源根自身不得是 symlink。否则 canonicalize 会把 base 解成它指向的目录
    // （比如 $HOME），于是「在 agents 目录内」的判断就扩大到了那个目录，
    // save/删除能跑到子智能体目录之外去。
    if let Ok(meta) = std::fs::symlink_metadata(&base) {
        if meta.file_type().is_symlink() {
            return Err("子智能体目录是符号链接，为安全起见拒绝写入".to_string());
        }
    }
    let target = base.join(file_name);

    // 已存在时额外校验：目标自身不得是 symlink，且规范化后的父目录必须正好
    // 是规范化后的 agents 目录（比 starts_with 严：后者允许任意层数的子目录）。
    if target.exists() {
        if let Ok(meta) = std::fs::symlink_metadata(&target) {
            if meta.file_type().is_symlink() {
                return Err("目标是符号链接，为安全起见拒绝写入".to_string());
            }
        }
        let canonical_base = base
            .canonicalize()
            .map_err(|e| format!("无法解析子智能体目录：{}", e))?;
        let canonical_target = target
            .canonicalize()
            .map_err(|e| format!("无法解析路径 {}：{}", target.display(), e))?;
        if canonical_target.parent() != Some(canonical_base.as_path()) {
            return Err("目标路径不在子智能体目录内".to_string());
        }
        if !canonical_target.is_file() {
            return Err("目标不是普通文件".to_string());
        }
    }
    Ok(target)
}

#[tauri::command]
pub async fn list_subagents() -> Result<SubagentListResult, String> {
    let dir = agents_dir()?;
    let dir_display = dir.to_string_lossy().to_string();
    if !dir.is_dir() {
        return Ok(SubagentListResult {
            dir: dir_display,
            extension_present: detect_subagent_extension(),
            entries: Vec::new(),
            total: 0,
            truncated: false,
        });
    }

    let read = std::fs::read_dir(&dir).map_err(|e| format!("无法读取 {}：{}", dir.display(), e))?;
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let is_md = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"));
        if !is_md {
            continue;
        }
        // 跟随 symlink 判断是不是文件（与扩展一致：它接受 symlink）
        if !path.is_file() {
            continue;
        }
        files.push(path);
    }
    files.sort();

    let total = files.len();
    let truncated = total > MAX_SUBAGENTS;
    files.truncate(MAX_SUBAGENTS);

    let mut entries = Vec::with_capacity(files.len());
    for path in files {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

        if size_bytes > MAX_DEFINITION_BYTES {
            entries.push(SubagentEntry {
                file_path: path.to_string_lossy().to_string(),
                file_name,
                frontmatter: None,
                error: Some(format!(
                    "文件过大（{} KB），超过 {} KB 上限，未解析",
                    size_bytes / 1024,
                    MAX_DEFINITION_BYTES / 1024
                )),
                body_chars: 0,
                size_bytes,
                round_trip_safe: false,
            });
            continue;
        }

        let (frontmatter, error, body_chars, round_trip_safe) = match std::fs::read_to_string(&path)
        {
            Ok(content) => match parse_subagent_definition(&content) {
                Ok((fm, body)) => (
                    Some(fm),
                    None,
                    body.chars().count(),
                    is_round_trip_safe(&content),
                ),
                Err(err) => (None, Some(err), 0, false),
            },
            Err(e) => (None, Some(format!("读取失败：{}", e)), 0, false),
        };

        entries.push(SubagentEntry {
            file_path: path.to_string_lossy().to_string(),
            file_name,
            frontmatter,
            error,
            body_chars,
            size_bytes,
            round_trip_safe,
        });
    }

    Ok(SubagentListResult {
        dir: dir_display,
        extension_present: detect_subagent_extension(),
        entries,
        total,
        truncated,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SubagentDetail {
    pub file_name: String,
    pub file_path: String,
    pub content: String,
    /// 修改时间（毫秒）。保存时回传用于比对，防覆盖终端侧的修改。
    pub mtime_ms: u64,
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn read_subagent(file_name: String) -> Result<SubagentDetail, String> {
    let path = resolve_agent_file(&file_name)?;
    let size = std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("无法读取文件信息：{}", e))?;
    if size > MAX_DEFINITION_BYTES {
        return Err(format!(
            "文件过大（{} KB），超过 {} KB 上限",
            size / 1024,
            MAX_DEFINITION_BYTES / 1024
        ));
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败：{}", path.display(), e))?;
    Ok(SubagentDetail {
        file_name,
        file_path: path.to_string_lossy().to_string(),
        mtime_ms: mtime_ms(&path),
        content,
    })
}

/// 保存定义。
///
/// - `expected_mtime_ms` 为 `Some` 时做乐观锁：盘上 mtime 不匹配则拒绝，
///   避开「用户同时在终端用 /subagent 改了同一个文件」的覆盖。
///   这只能缩小竞态窗口不能消除，但比无条件覆盖强。
/// - `create_new` 为 true 时目标已存在则报错（对齐扩展的 `flag: "wx"`）。
#[tauri::command]
pub async fn save_subagent(
    file_name: String,
    content: String,
    create_new: bool,
    expected_mtime_ms: Option<u64>,
) -> Result<SubagentDetail, String> {
    // 先校验内容合法：不让用户存下一个 pi 加载不了的定义。
    if content.len() as u64 > MAX_DEFINITION_BYTES {
        return Err(format!(
            "内容过大（{} KB），超过 {} KB 上限",
            content.len() / 1024,
            MAX_DEFINITION_BYTES / 1024
        ));
    }
    parse_subagent_definition(&content)?;
    let path = resolve_agent_file(&file_name)?;

    if create_new && path.exists() {
        return Err(format!("{} 已存在", file_name));
    }
    if !create_new {
        if !path.exists() {
            return Err(format!("{} 不存在", file_name));
        }
        // 乐观锁：拿不到版本信息时宁可拒绝，也不能把 0 当免检值——那等于
        // 在拿不到 mtime 的环境里直接放弃防覆盖。
        let expected = expected_mtime_ms.ok_or_else(|| "缺少版本信息，请先刷新再保存".to_string())?;
        let actual = mtime_ms(&path);
        if actual == 0 || expected == 0 || actual != expected {
            return Err("文件已在其他地方被修改，请先刷新再保存".to_string());
        }
    }

    // **逐字节写入调用方给的内容，绝不重序列化。**
    // 本模块的行解析器不是真 YAML（见 is_round_trip_safe 注释），拿它的输出回写
    // 会把带引号冒号、多行块、列表语法的定义静默改坏。谁能用结构化编辑器
    // 由 is_round_trip_safe 在列表层判定，不安全的走原文编辑。
    // 复用 safe_config 的原子写（临时文件 + fsync + rename + 备份轮转）；
    // 不走 safe_write_json：它的文件名白名单只含 JSON 配置。
    crate::safe_config::atomic_write(&path, content.as_bytes(), Some(0o600))
        .map_err(|e| format!("写入子智能体定义失败：{}", e))?;

    Ok(SubagentDetail {
        file_name,
        file_path: path.to_string_lossy().to_string(),
        mtime_ms: mtime_ms(&path),
        content,
    })
}

/// 后台运行记录的状态。
///
/// 只区分「可证明已结束」和「未知」。**不做「运行中」推断**：
/// `exit_code` 由脱离父会话的 shell 写，`result.json` 由父进程回调写且失败被静默吞，
/// 所以「无 result.json」不能推出异常；日志 mtime 也不能代表进程存活
/// （长模型请求可超过任何阈值，刚被杀死的进程反而 mtime 很新）。
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentRunStatus {
    /// 有 exit_code，退出码为 0。
    Succeeded,
    /// 有 exit_code，退出码非 0。
    Failed,
    /// 无 exit_code，但日志末尾也没有终态事件，且日志刚刚还在长。
    ///
    /// 这不是猜：进程写 exit_code 是退出时的动作，没有它说明进程未正常退出；
    /// 再叠上「日志在活跃追加」这个正向信号，才能报运行中。
    /// 两者缺一就退回 Unknown——宁可说不知道，不能把被杀的进程报成在跑。
    Running,
    /// 没有 exit_code：进程可能在跑、可能被杀、可能写失败。不猜。
    Unknown,
}

/// 日志被认为「活跃」的时间窗（毫秒）。
///
/// 取 90 秒：子智能体单次模型请求可能几十秒不写日志，太短会把正在思考的
/// 任务误报成已停；太长又会把刚被杀的报成在跑。这个值只影响 Running 与
/// Unknown 的分界，不影响已结束判定（后者靠 exit_code，是硬信号）。
const RUNNING_LOG_ACTIVE_WINDOW_MS: u64 = 90_000;

/// 日志末尾是否已出现终态事件。子进程正常跑完会写 agent_settled。
pub fn log_tail_looks_settled(tail: &str) -> bool {
    tail.contains("\"agent_settled\"") || tail.contains("\"agent_end\"")
}

/// 在无 exit_code 时，结合日志信号细分 Running / Unknown。
///
/// - `settled` = 日志末尾已有终态事件（跑完了但 exit_code 没写上）→ Unknown
/// - `log_age_ms` 在活跃窗口内且未 settled → Running
pub fn refine_status_without_exit_code(settled: bool, log_age_ms: Option<u64>) -> SubagentRunStatus {
    if settled {
        return SubagentRunStatus::Unknown;
    }
    match log_age_ms {
        Some(age) if age <= RUNNING_LOG_ACTIVE_WINDOW_MS => SubagentRunStatus::Running,
        _ => SubagentRunStatus::Unknown,
    }
}

/// 仅根据可证明的信号判定状态。exit_code 文件内容是进程退出码的十进制文本。
pub fn classify_run_status(exit_code_raw: Option<&str>) -> SubagentRunStatus {
    match exit_code_raw.map(str::trim) {
        Some(text) if !text.is_empty() => match text.parse::<i32>() {
            Ok(0) => SubagentRunStatus::Succeeded,
            Ok(_) => SubagentRunStatus::Failed,
            Err(_) => SubagentRunStatus::Unknown,
        },
        _ => SubagentRunStatus::Unknown,
    }
}

/// run 列表返回上限。
const MAX_RUNS: usize = 100;
/// result.json 读取上限（它含完整 finalText，可能很大）。
const MAX_RESULT_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SubagentRunEntry {
    pub run_id: String,
    pub dir: String,
    pub status: SubagentRunStatus,
    pub exit_code: Option<i32>,
    /// 从 result.json 读到的字段；无 result.json 时为 None。
    pub agent: Option<String>,
    pub cwd: Option<String>,
    pub task_preview: Option<String>,
    pub duration_ms: Option<u64>,
    pub has_result: bool,
    pub events_bytes: u64,
    pub stderr_bytes: u64,
    pub total_bytes: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SubagentRunListResult {
    pub dir: String,
    pub entries: Vec<SubagentRunEntry>,
    pub total: usize,
    pub truncated: bool,
    /// 所有返回条目的字节数合计（便于 UI 提示清理）。
    pub returned_bytes: u64,
}

fn runs_dir() -> Result<PathBuf, String> {
    let dir = crate::get_pi_agent_dir().ok_or_else(|| "无法确定 pi agent 目录".to_string())?;
    Ok(dir.join("subagent-bg-runs"))
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 读文件末尾至多 `max_bytes` 字节。
///
/// **绝不整读** `events.jsonl`——实测它能到 55MB。只需末尾就能判断有无终态事件。
fn read_tail(path: &Path, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity(max_bytes.min(len) as usize);
    file.take(max_bytes).read_to_end(&mut buf).ok()?;
    // 尾部可能切在多字节 UTF-8 中间，用 lossy 不报错。
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 从 events.jsonl 第一行的 session 头里取 cwd。
///
/// 无 result.json（还在跑、或被中途杀）时，这是拿到 cwd 的唯一途径。
/// 注意第一行不一定是 JSON：日志过大被截短时会有中文提示行，因此解析失败要宽容。
fn read_session_cwd(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    // 只看开头几行：截短提示行可能占第一行。
    for _ in 0..4 {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("session") {
            return value
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
    }
    None
}

/// 从 run 目录名推 agent 名。格式是 `<agent>-<时间戳>-<随机>`，
/// 而 agent 名本身可能带下划线（如 local_knowledge_maintainer）但不带连字符。
pub fn agent_name_from_run_id(run_id: &str) -> Option<String> {
    let mut parts: Vec<&str> = run_id.split('-').collect();
    if parts.len() < 3 {
        return None;
    }
    // 去掉末尾的时间戳与随机后缀
    parts.truncate(parts.len() - 2);
    let name = parts.join("-");
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

#[tauri::command]
pub async fn list_subagent_runs() -> Result<SubagentRunListResult, String> {
    let dir = runs_dir()?;
    let dir_display = dir.to_string_lossy().to_string();
    if !dir.is_dir() {
        return Ok(SubagentRunListResult {
            dir: dir_display,
            entries: Vec::new(),
            total: 0,
            truncated: false,
            returned_bytes: 0,
        });
    }

    let read = std::fs::read_dir(&dir).map_err(|e| format!("无法读取 {}：{}", dir.display(), e))?;
    let mut dirs: Vec<(u64, PathBuf)> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        dirs.push((mtime_ms(&path), path));
    }
    // 按 mtime 倒序：最近的 run 最有用。
    dirs.sort_by(|a, b| b.0.cmp(&a.0));

    let total = dirs.len();
    let truncated = total > MAX_RUNS;
    dirs.truncate(MAX_RUNS);

    let mut entries = Vec::with_capacity(dirs.len());
    let mut returned_bytes = 0u64;
    for (dir_mtime, path) in dirs {
        let run_id = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let exit_raw = std::fs::read_to_string(path.join("exit_code")).ok();
        let mut status = classify_run_status(exit_raw.as_deref());
        let exit_code = exit_raw.as_deref().and_then(|t| t.trim().parse::<i32>().ok());

        let events_path = path.join("events.jsonl");
        // 无 exit_code 时细分 Running / Unknown：只看末尾 8KB，绝不整读。
        if status == SubagentRunStatus::Unknown {
            let settled = read_tail(&events_path, 8 * 1024)
                .map(|tail| log_tail_looks_settled(&tail))
                .unwrap_or(false);
            let log_age_ms = std::fs::metadata(&events_path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_millis() as u64);
            status = refine_status_without_exit_code(settled, log_age_ms);
        }

        let result_path = path.join("result.json");
        let has_result = result_path.is_file();
        let mut agent = None;
        let mut cwd = None;
        let mut task_preview = None;
        let mut duration_ms = None;
        // 只在 result.json 存在且不过大时读它。绝不读 events.jsonl（实测可达 55MB）。
        if has_result && file_len(&result_path) <= MAX_RESULT_BYTES {
            if let Ok(text) = std::fs::read_to_string(&result_path) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    agent = value
                        .get("agent")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    cwd = value.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
                    task_preview = value.get("task").and_then(|v| v.as_str()).map(|t| {
                        t.chars().take(200).collect::<String>()
                    });
                    duration_ms = value.get("durationMs").and_then(|v| v.as_u64());
                }
            }
        }
        // 无 result.json（还在跑、或被中途杀）时的兜底：agent 名从目录名推，
        // cwd 从 events.jsonl 第一行的 session 头取。运行中的任务全靠这两条
        // 才能在面板上显示得出「谁在跑、在哪跑」。
        if agent.is_none() {
            agent = agent_name_from_run_id(&run_id);
        }
        if cwd.is_none() {
            cwd = read_session_cwd(&events_path);
        }

        let events_bytes = file_len(&events_path);
        let stderr_bytes = file_len(&path.join("stderr.log"));
        let total_bytes = events_bytes + stderr_bytes + file_len(&result_path);
        returned_bytes += total_bytes;

        entries.push(SubagentRunEntry {
            run_id,
            dir: path.to_string_lossy().to_string(),
            status,
            exit_code,
            agent,
            cwd,
            task_preview,
            duration_ms,
            has_result,
            events_bytes,
            stderr_bytes,
            total_bytes,
            mtime_ms: dir_mtime,
        });
    }

    Ok(SubagentRunListResult {
        dir: dir_display,
        entries,
        total,
        truncated,
        returned_bytes,
    })
}

/// 单条 run 详情的返回上限。
const MAX_RUN_DETAIL_MESSAGES: usize = 40;
/// 单条消息文本的截断长度。
const MAX_RUN_DETAIL_TEXT_CHARS: usize = 4_000;
/// events.jsonl 尾部读取窗口。绝不整读——实测该文件可达 55MB。
const RUN_DETAIL_TAIL_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunMessage {
    pub role: String,
    pub text: String,
    /// 该条是否被截断（前端要提示用户去看原始日志）。
    pub truncated: bool,
    pub model: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunDetail {
    pub run_id: String,
    pub dir: String,
    /// 从 result.json 读到的最终文本（完成的任务才有）。
    pub final_text: Option<String>,
    pub final_text_truncated: bool,
    /// 从 events.jsonl 尾部解析出的消息（新→旧已反转为旧→新）。
    pub messages: Vec<SubagentRunMessage>,
    /// 是否因为只读了尾部而可能漏掉更早的消息。
    pub tail_only: bool,
    pub stderr_preview: Option<String>,
    pub events_bytes: u64,
}

/// 校验 runId：只允许字母、数字、下划线、连字符、点。
///
/// 前端传的是列表里回来的 runId，但**绝不能信任**——它决定要拼进路径的目录名。
/// 拒绝分隔符和 `..` 防路径穿越。
fn resolve_run_dir(run_id: &str) -> Result<PathBuf, String> {
    if run_id.is_empty() {
        return Err("runId 不能为空".to_string());
    }
    if run_id.contains('/')
        || run_id.contains('\\')
        || run_id.contains("..")
        || Path::new(run_id).is_absolute()
    {
        return Err(format!("不合法的 runId：{}", run_id));
    }
    if !run_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err(format!("不合法的 runId：{}", run_id));
    }
    let base = runs_dir()?;
    let target = base.join(run_id);
    // 已存在时校验规范化后的父目录恰好是 runs 根（比 starts_with 严）。
    if target.exists() {
        let canonical_base = base
            .canonicalize()
            .map_err(|e| format!("无法解析运行记录目录：{}", e))?;
        let canonical_target = target
            .canonicalize()
            .map_err(|e| format!("无法解析路径 {}：{}", target.display(), e))?;
        if canonical_target.parent() != Some(canonical_base.as_path()) {
            return Err("目标路径不在运行记录目录内".to_string());
        }
    }
    Ok(target)
}

/// 从一条 message_end 事件里提取可读文本。
///
/// content 是分段数组，可能含 thinking / text / toolCall 等。只取 text 段拼接；
/// thinking 段跳过（子智能体的思考过程对查历史没用且极长）。
pub fn extract_message_text(message: &serde_json::Value) -> Option<SubagentRunMessage> {
    let role = message.get("role").and_then(|v| v.as_str())?.to_string();
    let content = message.get("content")?;
    let mut buf = String::new();
    if let Some(parts) = content.as_array() {
        for part in parts {
            if part.get("type").and_then(|v| v.as_str()) != Some("text") {
                continue;
            }
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(text);
            }
        }
    } else if let Some(text) = content.as_str() {
        buf.push_str(text);
    }
    let trimmed = buf.trim();
    if trimmed.is_empty() {
        return None;
    }
    let truncated = trimmed.chars().count() > MAX_RUN_DETAIL_TEXT_CHARS;
    let text = if truncated {
        trimmed.chars().take(MAX_RUN_DETAIL_TEXT_CHARS).collect()
    } else {
        trimmed.to_string()
    };
    Some(SubagentRunMessage {
        role,
        text,
        truncated,
        model: message
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

#[tauri::command]
pub async fn read_subagent_run(run_id: String) -> Result<SubagentRunDetail, String> {
    let dir = resolve_run_dir(&run_id)?;
    if !dir.is_dir() {
        return Err(format!("运行记录不存在：{}", run_id));
    }

    // final_text 来自 result.json（只有完成的任务才有）
    let result_path = dir.join("result.json");
    let mut final_text = None;
    let mut final_text_truncated = false;
    if result_path.is_file() && file_len(&result_path) <= MAX_RESULT_BYTES {
        if let Ok(text) = std::fs::read_to_string(&result_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(body) = value.get("finalText").and_then(|v| v.as_str()) {
                    final_text_truncated = body.chars().count() > MAX_RUN_DETAIL_TEXT_CHARS;
                    final_text = Some(if final_text_truncated {
                        body.chars().take(MAX_RUN_DETAIL_TEXT_CHARS).collect()
                    } else {
                        body.to_string()
                    });
                }
            }
        }
    }

    // 消息从 events.jsonl **尾部**解析：整读会把 55MB 拉进内存。
    let events_path = dir.join("events.jsonl");
    let events_bytes = file_len(&events_path);
    let tail_only = events_bytes > RUN_DETAIL_TAIL_BYTES;
    let mut messages: Vec<SubagentRunMessage> = Vec::new();
    if let Some(tail) = read_tail(&events_path, RUN_DETAIL_TAIL_BYTES) {
        // 从后往前扫，凑够上限就停——最近的消息最有用。
        for line in tail.lines().rev() {
            if messages.len() >= MAX_RUN_DETAIL_MESSAGES {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            if event.get("type").and_then(|v| v.as_str()) != Some("message_end") {
                continue;
            }
            let Some(message) = event.get("message") else {
                continue;
            };
            if let Some(parsed) = extract_message_text(message) {
                messages.push(parsed);
            }
        }
    }
    messages.reverse();

    let stderr_path = dir.join("stderr.log");
    let stderr_preview = read_tail(&stderr_path, 8 * 1024)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());

    Ok(SubagentRunDetail {
        run_id,
        dir: dir.to_string_lossy().to_string(),
        final_text,
        final_text_truncated,
        messages,
        tail_only,
        stderr_preview,
        events_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nname: review\ndescription: 代码审查\nmodel: anthropic/claude-opus-4\ntools: read,bash\n---\n\n你是审查员。\n";

    #[test]
    fn parses_basic_definition() {
        let (fm, body) = parse_subagent_definition(SAMPLE).unwrap();
        assert_eq!(fm.name, "review");
        assert_eq!(fm.description, "代码审查");
        assert_eq!(fm.model.as_deref(), Some("anthropic/claude-opus-4"));
        assert_eq!(fm.tools, vec!["read", "bash"]);
        assert_eq!(body, "你是审查员。");
    }

    /// 对齐 pi：以第一个 `\n---` 结束 frontmatter，而不是最后一个。
    #[test]
    fn frontmatter_ends_at_first_delimiter() {
        let content = "---\nname: a\ndescription: d\n---\n正文\n---\n后面也是正文\n";
        let (fm, body) = parse_subagent_definition(content).unwrap();
        assert_eq!(fm.name, "a");
        assert!(body.contains("正文"));
        assert!(body.contains("后面也是正文"));
    }

    #[test]
    fn normalizes_crlf() {
        let content = "---\r\nname: a\r\ndescription: d\r\n---\r\n正文\r\n";
        let (fm, body) = parse_subagent_definition(content).unwrap();
        assert_eq!(fm.name, "a");
        assert_eq!(body, "正文");
    }

    #[test]
    fn rejects_missing_required_fields() {
        // 扩展对这两种是静默跳过，我们要报错让用户看到。
        assert!(parse_subagent_definition("---\ndescription: d\n---\nbody\n").is_err());
        assert!(parse_subagent_definition("---\nname: a\n---\nbody\n").is_err());
        assert!(parse_subagent_definition("没有 frontmatter").is_err());
        // 系统提示为空
        assert!(parse_subagent_definition("---\nname: a\ndescription: d\n---\n\n").is_err());
    }

    #[test]
    fn rejects_invalid_names() {
        assert!(validate_subagent_name("ok_name-1").is_ok());
        assert!(validate_subagent_name("").is_err());
        assert!(validate_subagent_name("has space").is_err());
        assert!(validate_subagent_name("../escape").is_err());
        assert!(validate_subagent_name("中文").is_err());
    }

    /// 未知字段必须原样保留（read-modify-write 约定）。
    #[test]
    fn round_trip_preserves_unknown_fields() {
        let content =
            "---\nname: a\ndescription: d\ncustom_flag: keep-me\nanother: 42\n---\n正文\n";
        let (fm, body) = parse_subagent_definition(content).unwrap();
        assert_eq!(fm.extra.len(), 2);
        let out = serialize_subagent_definition(&fm, &body);
        assert!(out.contains("custom_flag: keep-me"));
        assert!(out.contains("another: 42"));
        // 再转一圈仍然等价
        let (fm2, body2) = parse_subagent_definition(&out).unwrap();
        assert_eq!(fm2, fm);
        assert_eq!(body2, body);
    }

    #[test]
    fn strips_matching_quotes() {
        let content = "---\nname: a\ndescription: \"带引号的描述\"\n---\n正文\n";
        let (fm, _) = parse_subagent_definition(content).unwrap();
        assert_eq!(fm.description, "带引号的描述");
    }

    /// 后台状态只能从 exit_code 得出，不猫猜。
    #[test]
    fn classifies_run_status_only_from_exit_code() {
        assert_eq!(classify_run_status(Some("0")), SubagentRunStatus::Succeeded);
        assert_eq!(classify_run_status(Some("0\n")), SubagentRunStatus::Succeeded);
        assert_eq!(classify_run_status(Some("1")), SubagentRunStatus::Failed);
        assert_eq!(classify_run_status(Some("137")), SubagentRunStatus::Failed);
        // 无 exit_code：不能判成异常，也不能判成运行中
        assert_eq!(classify_run_status(None), SubagentRunStatus::Unknown);
        assert_eq!(classify_run_status(Some("")), SubagentRunStatus::Unknown);
        assert_eq!(classify_run_status(Some("不是数字")), SubagentRunStatus::Unknown);
    }

    /// Running 必须是**可证明**的，不能猜。
    ///
    /// exit_code 是进程退出时才写的硬信号；缺它只说明「没正常退出」，
    /// 可能在跑也可能被杀。所以还要叠一个正向信号（日志在活跃追加）才敢报运行中。
    #[test]
    fn refines_running_only_with_positive_signal() {
        // 日志活跃 + 未见终态 → 运行中
        assert_eq!(
            refine_status_without_exit_code(false, Some(1_000)),
            SubagentRunStatus::Running
        );
        // 日志已久未动 → 不猜
        assert_eq!(
            refine_status_without_exit_code(false, Some(10 * 60 * 1000)),
            SubagentRunStatus::Unknown
        );
        // 已见终态事件但没写 exit_code → 不是运行中
        assert_eq!(
            refine_status_without_exit_code(true, Some(1_000)),
            SubagentRunStatus::Unknown
        );
        // 拿不到日志时间 → 不猜
        assert_eq!(
            refine_status_without_exit_code(false, None),
            SubagentRunStatus::Unknown
        );
    }

    /// message_end 的 content 是分段数组：只取 text 段，跳过 thinking。
    /// 子智能体的思考过程极长且对查历史无用。
    #[test]
    fn extracts_only_text_parts_from_message() {
        let msg: serde_json::Value = serde_json::from_str(
            r#"{"role":"assistant","model":"m1","content":[
                {"type":"thinking","text":"内部推理很长很长"},
                {"type":"text","text":"第一段结论"},
                {"type":"text","text":"第二段结论"}
            ]}"#,
        )
        .unwrap();
        let parsed = extract_message_text(&msg).unwrap();
        assert_eq!(parsed.role, "assistant");
        assert_eq!(parsed.text, "第一段结论\n第二段结论");
        assert!(!parsed.truncated);
        assert_eq!(parsed.model.as_deref(), Some("m1"));
        assert!(!parsed.text.contains("内部推理"));
    }

    /// 纯 thinking（无 text 段）不该产出空条目污染列表。
    #[test]
    fn skips_messages_without_text_parts() {
        let msg: serde_json::Value = serde_json::from_str(
            r#"{"role":"assistant","content":[{"type":"thinking","text":"只有思考"}]}"#,
        )
        .unwrap();
        assert!(extract_message_text(&msg).is_none());

        let empty: serde_json::Value =
            serde_json::from_str(r#"{"role":"assistant","content":[]}"#).unwrap();
        assert!(extract_message_text(&empty).is_none());
    }

    #[test]
    fn truncates_overlong_message_text() {
        let long = "x".repeat(MAX_RUN_DETAIL_TEXT_CHARS + 500);
        let msg = serde_json::json!({
            "role": "assistant",
            "content": [{"type": "text", "text": long}]
        });
        let parsed = extract_message_text(&msg).unwrap();
        assert!(parsed.truncated);
        assert_eq!(parsed.text.chars().count(), MAX_RUN_DETAIL_TEXT_CHARS);
    }

    /// runId 决定要拼进路径的目录名，必须拒绝穿越。
    #[test]
    fn rejects_unsafe_run_ids() {
        assert!(resolve_run_dir("").is_err());
        assert!(resolve_run_dir("../../etc").is_err());
        assert!(resolve_run_dir("has/slash").is_err());
        assert!(resolve_run_dir("has space").is_err());
        assert!(resolve_run_dir("/abs/path").is_err());
        // 合法形态（目录不存在时也应通过校验，返回路径由调用方判断存在性）
        assert!(resolve_run_dir("explore-20260730T193537-gymy").is_ok());
    }

    #[test]
    fn detects_terminal_events_in_log_tail() {
        assert!(log_tail_looks_settled("{\"type\":\"agent_settled\"}"));
        assert!(log_tail_looks_settled("{\"type\":\"agent_end\"}"));
        assert!(!log_tail_looks_settled("{\"type\":\"message_update\"}"));
        assert!(!log_tail_looks_settled(""));
    }

    /// agent 名可能带下划线（local_knowledge_maintainer）但不带连字符，
    /// 而 runId 是 `<agent>-<时间戳>-<随机>`。
    #[test]
    fn extracts_agent_name_from_run_id() {
        assert_eq!(
            agent_name_from_run_id("explore-20260730T193537-gymy").as_deref(),
            Some("explore")
        );
        assert_eq!(
            agent_name_from_run_id("local_knowledge_maintainer-20260730T035830-f91w").as_deref(),
            Some("local_knowledge_maintainer")
        );
        // 带连字符的 agent 名也能还原（去掉末两段即可）
        assert_eq!(
            agent_name_from_run_id("plan-review-20260730T035830-f91w").as_deref(),
            Some("plan-review")
        );
        assert_eq!(agent_name_from_run_id("toofew-x").as_deref(), None);
    }

    /// 防回归：本模块的行解析器不是真 YAML，这些输入必须被判为「不能结构化编辑」。
    /// 若有人把它们当成安全并回写，用户手写的配置就会被静默改坏。
    ///
    /// 已实测 pi 自己的 yaml 包对这些输入的正确结果：
    /// - `description: "review #1: high priority"` → 整个字符串
    /// - `tools: [read, bash]` → ["read", "bash"]
    /// 而本模块分别会得到被冒号影响的值和 ["[read", "bash]"]。
    #[test]
    fn flags_yaml_constructs_as_round_trip_unsafe() {
        // 列表语法：本模块会读成 ["[read", "bash]"]
        let list_form = "---\nname: t\ndescription: d\ntools: [read, bash]\n---\nbody\n";
        let (fm, _) = parse_subagent_definition(list_form).unwrap();
        assert_eq!(fm.tools, vec!["[read", "bash]"]);
        assert!(!is_round_trip_safe(list_form), "列表语法必须判为不安全");

        // 带引号且值内含冒号：剔掉引号后回写会变义
        let quoted_colon = "---\nname: t\ndescription: \"review #1: high\"\n---\nbody\n";
        assert!(!is_round_trip_safe(quoted_colon), "带引号冒号的值必须判为不安全");

        // 多行标量
        let multiline = "---\nname: t\ndescription: |\n  第一行\n  第二行\n---\nbody\n";
        assert!(!is_round_trip_safe(multiline), "多行标量必须判为不安全");

        // 注释与空行（回写会丢掉）
        let commented = "---\nname: t\n# 这是注释\ndescription: d\n---\nbody\n";
        assert!(!is_round_trip_safe(commented), "带注释必须判为不安全");
    }

    /// 简单扁平定义应当能结构化编辑（否则面板就没用了）。
    #[test]
    fn plain_definitions_are_round_trip_safe() {
        let plain = "---\nname: review\ndescription: 代码审查\nmodel: a/b:high\ntools: read,bash\n---\n\n你是审查员。\n";
        assert!(is_round_trip_safe(plain));
    }

    #[test]
    fn rejects_unsafe_file_names() {
        // 不依赖 agent 目录存在，这些在路径拼接前就被拒
        assert!(resolve_agent_file("../escape.md").is_err());
        assert!(resolve_agent_file("sub/dir.md").is_err());
        assert!(resolve_agent_file("/etc/passwd.md").is_err());
        assert!(resolve_agent_file("no-extension").is_err());
        assert!(resolve_agent_file("").is_err());
    }

    /// 真机一致性校验：把真实的 `~/.pi/agent/agents/*.md` 全部过一遍，确认本模块
    /// 的解析结果与 pi 自己的 frontmatter.js 一致（name / model / 正文字符数）。
    ///
    /// 默认忽略：依赖本机真实配置，CI 里没有。手动跑：
    /// `cargo test --manifest-path src-tauri/Cargo.toml parity_with_real_definitions -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn parity_with_real_definitions() {
        let Ok(dir) = agents_dir() else {
            eprintln!("跳过：无法确定 agent 目录");
            return;
        };
        if !dir.is_dir() {
            eprintln!("跳过：{} 不存在", dir.display());
            return;
        }
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let content = std::fs::read_to_string(&path).unwrap();
            let parsed = parse_subagent_definition(&content);
            assert!(
                parsed.is_ok(),
                "{} 解析失败：{:?}",
                path.display(),
                parsed.err()
            );
            let (fm, body) = parsed.unwrap();
            println!(
                "{{\"file\":\"{}\",\"name\":\"{}\",\"model\":{},\"bodyChars\":{}}}",
                path.file_name().unwrap().to_string_lossy(),
                fm.name,
                fm.model
                    .as_deref()
                    .map(|m| format!("\"{}\"", m))
                    .unwrap_or_else(|| "null".to_string()),
                body.chars().count()
            );
            checked += 1;
        }
        assert!(checked > 0, "一个定义都没检查到");
    }
}

