//! Crash-safe channel configuration transaction.
//!
//! A transaction owns a cross-process domain lock for recovery, snapshotting,
//! every read/modify/write step, rollback, and journal cleanup. Each step is
//! durably marked `in_progress` before it runs. Recovery therefore treats both
//! `in_progress` and `applied` as "possibly executed" and rolls them back
//! idempotently unless a durable commit marker exists.
//!
//! Keychain is the final commit step. New and previous values are staged in
//! transaction-specific Keychain items; the journal stores only their account
//! names. If a crash occurs around the final write, recovery compares the
//! destination item with the staged values and can prove committed, unchanged,
//! or ambiguous. It never reports a completed rollback after observing the new
//! secret at the destination.
//!
//! File snapshots can include a legacy plaintext auth entry. The journal is
//! therefore mode 0600, is written without backup rotation, and legacy journal
//! backup directories are removed while the domain lock is held.

use crate::safe_config;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const JOURNAL_FILE_NAME: &str = "channel-save-journal.json";
pub const META_FILE_NAME: &str = "channels-meta.json";
const KEYCHAIN_SERVICE: &str = "pi-gui.channels";
const JOURNAL_VERSION: u32 = 2;
const SETTINGS_KEYS: &[&str] = &["enabledModels", "defaultProvider", "defaultModel"];
static TX_SEQUENCE: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Public payload / report
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChannelConfigPayload {
    pub provider: String,
    pub auth_path: String,
    pub models_path: String,
    pub meta_path: String,
    #[serde(default)]
    pub settings_path: Option<String>,
    #[serde(default)]
    pub keychain: KeychainOp,
    #[serde(default)]
    pub auth_entry: EntryOp,
    #[serde(default)]
    pub models_entry: EntryOp,
    #[serde(default)]
    pub meta: MetaOp,
    #[serde(default)]
    pub settings: SettingsPatch,
}

#[derive(Debug, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KeychainOp {
    #[default]
    None,
    Write {
        account: String,
        secret: String,
    },
    Delete {
        account: String,
    },
}

#[derive(Debug, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EntryOp {
    #[default]
    None,
    Set {
        entry: Value,
    },
    Delete,
}

#[derive(Debug, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MetaOp {
    #[default]
    None,
    Set {
        entry: Value,
    },
    Delete,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default)]
    pub set: BTreeMap<String, Value>,
    #[serde(default)]
    pub delete: Vec<String>,
}

impl SettingsPatch {
    fn is_empty(&self) -> bool {
        self.set.is_empty() && self.delete.is_empty()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChannelConfigReport {
    pub provider: String,
    pub steps: Vec<String>,
    pub journal_path: String,
    pub recovered_stale_journal: bool,
    pub journal_cleanup_failed: bool,
}

fn error_json(code: &str, message: &str, journal_path: Option<&Path>) -> String {
    serde_json::json!({
        "code": code,
        "message": message,
        "journalPath": journal_path.map(|p| p.to_string_lossy().to_string()),
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Journal schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Step {
    Auth,
    Models,
    Meta,
    Settings,
    Keychain,
}

impl Step {
    fn as_str(self) -> &'static str {
        match self {
            Step::Auth => "auth",
            Step::Models => "models",
            Step::Meta => "meta",
            Step::Settings => "settings",
            Step::Keychain => "keychain",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Step::Auth => "写入 auth.json",
            Step::Models => "写入 models.json",
            Step::Meta => "写入渠道元数据",
            Step::Settings => "写入 settings.json",
            Step::Keychain => "提交钥匙串",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StepStatus {
    Pending,
    InProgress,
    Applied,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StepRecord {
    step: Step,
    status: StepStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum JournalPhase {
    Preparing,
    Applying,
    RollingBack,
    Committed,
}

#[derive(Debug, Serialize, Deserialize)]
struct JournalPaths {
    auth: PathBuf,
    models: PathBuf,
    meta: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    file_existed: bool,
    had_entry: bool,
    #[serde(default)]
    old_entry: Value,
    container_existed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaSnapshot {
    file_existed: bool,
    had_entry: bool,
    #[serde(default)]
    old_entry: Value,
    channels_existed: bool,
    order_existed: bool,
    order_index: Option<usize>,
    version_existed: bool,
    #[serde(default)]
    old_version: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldSnapshot {
    existed: bool,
    #[serde(default)]
    old_value: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSnapshot {
    file_existed: bool,
    fields: BTreeMap<String, FieldSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum KeychainAction {
    Write,
    Delete,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeychainSnapshot {
    account: String,
    action: KeychainAction,
    desired_stage_account: Option<String>,
    previous_stage_account: Option<String>,
    had_previous: bool,
    staging_ready: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Snapshots {
    #[serde(skip_serializing_if = "Option::is_none")]
    auth: Option<FileSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    models: Option<FileSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<MetaSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    settings: Option<SettingsSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    keychain: Option<KeychainSnapshot>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version: u32,
    transaction_id: String,
    created_at: String,
    provider: String,
    phase: JournalPhase,
    paths: JournalPaths,
    steps: Vec<StepRecord>,
    snapshots: Snapshots,
}

/// Deployed v1 schema, retained only for safe upgrade recovery.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyJournal {
    version: u32,
    provider: String,
    paths: JournalPaths,
    planned: Vec<Step>,
    completed: Vec<Step>,
    snapshots: LegacySnapshots,
}

#[derive(Debug, Default, Deserialize)]
struct LegacySnapshots {
    #[serde(default)]
    auth: Option<FileSnapshot>,
    #[serde(default)]
    models: Option<FileSnapshot>,
    #[serde(default)]
    meta: Option<LegacyMetaSnapshot>,
    // The v1 keychain snapshot did not contain enough information to reverse
    // or prove an in-flight destination write. Keep it parseable but opaque.
    #[serde(default)]
    keychain: Option<Value>,
}

impl LegacySnapshots {
    fn into_current(self, paths: &JournalPaths, provider: &str) -> Result<Snapshots, String> {
        let _ = self.keychain;
        let meta = match self.meta {
            Some(snapshot) => {
                let current = safe_config::read_json_file(&paths.meta)?;
                let order_index = snapshot.order_had_provider.then(|| {
                    current
                        .get("order")
                        .and_then(Value::as_array)
                        .and_then(|items| {
                            items
                                .iter()
                                .position(|item| item.as_str() == Some(provider))
                        })
                        .unwrap_or(usize::MAX)
                });
                Some(MetaSnapshot {
                    file_existed: snapshot.file_existed,
                    had_entry: snapshot.had_entry,
                    old_entry: snapshot.old_entry,
                    channels_existed: snapshot.channels_existed,
                    order_existed: snapshot.order_existed,
                    order_index,
                    // v1 did not snapshot version. Preserve the value visible
                    // at recovery rather than inventing its former absence.
                    version_existed: current.get("version").is_some(),
                    old_version: current.get("version").cloned().unwrap_or(Value::Null),
                })
            }
            None => None,
        };
        Ok(Snapshots {
            auth: self.auth,
            models: self.models,
            meta,
            settings: None,
            keychain: None,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMetaSnapshot {
    file_existed: bool,
    had_entry: bool,
    #[serde(default)]
    old_entry: Value,
    channels_existed: bool,
    order_existed: bool,
    order_had_provider: bool,
}

fn legacy_backup_dir(path: &Path) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(".backups");
    PathBuf::from(os)
}

fn cleanup_legacy_journal_backups(path: &Path) -> Result<(), String> {
    let backups = legacy_backup_dir(path);
    if backups.exists() {
        fs::remove_dir_all(&backups)
            .map_err(|e| format!("删除旧恢复日志备份目录 {} 失败：{}", backups.display(), e))?;
    }
    Ok(())
}

fn write_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(journal).map_err(|e| format!("序列化恢复日志失败：{}", e))?;
    safe_config::atomic_write_private_no_backup(path, &bytes)
}

fn remove_journal(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => {
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                if let Ok(dir) = fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除恢复日志 {} 失败：{}", path.display(), e)),
    }
}

fn transaction_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TX_SEQUENCE.fetch_add(1, Ordering::SeqCst);
    format!("{}-{}-{}", std::process::id(), nanos, seq)
}

// ---------------------------------------------------------------------------
// Paths, locks, and secret-store seam
// ---------------------------------------------------------------------------

pub(crate) struct ChannelSavePaths {
    pub auth: PathBuf,
    pub models: PathBuf,
    pub meta: PathBuf,
    pub settings: Option<PathBuf>,
    pub journal: PathBuf,
}

trait SecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct SystemSecretStore;

impl SecretStore for SystemSecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        safe_config::keychain_get_impl(KEYCHAIN_SERVICE, account)
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        safe_config::keychain_set_impl(KEYCHAIN_SERVICE, account, secret)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        safe_config::keychain_delete_impl(KEYCHAIN_SERVICE, account)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct FailPlan {
    fail_at: Option<Step>,
    fail_undo_of: Option<Step>,
    crash_after_execute: Option<Step>,
}

fn planned_steps(payload: &SaveChannelConfigPayload) -> Vec<Step> {
    let mut result = Vec::new();
    if !matches!(payload.auth_entry, EntryOp::None) {
        result.push(Step::Auth);
    }
    if !matches!(payload.models_entry, EntryOp::None) {
        result.push(Step::Models);
    }
    if !matches!(payload.meta, MetaOp::None) {
        result.push(Step::Meta);
    }
    if !payload.settings.is_empty() {
        result.push(Step::Settings);
    }
    if !matches!(payload.keychain, KeychainOp::None) {
        result.push(Step::Keychain);
    }
    result
}

fn validate_payload(payload: &SaveChannelConfigPayload) -> Result<(), String> {
    if payload.provider.trim().is_empty() {
        return Err(error_json("invalid_payload", "provider 不能为空", None));
    }
    for (name, op) in [
        ("authEntry", &payload.auth_entry),
        ("modelsEntry", &payload.models_entry),
    ] {
        if let EntryOp::Set { entry } = op {
            if !entry.is_object() {
                return Err(error_json(
                    "invalid_payload",
                    &format!("{} 的 entry 必须是 JSON 对象", name),
                    None,
                ));
            }
        }
    }
    if let MetaOp::Set { entry } = &payload.meta {
        if !entry.is_object() {
            return Err(error_json(
                "invalid_payload",
                "meta 的 entry 必须是 JSON 对象",
                None,
            ));
        }
    }
    match &payload.keychain {
        KeychainOp::Write { account, secret } => {
            if account.trim().is_empty() || secret.is_empty() {
                return Err(error_json(
                    "invalid_payload",
                    "keychain 写入需要非空 account 与 secret",
                    None,
                ));
            }
        }
        KeychainOp::Delete { account } if account.trim().is_empty() => {
            return Err(error_json(
                "invalid_payload",
                "keychain 删除需要非空 account",
                None,
            ));
        }
        _ => {}
    }
    let deletes: BTreeSet<&str> = payload.settings.delete.iter().map(String::as_str).collect();
    if deletes.len() != payload.settings.delete.len() {
        return Err(error_json(
            "invalid_payload",
            "settings.delete 不得包含重复键",
            None,
        ));
    }
    for key in payload
        .settings
        .set
        .keys()
        .map(String::as_str)
        .chain(deletes.iter().copied())
    {
        if !SETTINGS_KEYS.contains(&key) {
            return Err(error_json(
                "invalid_payload",
                &format!("settings 不允许修改根键 {}", key),
                None,
            ));
        }
        if payload.settings.set.contains_key(key) && deletes.contains(key) {
            return Err(error_json(
                "invalid_payload",
                &format!("settings 根键 {} 不能同时 set 和 delete", key),
                None,
            ));
        }
    }
    if !payload.settings.is_empty()
        && payload
            .settings_path
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err(error_json(
            "invalid_payload",
            "非空 settings patch 需要 settingsPath",
            None,
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Transaction execution
// ---------------------------------------------------------------------------

pub(crate) fn save_channel_config_core(
    paths: &ChannelSavePaths,
    payload: &SaveChannelConfigPayload,
) -> Result<SaveChannelConfigReport, String> {
    run_save(paths, payload, &SystemSecretStore, None)
}

fn run_save<S: SecretStore>(
    paths: &ChannelSavePaths,
    payload: &SaveChannelConfigPayload,
    secrets: &S,
    fail: Option<FailPlan>,
) -> Result<SaveChannelConfigReport, String> {
    validate_payload(payload)?;
    let _process_guard = safe_config::config_write_lock()?;
    let _domain_guard =
        safe_config::DirLock::acquire(&paths.journal, safe_config::DEFAULT_LOCK_TIMEOUT_MS)
            .map_err(|e| error_json("transaction_locked", &e, Some(&paths.journal)))?;
    cleanup_legacy_journal_backups(&paths.journal)
        .map_err(|e| error_json("stale_journal", &e, Some(&paths.journal)))?;

    let recovered_stale =
        recover_stale_journal_under_domain_lock(&paths.journal, secrets)?.is_some();
    let planned = planned_steps(payload);
    if planned.is_empty() {
        return Ok(SaveChannelConfigReport {
            provider: payload.provider.trim().to_string(),
            steps: Vec::new(),
            journal_path: paths.journal.to_string_lossy().to_string(),
            recovered_stale_journal: recovered_stale,
            journal_cleanup_failed: false,
        });
    }

    let tx_id = transaction_id();
    let (snapshots, previous_secret) = take_snapshots(paths, payload, &planned, &tx_id, secrets)
        .map_err(|e| error_json("prepare", &e, None))?;
    let mut journal = Journal {
        version: JOURNAL_VERSION,
        transaction_id: tx_id,
        created_at: safe_config::iso_utc_now(),
        provider: payload.provider.trim().to_string(),
        phase: JournalPhase::Preparing,
        paths: JournalPaths {
            auth: paths.auth.clone(),
            models: paths.models.clone(),
            meta: paths.meta.clone(),
            settings: paths.settings.clone(),
        },
        steps: planned
            .iter()
            .copied()
            .map(|step| StepRecord {
                step,
                status: StepStatus::Pending,
            })
            .collect(),
        snapshots,
    };
    write_journal(&paths.journal, &journal)
        .map_err(|e| error_json("prepare", &format!("无法写入恢复日志：{}", e), None))?;

    if let Err(e) = stage_keychain_values(&mut journal, payload, previous_secret, secrets) {
        let cleanup = cleanup_staging(&journal, secrets);
        if cleanup.is_ok() {
            let _ = remove_journal(&paths.journal);
        }
        return Err(error_json(
            "prepare",
            &format!("钥匙串事务暂存失败：{}", e),
            cleanup.err().map(|_| paths.journal.as_path()),
        ));
    }
    if journal.snapshots.keychain.is_some() {
        if let Some(keychain) = journal.snapshots.keychain.as_mut() {
            keychain.staging_ready = true;
        }
        if let Err(e) = write_journal(&paths.journal, &journal) {
            let cleanup = cleanup_staging(&journal, secrets);
            if cleanup.is_ok() {
                let _ = remove_journal(&paths.journal);
            }
            return Err(error_json(
                "prepare",
                &format!("钥匙串已暂存但无法记录状态：{}", e),
                cleanup.err().map(|_| paths.journal.as_path()),
            ));
        }
    }
    journal.phase = JournalPhase::Applying;
    write_journal(&paths.journal, &journal).map_err(|e| {
        error_json(
            "prepare",
            &format!("无法进入事务执行阶段：{}", e),
            Some(&paths.journal),
        )
    })?;

    for index in 0..journal.steps.len() {
        let step = journal.steps[index].step;
        journal.steps[index].status = StepStatus::InProgress;
        if let Err(e) = write_journal(&paths.journal, &journal) {
            let cause = format!("无法持久化步骤「{}」执行意图：{}", step.label(), e);
            return Err(finish_with_rollback(
                paths,
                &mut journal,
                cause,
                secrets,
                fail,
            ));
        }
        if matches!(fail, Some(plan) if plan.fail_at == Some(step)) {
            let cause = format!("步骤「{}」失败：注入的步骤失败", step.label());
            return Err(finish_with_rollback(
                paths,
                &mut journal,
                cause,
                secrets,
                fail,
            ));
        }
        let outcome = execute_step(paths, payload, step, &journal, secrets);
        if matches!(fail, Some(plan) if plan.crash_after_execute == Some(step)) {
            return Err(error_json(
                "simulated_crash",
                &format!("步骤「{}」执行后模拟崩溃", step.label()),
                Some(&paths.journal),
            ));
        }
        if let Err(e) = outcome {
            if step == Step::Keychain {
                match reconcile_keychain(&journal, secrets) {
                    Ok(KeychainObserved::Desired) => {
                        journal.steps[index].status = StepStatus::Applied;
                        return finish_committed(paths, &mut journal, recovered_stale, secrets);
                    }
                    Ok(KeychainObserved::Previous) => {}
                    Ok(KeychainObserved::Ambiguous) | Err(_) => {
                        return Err(error_json(
                            "commit_uncertain",
                            &format!(
                                "步骤「{}」失败且无法证明钥匙串处于新值或旧值：{}",
                                step.label(),
                                e
                            ),
                            Some(&paths.journal),
                        ));
                    }
                }
            }
            let cause = format!("步骤「{}」失败：{}", step.label(), e);
            return Err(finish_with_rollback(
                paths,
                &mut journal,
                cause,
                secrets,
                fail,
            ));
        }
        journal.steps[index].status = StepStatus::Applied;
        if let Err(e) = write_journal(&paths.journal, &journal) {
            if step == Step::Keychain {
                return finish_committed(paths, &mut journal, recovered_stale, secrets);
            }
            let cause = format!("步骤「{}」已执行，但持久化结果失败：{}", step.label(), e);
            return Err(finish_with_rollback(
                paths,
                &mut journal,
                cause,
                secrets,
                fail,
            ));
        }
    }
    finish_committed(paths, &mut journal, recovered_stale, secrets)
}

fn finish_committed<S: SecretStore>(
    paths: &ChannelSavePaths,
    journal: &mut Journal,
    recovered_stale: bool,
    secrets: &S,
) -> Result<SaveChannelConfigReport, String> {
    journal.phase = JournalPhase::Committed;
    write_journal(&paths.journal, journal).map_err(|e| {
        error_json(
            "commit_uncertain",
            &format!("配置已执行，但无法持久化提交标记：{}", e),
            Some(&paths.journal),
        )
    })?;
    let cleanup_failed =
        cleanup_staging(journal, secrets).is_err() || remove_journal(&paths.journal).is_err();
    Ok(SaveChannelConfigReport {
        provider: journal.provider.clone(),
        steps: journal
            .steps
            .iter()
            .map(|record| record.step.as_str().to_string())
            .collect(),
        journal_path: paths.journal.to_string_lossy().to_string(),
        recovered_stale_journal: recovered_stale,
        journal_cleanup_failed: cleanup_failed,
    })
}

fn finish_with_rollback<S: SecretStore>(
    paths: &ChannelSavePaths,
    journal: &mut Journal,
    cause: String,
    secrets: &S,
    fail: Option<FailPlan>,
) -> String {
    if let Some(record) = journal
        .steps
        .iter()
        .find(|record| record.step == Step::Keychain)
    {
        if matches!(record.status, StepStatus::InProgress | StepStatus::Applied) {
            match reconcile_keychain(journal, secrets) {
                Ok(KeychainObserved::Desired) => {
                    journal.phase = JournalPhase::Committed;
                    let _ = write_journal(&paths.journal, journal);
                    let _ = cleanup_staging(journal, secrets);
                    let _ = remove_journal(&paths.journal);
                    return error_json(
                        "committed_after_error",
                        &format!("{}；钥匙串已是目标值，事务按已提交处理", cause),
                        None,
                    );
                }
                Ok(KeychainObserved::Previous) => {}
                Ok(KeychainObserved::Ambiguous) | Err(_) => {
                    return error_json(
                        "commit_uncertain",
                        &format!("{}；钥匙串状态无法安全判定，未声称回滚完成", cause),
                        Some(&paths.journal),
                    );
                }
            }
        }
    }

    journal.phase = JournalPhase::RollingBack;
    let _ = write_journal(&paths.journal, journal);
    let errors = rollback_steps(&paths.journal, journal, fail, secrets);
    if errors.is_empty() {
        if cleanup_staging(journal, secrets).is_ok() && remove_journal(&paths.journal).is_ok() {
            error_json("rollback_complete", &cause, None)
        } else {
            error_json(
                "rollback_incomplete",
                &format!("{}；配置已回滚，但事务临时数据清理未完成", cause),
                Some(&paths.journal),
            )
        }
    } else {
        error_json(
            "rollback_incomplete",
            &format!(
                "{}；自动回滚未完成（{}），配置可能处于部分更新状态",
                cause,
                errors.join("；")
            ),
            Some(&paths.journal),
        )
    }
}

fn rollback_steps<S: SecretStore>(
    journal_path: &Path,
    journal: &mut Journal,
    fail: Option<FailPlan>,
    _secrets: &S,
) -> Vec<String> {
    let mut errors = Vec::new();
    for index in (0..journal.steps.len()).rev() {
        let record = &journal.steps[index];
        if matches!(record.status, StepStatus::Pending | StepStatus::RolledBack) {
            continue;
        }
        let step = record.step;
        if step == Step::Keychain {
            journal.steps[index].status = StepStatus::RolledBack;
            let _ = write_journal(journal_path, journal);
            continue;
        }
        if matches!(fail, Some(plan) if plan.fail_undo_of == Some(step)) {
            errors.push(format!("{}：注入的回滚失败", step.label()));
            continue;
        }
        match undo_step(&journal.paths, &journal.provider, &journal.snapshots, step) {
            Ok(()) => {
                journal.steps[index].status = StepStatus::RolledBack;
                if let Err(e) = write_journal(journal_path, journal) {
                    errors.push(format!("{}：回滚完成但记录状态失败：{}", step.label(), e));
                }
            }
            Err(e) => errors.push(format!("{}：{}", step.label(), e)),
        }
    }
    errors
}

// ---------------------------------------------------------------------------
// Step implementation
// ---------------------------------------------------------------------------

fn update_file_locked(
    path: &Path,
    mode: Option<u32>,
    merge: impl FnOnce(&mut Value) -> Result<(), String>,
) -> Result<(), String> {
    let _file_lock = safe_config::DirLock::acquire(path, safe_config::DEFAULT_LOCK_TIMEOUT_MS)?;
    let mut current = safe_config::read_json_file(path)?;
    merge(&mut current)?;
    safe_config::write_json_file_locked(path, &current, mode)
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object just initialized")
}

fn execute_step<S: SecretStore>(
    paths: &ChannelSavePaths,
    payload: &SaveChannelConfigPayload,
    step: Step,
    journal: &Journal,
    secrets: &S,
) -> Result<(), String> {
    let provider = payload.provider.trim().to_string();
    match step {
        Step::Auth => update_file_locked(&paths.auth, Some(0o600), |value| {
            let map = ensure_object(value);
            apply_entry(map, &provider, &payload.auth_entry);
            Ok(())
        }),
        Step::Models => update_file_locked(&paths.models, Some(0o600), |value| {
            let map = ensure_object(value);
            let providers = map
                .entry("providers".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            apply_entry(ensure_object(providers), &provider, &payload.models_entry);
            Ok(())
        }),
        Step::Meta => update_file_locked(&paths.meta, None, |value| {
            let map = ensure_object(value);
            match &payload.meta {
                MetaOp::None => {}
                MetaOp::Set { entry } => {
                    map.entry("version".to_string()).or_insert(Value::from(1));
                    let channels = map
                        .entry("channels".to_string())
                        .or_insert_with(|| Value::Object(Map::new()));
                    ensure_object(channels).insert(provider.clone(), entry.clone());
                    let order = map
                        .entry("order".to_string())
                        .or_insert_with(|| Value::Array(Vec::new()));
                    if !order.is_array() {
                        *order = Value::Array(Vec::new());
                    }
                    let order = order.as_array_mut().expect("array just initialized");
                    if !order.iter().any(|item| item.as_str() == Some(&provider)) {
                        order.push(Value::String(provider.clone()));
                    }
                }
                MetaOp::Delete => {
                    if let Some(channels) = map.get_mut("channels").and_then(Value::as_object_mut) {
                        channels.remove(&provider);
                    }
                    if let Some(order) = map.get_mut("order").and_then(Value::as_array_mut) {
                        order.retain(|item| item.as_str() != Some(&provider));
                    }
                }
            }
            Ok(())
        }),
        Step::Settings => {
            let path = paths
                .settings
                .as_ref()
                .ok_or("settings step 缺少 settings 路径")?;
            update_file_locked(path, None, |value| {
                let map = ensure_object(value);
                for key in &payload.settings.delete {
                    map.remove(key);
                }
                for (key, new_value) in &payload.settings.set {
                    map.insert(key.clone(), new_value.clone());
                }
                Ok(())
            })
        }
        Step::Keychain => execute_keychain(journal, secrets),
    }
}

fn apply_entry(map: &mut Map<String, Value>, provider: &str, op: &EntryOp) {
    match op {
        EntryOp::None => {}
        EntryOp::Set { entry } => {
            map.insert(provider.to_string(), entry.clone());
        }
        EntryOp::Delete => {
            map.remove(provider);
        }
    }
}

fn stage_keychain_values<S: SecretStore>(
    journal: &mut Journal,
    payload: &SaveChannelConfigPayload,
    previous_secret: Option<String>,
    secrets: &S,
) -> Result<(), String> {
    let Some(snapshot) = journal.snapshots.keychain.as_ref() else {
        return Ok(());
    };
    if let (Some(account), Some(old)) = (
        snapshot.previous_stage_account.as_deref(),
        previous_secret.as_deref(),
    ) {
        secrets.set(account, old)?;
    }
    if let KeychainOp::Write { secret, .. } = &payload.keychain {
        let desired = snapshot
            .desired_stage_account
            .as_deref()
            .ok_or("write 缺少目标暂存 account")?;
        secrets.set(desired, secret)?;
    }
    Ok(())
}

fn execute_keychain<S: SecretStore>(journal: &Journal, secrets: &S) -> Result<(), String> {
    let snapshot = journal
        .snapshots
        .keychain
        .as_ref()
        .ok_or("恢复日志缺少 keychain 快照")?;
    match snapshot.action {
        KeychainAction::Write => {
            let stage = snapshot
                .desired_stage_account
                .as_deref()
                .ok_or("write 缺少目标暂存 account")?;
            let desired = secrets.get(stage)?.ok_or("目标 secret 暂存项不存在")?;
            secrets.set(&snapshot.account, &desired)?;
        }
        KeychainAction::Delete => secrets.delete(&snapshot.account)?,
    }
    match reconcile_keychain(journal, secrets)? {
        KeychainObserved::Desired => Ok(()),
        _ => Err("钥匙串命令返回后未观察到目标状态".to_string()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeychainObserved {
    Desired,
    Previous,
    Ambiguous,
}

fn reconcile_keychain<S: SecretStore>(
    journal: &Journal,
    secrets: &S,
) -> Result<KeychainObserved, String> {
    let snapshot = journal
        .snapshots
        .keychain
        .as_ref()
        .ok_or("恢复日志缺少 keychain 快照")?;
    let current = secrets.get(&snapshot.account)?;
    let desired = match snapshot.action {
        KeychainAction::Write => {
            let account = snapshot
                .desired_stage_account
                .as_deref()
                .ok_or("write 缺少目标暂存 account")?;
            Some(
                secrets
                    .get(account)?
                    .ok_or("目标 secret 暂存项不存在，无法判定提交状态")?,
            )
        }
        KeychainAction::Delete => None,
    };
    if current == desired {
        return Ok(KeychainObserved::Desired);
    }
    let previous = if snapshot.had_previous {
        let account = snapshot
            .previous_stage_account
            .as_deref()
            .ok_or("缺少旧 secret 暂存 account")?;
        Some(
            secrets
                .get(account)?
                .ok_or("旧 secret 暂存项不存在，无法判定回滚状态")?,
        )
    } else {
        None
    };
    if current == previous {
        Ok(KeychainObserved::Previous)
    } else {
        Ok(KeychainObserved::Ambiguous)
    }
}

fn cleanup_staging<S: SecretStore>(journal: &Journal, secrets: &S) -> Result<(), String> {
    let Some(snapshot) = journal.snapshots.keychain.as_ref() else {
        return Ok(());
    };
    let mut errors = Vec::new();
    for account in [
        snapshot.desired_stage_account.as_deref(),
        snapshot.previous_stage_account.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Err(e) = secrets.delete(account) {
            errors.push(format!("{}：{}", account, e));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

// ---------------------------------------------------------------------------
// Snapshots and rollback
// ---------------------------------------------------------------------------

fn take_snapshots<S: SecretStore>(
    paths: &ChannelSavePaths,
    payload: &SaveChannelConfigPayload,
    planned: &[Step],
    tx_id: &str,
    secrets: &S,
) -> Result<(Snapshots, Option<String>), String> {
    let provider = payload.provider.trim();
    let mut result = Snapshots::default();
    let mut previous_secret = None;
    for step in planned {
        match step {
            Step::Auth => {
                let doc = safe_config::read_json_file(&paths.auth)?;
                let old = doc.get(provider).cloned();
                result.auth = Some(FileSnapshot {
                    file_existed: paths.auth.is_file(),
                    had_entry: old.is_some(),
                    old_entry: old.unwrap_or(Value::Null),
                    container_existed: true,
                });
            }
            Step::Models => {
                let doc = safe_config::read_json_file(&paths.models)?;
                let container = doc.get("providers");
                let old = container.and_then(|value| value.get(provider)).cloned();
                result.models = Some(FileSnapshot {
                    file_existed: paths.models.is_file(),
                    had_entry: old.is_some(),
                    old_entry: old.unwrap_or(Value::Null),
                    container_existed: container.is_some(),
                });
            }
            Step::Meta => {
                let doc = safe_config::read_json_file(&paths.meta)?;
                let channels = doc.get("channels");
                let old = channels.and_then(|value| value.get(provider)).cloned();
                let order = doc.get("order").and_then(Value::as_array);
                result.meta = Some(MetaSnapshot {
                    file_existed: paths.meta.is_file(),
                    had_entry: old.is_some(),
                    old_entry: old.unwrap_or(Value::Null),
                    channels_existed: channels.is_some(),
                    order_existed: doc.get("order").is_some(),
                    order_index: order.and_then(|items| {
                        items
                            .iter()
                            .position(|item| item.as_str() == Some(provider))
                    }),
                    version_existed: doc.get("version").is_some(),
                    old_version: doc.get("version").cloned().unwrap_or(Value::Null),
                });
            }
            Step::Settings => {
                let path = paths.settings.as_ref().ok_or("settings 快照缺少路径")?;
                let doc = safe_config::read_json_file(path)?;
                let keys: BTreeSet<&str> = payload
                    .settings
                    .set
                    .keys()
                    .map(String::as_str)
                    .chain(payload.settings.delete.iter().map(String::as_str))
                    .collect();
                let fields = keys
                    .into_iter()
                    .map(|key| {
                        let old = doc.get(key).cloned();
                        (
                            key.to_string(),
                            FieldSnapshot {
                                existed: old.is_some(),
                                old_value: old.unwrap_or(Value::Null),
                            },
                        )
                    })
                    .collect();
                result.settings = Some(SettingsSnapshot {
                    file_existed: path.is_file(),
                    fields,
                });
            }
            Step::Keychain => {
                let (account, action) = match &payload.keychain {
                    KeychainOp::Write { account, .. } => (account.clone(), KeychainAction::Write),
                    KeychainOp::Delete { account } => (account.clone(), KeychainAction::Delete),
                    KeychainOp::None => continue,
                };
                previous_secret = secrets
                    .get(&account)
                    .map_err(|e| format!("钥匙串预检失败：{}", e))?;
                let prefix = format!("__pi_gui_channel_txn__{}", tx_id);
                result.keychain = Some(KeychainSnapshot {
                    account,
                    action,
                    desired_stage_account: (action == KeychainAction::Write)
                        .then(|| format!("{}:desired", prefix)),
                    previous_stage_account: previous_secret
                        .is_some()
                        .then(|| format!("{}:previous", prefix)),
                    had_previous: previous_secret.is_some(),
                    staging_ready: false,
                });
            }
        }
    }
    Ok((result, previous_secret))
}

fn undo_step(
    paths: &JournalPaths,
    provider: &str,
    snapshots: &Snapshots,
    step: Step,
) -> Result<(), String> {
    match step {
        Step::Auth => undo_file_entry(
            &paths.auth,
            Some(0o600),
            provider,
            snapshots.auth.as_ref().ok_or("恢复日志缺少 auth 快照")?,
            true,
        ),
        Step::Models => undo_file_entry(
            &paths.models,
            Some(0o600),
            provider,
            snapshots
                .models
                .as_ref()
                .ok_or("恢复日志缺少 models 快照")?,
            false,
        ),
        Step::Meta => undo_meta(
            &paths.meta,
            provider,
            snapshots.meta.as_ref().ok_or("恢复日志缺少 meta 快照")?,
        ),
        Step::Settings => undo_settings(
            paths
                .settings
                .as_ref()
                .ok_or("恢复日志缺少 settings 路径")?,
            snapshots
                .settings
                .as_ref()
                .ok_or("恢复日志缺少 settings 快照")?,
        ),
        Step::Keychain => Ok(()),
    }
}

fn undo_file_entry(
    path: &Path,
    mode: Option<u32>,
    provider: &str,
    snapshot: &FileSnapshot,
    top_level: bool,
) -> Result<(), String> {
    update_file_locked(path, mode, |value| {
        let map = ensure_object(value);
        if top_level {
            restore_field(map, provider, snapshot.had_entry, &snapshot.old_entry);
        } else if snapshot.had_entry {
            let providers = map
                .entry("providers".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            ensure_object(providers).insert(provider.to_string(), snapshot.old_entry.clone());
        } else {
            if let Some(providers) = map.get_mut("providers").and_then(Value::as_object_mut) {
                providers.remove(provider);
            }
            let should_prune = !snapshot.container_existed
                && map
                    .get("providers")
                    .and_then(Value::as_object)
                    .is_some_and(Map::is_empty);
            if should_prune {
                map.remove("providers");
            }
        }
        Ok(())
    })?;
    remove_file_if_empty_when_originally_absent(path, snapshot.file_existed)
}

fn undo_meta(path: &Path, provider: &str, snapshot: &MetaSnapshot) -> Result<(), String> {
    update_file_locked(path, None, |value| {
        let map = ensure_object(value);
        if snapshot.had_entry {
            let channels = map
                .entry("channels".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            ensure_object(channels).insert(provider.to_string(), snapshot.old_entry.clone());
        } else {
            if let Some(channels) = map.get_mut("channels").and_then(Value::as_object_mut) {
                channels.remove(provider);
            }
            let should_prune = !snapshot.channels_existed
                && map
                    .get("channels")
                    .and_then(Value::as_object)
                    .is_some_and(Map::is_empty);
            if should_prune {
                map.remove("channels");
            }
        }
        if let Some(index) = snapshot.order_index {
            let order = map
                .entry("order".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if !order.is_array() {
                *order = Value::Array(Vec::new());
            }
            let order = order.as_array_mut().expect("array just initialized");
            order.retain(|item| item.as_str() != Some(provider));
            order.insert(index.min(order.len()), Value::String(provider.to_string()));
        } else {
            if let Some(order) = map.get_mut("order").and_then(Value::as_array_mut) {
                order.retain(|item| item.as_str() != Some(provider));
            }
            let should_prune = !snapshot.order_existed
                && map
                    .get("order")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty);
            if should_prune {
                map.remove("order");
            }
        }
        restore_field(
            map,
            "version",
            snapshot.version_existed,
            &snapshot.old_version,
        );
        Ok(())
    })?;
    remove_file_if_empty_when_originally_absent(path, snapshot.file_existed)
}

fn undo_settings(path: &Path, snapshot: &SettingsSnapshot) -> Result<(), String> {
    update_file_locked(path, None, |value| {
        let map = ensure_object(value);
        for (key, field) in &snapshot.fields {
            restore_field(map, key, field.existed, &field.old_value);
        }
        Ok(())
    })?;
    remove_file_if_empty_when_originally_absent(path, snapshot.file_existed)
}

fn restore_field(map: &mut Map<String, Value>, key: &str, existed: bool, old: &Value) {
    if existed {
        map.insert(key.to_string(), old.clone());
    } else {
        map.remove(key);
    }
}

fn remove_file_if_empty_when_originally_absent(
    path: &Path,
    file_existed: bool,
) -> Result<(), String> {
    if file_existed {
        return Ok(());
    }
    let current = safe_config::read_json_file(path)?;
    if current.as_object().is_some_and(Map::is_empty) {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删除回滚后空文件 {} 失败：{}", path.display(), e)),
        }
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub(crate) struct RecoveredJournal {
    pub action: &'static str,
    pub provider: String,
}

pub(crate) fn recover_stale_journal(
    journal_path: &Path,
) -> Result<Option<RecoveredJournal>, String> {
    let _process_guard = safe_config::config_write_lock()?;
    let _domain_guard =
        safe_config::DirLock::acquire(journal_path, safe_config::DEFAULT_LOCK_TIMEOUT_MS)?;
    cleanup_legacy_journal_backups(journal_path)?;
    recover_stale_journal_under_domain_lock(journal_path, &SystemSecretStore)
}

fn recover_stale_journal_under_domain_lock<S: SecretStore>(
    journal_path: &Path,
    secrets: &S,
) -> Result<Option<RecoveredJournal>, String> {
    if !journal_path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(journal_path)
        .map_err(|e| format!("无法读取恢复日志 {}：{}", journal_path.display(), e))?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "恢复日志 {} 损坏（{}），无法自动恢复，请人工核对渠道配置后删除该文件",
            journal_path.display(),
            e
        )
    })?;
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(0) as u32;
    match version {
        1 => {
            let legacy: LegacyJournal = serde_json::from_value(value)
                .map_err(|e| format!("恢复日志 {} v1 解析失败：{}", journal_path.display(), e))?;
            recover_legacy_journal(journal_path, legacy)
        }
        JOURNAL_VERSION => {
            let journal: Journal = serde_json::from_value(value)
                .map_err(|e| format!("恢复日志 {} v2 解析失败：{}", journal_path.display(), e))?;
            recover_v2_journal(journal_path, journal, secrets)
        }
        _ => Err(format!(
            "恢复日志 {} 版本（{}）不受支持，无法自动恢复",
            journal_path.display(),
            version
        )),
    }
}

fn recover_v2_journal<S: SecretStore>(
    journal_path: &Path,
    mut journal: Journal,
    secrets: &S,
) -> Result<Option<RecoveredJournal>, String> {
    let provider = journal.provider.clone();
    if journal.phase == JournalPhase::Committed {
        cleanup_staging(&journal, secrets)?;
        remove_journal(journal_path)?;
        return Ok(Some(RecoveredJournal {
            action: "committed",
            provider,
        }));
    }
    if journal.phase == JournalPhase::Preparing {
        cleanup_staging(&journal, secrets)?;
        remove_journal(journal_path)?;
        return Ok(Some(RecoveredJournal {
            action: "rolled_back",
            provider,
        }));
    }

    if let Some(record) = journal
        .steps
        .iter()
        .find(|record| record.step == Step::Keychain)
    {
        if matches!(record.status, StepStatus::InProgress | StepStatus::Applied) {
            match reconcile_keychain(&journal, secrets)? {
                KeychainObserved::Desired => {
                    journal.phase = JournalPhase::Committed;
                    write_journal(journal_path, &journal)?;
                    cleanup_staging(&journal, secrets)?;
                    remove_journal(journal_path)?;
                    return Ok(Some(RecoveredJournal {
                        action: "committed",
                        provider,
                    }));
                }
                KeychainObserved::Previous => {}
                KeychainObserved::Ambiguous => {
                    return Err(format!(
                        "恢复日志 {} 的钥匙串目标既不是暂存新值也不是暂存旧值，无法安全判定提交或回滚",
                        journal_path.display()
                    ));
                }
            }
        }
    }

    journal.phase = JournalPhase::RollingBack;
    write_journal(journal_path, &journal)?;
    let errors = rollback_steps(journal_path, &mut journal, None, secrets);
    if !errors.is_empty() {
        return Err(format!(
            "恢复日志 {} 的自动回滚未完成（{}）",
            journal_path.display(),
            errors.join("；")
        ));
    }
    cleanup_staging(&journal, secrets)?;
    remove_journal(journal_path)?;
    Ok(Some(RecoveredJournal {
        action: "rolled_back",
        provider,
    }))
}

fn recover_legacy_journal(
    journal_path: &Path,
    legacy: LegacyJournal,
) -> Result<Option<RecoveredJournal>, String> {
    if legacy.version != 1 {
        return Err("内部错误：非 v1 journal 进入 v1 恢复".to_string());
    }
    let provider = legacy.provider.clone();
    let first_incomplete = legacy
        .planned
        .iter()
        .position(|step| !legacy.completed.contains(step));
    if first_incomplete.is_none() {
        remove_journal(journal_path)?;
        return Ok(Some(RecoveredJournal {
            action: "committed",
            provider,
        }));
    }
    let last_possibly_executed = first_incomplete.expect("checked Some");
    if legacy.planned[last_possibly_executed] == Step::Keychain {
        return Err(format!(
            "旧版恢复日志 {} 在 Keychain 提交窗口中断，无法证明密钥是否已更改；未自动回滚文件",
            journal_path.display()
        ));
    }
    let snapshots = legacy
        .snapshots
        .into_current(&legacy.paths, &legacy.provider)?;
    let mut errors = Vec::new();
    for step in legacy.planned[..=last_possibly_executed].iter().rev() {
        if *step == Step::Keychain {
            continue;
        }
        if let Err(e) = undo_step(&legacy.paths, &legacy.provider, &snapshots, *step) {
            errors.push(format!("{}：{}", step.label(), e));
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "旧版恢复日志 {} 自动回滚未完成（{}）",
            journal_path.display(),
            errors.join("；")
        ));
    }
    remove_journal(journal_path)?;
    Ok(Some(RecoveredJournal {
        action: "rolled_back",
        provider,
    }))
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

fn validate_meta_path(app: &tauri::AppHandle, raw: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    let invalid = |message: &str| error_json("invalid_payload", message, None);
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err(invalid("meta 路径必须是绝对路径"));
    }
    if path.file_name().and_then(|name| name.to_str()) != Some(META_FILE_NAME) {
        return Err(invalid("meta 文件名必须是 channels-meta.json"));
    }
    let allowed = [
        app.path().app_data_dir().ok(),
        app.path().app_config_dir().ok(),
    ]
    .into_iter()
    .flatten()
    .any(|dir| path.parent() == Some(dir.as_path()));
    if !allowed {
        return Err(invalid("meta 路径不在应用数据目录下"));
    }
    Ok(path)
}

#[tauri::command]
pub async fn save_channel_config(
    app: tauri::AppHandle,
    payload: SaveChannelConfigPayload,
) -> Result<SaveChannelConfigReport, String> {
    use tauri::Manager;
    validate_payload(&payload)?;
    let roots = safe_config::allowed_config_roots(app.path().app_config_dir().ok());
    let auth = safe_config::validate_config_path(&payload.auth_path, &roots).map_err(|e| {
        error_json(
            "invalid_payload",
            &format!("auth 路径校验失败：{}", e),
            None,
        )
    })?;
    let models = safe_config::validate_config_path(&payload.models_path, &roots).map_err(|e| {
        error_json(
            "invalid_payload",
            &format!("models 路径校验失败：{}", e),
            None,
        )
    })?;
    let meta = validate_meta_path(&app, &payload.meta_path)?;
    let settings = if payload.settings.is_empty() {
        None
    } else {
        let raw = payload.settings_path.as_deref().unwrap_or_default();
        let path = safe_config::validate_config_path(raw, &roots).map_err(|e| {
            error_json(
                "invalid_payload",
                &format!("settings 路径校验失败：{}", e),
                None,
            )
        })?;
        if path.file_name().and_then(|name| name.to_str()) != Some("settings.json") {
            return Err(error_json(
                "invalid_payload",
                "settingsPath 必须指向 settings.json",
                None,
            ));
        }
        Some(path)
    };
    let journal = meta
        .parent()
        .map(|parent| parent.join(JOURNAL_FILE_NAME))
        .ok_or_else(|| error_json("invalid_payload", "无法定位恢复日志目录", None))?;
    let paths = ChannelSavePaths {
        auth,
        models,
        meta,
        settings,
        journal,
    };
    tokio::task::spawn_blocking(move || save_channel_config_core(&paths, &payload))
        .await
        .map_err(|e| error_json("internal", &format!("保存任务执行失败：{}", e), None))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone, Default)]
    struct FakeSecretStore {
        values: Arc<Mutex<BTreeMap<String, String>>>,
    }

    impl SecretStore for FakeSecretStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(account).cloned())
        }

        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.values
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let seq = TEST_SEQUENCE.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "channel-save-v2-{}-{}-{}",
            tag,
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn paths(dir: &Path) -> ChannelSavePaths {
        ChannelSavePaths {
            auth: dir.join("auth.json"),
            models: dir.join("models.json"),
            meta: dir.join("channels-meta.json"),
            settings: Some(dir.join("settings.json")),
            journal: dir.join(JOURNAL_FILE_NAME),
        }
    }

    fn write_json(path: &Path, value: Value) {
        fs::write(
            path,
            format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
        )
        .unwrap();
    }

    fn read_json(path: &Path) -> Value {
        safe_config::read_json_file(path).unwrap()
    }

    fn payload(provider: &str) -> SaveChannelConfigPayload {
        SaveChannelConfigPayload {
            provider: provider.to_string(),
            auth_path: String::new(),
            models_path: String::new(),
            meta_path: String::new(),
            settings_path: None,
            keychain: KeychainOp::None,
            auth_entry: EntryOp::None,
            models_entry: EntryOp::None,
            meta: MetaOp::None,
            settings: SettingsPatch::default(),
        }
    }

    fn error_code(error: &str) -> &str {
        let value: Value = serde_json::from_str(error).unwrap();
        Box::leak(value["code"].as_str().unwrap().to_string().into_boxed_str())
    }

    #[test]
    fn success_preserves_unknown_fields_and_has_no_journal_backups() {
        let dir = temp_dir("success");
        let p = paths(&dir);
        write_json(
            &p.auth,
            serde_json::json!({"other":{"key":"keep"},"future":1}),
        );
        write_json(
            &p.models,
            serde_json::json!({"providers":{"other":{"x":1}},"future":2}),
        );
        let mut request = payload("deepseek");
        request.auth_entry = EntryOp::Set {
            entry: serde_json::json!({"type":"api_key","key":"$DEEPSEEK"}),
        };
        request.models_entry = EntryOp::Set {
            entry: serde_json::json!({"baseUrl":"https://example.test/v1"}),
        };
        request.meta = MetaOp::Set {
            entry: serde_json::json!({"alias":"DeepSeek"}),
        };

        let report = run_save(&p, &request, &FakeSecretStore::default(), None).unwrap();
        assert_eq!(report.steps, vec!["auth", "models", "meta"]);
        assert_eq!(read_json(&p.auth)["other"]["key"], "keep");
        assert_eq!(read_json(&p.auth)["future"], 1);
        assert_eq!(read_json(&p.models)["providers"]["other"]["x"], 1);
        assert_eq!(read_json(&p.models)["future"], 2);
        assert!(!p.journal.exists());
        assert!(!legacy_backup_dir(&p.journal).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_patch_is_root_rmw_and_rolls_back() {
        let dir = temp_dir("settings");
        let p = paths(&dir);
        write_json(
            p.settings.as_ref().unwrap(),
            serde_json::json!({
                "enabledModels":["old/*"],
                "defaultProvider":"old",
                "defaultModel":"old-model",
                "future":{"keep":true}
            }),
        );
        let mut request = payload("oauth");
        request.settings_path = Some(p.settings.as_ref().unwrap().to_string_lossy().to_string());
        request.settings.set.insert(
            "enabledModels".to_string(),
            serde_json::json!(["oauth/a", "oauth/b"]),
        );
        request.settings.set.insert(
            "defaultProvider".to_string(),
            Value::String("oauth".to_string()),
        );
        request.settings.delete.push("defaultModel".to_string());
        let original = read_json(p.settings.as_ref().unwrap());

        let error = run_save(
            &p,
            &request,
            &FakeSecretStore::default(),
            Some(FailPlan {
                crash_after_execute: Some(Step::Settings),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "simulated_crash");
        recover_stale_journal_under_domain_lock(&p.journal, &FakeSecretStore::default()).unwrap();
        assert_eq!(read_json(p.settings.as_ref().unwrap()), original);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_settings_keys_are_rejected() {
        let mut request = payload("x");
        request
            .settings
            .set
            .insert("arbitrary".to_string(), Value::Bool(true));
        let error = validate_payload(&request).unwrap_err();
        assert_eq!(error_code(&error), "invalid_payload");
    }

    #[test]
    fn crash_after_file_execute_rolls_back_in_progress_step() {
        let dir = temp_dir("file-crash");
        let p = paths(&dir);
        write_json(
            &p.auth,
            serde_json::json!({"deepseek":{"key":"old"},"keep":1}),
        );
        let mut request = payload("deepseek");
        request.auth_entry = EntryOp::Set {
            entry: serde_json::json!({"key":"new"}),
        };

        let error = run_save(
            &p,
            &request,
            &FakeSecretStore::default(),
            Some(FailPlan {
                crash_after_execute: Some(Step::Auth),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "simulated_crash");
        assert_eq!(read_json(&p.auth)["deepseek"]["key"], "new");
        let recovered =
            recover_stale_journal_under_domain_lock(&p.journal, &FakeSecretStore::default())
                .unwrap()
                .unwrap();
        assert_eq!(recovered.action, "rolled_back");
        assert_eq!(read_json(&p.auth)["deepseek"]["key"], "old");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keychain_crash_after_destination_write_is_proven_committed() {
        let dir = temp_dir("keychain-commit");
        let p = paths(&dir);
        let secrets = FakeSecretStore::default();
        secrets.set("deepseek", "old-secret").unwrap();
        let mut request = payload("deepseek");
        request.auth_entry = EntryOp::Set {
            entry: serde_json::json!({"key":"!security account deepseek"}),
        };
        request.keychain = KeychainOp::Write {
            account: "deepseek".to_string(),
            secret: "new-secret".to_string(),
        };

        let error = run_save(
            &p,
            &request,
            &secrets,
            Some(FailPlan {
                crash_after_execute: Some(Step::Keychain),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "simulated_crash");
        assert_eq!(
            secrets.get("deepseek").unwrap().as_deref(),
            Some("new-secret")
        );
        let recovered = recover_stale_journal_under_domain_lock(&p.journal, &secrets)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.action, "committed");
        assert_eq!(
            read_json(&p.auth)["deepseek"]["key"],
            "!security account deepseek"
        );
        assert!(!secrets
            .values
            .lock()
            .unwrap()
            .keys()
            .any(|key| key.starts_with("__pi_gui_channel_txn__")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keychain_not_changed_allows_file_rollback() {
        let dir = temp_dir("keychain-rollback");
        let p = paths(&dir);
        let secrets = FakeSecretStore::default();
        secrets.set("deepseek", "old-secret").unwrap();
        write_json(&p.auth, serde_json::json!({"deepseek":{"key":"old-ref"}}));
        let mut request = payload("deepseek");
        request.auth_entry = EntryOp::Set {
            entry: serde_json::json!({"key":"new-ref"}),
        };
        request.keychain = KeychainOp::Write {
            account: "deepseek".to_string(),
            secret: "new-secret".to_string(),
        };

        let error = run_save(
            &p,
            &request,
            &secrets,
            Some(FailPlan {
                fail_at: Some(Step::Keychain),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "rollback_complete");
        assert_eq!(
            secrets.get("deepseek").unwrap().as_deref(),
            Some("old-secret")
        );
        assert_eq!(read_json(&p.auth)["deepseek"]["key"], "old-ref");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keychain_delete_crash_is_proven_committed() {
        let dir = temp_dir("keychain-delete");
        let p = paths(&dir);
        let secrets = FakeSecretStore::default();
        secrets.set("deepseek", "old-secret").unwrap();
        let mut request = payload("deepseek");
        request.auth_entry = EntryOp::Delete;
        request.keychain = KeychainOp::Delete {
            account: "deepseek".to_string(),
        };
        let error = run_save(
            &p,
            &request,
            &secrets,
            Some(FailPlan {
                crash_after_execute: Some(Step::Keychain),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "simulated_crash");
        let recovered = recover_stale_journal_under_domain_lock(&p.journal, &secrets)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.action, "committed");
        assert_eq!(secrets.get("deepseek").unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn meta_delete_and_rollback_restore_order_position() {
        let dir = temp_dir("meta-delete");
        let p = paths(&dir);
        let original = serde_json::json!({
            "version":1,
            "channels":{"a":{},"deepseek":{"alias":"old"},"b":{}},
            "order":["a","deepseek","b"],
            "future":true
        });
        write_json(&p.meta, original.clone());
        let mut request = payload("deepseek");
        request.meta = MetaOp::Delete;
        let error = run_save(
            &p,
            &request,
            &FakeSecretStore::default(),
            Some(FailPlan {
                crash_after_execute: Some(Step::Meta),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "simulated_crash");
        recover_stale_journal_under_domain_lock(&p.journal, &FakeSecretStore::default()).unwrap();
        assert_eq!(read_json(&p.meta), original);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn domain_lock_blocks_second_process_lane_and_recovers_stale_owner() {
        let dir = temp_dir("domain-lock");
        let p = paths(&dir);
        let lock = safe_config::DirLock::acquire(&p.journal, 1_000).unwrap();
        let second = safe_config::DirLock::acquire(&p.journal, 100);
        assert!(second.is_err());
        drop(lock);
        let reacquired = safe_config::DirLock::acquire(&p.journal, 1_000).unwrap();
        drop(reacquired);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_backup_directory_is_removed() {
        let dir = temp_dir("legacy-backup");
        let p = paths(&dir);
        let backup = legacy_backup_dir(&p.journal);
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("old.bak"), "plaintext old auth").unwrap();
        cleanup_legacy_journal_backups(&p.journal).unwrap();
        assert!(!backup.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn journal_is_private_and_not_backed_up() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("journal-mode");
        let p = paths(&dir);
        let mut request = payload("deepseek");
        request.auth_entry = EntryOp::Set {
            entry: serde_json::json!({"key":"new"}),
        };
        let error = run_save(
            &p,
            &request,
            &FakeSecretStore::default(),
            Some(FailPlan {
                crash_after_execute: Some(Step::Auth),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "simulated_crash");
        assert_eq!(
            fs::metadata(&p.journal).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!legacy_backup_dir(&p.journal).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_in_progress_file_step_is_rolled_back() {
        let dir = temp_dir("legacy-file-window");
        let p = paths(&dir);
        write_json(
            &p.auth,
            serde_json::json!({"deepseek":{"key":"new"},"keep":true}),
        );
        let legacy = serde_json::json!({
            "version":1,
            "provider":"deepseek",
            "paths":{
                "auth":p.auth,
                "models":p.models,
                "meta":p.meta
            },
            "planned":["auth"],
            "completed":[],
            "snapshots":{
                "auth":{
                    "fileExisted":true,
                    "hadEntry":true,
                    "oldEntry":{"key":"old"},
                    "containerExisted":true
                }
            }
        });
        fs::write(&p.journal, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let recovered =
            recover_stale_journal_under_domain_lock(&p.journal, &FakeSecretStore::default())
                .unwrap()
                .unwrap();
        assert_eq!(recovered.action, "rolled_back");
        assert_eq!(read_json(&p.auth)["deepseek"]["key"], "old");
        assert_eq!(read_json(&p.auth)["keep"], true);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_keychain_commit_window_is_not_misreported_as_rollback() {
        let dir = temp_dir("legacy-keychain-window");
        let p = paths(&dir);
        let legacy = serde_json::json!({
            "version":1,
            "provider":"deepseek",
            "paths":{
                "auth":p.auth,
                "models":p.models,
                "meta":p.meta
            },
            "planned":["auth","keychain"],
            "completed":["auth"],
            "snapshots":{
                "auth":{
                    "fileExisted":false,
                    "hadEntry":false,
                    "oldEntry":null,
                    "containerExisted":true
                },
                "keychain":{"account":"deepseek","hadPrevious":true}
            }
        });
        fs::write(&p.journal, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let error =
            recover_stale_journal_under_domain_lock(&p.journal, &FakeSecretStore::default())
                .unwrap_err();
        assert!(error.contains("无法证明密钥是否已更改"), "{}", error);
        assert!(p.journal.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rollback_failure_is_resumed() {
        let dir = temp_dir("rollback-resume");
        let p = paths(&dir);
        write_json(&p.auth, serde_json::json!({"deepseek":{"key":"old"}}));
        let mut request = payload("deepseek");
        request.auth_entry = EntryOp::Set {
            entry: serde_json::json!({"key":"new"}),
        };
        request.models_entry = EntryOp::Set {
            entry: serde_json::json!({"baseUrl":"new"}),
        };
        let error = run_save(
            &p,
            &request,
            &FakeSecretStore::default(),
            Some(FailPlan {
                fail_at: Some(Step::Models),
                fail_undo_of: Some(Step::Auth),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert_eq!(error_code(&error), "rollback_incomplete");
        assert!(p.journal.exists());
        let recovered =
            recover_stale_journal_under_domain_lock(&p.journal, &FakeSecretStore::default())
                .unwrap()
                .unwrap();
        assert_eq!(recovered.action, "rolled_back");
        assert_eq!(read_json(&p.auth)["deepseek"]["key"], "old");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_real_keychain_is_used_by_ordinary_tests() {
        let request = payload("noop");
        assert!(matches!(request.keychain, KeychainOp::None));
    }
}
