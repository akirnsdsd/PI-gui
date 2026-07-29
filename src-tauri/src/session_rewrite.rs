//! Safely rewrite an attached session to the state immediately before one
//! selected user entry.
//!
//! The command is deliberately generation- and lease-bound. If the matching
//! RPC process is still alive, it is stopped while the committed session lease
//! remains held. The instance mutex stays locked through the atomic rewrite, so
//! that instance cannot restart or write concurrently. Unlike `rpc_stop`, this
//! operation does not detach the session or release its lease.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::{safe_config, session_lease, stop_rpc_instance, RpcState};

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRewriteResult {
    instance_id: String,
    generation: u64,
    session_path: String,
    entry_id: String,
    retained_entry_count: usize,
    removed_entry_count: usize,
    process_stopped: bool,
}

#[derive(Debug)]
struct ParsedEntry {
    raw: String,
    parent_id: Option<String>,
    value: Value,
}

#[derive(Debug)]
struct RewritePlan {
    bytes: Vec<u8>,
    retained_entry_count: usize,
    removed_entry_count: usize,
}

fn required_nonempty_string<'a>(
    value: &'a Value,
    key: &str,
    line_number: usize,
) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("会话第 {} 行缺少有效的 {}", line_number, key))
}

fn parse_parent_id(value: &Value, line_number: usize) -> Result<Option<String>, String> {
    match value.get("parentId") {
        Some(Value::Null) => Ok(None),
        Some(Value::String(parent)) => {
            let parent = parent.trim();
            if parent.is_empty() {
                Err(format!(
                    "会话第 {} 行的 parentId 不能为空字符串",
                    line_number
                ))
            } else {
                Ok(Some(parent.to_string()))
            }
        }
        Some(_) => Err(format!(
            "会话第 {} 行的 parentId 必须是字符串或 null",
            line_number
        )),
        None => Err(format!("会话第 {} 行缺少 parentId", line_number)),
    }
}

fn build_rewrite_plan(content: &str, target_id: &str) -> Result<RewritePlan, String> {
    let target_id = target_id.trim();
    if target_id.is_empty() {
        return Err("entryId 不能为空".to_string());
    }

    let mut nonempty_lines =
        content
            .split_terminator('\n')
            .enumerate()
            .filter_map(|(index, raw)| {
                let raw = raw.strip_suffix('\r').unwrap_or(raw);
                (!raw.trim().is_empty()).then_some((index + 1, raw))
            });

    let (header_line_number, header_raw) = nonempty_lines
        .next()
        .ok_or_else(|| "会话文件为空".to_string())?;
    let header: Value = serde_json::from_str(header_raw)
        .map_err(|error| format!("会话第 {} 行 JSON 无效：{}", header_line_number, error))?;
    if !header.is_object() || header.get("type").and_then(Value::as_str) != Some("session") {
        return Err("会话首个非空行必须是 session header".to_string());
    }
    let header_id = required_nonempty_string(&header, "id", header_line_number)?;

    let mut entries = HashMap::<String, ParsedEntry>::new();
    let mut seen_ids = HashSet::from([header_id.to_string()]);
    let mut total_entries = 0_usize;
    for (line_number, raw) in nonempty_lines {
        let value: Value = serde_json::from_str(raw)
            .map_err(|error| format!("会话第 {} 行 JSON 无效：{}", line_number, error))?;
        if !value.is_object() {
            return Err(format!("会话第 {} 行必须是 JSON object", line_number));
        }
        let id = required_nonempty_string(&value, "id", line_number)?.to_string();
        let parent_id = parse_parent_id(&value, line_number)?;
        if !seen_ids.insert(id.clone()) {
            return Err(format!("会话 entry id 重复：{}", id));
        }
        entries.insert(
            id,
            ParsedEntry {
                raw: raw.to_string(),
                parent_id,
                value,
            },
        );
        total_entries += 1;
    }

    // Validate the entire entry graph, not only the selected branch. A corrupt
    // sibling branch must not be silently discarded by a successful rewrite.
    for entry_id in entries.keys() {
        let mut visited = HashSet::new();
        let mut cursor = Some(entry_id.as_str());
        while let Some(id) = cursor {
            if !visited.insert(id.to_string()) {
                return Err(format!("会话 entry 祖先链存在环：{}", id));
            }
            let entry = entries
                .get(id)
                .ok_or_else(|| format!("会话 entry 的祖先不存在：{}", id))?;
            cursor = entry.parent_id.as_deref();
        }
    }

    let target = entries
        .get(target_id)
        .ok_or_else(|| format!("未找到 entryId：{}", target_id))?;
    let is_user_message = target.value.get("type").and_then(Value::as_str) == Some("message")
        && target
            .value
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            == Some("user");
    if !is_user_message {
        return Err(format!("entry '{}' 不是 user message", target_id));
    }

    let mut ancestor_ids = Vec::new();
    let mut visited = HashSet::new();
    let mut cursor = target.parent_id.as_deref();
    while let Some(id) = cursor {
        if !visited.insert(id.to_string()) {
            return Err(format!("目标 entry 的祖先链存在环：{}", id));
        }
        let ancestor = entries
            .get(id)
            .ok_or_else(|| format!("目标 entry 的祖先不存在：{}", id))?;
        ancestor_ids.push(id.to_string());
        cursor = ancestor.parent_id.as_deref();
    }
    ancestor_ids.reverse();

    let mut rewritten = String::new();
    rewritten.push_str(header_raw);
    rewritten.push('\n');
    for id in &ancestor_ids {
        rewritten.push_str(&entries[id].raw);
        rewritten.push('\n');
    }

    Ok(RewritePlan {
        bytes: rewritten.into_bytes(),
        retained_entry_count: ancestor_ids.len(),
        removed_entry_count: total_entries.saturating_sub(ancestor_ids.len()),
    })
}

fn rewrite_session_file(path: &Path, entry_id: &str) -> Result<(usize, usize), String> {
    let content = fs::read_to_string(path).map_err(|error| format!("读取会话失败：{}", error))?;
    let plan = build_rewrite_plan(&content, entry_id)?;
    safe_config::atomic_write(path, &plan.bytes, Some(0o600))?;
    Ok((plan.retained_entry_count, plan.removed_entry_count))
}

/// Stop one generation (if still active), retain its exact committed lease,
/// and atomically rewrite the leased file before `entry_id`.
#[tauri::command]
pub(crate) fn rewrite_session_before_user_entry(
    state: tauri::State<'_, RpcState>,
    instance_id: String,
    generation: u64,
    session_path: String,
    entry_id: String,
) -> Result<SessionRewriteResult, String> {
    rewrite_session_for_state(
        state.inner(),
        instance_id,
        generation,
        session_path,
        entry_id,
    )
}

/// Stop one exact RPC generation without releasing its committed session
/// lease. This is used only while recovering a rewrite that already committed.
#[tauri::command]
pub(crate) fn stop_rpc_process_retain_session_lease(
    state: tauri::State<'_, RpcState>,
    instance_id: String,
    generation: u64,
    session_path: String,
) -> Result<bool, String> {
    stop_process_retain_lease_for_state(state.inner(), &instance_id, generation, &session_path)
}

fn stop_process_retain_lease_for_state(
    state: &RpcState,
    instance_id: &str,
    generation: u64,
    session_path: &str,
) -> Result<bool, String> {
    let instance_id = instance_id.trim();
    if instance_id.is_empty() {
        return Err("instanceId 不能为空".to_string());
    }
    let normalized_path = session_lease::normalize_session_path(session_path)?;
    let mut instances = state
        .instances
        .lock()
        .map_err(|_| "获取 RPC 实例锁失败".to_string())?;
    let current_generation = state
        .generations
        .lock()
        .map_err(|_| "获取 RPC generation 锁失败".to_string())?
        .get(instance_id)
        .copied()
        .ok_or_else(|| format!("实例 '{}' 没有 RPC generation", instance_id))?;
    if current_generation != generation {
        return Err(format!(
            "实例 '{}' generation 已变化（期望 {}，当前 {}）",
            instance_id, generation, current_generation
        ));
    }
    if instances
        .get(instance_id)
        .is_some_and(|handle| handle.generation != generation)
    {
        return Err(format!(
            "实例 '{}' 的进程 generation 与请求不一致",
            instance_id
        ));
    }
    if state
        .pending_leases
        .lock()
        .map_err(|_| "获取未决会话租约锁失败".to_string())?
        .contains_key(instance_id)
    {
        return Err("会话切换正在处理中，不能保留租约停止进程".to_string());
    }
    let leases = state
        .leases
        .lock()
        .map_err(|_| "获取会话租约锁失败".to_string())?;
    let committed_path = leases
        .get(instance_id)
        .map(|lease| lease.normalized_path())
        .ok_or_else(|| format!("实例 '{}' 未持有已提交的会话租约", instance_id))?;
    if committed_path != normalized_path {
        return Err("请求路径与实例已提交的会话租约不一致".to_string());
    }

    let stopped = if let Some(handle) = instances.get_mut(instance_id) {
        let was_active = handle.process.is_some() || handle.stdin_writer.is_some();
        if was_active {
            stop_rpc_instance(handle);
        }
        was_active
    } else {
        false
    };
    drop(leases);
    drop(instances);
    Ok(stopped)
}

fn rewrite_session_for_state(
    state: &RpcState,
    instance_id: String,
    generation: u64,
    session_path: String,
    entry_id: String,
) -> Result<SessionRewriteResult, String> {
    let instance_id = instance_id.trim().to_string();
    if instance_id.is_empty() {
        return Err("instanceId 不能为空".to_string());
    }
    let normalized_path = session_lease::normalize_session_path(&session_path)?;

    // rpc_start/rpc_send/rpc_stop all serialize on `instances`. Holding it
    // through replacement prevents a restart or stdin write from racing us.
    let mut instances = state
        .instances
        .lock()
        .map_err(|_| "获取 RPC 实例锁失败".to_string())?;
    let current_generation = state
        .generations
        .lock()
        .map_err(|_| "获取 RPC generation 锁失败".to_string())?
        .get(&instance_id)
        .copied()
        .ok_or_else(|| format!("实例 '{}' 没有 RPC generation", instance_id))?;
    if current_generation != generation {
        return Err(format!(
            "实例 '{}' generation 已变化（期望 {}，当前 {}）",
            instance_id, generation, current_generation
        ));
    }
    if instances
        .get(&instance_id)
        .is_some_and(|handle| handle.generation != generation)
    {
        return Err(format!(
            "实例 '{}' 的进程 generation 与请求不一致",
            instance_id
        ));
    }

    let pendings = state
        .pending_leases
        .lock()
        .map_err(|_| "获取未决会话租约锁失败".to_string())?;
    if pendings.contains_key(&instance_id) {
        return Err("会话切换正在处理中，不能改写会话".to_string());
    }
    let leases = state
        .leases
        .lock()
        .map_err(|_| "获取会话租约锁失败".to_string())?;
    let committed_path = leases
        .get(&instance_id)
        .map(|lease| lease.normalized_path())
        .ok_or_else(|| format!("实例 '{}' 未持有已提交的会话租约", instance_id))?;
    if committed_path != normalized_path {
        return Err("请求路径与实例已提交的会话租约不一致".to_string());
    }

    let process_stopped = if let Some(handle) = instances.get_mut(&instance_id) {
        let was_active = handle.process.is_some() || handle.stdin_writer.is_some();
        if was_active {
            stop_rpc_instance(handle);
        }
        was_active
    } else {
        false
    };

    // Keep `instances`, `pendings`, and `leases` locked until the durable
    // replacement completes. In particular, dropping `leases` early would
    // let rpc_stop detach the session during the write.
    let path = Path::new(&normalized_path);
    let (retained_entry_count, removed_entry_count) = rewrite_session_file(path, &entry_id)?;
    drop(leases);
    drop(pendings);
    drop(instances);

    Ok(SessionRewriteResult {
        instance_id,
        generation,
        session_path: normalized_path,
        entry_id: entry_id.trim().to_string(),
        retained_entry_count,
        removed_entry_count,
        process_stopped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LeaseTransition, PendingSessionLease};
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    const HEADER: &str = r#"{"type":"session","version":3,"id":"session-1","cwd":"/tmp/project"}"#;

    fn entry(id: &str, parent: Option<&str>, role: &str, content: &str) -> String {
        let parent = parent
            .map(|value| serde_json::to_string(value).unwrap())
            .unwrap_or_else(|| "null".to_string());
        format!(
            r#"{{"type":"message","id":"{}","parentId":{},"message":{{"role":"{}","content":{}}}}}"#,
            id, parent, role, content
        )
    }

    fn session(lines: &[String]) -> String {
        let mut content = format!("{}\n", HEADER);
        for line in lines {
            content.push_str(line);
            content.push('\n');
        }
        content
    }

    fn output(plan: &RewritePlan) -> String {
        String::from_utf8(plan.bytes.clone()).unwrap()
    }

    fn temp_path(tag: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "pi-session-rewrite-{}-{}-{}.jsonl",
            tag,
            std::process::id(),
            stamp
        ))
    }

    fn leased_state(
        instance_id: &str,
        generation: u64,
        session_path: &Path,
    ) -> (RpcState, std::path::PathBuf) {
        let state = RpcState::default();
        state
            .generations
            .lock()
            .unwrap()
            .insert(instance_id.to_string(), generation);
        let lease_root = temp_path("leases");
        let lease =
            session_lease::SessionLease::acquire(&lease_root, session_path.to_str().unwrap())
                .unwrap();
        state
            .leases
            .lock()
            .unwrap()
            .insert(instance_id.to_string(), lease);
        (state, lease_root)
    }

    #[test]
    fn linear_history_keeps_only_ancestors_before_target() {
        let root = entry("u1", None, "user", r#""first""#);
        let assistant = entry("a1", Some("u1"), "assistant", r#""answer""#);
        let target = entry("u2", Some("a1"), "user", r#""second""#);
        let after = entry("a2", Some("u2"), "assistant", r#""later""#);
        let plan = build_rewrite_plan(
            &session(&[root.clone(), assistant.clone(), target, after]),
            "u2",
        )
        .unwrap();
        assert_eq!(
            output(&plan),
            format!("{}\n{}\n{}\n", HEADER, root, assistant)
        );
        assert_eq!(plan.retained_entry_count, 2);
        assert_eq!(plan.removed_entry_count, 2);
    }

    #[test]
    fn branched_physical_order_is_rewritten_in_ancestor_order() {
        let root = entry("u1", None, "user", r#""root""#);
        let branch_b = entry("b", Some("u1"), "assistant", r#""branch b""#);
        let target = entry("target", Some("a"), "user", r#""same text""#);
        let branch_a = entry("a", Some("u1"), "assistant", r#""branch a""#);
        let plan = build_rewrite_plan(
            &session(&[branch_b, target, root.clone(), branch_a.clone()]),
            "target",
        )
        .unwrap();
        assert_eq!(
            output(&plan),
            format!("{}\n{}\n{}\n", HEADER, root, branch_a)
        );
    }

    #[test]
    fn first_user_rewrites_to_unchanged_header_only() {
        let target = entry("first", None, "user", r#""hello""#);
        let plan = build_rewrite_plan(&session(&[target]), "first").unwrap();
        assert_eq!(output(&plan), format!("{}\n", HEADER));
        assert_eq!(plan.retained_entry_count, 0);
        assert_eq!(plan.removed_entry_count, 1);
    }

    #[test]
    fn image_only_user_is_a_valid_target() {
        let target = entry("image", None, "user", r#"[{"type":"image","data":"abc"}]"#);
        assert!(build_rewrite_plan(&session(&[target]), "image").is_ok());
    }

    #[test]
    fn duplicate_text_selects_exact_entry_id() {
        let first = entry("first", None, "user", r#""duplicate""#);
        let answer = entry("answer", Some("first"), "assistant", r#""ok""#);
        let second = entry("second", Some("answer"), "user", r#""duplicate""#);
        let plan = build_rewrite_plan(&session(&[first.clone(), answer.clone(), second]), "second")
            .unwrap();
        assert_eq!(
            output(&plan),
            format!("{}\n{}\n{}\n", HEADER, first, answer)
        );
    }

    #[test]
    fn invalid_inputs_never_replace_original_file() {
        let cases = [
            ("malformed", format!("{}\nnot-json\n", HEADER), "target"),
            (
                "duplicate-id",
                session(&[
                    entry("dup", None, "assistant", r#""a""#),
                    entry("dup", None, "user", r#""b""#),
                ]),
                "dup",
            ),
            (
                "missing-parent",
                session(&[entry("target", Some("missing"), "user", r#""x""#)]),
                "target",
            ),
            (
                "missing-parent-on-sibling",
                session(&[
                    entry("target", None, "user", r#""x""#),
                    entry("sibling", Some("missing"), "assistant", r#""bad""#),
                ]),
                "target",
            ),
            (
                "cycle",
                session(&[
                    entry("a", Some("b"), "assistant", r#""a""#),
                    entry("b", Some("a"), "assistant", r#""b""#),
                    entry("target", Some("a"), "user", r#""x""#),
                ]),
                "target",
            ),
            (
                "cycle-on-sibling",
                session(&[
                    entry("target", None, "user", r#""x""#),
                    entry("a", Some("b"), "assistant", r#""a""#),
                    entry("b", Some("a"), "assistant", r#""b""#),
                ]),
                "target",
            ),
            (
                "not-user",
                session(&[entry("target", None, "assistant", r#""x""#)]),
                "target",
            ),
            (
                "missing-target",
                session(&[entry("other", None, "user", r#""x""#)]),
                "target",
            ),
        ];

        for (tag, original, target) in cases {
            let path = temp_path(tag);
            fs::write(&path, &original).unwrap();
            assert!(
                rewrite_session_file(&path, target).is_err(),
                "case {tag} must fail"
            );
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                original,
                "case {tag} changed the original"
            );
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn successful_rewrite_creates_recoverable_backup() {
        let path = temp_path("backup");
        let original = session(&[
            entry("first", None, "user", r#""one""#),
            entry("target", Some("first"), "user", r#""two""#),
        ]);
        fs::write(&path, &original).unwrap();
        rewrite_session_file(&path, "target").unwrap();

        let mut backup_dir_name = path.as_os_str().to_owned();
        backup_dir_name.push(".backups");
        let backups: Vec<_> = fs::read_dir(Path::new(&backup_dir_name))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), original);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(Path::new(&backup_dir_name));
    }

    #[test]
    fn state_guard_rejects_stale_generation_pending_transition_and_wrong_lease() {
        let path = temp_path("state-guard");
        fs::write(
            &path,
            session(&[entry("target", None, "user", r#""hello""#)]),
        )
        .unwrap();
        let original = fs::read_to_string(&path).unwrap();
        let (state, lease_root) = leased_state("tab", 7, &path);

        let stale = rewrite_session_for_state(
            &state,
            "tab".into(),
            6,
            path.to_string_lossy().into_owned(),
            "target".into(),
        )
        .unwrap_err();
        assert!(stale.contains("generation 已变化"));

        state.pending_leases.lock().unwrap().insert(
            "tab".into(),
            PendingSessionLease {
                request_id: "switch".into(),
                generation: 7,
                transition: LeaseTransition::Release,
                acquire_path_from_response: false,
            },
        );
        let pending = rewrite_session_for_state(
            &state,
            "tab".into(),
            7,
            path.to_string_lossy().into_owned(),
            "target".into(),
        )
        .unwrap_err();
        assert!(pending.contains("切换正在处理中"));
        state.pending_leases.lock().unwrap().remove("tab");

        let other = temp_path("other-session");
        fs::write(&other, HEADER).unwrap();
        let mismatch = rewrite_session_for_state(
            &state,
            "tab".into(),
            7,
            other.to_string_lossy().into_owned(),
            "target".into(),
        )
        .unwrap_err();
        assert!(mismatch.contains("租约不一致"));
        assert_eq!(fs::read_to_string(&path).unwrap(), original);

        drop(state);
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(other);
        let _ = fs::remove_dir_all(lease_root);
    }

    #[cfg(unix)]
    #[test]
    fn active_process_is_stopped_while_committed_lease_is_retained() {
        let path = temp_path("active-process");
        fs::write(
            &path,
            session(&[entry("target", None, "user", r#""hello""#)]),
        )
        .unwrap();
        let (state, lease_root) = leased_state("tab", 3, &path);
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        state.instances.lock().unwrap().insert(
            "tab".into(),
            crate::RpcProcessHandle {
                generation: 3,
                process: Some(child),
                stdin_writer: stdin,
            },
        );

        let result = rewrite_session_for_state(
            &state,
            "tab".into(),
            3,
            path.to_string_lossy().into_owned(),
            "target".into(),
        )
        .unwrap();
        assert!(result.process_stopped);
        let instances = state.instances.lock().unwrap();
        let handle = instances.get("tab").unwrap();
        assert!(handle.process.is_none());
        assert!(handle.stdin_writer.is_none());
        drop(instances);
        assert!(
            state.leases.lock().unwrap().contains_key("tab"),
            "rewrite stop must retain the committed lease"
        );

        drop(state);
        let _ = fs::remove_file(&path);
        let mut backup_dir = path.as_os_str().to_owned();
        backup_dir.push(".backups");
        let _ = fs::remove_dir_all(Path::new(&backup_dir));
        let _ = fs::remove_dir_all(lease_root);
    }

    #[cfg(unix)]
    #[test]
    fn recovery_stop_keeps_exact_committed_lease() {
        let path = temp_path("recovery-stop");
        fs::write(&path, HEADER).unwrap();
        let (state, lease_root) = leased_state("tab", 11, &path);
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        state.instances.lock().unwrap().insert(
            "tab".into(),
            crate::RpcProcessHandle {
                generation: 11,
                process: Some(child),
                stdin_writer: stdin,
            },
        );

        let stopped =
            stop_process_retain_lease_for_state(&state, "tab", 11, path.to_str().unwrap()).unwrap();
        assert!(stopped);
        let instances = state.instances.lock().unwrap();
        let handle = instances.get("tab").unwrap();
        assert!(handle.process.is_none());
        assert!(handle.stdin_writer.is_none());
        drop(instances);
        assert_eq!(
            state
                .leases
                .lock()
                .unwrap()
                .get("tab")
                .unwrap()
                .normalized_path(),
            session_lease::normalize_session_path(path.to_str().unwrap()).unwrap()
        );

        drop(state);
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(lease_root);
    }
}
