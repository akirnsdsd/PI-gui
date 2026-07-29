//! W2 Review 面板后端：基于 git 的变更审查（status / diff / stage / unstage）。
//!
//! 设计要点：
//! - 所有解析与参数拼装均为纯函数（`parse_porcelain_v2` / `build_*_args` 等），
//!   由单元测试覆盖；`#[tauri::command]` 层只是调用 git 的 thin wrapper。
//! - git 一律参数数组传参，不经过 shell；status 类调用 15 秒超时，其余 30 秒。
//! - status 用 `git status --porcelain=v2 --branch -z`：v2 格式字段定长、
//!   rename 带相似度分数，且 `-z` 输出不做 C 风格引号转义，路径含空格/中文/CR 都安全。
//! - 各文件列表均有返回上限（untracked 500 / 其余 2000），真实总数由
//!   `*_total` 字段单独给出，防止刚 `git init` 的目录枚举出几万个
//!   未跟踪文件时序列化与前端渲染把面板卡死。

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// status / ls-files 这类枚举型调用的超时：大目录下 git 可能很慢，
/// 宁可快速报错让用户看到提示，也不要让面板一直"刷新中…"。
const STATUS_GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// diff 最多渲染行数，超出截断并置 `truncated = true`。
pub const DIFF_MAX_LINES: usize = 2000;
/// untracked 列表最多返回条数（真实总数见 `untracked_total`）。
pub const UNTRACKED_MAX_ENTRIES: usize = 500;
/// staged / unstaged / conflicted 列表各自最多返回条数（防御超大仓库）。
pub const TRACKED_MAX_ENTRIES: usize = 2000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReviewFileEntry {
    pub path: String,
    pub old_path: Option<String>,
    /// "added" | "modified" | "deleted" | "renamed" | "typechange"
    pub status: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct ParsedReviewStatus {
    pub staged: Vec<ReviewFileEntry>,
    pub unstaged: Vec<ReviewFileEntry>,
    pub conflicted: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GitReviewStatusResult {
    pub is_repo: bool,
    /// 仓库是否已有提交（`# branch.oid` 为 `(initial)` 时为 false）。
    /// 前端用它识别"刚 git init 的空仓库"并给出 .gitignore 提示。
    pub has_head: bool,
    pub staged: Vec<ReviewFileEntry>,
    pub unstaged: Vec<ReviewFileEntry>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
    /// 各列表的真实总数；列表本身可能被截断（见 *_MAX_ENTRIES）。
    pub staged_total: u32,
    pub unstaged_total: u32,
    pub untracked_total: u32,
    pub conflicted_total: u32,
}

#[derive(Debug, Deserialize)]
pub struct GitReviewDiffOptions {
    pub cwd: String,
    /// "staged" | "unstaged"
    pub scope: String,
    pub path: String,
    /// rename 的原路径；传入后 pathspec 同时包含新旧路径，
    /// 否则 git 在路径过滤前拆散了 rename 对，会把 rename 显示成"新文件"。
    pub old_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitReviewDiffResult {
    pub patch: String,
    pub truncated: bool,
    pub is_binary: bool,
}

#[derive(Debug, Deserialize)]
pub struct GitReviewPathsOptions {
    pub cwd: String,
    pub paths: Vec<String>,
}

struct GitOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

/// 单字母 XY 状态码 → 展示状态。`.`（未变）与未知码返回 None。
/// C（copy）按"新增（复制自 old_path）"处理。
pub fn map_status_code(code: char) -> Option<&'static str> {
    match code {
        'A' => Some("added"),
        'M' => Some("modified"),
        'D' => Some("deleted"),
        'R' => Some("renamed"),
        'C' => Some("added"),
        'T' => Some("typechange"),
        _ => None,
    }
}

/// 跳过前 `fields` 个空格分隔的字段，返回剩余部分（即路径，路径本身可含空格）。
fn skip_fields(token: &str, fields: usize) -> Option<&str> {
    let mut rest = token;
    for _ in 0..fields {
        let idx = rest.find(' ')?;
        rest = &rest[idx + 1..];
    }
    Some(rest)
}

fn nth_field(token: &str, n: usize) -> &str {
    token.split(' ').nth(n).unwrap_or("")
}

fn push_entry(result: &mut ParsedReviewStatus, xy: &str, path: &str, old_path: Option<String>) {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    // 冲突（UU/AA/DU/…）不进入 staged/unstaged，单列一区。
    if x == 'U' || y == 'U' {
        result.conflicted.push(path.to_string());
        return;
    }
    if let Some(status) = map_status_code(x) {
        result.staged.push(ReviewFileEntry {
            path: path.to_string(),
            old_path: old_path.clone(),
            status: status.to_string(),
        });
    }
    if let Some(status) = map_status_code(y) {
        result.unstaged.push(ReviewFileEntry {
            path: path.to_string(),
            old_path: None,
            status: status.to_string(),
        });
    }
}

/// 解析 `git status --porcelain=v2 --branch -z` 输出。
/// 记录以 NUL 分隔；rename（`2`）记录额外占用一个 NUL token 存放原路径。
pub fn parse_porcelain_v2(output: &str) -> ParsedReviewStatus {
    let mut result = ParsedReviewStatus::default();
    let mut tokens = output.split('\0');
    while let Some(token) = tokens.next() {
        if token.is_empty() || token.starts_with('#') {
            continue; // 分支头部（# branch.oid / # branch.head / …）
        }
        match &token[..1] {
            // 普通记录：1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            "1" => {
                let Some(path) = skip_fields(token, 8) else {
                    continue;
                };
                let xy = nth_field(token, 1);
                push_entry(&mut result, xy, path, None);
            }
            // rename/copy：2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
            "2" => {
                let Some(path) = skip_fields(token, 9) else {
                    continue;
                };
                let orig_path = tokens.next().unwrap_or("").to_string();
                let xy = nth_field(token, 1);
                push_entry(&mut result, xy, path, Some(orig_path));
            }
            // 未合并（冲突）：u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            "u" => {
                let Some(path) = skip_fields(token, 10) else {
                    continue;
                };
                if !path.is_empty() {
                    result.conflicted.push(path.to_string());
                }
            }
            // `?` untracked / `!` ignored：untracked 由 ls-files 单列，这里忽略
            _ => {}
        }
    }
    result
}

/// 解析 `git ls-files -z --others --exclude-standard` 输出（NUL 分隔），
/// 最多取前 `max` 条。总数请用 `count_untracked_z` 单独统计。
pub fn parse_untracked_z(output: &str, max: usize) -> Vec<String> {
    output
        .split('\0')
        .filter(|s| !s.is_empty())
        .take(max)
        .map(|s| s.to_string())
        .collect()
}

/// 统计 untracked 总数：只数 NUL token，不分配字符串，几万个文件也很快。
pub fn count_untracked_z(output: &str) -> u32 {
    output.split('\0').filter(|s| !s.is_empty()).count() as u32
}

/// 从 status 输出的 `# branch.oid` 头判断是否已有提交：
/// 空仓库（刚 git init）该值为 `(initial)`；头部缺失时保守按"已有提交"。
pub fn parse_branch_has_head(output: &str) -> bool {
    for token in output.split('\0') {
        if let Some(oid) = token.strip_prefix("# branch.oid ") {
            return oid.trim() != "(initial)";
        }
    }
    true
}

/// 截断到前 `max` 条，返回（截断后的列表, 截断前的真实总数）。
pub fn truncate_entries<T>(mut entries: Vec<T>, max: usize) -> (Vec<T>, u32) {
    let total = entries.len() as u32;
    entries.truncate(max);
    (entries, total)
}

/// 二进制补丁判定：git 在 diff 里写 `Binary files … differ` 或 `GIT binary patch`。
pub fn is_binary_patch(patch: &str) -> bool {
    patch.contains("Binary files ") || patch.contains("GIT binary patch")
}

/// 截断到前 `max_lines` 行；返回（截断后的 patch, 是否发生了截断）。
pub fn truncate_patch(patch: &str, max_lines: usize) -> (String, bool) {
    let mut lines = 0usize;
    for (idx, ch) in patch.char_indices() {
        if ch == '\n' {
            lines += 1;
            if lines == max_lines {
                // 第 max_lines 个换行之后还有内容才算"超出"。
                if idx + 1 < patch.len() {
                    return (patch[..=idx].to_string(), true);
                }
                return (patch.to_string(), false);
            }
        }
    }
    (patch.to_string(), false)
}

pub fn build_status_args() -> Vec<String> {
    vec![
        "status".into(),
        "--porcelain=v2".into(),
        "--branch".into(),
        "-z".into(),
    ]
}

pub fn build_untracked_args() -> Vec<String> {
    vec![
        "ls-files".into(),
        "-z".into(),
        "--others".into(),
        "--exclude-standard".into(),
    ]
}

/// staged：`git diff --cached -- <path>`；空仓库（无 HEAD）追加 `--root`。
/// unstaged：`git diff -- <path>`。
pub fn build_diff_args(
    scope: &str,
    has_head: bool,
    path: &str,
    old_path: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec!["diff".into()];
    match scope {
        "staged" => {
            args.push("--cached".into());
            if !has_head {
                args.push("--root".into());
            }
        }
        "unstaged" => {}
        other => return Err(format!("未知的 diff 范围：{}", other)),
    }
    args.push("--find-renames".into());
    args.push("--".into());
    args.push(path.to_string());
    if let Some(old) = old_path {
        if !old.is_empty() && old != path {
            args.push(old.to_string());
        }
    }
    Ok(args)
}

pub fn build_stage_args(paths: &[String]) -> Vec<String> {
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    args
}

pub fn build_unstage_args(paths: &[String]) -> Vec<String> {
    let mut args = vec![
        "reset".to_string(),
        "-q".to_string(),
        "HEAD".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().cloned());
    args
}

fn run_git_capture(cwd: &str, args: &[String], timeout: Duration) -> Result<GitOutput, String> {
    let git_path = which::which("git").map_err(|_| "未在 PATH 上找到 git".to_string())?;

    let mut cmd = Command::new(git_path);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("运行 git 命令失败：{}", e))?;

    // 大 diff 可能超过管道缓冲（约 64KB）：子进程写满后会阻塞，若主进程只等退出
    // 不读管道就会死锁。因此 stdout/stderr 各起一个线程持续读取。
    let mut child_stdout = child.stdout.take();
    let mut child_stderr = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        if let Some(pipe) = child_stdout.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        if let Some(pipe) = child_stderr.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(format!("git 命令执行超时（{} 秒）", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 git 命令结束失败：{}", e));
            }
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();

    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        exit_code: status.code().unwrap_or(-1),
    })
}

fn validate_cwd(cwd: &str) -> Result<String, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("未提供工作目录".to_string());
    }
    if !Path::new(trimmed).is_dir() {
        return Err(format!("工作目录不存在：{}", trimmed));
    }
    Ok(trimmed.to_string())
}

fn git_failure(prefix: &str, out: &GitOutput) -> String {
    let detail = if !out.stderr.trim().is_empty() {
        out.stderr.trim().to_string()
    } else {
        out.stdout.trim().to_string()
    };
    if detail.is_empty() {
        format!("{}（退出码：{}）", prefix, out.exit_code)
    } else {
        format!("{}：{}", prefix, detail)
    }
}

#[tauri::command]
pub async fn git_review_status(cwd: String) -> Result<GitReviewStatusResult, String> {
    let cwd = validate_cwd(&cwd)?;
    collect_review_status(&cwd)
}

/// 超时错误追加"仓库文件过多"提示：枚举超时最常见的诱因就是
/// 未跟踪文件太多（比如刚 git init 的项目目录），引导用户先配 .gitignore。
fn with_timeout_hint(result: Result<GitOutput, String>) -> Result<GitOutput, String> {
    result.map_err(|e| {
        if e.contains("超时") {
            format!(
                "{}。可能是仓库文件过多导致，建议先配置 .gitignore 后重试",
                e
            )
        } else {
            e
        }
    })
}

/// status 的同步实现，与 `#[tauri::command]` 层分开以便单元测试。
fn collect_review_status(cwd: &str) -> Result<GitReviewStatusResult, String> {
    let empty = |has_head: bool| GitReviewStatusResult {
        is_repo: false,
        has_head,
        staged: vec![],
        unstaged: vec![],
        untracked: vec![],
        conflicted: vec![],
        staged_total: 0,
        unstaged_total: 0,
        untracked_total: 0,
        conflicted_total: 0,
    };

    let probe = run_git_capture(
        cwd,
        &["rev-parse".into(), "--is-inside-work-tree".into()],
        STATUS_GIT_TIMEOUT,
    )?;
    if probe.exit_code != 0 || probe.stdout.trim() != "true" {
        return Ok(empty(false));
    }

    let status_out = with_timeout_hint(run_git_capture(
        cwd,
        &build_status_args(),
        STATUS_GIT_TIMEOUT,
    ))?;
    if status_out.exit_code != 0 {
        return Err(git_failure("git status 失败", &status_out));
    }
    let untracked_out = with_timeout_hint(run_git_capture(
        cwd,
        &build_untracked_args(),
        STATUS_GIT_TIMEOUT,
    ))?;
    if untracked_out.exit_code != 0 {
        return Err(git_failure("git ls-files 失败", &untracked_out));
    }

    let parsed = parse_porcelain_v2(&status_out.stdout);
    let has_head = parse_branch_has_head(&status_out.stdout);
    let (staged, staged_total) = truncate_entries(parsed.staged, TRACKED_MAX_ENTRIES);
    let (unstaged, unstaged_total) = truncate_entries(parsed.unstaged, TRACKED_MAX_ENTRIES);
    let (conflicted, conflicted_total) = truncate_entries(parsed.conflicted, TRACKED_MAX_ENTRIES);
    Ok(GitReviewStatusResult {
        is_repo: true,
        has_head,
        staged,
        unstaged,
        untracked: parse_untracked_z(&untracked_out.stdout, UNTRACKED_MAX_ENTRIES),
        conflicted,
        staged_total,
        unstaged_total,
        untracked_total: count_untracked_z(&untracked_out.stdout),
        conflicted_total,
    })
}

#[tauri::command]
pub async fn git_review_diff(options: GitReviewDiffOptions) -> Result<GitReviewDiffResult, String> {
    let cwd = validate_cwd(&options.cwd)?;
    let path = options.path.trim();
    if path.is_empty() {
        return Err("未提供文件路径".to_string());
    }

    let has_head = run_git_capture(
        &cwd,
        &["rev-parse".into(), "--verify".into(), "HEAD".into()],
        GIT_TIMEOUT,
    )
    .map(|out| out.exit_code == 0)
    .unwrap_or(false);

    let args = build_diff_args(&options.scope, has_head, path, options.old_path.as_deref())?;
    let out = run_git_capture(&cwd, &args, GIT_TIMEOUT)?;
    if out.exit_code != 0 {
        return Err(git_failure("git diff 失败", &out));
    }

    let is_binary = is_binary_patch(&out.stdout);
    // 二进制文件不回传补丁内容，前端只显示占位提示。
    let (patch, truncated) = if is_binary {
        (String::new(), false)
    } else {
        truncate_patch(&out.stdout, DIFF_MAX_LINES)
    };

    Ok(GitReviewDiffResult {
        patch,
        truncated,
        is_binary,
    })
}

#[tauri::command]
pub async fn git_review_stage(options: GitReviewPathsOptions) -> Result<(), String> {
    let cwd = validate_cwd(&options.cwd)?;
    if options.paths.is_empty() || options.paths.iter().any(|p| p.trim().is_empty()) {
        return Err("未提供要暂存的文件".to_string());
    }
    let out = run_git_capture(&cwd, &build_stage_args(&options.paths), GIT_TIMEOUT)?;
    if out.exit_code != 0 {
        return Err(git_failure("git add 失败", &out));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_review_unstage(options: GitReviewPathsOptions) -> Result<(), String> {
    let cwd = validate_cwd(&options.cwd)?;
    if options.paths.is_empty() || options.paths.iter().any(|p| p.trim().is_empty()) {
        return Err("未提供要取消暂存的文件".to_string());
    }
    let out = run_git_capture(&cwd, &build_unstage_args(&options.paths), GIT_TIMEOUT)?;
    if out.exit_code != 0 {
        return Err(git_failure("git reset 失败", &out));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AAA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// 构造一条普通（1）记录的便捷方法。
    fn ordinary(xy: &str, path: &str) -> String {
        format!(
            "1 {} N... 100644 100644 100644 {} {} {}\0",
            xy, AAA, AAA, path
        )
    }

    fn entry(path: &str, old_path: Option<&str>, status: &str) -> ReviewFileEntry {
        ReviewFileEntry {
            path: path.to_string(),
            old_path: old_path.map(|s| s.to_string()),
            status: status.to_string(),
        }
    }

    #[test]
    fn parses_modified_staged_and_unstaged() {
        let out = format!(
            "# branch.oid {}\0# branch.head main\0{}",
            AAA,
            ordinary("MM", "src/a.ts")
        );
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(parsed.staged, vec![entry("src/a.ts", None, "modified")]);
        assert_eq!(parsed.unstaged, vec![entry("src/a.ts", None, "modified")]);
        assert!(parsed.conflicted.is_empty());
    }

    #[test]
    fn parses_added_staged_only_and_deleted_unstaged_only() {
        let out = format!(
            "{}{}",
            ordinary("A.", "new.txt"),
            ordinary(".D", "gone.txt")
        );
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(parsed.staged, vec![entry("new.txt", None, "added")]);
        assert_eq!(parsed.unstaged, vec![entry("gone.txt", None, "deleted")]);
    }

    #[test]
    fn parses_rename_with_score_and_orig_path() {
        // 2 记录：path 之后的下一个 NUL token 是原路径
        let out = format!(
            "2 R. N... 100644 100644 100644 {} {} R100 renamed.txt\0a.txt\0{}",
            AAA,
            AAA,
            ordinary(".M", "other.txt")
        );
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(
            parsed.staged,
            vec![entry("renamed.txt", Some("a.txt"), "renamed")]
        );
        assert_eq!(parsed.unstaged, vec![entry("other.txt", None, "modified")]);
    }

    #[test]
    fn parses_rename_with_worktree_modification() {
        let out = format!(
            "2 RM N... 100644 100644 100644 {} {} R087 new name.txt\0old.txt\0",
            AAA, AAA
        );
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(
            parsed.staged,
            vec![entry("new name.txt", Some("old.txt"), "renamed")]
        );
        // Y=M：worktree 里的后续修改没有 old_path
        assert_eq!(
            parsed.unstaged,
            vec![entry("new name.txt", None, "modified")]
        );
    }

    #[test]
    fn parses_typechange_and_paths_with_spaces() {
        let out = ordinary(".T", "my file link");
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(
            parsed.unstaged,
            vec![entry("my file link", None, "typechange")]
        );
        assert!(parsed.staged.is_empty());
    }

    #[test]
    fn parses_submodule_change_as_modified() {
        // submodule 的 sub 字段形如 SC..，mode 160000
        let out = format!("1 .M SC.. 160000 160000 160000 {} {} smod\0", AAA, AAA);
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(parsed.unstaged, vec![entry("smod", None, "modified")]);
    }

    #[test]
    fn parses_unmerged_conflict_record() {
        let out = format!(
            "u UU N... 100644 100644 100644 100644 {} {} {} conflict file.txt\0",
            AAA, AAA, AAA
        );
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(parsed.conflicted, vec!["conflict file.txt".to_string()]);
        assert!(parsed.staged.is_empty());
        assert!(parsed.unstaged.is_empty());
    }

    #[test]
    fn xy_with_u_goes_to_conflicted() {
        let parsed = parse_porcelain_v2(&ordinary("DU", "both.txt"));
        assert_eq!(parsed.conflicted, vec!["both.txt".to_string()]);
    }

    #[test]
    fn empty_repo_initial_branch_header_is_skipped() {
        let out = format!(
            "# branch.oid (initial)\0# branch.head main\0{}",
            ordinary("A.", "first.txt")
        );
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(parsed.staged, vec![entry("first.txt", None, "added")]);
    }

    #[test]
    fn untracked_and_ignored_records_are_skipped() {
        let out = format!("? stray.txt\0! build.log\0{}", ordinary("M.", "a.txt"));
        let parsed = parse_porcelain_v2(&out);
        assert_eq!(parsed.staged.len(), 1);
        assert!(parsed.conflicted.is_empty());
    }

    #[test]
    fn parse_untracked_z_splits_on_nul() {
        assert_eq!(
            parse_untracked_z(".gitignore\0new dir/f1.txt\0top.txt\0", 10),
            vec![
                ".gitignore".to_string(),
                "new dir/f1.txt".to_string(),
                "top.txt".to_string()
            ]
        );
        assert!(parse_untracked_z("", 10).is_empty());
    }

    #[test]
    fn parse_untracked_z_caps_at_max() {
        let out = "a\0b\0c\0";
        assert_eq!(
            parse_untracked_z(out, 2),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(parse_untracked_z(out, 0).len(), 0);
    }

    #[test]
    fn count_untracked_z_counts_all_without_cap() {
        assert_eq!(count_untracked_z("a\0b\0c\0"), 3);
        assert_eq!(count_untracked_z(""), 0);
        // 与事故现场同量级：2.5 万条路径只计数不收集，必须瞬间完成。
        let big: String = (0..25_000)
            .map(|i| format!("dir{}/f{}\0", i % 50, i))
            .collect();
        assert_eq!(count_untracked_z(&big), 25_000);
        assert_eq!(
            parse_untracked_z(&big, UNTRACKED_MAX_ENTRIES).len(),
            UNTRACKED_MAX_ENTRIES
        );
    }

    #[test]
    fn parse_branch_has_head_detects_initial() {
        assert!(!parse_branch_has_head(
            "# branch.oid (initial)\0# branch.head main\0"
        ));
        assert!(parse_branch_has_head(
            "# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0# branch.head main\0"
        ));
        // 头部缺失时保守按"已有提交"，避免误触发新手提示
        assert!(parse_branch_has_head(
            "1 .M N... 100644 100644 100644 a a x\0"
        ));
    }

    #[test]
    fn truncate_entries_reports_total_and_caps() {
        let (v, total) = truncate_entries(vec![1, 2, 3], 2);
        assert_eq!(v, vec![1, 2]);
        assert_eq!(total, 3);

        let (v, total) = truncate_entries(vec!["a"], 2000);
        assert_eq!(v, vec!["a"]);
        assert_eq!(total, 1);
    }

    #[test]
    fn binary_patch_detection() {
        assert!(is_binary_patch(
            "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n"
        ));
        assert!(is_binary_patch("diff --git a/a b/a\nGIT binary patch\n"));
        assert!(!is_binary_patch(
            "diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y\n"
        ));
    }

    #[test]
    fn truncate_patch_keeps_short_patches() {
        let patch = "a\nb\nc\n";
        let (out, truncated) = truncate_patch(patch, 3);
        assert_eq!(out, patch);
        assert!(!truncated);

        let (out, truncated) = truncate_patch("a\nb", 5);
        assert_eq!(out, "a\nb");
        assert!(!truncated);
    }

    #[test]
    fn truncate_patch_cuts_long_patches() {
        let patch = "l1\nl2\nl3\nl4\n";
        let (out, truncated) = truncate_patch(patch, 2);
        assert_eq!(out, "l1\nl2\n");
        assert!(truncated);

        // 无结尾换行的情况
        let (out, truncated) = truncate_patch("l1\nl2\nl3", 2);
        assert_eq!(out, "l1\nl2\n");
        assert!(truncated);
    }

    #[test]
    fn truncate_patch_handles_crlf() {
        // CRLF 内容行内的 \r 不影响按 \n 计数
        let patch = "a\r\nb\r\nc\r\n";
        let (out, truncated) = truncate_patch(patch, 2);
        assert_eq!(out, "a\r\nb\r\n");
        assert!(truncated);
    }

    #[test]
    fn diff_args_staged_with_and_without_head() {
        let args = build_diff_args("staged", true, "a.txt", None).unwrap();
        assert_eq!(
            args,
            vec!["diff", "--cached", "--find-renames", "--", "a.txt"]
        );

        let args = build_diff_args("staged", false, "a.txt", None).unwrap();
        assert_eq!(
            args,
            vec![
                "diff",
                "--cached",
                "--root",
                "--find-renames",
                "--",
                "a.txt"
            ]
        );
    }

    #[test]
    fn diff_args_unstaged_and_rename_old_path() {
        let args = build_diff_args("unstaged", true, "new.txt", Some("old.txt")).unwrap();
        assert_eq!(
            args,
            vec!["diff", "--find-renames", "--", "new.txt", "old.txt"]
        );

        // old == new 或无 old_path 时不重复添加
        let args = build_diff_args("unstaged", true, "same.txt", Some("same.txt")).unwrap();
        assert_eq!(args, vec!["diff", "--find-renames", "--", "same.txt"]);

        assert!(build_diff_args("bogus", true, "a", None).is_err());
    }

    #[test]
    fn stage_and_unstage_args() {
        let paths = vec!["a.txt".to_string(), "b c.txt".to_string()];
        assert_eq!(
            build_stage_args(&paths),
            vec!["add", "--", "a.txt", "b c.txt"]
        );
        assert_eq!(
            build_unstage_args(&paths),
            vec!["reset", "-q", "HEAD", "--", "a.txt", "b c.txt"]
        );
    }

    #[test]
    fn map_status_code_covers_known_letters() {
        assert_eq!(map_status_code('A'), Some("added"));
        assert_eq!(map_status_code('M'), Some("modified"));
        assert_eq!(map_status_code('D'), Some("deleted"));
        assert_eq!(map_status_code('R'), Some("renamed"));
        assert_eq!(map_status_code('C'), Some("added"));
        assert_eq!(map_status_code('T'), Some("typechange"));
        assert_eq!(map_status_code('.'), None);
        assert_eq!(map_status_code('X'), None);
    }

    #[test]
    fn truncate_patch_at_real_limit() {
        let patch: String = (0..DIFF_MAX_LINES + 5)
            .map(|i| format!("line{}\n", i))
            .collect();
        let (out, truncated) = truncate_patch(&patch, DIFF_MAX_LINES);
        assert!(truncated);
        assert_eq!(out.lines().count(), DIFF_MAX_LINES);
    }

    /* ------------------------------------------------ 真实 git 仓库集成测试 */

    /// 在系统临时目录建一个唯一子目录，返回路径；测试结束需自行清理。
    fn make_temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pi-review-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .output()
            .expect("运行 git 失败");
        assert!(
            out.status.success(),
            "git {:?} 失败：{}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn touch_files(dir: &Path, count: usize) {
        for i in 0..count {
            std::fs::File::create(dir.join(format!("f{}.txt", i))).expect("创建文件失败");
        }
    }

    /// 事故现场复刻：刚 git init 的空仓库 + 600 个未跟踪文件。
    /// 列表必须截断到上限，total 给真实总数，has_head 为 false。
    #[test]
    fn collect_status_caps_untracked_in_fresh_repo() {
        let dir = make_temp_dir("fresh");
        git(&dir, &["init", "-q"]);
        touch_files(&dir, 600);

        let status = collect_review_status(dir.to_str().unwrap()).expect("status 失败");
        assert!(status.is_repo);
        assert!(!status.has_head, "刚 init 的仓库应识别为无提交");
        assert_eq!(status.untracked.len(), UNTRACKED_MAX_ENTRIES);
        assert_eq!(status.untracked_total, 600);
        assert_eq!(status.staged_total, 0);
        assert_eq!(status.unstaged_total, 0);
        assert_eq!(status.conflicted_total, 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 提交一个文件后 has_head 变为 true，staged/unstaged 计数正常。
    #[test]
    fn collect_status_after_commit_reports_has_head() {
        let dir = make_temp_dir("committed");
        git(&dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(
            &dir,
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        );
        std::fs::write(dir.join("a.txt"), "changed").unwrap();

        let status = collect_review_status(dir.to_str().unwrap()).expect("status 失败");
        assert!(status.is_repo);
        assert!(status.has_head, "已提交的仓库应识别为已有 HEAD");
        assert_eq!(status.unstaged_total, 1);
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.untracked_total, 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 非仓库目录：is_repo = false，不报错。
    #[test]
    fn collect_status_non_repo_is_not_an_error() {
        let dir = make_temp_dir("plain");
        let status = collect_review_status(dir.to_str().unwrap()).expect("status 失败");
        assert!(!status.is_repo);
        assert_eq!(status.untracked_total, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 大规模模拟（默认 2.5 万个未跟踪文件，对齐事故现场量级）。
    /// 日常 `cargo test` 跳过；手动运行：
    ///   cargo test sim_large_untracked -- --ignored --nocapture
    /// 也可用 REVIEW_SIM_CWD 指向已存在的仓库目录（只读，不创建不删除）。
    #[test]
    #[ignore]
    fn sim_large_untracked_status() {
        let (dir, expected, cleanup) = match std::env::var("REVIEW_SIM_CWD") {
            Ok(cwd) if !cwd.trim().is_empty() => (std::path::PathBuf::from(cwd), None, false),
            _ => {
                let dir = make_temp_dir("sim25k");
                git(&dir, &["init", "-q"]);
                touch_files(&dir, 25_000);
                (dir, Some(25_000u32), true)
            }
        };

        let start = Instant::now();
        let status = collect_review_status(dir.to_str().unwrap()).expect("status 失败");
        let elapsed = start.elapsed();
        eprintln!(
            "[sim] cwd={} is_repo={} has_head={} untracked={} untracked_total={} staged_total={} elapsed={:?}",
            dir.display(),
            status.is_repo,
            status.has_head,
            status.untracked.len(),
            status.untracked_total,
            status.staged_total,
            elapsed
        );

        assert!(status.is_repo);
        assert!(status.untracked.len() <= UNTRACKED_MAX_ENTRIES);
        assert!(status.untracked_total >= status.untracked.len() as u32);
        if let Some(expected) = expected {
            assert_eq!(status.untracked_total, expected);
            assert_eq!(status.untracked.len(), UNTRACKED_MAX_ENTRIES);
            assert!(!status.has_head);
        }
        assert!(
            elapsed < STATUS_GIT_TIMEOUT,
            "status 耗时 {:?} 超过超时 {:?}",
            elapsed,
            STATUS_GIT_TIMEOUT
        );

        if cleanup {
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
