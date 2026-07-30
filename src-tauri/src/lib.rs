use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

mod channel_save;
mod extensions;
mod review;
mod safe_config;
mod session_lease;
mod session_rewrite;
mod subagents;

#[derive(Default)]
struct RpcProcessHandle {
    generation: u64,
    process: Option<Child>,
    stdin_writer: Option<std::process::ChildStdin>,
}

/// State for managing multiple RPC child processes (one per instance)
pub struct RpcState {
    instances: Arc<Mutex<HashMap<String, RpcProcessHandle>>>,
    /// instance_id -> 最近分配的 RPC lifecycle generation。
    /// 独立于 instances 保存，stop 删除 process handle 后也不得复用旧 generation。
    generations: Arc<Mutex<HashMap<String, u64>>>,
    /// instance_id -> 会话租约（attach 前取锁，detach/stop 时释放）
    leases: Arc<Mutex<HashMap<String, session_lease::SessionLease>>>,
    /// instance_id -> 未决的会话租约迁移（两阶段提交：等 pi 响应裁决，
    /// 成功 commit / error·cancelled·超时·进程死亡回滚）
    pending_leases: Arc<Mutex<HashMap<String, PendingSessionLease>>>,
}

impl Default for RpcState {
    fn default() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            generations: Arc::new(Mutex::new(HashMap::new())),
            leases: Arc::new(Mutex::new(HashMap::new())),
            pending_leases: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
struct RpcLineEventPayload {
    instance_id: String,
    generation: u64,
    line: String,
}

#[derive(Debug, Serialize, Clone)]
struct RpcClosedEventPayload {
    instance_id: String,
    generation: u64,
    reason: String,
}

#[derive(Debug, Serialize)]
struct RpcStartResult {
    discovery: String,
    generation: u64,
}

fn normalize_instance_id(instance_id: Option<String>) -> String {
    let raw = instance_id.unwrap_or_else(|| "default".to_string());
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Atomically allocate a lifecycle generation that remains unique for this
/// instance even when its process handle is removed by stop.
fn next_rpc_generation(state: &RpcState, instance_id: &str) -> Result<u64, String> {
    let mut generations = state
        .generations
        .lock()
        .map_err(|_| "获取 RPC generation 锁失败".to_string())?;
    let current = generations.entry(instance_id.to_string()).or_insert(0);
    *current = current
        .checked_add(1)
        .ok_or_else(|| format!("实例 '{}' 的 RPC generation 已耗尽", instance_id))?;
    Ok(*current)
}

/// Allocate a generation only after every fallible pre-spawn/preparation step
/// has succeeded. This keeps the frontend's `current + 1` pending generation
/// aligned with the next process that can actually emit events.
fn assign_generation_to_prepared_rpc<T>(
    state: &RpcState,
    instance_id: &str,
    prepared: Result<T, String>,
) -> Result<(u64, T), String> {
    let prepared = prepared?;
    let generation = next_rpc_generation(state, instance_id)?;
    Ok((generation, prepared))
}

/// Send a signal to the child's whole process group (unix only; the child is
/// spawned as its own process-group leader, so pgid == pid). This is what
/// reaps grandchildren (bash, MCP servers, ...) that a plain `child.kill()`
/// would leak.
#[cfg(unix)]
fn signal_process_group(pid: u32, signal: &str) {
    let _ = Command::new("kill")
        .arg(format!("-{}", signal))
        .arg(format!("-{}", pid))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Wait until `child` exits or `timeout` elapses. Returns true if the child exited.
#[cfg_attr(not(unix), allow(dead_code))]
fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return true,
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Graceful-then-forced shutdown of one RPC child and its process tree.
/// unix: SIGTERM the process group, wait, then SIGKILL the group, with a direct
/// `child.kill()` fallback. Windows keeps the previous direct-kill behavior.
fn terminate_child_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        signal_process_group(child.id(), "TERM");
        if wait_for_child_exit(child, Duration::from_millis(2_000)) {
            return;
        }
        signal_process_group(child.id(), "KILL");
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_rpc_instance(handle: &mut RpcProcessHandle) {
    handle.stdin_writer = None;
    if let Some(mut child) = handle.process.take() {
        terminate_child_tree(&mut child);
    }
}

/// Full exit orchestration shared by `rpc_stop_all` and the app exit handler:
/// 1. send `abort` to every runtime and give it up to `abort_wait` to wind down
/// 2. SIGTERM every process group, wait up to `term_wait`
/// 3. SIGKILL whatever is still alive (with direct-kill fallback)
fn shutdown_all_instances(state: &RpcState, abort_wait: Duration, term_wait: Duration) {
    let mut instances = match state.instances.lock() {
        Ok(instances) => instances,
        Err(_) => return,
    };

    // 1) Ask every runtime to abort its current run, then wait for graceful exits.
    for handle in instances.values_mut() {
        if let Some(ref mut stdin) = handle.stdin_writer {
            let _ = write_rpc_line(stdin, r#"{"type":"abort"}"#);
        }
    }
    wait_for_all_children_exit(&mut instances, abort_wait);

    // 2) TERM all remaining process groups at once, then wait.
    #[cfg(unix)]
    for handle in instances.values_mut() {
        if let Some(ref child) = handle.process {
            signal_process_group(child.id(), "TERM");
        }
    }
    wait_for_all_children_exit(&mut instances, term_wait);

    // 3) Force-kill anything left and drain the map.
    for (_, mut handle) in instances.drain() {
        handle.stdin_writer = None;
        if let Some(mut child) = handle.process.take() {
            #[cfg(unix)]
            signal_process_group(child.id(), "KILL");
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // 4) 释放所有会话租约（Drop 删除锁目录），进程退出场景依赖这里清理。
    if let Ok(mut leases) = state.leases.lock() {
        leases.clear();
    }
    // 5) 未决的租约迁移一并回滚（Drop 其未提交的新租约）。
    if let Ok(mut pendings) = state.pending_leases.lock() {
        pendings.clear();
    }
}

fn wait_for_all_children_exit(
    instances: &mut HashMap<String, RpcProcessHandle>,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let mut all_exited = true;
        for handle in instances.values_mut() {
            if let Some(ref mut child) = handle.process {
                match child.try_wait() {
                    Ok(Some(_)) => {}
                    Ok(None) => all_exited = false,
                    Err(_) => {}
                }
            }
        }
        if all_exited {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RpcStartOptions {
    /// Dev-mode only: path to the CLI JS file (e.g. "../coding-agent/dist/cli.js").
    /// When null/empty, the backend discovers the pi binary automatically.
    cli_path: Option<String>,
    /// Optional explicit pi binary path override from Desktop settings.
    /// When set, this takes precedence over sidecar/PATH/common-location discovery.
    pi_path: Option<String>,
    cwd: String,
    provider: Option<String>,
    model: Option<String>,
    /// Resume one exact session file instead of creating a new session.
    session_path: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
}

/// How the pi process was resolved
#[derive(Debug, Clone)]
enum PiProcess {
    /// Dev mode: node <script> --mode rpc
    DevNode { script: String },
    /// Packaged sidecar binary bundled with the desktop app
    SidecarBinary { path: std::path::PathBuf },
    /// Production/dev fallback: standalone pi binary found on PATH
    PathBinary { path: std::path::PathBuf },
}

fn find_sidecar_in_dir(dir: &Path, expected_name: &str) -> Option<PathBuf> {
    let exact = dir.join(expected_name);
    if exact.is_file() {
        return Some(exact);
    }

    None
}

fn discover_sidecar(app: &AppHandle) -> Option<PathBuf> {
    let default_target = if cfg!(target_os = "windows") {
        format!("{}-pc-windows-msvc", std::env::consts::ARCH)
    } else if cfg!(target_os = "macos") {
        format!("{}-apple-darwin", std::env::consts::ARCH)
    } else if cfg!(target_os = "linux") {
        format!("{}-unknown-linux-gnu", std::env::consts::ARCH)
    } else {
        format!(
            "{}-unknown-{}",
            std::env::consts::ARCH,
            std::env::consts::OS
        )
    };

    let target = std::env::var("TARGET").unwrap_or(default_target);

    let extension = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let expected_name = format!("pi-{}{}", target, extension);

    let mut candidate_dirs: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidate_dirs.push(resource_dir.clone());
        candidate_dirs.push(resource_dir.join("binaries"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidate_dirs.push(parent.to_path_buf());
            candidate_dirs.push(parent.join("binaries"));
            candidate_dirs.push(parent.join(".."));
            candidate_dirs.push(parent.join("..").join("Resources"));
            candidate_dirs.push(parent.join("..").join("Resources").join("binaries"));
        }
    }

    for dir in candidate_dirs {
        if !dir.exists() || !dir.is_dir() {
            continue;
        }
        if let Some(found) = find_sidecar_in_dir(&dir, &expected_name) {
            return Some(found);
        }
    }

    None
}

fn resolve_home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        if !user_profile.trim().is_empty() {
            return Some(PathBuf::from(user_profile));
        }
    }
    None
}

pub(crate) fn expand_tilde_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        if let Some(home) = resolve_home_dir() {
            return home;
        }
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = resolve_home_dir() {
            return home.join(rest);
        }
    }
    if let Some(rest) = trimmed.strip_prefix("~\\") {
        if let Some(home) = resolve_home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

/// 会话租约存放根目录：<应用 config 目录>/leases。
fn session_leases_root(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败：{}", e))?;
    Ok(config_dir.join("leases"))
}

/// 租约相关的 outbound 命令类别。
#[derive(Debug, PartialEq, Eq)]
enum LeaseCommandKind {
    /// switch_session 且携带有效 sessionPath：attach 前取新会话的锁
    Switch(String),
    /// new_session：成功响应携带路径时直接迁移；否则保留旧锁，等待前端
    /// get_state 后通过 generation-bound claim 提交。
    New,
}

/// 解析 outbound 命令的 method 与请求 id：仅当 type 为 switch_session（带有效
/// sessionPath）或 new_session、且带非空字符串 id 时返回 Some——两阶段提交靠
/// id 关联 pi 的响应，无 id 的命令无法确认结果，不进租约流程（调用方按无迁移
/// 处理；前端 send() 总是带 id）。快速路径：不含关键字的命令（prompt/abort 等
/// 高频消息）不做 JSON 解析。
fn parse_lease_command(command: &str) -> Option<(String, LeaseCommandKind)> {
    if !command.contains("switch_session") && !command.contains("new_session") {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(command).ok()?;
    let ty = value.get("type").and_then(|t| t.as_str())?;
    let id = value
        .get("id")
        .and_then(|i| i.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    match ty {
        "switch_session" => {
            let path = value
                .get("sessionPath")
                .and_then(|p| p.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)?;
            Some((id, LeaseCommandKind::Switch(path)))
        }
        "new_session" => Some((id, LeaseCommandKind::New)),
        _ => None,
    }
}

/// 租约状态迁移：pi 确认（成功响应）后由两阶段流程提交。
enum LeaseTransition {
    /// 附着新会话：已拿到新租约，提交时替换旧租约
    Replace(session_lease::SessionLease),
    /// 切到无锁会话：提交时释放旧租约
    Release,
}

/// 已写入 stdin、等待 pi 响应确认的租约迁移（两阶段提交的 prepare 阶段产物）。
/// 回滚 = 直接 Drop：未提交的 Replace 新租约随之释放，已提交的旧租约不动。
struct PendingSessionLease {
    /// outbound 命令的请求 id，用于匹配 pi 的响应行
    request_id: String,
    /// 注册时实例的 generation：进程重启后，旧 reader 的 EOF 回滚不得误伤
    /// 新 generation 注册的 pending
    generation: u64,
    transition: LeaseTransition,
    /// new_session：提交时尝试从响应 data 里取新会话路径占锁；无路径或
    /// 获取失败时保留旧租约，等待后续显式 claim。
    acquire_path_from_response: bool,
}

/// pending 租约迁移的兜底超时：pi 永久不应答（含 handler 抛错时响应不带 id
/// 的情形）按失败回滚。
const PENDING_LEASE_TIMEOUT_SECS: u64 = 30;

/// attach 前取锁（两阶段的第一阶段）。返回 Some(pending) 表示写 stdin 成功后
/// 需要注册 pending 等 pi 响应裁决；None 表示本命令无租约迁移。取锁失败
/// （冲突/路径非法）直接 Err，rpc_send 不会写入命令。
fn prepare_session_lease(
    app: &AppHandle,
    state: &RpcState,
    instance_id: &str,
    command: &str,
) -> Result<Option<PendingSessionLease>, String> {
    let (request_id, kind) = match parse_lease_command(command) {
        Some(parsed) => parsed,
        None => return Ok(None),
    };
    {
        let pendings = state
            .pending_leases
            .lock()
            .map_err(|_| "获取未决会话租约锁失败".to_string())?;
        if pendings.contains_key(instance_id) {
            return Err("会话切换正在处理中，请等待当前切换完成后重试".to_string());
        }
    }
    match kind {
        LeaseCommandKind::Switch(path) => {
            let normalized = session_lease::normalize_session_path(&path)?;
            {
                let leases = state
                    .leases
                    .lock()
                    .map_err(|_| "获取会话租约锁失败".to_string())?;
                if let Some(existing) = leases.get(instance_id) {
                    if existing.normalized_path() == normalized {
                        // 同一 runtime 重复附着同一会话：沿用现有租约，无迁移
                        return Ok(None);
                    }
                }
            }
            let root = session_leases_root(app)?;
            let lease = session_lease::SessionLease::acquire(&root, &path)?;
            Ok(Some(PendingSessionLease {
                request_id,
                generation: 0, // 由 rpc_send 在注册前填入实例当前 generation
                transition: LeaseTransition::Replace(lease),
                acquire_path_from_response: false,
            }))
        }
        LeaseCommandKind::New => Ok(Some(PendingSessionLease {
            request_id,
            generation: 0,
            transition: LeaseTransition::Release,
            acquire_path_from_response: true,
        })),
    }
}

/// 注册 pending 并武装兜底超时。同一实例的会话迁移必须串行：前一个请求收到
/// 响应、失败、超时或进程退出前，后一个 switch/new 不得写入 pi。否则后请求
/// 覆盖 pending 后，前请求若已在 pi 内成功，会造成实际会话与持有租约错位。
fn register_pending_lease(
    state: &RpcState,
    instance_id: &str,
    pending: PendingSessionLease,
) -> Result<(), String> {
    let request_id = pending.request_id.clone();
    let generation = pending.generation;
    {
        let mut map = state
            .pending_leases
            .lock()
            .map_err(|_| "获取未决会话租约锁失败".to_string())?;
        if map.contains_key(instance_id) {
            return Err("会话切换正在处理中，请等待当前切换完成后重试".to_string());
        }
        map.insert(instance_id.to_string(), pending);
    }
    spawn_pending_lease_timeout(
        Arc::clone(&state.pending_leases),
        instance_id.to_string(),
        request_id,
        generation,
        Duration::from_secs(PENDING_LEASE_TIMEOUT_SECS),
    );
    Ok(())
}

/// 兜底超时：timeout 后该 pending 仍在（同 request_id + generation）则移除之，
/// Drop 回滚。generation 防止进程重启后复用 request id 时旧定时器误伤新请求。
fn spawn_pending_lease_timeout(
    pendings: Arc<Mutex<HashMap<String, PendingSessionLease>>>,
    instance_id: String,
    request_id: String,
    generation: u64,
    timeout: Duration,
) {
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        let mut map = match pendings.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        if matches!(
            map.get(&instance_id),
            Some(p) if p.request_id == request_id && p.generation == generation
        ) {
            map.remove(&instance_id);
            eprintln!(
                "会话租约迁移超时（{}s 无响应）按失败回滚：instance={} request={} generation={}",
                timeout.as_secs(),
                instance_id,
                request_id,
                generation
            );
        }
    });
}

/// 进程死亡/实例停止时回滚 pending。`generation` 为 Some 时仅回滚该
/// generation 注册的 pending（stdout reader 的 EOF 路径用，避免误伤重启后
/// 新 generation 的 pending）；None 无条件回滚（rpc_stop 等实例销毁路径）。
fn rollback_pending_lease(state: &RpcState, instance_id: &str, generation: Option<u64>) {
    if let Ok(mut map) = state.pending_leases.lock() {
        let hit = match (map.get(instance_id), generation) {
            (Some(p), Some(g)) => p.generation == g,
            (Some(_), None) => true,
            _ => false,
        };
        if hit {
            map.remove(instance_id);
        }
    }
}

/// 解析 stdout 行：是带字符串 id 的 response 行时返回
/// (request_id, 是否确认成功, 响应 data 里的会话路径)。
/// `success:false`（error 响应）与 `data.cancelled:true`（切换/新建未生效）
/// 都视为未确认。
fn parse_lease_response(line: &str) -> Option<(String, bool, Option<String>)> {
    // 快速路径：事件流绝大多数行不是 response
    if !line.contains("\"response\"") {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(|t| t.as_str()) != Some("response") {
        return None;
    }
    let id = value.get("id").and_then(|i| i.as_str())?.to_string();
    let success = value
        .get("success")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);
    let cancelled = value
        .get("data")
        .and_then(|d| d.get("cancelled"))
        .and_then(|c| c.as_bool())
        .unwrap_or(false);
    let path = extract_response_session_path(&value);
    Some((id, success && !cancelled, path))
}

/// new_session 成功响应里可能携带的新会话路径（pi 当前版本只回
/// `{cancelled}`，此处兼容 sessionFile/sessionPath/path 三种字段名）。
fn extract_response_session_path(response: &serde_json::Value) -> Option<String> {
    let data = response.get("data")?;
    for key in ["sessionFile", "sessionPath", "path"] {
        if let Some(raw) = data.get(key).and_then(|v| v.as_str()) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// stdout reader 每行调用：该行若是 pending 租约迁移的响应，按结果提交或回滚；
/// 其余行（事件、其他命令的响应、其他实例的响应）不碰租约状态。
/// `leases_root` 仅 new_session 成功且响应携带新会话路径时用于占锁。
fn resolve_pending_lease_from_line(
    leases_root: Option<&Path>,
    state: &RpcState,
    instance_id: &str,
    generation: u64,
    line: &str,
) {
    let (request_id, confirmed, response_path) = match parse_lease_response(line) {
        Some(parsed) => parsed,
        None => return,
    };
    let pending = {
        let mut map = match state.pending_leases.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        match map.get(instance_id) {
            Some(p) if p.request_id == request_id && p.generation == generation => {
                map.remove(instance_id).unwrap()
            }
            _ => return,
        }
    };
    if !confirmed {
        // error 响应 / cancelled：回滚——未提交的新租约随 Drop 释放，旧租约不动
        eprintln!(
            "会话租约迁移未生效（pi 拒绝或取消），已回滚：instance={} request={}",
            instance_id, request_id
        );
        drop(pending);
        return;
    }
    let mut transition = pending.transition;
    if pending.acquire_path_from_response {
        // new_session：只有拿到响应实际路径且成功占锁后才替换旧租约。
        // pi 当前响应只有 {cancelled}；无路径/占锁失败时旧租约必须保留，
        // 等前端 get_state 后通过 rpc_claim_session_lease 完成迁移。
        match response_path {
            Some(path) => {
                let acquired = leases_root
                    .ok_or_else(|| "租约根目录不可用".to_string())
                    .and_then(|root| session_lease::SessionLease::acquire(root, &path));
                match acquired {
                    Ok(lease) => transition = LeaseTransition::Replace(lease),
                    Err(e) => {
                        eprintln!(
                            "new_session 新会话 {} 占锁失败（{}），保留旧租约等待显式 claim",
                            path, e
                        );
                        return;
                    }
                }
            }
            None => {
                eprintln!(
                    "new_session 响应未携带新会话路径：instance={} 保留旧租约等待 get_state claim",
                    instance_id
                );
                return;
            }
        }
    }
    commit_session_lease(state, instance_id, transition);
}

fn commit_session_lease(state: &RpcState, instance_id: &str, transition: LeaseTransition) {
    let replacement = match transition {
        LeaseTransition::Replace(lease) => Some(lease),
        LeaseTransition::Release => None,
    };
    if let Ok(mut leases) = state.leases.lock() {
        match replacement {
            Some(lease) => {
                // 旧租约随 map 替换 Drop 释放
                leases.insert(instance_id.to_string(), lease);
            }
            None => {
                if let Some(lease) = leases.remove(instance_id) {
                    lease.release();
                }
            }
        }
    }
}

/// Claim the authoritative session path reported by get_state for one exact
/// runtime generation. A stale caller can never replace a restarted runtime's
/// lease. Re-claiming the same normalized path for the same generation is
/// idempotent.
fn claim_session_lease_for_generation(
    leases_root: &Path,
    state: &RpcState,
    instance_id: &str,
    generation: u64,
    session_path: &str,
) -> Result<(), String> {
    let normalized = session_lease::normalize_session_path(session_path)?;
    // Serialize claim against stop/start and other claims for this process.
    // The generation cannot change while this guard is held.
    let instances = state
        .instances
        .lock()
        .map_err(|_| "获取 RPC 实例锁失败".to_string())?;
    let handle = instances
        .get(instance_id)
        .ok_or_else(|| format!("实例 '{}' 的 RPC 进程未启动", instance_id))?;
    if handle.generation != generation {
        return Err(format!(
            "实例 '{}' generation 已变化（期望 {}，当前 {}）",
            instance_id, generation, handle.generation
        ));
    }

    let mut leases = state
        .leases
        .lock()
        .map_err(|_| "获取会话租约锁失败".to_string())?;
    if leases
        .get(instance_id)
        .is_some_and(|lease| lease.normalized_path() == normalized)
    {
        return Ok(());
    }

    // Acquire first so the old lease remains held if the new path conflicts.
    // On an acquire error, re-check the committed map: a concurrent/retried
    // same-generation same-path claim is idempotent and must not fail closed.
    match session_lease::SessionLease::acquire(leases_root, session_path) {
        Ok(replacement) => {
            leases.insert(instance_id.to_string(), replacement);
            Ok(())
        }
        Err(error) => {
            if leases
                .get(instance_id)
                .is_some_and(|lease| lease.normalized_path() == normalized)
            {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

fn resolve_explicit_pi_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let expanded = expand_tilde_path(trimmed);
    if expanded.is_file() {
        return Some(expanded);
    }

    if let Ok(which_path) = which::which(trimmed) {
        return Some(which_path);
    }

    None
}

fn discover_pi_from_common_locations() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "windows") {
        if let Ok(app_data) = std::env::var("APPDATA") {
            let app_data_dir = PathBuf::from(app_data);
            candidates.push(app_data_dir.join("npm").join("pi.cmd"));
            candidates.push(app_data_dir.join("npm").join("pi.exe"));
            candidates.push(app_data_dir.join("npm").join("pi.bat"));
            candidates.push(app_data_dir.join("npm").join("pi"));
        }

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let local_app_data_dir = PathBuf::from(local_app_data);
            candidates.push(local_app_data_dir.join("npm").join("pi.cmd"));
            candidates.push(local_app_data_dir.join("npm").join("pi.exe"));
        }

        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_dir = PathBuf::from(user_profile);
            candidates.push(
                user_dir
                    .join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join("pi.cmd"),
            );
            candidates.push(
                user_dir
                    .join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join("pi.exe"),
            );
            candidates.push(user_dir.join("scoop").join("shims").join("pi.cmd"));
        }

        if let Ok(program_files) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("nodejs").join("pi.cmd"));
        }

        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(
                PathBuf::from(program_files_x86)
                    .join("nodejs")
                    .join("pi.cmd"),
            );
        }

        if let Ok(program_data) = std::env::var("ProgramData") {
            let program_data_dir = PathBuf::from(program_data);
            candidates.push(program_data_dir.join("npm").join("pi.cmd"));
            candidates.push(program_data_dir.join("npm").join("pi.exe"));
        }

        if let Ok(nvm_home) = std::env::var("NVM_HOME") {
            candidates.push(PathBuf::from(nvm_home).join("pi.cmd"));
        }

        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            candidates.push(PathBuf::from(nvm_symlink).join("pi.cmd"));
        }

        return candidates.into_iter().find(|candidate| candidate.is_file());
    }

    if let Some(home_dir) = resolve_home_dir() {
        // nvm installations (common for npm global installs)
        candidates.push(home_dir.join(".nvm/versions/node/current/bin/pi"));
        let nvm_versions_dir = home_dir.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(nvm_versions_dir) {
            let mut version_dirs: Vec<PathBuf> = entries
                .filter_map(|entry| {
                    let path = entry.ok()?.path();
                    if path.is_dir() {
                        Some(path)
                    } else {
                        None
                    }
                })
                .collect();
            version_dirs.sort_by(|a, b| b.cmp(a));
            for version_dir in version_dirs {
                candidates.push(version_dir.join("bin/pi"));
            }
        }

        // Other common per-user install locations
        candidates.push(home_dir.join(".pi/agent/bin/pi"));
        candidates.push(home_dir.join(".volta/bin/pi"));
        candidates.push(home_dir.join(".local/bin/pi"));
        candidates.push(home_dir.join(".local/node/bin/pi"));
        candidates.push(home_dir.join(".npm-global/bin/pi"));
        candidates.push(home_dir.join(".npm/bin/pi"));
    }

    // npm custom prefix installs (common on Linux/macOS desktop launches)
    for key in ["NPM_CONFIG_PREFIX", "PREFIX"] {
        if let Ok(prefix) = std::env::var(key) {
            let trimmed = prefix.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("bin/pi"));
                candidates.push(PathBuf::from(trimmed).join("pi"));
            }
        }
    }

    // Common system install locations
    candidates.push(PathBuf::from("/opt/homebrew/bin/pi"));
    candidates.push(PathBuf::from("/usr/local/bin/pi"));
    candidates.push(PathBuf::from("/usr/bin/pi"));

    if let Some(found) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Some(found);
    }

    // 兜底：GUI（Finder/Launchpad）启动时 PATH 很精简，
    // 用用户的登录 shell 解析 pi（覆盖 nvm/自定义 prefix 等一切情况）
    find_pi_via_login_shell()
}

/// 通过登录 shell（zsh/bash，-l -i）解析 `command -v pi`
fn find_pi_via_login_shell() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    for sh in [shell.as_str(), "/bin/zsh", "/bin/bash"] {
        let output = Command::new(sh)
            .args(["-l", "-i", "-c", "command -v pi"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        let Ok(out) = output else { continue };
        if !out.status.success() {
            continue;
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            let candidate = PathBuf::from(path);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn prepend_bin_dir_to_path(cmd: &mut Command, bin_dir: &Path) {
    let mut path_entries = vec![bin_dir.to_path_buf()];
    if let Some(existing) = std::env::var_os("PATH") {
        path_entries.extend(std::env::split_paths(&existing));
    }

    if let Ok(joined) = std::env::join_paths(path_entries) {
        cmd.env("PATH", joined);
    }
}

fn discover_npm_path(pi: Option<&PiProcess>) -> Option<PathBuf> {
    let npm = npm_executable();

    if let Ok(path) = which::which(npm) {
        return Some(path);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(PiProcess::PathBinary { path }) = pi {
        if let Some(parent) = path.parent() {
            candidates.push(parent.join(npm));
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let home_dir = PathBuf::from(home);
        candidates.push(home_dir.join(".nvm/versions/node/current/bin").join(npm));

        let nvm_versions_dir = home_dir.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(nvm_versions_dir) {
            let mut version_dirs: Vec<PathBuf> = entries
                .filter_map(|entry| {
                    let path = entry.ok()?.path();
                    if path.is_dir() {
                        Some(path)
                    } else {
                        None
                    }
                })
                .collect();
            version_dirs.sort_by(|a, b| b.cmp(a));
            for version_dir in version_dirs {
                candidates.push(version_dir.join("bin").join(npm));
            }
        }

        candidates.push(home_dir.join(".volta/bin").join(npm));
        candidates.push(home_dir.join(".local/bin").join(npm));
        // 独立安装的 node（~/.local/node 布局，本机用户即此）
        candidates.push(home_dir.join(".local/node/bin").join(npm));
        candidates.push(home_dir.join(".npm-global/bin").join(npm));
        candidates.push(home_dir.join(".npm/bin").join(npm));
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin").join(npm));
    candidates.push(PathBuf::from("/usr/local/bin").join(npm));
    candidates.push(PathBuf::from("/usr/bin").join(npm));

    if let Some(found) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Some(found);
    }

    // 兜底：GUI（Finder/Launchpad）启动时 PATH 很精简，
    // 用用户的登录 shell 解析 npm（覆盖 nvm/自定义 prefix 等一切情况）
    find_npm_via_login_shell()
}

/// 通过登录 shell（zsh/bash，-l -i）解析 `command -v npm`
fn find_npm_via_login_shell() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        return None;
    }
    let npm = npm_executable();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    for sh in [shell.as_str(), "/bin/zsh", "/bin/bash"] {
        let output = Command::new(sh)
            .args(["-l", "-i", "-c", &format!("command -v {}", npm)])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        let Ok(out) = output else { continue };
        if !out.status.success() {
            continue;
        }
        // 登录 shell 可能回显 motd / profile 输出，取最后一个非空行
        let path = String::from_utf8_lossy(&out.stdout)
            .lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
            .to_string();
        if !path.is_empty() {
            let candidate = PathBuf::from(path);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn discover_npm_global_root(pi: Option<&PiProcess>) -> Option<PathBuf> {
    let npm_path = discover_npm_path(pi)?;

    let mut cmd = Command::new(&npm_path);
    cmd.arg("root")
        .arg("-g")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(parent) = npm_path.parent() {
        prepend_bin_dir_to_path(&mut cmd, parent);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let root = stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())?;

    let path = PathBuf::from(root);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

fn resolve_pi_changelog_candidates(pi: &PiProcess) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(pkg_dir) = std::env::var("PI_PACKAGE_DIR") {
        let trimmed = pkg_dir.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed).join("CHANGELOG.md"));
        }
    }

    match pi {
        PiProcess::DevNode { script } => {
            let script_path = PathBuf::from(script);
            if let Some(dist_dir) = script_path.parent() {
                candidates.push(dist_dir.join("..").join("CHANGELOG.md"));
            }
        }
        PiProcess::PathBinary { path } | PiProcess::SidecarBinary { path } => {
            let mut binaries = vec![path.clone()];
            if let Ok(canonical) = fs::canonicalize(path) {
                binaries.push(canonical);
            }
            for binary in binaries {
                if let Some(parent) = binary.parent() {
                    candidates.push(
                        parent
                            .join("..")
                            .join("lib")
                            .join("node_modules")
                            .join("@earendil-works")
                            .join("pi-coding-agent")
                            .join("CHANGELOG.md"),
                    );
                    candidates.push(
                        parent
                            .join("..")
                            .join("node_modules")
                            .join("@earendil-works")
                            .join("pi-coding-agent")
                            .join("CHANGELOG.md"),
                    );
                    candidates.push(
                        parent
                            .join("..")
                            .join("..")
                            .join("lib")
                            .join("node_modules")
                            .join("@earendil-works")
                            .join("pi-coding-agent")
                            .join("CHANGELOG.md"),
                    );
                }
            }
        }
    }

    if let Some(global_root) = discover_npm_global_root(Some(pi)) {
        candidates.push(
            global_root
                .join("@earendil-works")
                .join("pi-coding-agent")
                .join("CHANGELOG.md"),
        );
    }

    candidates
}

fn discover_pi_from_env_override() -> Option<PathBuf> {
    for key in ["PI_DESKTOP_PI_PATH", "PI_CLI_PATH"] {
        if let Ok(raw) = std::env::var(key) {
            if let Some(path) = resolve_explicit_pi_path(&raw) {
                return Some(path);
            }
        }
    }
    None
}

fn missing_pi_cli_error(additional: Option<String>) -> String {
    let mut message = String::from(
        "找不到 pi CLI。\n\n请运行以下命令安装：\n  npm install -g @earendil-works/pi-coding-agent\n\n安装完成后重启应用。",
    );
    if let Some(extra) = additional {
        let trimmed = extra.trim();
        if !trimmed.is_empty() {
            message.push_str("\n\n");
            message.push_str(trimmed);
        }
    }
    message
}

/// Discover the pi binary. Strategy:
/// 1. If pi_path is provided (Desktop manual override), use it
/// 2. If cli_path is provided (dev mode), use node + script or explicit binary
/// 3. Try explicit env override (PI_DESKTOP_PI_PATH / PI_CLI_PATH)
/// 4. Try sidecar discovery (packaged app)
/// 5. Try finding `pi` on PATH (globally installed CLI or standalone binary)
/// 6. Try common install locations (for GUI app launches without shell PATH)
/// 7. Fail with actionable error
fn discover_pi(app: &AppHandle, options: &RpcStartOptions) -> Result<PiProcess, String> {
    // Desktop manual override from settings
    if let Some(ref pi_path) = options.pi_path {
        let trimmed = pi_path.trim();
        if !trimmed.is_empty() {
            if let Some(path) = resolve_explicit_pi_path(trimmed) {
                return Ok(PiProcess::PathBinary { path });
            }
            return Err(missing_pi_cli_error(Some(format!(
                "配置的 pi 二进制路径不存在：{}",
                trimmed
            ))));
        }
    }

    // Dev mode: cli_path explicitly provided
    if let Some(ref cli_path) = options.cli_path {
        let trimmed = cli_path.trim();
        if !trimmed.is_empty() {
            if trimmed.ends_with(".js") || trimmed.ends_with(".mjs") || trimmed.ends_with(".cjs") {
                return Ok(PiProcess::DevNode {
                    script: trimmed.to_string(),
                });
            }
            if let Some(path) = resolve_explicit_pi_path(trimmed) {
                return Ok(PiProcess::PathBinary { path });
            }
        }
    }

    // Explicit environment override
    if let Some(path) = discover_pi_from_env_override() {
        return Ok(PiProcess::PathBinary { path });
    }

    // Packaged app: bundled sidecar
    if let Some(path) = discover_sidecar(app) {
        return Ok(PiProcess::SidecarBinary { path });
    }

    // Fallback: pi on PATH
    if let Ok(path) = which::which("pi") {
        return Ok(PiProcess::PathBinary { path });
    }

    // GUI launches on macOS often don't inherit shell PATH (e.g. nvm-managed node/npm bins)
    if let Some(path) = discover_pi_from_common_locations() {
        return Ok(PiProcess::PathBinary { path });
    }

    Err(missing_pi_cli_error(None))
}

/// Build a Command for the discovered pi process
fn build_command(pi: &PiProcess, options: &RpcStartOptions) -> Command {
    let mut cmd = match pi {
        PiProcess::DevNode { script } => {
            let mut c = Command::new("node");
            c.arg(script);
            c
        }
        PiProcess::SidecarBinary { path } | PiProcess::PathBinary { path } => Command::new(path),
    };

    cmd.arg("--mode").arg("rpc");

    if let Some(ref provider) = options.provider {
        cmd.arg("--provider").arg(provider);
    }
    if let Some(ref model) = options.model {
        cmd.arg("--model").arg(model);
    }
    if let Some(ref session_path) = options.session_path {
        cmd.arg("--session").arg(session_path);
    }

    cmd.current_dir(&options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Merge environment variables
    if let Some(ref env) = options.env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    // If using a script-based pi binary (e.g. npm global install), ensure its bin dir
    // is on PATH so shebangs like `#!/usr/bin/env node` can resolve node in GUI launches.
    if let PiProcess::PathBinary { path } = pi {
        if let Some(parent) = path.parent() {
            prepend_bin_dir_to_path(&mut cmd, parent);
        }
    }

    // On unix, put the RPC child in its own process group (pgid == child pid)
    // so shutdown can signal the whole tree (bash/MCP grandchildren included).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // On Windows, prevent console window from appearing
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}

fn write_rpc_line(stdin: &mut std::process::ChildStdin, line: &str) -> Result<(), String> {
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("写入 stdin 失败：{}", e))?;
    stdin
        .write_all(b"\n")
        .map_err(|e| format!("写入换行符失败：{}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("刷新 stdin 失败：{}", e))?;
    Ok(())
}

/// Start the pi coding agent in RPC mode as a child process.
/// Discovery order: manual pi_path -> dev cli_path -> env override -> sidecar -> PATH/common locations -> error.
#[tauri::command]
async fn rpc_start(
    app: AppHandle,
    state: tauri::State<'_, RpcState>,
    options: RpcStartOptions,
    instance_id: Option<String>,
) -> Result<RpcStartResult, String> {
    let instance_id = normalize_instance_id(instance_id);

    if let Ok(mut instances) = state.instances.lock() {
        if let Some(handle) = instances.get_mut(&instance_id) {
            stop_rpc_instance(handle);
        }
    } else {
        return Err("获取 RPC 实例锁失败".to_string());
    }

    let cwd_path = Path::new(&options.cwd);
    if !cwd_path.is_dir() {
        return Err(format!("工作目录不存在：{}", options.cwd));
    }

    let pi = discover_pi(&app, &options)?;
    let discovery_label = format!("{:?}", pi);

    let mut cmd = build_command(&pi, &options);
    let mut child = cmd.spawn().map_err(|e| {
        let lower = e.to_string().to_lowercase();
        let missing_executable = matches!(e.raw_os_error(), Some(2) | Some(3))
            || e.kind() == std::io::ErrorKind::NotFound
            || (lower.contains("createprocess") && lower.contains("cannot find"));
        if missing_executable {
            return missing_pi_cli_error(Some(format!("探测详情：{:?}\n进程启动错误：{}", pi, e)));
        }
        format!("启动 pi 进程失败（{:?}）：{}", pi, e)
    })?;

    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            terminate_child_tree(&mut child);
            return Err("无法获取 stdin".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child_tree(&mut child);
            return Err("无法获取 stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child_tree(&mut child);
            return Err("无法获取 stderr".to_string());
        }
    };
    let (generation, (stdin, stdout, stderr)) = match assign_generation_to_prepared_rpc(
        state.inner(),
        &instance_id,
        Ok((stdin, stdout, stderr)),
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            terminate_child_tree(&mut child);
            return Err(error);
        }
    };

    // Store process + stdin handle for this instance
    if let Ok(mut instances) = state.instances.lock() {
        instances.insert(
            instance_id.clone(),
            RpcProcessHandle {
                generation,
                process: Some(child),
                stdin_writer: Some(stdin),
            },
        );
    } else {
        terminate_child_tree(&mut child);
        return Err("获取 RPC 实例锁失败".to_string());
    }

    // Spawn thread to read stdout and emit events to frontend
    let app_handle = app.clone();
    let stdout_instance_id = instance_id.clone();
    let stdout_generation = generation;
    std::thread::spawn(move || {
        let rpc_state = app_handle.state::<RpcState>();
        let leases_root = session_leases_root(&app_handle).ok();
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    // 会话租约两阶段提交：response 行裁决 pending 迁移
                    // （非 response 行/其他请求的响应快速跳过）
                    resolve_pending_lease_from_line(
                        leases_root.as_deref(),
                        rpc_state.inner(),
                        &stdout_instance_id,
                        stdout_generation,
                        &line,
                    );
                    let payload = RpcLineEventPayload {
                        instance_id: stdout_instance_id.clone(),
                        generation: stdout_generation,
                        line,
                    };
                    let _ = app_handle.emit("rpc-event", payload);
                }
                Err(_) => break,
            }
        }
        // 进程退出：本 generation 未决的租约迁移按失败回滚（响应永远不会到了）
        rollback_pending_lease(
            rpc_state.inner(),
            &stdout_instance_id,
            Some(stdout_generation),
        );
        let _ = app_handle.emit(
            "rpc-closed",
            RpcClosedEventPayload {
                instance_id: stdout_instance_id,
                generation: stdout_generation,
                reason: "进程已退出".to_string(),
            },
        );
    });

    // Spawn thread to read stderr
    let app_handle_err = app.clone();
    let stderr_instance_id = instance_id.clone();
    let stderr_generation = generation;
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let payload = RpcLineEventPayload {
                        instance_id: stderr_instance_id.clone(),
                        generation: stderr_generation,
                        line,
                    };
                    let _ = app_handle_err.emit("rpc-stderr", payload);
                }
                Err(_) => break,
            }
        }
    });

    Ok(RpcStartResult {
        discovery: format!("{} [instance:{}]", discovery_label, instance_id),
        generation,
    })
}

/// Send a JSON command to an RPC process stdin
#[tauri::command]
async fn rpc_send(
    app: AppHandle,
    state: tauri::State<'_, RpcState>,
    command: String,
    instance_id: Option<String>,
) -> Result<(), String> {
    let instance_id = normalize_instance_id(instance_id);
    if let Ok(mut instances) = state.instances.lock() {
        if let Some(handle) = instances.get_mut(&instance_id) {
            if let Some(ref mut stdin) = handle.stdin_writer {
                // 会话迁移的 prepare/register/write 全部在实例锁内串行，确保同一
                // runtime 不会有两个并发 rpc_send 都越过 pending 检查。
                let pending = prepare_session_lease(&app, state.inner(), &instance_id, &command)?;
                // 先注册 pending 再写入：pi 的响应可能先于注册到达 reader 线程
                if let Some(mut pending) = pending {
                    pending.generation = handle.generation;
                    register_pending_lease(state.inner(), &instance_id, pending)?;
                }
                let result = write_rpc_line(stdin, &command);
                if result.is_err() {
                    // 写入失败：迁移不会发生，撤销刚注册的 pending（Drop 回滚）
                    rollback_pending_lease(state.inner(), &instance_id, Some(handle.generation));
                }
                result
            } else {
                Err(format!("实例 '{}' 的 RPC 进程未启动", instance_id))
            }
        } else {
            Err(format!("实例 '{}' 的 RPC 进程未启动", instance_id))
        }
    } else {
        Err("获取 RPC 实例锁失败".to_string())
    }
}

/// Claim the authoritative session returned by get_state for the current
/// frontend-observed RPC generation.
fn ensure_expected_session_path(
    session_path: &str,
    expected_session_path: Option<&str>,
) -> Result<(), String> {
    let Some(expected) = expected_session_path else {
        return Ok(());
    };
    let actual = session_lease::normalize_session_path(session_path)?;
    let expected = session_lease::normalize_session_path(expected)?;
    if actual != expected {
        return Err(format!(
            "pi 恢复了错误的会话文件（期望 '{}'，实际 '{}'）",
            expected, actual
        ));
    }
    Ok(())
}

#[tauri::command]
async fn rpc_claim_session_lease(
    app: AppHandle,
    state: tauri::State<'_, RpcState>,
    session_path: String,
    expected_session_path: Option<String>,
    generation: u64,
    instance_id: Option<String>,
) -> Result<(), String> {
    let instance_id = normalize_instance_id(instance_id);
    ensure_expected_session_path(&session_path, expected_session_path.as_deref())?;
    let leases_root = session_leases_root(&app)?;
    claim_session_lease_for_generation(
        &leases_root,
        state.inner(),
        &instance_id,
        generation,
        &session_path,
    )
}

/// Stop an RPC process instance
#[tauri::command]
async fn rpc_stop(
    state: tauri::State<'_, RpcState>,
    instance_id: Option<String>,
) -> Result<(), String> {
    let instance_id = normalize_instance_id(instance_id);
    if let Ok(mut instances) = state.instances.lock() {
        if let Some(mut handle) = instances.remove(&instance_id) {
            stop_rpc_instance(&mut handle);
        }
        // stop 时释放该实例持有的会话租约，并回滚未决的租约迁移
        if let Ok(mut pendings) = state.pending_leases.lock() {
            pendings.remove(&instance_id);
        }
        if let Ok(mut leases) = state.leases.lock() {
            leases.remove(&instance_id);
        }
        Ok(())
    } else {
        Err("获取 RPC 实例锁失败".to_string())
    }
}

/// Stop all RPC process instances (abort → SIGTERM group → SIGKILL group)
#[tauri::command]
async fn rpc_stop_all(state: tauri::State<'_, RpcState>) -> Result<(), String> {
    shutdown_all_instances(
        state.inner(),
        Duration::from_millis(3_000),
        Duration::from_millis(2_000),
    );
    Ok(())
}

/// Check if an RPC process instance is running
#[tauri::command]
async fn rpc_is_running(
    state: tauri::State<'_, RpcState>,
    instance_id: Option<String>,
) -> Result<bool, String> {
    let instance_id = normalize_instance_id(instance_id);
    if let Ok(mut instances) = state.instances.lock() {
        if let Some(handle) = instances.get_mut(&instance_id) {
            if let Some(ref mut child) = handle.process {
                match child.try_wait() {
                    Ok(None) => Ok(true),
                    Ok(Some(_)) => {
                        handle.process = None;
                        handle.stdin_writer = None;
                        Ok(false)
                    }
                    Err(_) => Ok(false),
                }
            } else {
                Ok(false)
            }
        } else {
            Ok(false)
        }
    } else {
        Err("获取 RPC 实例锁失败".to_string())
    }
}

/// Send a response to an extension UI dialog request
#[tauri::command]
async fn rpc_ui_response(
    state: tauri::State<'_, RpcState>,
    response: String,
    instance_id: Option<String>,
) -> Result<(), String> {
    let instance_id = normalize_instance_id(instance_id);
    if let Ok(mut instances) = state.instances.lock() {
        if let Some(handle) = instances.get_mut(&instance_id) {
            if let Some(ref mut stdin) = handle.stdin_writer {
                write_rpc_line(stdin, &response)
            } else {
                Err(format!("实例 '{}' 的 RPC 进程未启动", instance_id))
            }
        } else {
            Err(format!("实例 '{}' 的 RPC 进程未启动", instance_id))
        }
    } else {
        Err("获取 RPC 实例锁失败".to_string())
    }
}

/// Session info for listing
#[derive(Debug, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: Option<String>,
    /// Derived from the first user message when the session has no explicit
    /// name, so the sidebar can show something recognizable instead of
    /// "未命名会话". None when a name exists or no user text was found.
    pub preview: Option<String>,
    pub path: String,
    pub cwd: Option<String>,
    /// Path of the session file this session was forked from (pi session
    /// header `parentSession`). None for regular, non-forked sessions.
    pub parent_session: Option<String>,
    pub created_at: i64,
    pub modified_at: i64,
    pub tokens: u64,
    pub cost: f64,
}

pub(crate) fn get_pi_agent_dir() -> Option<PathBuf> {
    // Respect explicit env override first
    if let Ok(raw) = std::env::var("PI_CODING_AGENT_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if trimmed == "~" {
                return std::env::var_os("HOME")
                    .or(std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from);
            }
            if let Some(rest) = trimmed
                .strip_prefix("~/")
                .or_else(|| trimmed.strip_prefix("~\\"))
            {
                return std::env::var_os("HOME")
                    .or(std::env::var_os("USERPROFILE"))
                    .map(|home| PathBuf::from(home).join(rest));
            }
            return Some(PathBuf::from(trimmed));
        }
    }

    // Default: ~/.pi/agent
    std::env::var_os("HOME")
        .or(std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".pi").join("agent"))
}

fn get_pi_sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(agent_dir) = get_pi_agent_dir() {
        return Ok(agent_dir.join("sessions"));
    }

    // Fallback for unusual environments
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败：{}", e))?;
    Ok(data_dir.join("sessions"))
}

fn collect_session_files_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_files_recursive(&path, out);
            continue;
        }

        let is_jsonl = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("jsonl"))
            .unwrap_or(false);

        if is_jsonl {
            out.push(path);
        }
    }
}

fn get_modified_at_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn get_created_at_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.created().ok())
        .or_else(|| fs::metadata(path).ok().and_then(|m| m.modified().ok()))
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Max bytes scanned when looking for the first user message. Session files
/// can be huge; the first user message lives near the top, so a small
/// sequential prefix read is enough and we never slurp the whole file here.
const PREVIEW_SCAN_CAP_BYTES: u64 = 64 * 1024;
/// Max characters kept for a session preview.
const PREVIEW_MAX_CHARS: usize = 40;

/// Extract the text of a user message's `content` (string or content blocks).
fn user_message_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// Normalize whitespace and truncate to PREVIEW_MAX_CHARS (char-based, so
/// CJK text is not cut mid-codepoint). Appends "…" when truncated.
fn normalize_preview_text(raw: &str) -> Option<String> {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let mut chars = normalized.chars();
    let truncated: String = chars.by_ref().take(PREVIEW_MAX_CHARS).collect();
    if chars.next().is_some() {
        Some(format!("{}…", truncated))
    } else {
        Some(truncated)
    }
}

/// Parse the XML-like tag at the start of `text` (must start with '<').
/// Returns (tag name, remainder after the tag, self_closing, is_closing).
/// Quoted attribute values may contain '>' without ending the tag.
fn parse_leading_xml_tag(text: &str) -> Option<(&str, &str, bool, bool)> {
    let mut rest = text.strip_prefix('<')?;
    let mut is_closing = false;
    if let Some(stripped) = rest.strip_prefix('/') {
        rest = stripped;
        is_closing = true;
    }
    // The name must start with an ASCII letter, otherwise this is prose like
    // "< 这不是标签" and we leave the text alone.
    if !rest.chars().next()?.is_ascii_alphabetic() {
        return None;
    }
    let name_len: usize = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .map(char::len_utf8)
        .sum();
    let name = &rest[..name_len];
    rest = &rest[name_len..];
    // Scan attributes up to the closing '>', honoring quoted values.
    let mut quote: Option<char> = None;
    for (i, c) in rest.char_indices() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' => quote = Some(c),
                '>' => {
                    let self_closing = rest[..i].trim_end().ends_with('/');
                    return Some((name, &rest[i + 1..], self_closing, is_closing));
                }
                _ => {}
            },
        }
    }
    None
}

/// Strip one leading XML construct from `text` (must start with '<'):
/// HTML comments (`<!-- … -->`), paired blocks (`<skill …> …body… </skill>` —
/// skill invocations wrap a whole machine-generated body that is never a good
/// session name), or lone tags (`</name>`, `<name …>`, `<name … />`).
/// Returns the remainder, or None when no well-formed construct leads.
fn strip_leading_xml(text: &str) -> Option<&str> {
    if let Some(after_open) = text.strip_prefix("<!--") {
        let end = after_open.find("-->")?;
        return Some(&after_open[end + 3..]);
    }
    let (name, after_tag, self_closing, is_closing) = parse_leading_xml_tag(text)?;
    if !is_closing && !self_closing {
        // A paired block: drop everything through the matching closing tag.
        let close_open = format!("</{}", name);
        if let Some(idx) = after_tag.find(&close_open) {
            let after_name = &after_tag[idx + close_open.len()..];
            if let Some(gt) = after_name.find('>') {
                // Only whitespace allowed between the name and '>'.
                if after_name[..gt].trim().is_empty() {
                    return Some(&after_name[gt + 1..]);
                }
            }
        }
    }
    Some(after_tag)
}

/// Strip a leading YAML-style frontmatter block (`---\n…\n---`).
fn strip_leading_frontmatter(text: &str) -> Option<&str> {
    let after_open = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))?;
    let mut pos = 0usize;
    for chunk in after_open.split_inclusive('\n') {
        if chunk.trim_end_matches(['\r', '\n']) == "---" {
            return Some(after_open[pos + chunk.len()..].trim_start_matches(['\r', '\n']));
        }
        pos += chunk.len();
    }
    None
}

/// Strip a leading fenced code block (```lang\n…\n```).
fn strip_leading_code_fence(text: &str) -> Option<&str> {
    if !text.starts_with("```") {
        return None;
    }
    let open_end = text.find('\n')?;
    let after_open = &text[open_end + 1..];
    let mut pos = 0usize;
    for chunk in after_open.split_inclusive('\n') {
        if chunk.trim_end_matches(['\r', '\n']).starts_with("```") {
            return Some(&after_open[pos + chunk.len()..]);
        }
        pos += chunk.len();
    }
    None
}

/// Strip one trailing XML tag (`</skill>` etc.) from `text` (must end with
/// '>'), so a leading-tag strip followed by real text does not leave a
/// dangling closing tag in the preview. Returns the remainder, or None.
fn strip_trailing_xml_tag(text: &str) -> Option<&str> {
    if !text.ends_with('>') {
        return None;
    }
    let start = text.rfind('<')?;
    // The whole tail from the last '<' must be exactly one well-formed tag.
    match strip_leading_xml(&text[start..]) {
        Some("") => Some(&text[..start]),
        _ => None,
    }
}

/// Reduce a user message to the text that may become a session preview:
/// strip leading frontmatter, fenced code blocks and XML-like constructs
/// (skill invocations, consecutive tag blocks, comments) plus trailing
/// closing tags. Returns "" when the message carries no real text.
fn meaningful_preview_text(text: &str) -> &str {
    let mut rest = text;
    loop {
        let trimmed = rest.trim_start();
        if trimmed.is_empty() {
            return "";
        }
        if let Some(stripped) = strip_leading_frontmatter(trimmed) {
            rest = stripped;
            continue;
        }
        if let Some(stripped) = strip_leading_code_fence(trimmed) {
            rest = stripped;
            continue;
        }
        if trimmed.starts_with('<') {
            if let Some(stripped) = strip_leading_xml(trimmed) {
                rest = stripped;
                continue;
            }
        }
        rest = trimmed;
        break;
    }
    loop {
        let trimmed = rest.trim_end();
        if trimmed.is_empty() {
            return "";
        }
        if let Some(stripped) = strip_trailing_xml_tag(trimmed) {
            rest = stripped;
            continue;
        }
        return trimmed;
    }
}

/// When the whole meaningful text is a single URL, shorten it to
/// `host/path` (scheme, query and fragment dropped) so the preview stays
/// readable instead of showing a bare long URL. Returns None otherwise.
fn shorten_url_preview(text: &str) -> Option<String> {
    if text.chars().any(char::is_whitespace) {
        return None;
    }
    let rest = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))?;
    if rest.is_empty() {
        return None;
    }
    let without_query = rest.split(['?', '#']).next().unwrap_or(rest);
    let shortened = without_query.trim_end_matches('/');
    if shortened.is_empty() {
        return None;
    }
    Some(shortened.to_string())
}

/// Scan the first PREVIEW_SCAN_CAP_BYTES of already-loaded session content and
/// return a preview derived from the first user message with meaningful text
/// (messages that are only tags/code/frontmatter are skipped). Stops as soon
/// as one is found; returns None for empty/broken/garbage-only files.
/// Operates on the content parse_session_info already read, so unnamed
/// sessions don't pay a second file open+read during a full scan.
fn extract_session_preview(content: &str) -> Option<String> {
    let mut scanned_bytes = 0usize;
    for line in content.lines() {
        if scanned_bytes >= PREVIEW_SCAN_CAP_BYTES as usize {
            break;
        }
        scanned_bytes += line.len() + 1;
        let line = line;
        if line.trim().is_empty() {
            continue;
        }
        let entry = match serde_json::from_str::<serde_json::Value>(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if entry.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let message = match entry.get("message") {
            Some(m) => m,
            None => continue,
        };
        if message.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let content = match message.get("content") {
            Some(c) => c,
            None => continue,
        };
        let text = user_message_text(content);
        // Strip leading junk (skill tags, frontmatter, code fences) and
        // trailing closing tags; messages with nothing real left are skipped
        // in favor of the next user message.
        let meaningful = meaningful_preview_text(&text);
        if meaningful.is_empty() {
            continue;
        }
        // A message that is just one URL previews as host/path, not the raw
        // long URL.
        let shortened = shorten_url_preview(meaningful);
        let candidate = shortened.as_deref().unwrap_or(meaningful);
        if let Some(preview) = normalize_preview_text(candidate) {
            return Some(preview);
        }
    }
    None
}

fn parse_session_info(path: &Path) -> Option<SessionInfo> {
    let content = fs::read_to_string(path).ok()?;

    let mut id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut name: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut parent_session: Option<String> = None;
    let mut tokens: u64 = 0;
    let mut cost: f64 = 0.0;

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let entry = match serde_json::from_str::<serde_json::Value>(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match entry.get("type").and_then(|t| t.as_str()) {
            Some("session") => {
                if let Some(session_id) = entry.get("id").and_then(|v| v.as_str()) {
                    id = session_id.to_string();
                }
                if let Some(session_cwd) = entry.get("cwd").and_then(|v| v.as_str()) {
                    let trimmed = session_cwd.trim();
                    if !trimmed.is_empty() {
                        cwd = Some(trimmed.to_string());
                    }
                }
                // fork 出来的会话在 header 里带 parentSession（源会话文件路径）。
                if let Some(parent) = entry.get("parentSession").and_then(|v| v.as_str()) {
                    let trimmed = parent.trim();
                    if !trimmed.is_empty() {
                        parent_session = Some(trimmed.to_string());
                    }
                }
            }
            Some("session_info") => {
                if let Some(session_name) = entry.get("name").and_then(|v| v.as_str()) {
                    let trimmed = session_name.trim();
                    if !trimmed.is_empty() {
                        name = Some(trimmed.to_string());
                    }
                }
            }
            Some("message") => {
                let message = entry.get("message");
                let role = message.and_then(|m| m.get("role")).and_then(|r| r.as_str());
                if role == Some("assistant") {
                    let message_tokens = message
                        .and_then(|m| m.get("usage"))
                        .and_then(|u| u.get("totalTokens"))
                        .and_then(|t| t.as_u64())
                        .unwrap_or(0);
                    tokens = tokens.saturating_add(message_tokens);

                    let message_cost = message
                        .and_then(|m| m.get("usage"))
                        .and_then(|u| u.get("cost"))
                        .and_then(|c| c.get("total"))
                        .and_then(|c| c.as_f64())
                        .unwrap_or(0.0);
                    cost += message_cost;
                }
            }
            _ => {}
        }
    }

    // Only derive a preview when there is no explicit name. The preview is
    // scanned from the content already loaded above — no second file read.
    let preview = if name.is_none() {
        extract_session_preview(&content)
    } else {
        None
    };

    Some(SessionInfo {
        id,
        name,
        preview,
        path: path.to_string_lossy().to_string(),
        cwd,
        parent_session,
        created_at: get_created_at_ms(path),
        modified_at: get_modified_at_ms(path),
        tokens,
        cost,
    })
}

/// List all sessions from pi's session directory (~/.pi/agent/sessions)
#[tauri::command]
async fn list_sessions(app: AppHandle) -> Result<Vec<SessionInfo>, String> {
    let sessions_dir = get_pi_sessions_dir(&app)?;

    if !sessions_dir.exists() {
        fs::create_dir_all(&sessions_dir).map_err(|e| format!("创建会话目录失败：{}", e))?;
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_session_files_recursive(&sessions_dir, &mut files);

    let mut sessions = files
        .iter()
        .filter_map(|path| parse_session_info(path))
        .collect::<Vec<_>>();

    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(sessions)
}

/// A project discovered from pi's session history: one subdirectory of the
/// sessions root maps to one cwd (read from the session header, never from
/// the encoded directory name, which is ambiguous for cwds containing '-').
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PiSessionProject {
    pub cwd: String,
    pub session_count: u32,
    /// ISO timestamp from the newest session header ("" when unavailable).
    pub last_active: String,
}

/// Read only the first line of a session file and extract the header cwd and
/// timestamp. Returns None when the first line is not a valid session header.
fn parse_session_header_first_line(path: &Path) -> Option<(String, Option<String>)> {
    let file = fs::File::open(path).ok()?;
    // Cap the read so a malformed file without newlines is not slurped whole.
    let mut first_line = String::new();
    BufReader::new(file)
        .take(256 * 1024)
        .read_line(&mut first_line)
        .ok()?;
    let entry = serde_json::from_str::<serde_json::Value>(first_line.trim()).ok()?;
    if entry.get("type").and_then(|t| t.as_str()) != Some("session") {
        return None;
    }
    let cwd = entry
        .get("cwd")
        .and_then(|v| v.as_str())?
        .trim()
        .to_string();
    if cwd.is_empty() {
        return None;
    }
    let timestamp = entry
        .get("timestamp")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some((cwd, timestamp))
}

fn collect_pi_session_projects(sessions_dir: &Path) -> Vec<PiSessionProject> {
    let entries = match fs::read_dir(sessions_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    let mut projects = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }

        let mut files = Vec::new();
        collect_session_files_recursive(&dir, &mut files);
        if files.is_empty() {
            continue;
        }

        // The newest file identifies the project: its header carries the cwd.
        let mut latest_mtime = 0_i64;
        let mut latest_file: Option<&PathBuf> = None;
        for path in &files {
            let mtime = get_modified_at_ms(path);
            if latest_file.is_none() || mtime >= latest_mtime {
                latest_mtime = mtime;
                latest_file = Some(path);
            }
        }
        let Some(latest_file) = latest_file else {
            continue;
        };
        let Some((cwd, timestamp)) = parse_session_header_first_line(latest_file) else {
            // Never guess the cwd from the encoded directory name.
            continue;
        };

        projects.push((
            latest_mtime,
            PiSessionProject {
                cwd,
                session_count: files.len() as u32,
                last_active: timestamp.unwrap_or_default(),
            },
        ));
    }

    projects.sort_by(|a, b| b.0.cmp(&a.0));
    projects.into_iter().map(|(_, project)| project).collect()
}

/// List projects discovered from pi's session directory (~/.pi/agent/sessions),
/// most recently active first. Used by the frontend to auto-import the user's
/// existing TUI sessions into the sidebar.
#[tauri::command]
async fn list_pi_session_projects(app: AppHandle) -> Result<Vec<PiSessionProject>, String> {
    let sessions_dir = get_pi_sessions_dir(&app)?;
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }
    Ok(collect_pi_session_projects(&sessions_dir))
}

/// Get the content of a session file
#[tauri::command]
async fn get_session_content(session_path: String) -> Result<String, String> {
    fs::read_to_string(&session_path).map_err(|e| format!("读取会话失败：{}", e))
}

const SESSION_PAGE_DEFAULT_LIMIT: usize = 40;
const SESSION_PAGE_MAX_LIMIT: usize = 200;
/// Single string values larger than this are truncated before crossing the
/// bridge; a 20MB session file is dominated by multi-MB tool outputs.
const SESSION_PAGE_TRUNCATE_BYTES: usize = 50 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionPage {
    entries: Vec<serde_json::Value>,
    has_more: bool,
    oldest_entry_id: Option<String>,
    /// 会话里**最后一个** `todo` 工具结果的 details 快照。
    ///
    /// 为什么要它：`entries` 只是尾页（默认 40 条），而 todo 清单面板需要全量
    /// 状态。长会话里最后一次 todo 调用很容易被后续 entry 挤出尾页，前端就无法
    /// 恢复清单。本字段在同一次流式扇描里顺便记住，不额外读文件。
    ///
    /// 只保留 details 本身（已经过 truncate_large_strings），不带整条 entry。
    latest_todo_details: Option<serde_json::Value>,
}

/// 从一条 timeline entry 里提取 `todo` 工具结果的 details。
///
/// 会话 JSONL 的形状是 `{type:"message", message:{role:"toolResult", toolName:"todo", details:{...}}}`。
/// 字段缺失或类型不对时返回 None——清单来自用户可改的扩展，不能假设形状。
fn extract_todo_details(entry: &serde_json::Value) -> Option<serde_json::Value> {
    let message = entry.get("message")?;
    if message.get("role").and_then(|v| v.as_str()) != Some("toolResult") {
        return None;
    }
    if message.get("toolName").and_then(|v| v.as_str()) != Some("todo") {
        return None;
    }
    let details = message.get("details")?;
    if !details.is_object() {
        return None;
    }
    Some(details.clone())
}

/// Entry types the chat timeline can render (mirrors what pi's
/// `buildSessionContext` turns into messages).
fn is_timeline_entry_type(entry_type: &str) -> bool {
    matches!(
        entry_type,
        "message" | "custom_message" | "branch_summary" | "compaction"
    )
}

/// String fields that must stay intact: image payloads and signatures would
/// be corrupted by truncation.
fn truncation_exempt_key(key: &str) -> bool {
    matches!(key, "data" | "signature" | "thinkingSignature")
}

/// Truncate oversized string values in place, appending a machine-readable
/// marker (`[PI_DESKTOP_TRUNCATED:<n>KB]`) the frontend localizes via `t()`.
fn truncate_large_strings(
    value: &mut serde_json::Value,
    parent_key: Option<&str>,
    truncated: &mut bool,
) {
    match value {
        serde_json::Value::String(text) => {
            if parent_key.map(truncation_exempt_key).unwrap_or(false) {
                return;
            }
            if text.len() <= SESSION_PAGE_TRUNCATE_BYTES {
                return;
            }
            let omitted_kb = (text.len() - SESSION_PAGE_TRUNCATE_BYTES) / 1024;
            let mut cut = SESSION_PAGE_TRUNCATE_BYTES;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str(&format!("\n\n[PI_DESKTOP_TRUNCATED:{}KB]", omitted_kb));
            *truncated = true;
        }
        serde_json::Value::Array(items) => {
            for item in items {
                truncate_large_strings(item, None, truncated);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                truncate_large_strings(item, Some(key.as_str()), truncated);
            }
        }
        _ => {}
    }
}

/// Read the tail window of timeline entries from a session JSONL file.
/// Streams the file line by line (never loads it whole), keeps only the last
/// `limit` matching entries in a fixed-capacity ring buffer, and stops early
/// when the entry `before_entry_id` is reached.
fn load_session_page(
    session_path: &str,
    before_entry_id: Option<&str>,
    limit: Option<usize>,
) -> Result<SessionPage, String> {
    let limit = limit
        .unwrap_or(SESSION_PAGE_DEFAULT_LIMIT)
        .clamp(1, SESSION_PAGE_MAX_LIMIT);
    let file = fs::File::open(session_path).map_err(|e| format!("读取会话失败：{}", e))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let before = before_entry_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut ring: VecDeque<serde_json::Value> = VecDeque::with_capacity(limit + 1);
    let mut dropped = 0_usize;
    // 跟着扇描记住最后一个 todo 快照，不受尾页窗口限制。
    let mut latest_todo_details: Option<serde_json::Value> = None;
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取会话失败：{}", e))?;
        if read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Bad lines (partial writes, non-JSON noise) are skipped, never fatal.
        let mut entry: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let entry_type = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !is_timeline_entry_type(entry_type) {
            continue;
        }
        if let Some(before_id) = before {
            if entry.get("id").and_then(|v| v.as_str()) == Some(before_id) {
                break;
            }
        }
        let mut truncated = false;
        truncate_large_strings(&mut entry, None, &mut truncated);
        if truncated {
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("truncated".to_string(), serde_json::Value::Bool(true));
            }
        }
        if let Some(details) = extract_todo_details(&entry) {
            latest_todo_details = Some(details);
        }
        ring.push_back(entry);
        if ring.len() > limit {
            ring.pop_front();
            dropped += 1;
        }
    }

    let entries: Vec<serde_json::Value> = ring.into_iter().collect();
    let oldest_entry_id = entries
        .first()
        .and_then(|entry| entry.get("id"))
        .and_then(|id| id.as_str())
        .map(|id| id.to_string());
    Ok(SessionPage {
        entries,
        has_more: dropped > 0,
        oldest_entry_id,
        latest_todo_details,
    })
}

/// Get a tail page of timeline entries from a session JSONL file, newest
/// last. Used instead of RPC `get_messages` so opening a huge session does
/// not ship the full history across the bridge.
#[tauri::command]
async fn get_session_page(
    session_path: String,
    before_entry_id: Option<String>,
    limit: Option<u32>,
) -> Result<SessionPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_session_page(
            &session_path,
            before_entry_id.as_deref(),
            limit.map(|value| value as usize),
        )
    })
    .await
    .map_err(|e| format!("读取会话失败：{}", e))?
}

#[derive(Debug, Serialize)]
struct PiAuthProviderStatus {
    provider: String,
    source: String,
    kind: String,
}

#[derive(Debug, Serialize)]
struct PiAuthStatus {
    agent_dir: Option<String>,
    auth_file: Option<String>,
    auth_file_exists: bool,
    configured_providers: Vec<PiAuthProviderStatus>,
}

fn provider_env_var_map() -> [(&'static str, &'static str); 16] {
    [
        ("anthropic", "ANTHROPIC_API_KEY"),
        ("azure-openai-responses", "AZURE_OPENAI_API_KEY"),
        ("openai", "OPENAI_API_KEY"),
        ("google", "GEMINI_API_KEY"),
        ("mistral", "MISTRAL_API_KEY"),
        ("groq", "GROQ_API_KEY"),
        ("cerebras", "CEREBRAS_API_KEY"),
        ("xai", "XAI_API_KEY"),
        ("openrouter", "OPENROUTER_API_KEY"),
        ("vercel-ai-gateway", "AI_GATEWAY_API_KEY"),
        ("zai", "ZAI_API_KEY"),
        ("opencode", "OPENCODE_API_KEY"),
        ("huggingface", "HF_TOKEN"),
        ("kimi-coding", "KIMI_API_KEY"),
        ("minimax", "MINIMAX_API_KEY"),
        ("minimax-cn", "MINIMAX_CN_API_KEY"),
    ]
}

fn provider_env_var(provider: &str) -> Option<&'static str> {
    for (name, env_key) in provider_env_var_map() {
        if name == provider {
            return Some(env_key);
        }
    }
    None
}

fn provider_env_var_is_set(provider: &str) -> bool {
    provider_env_var(provider)
        .and_then(|env_key| std::env::var_os(env_key))
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

/// Inspect PI auth configuration from auth.json + environment variables.
#[tauri::command]
async fn get_pi_auth_status() -> Result<PiAuthStatus, String> {
    let agent_dir = get_pi_agent_dir();
    let auth_file_path = agent_dir.as_ref().map(|dir| dir.join("auth.json"));

    let mut configured_providers: Vec<PiAuthProviderStatus> = Vec::new();
    let auth_file_exists = auth_file_path
        .as_ref()
        .map(|path| path.exists() && path.is_file())
        .unwrap_or(false);

    if let Some(path) = &auth_file_path {
        if path.exists() && path.is_file() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(map) = parsed.as_object() {
                        for (provider, cred) in map {
                            let kind = cred
                                .get("type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string();

                            let source = if kind == "oauth" {
                                "auth_file_oauth"
                            } else {
                                "auth_file_api_key"
                            }
                            .to_string();

                            configured_providers.push(PiAuthProviderStatus {
                                provider: provider.clone(),
                                source,
                                kind,
                            });
                        }
                    }
                }
            }
        }
    }

    // Known provider env var mapping from docs/providers.md (core API key providers)
    for (provider, env_key) in provider_env_var_map() {
        let env_present = std::env::var_os(env_key)
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        if !env_present {
            continue;
        }

        let already_listed = configured_providers.iter().any(|p| p.provider == provider);
        if already_listed {
            continue;
        }

        configured_providers.push(PiAuthProviderStatus {
            provider: provider.to_string(),
            source: "environment".to_string(),
            kind: "api_key".to_string(),
        });
    }

    configured_providers.sort_by(|a, b| a.provider.cmp(&b.provider));

    Ok(PiAuthStatus {
        agent_dir: agent_dir.map(|p| p.to_string_lossy().to_string()),
        auth_file: auth_file_path.map(|p| p.to_string_lossy().to_string()),
        auth_file_exists,
        configured_providers,
    })
}

#[derive(Debug, Serialize)]
struct PiProviderAuthClearResult {
    provider: String,
    removed: bool,
    source: String,
}

/// Remove provider credentials from ~/.pi/agent/auth.json when present.
/// 重读-删除-原子写在 safe_config 的锁内完成（GUI/TUI 并发不互相覆盖）。
#[tauri::command]
async fn clear_pi_provider_auth(provider: String) -> Result<PiProviderAuthClearResult, String> {
    let normalized = provider.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("提供商不能为空".to_string());
    }

    let agent_dir = get_pi_agent_dir();
    let auth_file_path = agent_dir.as_ref().map(|dir| dir.join("auth.json"));
    let mut removed = false;

    if let Some(path) = &auth_file_path {
        if path.is_file() {
            let provider_key = normalized.clone();
            safe_config::update_json_file(path, Some(0o600), |value| {
                if !value.is_object() {
                    *value = serde_json::json!({});
                }
                if let Some(map) = value.as_object_mut() {
                    removed = map.remove(&provider_key).is_some();
                }
                Ok(())
            })?;
        }
    }

    let source = if removed {
        "auth_file"
    } else if provider_env_var_is_set(&normalized) {
        "environment"
    } else {
        "missing"
    }
    .to_string();

    Ok(PiProviderAuthClearResult {
        provider: normalized,
        removed,
        source,
    })
}

#[derive(Debug, Serialize, Clone)]
struct PiOAuthProviderInfo {
    id: String,
    name: String,
    source: String,
}

fn builtin_oauth_provider_info() -> Vec<PiOAuthProviderInfo> {
    vec![
        PiOAuthProviderInfo {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            source: "built_in".to_string(),
        },
        PiOAuthProviderInfo {
            id: "github-copilot".to_string(),
            name: "GitHub Copilot".to_string(),
            source: "built_in".to_string(),
        },
        PiOAuthProviderInfo {
            id: "google-gemini-cli".to_string(),
            name: "Google Gemini CLI".to_string(),
            source: "built_in".to_string(),
        },
        PiOAuthProviderInfo {
            id: "google-antigravity".to_string(),
            name: "Google Antigravity".to_string(),
            source: "built_in".to_string(),
        },
        PiOAuthProviderInfo {
            id: "openai-codex".to_string(),
            name: "OpenAI Codex".to_string(),
            source: "built_in".to_string(),
        },
    ]
}

fn humanize_provider_id(provider_id: &str) -> String {
    provider_id
        .split(|ch: char| ch == '-' || ch == '_' || ch.is_whitespace())
        .filter(|part| !part.trim().is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn parse_package_paths_from_pi_list_output(output: &str) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let candidate = PathBuf::from(trimmed);
        if !candidate.is_absolute() || !candidate.exists() || !candidate.is_dir() {
            continue;
        }

        let key = candidate.to_string_lossy().to_string();
        if seen.insert(key) {
            paths.push(candidate);
        }
    }

    paths
}

fn package_extension_entry_files(package_root: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();

    let package_json_path = package_root.join("package.json");
    if package_json_path.is_file() {
        if let Ok(content) = fs::read_to_string(&package_json_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(extensions) = parsed
                    .get("pi")
                    .and_then(|pi| pi.get("extensions"))
                    .and_then(|value| value.as_array())
                {
                    for entry in extensions {
                        let Some(raw) = entry.as_str() else {
                            continue;
                        };
                        let normalized = raw
                            .trim()
                            .trim_start_matches("./")
                            .trim_start_matches(".\\");
                        if normalized.is_empty() {
                            continue;
                        }
                        let candidate = package_root.join(normalized);
                        if candidate.is_file() {
                            files.push(candidate);
                        }
                    }
                }
            }
        }
    }

    if files.is_empty() {
        for fallback in [
            "index.ts",
            "index.js",
            "src/index.ts",
            "src/index.js",
            "src/index.mjs",
            "index.mjs",
        ] {
            let candidate = package_root.join(fallback);
            if candidate.is_file() {
                files.push(candidate);
            }
        }
    }

    files
}

fn parse_quoted_string(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = 0usize;

    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() {
        return None;
    }

    let quote = bytes[index];
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    index += 1;
    let start = index;

    while index < bytes.len() {
        if bytes[index] == quote {
            return Some(value[start..index].to_string());
        }
        index += 1;
    }

    None
}

fn extract_oauth_name_from_segment(segment: &str, provider_id: &str) -> String {
    let oauth_pos = segment.find("oauth").unwrap_or(0);
    let oauth_segment = &segment[oauth_pos..];

    if let Some(name_pos) = oauth_segment.find("name") {
        let tail = &oauth_segment[name_pos + "name".len()..];
        if let Some(colon_pos) = tail.find(':') {
            let candidate = &tail[colon_pos + 1..];
            if let Some(name) = parse_quoted_string(candidate) {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }

    humanize_provider_id(provider_id)
}

fn extract_oauth_providers_from_source(source: &str) -> Vec<(String, String)> {
    let mut providers: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let needle = "registerProvider(";
    let mut cursor = 0usize;

    while cursor < source.len() {
        let Some(rel) = source[cursor..].find(needle) else {
            break;
        };
        let start = cursor + rel;
        let mut index = start + needle.len();
        let bytes = source.as_bytes();

        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }

        let quote = bytes[index];
        if quote != b'"' && quote != b'\'' {
            cursor = index.saturating_add(1);
            continue;
        }

        index += 1;
        let provider_start = index;
        while index < bytes.len() && bytes[index] != quote {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }

        let provider_id = source[provider_start..index].trim().to_lowercase();
        if provider_id.is_empty() {
            cursor = index.saturating_add(1);
            continue;
        }

        let segment_start = index;
        let mut scan_limit = (segment_start + 9000).min(source.len());
        while scan_limit > segment_start && !source.is_char_boundary(scan_limit) {
            scan_limit -= 1;
        }
        let segment_end = source[segment_start..scan_limit]
            .find(needle)
            .map(|next_rel| segment_start + next_rel)
            .unwrap_or(scan_limit);

        let segment = &source[segment_start..segment_end];
        if !segment.contains("oauth") {
            cursor = index.saturating_add(1);
            continue;
        }

        if seen.insert(provider_id.clone()) {
            let provider_name = extract_oauth_name_from_segment(segment, &provider_id);
            providers.push((provider_id, provider_name));
        }

        cursor = index.saturating_add(1);
    }

    providers
}

fn extract_oauth_providers_from_package(package_root: &Path) -> Vec<PiOAuthProviderInfo> {
    let mut providers: Vec<PiOAuthProviderInfo> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for file in package_extension_entry_files(package_root) {
        let Ok(content) = fs::read_to_string(&file) else {
            continue;
        };
        for (id, name) in extract_oauth_providers_from_source(&content) {
            if !seen.insert(id.clone()) {
                continue;
            }
            providers.push(PiOAuthProviderInfo {
                id,
                name,
                source: "package".to_string(),
            });
        }
    }

    providers
}

/// Discover OAuth providers the same way users see in CLI /login:
/// built-ins + package-registered OAuth providers.
#[tauri::command]
async fn get_pi_oauth_providers(app: AppHandle) -> Result<Vec<PiOAuthProviderInfo>, String> {
    let mut providers = builtin_oauth_provider_info();
    let mut seen: HashSet<String> = providers
        .iter()
        .map(|provider| provider.id.clone())
        .collect();

    let discovery_opts = RpcStartOptions {
        cli_path: None,
        pi_path: None,
        cwd: ".".to_string(),
        provider: None,
        model: None,
        session_path: None,
        env: None,
    };

    let Ok(pi) = discover_pi(&app, &discovery_opts) else {
        return Ok(providers);
    };

    let list_opts = PiCliCommandOptions {
        args: vec!["list".to_string()],
        cwd: Some(".".to_string()),
        env: None,
        cli_path: None,
        pi_path: None,
    };

    let output = match build_plain_command(&pi, &list_opts).output() {
        Ok(output) => output,
        Err(_) => return Ok(providers),
    };

    if !output.status.success() {
        return Ok(providers);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let package_paths = parse_package_paths_from_pi_list_output(&stdout);
    let mut custom_providers: Vec<PiOAuthProviderInfo> = Vec::new();

    for package_path in package_paths {
        for provider in extract_oauth_providers_from_package(&package_path) {
            if !seen.insert(provider.id.clone()) {
                continue;
            }
            custom_providers.push(provider);
        }
    }

    custom_providers.sort_by(|a, b| {
        let name_cmp = a.name.to_lowercase().cmp(&b.name.to_lowercase());
        if name_cmp != std::cmp::Ordering::Equal {
            return name_cmp;
        }
        a.id.cmp(&b.id)
    });

    providers.extend(custom_providers);
    Ok(providers)
}

/// Settings structure
#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub theme: String,
    pub thinking_level: String,
    pub auto_compaction: bool,
    pub auto_retry: bool,
    pub steering_mode: String,
    pub follow_up_mode: String,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub pi_path: Option<String>,
    /// Max concurrently running pi RPC processes. Starting a new runtime beyond
    /// this cap suspends the least-recently-active idle runtime (frontend-enforced).
    pub max_running_runtimes: u32,
    /// Minutes a background runtime may stay idle before it is suspended
    /// (frontend-enforced). Streaming runtimes are never suspended.
    pub runtime_idle_timeout_minutes: u32,
    /// Project cwds the user manually removed from the sidebar. The pi session
    /// auto-import never re-adds these (frontend-enforced).
    pub auto_import_excluded: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            thinking_level: "medium".to_string(),
            auto_compaction: true,
            auto_retry: true,
            steering_mode: "one-at-a-time".to_string(),
            follow_up_mode: "one-at-a-time".to_string(),
            model_provider: None,
            model_id: None,
            pi_path: None,
            max_running_runtimes: 4,
            runtime_idle_timeout_minutes: 15,
            auto_import_excluded: Vec::new(),
        }
    }
}

/// Save app settings
#[tauri::command]
async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败：{}", e))?;

    // Ensure directory exists
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败：{}", e))?;

    let settings_path = data_dir.join("settings.json");
    let json =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("序列化设置失败：{}", e))?;

    fs::write(settings_path, json).map_err(|e| format!("写入设置失败：{}", e))
}

/// Load app settings
#[tauri::command]
async fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败：{}", e))?;

    let settings_path = data_dir.join("settings.json");

    if !settings_path.exists() {
        return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(settings_path).map_err(|e| format!("读取设置失败：{}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("解析设置失败：{}", e))
}

/// Open a file dialog and return the selected path
#[tauri::command]
async fn open_file_dialog(_app: AppHandle, _multiple: bool) -> Result<Vec<String>, String> {
    // Placeholder: frontend currently uses @tauri-apps/plugin-dialog directly.
    Ok(Vec::new())
}

#[derive(Debug, Deserialize)]
struct PiCliCommandOptions {
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    cli_path: Option<String>,
    pi_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct PiCliCommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    discovery: String,
}

#[derive(Debug, Deserialize)]
struct CliStatusOptions {
    cli_path: Option<String>,
    pi_path: Option<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
struct CliUpdateStatus {
    discovery: String,
    current_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    can_update_in_app: bool,
    npm_available: bool,
    update_command: String,
    note: Option<String>,
}

#[derive(Debug, Serialize)]
struct PiChangelogResult {
    path: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct NpmCommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Debug, Deserialize)]
struct GitCommandOptions {
    args: Vec<String>,
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
struct GitCommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Debug, Deserialize)]
struct ShareGistOptions {
    html_path: String,
}

#[derive(Debug, Serialize)]
struct ShareGistResult {
    gist_url: String,
    gist_id: String,
    preview_url: String,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize)]
struct DesktopRuntimeInfo {
    platform: String,
    arch: String,
    version: String,
}

fn npm_executable() -> &'static str {
    if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn discover_gh_path() -> Option<PathBuf> {
    if let Ok(path) = which::which("gh") {
        return Some(path);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(&app_data).join("GitHub CLI").join("gh.exe"));
            candidates.push(PathBuf::from(&app_data).join("npm").join("gh.cmd"));
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            candidates.push(
                PathBuf::from(program_files)
                    .join("GitHub CLI")
                    .join("gh.exe"),
            );
        }
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(
                PathBuf::from(program_files_x86)
                    .join("GitHub CLI")
                    .join("gh.exe"),
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/gh"));
        candidates.push(PathBuf::from("/usr/local/bin/gh"));
        candidates.push(PathBuf::from("/usr/bin/gh"));
        if let Some(home_dir) = resolve_home_dir() {
            candidates.push(home_dir.join(".local/bin/gh"));
            candidates.push(home_dir.join(".nvm/versions/node/current/bin/gh"));
        }
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn parse_gist_url_from_output(output: &str) -> Option<String> {
    for token in output.split_whitespace() {
        let Some(start) = token.find("https://gist.github.com/") else {
            continue;
        };
        let mut url = token[start..]
            .trim_matches(|c: char| {
                c == '"' || c == '\'' || c == '`' || c == '(' || c == '[' || c == '{'
            })
            .to_string();

        while let Some(last) = url.chars().last() {
            if matches!(last, ')' | ']' | '}' | ',' | ';' | '.') {
                url.pop();
                continue;
            }
            break;
        }

        if !url.is_empty() {
            return Some(url);
        }
    }
    None
}

fn parse_gist_id_from_url(url: &str) -> Option<String> {
    let clean = url.trim().trim_end_matches('/');
    let parts: Vec<&str> = clean
        .split('/')
        .filter(|entry| !entry.trim().is_empty())
        .collect();
    let gist_id = parts.last()?.trim();
    if gist_id.len() < 20 {
        return None;
    }
    if !gist_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(gist_id.to_string())
}

/// 截取命令输出的尾部（用于把失败原因展示给用户，避免整段输出刷屏）
fn tail_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let total = trimmed.chars().count();
    if total <= max_chars {
        return trimmed.to_string();
    }
    trimmed
        .char_indices()
        .nth(total - max_chars)
        .map(|(idx, _)| trimmed[idx..].to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

#[derive(serde::Serialize)]
struct HttpGetResult {
    status: u16,
    body: String,
}

/// http_get 单跳超时（远端要求的 ≤30s 上限内）；重定向每跳单独计时。
const HTTP_GET_TIMEOUT_SECS: &str = "15";
/// 手动跟随重定向的最大跳数（每跳重新做 SSRF 校验）。
const HTTP_GET_MAX_REDIRECTS: usize = 5;
/// 返回给前端的响应体上限。
const HTTP_GET_MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// 经 SSRF 校验后的 URL：scheme/host/port 已解析，域名已解析成 IP 并全部
/// 通过公网检查；`pinned_ip` 非 None 时通过 curl `--connect-to` 把连接目标
/// 固定为该 IP，消除「校验时解析」与「连接时再解析」之间的 DNS rebinding
/// 窗口。`--connect-to` 在 HTTP(S) 代理下也会把 CONNECT 目标固定为 IP，
/// 而 `--resolve` 在代理下仍会把域名交给代理重新解析，不能作为安全边界。
struct ValidatedFetchUrl {
    url: String,
    scheme: String,
    host: String,
    port: u16,
    pinned_ip: Option<std::net::IpAddr>,
}

/// 私网/环回/链路本地/保留地址判定（IPv4）。
fn is_blocked_ipv4(addr: &std::net::Ipv4Addr) -> bool {
    let [a, b, c, _d] = addr.octets();
    a == 0                                  // 0.0.0.0/8 "this network"
        || a == 10                          // 10.0.0.0/8 私网
        || a == 127                         // 127.0.0.0/8 环回
        || (a == 169 && b == 254)           // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
        || (a == 172 && (16..=31).contains(&b)) // 172.16.0.0/12 私网
        || (a == 192 && b == 168)           // 192.168.0.0/16 私网
        || (a == 100 && (64..=127).contains(&b)) // 100.64.0.0/10 CGNAT
        || (a == 192 && b == 0 && c == 2)   // 192.0.2.0/24 TEST-NET-1
        || (a == 198 && (b == 18 || b == 19)) // 198.18.0.0/15 基准测试网段
        || (a == 198 && b == 51 && c == 100) // 198.51.100.0/24 TEST-NET-2
        || (a == 203 && b == 0 && c == 113) // 203.0.113.0/24 TEST-NET-3
        || a >= 224 // 224.0.0.0/4 组播 + 240.0.0.0/4 保留（含 255.255.255.255 广播）
}

/// 私网/环回/链路本地/保留地址判定（IPv6）。
fn is_blocked_ipv6(addr: &std::net::Ipv6Addr) -> bool {
    if addr.is_loopback() || addr.is_unspecified() || addr.is_multicast() {
        return true; // ::1 / :: / ff00::/8
    }
    // ::ffff:a.b.c.d（IPv4-mapped）与 ::a.b.c.d（IPv4-compatible，已废弃）：
    // 内嵌 IPv4 按 IPv4 规则判定，绕过形如 ::ffff:127.0.0.1 的逃逸写法。
    if let Some(v4) = addr.to_ipv4_mapped() {
        return is_blocked_ipv4(&v4);
    }
    let segments = addr.segments();
    if segments[..6].iter().all(|&s| s == 0) {
        let v4 = std::net::Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        );
        return is_blocked_ipv4(&v4);
    }
    (segments[0] & 0xfe00) == 0xfc00 // fc00::/7 唯一本地地址（含 fd00::/8）
        || (segments[0] & 0xffc0) == 0xfe80 // fe80::/10 链路本地
        || (segments[0] == 0x2001 && segments[1] == 0x0db8) // 2001:db8::/32 文档保留
}

fn is_blocked_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_blocked_ipv4(v4),
        std::net::IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

/// Clash/Mihomo 等本机代理的 fake-ip 模式常把公网域名映射到
/// 198.18.0.0/15。这个网段仍属于保留地址，不能直接视为公网；只有在经过
/// 固定公网 IP 的 DoH 重新解析并校验后，才允许继续请求。
fn is_proxy_fake_ip(ip: &std::net::IpAddr) -> bool {
    matches!(
        ip,
        std::net::IpAddr::V4(v4)
            if {
                let [a, b, _, _] = v4.octets();
                a == 198 && (b == 18 || b == 19)
            }
    )
}

fn parse_doh_ips(body: &str) -> Result<Vec<std::net::IpAddr>, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("DoH 响应不是有效 JSON：{}", e))?;
    let status = value
        .get("Status")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "DoH 响应缺少 DNS 状态码".to_string())?;
    if status != 0 {
        return Err(format!("DoH 返回 DNS 状态码 {}", status));
    }
    let mut ips = Vec::new();
    if let Some(answers) = value.get("Answer").and_then(|v| v.as_array()) {
        for answer in answers {
            let record_type = answer.get("type").and_then(|v| v.as_u64());
            if !matches!(record_type, Some(1 | 28)) {
                continue;
            }
            let Some(data) = answer.get("data").and_then(|v| v.as_str()) else {
                continue;
            };
            if let Ok(ip) = data.parse::<std::net::IpAddr>() {
                if !ips.contains(&ip) {
                    ips.push(ip);
                }
            }
        }
    }
    if ips.is_empty() {
        return Err("DoH 未返回可用的 A/AAAA 地址".to_string());
    }
    Ok(ips)
}

/// 使用固定公网 IP 的 DoH 解析真实地址，绕开本机代理的 fake-ip DNS。
/// resolver 本身通过 `--connect-to` 固定到公开地址，不依赖当前系统 DNS。
fn resolve_host_via_doh(host: &str) -> Result<Vec<std::net::IpAddr>, String> {
    const RESOLVERS: [(&str, &str, &str); 2] = [
        ("dns.google", "8.8.8.8", "https://dns.google/resolve"),
        (
            "cloudflare-dns.com",
            "1.1.1.1",
            "https://cloudflare-dns.com/dns-query",
        ),
    ];
    let mut errors = Vec::new();
    for (resolver_host, resolver_ip, endpoint) in RESOLVERS {
        for record_type in ["A", "AAAA"] {
            let mut cmd = Command::new("curl");
            cmd.arg("--disable")
                .arg("-sS")
                .arg("--connect-timeout")
                .arg("4")
                .arg("--max-time")
                .arg("8")
                .arg("--max-filesize")
                .arg("262144")
                .arg("--connect-to")
                .arg(format!("{}:443:{}:443", resolver_host, resolver_ip))
                .arg("--get")
                .arg("--data-urlencode")
                .arg(format!("name={}", host))
                .arg("--data")
                .arg(format!("type={}", record_type))
                .arg("-H")
                .arg("accept: application/dns-json")
                .arg(endpoint);
            let output = match cmd.output() {
                Ok(output) => output,
                Err(e) => {
                    errors.push(format!(
                        "{} {} 查询启动失败：{}",
                        resolver_host, record_type, e
                    ));
                    continue;
                }
            };
            if !output.status.success() {
                errors.push(format!(
                    "{} {} 查询失败：{}",
                    resolver_host,
                    record_type,
                    tail_text(&String::from_utf8_lossy(&output.stderr), 160)
                ));
                continue;
            }
            let body = String::from_utf8_lossy(&output.stdout);
            match parse_doh_ips(&body) {
                Ok(ips) => return Ok(ips),
                Err(e) => errors.push(format!("{} {}：{}", resolver_host, record_type, e)),
            }
        }
    }
    Err(errors.join("；"))
}

/// 从 authority（已去掉 userinfo）解析 host 与显式端口。
/// 支持 `[v6]:port`、`[v6]`、`host:port`、裸 host；无括号 IPv6 字面量按纯主机处理。
fn parse_host_port(authority: &str) -> Result<(String, Option<u16>), String> {
    if let Some(inner) = authority.strip_prefix('[') {
        let close = inner
            .find(']')
            .ok_or_else(|| "URL 非法：IPv6 地址缺少右括号 ]".to_string())?;
        let host = &inner[..close];
        if host.is_empty() {
            return Err("URL 非法：主机名为空".to_string());
        }
        let after = &inner[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => Some(
                p.parse::<u16>()
                    .map_err(|_| format!("URL 非法：端口号无效：{}", p))?,
            ),
            None if after.is_empty() => None,
            None => return Err(format!("URL 非法：主机/端口格式错误：{}", authority)),
        };
        return Ok((host.to_string(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && !host.contains(':') => {
            let port = port
                .parse::<u16>()
                .map_err(|_| format!("URL 非法：端口号无效：{}", port))?;
            Ok((host.to_string(), Some(port)))
        }
        // 无括号 IPv6 字面量（如 ::1）或畸形写法：整体按主机处理，
        // 后续 IP 解析/域名解析会给出明确成败
        _ => Ok((authority.to_string(), None)),
    }
}

/// SSRF 复查（前端校验不是安全边界，这里才是）：仅允许 http/https；解析
/// 域名后拒绝私网/环回/链路本地/保留地址；域名解析到的全部地址都必须通过
/// 检查，并固定首个地址给 curl 防 DNS rebinding。若系统 DNS 仅返回
/// 198.18.0.0/15（本机代理 fake-ip），先通过固定公网 IP 的 DoH 获取真实
/// 地址并重复相同的公网检查。
fn validate_fetch_url(raw: &str) -> Result<ValidatedFetchUrl, String> {
    use std::net::ToSocketAddrs;

    let url = raw.trim();
    if url.is_empty() {
        return Err("URL 非法：不能为空".to_string());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("URL 非法：包含空白或控制字符".to_string());
    }
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| "URL 非法：缺少协议 scheme（仅允许 http/https）".to_string())?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("URL 非法：仅允许 http/https，收到 {}://", scheme));
    }

    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    // 去掉 userinfo（user:pass@host），取最后一个 @ 之后的内容
    let host_port = authority.rsplit('@').next().unwrap_or("");
    if host_port.is_empty() {
        return Err("URL 非法：缺少主机名".to_string());
    }
    let (host, explicit_port) = parse_host_port(host_port)?;
    let port = explicit_port.unwrap_or(if scheme == "https" { 443 } else { 80 });

    let lookup_host = host.trim_end_matches('.');
    if lookup_host.is_empty() {
        return Err("URL 非法：缺少主机名".to_string());
    }
    let pinned_ip = if let Ok(ip) = lookup_host.parse::<std::net::IpAddr>() {
        // IP 字面量（含 0x7f000001、2130706433 等写法不会被 Rust 解析成
        // IP，会落入下面的域名分支由系统解析器识别后再判定）
        if is_blocked_ip(&ip) {
            return Err(format!("已拦截对内网/保留地址 {} 的请求（SSRF 防护）", ip));
        }
        None
    } else {
        let addrs: Vec<std::net::SocketAddr> = (lookup_host, port)
            .to_socket_addrs()
            .map_err(|e| format!("解析域名 {} 失败：{}", lookup_host, e))?
            .collect();
        if addrs.is_empty() {
            return Err(format!("解析域名 {} 失败：无可用地址", lookup_host));
        }
        let local_ips: Vec<std::net::IpAddr> = addrs.iter().map(|addr| addr.ip()).collect();
        let resolved_ips = if local_ips.iter().all(is_proxy_fake_ip) {
            resolve_host_via_doh(lookup_host).map_err(|e| {
                format!(
                    "检测到本机代理 Fake-IP，但安全解析域名 {} 的真实地址失败：{}",
                    lookup_host, e
                )
            })?
        } else {
            local_ips
        };
        let mut first = None;
        for ip in resolved_ips {
            if is_blocked_ip(&ip) {
                return Err(format!(
                    "已拦截域名 {} 的请求：解析到内网/保留地址 {}（SSRF 防护）",
                    lookup_host, ip
                ));
            }
            if first.is_none() {
                first = Some(ip);
            }
        }
        first
    };

    Ok(ValidatedFetchUrl {
        url: url.to_string(),
        scheme,
        host,
        port,
        pinned_ip,
    })
}

fn is_redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// 只跟随绝对 http(s) 与 scheme-relative（//host/path）重定向；相对路径
/// 重定向不跟随，把 3xx 响应原样返回（与引入跟随前的行为一致）。
fn resolve_redirect_url(validated: &ValidatedFetchUrl, location: &str) -> Option<String> {
    let lower = location.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(location.to_string())
    } else if location.starts_with("//") {
        Some(format!("{}:{}", validated.scheme, location))
    } else {
        None
    }
}

struct CurlFetchResponse {
    status: u16,
    redirect_url: String,
    body: String,
}

/// 归一化 origin（scheme://host:port）用于跨源判断：host 小写化并去尾部点；
/// 端口取 validate_fetch_url 归一后的有效端口（显式 :443 与不显式等价）；
/// userinfo 在 URL 解析阶段已剔除，不参与 origin。
fn url_origin_key(validated: &ValidatedFetchUrl) -> String {
    format!(
        "{}://{}:{}",
        validated.scheme,
        validated.host.trim_end_matches('.').to_ascii_lowercase(),
        validated.port
    )
}

/// 跨源重定向只保留明确无敏感信息的请求头。不能靠认证头黑名单判断：
/// 渠道允许任意自定义头，`X-Token` 等未知名称同样可能承载密钥。
fn cross_origin_safe_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    const SAFE_HEADER_NAMES: [&str; 3] = ["accept", "accept-language", "user-agent"];
    headers
        .iter()
        .filter(|(name, _)| SAFE_HEADER_NAMES.contains(&name.to_ascii_lowercase().as_str()))
        .cloned()
        .collect()
}

/// 决定重定向下一跳要发送的 headers：origin 不变全部保留；跨源只保留安全
/// allowlist。返回 (下一跳 headers, 是否跨源)。一旦剥离，后续跳保持剥离状态
/// （调用方把返回值作为下一跳的输入），即使又跳回原源也不恢复。
fn redirect_hop_headers(
    prev_origin: &str,
    next_origin: &str,
    headers: &[(String, String)],
) -> (Vec<(String, String)>, bool) {
    if prev_origin == next_origin {
        return (headers.to_vec(), false);
    }
    (cross_origin_safe_headers(headers), true)
}

/// 将 String 截断到不超过 max_bytes，且截断点始终位于 UTF-8 字符边界。
fn truncate_utf8_bytes(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value
}

fn curl_get_once(
    validated: &ValidatedFetchUrl,
    headers: &[(String, String)],
) -> Result<CurlFetchResponse, String> {
    let mut cmd = Command::new("curl");
    cmd.arg("--disable")
        .arg("-sS")
        .arg("-m")
        .arg(HTTP_GET_TIMEOUT_SECS)
        .arg("-o")
        .arg("-")
        .arg("-w")
        .arg("\n__HTTP_STATUS__:%{http_code}\n__REDIRECT_URL__:%{redirect_url}");
    if let Some(ip) = validated.pinned_ip {
        // 固定实际连接目标，防校验与连接之间的 DNS rebinding。
        // 与 --resolve 不同，--connect-to 在 HTTP(S) 代理下也会让代理
        // CONNECT 到已校验的 IP，同时保留原 URL 的 Host 与 TLS SNI。
        let entry = if ip.is_ipv6() {
            format!(
                "{}:{}:[{}]:{}",
                validated.host, validated.port, ip, validated.port
            )
        } else {
            format!(
                "{}:{}:{}:{}",
                validated.host, validated.port, ip, validated.port
            )
        };
        cmd.arg("--connect-to").arg(entry);
    }
    for (name, value) in headers {
        cmd.arg("-H").arg(format!("{}: {}", name, value));
    }
    cmd.arg(&validated.url);
    let output = cmd.output().map_err(|e| format!("curl 启动失败：{}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let (rest, redirect_url) = match stdout.rsplit_once("\n__REDIRECT_URL__:") {
        Some((body, url)) => (body.to_string(), url.trim().to_string()),
        None => (stdout, String::new()),
    };
    let (body, status) = match rest.rsplit_once("\n__HTTP_STATUS__:") {
        Some((body, code)) => (body.to_string(), code.trim().parse::<u16>().unwrap_or(0)),
        None => (rest, 0u16),
    };
    if status == 0 && !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("网络请求失败：{}", tail_text(&stderr, 200)));
    }
    Ok(CurlFetchResponse {
        status,
        redirect_url,
        body,
    })
}

/// 经 Rust 侧 curl 发 GET 请求，绕开 WKWebView 的 CORS 限制（拉取模型列表等场景）。
/// 安全边界在 Rust 侧：仅 http/https；目标 IP（含域名解析结果、重定向每跳）
/// 拒绝私网/环回/链路本地/保留地址；代理 fake-ip 经固定公网 DoH 复查；
/// DNS 解析经 --connect-to 固定防 rebinding（含 HTTP(S) 代理场景）；
/// 重定向跨源（scheme/host/port 任一变化）时仅保留明确安全的请求头 allowlist；
/// 单跳 15s 超时；body 截断 4MB。参数数组传参、禁 shell 拼接。
#[tauri::command]
async fn http_get(url: String, headers: Vec<(String, String)>) -> Result<HttpGetResult, String> {
    tokio::task::spawn_blocking(move || {
        // 拒绝带 CR/LF 的 header 名/值（防请求拆分）；header 名同样不允许冒号
        for (name, value) in &headers {
            if name.chars().any(|c| c == '\r' || c == '\n' || c == ':')
                || value.chars().any(|c| c == '\r' || c == '\n')
            {
                return Err(format!("请求头 {} 包含非法字符", name));
            }
        }

        let mut current = url;
        let mut hop_headers = headers;
        let mut prev_origin: Option<String> = None;
        for hop in 0..=HTTP_GET_MAX_REDIRECTS {
            let validated = validate_fetch_url(&current)?;
            let origin = url_origin_key(&validated);
            if let Some(prev) = prev_origin.as_deref() {
                let (next_headers, cross_origin) =
                    redirect_hop_headers(prev, &origin, &hop_headers);
                let removed = hop_headers.len() - next_headers.len();
                if cross_origin && removed > 0 {
                    eprintln!(
                        "http_get：跨源重定向 {} -> {}，已剥离 {} 个非 allowlist 请求头",
                        prev, origin, removed
                    );
                }
                hop_headers = next_headers;
            }
            prev_origin = Some(origin);
            let response = curl_get_once(&validated, &hop_headers)?;
            if is_redirect_status(response.status) && !response.redirect_url.is_empty() {
                if let Some(next) = resolve_redirect_url(&validated, &response.redirect_url) {
                    if hop == HTTP_GET_MAX_REDIRECTS {
                        return Err(format!(
                            "重定向次数过多（超过 {} 次）",
                            HTTP_GET_MAX_REDIRECTS
                        ));
                    }
                    current = next;
                    continue; // 重定向每一跳都重新过 validate_fetch_url
                }
                // 相对路径重定向：不跟随，返回 3xx 响应本身
            }
            let body = truncate_utf8_bytes(response.body, HTTP_GET_MAX_BODY_BYTES);
            return Ok(HttpGetResult {
                status: response.status,
                body,
            });
        }
        unreachable!("redirect loop bounded by HTTP_GET_MAX_REDIRECTS")
    })
    .await
    .map_err(|e| format!("请求任务失败：{}", e))?
}

/// 经 shell 执行密钥命令，取 stdout 首行；超时即杀进程报错。
/// 轮询 try_wait 而非另起读线程：密钥命令输出极小，不会撑满管道缓冲；
/// 万一撑满导致子进程阻塞，超时分支也会把它杀掉。
fn run_secret_command(cmdline: &str, timeout: Duration) -> Result<String, String> {
    #[allow(unused_mut)]
    let mut cmd = {
        #[cfg(target_os = "windows")]
        {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(cmdline);
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
            c
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut c = Command::new("sh");
            c.arg("-c").arg(cmdline);
            c
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("密钥命令启动失败：{}", e))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("密钥命令执行超时（{} 秒）", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待密钥命令失败：{}", e)),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("读取密钥命令输出失败：{}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "密钥命令执行失败（退出码 {}）：{}",
            output.status.code().unwrap_or(-1),
            tail_text(&stderr, 200)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return Err("密钥命令没有输出".to_string());
    }
    Ok(first_line.to_string())
}

/// 解析密钥引用（前端拉模型列表等场景需要把 auth.json/models.json 里的
/// 引用形式还原成真实密钥）：
/// - `$ENV_VAR`（含 `${ENV_VAR}`）：读进程环境变量，未设置则报错；
/// - `!cmd ...`：经 shell 执行，取 stdout 首行（10s 超时，非零退出/无输出报错）；
/// - 其他：字面量原样返回。
/// JS 侧参数名为 `ref`（Rust 参数 `ref_` 经默认 camelCase 转换得到）。
#[tauri::command(rename_all = "camelCase")]
async fn resolve_secret_ref(ref_: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || resolve_secret_ref_impl(&ref_))
        .await
        .map_err(|e| format!("解析密钥引用失败：{}", e))?
}

fn resolve_secret_ref_impl(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if let Some(name) = trimmed.strip_prefix('$') {
        // 兼容 ${VAR} 写法
        let name = name
            .trim()
            .strip_prefix('{')
            .and_then(|rest| rest.strip_suffix('}'))
            .unwrap_or_else(|| name.trim());
        if name.is_empty() {
            return Err("密钥引用的环境变量名为空".to_string());
        }
        return std::env::var(name).map_err(|_| format!("环境变量 {} 未设置", name));
    }
    if let Some(cmdline) = trimmed.strip_prefix('!') {
        let cmdline = cmdline.trim();
        if cmdline.is_empty() {
            return Err("密钥引用的命令为空".to_string());
        }
        return run_secret_command(cmdline, Duration::from_secs(10));
    }
    Ok(raw.to_string())
}

fn sanitize_version_token(raw: &str) -> String {
    raw.trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .to_string()
}

fn is_semverish(token: &str) -> bool {
    let core = token.split('-').next().unwrap_or(token);
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() < 2 {
        return false;
    }

    parts
        .iter()
        .take(3)
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn parse_semver_tuple(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split('-').next().unwrap_or(version);
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some((major, minor, patch))
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    // 仅当 latest 严格大于 current 才提示更新；任一端无法解析为 semver 时
    // 宁可不提示，避免把「版本串不同」误报为「有新版本」。
    match (parse_semver_tuple(latest), parse_semver_tuple(current)) {
        (Some(lat), Some(cur)) => lat > cur,
        _ => false,
    }
}

fn extract_version_from_output(output: &str) -> Option<String> {
    for raw in output.split_whitespace() {
        let token = sanitize_version_token(raw);
        if token.is_empty() {
            continue;
        }

        let normalized = token.strip_prefix('v').unwrap_or(&token);
        if is_semverish(normalized) {
            return Some(normalized.to_string());
        }
    }

    None
}

fn get_current_pi_version(pi: &PiProcess, options: &CliStatusOptions) -> Option<String> {
    let version_opts = PiCliCommandOptions {
        args: vec!["--version".to_string()],
        cwd: options.cwd.clone(),
        env: options.env.clone(),
        cli_path: options.cli_path.clone(),
        pi_path: options.pi_path.clone(),
    };

    let output = build_plain_command(pi, &version_opts).output().ok()?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    extract_version_from_output(&combined)
}

fn get_latest_npm_cli_version(pi: Option<&PiProcess>) -> (bool, Option<String>, Option<String>) {
    let npm_path = match discover_npm_path(pi) {
        Some(path) => path,
        None => {
            return (
                false,
                None,
                Some("未在 PATH 或常见安装位置找到 npm".to_string()),
            );
        }
    };

    let mut cmd = Command::new(&npm_path);
    cmd.arg("view")
        .arg("@earendil-works/pi-coding-agent")
        .arg("version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(parent) = npm_path.parent() {
        prepend_bin_dir_to_path(&mut cmd, parent);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = match cmd.output() {
        Ok(out) => out,
        Err(err) => {
            return (true, None, Some(format!("运行 npm 失败：{}", err)));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        let error = if stderr.is_empty() {
            "检查最新版本时 npm 返回错误".to_string()
        } else {
            stderr
        };
        return (true, None, Some(error));
    }

    let latest = extract_version_from_output(&stdout).or_else(|| {
        if stdout.is_empty() {
            None
        } else {
            Some(stdout)
        }
    });

    if latest.is_none() {
        return (
            true,
            None,
            Some("无法从 npm 输出解析最新的 CLI 版本".to_string()),
        );
    }

    (true, latest, None)
}

fn build_plain_command(pi: &PiProcess, options: &PiCliCommandOptions) -> Command {
    let mut cmd = match pi {
        PiProcess::DevNode { script } => {
            let mut c = Command::new("node");
            c.arg(script);
            c
        }
        PiProcess::SidecarBinary { path } | PiProcess::PathBinary { path } => Command::new(path),
    };

    for arg in &options.args {
        cmd.arg(arg);
    }

    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(env) = &options.env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    if let PiProcess::PathBinary { path } = pi {
        if let Some(parent) = path.parent() {
            prepend_bin_dir_to_path(&mut cmd, parent);
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}

/// Run a regular pi CLI command (e.g. package operations: list/install/remove/update)
#[tauri::command]
async fn run_pi_cli_command(
    app: AppHandle,
    options: PiCliCommandOptions,
) -> Result<PiCliCommandResult, String> {
    if options.args.is_empty() {
        return Err("未提供命令参数".to_string());
    }

    let resolved_cwd = options.cwd.clone().unwrap_or_else(|| ".".to_string());
    if !Path::new(&resolved_cwd).is_dir() {
        return Err(format!("工作目录不存在：{}", resolved_cwd));
    }

    let discovery_opts = RpcStartOptions {
        cli_path: options.cli_path.clone(),
        pi_path: options.pi_path.clone(),
        cwd: resolved_cwd,
        provider: None,
        model: None,
        session_path: None,
        env: options.env.clone(),
    };

    let pi = discover_pi(&app, &discovery_opts)?;
    let discovery_label = format!("{:?}", pi);

    let output = build_plain_command(&pi, &options)
        .output()
        .map_err(|e| format!("运行 pi 命令失败（{:?}）：{}", pi, e))?;

    Ok(PiCliCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        discovery: discovery_label,
    })
}

/// Get current vs latest CLI version and whether in-app update is available.
#[tauri::command]
async fn get_cli_update_status(
    app: AppHandle,
    options: Option<CliStatusOptions>,
) -> Result<CliUpdateStatus, String> {
    let opts = options.unwrap_or(CliStatusOptions {
        cli_path: None,
        pi_path: None,
        cwd: Some(".".to_string()),
        env: None,
    });

    let discovery_opts = RpcStartOptions {
        cli_path: opts.cli_path.clone(),
        pi_path: opts.pi_path.clone(),
        cwd: opts.cwd.clone().unwrap_or_else(|| ".".to_string()),
        provider: None,
        model: None,
        session_path: None,
        env: opts.env.clone(),
    };

    let pi = discover_pi(&app, &discovery_opts)?;
    let discovery = format!("{:?}", pi);
    let current_version = get_current_pi_version(&pi, &opts);

    let (npm_available, latest_version, npm_note) = get_latest_npm_cli_version(Some(&pi));

    let can_update_in_app = matches!(pi, PiProcess::PathBinary { .. });
    let update_command = "npm install -g @earendil-works/pi-coding-agent@latest".to_string();

    let update_available = match (&current_version, &latest_version) {
        (Some(current), Some(latest)) if can_update_in_app => is_newer_version(latest, current),
        _ => false,
    };

    let note = if let Some(note) = npm_note {
        Some(note)
    } else if matches!(pi, PiProcess::SidecarBinary { .. }) {
        Some("当前使用应用内置的 sidecar 二进制；请通过更新桌面应用来更新 CLI".to_string())
    } else if matches!(pi, PiProcess::DevNode { .. }) {
        Some("当前使用开发模式的 CLI 路径；请更新本地 coding-agent 代码仓库".to_string())
    } else if !can_update_in_app {
        Some("当前 CLI 来源不支持在桌面应用内更新".to_string())
    } else {
        None
    };

    Ok(CliUpdateStatus {
        discovery,
        current_version,
        latest_version,
        update_available,
        can_update_in_app,
        npm_available,
        update_command,
        note,
    })
}

#[tauri::command]
async fn get_pi_changelog(
    app: AppHandle,
    options: Option<CliStatusOptions>,
) -> Result<PiChangelogResult, String> {
    let opts = options.unwrap_or(CliStatusOptions {
        cli_path: None,
        pi_path: None,
        cwd: Some(".".to_string()),
        env: None,
    });

    let discovery_opts = RpcStartOptions {
        cli_path: opts.cli_path.clone(),
        pi_path: opts.pi_path.clone(),
        cwd: opts.cwd.clone().unwrap_or_else(|| ".".to_string()),
        provider: None,
        model: None,
        session_path: None,
        env: opts.env.clone(),
    };

    let pi = discover_pi(&app, &discovery_opts)?;
    let candidates = resolve_pi_changelog_candidates(&pi);
    let mut seen = HashSet::new();

    for candidate in candidates {
        let raw = candidate.to_string_lossy().to_string();
        if raw.trim().is_empty() || !seen.insert(raw.clone()) {
            continue;
        }
        if !candidate.is_file() {
            continue;
        }

        match fs::read_to_string(&candidate) {
            Ok(content) => {
                return Ok(PiChangelogResult { path: raw, content });
            }
            Err(_) => {
                continue;
            }
        }
    }

    Err(format!(
        "找不到 Pi Coding Agent 的更新日志（探测方式：{:?}）",
        pi
    ))
}

fn build_npm_update_command(npm_path: &Path) -> Command {
    let mut cmd = Command::new(npm_path);
    cmd.arg("install")
        .arg("-g")
        .arg("@earendil-works/pi-coding-agent@latest")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(parent) = npm_path.parent() {
        prepend_bin_dir_to_path(&mut cmd, parent);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}

/// 按当前设置发现 pi（失败时返回 None，不阻断 npm 解析）
fn discover_pi_silently(app: &AppHandle, options: Option<CliStatusOptions>) -> Option<PiProcess> {
    let opts = options.unwrap_or(CliStatusOptions {
        cli_path: None,
        pi_path: None,
        cwd: Some(".".to_string()),
        env: None,
    });
    let discovery_opts = RpcStartOptions {
        cli_path: opts.cli_path,
        pi_path: opts.pi_path,
        cwd: opts.cwd.unwrap_or_else(|| ".".to_string()),
        provider: None,
        model: None,
        session_path: None,
        env: opts.env,
    };
    discover_pi(app, &discovery_opts).ok()
}

/// Update globally installed pi CLI via npm.
#[tauri::command]
async fn update_cli_via_npm(app: AppHandle) -> Result<NpmCommandResult, String> {
    // 与 pi 发现共用一套 npm 解析：优先 pi 同目录，其次常见安装位置，最后登录 shell 兜底
    let pi = discover_pi_silently(&app, None);
    let npm_path = discover_npm_path(pi.as_ref())
        .ok_or_else(|| "未在 PATH 或常见安装位置找到 npm。请先安装 Node.js/npm。".to_string())?;

    let output = build_npm_update_command(&npm_path)
        .output()
        .map_err(|e| format!("运行 npm 更新命令失败（{}）：{}", npm_path.display(), e))?;

    Ok(NpmCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// 一键更新 CLI 的结构化结果：新版本号 + 输出尾段（前端可直接展示失败原因）
#[derive(Debug, Serialize)]
struct CliUpdateReport {
    success: bool,
    exit_code: i32,
    npm_path: Option<String>,
    new_version: Option<String>,
    output_tail: String,
    error: Option<String>,
}

/// Resolve npm → run npm install -g → report the new version and output tail.
#[tauri::command]
async fn update_cli_and_report(
    app: AppHandle,
    options: Option<CliStatusOptions>,
) -> Result<CliUpdateReport, String> {
    let pi = discover_pi_silently(&app, options);

    let Some(npm_path) = discover_npm_path(pi.as_ref()) else {
        return Ok(CliUpdateReport {
            success: false,
            exit_code: -1,
            npm_path: None,
            new_version: None,
            output_tail: String::new(),
            error: Some("未在 PATH 或常见安装位置找到 npm。请先安装 Node.js/npm。".to_string()),
        });
    };

    let npm_label = npm_path.to_string_lossy().to_string();
    let output = match build_npm_update_command(&npm_path).output() {
        Ok(out) => out,
        Err(err) => {
            return Ok(CliUpdateReport {
                success: false,
                exit_code: -1,
                npm_path: Some(npm_label),
                new_version: None,
                output_tail: String::new(),
                error: Some(format!("运行 npm 更新命令失败：{}", err)),
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);
    let success = output.status.success();
    let new_version = if success {
        get_latest_npm_cli_version(pi.as_ref()).1
    } else {
        None
    };

    Ok(CliUpdateReport {
        success,
        exit_code,
        npm_path: Some(npm_label),
        new_version,
        output_tail: tail_text(&format!("{}\n{}", stdout, stderr), 2000),
        error: None,
    })
}

#[tauri::command]
async fn run_git_command(options: GitCommandOptions) -> Result<GitCommandResult, String> {
    if options.args.is_empty() {
        return Err("未提供 git 命令参数".to_string());
    }

    let git_path = which::which("git").map_err(|_| "未在 PATH 上找到 git".to_string())?;

    let mut cmd = Command::new(git_path);
    cmd.args(&options.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(cwd) = options.cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .map_err(|e| format!("运行 git 命令失败：{}", e))?;

    Ok(GitCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
async fn create_share_gist(options: ShareGistOptions) -> Result<ShareGistResult, String> {
    let html_path_raw = options.html_path.trim();
    if html_path_raw.is_empty() {
        return Err("未提供导出文件路径".to_string());
    }

    let html_path = PathBuf::from(html_path_raw);
    if !html_path.is_file() {
        return Err(format!("找不到导出的会话文件：{}", html_path_raw));
    }

    let gh_path = discover_gh_path().ok_or_else(|| {
        "未安装 GitHub CLI（gh）。请前往 https://cli.github.com/ 安装。".to_string()
    })?;

    let mut auth_cmd = Command::new(&gh_path);
    auth_cmd
        .arg("auth")
        .arg("status")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        auth_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let auth_output = auth_cmd
        .output()
        .map_err(|e| format!("运行 gh auth status 失败：{}", e))?;

    if !auth_output.status.success() {
        return Err("GitHub CLI 未登录。请先运行 'gh auth login'。".to_string());
    }

    let mut gist_cmd = Command::new(&gh_path);
    gist_cmd
        .arg("gist")
        .arg("create")
        .arg("--public=false")
        .arg(&html_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(parent) = html_path.parent() {
        gist_cmd.current_dir(parent);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        gist_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let gist_output = gist_cmd
        .output()
        .map_err(|e| format!("运行 gh gist create 失败：{}", e))?;

    let stdout = String::from_utf8_lossy(&gist_output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&gist_output.stderr).to_string();

    if !gist_output.status.success() {
        let message = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!(
                "gh gist create 执行失败，退出码：{}",
                gist_output.status.code().unwrap_or(-1)
            )
        };
        return Err(format!("创建 gist 失败：{}", message));
    }

    let combined = format!("{}\n{}", stdout, stderr);
    let gist_url = parse_gist_url_from_output(&combined)
        .ok_or_else(|| "无法从 gh 输出解析 gist URL".to_string())?;
    let gist_id = parse_gist_id_from_url(&gist_url)
        .ok_or_else(|| "无法从 gh 输出解析 gist ID".to_string())?;
    let preview_url = format!("https://pi.dev/session/#{}", gist_id);

    Ok(ShareGistResult {
        gist_url,
        gist_id,
        preview_url,
        stdout,
        stderr,
    })
}

#[tauri::command]
async fn get_desktop_runtime_info(app: AppHandle) -> Result<DesktopRuntimeInfo, String> {
    Ok(DesktopRuntimeInfo {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        version: app.package_info().version.to_string(),
    })
}

/// 重启应用（Tauri 内置 restart，无需 process 插件）。
#[tauri::command]
async fn relaunch_app(app: AppHandle) -> Result<(), String> {
    app.restart()
}

#[tauri::command]
async fn open_path_in_default_app(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("未提供路径".to_string());
    }

    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(format!("路径不存在：{}", trimmed));
    }

    #[cfg(target_os = "macos")]
    {
        let primary = Command::new("open")
            .arg(&target)
            .output()
            .map_err(|e| format!("运行 open 命令失败：{}", e))?;

        if primary.status.success() {
            return Ok(());
        }

        // Some files (e.g. .sample hooks in .git) have no associated app.
        // Fall back to TextEdit so "Open in editor" still works.
        let fallback = Command::new("open")
            .arg("-a")
            .arg("TextEdit")
            .arg(&target)
            .output()
            .map_err(|e| format!("运行 TextEdit 备用打开失败：{}", e))?;

        if fallback.status.success() {
            return Ok(());
        }

        let primary_stderr = String::from_utf8_lossy(&primary.stderr).trim().to_string();
        let fallback_stderr = String::from_utf8_lossy(&fallback.stderr).trim().to_string();
        return Err(format!(
            "无法打开文件。默认应用错误：{} | TextEdit 备用打开错误：{}",
            if primary_stderr.is_empty() {
                format!("退出码：{}", primary.status.code().unwrap_or(-1))
            } else {
                primary_stderr
            },
            if fallback_stderr.is_empty() {
                format!("退出码：{}", fallback.status.code().unwrap_or(-1))
            } else {
                fallback_stderr
            }
        ));
    }

    #[cfg(target_os = "linux")]
    {
        let output = Command::new("xdg-open")
            .arg(&target)
            .output()
            .map_err(|e| format!("运行 xdg-open 命令失败：{}", e))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "无法打开文件（退出码：{}）",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("无法打开文件：{}", stderr)
        });
    }

    #[cfg(target_os = "windows")]
    {
        let output = Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(target.as_os_str())
            .output()
            .map_err(|e| format!("运行 start 命令失败：{}", e))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "无法打开文件（退出码：{}）",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("无法打开文件：{}", stderr)
        });
    }

    #[allow(unreachable_code)]
    Err("当前平台不支持 open_path_in_default_app 操作".to_string())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ =
                        window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
                    let _ = window.set_shadow(true);
                }
            }
            // 渠道保存事务的启动恢复：上次保存若崩在中途，残留的 recovery
            // journal 在这里按快照回滚（或识别为已提交）并清理；恢复不了则
            // 保留 journal 并记录错误（下一次保存会在入口处再拦截提示）。
            {
                let journal_path = app
                    .path()
                    .app_data_dir()
                    .map(|dir| dir.join(channel_save::JOURNAL_FILE_NAME));
                if let Ok(path) = journal_path {
                    match channel_save::recover_stale_journal(&path) {
                        Ok(Some(info)) => eprintln!(
                            "已按恢复日志处理上次未完成的渠道保存（{}）：provider={} path={}",
                            info.action,
                            info.provider,
                            path.display()
                        ),
                        Ok(None) => {}
                        Err(e) => eprintln!("渠道保存恢复日志处理失败：{}", e),
                    }
                }
            }
            Ok(())
        })
        .manage(RpcState::default())
        .invoke_handler(tauri::generate_handler![
            rpc_start,
            rpc_send,
            rpc_claim_session_lease,
            session_rewrite::rewrite_session_before_user_entry,
            session_rewrite::stop_rpc_process_retain_session_lease,
            rpc_stop,
            rpc_stop_all,
            rpc_is_running,
            rpc_ui_response,
            list_sessions,
            list_pi_session_projects,
            get_session_content,
            get_session_page,
            get_pi_auth_status,
            get_pi_oauth_providers,
            clear_pi_provider_auth,
            save_settings,
            load_settings,
            open_file_dialog,
            run_pi_cli_command,
            get_cli_update_status,
            get_pi_changelog,
            update_cli_via_npm,
            update_cli_and_report,
            run_git_command,
            create_share_gist,
            get_desktop_runtime_info,
            relaunch_app,
            open_path_in_default_app,
            safe_config::safe_read_json,
            safe_config::safe_write_json,
            channel_save::save_channel_config,
            http_get,
            resolve_secret_ref,
            safe_config::keychain_set,
            safe_config::keychain_get,
            safe_config::keychain_delete,
            review::git_review_status,
            review::git_review_diff,
            review::git_review_stage,
            review::git_review_unstage,
            extensions::list_skill_resources,
            extensions::install_skill_from_path,
            extensions::list_loose_extensions,
            extensions::move_path_to_trash,
            extensions::get_project_trust_status,
            extensions::set_project_trust,
            extensions::list_trusted_projects,
            extensions::list_mcp_servers,
            extensions::scan_mcp_import_sources,
            subagents::list_subagents,
            subagents::read_subagent,
            subagents::save_subagent,
            subagents::list_subagent_runs,
            subagents::read_subagent_run,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Orchestrated shutdown of every pi runtime: abort runs, then
            // SIGTERM the process groups, then SIGKILL whatever survives.
            let state = app_handle.state::<RpcState>();
            shutdown_all_instances(
                state.inner(),
                Duration::from_millis(3_000),
                Duration::from_millis(2_000),
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Barrier;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn controlled_session_claim_requires_exact_expected_path() {
        assert!(
            ensure_expected_session_path("/tmp/project/a.jsonl", Some("/tmp/project/a.jsonl"))
                .is_ok()
        );
        let mismatch = ensure_expected_session_path(
            "/tmp/project/new.jsonl",
            Some("/tmp/project/original.jsonl"),
        )
        .unwrap_err();
        assert!(mismatch.contains("错误的会话文件"));
    }

    #[test]
    fn rpc_generation_is_not_reused_after_stop_then_start() {
        let state = RpcState::default();
        let instance_id = "default";

        let first = next_rpc_generation(&state, instance_id).unwrap();
        state.instances.lock().unwrap().insert(
            instance_id.to_string(),
            RpcProcessHandle {
                generation: first,
                ..RpcProcessHandle::default()
            },
        );

        let mut stopped = state.instances.lock().unwrap().remove(instance_id).unwrap();
        stop_rpc_instance(&mut stopped);

        let restarted = next_rpc_generation(&state, instance_id).unwrap();
        assert_eq!(first, 1);
        assert_eq!(restarted, 2);
        assert_ne!(
            restarted, first,
            "stop 删除 process handle 后，下一次 start 不得复用旧 generation"
        );
    }

    #[test]
    fn failed_rpc_preparation_does_not_consume_generation() {
        let state = RpcState::default();
        let instance_id = "prepare-failure";

        let failed = assign_generation_to_prepared_rpc::<()>(
            &state,
            instance_id,
            Err("spawn failed".to_string()),
        );
        assert_eq!(failed.unwrap_err(), "spawn failed");
        assert!(
            !state.generations.lock().unwrap().contains_key(instance_id),
            "前置失败不得创建或递增 generation"
        );

        let (generation, ()) =
            assign_generation_to_prepared_rpc(&state, instance_id, Ok(())).unwrap();
        assert_eq!(generation, 1, "相邻的首次成功仍应获得 generation 1");
        assert_eq!(next_rpc_generation(&state, instance_id).unwrap(), 2);
    }

    #[test]
    fn late_rpc_closed_generation_does_not_match_restarted_instance() {
        let state = RpcState::default();
        let instance_id = "default";
        let old_generation = next_rpc_generation(&state, instance_id).unwrap();

        state.instances.lock().unwrap().insert(
            instance_id.to_string(),
            RpcProcessHandle {
                generation: old_generation,
                ..RpcProcessHandle::default()
            },
        );
        state.instances.lock().unwrap().remove(instance_id);

        let new_generation = next_rpc_generation(&state, instance_id).unwrap();
        state.instances.lock().unwrap().insert(
            instance_id.to_string(),
            RpcProcessHandle {
                generation: new_generation,
                ..RpcProcessHandle::default()
            },
        );

        let late_close = RpcClosedEventPayload {
            instance_id: instance_id.to_string(),
            generation: old_generation,
            reason: "进程已退出".to_string(),
        };
        let current_generation = state
            .instances
            .lock()
            .unwrap()
            .get(instance_id)
            .unwrap()
            .generation;

        assert_ne!(
            late_close.generation, current_generation,
            "旧 reader 的迟到 rpc-closed 不得命中新进程"
        );
    }

    fn temp_sessions_dir(tag: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "pi_session_projects_test_{}_{}_{}",
            tag,
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn session_header(cwd: &str, timestamp: &str) -> String {
        format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"timestamp\":\"{}\",\"cwd\":\"{}\"}}",
            timestamp, cwd
        )
    }

    fn write_session(dir: &Path, name: &str, first_line: &str) {
        fs::write(dir.join(name), format!("{}\n", first_line)).unwrap();
    }

    #[test]
    fn tail_text_keeps_short_input_and_trims() {
        assert_eq!(tail_text("  hello world  \n", 100), "hello world");
        assert_eq!(tail_text("", 100), "");
    }

    #[test]
    fn tail_text_truncates_to_last_chars() {
        let input = "0123456789abcdef";
        assert_eq!(tail_text(input, 4), "cdef");
        // 按字符数截断，中文等多字节字符不截断在 UTF-8 边界中间
        let chinese = "一二三四五六七八九十";
        assert_eq!(tail_text(chinese, 3), "八九十");
    }

    #[test]
    fn collects_projects_sorted_by_latest_activity() {
        let root = temp_sessions_dir("sorted");

        let older = root.join("--Users-demo-Desktop-sample-project--");
        fs::create_dir_all(&older).unwrap();
        write_session(
            &older,
            "a.jsonl",
            &session_header("/Users/demo/Desktop/sample-project", "2026-07-20T10:00:00Z"),
        );
        // mtimes are compared at millisecond precision: back-to-back writes can
        // tie, making the "latest file" pick depend on readdir order.
        std::thread::sleep(Duration::from_millis(5));
        write_session(
            &older,
            "b.jsonl",
            &session_header("/Users/demo/Desktop/sample-project", "2026-07-21T10:00:00Z"),
        );

        // Written after `older`, so its mtime sorts it first.
        std::thread::sleep(Duration::from_millis(5));
        let newer = root.join("--Users-demo-Documents-Codex--");
        fs::create_dir_all(&newer).unwrap();
        write_session(
            &newer,
            "c.jsonl",
            &session_header("/Users/demo/Documents/Codex", "2026-07-25T10:00:00Z"),
        );

        let projects = collect_pi_session_projects(&root);
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].cwd, "/Users/demo/Documents/Codex");
        assert_eq!(projects[0].session_count, 1);
        assert_eq!(projects[0].last_active, "2026-07-25T10:00:00Z");
        assert_eq!(projects[1].cwd, "/Users/demo/Desktop/sample-project");
        assert_eq!(projects[1].session_count, 2);
        assert_eq!(projects[1].last_active, "2026-07-21T10:00:00Z");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_directory_with_bad_first_line() {
        let root = temp_sessions_dir("bad_header");

        let bad = root.join("--Users-demo-broken--");
        fs::create_dir_all(&bad).unwrap();
        write_session(&bad, "broken.jsonl", "this is not json");

        let good = root.join("--Users-demo-Desktop-sample-project--");
        fs::create_dir_all(&good).unwrap();
        write_session(
            &good,
            "ok.jsonl",
            &session_header("/Users/demo/Desktop/sample-project", "2026-07-25T10:00:00Z"),
        );

        let projects = collect_pi_session_projects(&root);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].cwd, "/Users/demo/Desktop/sample-project");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_header_without_cwd() {
        let root = temp_sessions_dir("no_cwd");

        let dir = root.join("--Users-demo-nowhere--");
        fs::create_dir_all(&dir).unwrap();
        write_session(
            &dir,
            "nocwd.jsonl",
            "{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"timestamp\":\"2026-07-25T10:00:00Z\"}",
        );

        let projects = collect_pi_session_projects(&root);
        assert!(projects.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_and_missing_sessions_dir_yield_no_projects() {
        let root = temp_sessions_dir("empty");
        // An empty subdirectory (no .jsonl) is skipped.
        fs::create_dir_all(root.join("--Users-demo-empty--")).unwrap();
        // A stray file at the sessions root is not a project.
        write_session(
            &root,
            "stray.jsonl",
            &session_header("/Users/demo/stray", "2026-07-25T10:00:00Z"),
        );
        assert!(collect_pi_session_projects(&root).is_empty());
        let _ = fs::remove_dir_all(&root);

        let missing = std::env::temp_dir().join(format!(
            "pi_session_projects_test_missing_{}",
            std::process::id()
        ));
        assert!(collect_pi_session_projects(&missing).is_empty());
    }

    #[test]
    fn cwd_comes_from_header_not_encoded_dir_name() {
        // The encoded dir name is ambiguous for cwds containing '-':
        // "--Users-demo-Desktop-my-proj--" could decode to several paths.
        // The header cwd is authoritative.
        let root = temp_sessions_dir("hyphen");

        let dir = root.join("--Users-demo-Desktop-my-proj--");
        fs::create_dir_all(&dir).unwrap();
        write_session(
            &dir,
            "s.jsonl",
            &session_header("/Users/demo/Desktop/my-proj", "2026-07-25T10:00:00Z"),
        );

        let projects = collect_pi_session_projects(&root);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].cwd, "/Users/demo/Desktop/my-proj");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn newest_file_determines_project_cwd() {
        let root = temp_sessions_dir("newest");

        let dir = root.join("--Users-demo-Desktop-moved--");
        fs::create_dir_all(&dir).unwrap();
        // Older file first, then the newer one (later mtime wins).
        write_session(
            &dir,
            "old.jsonl",
            &session_header("/Users/demo/old-location", "2026-07-20T10:00:00Z"),
        );
        // Same millisecond-tie hazard as in collects_projects_sorted_by_latest_activity.
        std::thread::sleep(Duration::from_millis(5));
        write_session(
            &dir,
            "new.jsonl",
            &session_header("/Users/demo/new-location", "2026-07-25T10:00:00Z"),
        );

        let projects = collect_pi_session_projects(&root);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].cwd, "/Users/demo/new-location");
        assert_eq!(projects[0].session_count, 2);

        let _ = fs::remove_dir_all(&root);
    }

    // -----------------------------------------------------------------------
    // Session preview (first user message) extraction
    // -----------------------------------------------------------------------

    fn user_message_line(text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"2026-07-25T10:00:01Z\",\"message\":{{\"role\":\"user\",\"content\":{},\"timestamp\":123}}}}",
            serde_json::to_string(text).unwrap()
        )
    }

    #[test]
    fn preview_not_extracted_when_session_has_name() {
        let root = temp_sessions_dir("preview_named");
        let path = root.join("named.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                session_header("/Users/demo/x", "2026-07-25T10:00:00Z"),
                "{\"type\":\"session_info\",\"id\":\"i1\",\"parentId\":null,\"timestamp\":\"2026-07-25T10:00:02Z\",\"name\":\"已命名会话\"}",
                user_message_line("这条不应该成为 preview")
            ),
        )
        .unwrap();

        let info = parse_session_info(&path).unwrap();
        assert_eq!(info.name.as_deref(), Some("已命名会话"));
        assert_eq!(info.preview, None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_comes_from_first_user_message() {
        let root = temp_sessions_dir("preview_first_user");
        let path = root.join("unnamed.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                session_header("/Users/demo/x", "2026-07-25T10:00:00Z"),
                // An assistant message before the first user message is ignored.
                "{\"type\":\"message\",\"id\":\"m0\",\"parentId\":null,\"timestamp\":\"2026-07-25T10:00:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[],\"timestamp\":123}}",
                user_message_line("  帮我修一下\n\n登录页的   样式问题 ")
            ),
        )
        .unwrap();

        let info = parse_session_info(&path).unwrap();
        assert_eq!(info.name, None);
        // Whitespace/newlines collapse to single spaces.
        assert_eq!(
            info.preview.as_deref(),
            Some("帮我修一下 登录页的 样式问题")
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_reads_text_blocks_and_skips_empty_user_text() {
        let root = temp_sessions_dir("preview_blocks");
        let path = root.join("blocks.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"timestamp\":\"2026-07-25T10:00:00Z\",\"cwd\":\"/x\"}\n",
                // Image-only user message: no text, keep scanning.
                "{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"2026-07-25T10:00:01Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"data\":\"...\"}],\"timestamp\":123}}\n",
                "{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"m1\",\"timestamp\":\"2026-07-25T10:00:02Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"第一段\"},{\"type\":\"text\",\"text\":\"第二段\"}],\"timestamp\":123}}\n"
            ),
        )
        .unwrap();

        let info = parse_session_info(&path).unwrap();
        assert_eq!(info.preview.as_deref(), Some("第一段 第二段"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_truncates_long_text_by_chars() {
        let root = temp_sessions_dir("preview_truncate");
        let path = root.join("long.jsonl");
        let long_text: String =
            "很长的会话标题用来验证截断逻辑是否按字符数正确工作还需要再长一些才行继续补充几个字"
                .into();
        assert!(long_text.chars().count() > PREVIEW_MAX_CHARS);
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                session_header("/Users/demo/x", "2026-07-25T10:00:00Z"),
                user_message_line(&long_text)
            ),
        )
        .unwrap();

        let info = parse_session_info(&path).unwrap();
        let preview = info.preview.unwrap();
        let expected: String = long_text.chars().take(PREVIEW_MAX_CHARS).collect();
        assert_eq!(preview, format!("{}…", expected));
        // 40 chars + the ellipsis.
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS + 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_none_for_empty_or_broken_files() {
        let root = temp_sessions_dir("preview_broken");

        let empty = root.join("empty.jsonl");
        fs::write(&empty, "").unwrap();
        let info = parse_session_info(&empty).unwrap();
        assert_eq!(info.preview, None);

        let broken = root.join("broken.jsonl");
        fs::write(&broken, "not json at all\n{\"type\":\"message\"\n").unwrap();
        let info = parse_session_info(&broken).unwrap();
        assert_eq!(info.preview, None);

        let header_only = root.join("header_only.jsonl");
        fs::write(
            &header_only,
            format!(
                "{}\n",
                session_header("/Users/demo/x", "2026-07-25T10:00:00Z")
            ),
        )
        .unwrap();
        let info = parse_session_info(&header_only).unwrap();
        assert_eq!(info.preview, None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_strips_skill_invocation_block() {
        // Real-world shape: `/skill` invocation expands to a huge
        // machine-generated <skill …>…</skill> block; the user's actual
        // request follows the closing tag.
        let text = "<skill name=\"office-hours\" location=\"/Users/x/SKILL.md\">\nReferences are relative to /Users/x.\n\n## When to invoke this skill\n… lots of generated body …\n</skill>\n\n了解整个 sample-project 项目的结构";
        let content = user_message_line(text);
        assert_eq!(
            extract_session_preview(&content).as_deref(),
            Some("了解整个 sample-project 项目的结构")
        );
    }

    #[test]
    fn preview_strips_consecutive_leading_tags() {
        let content = user_message_line(
            " <system>internal notes</system>\n<skill name=\"x\">body</skill>  真正的问题在这里",
        );
        assert_eq!(
            extract_session_preview(&content).as_deref(),
            Some("真正的问题在这里")
        );
        // Lone and self-closing tags are stripped one by one.
        let content = user_message_line("<br/> <hr> <img src=\"a.png\"> hello");
        assert_eq!(extract_session_preview(&content).as_deref(), Some("hello"));
        // Quoted attribute values may contain '>' without ending the tag.
        let content = user_message_line("<skill name=\"a>b\">body</skill> real");
        assert_eq!(extract_session_preview(&content).as_deref(), Some("real"));
    }

    #[test]
    fn preview_strips_frontmatter_and_code_only_messages() {
        // First message is frontmatter + code only: skipped entirely.
        let first = user_message_line("---\ntitle: notes\n---\n```json\n{\"a\":1}\n```");
        let second = user_message_line("第二条才是真正内容");
        let content = format!("{}\n{}", first, second);
        assert_eq!(
            extract_session_preview(&content).as_deref(),
            Some("第二条才是真正内容")
        );
    }

    #[test]
    fn preview_url_only_message_shows_host_and_path() {
        let content =
            user_message_line("https://github.com/m1guelpf/pi-desktop/issues/42?tab=comments#n");
        assert_eq!(
            extract_session_preview(&content).as_deref(),
            Some("github.com/m1guelpf/pi-desktop/issues/42")
        );
        // Host-only URL drops the scheme and trailing slash.
        let content = user_message_line("https://example.com/");
        assert_eq!(
            extract_session_preview(&content).as_deref(),
            Some("example.com")
        );
        // A long URL-only message still truncates at PREVIEW_MAX_CHARS.
        let long = format!("https://example.com/{}", "a".repeat(100));
        let content = user_message_line(&long);
        let preview = extract_session_preview(&content).unwrap();
        assert!(preview.starts_with("example.com/"));
        assert!(preview.ends_with('…'));
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS + 1);
        // Text around a URL keeps the message verbatim.
        let content = user_message_line("看看这个 https://example.com/x 有没有用");
        assert_eq!(
            extract_session_preview(&content).as_deref(),
            Some("看看这个 https://example.com/x 有没有用")
        );
    }

    #[test]
    fn preview_keeps_plain_chinese_text() {
        let content = user_message_line("帮我梳理一下这个项目的架构");
        assert_eq!(
            extract_session_preview(&content).as_deref(),
            Some("帮我梳理一下这个项目的架构")
        );
    }

    #[test]
    fn preview_skips_all_tag_messages_and_falls_back_to_none() {
        // An all-tags first message is skipped in favor of the next real one.
        let tagged = user_message_line("<skill name=\"a\">only generated body</skill>");
        let real = user_message_line("真实需求");
        let content = format!("{}\n{}", tagged, real);
        assert_eq!(
            extract_session_preview(&content).as_deref(),
            Some("真实需求")
        );
        // Every user message pure tags/comments → no preview at all
        // (前端据此显示「未命名会话」而不是垃圾串).
        let content = format!(
            "{}\n{}",
            user_message_line("<skill name=\"a\">x</skill>"),
            user_message_line("<system>y</system> <!-- done -->")
        );
        assert_eq!(extract_session_preview(&content), None);
    }

    // -----------------------------------------------------------------------
    // Session history paging (get_session_page)
    // -----------------------------------------------------------------------

    fn paged_message_line(id: &str, role: &str, text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"{}\",\"parentId\":null,\"timestamp\":\"2026-07-25T10:00:01Z\",\"message\":{{\"role\":\"{}\",\"content\":[{{\"type\":\"text\",\"text\":{}}}],\"timestamp\":123}}}}",
            id,
            role,
            serde_json::to_string(text).unwrap()
        )
    }

    fn write_lines(path: &Path, lines: &[String]) {
        fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
    }

    fn page_entry_ids(page: &SessionPage) -> Vec<String> {
        page.entries
            .iter()
            .filter_map(|entry| entry.get("id").and_then(|id| id.as_str()))
            .map(|id| id.to_string())
            .collect()
    }

    #[test]
    fn session_page_returns_tail_entries_in_order() {
        let root = temp_sessions_dir("page_tail");
        let path = root.join("s.jsonl");
        let mut lines = vec![
            session_header("/Users/demo/x", "2026-07-25T10:00:00Z"),
            "{\"type\":\"model_change\",\"id\":\"mc1\",\"parentId\":null,\"timestamp\":\"2026-07-25T10:00:00Z\",\"provider\":\"p\",\"modelId\":\"m\"}".to_string(),
        ];
        for i in 0..10 {
            lines.push(paged_message_line(
                &format!("m{}", i),
                "user",
                &format!("msg {}", i),
            ));
        }
        write_lines(&path, &lines);

        let page = load_session_page(path.to_str().unwrap(), None, Some(4)).unwrap();
        assert_eq!(page_entry_ids(&page), vec!["m6", "m7", "m8", "m9"]);
        assert!(page.has_more);
        assert_eq!(page.oldest_entry_id.as_deref(), Some("m6"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_page_has_more_false_when_within_limit() {
        let root = temp_sessions_dir("page_small");
        let path = root.join("s.jsonl");
        let lines = vec![
            session_header("/Users/demo/x", "2026-07-25T10:00:00Z"),
            paged_message_line("m0", "user", "a"),
            paged_message_line("m1", "assistant", "b"),
        ];
        write_lines(&path, &lines);

        // Default limit applies when limit is None; small sessions load whole.
        let page = load_session_page(path.to_str().unwrap(), None, None).unwrap();
        assert_eq!(page_entry_ids(&page), vec!["m0", "m1"]);
        assert!(!page.has_more);
        assert_eq!(page.oldest_entry_id.as_deref(), Some("m0"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_page_before_entry_id_pages_back() {
        let root = temp_sessions_dir("page_before");
        let path = root.join("s.jsonl");
        let mut lines = vec![session_header("/Users/demo/x", "2026-07-25T10:00:00Z")];
        for i in 0..10 {
            lines.push(paged_message_line(
                &format!("m{}", i),
                "user",
                &format!("msg {}", i),
            ));
        }
        write_lines(&path, &lines);

        // Everything strictly before m7, capped at 4 entries.
        let page = load_session_page(path.to_str().unwrap(), Some("m7"), Some(4)).unwrap();
        assert_eq!(page_entry_ids(&page), vec!["m3", "m4", "m5", "m6"]);
        assert!(page.has_more);
        assert_eq!(page.oldest_entry_id.as_deref(), Some("m3"));

        // Walking further back reaches the top with has_more = false.
        let first = load_session_page(path.to_str().unwrap(), Some("m3"), Some(4)).unwrap();
        assert_eq!(page_entry_ids(&first), vec!["m0", "m1", "m2"]);
        assert!(!first.has_more);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_page_skips_bad_lines_and_unknown_types() {
        let root = temp_sessions_dir("page_bad_lines");
        let path = root.join("s.jsonl");
        let lines = vec![
            session_header("/Users/demo/x", "2026-07-25T10:00:00Z"),
            "this is not json".to_string(),
            "{\"type\":\"message\"".to_string(),
            "{\"type\":\"thinking_level_change\",\"id\":\"t1\",\"parentId\":null,\"timestamp\":\"x\",\"thinkingLevel\":\"max\"}".to_string(),
            paged_message_line("m0", "user", "ok"),
            "{\"foo\":1}".to_string(),
            paged_message_line("m1", "assistant", "ok2"),
        ];
        write_lines(&path, &lines);

        let page = load_session_page(path.to_str().unwrap(), None, None).unwrap();
        assert_eq!(page_entry_ids(&page), vec!["m0", "m1"]);
        assert!(!page.has_more);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_page_truncates_large_text_but_not_image_data() {
        let root = temp_sessions_dir("page_truncate");
        let path = root.join("s.jsonl");
        let big_text = "x".repeat(120 * 1024);
        let big_image = "a".repeat(120 * 1024);
        let lines = vec![
            paged_message_line("m0", "toolResult", &big_text),
            format!(
                "{{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"2026-07-25T10:00:02Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"image\",\"data\":\"{}\"}}],\"timestamp\":123}}}}",
                big_image
            ),
        ];
        write_lines(&path, &lines);

        let page = load_session_page(path.to_str().unwrap(), None, None).unwrap();
        assert_eq!(page.entries.len(), 2);

        let truncated_text = page.entries[0]
            .pointer("/message/content/0/text")
            .and_then(|v| v.as_str())
            .unwrap();
        assert!(truncated_text.len() < 60 * 1024);
        assert!(truncated_text.contains("[PI_DESKTOP_TRUNCATED:70KB]"));
        assert_eq!(
            page.entries[0].get("truncated").and_then(|v| v.as_bool()),
            Some(true)
        );

        // Image payloads stay intact and are not flagged.
        let image_data = page.entries[1]
            .pointer("/message/content/0/data")
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(image_data.len(), 120 * 1024);
        assert_eq!(page.entries[1].get("truncated"), None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_page_limit_one_keeps_only_newest() {
        let root = temp_sessions_dir("page_limit_one");
        let path = root.join("s.jsonl");
        let mut lines = vec![session_header("/Users/demo/x", "2026-07-25T10:00:00Z")];
        for i in 0..50 {
            lines.push(paged_message_line(&format!("m{}", i), "user", "x"));
        }
        write_lines(&path, &lines);

        let page = load_session_page(path.to_str().unwrap(), None, Some(1)).unwrap();
        assert_eq!(page_entry_ids(&page), vec!["m49"]);
        assert!(page.has_more);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_page_missing_file_errors() {
        let missing = std::env::temp_dir().join(format!(
            "pi_session_page_missing_{}.jsonl",
            std::process::id()
        ));
        assert!(load_session_page(missing.to_str().unwrap(), None, None).is_err());
    }

    fn todo_result_line(id: &str, todos_json: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"{}\",\"parentId\":null,\"timestamp\":\"2026-07-25T10:00:01Z\",\"message\":{{\"role\":\"toolResult\",\"toolName\":\"todo\",\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}],\"details\":{{\"action\":\"add\",\"todos\":{},\"nextId\":9}}}}}}",
            id, todos_json
        )
    }

    /// 回归：todo 清单必须能从长会话恢复。
    ///
    /// 尾页只有 40 条，而清单面板需要全量状态。若只靠 entries 里找 todo，
    /// 最后一次调用被后续 entry 挤出后面板就空了。
    #[test]
    fn session_page_keeps_todo_snapshot_beyond_tail_window() {
        let root = temp_sessions_dir("page_todo_snapshot");
        let path = root.join("s.jsonl");
        let mut lines = vec![session_header("/Users/demo/x", "2026-07-25T10:00:00Z")];
        // todo 调用在很前面
        lines.push(todo_result_line(
            "todo1",
            "[{\"id\":1,\"text\":\"alpha\",\"done\":true},{\"id\":2,\"text\":\"beta\",\"done\":false}]",
        ));
        // 后面推 60 条，远超默认 40 条尾页窗口
        for i in 0..60 {
            lines.push(paged_message_line(&format!("m{}", i), "user", "x"));
        }
        write_lines(&path, &lines);

        let page = load_session_page(path.to_str().unwrap(), None, None).unwrap();
        // todo entry 确实已不在尾页里
        assert!(!page_entry_ids(&page).contains(&"todo1".to_string()));
        // 但快照必须带出来
        let details = page
            .latest_todo_details
            .as_ref()
            .expect("快照必须存在，否则长会话无法恢复清单");
        let todos = details.get("todos").and_then(|v| v.as_array()).unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].get("text").and_then(|v| v.as_str()), Some("alpha"));
        assert_eq!(todos[0].get("done").and_then(|v| v.as_bool()), Some(true));

        let _ = fs::remove_dir_all(&root);
    }

    /// 多次 todo 调用时只保留最后一个（清单是全量快照，不是增量）。
    #[test]
    fn session_page_todo_snapshot_takes_the_last_one() {
        let root = temp_sessions_dir("page_todo_last");
        let path = root.join("s.jsonl");
        let lines = vec![
            session_header("/Users/demo/x", "2026-07-25T10:00:00Z"),
            todo_result_line("t1", "[{\"id\":1,\"text\":\"old\",\"done\":false}]"),
            todo_result_line("t2", "[{\"id\":1,\"text\":\"new\",\"done\":true}]"),
        ];
        write_lines(&path, &lines);

        let page = load_session_page(path.to_str().unwrap(), None, None).unwrap();
        let todos = page
            .latest_todo_details
            .as_ref()
            .unwrap()
            .get("todos")
            .and_then(|v| v.as_array())
            .unwrap();
        assert_eq!(todos[0].get("text").and_then(|v| v.as_str()), Some("new"));

        let _ = fs::remove_dir_all(&root);
    }

    /// 没有 todo 记录时快照为 None，不能凭空造一个。
    #[test]
    fn session_page_todo_snapshot_absent_without_todo_calls() {
        let root = temp_sessions_dir("page_todo_none");
        let path = root.join("s.jsonl");
        let lines = vec![
            session_header("/Users/demo/x", "2026-07-25T10:00:00Z"),
            paged_message_line("m0", "user", "hi"),
        ];
        write_lines(&path, &lines);

        let page = load_session_page(path.to_str().unwrap(), None, None).unwrap();
        assert!(page.latest_todo_details.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_page_large_file_stays_fast() {
        let root = temp_sessions_dir("page_perf");
        let path = root.join("big.jsonl");
        let mut lines = vec![session_header("/Users/demo/x", "2026-07-25T10:00:00Z")];
        // 5000 message lines, ~4KB each => ~20MB, mirroring a heavy session.
        let filler = "y".repeat(4 * 1024);
        for i in 0..5000 {
            lines.push(paged_message_line(
                &format!("m{}", i),
                "toolResult",
                &filler,
            ));
        }
        write_lines(&path, &lines);
        let size_mb = fs::metadata(&path).unwrap().len() as f64 / 1024.0 / 1024.0;

        let started = Instant::now();
        let page = load_session_page(path.to_str().unwrap(), None, None).unwrap();
        let elapsed = started.elapsed();
        eprintln!(
            "session_page_large_file_stays_fast: {:.1}MB scanned in {:?}",
            size_mb, elapsed
        );
        assert_eq!(page.entries.len(), SESSION_PAGE_DEFAULT_LIMIT);
        assert!(page.has_more);
        assert!(size_mb > 15.0);
        assert!(
            elapsed < Duration::from_millis(300),
            "tail page of a {:.1}MB session took {:?}",
            size_mb,
            elapsed
        );

        let _ = fs::remove_dir_all(&root);
    }

    // ------------------------------------------------------------------
    // SECURITY-03: SSRF 地址判定与 URL 校验
    // ------------------------------------------------------------------

    fn v4(a: u8, b: u8, c: u8, d: u8) -> std::net::IpAddr {
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(a, b, c, d))
    }

    fn v6(s: &str) -> std::net::IpAddr {
        s.parse::<std::net::IpAddr>().unwrap()
    }

    #[test]
    fn ssrf_recognizes_only_proxy_fake_ip_range() {
        assert!(is_proxy_fake_ip(&v4(198, 18, 0, 0)));
        assert!(is_proxy_fake_ip(&v4(198, 19, 255, 255)));
        assert!(!is_proxy_fake_ip(&v4(198, 17, 255, 255)));
        assert!(!is_proxy_fake_ip(&v4(198, 20, 0, 0)));
        assert!(!is_proxy_fake_ip(&v4(192, 168, 1, 1)));
        assert!(!is_proxy_fake_ip(&v6("::ffff:198.18.0.1")));
    }

    #[test]
    fn ssrf_parses_only_address_records_from_doh() {
        let body = r#"{
          "Status": 0,
          "Answer": [
            {"type": 5, "data": "alias.example.com."},
            {"type": 1, "data": "104.21.66.179"},
            {"type": 28, "data": "2606:4700:3037::ac43:a2f8"},
            {"type": 1, "data": "104.21.66.179"},
            {"type": 16, "data": "not-an-ip"}
          ]
        }"#;
        assert_eq!(
            parse_doh_ips(body).unwrap(),
            vec![v4(104, 21, 66, 179), v6("2606:4700:3037::ac43:a2f8")]
        );
        assert!(parse_doh_ips(r#"{"Status":3}"#).is_err());
        assert!(parse_doh_ips(r#"{"Answer":[]}"#).is_err());
    }

    #[test]
    fn ssrf_blocks_private_loopback_linklocal_reserved_ipv4() {
        // 私网
        assert!(is_blocked_ip(&v4(10, 0, 0, 1)));
        assert!(is_blocked_ip(&v4(10, 255, 255, 255)));
        assert!(is_blocked_ip(&v4(172, 16, 0, 1)));
        assert!(is_blocked_ip(&v4(172, 31, 255, 255)));
        assert!(is_blocked_ip(&v4(192, 168, 0, 1)));
        assert!(is_blocked_ip(&v4(192, 168, 255, 255)));
        // 环回 / 链路本地 / this-network / CGNAT
        assert!(is_blocked_ip(&v4(127, 0, 0, 1)));
        assert!(is_blocked_ip(&v4(127, 255, 0, 9)));
        assert!(is_blocked_ip(&v4(169, 254, 169, 254))); // 云元数据
        assert!(is_blocked_ip(&v4(0, 0, 0, 0)));
        assert!(is_blocked_ip(&v4(0, 1, 2, 3)));
        assert!(is_blocked_ip(&v4(100, 64, 0, 1)));
        assert!(is_blocked_ip(&v4(100, 127, 255, 255)));
        // 文档/基准/组播/保留/广播
        assert!(is_blocked_ip(&v4(192, 0, 2, 1)));
        assert!(is_blocked_ip(&v4(198, 18, 0, 1)));
        assert!(is_blocked_ip(&v4(198, 19, 255, 1)));
        assert!(is_blocked_ip(&v4(198, 51, 100, 1)));
        assert!(is_blocked_ip(&v4(203, 0, 113, 1)));
        assert!(is_blocked_ip(&v4(224, 0, 0, 1)));
        assert!(is_blocked_ip(&v4(240, 0, 0, 1)));
        assert!(is_blocked_ip(&v4(255, 255, 255, 255)));
    }

    #[test]
    fn ssrf_allows_public_ipv4_boundaries() {
        // 私网网段的边界外侧是公网
        assert!(!is_blocked_ip(&v4(9, 255, 255, 255)));
        assert!(!is_blocked_ip(&v4(11, 0, 0, 0)));
        assert!(!is_blocked_ip(&v4(172, 15, 255, 255)));
        assert!(!is_blocked_ip(&v4(172, 32, 0, 0)));
        assert!(!is_blocked_ip(&v4(192, 167, 255, 255)));
        assert!(!is_blocked_ip(&v4(192, 169, 0, 0)));
        assert!(!is_blocked_ip(&v4(100, 63, 255, 255)));
        assert!(!is_blocked_ip(&v4(100, 128, 0, 0)));
        assert!(!is_blocked_ip(&v4(223, 255, 255, 255)));
        assert!(!is_blocked_ip(&v4(1, 1, 1, 1)));
        assert!(!is_blocked_ip(&v4(8, 8, 8, 8)));
    }

    #[test]
    fn ssrf_blocks_loopback_ula_linklocal_ipv6() {
        assert!(is_blocked_ip(&v6("::1"))); // 环回
        assert!(is_blocked_ip(&v6("::"))); // 未指定
        assert!(is_blocked_ip(&v6("fc00::1"))); // ULA
        assert!(is_blocked_ip(&v6("fd00::1"))); // ULA
        assert!(is_blocked_ip(&v6("fdff:ffff::1"))); // ULA 上界附近
        assert!(is_blocked_ip(&v6("fe80::1"))); // 链路本地
        assert!(is_blocked_ip(&v6("febf::1"))); // fe80::/10 上界
        assert!(is_blocked_ip(&v6("ff02::1"))); // 组播
        assert!(is_blocked_ip(&v6("2001:db8::1"))); // 文档保留
                                                    // IPv4-mapped / compatible 逃逸写法
        assert!(is_blocked_ip(&v6("::ffff:127.0.0.1")));
        assert!(is_blocked_ip(&v6("::ffff:10.0.0.1")));
        assert!(is_blocked_ip(&v6("::ffff:169.254.169.254")));
        assert!(is_blocked_ip(&v6("::127.0.0.1")));
        assert!(!is_blocked_ip(&v6("::ffff:8.8.8.8"))); // mapped 公网放行
        assert!(!is_blocked_ip(&v6("2606:4700:4700::1111")));
    }

    #[test]
    fn ssrf_rejects_non_http_schemes_and_malformed_urls() {
        for bad in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "gopher://127.0.0.1/",
            "http://",
            "http:// ",
            "",
            "   ",
            "not-a-url",
            "http://example .com/",
            "http://example.com:99999/",
            "http://example.com:abc/",
        ] {
            assert!(
                validate_fetch_url(bad).is_err(),
                "{} should be rejected",
                bad
            );
        }
    }

    #[test]
    fn ssrf_rejects_internal_literal_ips() {
        for bad in [
            "http://127.0.0.1/",
            "http://127.0.0.1:8080/admin",
            "https://10.0.0.5/",
            "http://172.16.3.4/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[fc00::1]/",
            "http://[fe80::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://user:pass@127.0.0.1/", // userinfo 后面的才是真主机
        ] {
            assert!(
                validate_fetch_url(bad).is_err(),
                "{} should be rejected",
                bad
            );
        }
    }

    #[test]
    fn ssrf_rejects_localhost_and_numeric_ip_tricks() {
        // localhost 走系统解析（/etc/hosts），结果是 127.0.0.1
        assert!(validate_fetch_url("http://localhost/").is_err());
        assert!(validate_fetch_url("http://localhost:3000/").is_err());
        // 十进制/短形式 IPv4：Rust 不解析为 IP，但系统解析器认得；
        // 无论解析成 127.0.0.1 被拦，还是解析失败，都必须报错
        assert!(validate_fetch_url("http://2130706433/").is_err());
        assert!(validate_fetch_url("http://127.1/").is_err());
        assert!(validate_fetch_url("http://0x7f000001/").is_err());
    }

    #[test]
    fn ssrf_accepts_public_urls() {
        let v = validate_fetch_url("http://1.1.1.1/").unwrap();
        assert_eq!(v.scheme, "http");
        assert_eq!(v.host, "1.1.1.1");
        assert_eq!(v.port, 80);
        assert!(v.pinned_ip.is_none(), "IP 字面量无需 --connect-to 固定");

        let v = validate_fetch_url("https://8.8.8.8:8443/path?q=1").unwrap();
        assert_eq!(v.port, 8443);

        let v = validate_fetch_url("https://[2606:4700:4700::1111]/").unwrap();
        assert_eq!(v.scheme, "https");
        assert_eq!(v.host, "2606:4700:4700::1111");
        assert_eq!(v.port, 443);

        // userinfo 不影响主机提取
        let v = validate_fetch_url("https://user:pass@1.1.1.1/x").unwrap();
        assert_eq!(v.host, "1.1.1.1");
    }

    #[test]
    fn ssrf_parses_host_port_forms() {
        assert_eq!(
            parse_host_port("example.com").unwrap(),
            ("example.com".to_string(), None)
        );
        assert_eq!(
            parse_host_port("example.com:8080").unwrap(),
            ("example.com".to_string(), Some(8080))
        );
        assert_eq!(parse_host_port("[::1]").unwrap(), ("::1".to_string(), None));
        assert_eq!(
            parse_host_port("[2001:db8::1]:443").unwrap(),
            ("2001:db8::1".to_string(), Some(443))
        );
        assert!(parse_host_port("example.com:notaport").is_err());
        assert!(parse_host_port("[]").is_err());
    }

    #[test]
    fn ssrf_redirect_resolution_only_absolute_or_scheme_relative() {
        let v = validate_fetch_url("https://1.1.1.1/").unwrap();
        assert_eq!(
            resolve_redirect_url(&v, "http://1.1.1.1/next"),
            Some("http://1.1.1.1/next".to_string())
        );
        assert_eq!(
            resolve_redirect_url(&v, "//1.1.1.1/next"),
            Some("https://1.1.1.1/next".to_string())
        );
        assert_eq!(resolve_redirect_url(&v, "/relative/path"), None);
        assert_eq!(resolve_redirect_url(&v, "relative"), None);
    }

    // ------------------------------------------------------------------
    // resolve_secret_ref
    // ------------------------------------------------------------------

    #[test]
    fn secret_ref_literal_passthrough_verbatim() {
        assert_eq!(
            resolve_secret_ref_impl("sk-ant-api03-xyz").unwrap(),
            "sk-ant-api03-xyz"
        );
        // 原样返回：不 trim
        assert_eq!(
            resolve_secret_ref_impl("  spaced secret  ").unwrap(),
            "  spaced secret  "
        );
        assert_eq!(resolve_secret_ref_impl("").unwrap(), "");
    }

    #[test]
    fn secret_ref_env_var_resolution() {
        let var = format!("PI_TEST_SECRET_{}", std::process::id());
        std::env::set_var(&var, "env-secret-value");
        assert_eq!(
            resolve_secret_ref_impl(&format!("${}", var)).unwrap(),
            "env-secret-value"
        );
        // ${VAR} 写法同样支持
        assert_eq!(
            resolve_secret_ref_impl(&format!("${{{}}}", var)).unwrap(),
            "env-secret-value"
        );
        std::env::remove_var(&var);

        let missing = format!("$PI_TEST_DEFINITELY_MISSING_{}", std::process::id());
        let err = resolve_secret_ref_impl(&missing).unwrap_err();
        assert!(err.contains("未设置"), "got: {}", err);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn secret_ref_command_resolution() {
        assert_eq!(
            resolve_secret_ref_impl("!echo hello-secret").unwrap(),
            "hello-secret"
        );
        // 只取 stdout 首行
        assert_eq!(
            resolve_secret_ref_impl("!printf 'first\\nsecond\\n'").unwrap(),
            "first"
        );
        // 非零退出报错
        assert!(resolve_secret_ref_impl("!exit 3").is_err());
        // 无输出报错
        assert!(resolve_secret_ref_impl("!true").is_err());
        // 空命令报错
        assert!(resolve_secret_ref_impl("!").is_err());
        assert!(resolve_secret_ref_impl("!   ").is_err());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn secret_ref_command_times_out() {
        let err = run_secret_command("sleep 30", Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("超时"), "got: {}", err);
    }

    // ------------------------------------------------------------------
    // SESSION-01: 租约命令解析 + 两阶段提交
    // ------------------------------------------------------------------

    fn lease_test_root(tag: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "pi_lease_2pc_test_{}_{}_{}",
            tag,
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_session(root: &Path, name: &str) -> String {
        let path = root.join(name);
        fs::write(&path, "{}\n").unwrap();
        path.to_string_lossy().to_string()
    }

    fn hold_committed_lease(state: &RpcState, instance: &str, root: &Path, session: &str) {
        let lease = session_lease::SessionLease::acquire(root, session).unwrap();
        state
            .leases
            .lock()
            .unwrap()
            .insert(instance.to_string(), lease);
    }

    fn pending_switch(root: &Path, request_id: &str, session: &str) -> PendingSessionLease {
        PendingSessionLease {
            request_id: request_id.to_string(),
            generation: 1,
            transition: LeaseTransition::Replace(
                session_lease::SessionLease::acquire(root, session).unwrap(),
            ),
            acquire_path_from_response: false,
        }
    }

    fn pending_new(request_id: &str) -> PendingSessionLease {
        PendingSessionLease {
            request_id: request_id.to_string(),
            generation: 1,
            transition: LeaseTransition::Release,
            acquire_path_from_response: true,
        }
    }

    fn insert_pending(state: &RpcState, instance: &str, pending: PendingSessionLease) {
        state
            .pending_leases
            .lock()
            .unwrap()
            .insert(instance.to_string(), pending);
    }

    fn current_lease_path(state: &RpcState, instance: &str) -> Option<String> {
        state
            .leases
            .lock()
            .unwrap()
            .get(instance)
            .map(|l| l.normalized_path().to_string())
    }

    fn normalized(session: &str) -> String {
        session_lease::normalize_session_path(session).unwrap()
    }

    fn lock_dir_count(root: &Path) -> usize {
        fs::read_dir(root)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".gui-lock")
            })
            .count()
    }

    #[test]
    fn parse_lease_command_requires_id_and_path() {
        // switch_session：id + 有效路径才进租约流程
        assert_eq!(
            parse_lease_command(
                r#"{"type":"switch_session","sessionPath":"/tmp/a.jsonl","id":"req_1"}"#
            ),
            Some((
                "req_1".to_string(),
                LeaseCommandKind::Switch("/tmp/a.jsonl".to_string())
            ))
        );
        // 无 id / 空 id：无法关联响应，不进租约流程
        assert_eq!(
            parse_lease_command(r#"{"type":"switch_session","sessionPath":"/tmp/a.jsonl"}"#),
            None
        );
        assert_eq!(
            parse_lease_command(
                r#"{"type":"switch_session","sessionPath":"/tmp/a.jsonl","id":"  "}"#
            ),
            None
        );
        // 无路径 / 空白路径 / null：不进租约流程
        assert_eq!(
            parse_lease_command(r#"{"type":"switch_session","id":"req_1"}"#),
            None
        );
        assert_eq!(
            parse_lease_command(r#"{"type":"switch_session","sessionPath":"  ","id":"req_1"}"#),
            None
        );
        assert_eq!(
            parse_lease_command(r#"{"type":"switch_session","sessionPath":null,"id":"req_1"}"#),
            None
        );
        // new_session：带 id 即进租约流程
        assert_eq!(
            parse_lease_command(r#"{"type":"new_session","id":"req_2"}"#),
            Some(("req_2".to_string(), LeaseCommandKind::New))
        );
        assert_eq!(parse_lease_command(r#"{"type":"new_session"}"#), None);
        // 其他命令不触发
        assert_eq!(
            parse_lease_command(r#"{"type":"prompt","message":"hi","id":"req_3"}"#),
            None
        );
        assert_eq!(parse_lease_command("not json at all"), None);
        // 关键字出现在 payload 里但 type 不是租约命令
        assert_eq!(
            parse_lease_command(
                r#"{"type":"prompt","message":"switch_session please","id":"req_4"}"#
            ),
            None
        );
    }

    #[test]
    fn parse_lease_response_classifies_outcome() {
        // 成功响应
        assert_eq!(
            parse_lease_response(
                r#"{"type":"response","id":"req_1","command":"switch_session","success":true,"data":{"cancelled":false}}"#
            ),
            Some(("req_1".to_string(), true, None))
        );
        // error 响应 = 未确认
        assert_eq!(
            parse_lease_response(
                r#"{"type":"response","id":"req_1","command":"switch_session","success":false,"error":"boom"}"#
            ),
            Some(("req_1".to_string(), false, None))
        );
        // success 但 cancelled = 未确认
        assert_eq!(
            parse_lease_response(
                r#"{"type":"response","id":"req_1","command":"switch_session","success":true,"data":{"cancelled":true}}"#
            ),
            Some(("req_1".to_string(), false, None))
        );
        // 响应 data 携带会话路径（new_session 占锁用）
        assert_eq!(
            parse_lease_response(
                r#"{"type":"response","id":"req_2","command":"new_session","success":true,"data":{"cancelled":false,"sessionFile":"/tmp/n.jsonl"}}"#
            ),
            Some(("req_2".to_string(), true, Some("/tmp/n.jsonl".to_string())))
        );
        // 事件行 / 无 id 响应 / 非 JSON / 不含 response 关键字：都不是租约响应
        assert_eq!(
            parse_lease_response(r#"{"type":"agent_event","data":{}}"#),
            None
        );
        assert_eq!(
            parse_lease_response(r#"{"type":"response","command":"parse","success":false}"#),
            None
        );
        assert_eq!(parse_lease_response("not json"), None);
        assert_eq!(
            parse_lease_response(r#"{"type":"message","text":"hi"}"#),
            None
        );
    }

    #[test]
    fn two_phase_commit_on_success_response() {
        let root = lease_test_root("commit");
        let old = test_session(&root, "old.jsonl");
        let new = test_session(&root, "new.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        insert_pending(&state, "default", pending_switch(&root, "req_1", &new));

        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_1","command":"switch_session","success":true,"data":{"cancelled":false}}"#,
        );

        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&new)),
            "成功响应后租约提交到新会话"
        );
        assert!(state.pending_leases.lock().unwrap().is_empty());
        assert_eq!(lock_dir_count(&root), 1, "旧租约已释放，只剩新锁目录");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_phase_rollback_on_error_response() {
        let root = lease_test_root("err");
        let old = test_session(&root, "old.jsonl");
        let new = test_session(&root, "new.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        insert_pending(&state, "default", pending_switch(&root, "req_1", &new));

        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_1","command":"switch_session","success":false,"error":"boom"}"#,
        );

        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old)),
            "error 响应：旧租约不动"
        );
        assert!(state.pending_leases.lock().unwrap().is_empty());
        assert_eq!(lock_dir_count(&root), 1, "未提交的新租约已回滚");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_phase_rollback_on_cancelled_response() {
        let root = lease_test_root("cancel");
        let old = test_session(&root, "old.jsonl");
        let new = test_session(&root, "new.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        insert_pending(&state, "default", pending_switch(&root, "req_1", &new));

        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_1","command":"switch_session","success":true,"data":{"cancelled":true}}"#,
        );

        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old))
        );
        assert_eq!(lock_dir_count(&root), 1, "cancelled 按失败回滚");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_phase_timeout_rolls_back() {
        let root = lease_test_root("timeout");
        let old = test_session(&root, "old.jsonl");
        let new = test_session(&root, "new.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        insert_pending(&state, "default", pending_switch(&root, "req_7", &new));

        spawn_pending_lease_timeout(
            Arc::clone(&state.pending_leases),
            "default".to_string(),
            "req_7".to_string(),
            1,
            Duration::from_millis(50),
        );
        std::thread::sleep(Duration::from_millis(300));

        assert!(state.pending_leases.lock().unwrap().is_empty());
        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old)),
            "超时回滚：旧租约不动"
        );
        assert_eq!(lock_dir_count(&root), 1, "超时回滚：新租约已释放");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn old_generation_timeout_does_not_touch_new_pending() {
        let root = lease_test_root("timeout_guard");
        let new = test_session(&root, "new.jsonl");
        let state = RpcState::default();
        let mut pending = pending_switch(&root, "reused_id", &new);
        pending.generation = 2;
        insert_pending(&state, "default", pending);

        spawn_pending_lease_timeout(
            Arc::clone(&state.pending_leases),
            "default".to_string(),
            "reused_id".to_string(),
            1, // 旧进程 generation 的定时器
            Duration::from_millis(50),
        );
        std::thread::sleep(Duration::from_millis(300));

        assert_eq!(
            state
                .pending_leases
                .lock()
                .unwrap()
                .get("default")
                .map(|p| p.request_id.clone()),
            Some("reused_id".to_string()),
            "request id 即使复用，generation 不匹配时也不得回滚"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn consecutive_switch_is_serialized_without_losing_intermediate_lease() {
        let root = lease_test_root("consecutive");
        let old = test_session(&root, "old.jsonl");
        let b = test_session(&root, "b.jsonl");
        let c = test_session(&root, "c.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);

        register_pending_lease(&state, "default", pending_switch(&root, "req_1", &b)).unwrap();
        let second = register_pending_lease(&state, "default", pending_switch(&root, "req_2", &c));

        assert!(
            second.unwrap_err().contains("正在处理中"),
            "A→B 未裁决时，B→C 必须明确拒绝且不能覆盖前请求"
        );
        assert_eq!(
            state
                .pending_leases
                .lock()
                .unwrap()
                .get("default")
                .map(|p| p.request_id.clone()),
            Some("req_1".to_string())
        );
        assert_eq!(lock_dir_count(&root), 2, "旧租约 + B 的未决租约；C 已回滚");
        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_1","command":"switch_session","success":true,"data":{"cancelled":false}}"#,
        );
        assert_eq!(current_lease_path(&state, "default"), Some(normalized(&b)));
        assert_eq!(lock_dir_count(&root), 1, "成功后只保留真实会话 B 的锁");

        register_pending_lease(&state, "default", pending_switch(&root, "req_3", &c)).unwrap();
        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_3","command":"switch_session","success":true,"data":{"cancelled":false}}"#,
        );
        assert_eq!(current_lease_path(&state, "default"), Some(normalized(&c)));
        assert_eq!(lock_dir_count(&root), 1, "B 完成后重试 C，最终只持有 C");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn second_switch_can_start_after_first_fails() {
        let root = lease_test_root("second_after_failure");
        let old = test_session(&root, "old.jsonl");
        let b = test_session(&root, "b.jsonl");
        let c = test_session(&root, "c.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);

        register_pending_lease(&state, "default", pending_switch(&root, "req_1", &b)).unwrap();
        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_1","command":"switch_session","success":false,"error":"boom"}"#,
        );
        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old))
        );

        register_pending_lease(&state, "default", pending_switch(&root, "req_2", &c)).unwrap();
        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_2","command":"switch_session","success":true,"data":{"cancelled":false}}"#,
        );
        assert_eq!(current_lease_path(&state, "default"), Some(normalized(&c)));
        assert_eq!(lock_dir_count(&root), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn second_switch_failure_keeps_intermediate_lease() {
        let root = lease_test_root("second_failure");
        let old = test_session(&root, "old.jsonl");
        let b = test_session(&root, "b.jsonl");
        let c = test_session(&root, "c.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);

        register_pending_lease(&state, "default", pending_switch(&root, "req_1", &b)).unwrap();
        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_1","command":"switch_session","success":true,"data":{"cancelled":false}}"#,
        );
        register_pending_lease(&state, "default", pending_switch(&root, "req_2", &c)).unwrap();
        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_2","command":"switch_session","success":false,"error":"boom"}"#,
        );

        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&b)),
            "A→B 成功后 B→C 失败，必须继续持有实际会话 B"
        );
        assert_eq!(lock_dir_count(&root), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_lease_messages_do_not_disturb_pending() {
        let root = lease_test_root("nonlease");
        let old = test_session(&root, "old.jsonl");
        let new = test_session(&root, "new.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        insert_pending(&state, "default", pending_switch(&root, "req_1", &new));

        for line in [
            // 其他请求的响应（id 不匹配）
            r#"{"type":"response","id":"req_99","command":"get_state","success":true,"data":{}}"#,
            // prompt 等普通命令的响应
            r#"{"type":"response","id":"req_98","command":"prompt","success":true}"#,
            // 事件行
            r#"{"type":"agent_event","data":{"type":"message_update"}}"#,
            // 无 id 的 error 响应（pi handler 抛错时的形态）
            r#"{"type":"response","command":"parse","success":false,"error":"x"}"#,
            // 非 JSON 行
            "not json at all",
        ] {
            resolve_pending_lease_from_line(Some(&root), &state, "default", 1, line);
        }

        assert_eq!(
            state
                .pending_leases
                .lock()
                .unwrap()
                .get("default")
                .map(|p| p.request_id.clone()),
            Some("req_1".to_string()),
            "非租约消息不得裁决 pending"
        );
        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old))
        );
        assert_eq!(lock_dir_count(&root), 2, "旧租约与未决新租约都在");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn new_session_commit_without_path_keeps_old_lease_until_claim() {
        let root = lease_test_root("new_nopath");
        let old = test_session(&root, "old.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        insert_pending(&state, "default", pending_new("req_3"));

        // pi 当前版本的 new_session 响应不带路径：旧锁必须保留到 get_state claim
        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_3","command":"new_session","success":true,"data":{"cancelled":false}}"#,
        );

        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old))
        );
        assert_eq!(lock_dir_count(&root), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn generation_bound_claim_replaces_old_lease_and_is_idempotent() {
        let root = lease_test_root("claim");
        let old = test_session(&root, "old.jsonl");
        let created = test_session(&root, "created.jsonl");
        let state = RpcState::default();
        state.instances.lock().unwrap().insert(
            "default".to_string(),
            RpcProcessHandle {
                generation: 7,
                ..Default::default()
            },
        );
        hold_committed_lease(&state, "default", &root, &old);

        claim_session_lease_for_generation(&root, &state, "default", 7, &created).unwrap();
        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&created))
        );
        assert_eq!(lock_dir_count(&root), 1, "替换后只保留新会话租约");

        claim_session_lease_for_generation(&root, &state, "default", 7, &created).unwrap();
        assert_eq!(
            lock_dir_count(&root),
            1,
            "同 generation 同路径 claim 必须幂等"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_same_generation_same_path_claims_are_idempotent() {
        let root = lease_test_root("claim_concurrent");
        let old = test_session(&root, "old.jsonl");
        let created = test_session(&root, "created.jsonl");
        let state = Arc::new(RpcState::default());
        state.instances.lock().unwrap().insert(
            "default".to_string(),
            RpcProcessHandle {
                generation: 9,
                ..Default::default()
            },
        );
        hold_committed_lease(&state, "default", &root, &old);
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();

        for _ in 0..2 {
            let state = Arc::clone(&state);
            let barrier = Arc::clone(&barrier);
            let root = root.clone();
            let created = created.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                claim_session_lease_for_generation(&root, &state, "default", 9, &created)
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }

        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&created))
        );
        assert_eq!(lock_dir_count(&root), 1, "并发同路径 claim 只保留一把租约");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_generation_claim_cannot_replace_current_lease() {
        let root = lease_test_root("claim_stale");
        let old = test_session(&root, "old.jsonl");
        let created = test_session(&root, "created.jsonl");
        let state = RpcState::default();
        state.instances.lock().unwrap().insert(
            "default".to_string(),
            RpcProcessHandle {
                generation: 8,
                ..Default::default()
            },
        );
        hold_committed_lease(&state, "default", &root, &old);

        let err =
            claim_session_lease_for_generation(&root, &state, "default", 7, &created).unwrap_err();
        assert!(err.contains("generation 已变化"));
        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old))
        );
        assert_eq!(lock_dir_count(&root), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn new_session_commit_with_response_path_acquires_new_lease() {
        let root = lease_test_root("new_withpath");
        let old = test_session(&root, "old.jsonl");
        let created = test_session(&root, "created.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        insert_pending(&state, "default", pending_new("req_4"));

        let line = format!(
            r#"{{"type":"response","id":"req_4","command":"new_session","success":true,"data":{{"cancelled":false,"sessionFile":"{}"}}}}"#,
            created
        );
        resolve_pending_lease_from_line(Some(&root), &state, "default", 1, &line);

        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&created)),
            "按响应实际路径占锁"
        );
        assert_eq!(lock_dir_count(&root), 1, "旧锁已释放，只有新会话的锁");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn new_session_error_keeps_old_lease() {
        let root = lease_test_root("new_err");
        let old = test_session(&root, "old.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        insert_pending(&state, "default", pending_new("req_5"));

        resolve_pending_lease_from_line(
            Some(&root),
            &state,
            "default",
            1,
            r#"{"type":"response","id":"req_5","command":"new_session","success":false,"error":"boom"}"#,
        );

        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old))
        );
        assert_eq!(lock_dir_count(&root), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rollback_respects_generation() {
        let root = lease_test_root("gen");
        let new = test_session(&root, "new.jsonl");
        let state = RpcState::default();

        insert_pending(&state, "default", pending_switch(&root, "req_1", &new));
        // 其他 generation 的 EOF 回滚：不动
        rollback_pending_lease(&state, "default", Some(2));
        assert!(state.pending_leases.lock().unwrap().contains_key("default"));
        // 本 generation 的 EOF 回滚：移除
        rollback_pending_lease(&state, "default", Some(1));
        assert!(state.pending_leases.lock().unwrap().is_empty());

        // None（实例销毁路径）：无条件回滚
        insert_pending(&state, "default", pending_switch(&root, "req_2", &new));
        rollback_pending_lease(&state, "default", None);
        assert!(state.pending_leases.lock().unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn late_response_from_old_generation_cannot_commit_new_pending() {
        let root = lease_test_root("late_gen");
        let old = test_session(&root, "old.jsonl");
        let new = test_session(&root, "new.jsonl");
        let state = RpcState::default();
        hold_committed_lease(&state, "default", &root, &old);
        let mut pending = pending_switch(&root, "reused_id", &new);
        pending.generation = 2;
        insert_pending(&state, "default", pending);
        let line = r#"{"type":"response","id":"reused_id","command":"switch_session","success":true,"data":{"cancelled":false}}"#;

        resolve_pending_lease_from_line(Some(&root), &state, "default", 1, line);
        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&old)),
            "旧 reader 的迟到响应不能提交新 generation 的 pending"
        );
        assert!(state.pending_leases.lock().unwrap().contains_key("default"));

        resolve_pending_lease_from_line(Some(&root), &state, "default", 2, line);
        assert_eq!(
            current_lease_path(&state, "default"),
            Some(normalized(&new))
        );
        assert!(state.pending_leases.lock().unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    // ------------------------------------------------------------------
    // http_get 跨源重定向安全 header allowlist + UTF-8 截断
    // ------------------------------------------------------------------

    fn validated(url: &str) -> ValidatedFetchUrl {
        validate_fetch_url(url).unwrap()
    }

    #[test]
    fn origin_key_normalizes_default_port() {
        // 显式 :443 与不显式等价；http :80 同理
        assert_eq!(
            url_origin_key(&validated("https://1.1.1.1/")),
            url_origin_key(&validated("https://1.1.1.1:443/x"))
        );
        assert_eq!(
            url_origin_key(&validated("http://1.1.1.1/")),
            url_origin_key(&validated("http://1.1.1.1:80/"))
        );
        // 非默认端口 / 不同 scheme 是不同 origin
        assert_ne!(
            url_origin_key(&validated("https://1.1.1.1/")),
            url_origin_key(&validated("https://1.1.1.1:8443/"))
        );
        assert_ne!(
            url_origin_key(&validated("http://1.1.1.1/")),
            url_origin_key(&validated("https://1.1.1.1/"))
        );
    }

    #[test]
    fn origin_key_ignores_userinfo_case_and_trailing_dot() {
        // userinfo 不参与 origin
        assert_eq!(
            url_origin_key(&validated("https://user:pass@1.1.1.1/")),
            url_origin_key(&validated("https://1.1.1.1/"))
        );
        // host 大小写不敏感、尾部点归一（直接构造 host，绕过 DNS）
        let mut upper = validated("https://1.1.1.1/");
        upper.host = "Example.COM.".to_string();
        let mut lower = validated("https://1.1.1.1/");
        lower.host = "example.com".to_string();
        assert_eq!(url_origin_key(&upper), url_origin_key(&lower));
    }

    #[test]
    fn same_origin_redirect_keeps_all_headers() {
        let prev = url_origin_key(&validated("https://1.1.1.1/a"));
        let next = url_origin_key(&validated("https://1.1.1.1:443/b"));
        let headers = vec![
            ("Authorization".to_string(), "Bearer sk-1".to_string()),
            ("X-Api-Key".to_string(), "k".to_string()),
            ("X-Token".to_string(), "same-origin-secret".to_string()),
        ];
        let (out, cross_origin) = redirect_hop_headers(&prev, &next, &headers);
        assert!(!cross_origin, "同源重定向不标记跨源");
        assert_eq!(out, headers, "同源重定向保留全部 headers");
    }

    #[test]
    fn cross_origin_redirect_keeps_only_safe_allowlist() {
        let prev = url_origin_key(&validated("https://1.1.1.1/a"));
        let next = url_origin_key(&validated("https://8.8.8.8/b"));
        let headers: Vec<(String, String)> = [
            ("Accept", "application/json"),
            ("accept-language", "zh-CN"),
            ("USER-AGENT", "pi-gui"),
            ("Authorization", "Bearer sk-1"),
            ("X-Api-Key", "k"),
            ("X-Token", "unknown-custom-secret"),
            ("X-Keep", "looks harmless but is not allowlisted"),
            ("X-Note", "Bearerish value"),
        ]
        .into_iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect();
        let (out, cross_origin) = redirect_hop_headers(&prev, &next, &headers);
        assert!(cross_origin);
        let names: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            ["Accept", "accept-language", "USER-AGENT"],
            "跨源只保留明确安全的 allowlist，自定义头一律不跟随"
        );
    }

    #[test]
    fn utf8_body_truncation_uses_character_boundary() {
        assert_eq!(truncate_utf8_bytes("abc".to_string(), 4), "abc");
        assert_eq!(truncate_utf8_bytes("abc".to_string(), 0), "");
        assert_eq!(
            truncate_utf8_bytes("123好456".to_string(), 5),
            "123",
            "上限落在三字节字符中间时应退到前一个边界"
        );
        assert_eq!(
            truncate_utf8_bytes("123好456".to_string(), 6),
            "123好",
            "上限正好落在字符边界时应保留完整字符"
        );
    }
}
