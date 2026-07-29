//! Safe configuration file primitives for pi config files
//! (auth.json / models.json / settings.json).
//!
//! - [`DirLock`]: atomic mkdir-based advisory lock with stale-owner detection.
//! - [`atomic_write`]: temp-file + fsync + backup rotation + rename + chmod.
//! - [`update_json_file`]: process mutex + DirLock held across the whole
//!   read-modify-write cycle, so concurrent writers cannot lose updates.
//! - Tauri commands: `safe_read_json` / `safe_write_json` / `keychain_*`,
//!   path-restricted to known config file names under `~/.pi/`, the pi agent
//!   dir, or the app config dir.
//!
//! JSON serialization is the caller's job; this module only moves bytes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

/// How long Tauri commands wait for a contended lock before failing.
pub(crate) const DEFAULT_LOCK_TIMEOUT_MS: u64 = 10_000;
/// Poll interval while waiting for a held lock.
const LOCK_POLL_MS: u64 = 50;
/// Number of rotated backups kept per file.
const MAX_BACKUPS: usize = 10;

/// 允许通过 `safe_read_json` / `safe_write_json` 读写的配置文件名白名单。
/// `channels-meta.json` 是 GUI 自有元数据（别名/备注/图标/排序），
/// 只放 app data/config 目录（根白名单已限定），不进 pi 配置目录的语义。
const ALLOWED_CONFIG_FILE_NAMES: &[&str] = &[
    "auth.json",
    "models.json",
    "settings.json",
    "mcp.json",
    "trust.json",
    "channels-meta.json",
];

/// Process-level mutex covering the whole read-modify-write cycle of config
/// files. The [`DirLock`] only protects the final write between processes;
/// without this mutex two commands in this process can still interleave their
/// read and write phases and lose each other's updates.
static CONFIG_WRITE_MUTEX: Mutex<()> = Mutex::new(());

/// Acquire the process-level config write mutex. Multi-step transactions
/// (channel_save) hold it across several file updates; while held, only the
/// `_locked` primitives may be used (the public helpers would re-take the
/// mutex and deadlock — `std::sync::Mutex` is not reentrant).
pub(crate) fn config_write_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    CONFIG_WRITE_MUTEX
        .lock()
        .map_err(|e| format!("Config write mutex poisoned: {}", e))
}

/// Monotonic sequence to keep temp file names unique within one process,
/// even when two writes land on the same clock tick.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
/// Monotonic sequence for unique stale-lock tombstone names.
static LOCK_CLAIM_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Time helpers (no chrono dependency; UTC everywhere)
// ---------------------------------------------------------------------------

/// Split unix seconds into (year, month, day, hour, minute, second) in UTC.
/// Uses Howard Hinnant's civil-from-days algorithm.
fn split_unix_utc(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = (secs % 86_400) as u32;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    ((if m <= 2 { y + 1 } else { y }), m, d, hour, minute, second)
}

fn unix_secs_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `2026-07-25T19:56:25Z`
pub(crate) fn iso_utc_now() -> String {
    let (y, mo, d, h, mi, s) = split_unix_utc(unix_secs_now());
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

/// `20260725-195625`
fn compact_utc_now() -> String {
    let (y, mo, d, h, mi, s) = split_unix_utc(unix_secs_now());
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", y, mo, d, h, mi, s)
}

// ---------------------------------------------------------------------------
// DirLock
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct LockOwner {
    pid: u32,
    hostname: String,
    created_at: String,
}

fn lock_dir_for(target: &Path) -> PathBuf {
    let mut os = target.as_os_str().to_owned();
    os.push(".lock");
    PathBuf::from(os)
}

pub(crate) fn hostname() -> String {
    if let Ok(out) = Command::new("hostname").output() {
        if out.status.success() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(unix)]
pub(crate) fn pid_is_alive(pid: u32) -> bool {
    match Command::new("kill").args(["-0", &pid.to_string()]).output() {
        Ok(out) => {
            if out.status.success() {
                true
            } else {
                // EPERM: process exists but is owned by another user.
                let stderr = String::from_utf8_lossy(&out.stderr);
                stderr.contains("not permitted")
            }
        }
        // Cannot probe -> assume alive (conservative: never break a live lock).
        Err(_) => true,
    }
}

#[cfg(not(unix))]
pub(crate) fn pid_is_alive(_pid: u32) -> bool {
    // No portable pid probe without extra deps; assume alive (conservative).
    true
}

/// Read the lock owner; treat a dead owner pid as stale.
/// Unreadable/corrupt owner.json is NOT stale — the owner may be mid-acquire.
fn lock_is_stale(lock_dir: &Path) -> bool {
    let owner_path = lock_dir.join("owner.json");
    let content = match fs::read_to_string(&owner_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    match serde_json::from_str::<LockOwner>(&content) {
        Ok(owner) => !pid_is_alive(owner.pid),
        Err(_) => false,
    }
}

/// Atomically detach a stale lock from its well-known path.
///
/// Only the caller whose rename succeeds owns (and may delete) the detached
/// directory. A competing reclaimer can then create a fresh lock at
/// `lock_dir` without it being removed by a loser that observed the old owner.
fn claim_stale_lock(lock_dir: &Path) -> Result<bool, std::io::Error> {
    let seq = LOCK_CLAIM_SEQ.fetch_add(1, Ordering::Relaxed);
    let tombstone = sibling_with_suffix(
        lock_dir,
        &format!(".reclaim-{}-{}", std::process::id(), seq),
    );
    match fs::rename(lock_dir, &tombstone) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&tombstone);
            Ok(true)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Stable sibling-file guard serializing stale checks with recovery. The file
/// is intentionally retained: unlinking it would let waiters lock different
/// inodes and defeat the serialization.
struct StaleReclaimGuard {
    #[cfg(unix)]
    file: fs::File,
}

impl StaleReclaimGuard {
    fn acquire(lock_dir: &Path) -> Result<Self, std::io::Error> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;

            const LOCK_EX: i32 = 2;
            let guard_path = sibling_with_suffix(lock_dir, ".reclaim.guard");
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .open(guard_path)?;
            if unsafe { flock(file.as_raw_fd(), LOCK_EX) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self { file })
        }
        #[cfg(not(unix))]
        {
            let _ = lock_dir;
            Ok(Self {})
        }
    }
}

impl Drop for StaleReclaimGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;

            const LOCK_UN: i32 = 8;
            let _ = unsafe { flock(self.file.as_raw_fd(), LOCK_UN) };
        }
    }
}

/// Advisory lock: a `<target>.lock/` directory holding an `owner.json`.
/// mkdir is atomic on POSIX filesystems, so creation == ownership.
pub struct DirLock {
    lock_dir: PathBuf,
}

impl DirLock {
    /// Acquire the lock for `target`, waiting up to `timeout_ms` when held by
    /// a live process. A lock whose owner pid no longer exists is stale and
    /// is removed and retried immediately.
    pub fn acquire(target: &Path, timeout_ms: u64) -> Result<DirLock, String> {
        let lock_dir = lock_dir_for(target);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut reclaim_guard = None;

        loop {
            match fs::create_dir(&lock_dir) {
                Ok(()) => {
                    let owner = LockOwner {
                        pid: std::process::id(),
                        hostname: hostname(),
                        created_at: iso_utc_now(),
                    };
                    let data = serde_json::to_string_pretty(&owner)
                        .map_err(|e| format!("Failed to serialize lock owner: {}", e))?;
                    if let Err(e) = fs::write(lock_dir.join("owner.json"), data) {
                        let _ = fs::remove_dir_all(&lock_dir);
                        return Err(format!(
                            "Failed to write lock owner in {}: {}",
                            lock_dir.display(),
                            e
                        ));
                    }
                    return Ok(DirLock { lock_dir });
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                    if lock_is_stale(&lock_dir) {
                        if reclaim_guard.is_none() {
                            reclaim_guard = Some(StaleReclaimGuard::acquire(&lock_dir).map_err(
                                |guard_err| {
                                    format!(
                                        "Failed to guard stale lock recovery {}: {}",
                                        lock_dir.display(),
                                        guard_err
                                    )
                                },
                            )?);
                        }
                        // Another reclaimer may have rebuilt the lock while we
                        // waited for the guard. Never act on the old observation.
                        if !lock_is_stale(&lock_dir) {
                            reclaim_guard = None;
                            continue;
                        }
                        claim_stale_lock(&lock_dir).map_err(|claim_err| {
                            format!(
                                "Failed to reclaim stale lock dir {}: {}",
                                lock_dir.display(),
                                claim_err
                            )
                        })?;
                        continue;
                    }
                    reclaim_guard = None;
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "Timed out after {}ms waiting for lock {}",
                            timeout_ms,
                            lock_dir.display()
                        ));
                    }
                    thread::sleep(Duration::from_millis(LOCK_POLL_MS));
                }
                Err(e) => {
                    return Err(format!(
                        "Failed to create lock dir {}: {}",
                        lock_dir.display(),
                        e
                    ))
                }
            }
        }
    }
}

impl Drop for DirLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.lock_dir);
    }
}

// ---------------------------------------------------------------------------
// Atomic write + backup rotation
// ---------------------------------------------------------------------------

fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(suffix);
    PathBuf::from(os)
}

/// Copy the current file into `<path>.backups/` and keep only the newest
/// [`MAX_BACKUPS`] entries. Names sort chronologically thanks to the
/// fixed-width UTC timestamp.
fn backup_existing(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Invalid file name in {}", path.display()))?;

    let backup_dir = sibling_with_suffix(path, ".backups");
    fs::create_dir_all(&backup_dir).map_err(|e| {
        format!(
            "Failed to create backup dir {}: {}",
            backup_dir.display(),
            e
        )
    })?;

    // Base name per spec; same-second collisions get a numeric suffix so
    // rapid consecutive writes each keep their own backup.
    let ts = compact_utc_now();
    let mut candidate = backup_dir.join(format!("{}-{}.bak", file_name, ts));
    let mut n = 2u32;
    while candidate.exists() {
        candidate = backup_dir.join(format!("{}-{}-{}.bak", file_name, ts, n));
        n += 1;
    }

    fs::copy(path, &candidate)
        .map_err(|e| format!("Failed to back up {}: {}", path.display(), e))?;

    // Rotate: lexicographic order == chronological order (fixed-width ts).
    let mut backups: Vec<PathBuf> = fs::read_dir(&backup_dir)
        .map_err(|e| format!("Failed to list backup dir {}: {}", backup_dir.display(), e))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("bak"))
        .collect();
    backups.sort();
    while backups.len() > MAX_BACKUPS {
        let _ = fs::remove_file(backups.remove(0));
    }
    Ok(())
}

/// Write `bytes` to `path` atomically: temp file in the same directory ->
/// flush + fsync -> back up existing target -> rename over it -> chmod.
fn atomic_write_impl(
    path: &Path,
    bytes: &[u8],
    mode: Option<u32>,
    create_backup: bool,
) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent)
        .map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
    let tmp = parent.join(format!(".tmp-{}-{}-{}", std::process::id(), nanos, seq));

    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("Failed to create temp file {}: {}", tmp.display(), e))?;
        file.write_all(bytes)
            .map_err(|e| format!("Failed to write temp file {}: {}", tmp.display(), e))?;
        file.flush()
            .map_err(|e| format!("Failed to flush temp file {}: {}", tmp.display(), e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync temp file {}: {}", tmp.display(), e))?;

        #[cfg(unix)]
        {
            if let Some(m) = mode {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&tmp, fs::Permissions::from_mode(m)).map_err(|e| {
                    format!("Failed to set mode {:o} on {}: {}", m, tmp.display(), e)
                })?;
            }
        }
        #[cfg(not(unix))]
        let _ = mode;

        if create_backup {
            backup_existing(path)?;
        }

        #[cfg(unix)]
        fs::rename(&tmp, path).map_err(|e| {
            format!(
                "Failed to rename {} -> {}: {}",
                tmp.display(),
                path.display(),
                e
            )
        })?;
        #[cfg(windows)]
        {
            // rename(2) cannot overwrite on Windows.
            if path.exists() {
                fs::remove_file(path)
                    .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
            }
            fs::rename(&tmp, path).map_err(|e| {
                format!(
                    "Failed to rename {} -> {}: {}",
                    tmp.display(),
                    path.display(),
                    e
                )
            })?;
        }

        // Best-effort directory fsync so the rename itself is durable.
        #[cfg(unix)]
        {
            if let Ok(dir) = fs::File::open(&parent) {
                let _ = dir.sync_all();
            }
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn atomic_write(path: &Path, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    atomic_write_impl(path, bytes, mode, true)
}

/// Atomically replace a private, ephemeral control file without rotating
/// backups. Recovery journals can contain snapshots of sensitive config
/// entries, so retaining historical copies would extend their lifetime and
/// make journal cleanup misleading.
pub(crate) fn atomic_write_private_no_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_impl(path, bytes, Some(0o600), false)
}

// ---------------------------------------------------------------------------
// JSON read/write (sync cores; Tauri commands are thin async wrappers)
// ---------------------------------------------------------------------------

pub(crate) fn read_json_file(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).map_err(|e| {
            format!(
                "Invalid JSON in {}: line {} column {}: {}",
                path.display(),
                e.line(),
                e.column(),
                e
            )
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(format!("Failed to read {}: {}", path.display(), e)),
    }
}

/// Serialize + atomic write. Caller must already hold both the process
/// mutex and the file's [`DirLock`].
pub(crate) fn write_json_file_locked(
    path: &Path,
    value: &Value,
    mode: Option<u32>,
) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize JSON for {}: {}", path.display(), e))?;
    // Trailing newline matches the existing clear_pi_provider_auth convention.
    let bytes = format!("{}\n", serialized).into_bytes();
    atomic_write(path, &bytes, mode)
}

fn write_json_file(path: &Path, value: &Value, mode: Option<u32>) -> Result<(), String> {
    let _guard = CONFIG_WRITE_MUTEX
        .lock()
        .map_err(|e| format!("Config write mutex poisoned: {}", e))?;
    let _file_lock = DirLock::acquire(path, DEFAULT_LOCK_TIMEOUT_MS)?;
    write_json_file_locked(path, value, mode)
}

/// 锁内「重读-合并-原子写」：进程级互斥 + 文件级 DirLock 覆盖整个
/// read-modify-write 周期，避免 GUI 与 TUI 并发互相覆盖。
///
/// `merge` 收到的当前值在文件缺失时为 [`Value::Null`]（调用方自行初始化
/// 结构），merge 返回 Ok 后立刻原子写回（含备份轮换）。
pub fn update_json_file(
    path: &Path,
    mode: Option<u32>,
    merge: impl FnOnce(&mut Value) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = CONFIG_WRITE_MUTEX
        .lock()
        .map_err(|e| format!("Config write mutex poisoned: {}", e))?;
    let _file_lock = DirLock::acquire(path, DEFAULT_LOCK_TIMEOUT_MS)?;
    let mut current = read_json_file(path)?;
    merge(&mut current)?;
    write_json_file_locked(path, &current, mode)
}

/// Lexically resolve `.` / `..` components (the file may not exist yet, so
/// `fs::canonicalize` is not an option) without touching the filesystem.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn home_dir() -> Option<PathBuf> {
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

fn expand_tilde(raw: &str) -> PathBuf {
    if raw == "~" {
        if let Some(home) = home_dir() {
            return home;
        }
    }
    for prefix in ["~/", "~\\"] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            if let Some(home) = home_dir() {
                return home.join(rest);
            }
        }
    }
    PathBuf::from(raw)
}

/// Allowed roots for config IO: `~/.pi/`, the effective pi agent dir when
/// `PI_CODING_AGENT_DIR` overrides it, the Tauri app config dir, plus the
/// known MCP config locations (`~/.config/mcp/`, `~/.agents/`).
pub(crate) fn allowed_config_roots(app_config_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home_dir() {
        roots.push(home.join(".pi"));
        roots.push(home.join(".config").join("mcp"));
        roots.push(home.join(".agents"));
    }
    if let Ok(raw) = std::env::var("PI_CODING_AGENT_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            roots.push(normalize_lexical(&expand_tilde(trimmed)));
        }
    }
    if let Some(dir) = app_config_dir {
        roots.push(dir);
    }
    roots
}

/// 项目内配置形态：任意项目目录下的 `.pi/settings.json`、`.pi/mcp.json`、
/// `.mcp.json`（项目根级 MCP 配置）。项目路径本身任意，无法进根白名单，
/// 按路径形态放行。
fn is_project_scoped_config(normalized: &Path, file_name: &str) -> bool {
    if file_name == ".mcp.json" {
        return true;
    }
    if file_name != "settings.json" && file_name != "mcp.json" {
        return false;
    }
    normalized
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some(".pi")
}

/// Whitelist validation: known config file names
/// ([`ALLOWED_CONFIG_FILE_NAMES`]，外加项目根级 `.mcp.json`) under `~/.pi/`,
/// the pi agent dir, the app config dir, the known MCP locations, or a
/// project-scoped config shape may be read/written through the Tauri commands.
pub(crate) fn validate_config_path(
    path: &str,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    let normalized = normalize_lexical(&expand_tilde(trimmed));
    if !normalized.is_absolute() {
        return Err(format!("Path must be absolute: {}", trimmed));
    }
    let file_name = normalized
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Invalid file name in {}", normalized.display()))?;
    if !ALLOWED_CONFIG_FILE_NAMES.contains(&file_name) && file_name != ".mcp.json" {
        return Err(format!(
            "Config file name not allowed: {} (allowed: {})",
            file_name,
            ALLOWED_CONFIG_FILE_NAMES.join(", ")
        ));
    }
    if !allowed_roots
        .iter()
        .any(|root| normalized.starts_with(root))
        && !is_project_scoped_config(&normalized, file_name)
    {
        return Err(format!(
            "Path outside allowed config roots (~/.pi, app config dir): {}",
            normalized.display()
        ));
    }
    Ok(normalized)
}

// ---------------------------------------------------------------------------
// macOS Keychain via /usr/bin/security
// ---------------------------------------------------------------------------

const SECURITY_BIN: &str = "/usr/bin/security";

fn run_security(args: &[&str]) -> Result<std::process::Output, String> {
    if !cfg!(target_os = "macos") {
        return Err("Keychain access is only supported on macOS".to_string());
    }
    Command::new(SECURITY_BIN)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run {}: {}", SECURITY_BIN, e))
}

fn security_not_found(output: &std::process::Output) -> bool {
    output.status.code() == Some(44)
        || String::from_utf8_lossy(&output.stderr).contains("could not be found")
}

pub(crate) fn keychain_set_impl(service: &str, account: &str, secret: &str) -> Result<(), String> {
    // NOTE: `-w` puts the secret in argv, briefly visible in `ps` output on
    // this machine. Acceptable for a local desktop app; documented tradeoff.
    let out = run_security(&[
        "add-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
        secret,
        "-U", // update in place if the item already exists
    ])?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "security add-generic-password failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

pub(crate) fn keychain_get_impl(service: &str, account: &str) -> Result<Option<String>, String> {
    let out = run_security(&["find-generic-password", "-s", service, "-a", account, "-w"])?;
    if out.status.success() {
        let secret = String::from_utf8_lossy(&out.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_string();
        Ok(Some(secret))
    } else if security_not_found(&out) {
        Ok(None)
    } else {
        Err(format!(
            "security find-generic-password failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

pub(crate) fn keychain_delete_impl(service: &str, account: &str) -> Result<(), String> {
    let out = run_security(&["delete-generic-password", "-s", service, "-a", account])?;
    if out.status.success() || security_not_found(&out) {
        // Deleting a missing item is a no-op, not an error.
        Ok(())
    } else {
        Err(format!(
            "security delete-generic-password failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn validate_keychain_args(service: &str, account: &str) -> Result<(), String> {
    if service.trim().is_empty() {
        return Err("Service cannot be empty".to_string());
    }
    if account.trim().is_empty() {
        return Err("Account cannot be empty".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read a JSON config file. Missing file -> null; malformed JSON -> error
/// with line/column info. Paths are whitelist-validated (see
/// [`validate_config_path`]).
#[tauri::command]
pub async fn safe_read_json(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    use tauri::Manager;
    let roots = allowed_config_roots(app.path().app_config_dir().ok());
    let path = validate_config_path(&path, &roots)?;
    read_json_file(&path)
}

/// Write a JSON config file under a DirLock, with backup + atomic rename.
/// `mode` is a unix permission like 0o600 (used for auth.json).
/// Paths are whitelist-validated (see [`validate_config_path`]).
#[tauri::command]
pub async fn safe_write_json(
    app: tauri::AppHandle,
    path: String,
    value: Value,
    mode: Option<u32>,
) -> Result<(), String> {
    use tauri::Manager;
    let roots = allowed_config_roots(app.path().app_config_dir().ok());
    let path = validate_config_path(&path, &roots)?;
    write_json_file(&path, &value, mode)
}

/// Store a secret in the macOS login keychain (create or update).
#[tauri::command]
pub async fn keychain_set(service: String, account: String, secret: String) -> Result<(), String> {
    validate_keychain_args(&service, &account)?;
    keychain_set_impl(&service, &account, &secret)
}

/// Read a secret from the macOS login keychain. Missing item -> null.
#[tauri::command]
pub async fn keychain_get(service: String, account: String) -> Result<Option<String>, String> {
    validate_keychain_args(&service, &account)?;
    keychain_get_impl(&service, &account)
}

/// Delete a secret from the macOS login keychain (idempotent).
#[tauri::command]
pub async fn keychain_delete(service: String, account: String) -> Result<(), String> {
    validate_keychain_args(&service, &account)?;
    keychain_delete_impl(&service, &account)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_test_dir(tag: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "safe_config_test_{}_{}_{}",
            tag,
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lock_rejects_second_acquire() {
        let dir = temp_test_dir("double_lock");
        let target = dir.join("settings.json");

        let lock = DirLock::acquire(&target, 1_000).unwrap();
        // Held by a live process (us) -> must time out, not break the lock.
        let second = DirLock::acquire(&target, 200);
        assert!(second.is_err(), "second acquire should time out");
        let owner_path = lock_dir_for(&target).join("owner.json");
        assert!(
            owner_path.exists(),
            "lock dir must survive the failed acquire"
        );

        drop(lock);
        let third = DirLock::acquire(&target, 1_000).unwrap();
        drop(third);
        assert!(!lock_dir_for(&target).exists(), "lock dir removed on drop");

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn lock_recovers_stale_owner() {
        let dir = temp_test_dir("stale_lock");
        let target = dir.join("settings.json");
        let lock_dir = lock_dir_for(&target);
        fs::create_dir(&lock_dir).unwrap();

        // Simulate a crashed owner: pid far above any real pid (macOS
        // PID_MAX is 99999), so kill -0 reliably reports ESRCH.
        let stale = LockOwner {
            pid: 999_999_999,
            hostname: "ghost-host".to_string(),
            created_at: iso_utc_now(),
        };
        fs::write(
            lock_dir.join("owner.json"),
            serde_json::to_string(&stale).unwrap(),
        )
        .unwrap();

        let lock =
            DirLock::acquire(&target, 2_000).expect("stale lock should be reclaimed immediately");
        let content = fs::read_to_string(lock_dir.join("owner.json")).unwrap();
        let owner: LockOwner = serde_json::from_str(&content).unwrap();
        assert_eq!(owner.pid, std::process::id(), "lock now owned by us");
        drop(lock);

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn competing_stale_reclaimers_cannot_remove_rebuilt_lock() {
        let dir = temp_test_dir("stale_reclaim_race");
        let target = dir.join("settings.json");
        let lock_dir = lock_dir_for(&target);
        fs::create_dir(&lock_dir).unwrap();
        let stale = LockOwner {
            pid: 999_999_999,
            hostname: "ghost-host".to_string(),
            created_at: iso_utc_now(),
        };
        fs::write(
            lock_dir.join("owner.json"),
            serde_json::to_string(&stale).unwrap(),
        )
        .unwrap();

        // Both reclaimers have observed the old stale owner. The first keeps
        // the guard through rebuilding; the delayed second must re-check after
        // obtaining the guard and therefore cannot rename the rebuilt lock.
        assert!(lock_is_stale(&lock_dir));
        let first_guard = StaleReclaimGuard::acquire(&lock_dir).unwrap();
        assert!(claim_stale_lock(&lock_dir).unwrap());
        let rebuilt = DirLock::acquire(&target, 1_000).unwrap();
        let delayed_lock_dir = lock_dir.clone();
        let delayed = thread::spawn(move || {
            let _guard = StaleReclaimGuard::acquire(&delayed_lock_dir).unwrap();
            if lock_is_stale(&delayed_lock_dir) {
                claim_stale_lock(&delayed_lock_dir).unwrap()
            } else {
                false
            }
        });
        drop(first_guard);
        assert!(
            !delayed.join().unwrap(),
            "delayed reclaimer must reject its stale observation"
        );
        assert!(
            lock_dir.join("owner.json").exists(),
            "losing reclaimer must not delete the rebuilt lock"
        );
        assert!(
            DirLock::acquire(&target, 100).is_err(),
            "rebuilt lock must still exclude a second holder"
        );
        drop(rebuilt);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_roundtrip() {
        let dir = temp_test_dir("roundtrip");
        let target = dir.join("models.json");
        let payload = br#"{"providers":["anthropic"],"n":1}"#;

        atomic_write(&target, payload, Some(0o600)).unwrap();
        assert_eq!(fs::read(&target).unwrap(), payload);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "mode applied to written file");
        }

        // Temp file must not linger.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_rotates_backups() {
        let dir = temp_test_dir("rotation");
        let target = dir.join("settings.json");
        let backup_dir = sibling_with_suffix(&target, ".backups");

        for i in 0..12 {
            atomic_write(&target, format!(r#"{{"version":{}}}"#, i).as_bytes(), None).unwrap();
        }

        let backups: Vec<_> = fs::read_dir(&backup_dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("bak"))
            .collect();
        // First write had nothing to back up: 11 backups made, rotated to 10.
        assert_eq!(backups.len(), MAX_BACKUPS);
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"version":11}"#);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writes_keep_file_intact() {
        let dir = temp_test_dir("concurrent");
        let target = dir.join("settings.json");
        let threads = 8;

        let handles: Vec<_> = (0..threads)
            .map(|i| {
                let target = target.clone();
                thread::spawn(move || {
                    let value = serde_json::json!({
                        "writer": i,
                        "payload": "x".repeat(512),
                    });
                    let bytes = serde_json::to_vec(&value).unwrap();
                    let lock = DirLock::acquire(&target, 10_000).unwrap();
                    atomic_write(&target, &bytes, None).unwrap();
                    drop(lock);
                    i
                })
            })
            .collect();
        let writers: Vec<usize> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(writers.len(), threads);

        // The final content must be one complete write, never a mix.
        let final_value: Value =
            serde_json::from_str(&fs::read_to_string(&target).unwrap()).unwrap();
        let writer = final_value["writer"].as_u64().unwrap() as usize;
        assert!(writer < threads);
        assert_eq!(final_value["payload"].as_str().unwrap().len(), 512);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_json_missing_file_is_null() {
        let dir = temp_test_dir("read_missing");
        let value = read_json_file(&dir.join("nope.json")).unwrap();
        assert_eq!(value, Value::Null);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_json_malformed_reports_line() {
        let dir = temp_test_dir("read_bad");
        let target = dir.join("bad.json");
        fs::write(&target, "{\n  \"a\": 1,\n  bad\n}\n").unwrap();
        let err = read_json_file(&target).unwrap_err();
        assert!(err.contains("line 3"), "error names the line: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_json_roundtrip_via_lock() {
        let dir = temp_test_dir("write_json");
        let target = dir.join("auth.json");
        let value = serde_json::json!({"anthropic": {"key": "sk-test"}});
        write_json_file(&target, &value, Some(0o600)).unwrap();

        let back = read_json_file(&target).unwrap();
        assert_eq!(back, value);
        // Lock released after write.
        assert!(!lock_dir_for(&target).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_json_file_merges_under_lock() {
        let dir = temp_test_dir("update_merge");
        let target = dir.join("settings.json");

        // 文件缺失：merge 收到 Null，自行初始化结构。
        update_json_file(&target, None, |value| {
            assert!(value.is_null());
            *value = serde_json::json!({"theme": "dark"});
            Ok(())
        })
        .unwrap();

        // 已存在：在持锁状态下重读-合并-写回，保留既有键。
        update_json_file(&target, None, |value| {
            value["fontSize"] = serde_json::json!(14);
            Ok(())
        })
        .unwrap();

        let back = read_json_file(&target).unwrap();
        assert_eq!(back["theme"], serde_json::json!("dark"));
        assert_eq!(back["fontSize"], serde_json::json!(14));
        assert!(
            !lock_dir_for(&target).exists(),
            "lock released after update"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_json_file_propagates_merge_error_without_writing() {
        let dir = temp_test_dir("update_err");
        let target = dir.join("settings.json");
        fs::write(&target, "{\"keep\":1}\n").unwrap();

        let err = update_json_file(&target, None, |_value| Err("boom".to_string())).unwrap_err();
        assert!(err.contains("boom"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"keep\":1}\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_updates_do_not_lose_writes() {
        let dir = temp_test_dir("rmw_race");
        let target = dir.join("settings.json");
        fs::write(&target, "{}\n").unwrap();
        let threads = 8;

        let handles: Vec<_> = (0..threads)
            .map(|i| {
                let target = target.clone();
                thread::spawn(move || {
                    update_json_file(&target, None, move |value| {
                        value[format!("key_{}", i)] = serde_json::json!(i);
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        // 重读-合并在锁内完成：8 个并发写者的键必须全部保留，零丢失更新。
        let final_value = read_json_file(&target).unwrap();
        for i in 0..threads {
            assert_eq!(
                final_value[format!("key_{}", i)],
                serde_json::json!(i),
                "update from writer {} survived",
                i
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn whitelist_accepts_known_names_under_allowed_roots() {
        let dir = temp_test_dir("wl_accept");
        let pi_root = dir.join(".pi");
        let app_root = dir.join("app-config");
        let roots = vec![pi_root.clone(), app_root.clone()];

        for name in [
            "auth.json",
            "models.json",
            "settings.json",
            "mcp.json",
            "trust.json",
        ] {
            let p = pi_root.join("agent").join(name);
            assert!(
                validate_config_path(p.to_str().unwrap(), &roots).is_ok(),
                "{} under ~/.pi accepted",
                name
            );
        }
        // 应用 config 目录下的已知文件名同样放行
        assert!(
            validate_config_path(app_root.join("settings.json").to_str().unwrap(), &roots).is_ok()
        );
        // GUI 自有元数据 channels-meta.json（app data/config 目录）放行
        assert!(validate_config_path(
            app_root.join("channels-meta.json").to_str().unwrap(),
            &roots
        )
        .is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn whitelist_rejects_unknown_names_and_foreign_paths() {
        let dir = temp_test_dir("wl_reject");
        let pi_root = dir.join(".pi");
        let roots = vec![pi_root.clone()];

        // ~/.pi 下的非白名单文件名
        let err = validate_config_path(
            pi_root.join("agent").join("evil.json").to_str().unwrap(),
            &roots,
        )
        .unwrap_err();
        assert!(err.contains("not allowed"), "got: {}", err);
        // 非 JSON 文件，即使在 ~/.pi 下
        assert!(validate_config_path(
            pi_root.join("agent").join("id_rsa").to_str().unwrap(),
            &roots
        )
        .is_err());
        // 白名单文件名但在其他目录
        let err = validate_config_path(
            dir.join("other").join("auth.json").to_str().unwrap(),
            &roots,
        )
        .unwrap_err();
        assert!(err.contains("outside allowed"), "got: {}", err);
        // 用 .. 逃逸白名单根目录
        let err = validate_config_path(
            pi_root
                .join("..")
                .join("escape")
                .join("auth.json")
                .to_str()
                .unwrap(),
            &roots,
        )
        .unwrap_err();
        assert!(err.contains("outside allowed"), "got: {}", err);
        // 相对路径 / 空路径
        assert!(validate_config_path("relative/auth.json", &roots).is_err());
        assert!(validate_config_path("   ", &roots).is_err());
        // 根目录本身（没有文件名）
        assert!(validate_config_path(pi_root.to_str().unwrap(), &roots).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn whitelist_accepts_project_scoped_and_known_mcp_locations() {
        let dir = temp_test_dir("wl_project");
        let pi_root = dir.join(".pi");
        let roots = vec![pi_root.clone()];

        // 任意项目目录下的 .pi/settings.json、.pi/mcp.json
        let project = dir.join("some-random-project");
        assert!(validate_config_path(
            project.join(".pi").join("settings.json").to_str().unwrap(),
            &roots
        )
        .is_ok());
        assert!(validate_config_path(
            project.join(".pi").join("mcp.json").to_str().unwrap(),
            &roots
        )
        .is_ok());
        // 项目根级 .mcp.json
        assert!(validate_config_path(project.join(".mcp.json").to_str().unwrap(), &roots).is_ok());
        // 项目目录下的其他文件名仍拒绝
        assert!(validate_config_path(
            project.join(".pi").join("auth.json").to_str().unwrap(),
            &roots
        )
        .is_err());
        // 非 .pi 父目录的 settings.json 仍拒绝
        assert!(validate_config_path(
            project
                .join("config")
                .join("settings.json")
                .to_str()
                .unwrap(),
            &roots
        )
        .is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn whitelist_accepts_known_mcp_roots() {
        // allowed_config_roots 现在含 ~/.config/mcp 与 ~/.agents；用真实 home 构建验证
        let roots = allowed_config_roots(None);
        let home = home_dir().unwrap();
        assert!(validate_config_path(
            home.join(".config")
                .join("mcp")
                .join("mcp.json")
                .to_str()
                .unwrap(),
            &roots
        )
        .is_ok());
        assert!(validate_config_path(
            home.join(".agents").join("mcp.json").to_str().unwrap(),
            &roots
        )
        .is_ok());
        assert!(validate_config_path(
            home.join(".agents")
                .join("mcp")
                .join("mcp.json")
                .to_str()
                .unwrap(),
            &roots
        )
        .is_ok());
        // ~/.agents 下的非白名单文件名仍拒绝
        assert!(validate_config_path(
            home.join(".agents").join("evil.json").to_str().unwrap(),
            &roots
        )
        .is_err());
    }

    #[test]
    fn whitelist_tilde_expands_to_home_pi() {
        // HOME 由测试运行环境提供，只读使用，不做 env 篡改。
        let home = home_dir().expect("tests need HOME or USERPROFILE");
        let roots = allowed_config_roots(None);
        let p = validate_config_path("~/.pi/agent/auth.json", &roots).unwrap();
        assert_eq!(p, home.join(".pi").join("agent").join("auth.json"));
    }

    // -- Keychain: real login-keychain access, excluded from CI. -----------
    // 手动验证（macOS）:
    //   cd src-tauri && cargo test safe_config::tests::keychain -- --ignored
    // 会真实写入登录钥匙串（service 名带 pi-desktop-safe-config-test 前缀，
    // 测试结束即删除）。若系统弹出钥匙串授权框，选择"始终允许"。

    #[test]
    #[ignore = "touches the real login keychain; run manually"]
    fn keychain_roundtrip() {
        let service = format!("pi-desktop-safe-config-test-{}", std::process::id());
        let account = "test-account";

        keychain_set_impl(&service, account, "s3cret-one").unwrap();
        assert_eq!(
            keychain_get_impl(&service, account).unwrap(),
            Some("s3cret-one".to_string())
        );

        // -U update in place.
        keychain_set_impl(&service, account, "s3cret-two").unwrap();
        assert_eq!(
            keychain_get_impl(&service, account).unwrap(),
            Some("s3cret-two".to_string())
        );

        keychain_delete_impl(&service, account).unwrap();
        assert_eq!(keychain_get_impl(&service, account).unwrap(), None);
        // Delete is idempotent.
        keychain_delete_impl(&service, account).unwrap();
    }

    #[test]
    #[ignore = "touches the real login keychain; run manually"]
    fn keychain_get_missing_returns_none() {
        let service = format!("pi-desktop-safe-config-missing-{}", std::process::id());
        assert_eq!(keychain_get_impl(&service, "nobody").unwrap(), None);
    }
}
