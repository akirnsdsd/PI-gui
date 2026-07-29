//! Session file leases: prevent the same session from being opened in two
//! windows or processes at once (single-writer lock).
//!
//! 沿用 DEVLOG「session 单写者锁」bash spike 已验证的方案：mkdir 原子目录锁
//! + `owner.json`（pid/hostname/时间戳）+ stale 检测（owner pid 不存活则回收）。
//! 与 spike 不同的是锁目录不在 session 文件旁边，而是集中放在应用 config
//! 目录的 `leases/` 下，以规范化 session path 的 FNV-1a hash 命名——同一台
//! 机器、同一用户的所有进程算出相同的名字，从而跨进程互斥。
//!
//! 进程退出清理：正常退出由持有方 Drop（`rpc_stop` / `shutdown_all_instances`
//! / 应用 ExitRequested 钩子）删除锁目录；进程崩溃留下的 stale 锁由下一次
//! acquire 的 pid 存活检查回收。

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::safe_config::{hostname, iso_utc_now, pid_is_alive};

#[cfg(unix)]
extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

/// 获取会话租约失败（被其他窗口/进程持有）时返回给前端的错误文案。
pub const LEASE_CONFLICT_MESSAGE: &str = "该会话已在另一个窗口或进程中打开";

static LEASE_CLAIM_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, Deserialize)]
struct LeaseOwner {
    pid: u32,
    hostname: String,
    created_at: String,
    session_path: String,
}

/// 规范化 session path：展开 `~`、纯词法消解 `.`/`..`；文件存在时优先
/// canonicalize 以消解符号链接，保证同一会话的不同写法映射到同一把锁。
pub fn normalize_session_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("session path 不能为空".to_string());
    }
    let expanded = crate::expand_tilde_path(trimmed);
    if expanded.exists() {
        if let Ok(canonical) = fs::canonicalize(&expanded) {
            return Ok(canonical.to_string_lossy().to_string());
        }
    }
    let mut normalized = PathBuf::new();
    for component in expanded.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized.to_string_lossy().to_string())
}

/// FNV-1a 64-bit：无依赖、跨进程/跨 Rust 版本稳定的 hash（`DefaultHasher`
/// 不保证跨版本一致，不能用于需要跨进程对齐的锁文件名）。
fn fnv1a_64(data: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 锁目录名：`session-<fnv1a64(hex)>.gui-lock`。
fn lease_dir_name(normalized_path: &str) -> String {
    format!("session-{:016x}.gui-lock", fnv1a_64(normalized_path))
}

/// owner pid 不存活视为 stale；owner.json 读不出/解析失败不算 stale
/// （owner 可能正在写入，保守保留）。
fn lease_is_stale(lock_dir: &Path) -> bool {
    let content = match fs::read_to_string(lock_dir.join("owner.json")) {
        Ok(c) => c,
        Err(_) => return false,
    };
    match serde_json::from_str::<LeaseOwner>(&content) {
        Ok(owner) => !pid_is_alive(owner.pid),
        Err(_) => false,
    }
}

/// 原子地把 stale 锁从固定路径移到唯一 tombstone。只有 rename 成功者可以
/// 删除 tombstone；竞争失败者不得删除固定路径，因为那里可能已是新锁。
fn claim_stale_lease(lock_dir: &Path) -> Result<bool, std::io::Error> {
    let seq = LEASE_CLAIM_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut tombstone_name = lock_dir.as_os_str().to_owned();
    tombstone_name.push(format!(".reclaim-{}-{}", std::process::id(), seq));
    let tombstone = PathBuf::from(tombstone_name);
    match fs::rename(lock_dir, &tombstone) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&tombstone);
            Ok(true)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// 固定 sibling guard 将 stale 复检、rename 和新 owner 写入串行化。guard
/// 文件必须保留，删除会让等待者锁住不同 inode，失去互斥。
struct StaleLeaseReclaimGuard {
    #[cfg(unix)]
    file: fs::File,
}

impl StaleLeaseReclaimGuard {
    fn acquire(lock_dir: &Path) -> Result<Self, std::io::Error> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;

            const LOCK_EX: i32 = 2;
            let mut guard_name = lock_dir.as_os_str().to_owned();
            guard_name.push(".reclaim.guard");
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .open(PathBuf::from(guard_name))?;
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

impl Drop for StaleLeaseReclaimGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;

            const LOCK_UN: i32 = 8;
            let _ = unsafe { flock(self.file.as_raw_fd(), LOCK_UN) };
        }
    }
}

/// 一个已持有的会话租约；Drop 即释放（删除锁目录）。
#[derive(Debug)]
pub struct SessionLease {
    lock_dir: PathBuf,
    normalized_path: String,
}

impl SessionLease {
    /// 获取 `session_path` 的租约。锁已存在且 owner pid 存活（包括本进程已
    /// 持有——同进程重复获取同样拒绝，由调用方先做同路径重入判断）时立即
    /// 返回 [`LEASE_CONFLICT_MESSAGE`]；owner 已死则回收后获取。不做等待
    /// 重试：会话锁是互斥语义，不是排队语义。
    pub fn acquire(leases_root: &Path, session_path: &str) -> Result<SessionLease, String> {
        let normalized = normalize_session_path(session_path)?;
        fs::create_dir_all(leases_root)
            .map_err(|e| format!("创建租约目录失败 {}：{}", leases_root.display(), e))?;
        let lock_dir = leases_root.join(lease_dir_name(&normalized));
        let mut reclaim_guard = None;

        loop {
            match fs::create_dir(&lock_dir) {
                Ok(()) => {
                    let owner = LeaseOwner {
                        pid: std::process::id(),
                        hostname: hostname(),
                        created_at: iso_utc_now(),
                        session_path: normalized.clone(),
                    };
                    let data = serde_json::to_string_pretty(&owner)
                        .map_err(|e| format!("序列化租约 owner 失败：{}", e))?;
                    if let Err(e) = fs::write(lock_dir.join("owner.json"), data) {
                        let _ = fs::remove_dir_all(&lock_dir);
                        return Err(format!("写入租约 owner 失败 {}：{}", lock_dir.display(), e));
                    }
                    return Ok(SessionLease {
                        lock_dir,
                        normalized_path: normalized,
                    });
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                    if lease_is_stale(&lock_dir) {
                        if reclaim_guard.is_none() {
                            reclaim_guard =
                                Some(StaleLeaseReclaimGuard::acquire(&lock_dir).map_err(
                                    |guard_err| {
                                        format!(
                                            "保护 stale 会话锁回收失败 {}：{}",
                                            lock_dir.display(),
                                            guard_err
                                        )
                                    },
                                )?);
                        }
                        // 等待 guard 时锁可能已经被其他回收者重建；必须复检。
                        if !lease_is_stale(&lock_dir) {
                            return Err(LEASE_CONFLICT_MESSAGE.to_string());
                        }
                        claim_stale_lease(&lock_dir).map_err(|claim_err| {
                            format!(
                                "回收 stale 会话锁失败 {}：{}",
                                lock_dir.display(),
                                claim_err
                            )
                        })?;
                        continue;
                    }
                    return Err(LEASE_CONFLICT_MESSAGE.to_string());
                }
                Err(e) => return Err(format!("创建会话锁目录失败 {}：{}", lock_dir.display(), e)),
            }
        }
    }

    /// 规范化后的 session path，用于调用方做同路径重入判断。
    pub fn normalized_path(&self) -> &str {
        &self.normalized_path
    }

    /// 显式释放（等价于 drop，删除锁目录）。
    pub fn release(self) {
        drop(self);
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.lock_dir);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_leases_root(tag: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "session_lease_test_{}_{}_{}",
            tag,
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn acquire_then_second_acquire_conflicts() {
        let root = temp_leases_root("conflict");
        let session = root.join("a.jsonl");
        fs::write(&session, "{}\n").unwrap();

        let lease = SessionLease::acquire(&root, session.to_str().unwrap()).unwrap();
        let err = SessionLease::acquire(&root, session.to_str().unwrap()).unwrap_err();
        assert_eq!(err, LEASE_CONFLICT_MESSAGE);

        // 释放后同一会话可以重新获取
        lease.release();
        let again = SessionLease::acquire(&root, session.to_str().unwrap());
        assert!(again.is_ok(), "released lease should be re-acquirable");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn drop_removes_lock_dir() {
        let root = temp_leases_root("drop");
        let session = root.join("b.jsonl");
        fs::write(&session, "{}\n").unwrap();

        let lease = SessionLease::acquire(&root, session.to_str().unwrap()).unwrap();
        let lock_dir = lease.lock_dir.clone();
        assert!(lock_dir.exists());
        assert!(lock_dir.join("owner.json").exists());
        drop(lease);
        assert!(!lock_dir.exists(), "lock dir removed on drop");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn stale_owner_is_reclaimed() {
        let root = temp_leases_root("stale");
        let session = root.join("c.jsonl");
        fs::write(&session, "{}\n").unwrap();
        let normalized = normalize_session_path(session.to_str().unwrap()).unwrap();
        let lock_dir = root.join(lease_dir_name(&normalized));
        fs::create_dir(&lock_dir).unwrap();

        // 模拟崩溃的持锁进程：pid 远超 macOS PID_MAX(99999)，kill -0 必报 ESRCH
        let stale = LeaseOwner {
            pid: 999_999_999,
            hostname: "ghost-host".to_string(),
            created_at: iso_utc_now(),
            session_path: normalized.clone(),
        };
        fs::write(
            lock_dir.join("owner.json"),
            serde_json::to_string(&stale).unwrap(),
        )
        .unwrap();

        let lease = SessionLease::acquire(&root, session.to_str().unwrap())
            .expect("stale lease should be reclaimed immediately");
        let content = fs::read_to_string(lock_dir.join("owner.json")).unwrap();
        let owner: LeaseOwner = serde_json::from_str(&content).unwrap();
        assert_eq!(owner.pid, std::process::id(), "lock now owned by us");
        drop(lease);

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn competing_stale_reclaimers_cannot_remove_rebuilt_lease() {
        let root = temp_leases_root("stale_reclaim_race");
        let session = root.join("race.jsonl");
        fs::write(&session, "{}\n").unwrap();
        let normalized = normalize_session_path(session.to_str().unwrap()).unwrap();
        let lock_dir = root.join(lease_dir_name(&normalized));
        fs::create_dir(&lock_dir).unwrap();
        let stale = LeaseOwner {
            pid: 999_999_999,
            hostname: "ghost-host".to_string(),
            created_at: iso_utc_now(),
            session_path: normalized,
        };
        fs::write(
            lock_dir.join("owner.json"),
            serde_json::to_string(&stale).unwrap(),
        )
        .unwrap();

        // 两个回收者都已观察到旧 stale owner。第一个持有 guard 直到新 owner
        // 写完；延迟的第二个拿到 guard 后必须复检，不能 rename 新锁。
        assert!(lease_is_stale(&lock_dir));
        let first_guard = StaleLeaseReclaimGuard::acquire(&lock_dir).unwrap();
        assert!(claim_stale_lease(&lock_dir).unwrap());
        let rebuilt = SessionLease::acquire(&root, session.to_str().unwrap()).unwrap();
        let delayed_lock_dir = lock_dir.clone();
        let delayed = std::thread::spawn(move || {
            let _guard = StaleLeaseReclaimGuard::acquire(&delayed_lock_dir).unwrap();
            if lease_is_stale(&delayed_lock_dir) {
                claim_stale_lease(&delayed_lock_dir).unwrap()
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
            "losing reclaimer must not delete the rebuilt lease"
        );
        assert_eq!(
            SessionLease::acquire(&root, session.to_str().unwrap()).unwrap_err(),
            LEASE_CONFLICT_MESSAGE,
            "rebuilt lease must still exclude a second holder"
        );
        drop(rebuilt);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn owner_without_file_is_not_stale() {
        // 锁目录存在但 owner.json 尚未写入（owner 正在 acquire 途中）：
        // 不得当作 stale 回收，必须报冲突。
        let root = temp_leases_root("mid_acquire");
        let session = root.join("d.jsonl");
        fs::write(&session, "{}\n").unwrap();
        let normalized = normalize_session_path(session.to_str().unwrap()).unwrap();
        fs::create_dir(root.join(lease_dir_name(&normalized))).unwrap();

        let err = SessionLease::acquire(&root, session.to_str().unwrap()).unwrap_err();
        assert_eq!(err, LEASE_CONFLICT_MESSAGE);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_variants_normalize_to_same_lease() {
        let root = temp_leases_root("variants");
        let session = root.join("sub").join("e.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::write(&session, "{}\n").unwrap();

        let plain = normalize_session_path(session.to_str().unwrap()).unwrap();
        let with_dot = format!("{}/./e.jsonl", session.parent().unwrap().display());
        let with_dotdot = format!("{}/sub/../sub/e.jsonl", root.display());
        assert_eq!(
            normalize_session_path(&with_dot).unwrap(),
            plain,
            "'/./' variant maps to the same path"
        );
        assert_eq!(
            normalize_session_path(&with_dotdot).unwrap(),
            plain,
            "'/../' variant maps to the same path"
        );

        // 持有期间，换一种写法获取同一会话也必须冲突
        let lease = SessionLease::acquire(&root, session.to_str().unwrap()).unwrap();
        let err = SessionLease::acquire(&root, &with_dotdot).unwrap_err();
        assert_eq!(err, LEASE_CONFLICT_MESSAGE);
        drop(lease);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn different_sessions_get_different_leases() {
        let root = temp_leases_root("distinct");
        let a = root.join("a.jsonl");
        let b = root.join("b.jsonl");
        fs::write(&a, "{}\n").unwrap();
        fs::write(&b, "{}\n").unwrap();

        let lease_a = SessionLease::acquire(&root, a.to_str().unwrap()).unwrap();
        let lease_b = SessionLease::acquire(&root, b.to_str().unwrap());
        assert!(lease_b.is_ok(), "different session must not conflict");
        drop(lease_a);
        drop(lease_b);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fnv1a_is_stable_across_calls() {
        // 锁文件名必须逐位稳定：跨进程/跨版本一致性依赖这个常量输出。
        assert_eq!(fnv1a_64(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64("a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a_64("/tmp/x/e.jsonl"), fnv1a_64("/tmp/x/e.jsonl"));
        assert_ne!(fnv1a_64("/tmp/x/a.jsonl"), fnv1a_64("/tmp/x/b.jsonl"));
    }

    #[test]
    fn empty_session_path_rejected() {
        let root = temp_leases_root("empty");
        assert!(SessionLease::acquire(&root, "   ").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
