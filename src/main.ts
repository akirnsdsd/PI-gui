/**
 * Pi Desktop - app bootstrap
 */

import { html, nothing, render } from "lit";
import { alertDialog, confirmDialog, promptDialog } from "./components/app-dialog.js";
import { ChatView, type SessionForkedInfo } from "./components/chat-view.js";
import { resolveProjectFileReference } from "./components/chat-view/local-file-reference.js";
import { CommandPalette } from "./components/command-palette.js";
import { ContentTabs } from "./components/content-tabs.js";
import {
	shouldRollbackSessionTitle,
	toggleCompactSidebarOverlay,
} from "./components/desktop-ui-behavior.js";
import { ExtensionUiHandler, normalizeExtensionUiRequest, type McpChipServerInfo, type NotificationActionTarget } from "./components/extension-ui-handler.js";
import { type DraftFileCreatedEvent, FileViewer } from "./components/file-viewer.js";
import { PackagesView } from "./components/packages-view.js";
import { SessionBrowser } from "./components/session-browser.js";
import { SettingsPanel, type SettingsSectionId } from "./components/settings-panel.js";
import type { ExtensionsViewId } from "./components/settings-extensions.js";
import { ShortcutsPanel } from "./components/shortcuts-panel.js";
import { SESSION_WILL_DELETE_EVENT, Sidebar, type SidebarMode, type SidebarWorkspaceItem } from "./components/sidebar.js";
import { TerminalPanel } from "./components/terminal-panel.js";
import type { WorkspaceTabs } from "./components/workspace-tabs.js";
import { fetchDesktopUpdateStatus, openDesktopUpdate, relaunchApp, type DesktopUpdateStatus } from "./desktop-updates.js";
import { type CliUpdateStatus, RpcBridge, type RpcCompatibilityReport, type RpcSessionState, rpcBridge, setActiveRpcBridge } from "./rpc/bridge.js";
import {
	applyDesktopAppearanceProfileToRoot,
	DESKTOP_APPEARANCE_PROFILE_CHANGED_EVENT,
	loadDesktopAppearanceProfiles,
} from "./theme/appearance-profiles.js";
import { syncDesktopThemeWithPiTheme } from "./theme/pi-theme-bridge.js";
import { DESKTOP_THEME_CHANGED_EVENT, getResolvedDesktopTheme, initializeDesktopTheme, toggleDesktopTheme } from "./theme/theme-manager.js";
import { ensureBundledThemesInstalled } from "./theme/bundled-themes.js";
import { ensureDesktopNotifyBridgeExtensionInstalled } from "./extensions/desktop-notify-bridge-extension.js";
import { isExtensionConfigIntent, normalizeExtensionCommandName } from "./extensions/extension-command-intent.js";
import { ensureDesktopSdkCompatExtensionInstalled } from "./extensions/sdk-compat-extension.js";
import { ensureSmartVoiceNotifyDesktopHostMode } from "./extensions/smart-voice-notify-config.js";
import { t } from "./i18n/index.js";
import {
	isCurrentSessionRuntimeSettlement,
	isSessionRuntimeLifecycleProtected,
	shouldRefuseSessionRuntimeReattach,
	reduceSessionRuntimeLifecycle,
	resolveSessionRuntimeEventSource,
	type SessionRuntimeLifecycleSignal,
} from "./runtime/session-runtime-lifecycle.js";
import {
	clearMatchingSessionAttention,
	setSessionAttention,
} from "./runtime/session-attention.js";
import "./styles/app.css";

interface WorkspaceSessionTab {
	id: string;
	projectId: string | null;
	projectPath: string | null;
	sessionPath: string | null;
	title: string;
	messageCount: number | null;
	ephemeral: boolean;
	needsAttention: boolean;
	attentionMessage: string | null;
	/** fork 分支标签标记：fork 创建时打标，用于 tab 栏可见性（存在 fork 标签才显示）。 */
	isFork: boolean;
	/** 分支来源（父会话）文件路径。 */
	parentSessionPath: string | null;
}

interface WorkspaceFileTab {
	id: string;
	projectId: string | null;
	projectPath: string | null;
	path: string | null;
	title: string;
	draftDirectoryPath: string | null;
	draftAnchorPath: string | null;
}

interface WorkspaceState {
	id: string;
	title: string;
	color: string | null;
	emoji: string | null;
	pinned: boolean;
	leftMode: SidebarMode;
	pane: "chat" | "file" | "packages" | "settings" | "terminal";
	activeProjectId: string | null;
	activeProjectPath: string | null;
	filePath: string | null;
	terminalOpen: boolean;
	sessionTitle: string;
	sessionTabs: WorkspaceSessionTab[];
	activeSessionTabId: string | null;
	fileTabs: WorkspaceFileTab[];
	activeFileTabId: string | null;
}

interface SessionRuntime {
	key: string;
	instanceId: string;
	bridge: RpcBridge;
	workspaceId: string;
	tabId: string;
	projectPath: string;
	lastKnownSessionPath: string | null;
	running: boolean;
	/**
	 * The session-level run has started but pi has not emitted the external
	 * `agent_settled` boundary yet. UI streaming may already be false while
	 * extension callbacks are still using this runtime's ctx.
	 */
	awaitingAgentSettled: boolean;
	/** Monotonic task generation used to invalidate delayed settlement callbacks. */
	runEpoch: number;
	/** The single queued settlement callback for the current run, if any. */
	pendingSettleTimer: ReturnType<typeof setTimeout> | null;
	/** Config reload requested while this runtime was still protected by a run. */
	restartAfterSettlement: boolean;
	draftInitialized: boolean;
	phase: "idle" | "starting" | "switching_session" | "creating_session" | "ready" | "failed";
	lastError: string | null;
	eventUnlisten: (() => void) | null;
	/** True when the pi process was stopped by the runtime supervisor (concurrency
	 * cap or idle timeout). Tab/session state is kept; the process is restarted
	 * and re-attached to its session when the tab becomes active again. */
	suspended: boolean;
	/** Last time the runtime saw user-facing activity (events, state syncs, activation). */
	lastActivityAt: number;
	/** 在途的 ensureRuntime 调用（预热或正常切换链路），用于去重，避免同一 runtime 并发 start。 */
	ensureInFlight: Promise<SessionRuntime> | null;
	/** 进程启动时的配置 revision：低于当前 runtimeConfigRevision 的已连接 runtime 视为配置过期。 */
	configRevision: number;
}

const WORKSPACES_STORAGE_KEY = "pi-desktop.workspaces.v1";
const WORKSPACES_ACTIVE_STORAGE_KEY = "pi-desktop.workspaces.active.v1";
const LEGACY_PROJECTS_STORAGE_KEY = "pi-desktop.projects.v1";
const WORKSPACE_DEFAULT_ID = "workspace_default";
const WORKSPACE_PROJECTS_KEY_PREFIX = "pi-desktop.workspace-projects.v1";
const SIDEBAR_WIDTH_KEY = "pi-desktop.sidebar.width.v1";
const SIDEBAR_COLLAPSED_STATE_KEY = "pi-desktop.sidebar.collapsed.v1";
const SIDEBAR_WIDTH_MIN = 240;
const SIDEBAR_WIDTH_MAX = 540;
const TERMINAL_DOCK_HEIGHT_KEY = "pi-desktop.terminal-dock-height.v1";
const TERMINAL_DOCK_MIN_HEIGHT = 180;
const TERMINAL_DOCK_MAX_HEIGHT = 640;
const TERMINAL_DOCK_DEFAULT_HEIGHT = 280;
const FILE_SPLIT_WIDTH_KEY = "pi-desktop.file-split-width.v1";
const FILE_SPLIT_MIN_WIDTH = 300;
const FILE_SPLIT_MIN_CHAT_WIDTH = 420;
const FILE_SPLIT_MIN_COMPOSER_GAP = 16;
const FILE_SPLIT_DEFAULT_WIDTH = 520;
const NEW_SESSION_TAB_TITLE = t("app.tabs.newSession");
const NEW_FILE_TAB_TITLE = t("app.tabs.newFile");
/**
 * 会话 tab 的占位标题（未命名时的临时文案）。
 * pi 对未显式命名的会话，get_state 不返回 sessionName；这类占位标题
 * 可以被真实名字覆盖，但真实标题绝不能被占位文案（如「会话」）反向覆盖。
 */
function isSessionTabPlaceholderTitle(title: string): boolean {
	return ["chat", "new session", NEW_SESSION_TAB_TITLE.toLowerCase(), t("app.tabs.chat").toLowerCase(), ""].includes(
		title.trim().toLowerCase(),
	);
}
const NEW_GENERIC_TAB_TITLE = t("app.tabs.newTab");
const DEFAULT_AUTO_CONTENT_TAB_LIMIT = 2;
const DEBUG_OVERLAY_STORAGE_KEY = "pi-desktop.debug-overlay.v1";
const CLI_UPDATE_NOTICE_STORAGE_KEY = "pi-desktop.cli-update-notice-at.v1";
const DESKTOP_UPDATE_NOTICE_STORAGE_KEY = "pi-desktop.desktop-update-notice-at.v1";
const UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTH_CONFIG_RELOAD_DEBOUNCE_MS = 550;
const AUTH_CONFIG_FALLBACK_POLL_MS = 2_500;
const AUTH_CONFIG_SNAPSHOT_MISSING = "__pi-desktop-auth-missing__";
const AUTH_CONFIG_SNAPSHOT_ERROR = "__pi-desktop-auth-read-error__";
const CLI_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";
const WINDOWS_NODE_INSTALL_COMMAND = "winget install --id OpenJS.NodeJS.LTS";
const SESSION_ATTENTION_MESSAGES = [
	t("app.attention.waiting"),
	t("app.attention.ready"),
	t("app.attention.yourMove"),
	t("app.attention.comeBack"),
] as const;

let sidebar: Sidebar | null = null;
let chatView: ChatView | null = null;
let workspaceTabsBar: WorkspaceTabs | null = null;
let contentTabsBar: ContentTabs | null = null;
let fileViewer: FileViewer | null = null;
let terminalPanel: TerminalPanel | null = null;
let packagesView: PackagesView | null = null;
let connectionError: string | null = null;

let settingsPanel: SettingsPanel | null = null;
let commandPalette: CommandPalette | null = null;
let sessionBrowser: SessionBrowser | null = null;
let shortcutsPanel: ShortcutsPanel | null = null;
let extensionUiHandler: ExtensionUiHandler | null = null;

let cliUpdateStatus: CliUpdateStatus | null = null;
let desktopUpdateStatus: DesktopUpdateStatus | null = null;
let preferredPiBinaryPath: string | null = null;
let cliUpdatePollingTimer: ReturnType<typeof setInterval> | null = null;
let desktopUpdatePollingTimer: ReturnType<typeof setInterval> | null = null;
let cliUpdateChecking = false;
let desktopUpdateChecking = false;

let projectSwitchTask: Promise<void> = Promise.resolve();
let projectSwitchVersion = 0;
let workspacePaneApplyVersion = 0;
let settingsPaneRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let terminalCommandRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let authConfigWatchUnlisten: (() => void) | null = null;
let authConfigPollTimer: ReturnType<typeof setInterval> | null = null;
let authConfigReloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let authConfigPath: string | null = null;
let authConfigSnapshot = "";
let authConfigReloadInFlight = false;
let authConfigReloadQueued = false;
let authConfigReloadPendingUntilIdle = false;

class StaleProjectTaskError extends Error {
	constructor() {
		super("Stale project task");
	}
}

let workspaces: WorkspaceState[] = [];
let activeWorkspaceId: string | null = null;
let sidebarWidth = 320;
let compactSidebarOverlayOpen = false;
let removeSidebarResizeHandlers: (() => void) | null = null;
let removeTerminalDockResizeHandlers: (() => void) | null = null;
let removeFileSplitResizeHandlers: (() => void) | null = null;
let terminalDockHeightPx = loadTerminalDockHeight();
let fileSplitWidthPx = loadFileSplitWidth();
let sidebarSessionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let sidebarSessionsWarmInterval: ReturnType<typeof setInterval> | null = null;
let sidebarSessionsWarmStopTimer: ReturnType<typeof setTimeout> | null = null;
let sessionRuntimes = new Map<string, SessionRuntime>();
let activeSessionRuntimeKey: string | null = null;
let runningSessionPollInterval: ReturnType<typeof setInterval> | null = null;
let runningSessionPollInFlight = false;
let runtimeSupervisorInterval: ReturnType<typeof setInterval> | null = null;
let maxRunningRuntimes = 4;
let runtimeIdleTimeoutMinutes = 15;
let debugOverlayInterval: ReturnType<typeof setInterval> | null = null;
let debugTraceLines: string[] = [];
let notificationAttentionListenersBound = false;
let runtimeRunHadError = new Map<string, boolean>();
let runtimeRunNotifyObserved = new Map<string, boolean>();
let syntheticRuntimeNotifyCounter = 0;
/** RUNTIME-03/04 配置 revision：渠道/扩展/MCP/Skill/auth 配置保存时单调递增；
 * 已连接 runtime 的 configRevision 低于它即为配置过期（stale）。 */
let runtimeConfigRevision = 0;

function recordDebugTrace(message: string): void {
	const stamp = new Date().toISOString().slice(11, 23);
	const line = `${stamp} ${message}`;
	debugTraceLines = [...debugTraceLines.slice(-79), line];
	console.debug(`[pi-desktop] ${line}`);
	syncDebugOverlay();
}

(window as typeof window & {
	__PI_DESKTOP_PUSH_TRACE__?: (message: string) => void;
	__PI_DESKTOP_GET_TRACE__?: () => string[];
}).__PI_DESKTOP_PUSH_TRACE__ = (message: string) => {
	recordDebugTrace(message);
};

(window as typeof window & {
	__PI_DESKTOP_PUSH_TRACE__?: (message: string) => void;
	__PI_DESKTOP_GET_TRACE__?: () => string[];
}).__PI_DESKTOP_GET_TRACE__ = () => [...debugTraceLines];

// sidebar 删除会话文件前的预处理：停止并等待所有附着该 session 的 runtime
// 退出（含租约释放，内部有 5s 超时兜底）。两个入口共享同一份在途 promise：
//   1. SESSION_WILL_DELETE_EVENT 同步监听（兜底，钩子缺失或被其他派发方触发时仍能停进程）；
//   2. window.__piGuiPrepareSessionDelete（sidebar 在移文件到废纸篓前 await 它）。
// 事件先于 hook 同步派发，去重保证 hook await 的正是事件触发的那次停止，
// 不会出现「hook 因 runtime 已被摘走而立即返回、文件在进程退出前被移走」的竞态。
type SessionDeleteStopResult =
	| { status: "stopped" }
	| { status: "timed_out"; instanceIds: string[] }
	| { status: "failed"; instanceIds: string[]; error: string };

const sessionDeleteStopPromises = new Map<string, Promise<SessionDeleteStopResult>>();

function prepareSessionDeleteStop(sessionPath: string): Promise<SessionDeleteStopResult> {
	const key = normalizeSessionPath(sessionPath);
	if (!key) return Promise.resolve({ status: "stopped" });
	const existing = sessionDeleteStopPromises.get(key);
	if (existing) return existing;
	const promise = awaitRuntimeStoppedForSession(sessionPath).finally(() => {
		if (sessionDeleteStopPromises.get(key) === promise) sessionDeleteStopPromises.delete(key);
	});
	sessionDeleteStopPromises.set(key, promise);
	return promise;
}

window.addEventListener(SESSION_WILL_DELETE_EVENT, (event) => {
	const detail = (event as CustomEvent<{ sessionPath?: unknown }>).detail;
	const sessionPath = typeof detail?.sessionPath === "string" ? detail.sessionPath : "";
	if (!sessionPath) return;
	void prepareSessionDeleteStop(sessionPath)
		.then((result) => {
			if (result.status !== "stopped") {
				recordDebugTrace(`session-delete:prepare-${result.status} session=${sessionPath}`);
			}
		})
		.catch((err) => {
			recordDebugTrace(`session-delete:prepare-failed ${err instanceof Error ? err.message : String(err)}`);
		});
});

window.__piGuiPrepareSessionDelete = async (sessionPath: string) => {
	const result = await prepareSessionDeleteStop(sessionPath);
	if (result.status === "stopped") return;
	if (result.status === "timed_out") {
		throw new Error(`停止会话进程超时：${result.instanceIds.join(", ")}`);
	}
	throw new Error(`停止会话进程失败：${result.error}`);
};

function uid(prefix = "id"): string {
	return `${prefix}_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

function clampTerminalDockHeight(value: number): number {
	return Math.min(TERMINAL_DOCK_MAX_HEIGHT, Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.round(value)));
}

function loadTerminalDockHeight(): number {
	try {
		const raw = localStorage.getItem(TERMINAL_DOCK_HEIGHT_KEY);
		const parsed = raw ? Number(raw) : TERMINAL_DOCK_DEFAULT_HEIGHT;
		if (!Number.isFinite(parsed)) return TERMINAL_DOCK_DEFAULT_HEIGHT;
		return clampTerminalDockHeight(parsed);
	} catch {
		return TERMINAL_DOCK_DEFAULT_HEIGHT;
	}
}

function persistTerminalDockHeight(): void {
	try {
		localStorage.setItem(TERMINAL_DOCK_HEIGHT_KEY, String(terminalDockHeightPx));
	} catch {
		// ignore
	}
}

function setTerminalDockHeight(nextHeight: number, persist = false): void {
	const clamped = clampTerminalDockHeight(nextHeight);
	if (clamped === terminalDockHeightPx) return;
	terminalDockHeightPx = clamped;
	if (persist) persistTerminalDockHeight();
	syncTerminalDockVisibility(getActiveWorkspace());
}

function resolveFileSplitMaxWidth(): number {
	const layout = document.getElementById("chat-file-layout");
	const availableWidth = layout?.getBoundingClientRect().width ?? window.innerWidth;
	const maxWidth = Math.round(availableWidth - FILE_SPLIT_MIN_CHAT_WIDTH);
	return Math.max(FILE_SPLIT_MIN_WIDTH, maxWidth);
}

function clampFileSplitWidth(value: number): number {
	return Math.min(resolveFileSplitMaxWidth(), Math.max(FILE_SPLIT_MIN_WIDTH, Math.round(value)));
}

function loadFileSplitWidth(): number {
	try {
		const raw = localStorage.getItem(FILE_SPLIT_WIDTH_KEY);
		const parsed = raw ? Number(raw) : FILE_SPLIT_DEFAULT_WIDTH;
		if (!Number.isFinite(parsed)) return FILE_SPLIT_DEFAULT_WIDTH;
		return Math.max(FILE_SPLIT_MIN_WIDTH, Math.round(parsed));
	} catch {
		return FILE_SPLIT_DEFAULT_WIDTH;
	}
}

function persistFileSplitWidth(): void {
	try {
		localStorage.setItem(FILE_SPLIT_WIDTH_KEY, String(fileSplitWidthPx));
	} catch {
		// ignore
	}
}

function resolveFileSplitComposerOverlap(layout: HTMLElement): number {
	const handle = document.getElementById("file-split-resize-handle");
	if (!handle || handle.classList.contains("hidden-pane")) return 0;
	const composerPanel = layout.querySelector<HTMLElement>(".composer-panel");
	if (!composerPanel || composerPanel.offsetParent === null) return 0;
	const handleRect = handle.getBoundingClientRect();
	const composerRect = composerPanel.getBoundingClientRect();
	const dividerX = handleRect.left + handleRect.width / 2;
	const minDividerX = composerRect.right + FILE_SPLIT_MIN_COMPOSER_GAP;
	return Math.max(0, Math.ceil(minDividerX - dividerX));
}

function applyFileSplitWidth(): void {
	const layout = document.getElementById("chat-file-layout");
	if (!layout) return;
	const clamped = clampFileSplitWidth(fileSplitWidthPx);
	if (clamped !== fileSplitWidthPx) {
		fileSplitWidthPx = clamped;
	}

	layout.style.setProperty("--file-split-width", `${fileSplitWidthPx}px`);

	for (let attempt = 0; attempt < 5; attempt += 1) {
		const overlap = resolveFileSplitComposerOverlap(layout);
		if (overlap <= 0) break;
		const nextWidth = clampFileSplitWidth(fileSplitWidthPx - overlap);
		if (nextWidth === fileSplitWidthPx) break;
		fileSplitWidthPx = nextWidth;
		layout.style.setProperty("--file-split-width", `${fileSplitWidthPx}px`);
	}
}

function setFileSplitWidth(nextWidth: number, persist = false): void {
	const clamped = clampFileSplitWidth(nextWidth);
	if (clamped !== fileSplitWidthPx) {
		fileSplitWidthPx = clamped;
	}
	applyFileSplitWidth();
	if (persist) persistFileSplitWidth();
}

function setupFileSplitResize(): void {
	removeFileSplitResizeHandlers?.();
	removeFileSplitResizeHandlers = null;

	const handle = document.getElementById("file-split-resize-handle");
	if (!handle) return;

	const onPointerDown = (event: PointerEvent) => {
		if (handle.classList.contains("hidden-pane")) return;
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = fileSplitWidthPx;
		handle.classList.add("dragging");
		document.body.classList.add("file-split-resizing");

		const onMove = (moveEvent: PointerEvent) => {
			const delta = startX - moveEvent.clientX;
			setFileSplitWidth(startWidth + delta, false);
		};

		const onUp = () => {
			handle.classList.remove("dragging");
			document.body.classList.remove("file-split-resizing");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			persistFileSplitWidth();
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const onWindowResize = () => {
		applyFileSplitWidth();
	};

	handle.addEventListener("pointerdown", onPointerDown);
	window.addEventListener("resize", onWindowResize);
	removeFileSplitResizeHandlers = () => {
		handle.removeEventListener("pointerdown", onPointerDown);
		window.removeEventListener("resize", onWindowResize);
	};
}

function setupTerminalDockResize(terminalPane: HTMLElement): void {
	removeTerminalDockResizeHandlers?.();
	const onPointerDown = (event: PointerEvent) => {
		const target = event.target instanceof Element ? event.target.closest(".terminal-resize-handle") : null;
		if (!target) return;
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = terminalDockHeightPx;
		const onPointerMove = (moveEvent: PointerEvent) => {
			const deltaY = startY - moveEvent.clientY;
			setTerminalDockHeight(startHeight + deltaY, false);
		};
		const onPointerUp = () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			persistTerminalDockHeight();
		};
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
	};
	terminalPane.addEventListener("pointerdown", onPointerDown);
	removeTerminalDockResizeHandlers = () => {
		terminalPane.removeEventListener("pointerdown", onPointerDown);
	};
}

function pickSessionAttentionMessage(current?: string | null): string {
	const options = SESSION_ATTENTION_MESSAGES as readonly string[];
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const candidate = options[Math.floor(Math.random() * options.length)] || options[0] || t("app.attention.waiting");
		if (!current || candidate !== current) return candidate;
	}
	return options[0] || t("app.attention.waiting");
}

function shouldShowDebugOverlay(): boolean {
	try {
		return localStorage.getItem(DEBUG_OVERLAY_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

function isCliMissingError(message: string | null | undefined): boolean {
	const text = (message ?? "").toLowerCase();
	if (!text) return false;
	if (text.includes("could not find the pi cli") || text.includes("npm install -g @earendil-works/pi-coding-agent")) {
		return true;
	}

	const referencesPiBinary = /\bpi(?:\.cmd|\.exe|\.bat)?\b/.test(text) || text.includes("pi process");
	if (text.includes("'pi' is not recognized as an internal or external command")) {
		return true;
	}
	if (referencesPiBinary && text.includes("enoent")) {
		return true;
	}
	if (referencesPiBinary && (text.includes("createprocess") || text.includes("os error 2") || text.includes("os error 3"))) {
		return true;
	}
	if (referencesPiBinary && text.includes("the system cannot find the file specified")) {
		return true;
	}
	if (text.includes("failed to spawn pi process") && text.includes("cannot find")) {
		return true;
	}
	return false;
}

function isLikelyWindowsHost(): boolean {
	const platform = `${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
	return platform.includes("win32") || platform.includes("win64") || platform.includes("windows");
}

async function copyCommandToClipboard(command: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(command);
	} catch {
		await promptDialog({ title: t("app.onboarding.copyCommandPrompt"), value: command, readonly: true });
	}
}

async function copyCliInstallCommand(): Promise<void> {
	await copyCommandToClipboard(CLI_INSTALL_COMMAND);
}

async function copyWindowsNodeInstallCommand(): Promise<void> {
	await copyCommandToClipboard(WINDOWS_NODE_INSTALL_COMMAND);
}

function readLastUpdateNoticeAt(storageKey: string): number {
	try {
		const raw = localStorage.getItem(storageKey);
		const parsed = raw ? Number(raw) : 0;
		return Number.isFinite(parsed) ? parsed : 0;
	} catch {
		return 0;
	}
}

function shouldNotifyUpdate(storageKey: string, now = Date.now()): boolean {
	return now - readLastUpdateNoticeAt(storageKey) >= UPDATE_NOTICE_INTERVAL_MS;
}

function markUpdateNotified(storageKey: string, now = Date.now()): void {
	try {
		localStorage.setItem(storageKey, String(now));
	} catch {
		// ignore
	}
}

function shouldNotifyCliUpdate(now = Date.now()): boolean {
	return shouldNotifyUpdate(CLI_UPDATE_NOTICE_STORAGE_KEY, now);
}

function markCliUpdateNotified(now = Date.now()): void {
	markUpdateNotified(CLI_UPDATE_NOTICE_STORAGE_KEY, now);
}

function shouldNotifyDesktopUpdate(now = Date.now()): boolean {
	return shouldNotifyUpdate(DESKTOP_UPDATE_NOTICE_STORAGE_KEY, now);
}

function markDesktopUpdateNotified(now = Date.now()): void {
	markUpdateNotified(DESKTOP_UPDATE_NOTICE_STORAGE_KEY, now);
}

function normalizeProjectPath(path: string | null | undefined): string {
	if (!path) return "";
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function baseName(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/");
	return parts[parts.length - 1] || path;
}

function normalizeSessionPath(path: string | null | undefined): string {
	if (!path) return "";
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function joinFsPath(base: string, child: string): string {
	const normalizedBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedChild = child.replace(/\\/g, "/").replace(/^\/+/, "");
	return normalizedBase ? `${normalizedBase}/${normalizedChild}` : normalizedChild;
}

function sessionRuntimeKey(workspaceId: string, tabId: string): string {
	return `${workspaceId}::${tabId}`;
}

function sessionRuntimeInstanceId(runtimeKey: string): string {
	return `session_${runtimeKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function getRuntimeForTab(workspaceId: string, tabId: string): SessionRuntime | null {
	return sessionRuntimes.get(sessionRuntimeKey(workspaceId, tabId)) ?? null;
}

function getOrCreateRuntimeForTab(workspaceId: string, tabId: string, projectPath: string): SessionRuntime {
	const key = sessionRuntimeKey(workspaceId, tabId);
	const existing = sessionRuntimes.get(key);
	if (existing) {
		return existing;
	}
	const instanceId = sessionRuntimeInstanceId(key);
	const bridge = new RpcBridge(instanceId);
	bridge.setPreferredPiPath(preferredPiBinaryPath);
	const runtime: SessionRuntime = {
		key,
		instanceId,
		bridge,
		workspaceId,
		tabId,
		projectPath,
		lastKnownSessionPath: null,
		running: false,
		awaitingAgentSettled: false,
		runEpoch: 0,
		pendingSettleTimer: null,
		restartAfterSettlement: false,
		draftInitialized: false,
		phase: "idle",
		lastError: null,
		eventUnlisten: null,
		suspended: false,
		lastActivityAt: Date.now(),
		ensureInFlight: null,
		configRevision: runtimeConfigRevision,
	};
	runtime.eventUnlisten = runtime.bridge.onEvent((event) => {
		touchRuntime(runtime);
		if (event.type === "rpc_connected") {
			// 兼容性检查挂在 runtime 级 rpc_connected 上：全局 proxy 只转发 active
			// bridge 的事件，首次 start 发生在激活之前，proxy 层监听会漏掉。
			void runStartupCompatibilityCheck(runtime.bridge, event.discovery);
		}
		handleSessionRuntimeLifecycleEvent(runtime, event);
		handleBackgroundRuntimeNotifyEvent(runtime.key, event);
	});
	sessionRuntimes.set(key, runtime);
	return runtime;
}

function setActiveRuntime(runtime: SessionRuntime | null): void {
	activeSessionRuntimeKey = runtime?.key ?? null;
	setActiveRpcBridge(runtime?.bridge ?? null);
	syncDebugOverlay();
}

function getActiveRuntime(): SessionRuntime | null {
	if (!activeSessionRuntimeKey) return null;
	return sessionRuntimes.get(activeSessionRuntimeKey) ?? null;
}

function resolveRuntimeNotifyTarget(runtime: SessionRuntime): {
	workspaceId?: string;
	tabId?: string;
	sessionPath?: string;
	workspaceLabel?: string;
	sessionLabel?: string;
} {
	const workspace = workspaces.find((entry) => entry.id === runtime.workspaceId) ?? null;
	const tab = workspace ? workspace.sessionTabs.find((entry) => entry.id === runtime.tabId) ?? null : null;
	const sessionPath = runtime.lastKnownSessionPath ?? tab?.sessionPath ?? undefined;
	const workspaceLabel = workspace?.title?.trim() || undefined;
	const sessionLabel = tab?.title?.trim() || (sessionPath ? baseName(sessionPath) : undefined);
	return {
		workspaceId: runtime.workspaceId || workspace?.id || undefined,
		tabId: runtime.tabId || tab?.id || undefined,
		sessionPath: sessionPath ?? undefined,
		workspaceLabel,
		sessionLabel,
	};
}

function applySessionRuntimeLifecycleSignal(
	runtime: SessionRuntime,
	signal: SessionRuntimeLifecycleSignal,
): void {
	const previousRunning = runtime.running;
	const previousAwaiting = runtime.awaitingAgentSettled;
	const next = reduceSessionRuntimeLifecycle(
		{
			uiRunning: previousRunning,
			awaitingAgentSettled: previousAwaiting,
		},
		signal,
	);
	runtime.running = next.uiRunning;
	runtime.awaitingAgentSettled = next.awaitingAgentSettled;
	if (runtime.running && !previousRunning) {
		extensionUiHandler?.primeNotificationPermission();
	}
	if (runtime.running !== previousRunning || runtime.awaitingAgentSettled !== previousAwaiting) {
		syncRunningSessionIndicators();
		ensureRunningSessionPoller();
	}
}

function isSessionRuntimeProtected(runtime: SessionRuntime | null | undefined): boolean {
	if (!runtime) return false;
	return isSessionRuntimeLifecycleProtected(runtime.phase, {
		uiRunning: runtime.running,
		awaitingAgentSettled: runtime.awaitingAgentSettled,
	});
}

/**
 * 只问「这个 runtime 上是不是真的有 agent 在跑」。用于那些要向用户报「仍在后台运行」
 * 的拒绝路径；绝不能用 isSessionRuntimeProtected 代替——后者把 starting/
 * switching_session/creating_session 也算作受保护，而那些 phase 往往是调用方
 * 自己刚设进去的，拿来做守卫会变成自我阻断。
 */
function isSessionRuntimeAgentRunning(runtime: SessionRuntime | null | undefined): boolean {
	if (!runtime) return false;
	return shouldRefuseSessionRuntimeReattach(runtime.phase, {
		uiRunning: runtime.running,
		awaitingAgentSettled: runtime.awaitingAgentSettled,
	});
}

/**
 * 把底层 error message 拼到笼统文案后。这些失败路径都是 catch-all，只报一句
 * 「XX 失败」时用户和开发者都无法定位（真因只进了 console）。
 */
function formatErrorNotice(baseMessage: string, err: unknown): string {
	const reason = err instanceof Error ? err.message : typeof err === "string" ? err : "";
	const trimmed = reason.trim();
	if (!trimmed) return baseMessage;
	return t("app.errors.withReason", { message: baseMessage, reason: trimmed.slice(0, 200) });
}

function cancelPendingRuntimeSettlement(runtime: SessionRuntime): void {
	if (runtime.pendingSettleTimer === null) return;
	clearTimeout(runtime.pendingSettleTimer);
	runtime.pendingSettleTimer = null;
}

function markRuntimeRunStarted(runtimeKey: string): void {
	runtimeRunHadError.set(runtimeKey, false);
	runtimeRunNotifyObserved.set(runtimeKey, false);
	const runtime = sessionRuntimes.get(runtimeKey);
	if (runtime) {
		cancelPendingRuntimeSettlement(runtime);
		runtime.runEpoch += 1;
		applySessionRuntimeLifecycleSignal(runtime, { type: "agent_start" });
	}
}

function markRuntimeRunErrored(runtimeKey: string): void {
	runtimeRunHadError.set(runtimeKey, true);
}

function markRuntimeRunNotifyObserved(runtimeKey: string): void {
	runtimeRunNotifyObserved.set(runtimeKey, true);
}

function consumeRuntimeRunState(runtimeKey: string): { hadError: boolean; hadNotify: boolean } {
	const hadError = runtimeRunHadError.get(runtimeKey) === true;
	const hadNotify = runtimeRunNotifyObserved.get(runtimeKey) === true;
	runtimeRunHadError.delete(runtimeKey);
	runtimeRunNotifyObserved.delete(runtimeKey);
	return { hadError, hadNotify };
}

function clearRuntimeRunState(runtimeKey: string): void {
	runtimeRunHadError.delete(runtimeKey);
	runtimeRunNotifyObserved.delete(runtimeKey);
}

function nextSyntheticRuntimeNotifyRequestId(runtimeKey: string): string {
	syntheticRuntimeNotifyCounter = syntheticRuntimeNotifyCounter >= 2_100_000_000 ? 1 : syntheticRuntimeNotifyCounter + 1;
	const normalizedRuntimeKey = runtimeKey.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `desktop_notify_${normalizedRuntimeKey}_${Date.now()}_${syntheticRuntimeNotifyCounter}`;
}

function attachNotifyTargetToRequest(
	request: Record<string, unknown>,
	target: ReturnType<typeof resolveRuntimeNotifyTarget>,
	source: "active" | "background",
	runtime: SessionRuntime,
): void {
	if (!target.workspaceId && !target.tabId && !target.sessionPath) return;
	request.notifyTargetWorkspaceId = target.workspaceId;
	request.notifyTargetTabId = target.tabId;
	request.notifyTargetSessionPath = target.sessionPath;
	request.notifyTargetWorkspaceLabel = target.workspaceLabel;
	request.notifyTargetSessionLabel = target.sessionLabel;
	recordDebugTrace(
		`notify-target workspace=${target.workspaceId ?? "-"} tab=${target.tabId ?? "-"} session=${target.sessionPath ?? "-"} source=${source} runtime=${runtime.instanceId}`,
	);
	markSessionAttentionTarget(target);
}

function dispatchSyntheticRunEndNotify(runtime: SessionRuntime, source: "active" | "background"): void {
	const state = consumeRuntimeRunState(runtime.key);
	if (state.hadNotify) return;

	const request: Record<string, unknown> = {
		id: nextSyntheticRuntimeNotifyRequestId(runtime.key),
		method: "notify",
		notifyType: state.hadError ? "error" : "info",
		title: state.hadError ? t("app.notify.runErrorTitle") : t("app.notify.runDoneTitle"),
		message: state.hadError ? t("app.notify.runErrorMessage") : t("app.notify.runDoneMessage"),
	};
	const target = resolveRuntimeNotifyTarget(runtime);
	attachNotifyTargetToRequest(request, target, source, runtime);
	recordDebugTrace(
		`notify:synthetic-run-end type=${state.hadError ? "error" : "info"} source=${source} runtime=${runtime.instanceId}`,
	);
	const normalizedRequest = normalizeExtensionUiRequest(request);
	if (!normalizedRequest) return;
	void extensionUiHandler?.handleRequest(normalizedRequest);
}

function finalizeSessionRuntimeRun(runtime: SessionRuntime, runEpoch: number): void {
	if (sessionRuntimes.get(runtime.key) !== runtime) return;
	if (!isCurrentSessionRuntimeSettlement(runtime.runEpoch, runEpoch, runtime.awaitingAgentSettled)) return;
	const source = resolveSessionRuntimeEventSource(runtime.key, activeSessionRuntimeKey);
	// Resolve the outcome/notification target before releasing the lifecycle
	// fence. Once released, tab reuse may attach this bridge to another session.
	dispatchSyntheticRunEndNotify(runtime, source);
	applySessionRuntimeLifecycleSignal(runtime, { type: "agent_settled" });
	scheduleStaleRuntimeRestart(runtime);
	flushPendingAuthConfigReload();
}

function terminalizeSessionRuntimeRun(runtime: SessionRuntime): void {
	cancelPendingRuntimeSettlement(runtime);
	runtime.runEpoch += 1;
	if (!runtime.running && !runtime.awaitingAgentSettled) {
		clearRuntimeRunState(runtime.key);
		return;
	}
	markRuntimeRunErrored(runtime.key);
	const source = resolveSessionRuntimeEventSource(runtime.key, activeSessionRuntimeKey);
	// The old process and its extension ctx cannot resume after disconnect.
	// Attribute the failure to the originating tab before releasing its fence.
	dispatchSyntheticRunEndNotify(runtime, source);
	applySessionRuntimeLifecycleSignal(runtime, { type: "terminal_failure" });
	scheduleStaleRuntimeRestart(runtime);
	flushPendingAuthConfigReload();
}

function handleSessionRuntimeLifecycleEvent(
	runtime: SessionRuntime,
	event: Record<string, unknown>,
): void {
	const type = typeof event.type === "string" ? event.type : "unknown";
	if (type === "agent_start") {
		markRuntimeRunStarted(runtime.key);
		return;
	}
	if (type === "agent_end") {
		applySessionRuntimeLifecycleSignal(runtime, { type: "agent_end" });
		return;
	}
	if (type === "error") {
		markRuntimeRunErrored(runtime.key);
		return;
	}
	if (type === "agent_settled") {
		if (!runtime.awaitingAgentSettled || runtime.pendingSettleTimer !== null) return;
		// pi emits its external agent_settled only after awaiting every extension
		// agent_settled callback. Keep the runtime protected through one browser
		// task so queued extension-ui events from the same stdout turn route first.
		const runEpoch = runtime.runEpoch;
		runtime.pendingSettleTimer = setTimeout(() => {
			runtime.pendingSettleTimer = null;
			finalizeSessionRuntimeRun(runtime, runEpoch);
		}, 0);
		return;
	}
	if (type === "rpc_disconnected") {
		terminalizeSessionRuntimeRun(runtime);
		return;
	}
	if (type === "rpc_reconnected") {
		// A reconnect starts a new pi process from the current on-disk config.
		runtime.configRevision = runtimeConfigRevision;
		return;
	}
	if (type === "rpc_reconnect_failed") {
		terminalizeSessionRuntimeRun(runtime);
	}
}

// ---------------------------------------------------------------------------
// RUNTIME-03/04 配置 revision：配置保存即递增；过期 runtime 的处置分三类——
//   1. warm 热备：立即淘汰（绝不收养旧配置进程）；
//   2. 后台运行中：标记 stale，agent_settled 后重启加载新配置；
//   3. 后台空闲/挂起：下次激活前经 ensureRuntimeForSessionTab 重启。
// ---------------------------------------------------------------------------

function bumpRuntimeConfigRevision(trigger: string): void {
	runtimeConfigRevision += 1;
	recordDebugTrace(`config-revision bump rev=${runtimeConfigRevision} trigger=${trigger}`);
	evictStaleWarmRuntimes();
}

/** 配置变化立即淘汰所有旧 revision 的 warm runtime。 */
function evictStaleWarmRuntimes(): void {
	for (const runtime of [...sessionRuntimes.values()]) {
		if (!isWarmPoolRuntime(runtime)) continue;
		if (runtime.configRevision >= runtimeConfigRevision) continue;
		recordDebugTrace(`config-revision evict-warm runtime=${runtime.instanceId} rev=${runtime.configRevision} current=${runtimeConfigRevision}`);
		const inflight = runtime.ensureInFlight;
		removeRuntimeByKey(runtime.key);
		if (inflight) {
			// 启动在途：进程可能在 stop 之后才完成 spawn，落定后再兜底停一次。
			void inflight
				.catch(() => {})
				.then(() => stopRuntimeInstance(runtime))
				.catch((err) => {
					recordDebugTrace(
						`config-revision late-stop-failed runtime=${runtime.instanceId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
		}
	}
}

/** 配置已过期：只在 run fence 与 ensure 都落定后重启，恢复原会话附着。 */
function scheduleStaleRuntimeRestart(runtime: SessionRuntime): void {
	if (isWarmPoolRuntime(runtime)) return;
	if (runtime.suspended || !runtime.bridge.isConnected) return;
	if (runtime.configRevision >= runtimeConfigRevision) {
		runtime.restartAfterSettlement = false;
		return;
	}
	if (isSessionRuntimeProtected(runtime)) {
		runtime.restartAfterSettlement = true;
		recordDebugTrace(
			`config-stale:defer-protected runtime=${runtime.instanceId} rev=${runtime.configRevision} current=${runtimeConfigRevision}`,
		);
		return;
	}
	if (runtime.ensureInFlight) {
		runtime.restartAfterSettlement = true;
		const pendingEnsure = runtime.ensureInFlight;
		void pendingEnsure
			.catch(() => {
				/* the caller owns the ensure error; still reevaluate deferred restart */
			})
			.finally(() => {
				if (runtime.ensureInFlight === pendingEnsure) {
					setTimeout(() => {
						if (sessionRuntimes.get(runtime.key) !== runtime) return;
						scheduleStaleRuntimeRestart(runtime);
					}, 0);
				}
			});
		return;
	}
	const workspace = workspaces.find((entry) => entry.id === runtime.workspaceId) ?? null;
	const tab = workspace?.sessionTabs.find((entry) => entry.id === runtime.tabId) ?? null;
	if (!workspace || !tab) return;
	runtime.restartAfterSettlement = false;
	recordDebugTrace(`config-stale:settled-restart runtime=${runtime.instanceId} rev=${runtime.configRevision} current=${runtimeConfigRevision}`);
	void ensureRuntimeForSessionTab(workspace, tab, runtime.projectPath, false).catch((err) => {
		recordDebugTrace(`config-stale:settled-restart-failed runtime=${runtime.instanceId}: ${err instanceof Error ? err.message : String(err)}`);
	});
}

function handleBackgroundRuntimeNotifyEvent(runtimeKey: string, event: Record<string, unknown>): void {
	const runtime = sessionRuntimes.get(runtimeKey);
	if (!runtime) return;
	if (runtime.key === activeSessionRuntimeKey) return;

	const type = typeof event.type === "string" ? event.type : "unknown";
	if (type === "agent_start" || type === "error" || type === "agent_settled") return;
	if (type === "rpc_reconnect_failed") {
		recordDebugTrace(`rpc:reconnect-failed source=background runtime=${runtime.instanceId}`);
		return;
	}
	if (type === "rpc_inflight_lost") {
		// 后台 runtime 断线丢失的在途用户消息：同样提示可能未送达（active runtime 走 proxy 监听，不会重复）。
		recordDebugTrace(`rpc:inflight-lost source=background runtime=${runtime.instanceId}`);
		chatView?.notify(t("app.errors.rpcInflightLost"), "error");
		return;
	}
	if (type === "rpc_offline_queue_full") {
		const max = typeof event.max === "number" ? event.max : 100;
		chatView?.notify(t("app.errors.rpcOfflineQueueFull", { max }), "error");
		return;
	}
	if (type !== "extension_ui_request") return;
	const method = typeof event.method === "string" ? event.method : "unknown";
	if (method !== "notify") {
		// RUNTIME-02：后台 runtime 的交互请求（confirm/input/select 等）无法前台展示，
		// 立即向来源 bridge 回复 cancelled，避免扩展侧永久等待。
		const requestId = typeof event.id === "string" ? event.id.trim() : "";
		recordDebugTrace(`extension_ui_request background-interactive-cancel method=${method} runtime=${runtime.instanceId}`);
		if (requestId) {
			void runtime.bridge.sendExtensionUiResponse({
				type: "extension_ui_response",
				id: requestId,
				cancelled: true,
			});
		}
		return;
	}
	markRuntimeRunNotifyObserved(runtime.key);

	const message = typeof event.message === "string" ? event.message : "";
	recordDebugTrace(`rpc:event type=${type} source=background runtime=${runtime.instanceId}`);
	recordDebugTrace(`extension_ui_request method=${method} message=${message.slice(0, 80)} source=background runtime=${runtime.instanceId}`);

	const request = { ...(event as Record<string, unknown>) };
	// extension-ui 路由契约：标出来源 runtime，回复经 extension-ui-response-route 按它路由回对应 bridge。
	request.runtimeId = runtime.instanceId;
	const target = resolveRuntimeNotifyTarget(runtime);
	attachNotifyTargetToRequest(request, target, "background", runtime);

	const normalizedRequest = normalizeExtensionUiRequest(request);
	if (!normalizedRequest) {
		const requestId = typeof request.id === "string" ? request.id.trim() : "";
		const unsupportedMethod = typeof request.method === "string" ? request.method : "unknown";
		recordDebugTrace(`extension_ui_request unsupported method=${unsupportedMethod} source=background runtime=${runtime.instanceId}`);
		if (requestId) {
			void runtime.bridge.sendExtensionUiResponse({
				type: "extension_ui_response",
				id: requestId,
				success: false,
				error: `Unsupported extension UI capability: ${unsupportedMethod}`,
			});
		}
		return;
	}

	void extensionUiHandler?.handleRequest(normalizedRequest);
}

function setRuntimeRunning(runtime: SessionRuntime | null, running: boolean, _options: { suppressNotify?: boolean } = {}): void {
	if (!runtime) return;
	applySessionRuntimeLifecycleSignal(runtime, {
		type: "streaming_state",
		isStreaming: running,
	});
}

function syncRunningSessionIndicators(): void {
	const runningPaths: string[] = [];
	for (const runtime of sessionRuntimes.values()) {
		// Keep the originating task active through the external agent_settled
		// boundary. agent_end/isStreaming=false may arrive earlier while queued
		// continuation or extension callbacks still belong to the run.
		if (!runtime.awaitingAgentSettled) continue;
		if (!runtime.lastKnownSessionPath) continue;
		runningPaths.push(runtime.lastKnownSessionPath);
	}
	sidebar?.setRunningSessionPaths(runningPaths);
	syncSuspendedSessionIndicators();
}

function ensureRunningSessionPoller(): void {
	const hasRunning = [...sessionRuntimes.values()].some((runtime) => runtime.running);
	if (!hasRunning) {
		if (runningSessionPollInterval) {
			clearInterval(runningSessionPollInterval);
			runningSessionPollInterval = null;
		}
		return;
	}

	if (runningSessionPollInterval) return;
	runningSessionPollInterval = setInterval(() => {
		void pollBackgroundRuntimeState();
	}, 1200);
}

async function pollBackgroundRuntimeState(): Promise<void> {
	if (runningSessionPollInFlight) return;
	runningSessionPollInFlight = true;
	try {
		const runtimes = [...sessionRuntimes.values()].filter((runtime) => runtime.running && runtime.key !== activeSessionRuntimeKey);
		if (runtimes.length === 0) return;

		let changed = false;
		for (const runtime of runtimes) {
			try {
				const state = await runtime.bridge.getState();
				if (state.sessionFile) {
					runtime.lastKnownSessionPath = state.sessionFile;
				}
				const running = Boolean(state.isStreaming);
				if (running !== runtime.running) {
					setRuntimeRunning(runtime, running);
					changed = true;
				}
			} catch {
				try {
					const alive = await runtime.bridge.refreshRunningState();
					if (!alive && runtime.running) {
						setRuntimeRunning(runtime, false, { suppressNotify: true });
						changed = true;
					}
				} catch {
					// ignore polling errors; next tick may recover
				}
			}
		}

		if (changed) {
			syncRunningSessionIndicators();
			ensureRunningSessionPoller();
		}
	} finally {
		runningSessionPollInFlight = false;
	}
}

function updateRuntimeFromState(runtime: SessionRuntime | null, state: RpcSessionState): void {
	if (!runtime) return;
	touchRuntime(runtime);
	const previousSessionPath = normalizeSessionPath(runtime.lastKnownSessionPath);
	if (state.sessionFile) {
		runtime.lastKnownSessionPath = state.sessionFile;
	}
	setRuntimeRunning(runtime, Boolean(state.isStreaming));
	const nextSessionPath = normalizeSessionPath(runtime.lastKnownSessionPath);
	if (runtime.running && nextSessionPath && nextSessionPath !== previousSessionPath) {
		// Fresh sessions start streaming before pi assigns their session file.
		// Once the path arrives, republish the running set even though the
		// boolean running state itself did not change.
		syncRunningSessionIndicators();
	}
}

// ---------------------------------------------------------------------------
// Runtime supervisor: concurrency cap + idle reclamation
//
// A "suspended" runtime keeps its tab and session path but its pi process is
// stopped. Activating the tab restarts the process and re-attaches the session
// (see ensureRuntimeForSessionTab). Streaming runtimes and the currently
// visible runtime are never suspended.
// ---------------------------------------------------------------------------

function touchRuntime(runtime: SessionRuntime): void {
	runtime.lastActivityAt = Date.now();
}

async function loadRuntimeSupervisorSettings(): Promise<void> {
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const saved = (await invoke("load_settings")) as {
			max_running_runtimes?: number;
			runtime_idle_timeout_minutes?: number;
		};
		const max = saved?.max_running_runtimes;
		if (typeof max === "number" && Number.isFinite(max) && max >= 1) {
			maxRunningRuntimes = Math.floor(max);
		}
		const idle = saved?.runtime_idle_timeout_minutes;
		if (typeof idle === "number" && Number.isFinite(idle) && idle >= 1) {
			runtimeIdleTimeoutMinutes = Math.floor(idle);
		}
		recordDebugTrace(`runtime-supervisor settings max=${maxRunningRuntimes} idleMinutes=${runtimeIdleTimeoutMinutes}`);
	} catch {
		// keep defaults when settings are unavailable
	}
}

function ensureRuntimeSupervisor(): void {
	if (runtimeSupervisorInterval) return;
	runtimeSupervisorInterval = setInterval(() => {
		void scanIdleRuntimes();
	}, 30_000);
}

async function suspendRuntime(runtime: SessionRuntime, reason: string): Promise<boolean> {
	if (runtime.suspended) return false;
	if (isSessionRuntimeProtected(runtime)) return false;
	if (runtime.key === activeSessionRuntimeKey) return false;
	runtime.suspended = true;
	runtime.phase = "idle";
	recordDebugTrace(`runtime-suspend instance=${runtime.instanceId} reason=${reason} session=${runtime.lastKnownSessionPath ?? "-"}`);
	try {
		await runtime.bridge.stop();
	} catch {
		// ignore stop failures; the process may already be gone
	}
	setRuntimeRunning(runtime, false, { suppressNotify: true });
	syncSuspendedSessionIndicators();
	ensureRunningSessionPoller();
	syncDebugOverlay();
	return true;
}

async function enforceRuntimeConcurrencyLimit(excludeKey: string): Promise<void> {
	const connected = [...sessionRuntimes.values()].filter(
		(runtime) => !runtime.suspended && runtime.bridge.isConnected && runtime.key !== excludeKey,
	);
	while (connected.length >= maxRunningRuntimes) {
		const victim = connected
			.filter((runtime) => !isSessionRuntimeProtected(runtime) && runtime.key !== activeSessionRuntimeKey)
			.sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
		if (!victim) return;
		const suspended = await suspendRuntime(victim, "concurrency-limit");
		if (!suspended) return;
		connected.splice(connected.indexOf(victim), 1);
	}
}

async function scanIdleRuntimes(): Promise<void> {
	const idleMs = runtimeIdleTimeoutMinutes * 60_000;
	const now = Date.now();
	for (const runtime of sessionRuntimes.values()) {
		if (runtime.suspended || isSessionRuntimeProtected(runtime)) continue;
		if (runtime.key === activeSessionRuntimeKey) continue;
		if (!runtime.bridge.isConnected) continue;
		if (now - runtime.lastActivityAt < idleMs) continue;
		await suspendRuntime(runtime, "idle-timeout");
	}
}

function syncSuspendedSessionIndicators(): void {
	const suspendedPaths: string[] = [];
	for (const runtime of sessionRuntimes.values()) {
		if (!runtime.suspended) continue;
		if (!runtime.lastKnownSessionPath) continue;
		suspendedPaths.push(runtime.lastKnownSessionPath);
	}
	sidebar?.setSuspendedSessionPaths(suspendedPaths);
}

async function stopRuntimeInstance(runtime: SessionRuntime): Promise<void> {
	try {
		await runtime.bridge.stop();
	} finally {
		await runtime.bridge.teardownListeners().catch(() => {
			// Listener teardown failure does not mean the process is still alive.
		});
	}
}

/** 每个 runtime 对象至多发起一次停止：停止链路全程可 await，重复调用幂等。 */
const runtimeStopPromises = new WeakMap<SessionRuntime, Promise<void>>();

function trackRuntimeStop(runtime: SessionRuntime): Promise<void> {
	const existing = runtimeStopPromises.get(runtime);
	if (existing) return existing;
	const promise = stopRuntimeInstance(runtime);
	runtimeStopPromises.set(runtime, promise);
	void promise.catch((err) => {
		recordDebugTrace(
			`runtime-stop:failed instance=${runtime.instanceId} error=${err instanceof Error ? err.message : String(err)}`,
		);
	});
	return promise;
}

/** 带超时兜底的停止结果；失败和超时必须传回删除确认流程。 */
function awaitStopResult(
	instanceId: string,
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<SessionDeleteStopResult> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return Promise.race([
		promise
			.then<SessionDeleteStopResult>(() => ({ status: "stopped" }))
			.catch<SessionDeleteStopResult>((err) => ({
				status: "failed",
				instanceIds: [instanceId],
				error: err instanceof Error ? err.message : String(err),
			})),
		new Promise<SessionDeleteStopResult>((resolve) => {
			timer = setTimeout(() => resolve({ status: "timed_out", instanceIds: [instanceId] }), timeoutMs);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/** Pure reducer for multi-runtime delete preparation; exported for state tests. */
export function mergeSessionDeleteStopResults(results: SessionDeleteStopResult[]): SessionDeleteStopResult {
	const failures = results.filter(
		(result): result is Extract<SessionDeleteStopResult, { status: "failed" }> => result.status === "failed",
	);
	if (failures.length > 0) {
		return {
			status: "failed",
			instanceIds: failures.flatMap((result) => result.instanceIds),
			error: failures.map((result) => result.error).join("；"),
		};
	}
	const timedOut = results.filter(
		(result): result is Extract<SessionDeleteStopResult, { status: "timed_out" }> => result.status === "timed_out",
	);
	if (timedOut.length > 0) {
		return {
			status: "timed_out",
			instanceIds: timedOut.flatMap((result) => result.instanceIds),
		};
	}
	return { status: "stopped" };
}

function removeRuntimeByKey(runtimeKey: string): Promise<void> | null {
	const runtime = sessionRuntimes.get(runtimeKey);
	if (!runtime) return null;
	runtime.eventUnlisten?.();
	runtime.eventUnlisten = null;
	cancelPendingRuntimeSettlement(runtime);
	runtime.runEpoch += 1;
	applySessionRuntimeLifecycleSignal(runtime, { type: "terminal_failure" });
	sessionRuntimes.delete(runtimeKey);
	clearRuntimeRunState(runtimeKey);
	if (activeSessionRuntimeKey === runtimeKey) {
		setActiveRuntime(null);
	}
	runtime.phase = "idle";
	syncDebugOverlay();
	return trackRuntimeStop(runtime);
}

function removeRuntimeForTab(workspaceId: string, tabId: string): void {
	removeRuntimeByKey(sessionRuntimeKey(workspaceId, tabId));
}

function listRuntimeKeysForWorkspace(workspaceId: string): string[] {
	return [...sessionRuntimes.keys()].filter((key) => key.startsWith(`${workspaceId}::`));
}

function removeRuntimeKeys(keys: string[]): void {
	keys.forEach((key) => removeRuntimeByKey(key));
}

function removeRuntimesForWorkspace(workspaceId: string): void {
	removeRuntimeKeys(listRuntimeKeysForWorkspace(workspaceId));
}

/** 删除会话前等待单个 runtime 停止的超时兜底：超时交给用户确认是否继续。 */
const SESSION_DELETE_STOP_TIMEOUT_MS = 5_000;

/**
 * 删除会话文件前调用：匹配所有 workspace 中附着该 session 的 tab（含 runtime
 * 最近已知附着），停止对应 runtime 并等待退出（租约随停止释放）。
 * 停止幂等；启动在途的先等落定（带超时），落定后兜底再停一次，避免 spawn
 * 晚于 stop 完成而留下孤儿进程；单个 runtime 最多等 5s，超时/失败由 sidebar
 * 的危险操作确认流程决定是否仍要移入废纸篓。
 */
async function awaitRuntimeStoppedForSession(sessionPath: string): Promise<SessionDeleteStopResult> {
	const normalizedTarget = normalizeSessionPath(sessionPath);
	if (!normalizedTarget) return { status: "stopped" };
	const stops: Array<{ instanceId: string; promise: Promise<unknown> }> = [];
	for (const workspace of workspaces) {
		ensureWorkspaceContentState(workspace);
		for (const tab of workspace.sessionTabs) {
			const runtime = getRuntimeForTab(workspace.id, tab.id);
			if (!runtime) continue;
			const attached =
				normalizeSessionPath(tab.sessionPath) === normalizedTarget ||
				normalizeSessionPath(runtime.lastKnownSessionPath) === normalizedTarget;
			if (!attached) continue;
			const ensureInFlight: Promise<unknown> | null = runtime.ensureInFlight;
			const initialStop = removeRuntimeByKey(runtime.key) ?? trackRuntimeStop(runtime);
			if (!ensureInFlight) {
				stops.push({ instanceId: runtime.instanceId, promise: initialStop });
				continue;
			}

			// stop() cancels bridge-level rpc_start/reconnect work immediately.
			// The app-level ensure chain may still be before bridge.start(), so
			// wait for it to settle and perform one final idempotent stop.
			const stopAfterEnsure = (async () => {
				await Promise.allSettled([initialStop, ensureInFlight]);
				await stopRuntimeInstance(runtime);
			})();
			void stopAfterEnsure.catch((err) => {
				recordDebugTrace(
					`session-delete:late-stop-failed instance=${runtime.instanceId} error=${err instanceof Error ? err.message : String(err)}`,
				);
			});
			stops.push({ instanceId: runtime.instanceId, promise: stopAfterEnsure });
		}
	}
	const results = await Promise.all(
		stops.map(async ({ instanceId, promise }) => {
			const result = await awaitStopResult(instanceId, promise, SESSION_DELETE_STOP_TIMEOUT_MS);
			recordDebugTrace(
				result.status === "stopped"
					? `session-delete:runtime-stopped instance=${instanceId}`
					: result.status === "timed_out"
						? `session-delete:runtime-stop-timeout instance=${instanceId} timeoutMs=${SESSION_DELETE_STOP_TIMEOUT_MS}`
						: `session-delete:runtime-stop-failed instance=${instanceId} error=${result.error}`,
			);
			return result;
		}),
	);
	return mergeSessionDeleteStopResults(results);
}

function normalizeStoredId(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeStoredPath(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function setWorkspaceActiveProject(
	workspace: WorkspaceState,
	project: { id?: string | null; path?: string | null } | null,
): void {
	workspace.activeProjectId = normalizeStoredId(project?.id ?? null);
	workspace.activeProjectPath = normalizeStoredPath(project?.path ?? null);
}

function setSessionTabProject(tab: WorkspaceSessionTab, projectId: string | null, projectPath: string | null): void {
	tab.projectId = normalizeStoredId(projectId);
	tab.projectPath = normalizeStoredPath(projectPath);
}

function setFileTabProject(tab: WorkspaceFileTab, projectId: string | null, projectPath: string | null): void {
	tab.projectId = normalizeStoredId(projectId);
	tab.projectPath = normalizeStoredPath(projectPath);
}

function getSessionTabProjectPath(tab: WorkspaceSessionTab | null | undefined): string | null {
	return normalizeStoredPath(tab?.projectPath ?? null);
}

function getFileTabProjectPath(tab: WorkspaceFileTab | null | undefined): string | null {
	return normalizeStoredPath(tab?.projectPath ?? null);
}

function getSessionTabProjectId(tab: WorkspaceSessionTab | null | undefined): string | null {
	return normalizeStoredId(tab?.projectId ?? null);
}

function getFileTabProjectId(tab: WorkspaceFileTab | null | undefined): string | null {
	return normalizeStoredId(tab?.projectId ?? null);
}

function getWorkspaceActiveProjectPath(workspace: WorkspaceState): string | null {
	const activeFile = workspace.fileTabs.find((tab) => tab.id === workspace.activeFileTabId) ?? null;
	const activeSession = workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId) ?? workspace.sessionTabs[0] ?? null;
	return workspace.pane === "file"
		? getFileTabProjectPath(activeFile) ?? getSessionTabProjectPath(activeSession) ?? normalizeStoredPath(workspace.activeProjectPath)
		: getSessionTabProjectPath(activeSession) ?? getFileTabProjectPath(activeFile) ?? normalizeStoredPath(workspace.activeProjectPath);
}

function getWorkspaceActiveProjectId(workspace: WorkspaceState): string | null {
	const activeFile = workspace.fileTabs.find((tab) => tab.id === workspace.activeFileTabId) ?? null;
	const activeSession = workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId) ?? workspace.sessionTabs[0] ?? null;
	return workspace.pane === "file"
		? getFileTabProjectId(activeFile) ?? getSessionTabProjectId(activeSession) ?? normalizeStoredId(workspace.activeProjectId)
		: getSessionTabProjectId(activeSession) ?? getFileTabProjectId(activeFile) ?? normalizeStoredId(workspace.activeProjectId);
}

function createSessionTab(
	title = NEW_SESSION_TAB_TITLE,
	sessionPath: string | null = null,
	projectId: string | null = null,
	projectPath: string | null = null,
): WorkspaceSessionTab {
	const normalizedSessionPath = normalizeStoredPath(sessionPath);
	return {
		id: uid("sessiontab"),
		projectId: normalizeStoredId(projectId),
		projectPath: normalizeStoredPath(projectPath),
		sessionPath: normalizedSessionPath,
		title: title.trim() || NEW_SESSION_TAB_TITLE,
		messageCount: normalizedSessionPath ? null : 0,
		ephemeral: !normalizedSessionPath,
		needsAttention: false,
		attentionMessage: null,
		isFork: false,
		parentSessionPath: null,
	};
}

function isDraftSessionTab(tab: WorkspaceSessionTab): boolean {
	return !tab.sessionPath;
}

function isEphemeralSessionTab(tab: WorkspaceSessionTab | null | undefined): boolean {
	return Boolean(tab?.ephemeral);
}

function isDraftFileTab(tab: WorkspaceFileTab): boolean {
	return !tab.path;
}

/**
 * Resolve a draft-created callback against its stable tab id across every
 * workspace. Never falls back to the active workspace: a missing or already
 * converted draft means the callback is stale and must be ignored.
 */
function findDraftFileOwner<
	TWorkspace extends { fileTabs: Array<{ id: string; path: string | null }> },
>(
	candidates: readonly TWorkspace[],
	draftId: string,
): { workspace: TWorkspace; tab: TWorkspace["fileTabs"][number] } | null {
	let owner: { workspace: TWorkspace; tab: TWorkspace["fileTabs"][number] } | null = null;
	for (const workspace of candidates) {
		const tab = workspace.fileTabs.find((entry) => entry.id === draftId && entry.path === null);
		if (!tab) continue;
		// Persisted duplicate ids are corrupt/ambiguous; refusing the callback is
		// safer than binding the newly written path to an arbitrary workspace.
		if (owner) return null;
		owner = { workspace, tab };
	}
	return owner;
}

function assertDraftFileOwnerRouting(): void {
	type TestWorkspace = { id: string; fileTabs: Array<{ id: string; path: string | null }> };
	const workspaceA: TestWorkspace = { id: "workspace-a", fileTabs: [{ id: "draft-a", path: null }] };
	const workspaceB: TestWorkspace = { id: "workspace-b", fileTabs: [{ id: "draft-b", path: null }] };
	const owner = findDraftFileOwner([workspaceB, workspaceA], "draft-a");
	if (owner?.workspace !== workspaceA || owner.tab !== workspaceA.fileTabs[0]) {
		throw new Error("Draft owner routing must resolve the originating inactive workspace.");
	}
	workspaceA.fileTabs[0].path = "/tmp/created.md";
	if (findDraftFileOwner([workspaceA, workspaceB], "draft-a") !== null) {
		throw new Error("Draft owner routing must reject stale callbacks for converted tabs.");
	}
	if (findDraftFileOwner([workspaceA, workspaceB], "missing") !== null) {
		throw new Error("Draft owner routing must not fall back to the active workspace.");
	}
	const duplicateA: TestWorkspace = { id: "duplicate-a", fileTabs: [{ id: "duplicate", path: null }] };
	const duplicateB: TestWorkspace = { id: "duplicate-b", fileTabs: [{ id: "duplicate", path: null }] };
	if (findDraftFileOwner([duplicateA, duplicateB], "duplicate") !== null) {
		throw new Error("Draft owner routing must reject ambiguous duplicate ids.");
	}
}

if (import.meta.env.DEV) {
	assertDraftFileOwnerRouting();
}

function ensureWorkspaceContentState(workspace: WorkspaceState): void {
	workspace.activeProjectId = normalizeStoredId(workspace.activeProjectId);
	workspace.activeProjectPath = normalizeStoredPath(workspace.activeProjectPath);

	const incomingSessionTabs = Array.isArray(workspace.sessionTabs) ? workspace.sessionTabs : [];
	workspace.sessionTabs = incomingSessionTabs
		.filter((tab) => tab && typeof tab.id === "string" && tab.id.length > 0)
		.map((tab) => {
			const sessionPath = normalizeStoredPath(tab.sessionPath);
			const storedMessageCount = (tab as Partial<WorkspaceSessionTab>).messageCount;
			const needsAttentionRaw = (tab as Partial<WorkspaceSessionTab>).needsAttention;
			const attentionMessageRaw = (tab as Partial<WorkspaceSessionTab>).attentionMessage;
			return {
				id: tab.id,
				projectId: normalizeStoredId((tab as Partial<WorkspaceSessionTab>).projectId),
				projectPath: normalizeStoredPath((tab as Partial<WorkspaceSessionTab>).projectPath),
				sessionPath,
				title: typeof tab.title === "string" && tab.title.trim().length > 0 ? tab.title.trim() : NEW_SESSION_TAB_TITLE,
				messageCount: typeof storedMessageCount === "number" && Number.isFinite(storedMessageCount) ? storedMessageCount : sessionPath ? null : 0,
				ephemeral: typeof (tab as Partial<WorkspaceSessionTab>).ephemeral === "boolean" ? Boolean((tab as Partial<WorkspaceSessionTab>).ephemeral) : !sessionPath,
				needsAttention: typeof needsAttentionRaw === "boolean" ? needsAttentionRaw : false,
				attentionMessage:
					typeof attentionMessageRaw === "string" && attentionMessageRaw.trim().length > 0
						? attentionMessageRaw.trim()
						: null,
				isFork: Boolean((tab as Partial<WorkspaceSessionTab>).isFork),
				parentSessionPath: normalizeStoredPath((tab as Partial<WorkspaceSessionTab>).parentSessionPath),
			};
		});

	if (workspace.sessionTabs.length === 0) {
		const fallbackTitle =
			typeof workspace.sessionTitle === "string" && workspace.sessionTitle.trim().length > 0
				? workspace.sessionTitle
				: NEW_SESSION_TAB_TITLE;
		workspace.sessionTabs = [createSessionTab(fallbackTitle, null, workspace.activeProjectId, workspace.activeProjectPath)];
	}

	if (workspace.sessionTabs.length > 1) {
		workspace.sessionTabs = workspace.sessionTabs.filter((tab) => {
			if (tab.sessionPath) return true;
			return tab.title.trim().toLowerCase() !== "chat";
		});
		if (workspace.sessionTabs.length === 0) {
			workspace.sessionTabs = [createSessionTab(NEW_SESSION_TAB_TITLE, null, workspace.activeProjectId, workspace.activeProjectPath)];
		}
	}

	if (!workspace.activeSessionTabId || !workspace.sessionTabs.some((tab) => tab.id === workspace.activeSessionTabId)) {
		workspace.activeSessionTabId = workspace.sessionTabs[0]?.id ?? null;
	}

	const incomingFileTabs = Array.isArray(workspace.fileTabs) ? workspace.fileTabs : [];
	workspace.fileTabs = incomingFileTabs
		.filter((tab) => tab && typeof tab.id === "string" && tab.id.length > 0)
		.map((tab) => {
			const path = normalizeStoredPath(tab.path);
			const fallbackTitle = path ? baseName(path) : NEW_FILE_TAB_TITLE;
			const projectPath = normalizeStoredPath((tab as Partial<WorkspaceFileTab>).projectPath);
			const draftDirectoryPath = path
				? null
				: normalizeStoredPath((tab as Partial<WorkspaceFileTab>).draftDirectoryPath) ?? projectPath;
			const draftAnchorPath = path ? null : normalizeStoredPath((tab as Partial<WorkspaceFileTab>).draftAnchorPath);
			return {
				id: tab.id,
				projectId: normalizeStoredId((tab as Partial<WorkspaceFileTab>).projectId),
				projectPath,
				path,
				title: typeof tab.title === "string" && tab.title.trim().length > 0 ? tab.title.trim() : fallbackTitle,
				draftDirectoryPath,
				draftAnchorPath,
			};
		});

	if (!workspace.activeFileTabId || !workspace.fileTabs.some((tab) => tab.id === workspace.activeFileTabId)) {
		workspace.activeFileTabId = workspace.fileTabs[0]?.id ?? null;
	}

	if (workspace.fileTabs.length > 1) {
		const activeFileTab = workspace.fileTabs.find((tab) => tab.id === workspace.activeFileTabId) ?? workspace.fileTabs[0] ?? null;
		workspace.fileTabs = activeFileTab ? [activeFileTab] : [];
		workspace.activeFileTabId = activeFileTab?.id ?? null;
	}

	const activeSession = workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId) ?? workspace.sessionTabs[0] ?? null;
	const activeFile = workspace.fileTabs.find((tab) => tab.id === workspace.activeFileTabId) ?? null;

	if (activeSession && isDraftSessionTab(activeSession) && !activeSession.projectPath && workspace.activeProjectPath) {
		setSessionTabProject(activeSession, workspace.activeProjectId, workspace.activeProjectPath);
	}
	if (activeFile && isDraftFileTab(activeFile) && !activeFile.projectPath && workspace.activeProjectPath) {
		setFileTabProject(activeFile, workspace.activeProjectId, workspace.activeProjectPath);
	}
	if (activeFile && isDraftFileTab(activeFile) && !activeFile.draftDirectoryPath) {
		activeFile.draftDirectoryPath = activeFile.projectPath ?? workspace.activeProjectPath;
	}
	if (activeFile && !isDraftFileTab(activeFile)) {
		activeFile.draftDirectoryPath = null;
		activeFile.draftAnchorPath = null;
	}

	workspace.activeProjectId = getWorkspaceActiveProjectId(workspace);
	workspace.activeProjectPath = getWorkspaceActiveProjectPath(workspace);
	workspace.sessionTitle = activeSession?.title ?? NEW_SESSION_TAB_TITLE;
	workspace.filePath = activeFile?.path ?? null;
}

function getActiveSessionTab(workspace: WorkspaceState): WorkspaceSessionTab {
	ensureWorkspaceContentState(workspace);
	return workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId) ?? workspace.sessionTabs[0];
}

function isSessionTabRuntimeRunning(workspaceId: string, tabId: string): boolean {
	const runtime = getRuntimeForTab(workspaceId, tabId);
	return isSessionRuntimeProtected(runtime);
}

function clearSessionAttention(tab: WorkspaceSessionTab | null | undefined): boolean {
	if (!tab) return false;
	return setSessionAttention(tab, false);
}

function markSessionAttentionTarget(target: {
	workspaceId?: string;
	tabId?: string;
	sessionPath?: string;
}): void {
	const workspace = target.workspaceId
		? workspaces.find((entry) => entry.id === target.workspaceId) ?? null
		: getActiveWorkspace();
	if (!workspace) return;
	ensureWorkspaceContentState(workspace);

	let tab: WorkspaceSessionTab | null = null;
	if (target.tabId) {
		tab = workspace.sessionTabs.find((entry) => entry.id === target.tabId) ?? null;
	}
	if (!tab && target.sessionPath) {
		const normalizedPath = normalizeSessionPath(target.sessionPath);
		tab = workspace.sessionTabs.find((entry) => normalizeSessionPath(entry.sessionPath) === normalizedPath) ?? null;
	}
	if (!tab && !target.tabId && !target.sessionPath) {
		tab = getActiveSessionTab(workspace);
	}
	if (!tab) return;

	const windowVisible = typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
	const sameActiveSession = activeWorkspaceId === workspace.id && workspace.activeSessionTabId === tab.id && workspace.pane === "chat";
	if (windowVisible && sameActiveSession) {
		if (clearSessionAttention(tab)) {
			persistWorkspaces();
			syncContentTabsBar(workspace);
		}
		return;
	}

	setSessionAttention(tab, true, pickSessionAttentionMessage(tab.attentionMessage));
	recordDebugTrace(`notify-attention:set workspace=${workspace.id} tab=${tab.id} message=${tab.attentionMessage}`);
	persistWorkspaces();
	if (activeWorkspaceId === workspace.id) {
		syncContentTabsBar(workspace);
		syncSidebarSelectionFromWorkspace(workspace);
	}
}

function clearVisibleActiveSessionAttention(): void {
	if (typeof document === "undefined") return;
	if (document.visibilityState !== "visible" || !document.hasFocus()) return;
	const workspace = getActiveWorkspace();
	if (!workspace || workspace.pane !== "chat") return;
	const tab = getActiveSessionTab(workspace);
	if (!clearSessionAttention(tab)) return;
	recordDebugTrace(`notify-attention:cleared workspace=${workspace.id} tab=${tab.id}`);
	persistWorkspaces();
	syncContentTabsBar(workspace);
	syncSidebarSelectionFromWorkspace(workspace);
}

function ensureNotificationAttentionListeners(): void {
	if (notificationAttentionListenersBound) return;
	notificationAttentionListenersBound = true;
	window.addEventListener("focus", () => {
		clearVisibleActiveSessionAttention();
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			clearVisibleActiveSessionAttention();
		}
	});
}

function setActiveSessionTab(workspace: WorkspaceState, tabId: string): WorkspaceSessionTab | null {
	ensureWorkspaceContentState(workspace);
	const tab = workspace.sessionTabs.find((entry) => entry.id === tabId);
	if (!tab) return null;
	clearSessionAttention(tab);
	workspace.activeSessionTabId = tab.id;
	workspace.sessionTitle = tab.title;
	setWorkspaceActiveProject(workspace, { id: tab.projectId, path: tab.projectPath });
	workspace.pane = "chat";
	return tab;
}

function openOrActivateSessionTab(
	workspace: WorkspaceState,
	sessionPath: string,
	projectId: string | null,
	projectPath: string | null,
	preferredTitle?: string,
	options: { allowCreateTab?: boolean; preferredTabId?: string | null } = {},
): WorkspaceSessionTab {
	ensureWorkspaceContentState(workspace);
	const normalized = normalizeSessionPath(sessionPath);
	const allowCreateTab = options.allowCreateTab ?? false;
	let tab = workspace.sessionTabs.find((entry) => normalizeSessionPath(entry.sessionPath) === normalized);
	const nextTitle = (preferredTitle || baseName(sessionPath)).trim() || t("app.tabs.chat");
	if (!tab) {
		const activeTab = workspace.sessionTabs.find((entry) => entry.id === workspace.activeSessionTabId) ?? null;
		const preferredTab = options.preferredTabId
			? workspace.sessionTabs.find((entry) => entry.id === options.preferredTabId) ?? null
			: null;
		const onlyTab = workspace.sessionTabs.length === 1 ? workspace.sessionTabs[0] : null;
		const onlyTabLooksLikeSeed = Boolean(onlyTab) && isSessionTabPlaceholderTitle(onlyTab?.title || "");
		const reusableCandidates: WorkspaceSessionTab[] = [];
		const pushReusableCandidate = (candidate: WorkspaceSessionTab | null | undefined) => {
			if (!candidate) return;
			if (reusableCandidates.some((entry) => entry.id === candidate.id)) return;
			reusableCandidates.push(candidate);
		};
		pushReusableCandidate(preferredTab);
		pushReusableCandidate(onlyTabLooksLikeSeed ? onlyTab : null);
		for (const candidate of workspace.sessionTabs) {
			if (candidate.id === activeTab?.id) continue;
			pushReusableCandidate(candidate);
		}
		pushReusableCandidate(activeTab);
		const reusableTab = allowCreateTab
			? null
			: reusableCandidates.find((candidate) => !isSessionTabRuntimeRunning(workspace.id, candidate.id)) ?? null;
		if (!allowCreateTab && !reusableTab && reusableCandidates.length > 0) {
			recordDebugTrace(
				`openOrActivateSessionTab:create-new avoid-running workspace=${workspace.id} target=${sessionPath}`,
			);
		}
		if (reusableTab) {
			const previousPath = reusableTab.sessionPath;
			const shouldDiscardPreviousEphemeral =
				Boolean(previousPath) &&
				isEphemeralSessionTab(reusableTab) &&
				(reusableTab.messageCount ?? 0) <= 0 &&
				normalizeSessionPath(previousPath) !== normalized;
			reusableTab.sessionPath = sessionPath;
			reusableTab.title = nextTitle;
			reusableTab.messageCount = null;
			reusableTab.ephemeral = false;
			if (normalizeSessionPath(previousPath) !== normalized) {
				// 复用标签改挂到别的会话后，旧的 fork 分支标记不再成立。
				reusableTab.isFork = false;
				reusableTab.parentSessionPath = null;
			}
			setSessionTabProject(reusableTab, projectId, projectPath);
			tab = reusableTab;
			if (shouldDiscardPreviousEphemeral && previousPath) {
				scheduleDiscardEphemeralSessionPaths([previousPath]);
			}
		} else {
			tab = createSessionTab(nextTitle, sessionPath, projectId, projectPath);
			workspace.sessionTabs.push(tab);
		}
	} else {
		setSessionTabProject(tab, projectId, projectPath);
		tab.messageCount = tab.messageCount ?? null;
		tab.ephemeral = false;
		if (preferredTitle && preferredTitle.trim().length > 0) {
			tab.title = preferredTitle.trim();
		}
	}
	clearSessionAttention(tab);
	workspace.activeSessionTabId = tab.id;
	workspace.sessionTitle = tab.title;
	setWorkspaceActiveProject(workspace, { id: tab.projectId, path: tab.projectPath });
	workspace.pane = "chat";
	return tab;
}

/**
 * fork 完成后，把分叉前的原会话保留为独立标签页。
 * fork RPC 会把当前 runtime 就地切到分支会话文件（活动标签经 state 同步后指向分支），
 * 这里为原会话补建一个标签页：置于分支标签之前、不激活、不预热 runtime
 * （首次切回时按普通会话加载），使分叉以「原会话 + 分支会话」两个 tab 呈现，
 * 关闭/重命名等分叉管理复用现有 tab 交互。
 */
function preserveForkSourceSessionTab(info: SessionForkedInfo): void {
	const workspace = getActiveWorkspace();
	if (!workspace) return;
	const sourcePath = normalizeStoredPath(info.sourceSessionPath);
	const forkedPath = normalizeStoredPath(info.forkedSessionPath);
	if (!sourcePath || !forkedPath) return;
	if (normalizeSessionPath(sourcePath) === normalizeSessionPath(forkedPath)) return;
	ensureWorkspaceContentState(workspace);
	const forkTab = getActiveSessionTab(workspace);
	if (normalizeSessionPath(forkTab.sessionPath) !== normalizeSessionPath(forkedPath)) return;
	// 给分支标签打 fork 标记（tab 栏仅在可见标签中存在 fork 分支标签时显示）。
	// 打标前 forkTab 承载的是源会话状态，先记下源本身的分支标记供下面保留。
	const sourceWasFork = forkTab.isFork;
	const sourceParentPath = forkTab.parentSessionPath;
	forkTab.isFork = true;
	forkTab.parentSessionPath = sourcePath;
	const normalizedSource = normalizeSessionPath(sourcePath);
	if (workspace.sessionTabs.some((tab) => tab.id !== forkTab.id && normalizeSessionPath(tab.sessionPath) === normalizedSource)) {
		persistWorkspaces();
		syncWorkspaceTabsBar();
		syncContentTabsBar(workspace);
		syncSidebarSelectionFromWorkspace(workspace);
		return;
	}
	const insertIndex = workspace.sessionTabs.findIndex((tab) => tab.id === forkTab.id);
	const sourceTab = createSessionTab(
		info.sourceTitle?.trim() || baseName(sourcePath),
		sourcePath,
		forkTab.projectId,
		forkTab.projectPath,
	);
	sourceTab.messageCount = null;
	sourceTab.ephemeral = false;
	// fork 的 fork：源会话本身也是分支时，保留其分支标记与父链路。
	sourceTab.isFork = sourceWasFork;
	sourceTab.parentSessionPath = sourceParentPath;
	workspace.sessionTabs.splice(insertIndex < 0 ? workspace.sessionTabs.length : insertIndex, 0, sourceTab);
	persistWorkspaces();
	syncWorkspaceTabsBar();
	syncContentTabsBar(workspace);
	syncSidebarSelectionFromWorkspace(workspace);
}

function openOrActivateFileTab(
	workspace: WorkspaceState,
	filePath: string,
	projectId: string | null,
	projectPath: string | null,
	options: { allowCreateTab?: boolean; preferredTabId?: string | null } = {},
): WorkspaceFileTab {
	ensureWorkspaceContentState(workspace);
	const normalized = normalizeProjectPath(filePath);
	const allowCreateTab = options.allowCreateTab ?? false;
	let tab = workspace.fileTabs.find((entry) => normalizeProjectPath(entry.path) === normalized);
	if (!tab) {
		const preferredTab = options.preferredTabId
			? workspace.fileTabs.find((entry) => entry.id === options.preferredTabId) ?? null
			: null;
		const activeTab = workspace.fileTabs.find((entry) => entry.id === workspace.activeFileTabId) ?? null;
		const reusableTab = allowCreateTab ? null : preferredTab ?? activeTab ?? workspace.fileTabs[0] ?? null;
		if (reusableTab) {
			reusableTab.path = filePath;
			reusableTab.title = baseName(filePath);
			setFileTabProject(reusableTab, projectId, projectPath);
			reusableTab.draftDirectoryPath = null;
			reusableTab.draftAnchorPath = null;
			tab = reusableTab;
		} else {
			tab = {
				id: uid("filetab"),
				projectId: normalizeStoredId(projectId),
				projectPath: normalizeStoredPath(projectPath),
				path: filePath,
				title: baseName(filePath),
				draftDirectoryPath: null,
				draftAnchorPath: null,
			};
			workspace.fileTabs.push(tab);
		}
	} else {
		setFileTabProject(tab, projectId, projectPath);
		tab.draftDirectoryPath = null;
		tab.draftAnchorPath = null;
	}
	workspace.activeFileTabId = tab.id;
	workspace.filePath = tab.path;
	workspace.pane = "chat";
	return tab;
}

function createAndActivateEmptyFileTab(
	workspace: WorkspaceState,
	title = NEW_FILE_TAB_TITLE,
	projectId: string | null = workspace.activeProjectId,
	projectPath: string | null = workspace.activeProjectPath,
	draftDirectoryPath: string | null = projectPath,
	draftAnchorPath: string | null = null,
	options: { forceNewTab?: boolean } = {},
): WorkspaceFileTab {
	ensureWorkspaceContentState(workspace);
	const forceNewTab = options.forceNewTab ?? false;
	const normalizedDraftDirectoryPath = normalizeStoredPath(draftDirectoryPath) ?? normalizeStoredPath(projectPath);
	const normalizedDraftAnchorPath = normalizeStoredPath(draftAnchorPath);
	const activeFileTab = workspace.fileTabs.find((entry) => entry.id === workspace.activeFileTabId) ?? workspace.fileTabs[0] ?? null;
	if (activeFileTab && !forceNewTab) {
		activeFileTab.path = null;
		activeFileTab.title = title.trim() || NEW_FILE_TAB_TITLE;
		setFileTabProject(activeFileTab, projectId, projectPath);
		activeFileTab.draftDirectoryPath = normalizedDraftDirectoryPath;
		activeFileTab.draftAnchorPath = normalizedDraftAnchorPath;
		workspace.activeFileTabId = activeFileTab.id;
		workspace.filePath = null;
		workspace.pane = "chat";
		return activeFileTab;
	}
	const tab: WorkspaceFileTab = {
		id: uid("filetab"),
		projectId: normalizeStoredId(projectId),
		projectPath: normalizeStoredPath(projectPath),
		path: null,
		title: title.trim() || NEW_FILE_TAB_TITLE,
		draftDirectoryPath: normalizedDraftDirectoryPath,
		draftAnchorPath: normalizedDraftAnchorPath,
	};
	workspace.fileTabs.push(tab);
	workspace.activeFileTabId = tab.id;
	workspace.filePath = null;
	workspace.pane = "chat";
	return tab;
}

function getActiveFileTab(workspace: WorkspaceState): WorkspaceFileTab | null {
	ensureWorkspaceContentState(workspace);
	return workspace.fileTabs.find((tab) => tab.id === workspace.activeFileTabId) ?? workspace.fileTabs[0] ?? null;
}

interface WorkspaceFileNavigationSnapshot {
	activeProjectId: string | null;
	activeProjectPath: string | null;
	pane: WorkspaceState["pane"];
	fileTabs: WorkspaceFileTab[];
	activeFileTabId: string | null;
	filePath: string | null;
}

function captureWorkspaceFileNavigation(workspace: WorkspaceState): WorkspaceFileNavigationSnapshot {
	return {
		activeProjectId: workspace.activeProjectId,
		activeProjectPath: workspace.activeProjectPath,
		pane: workspace.pane,
		fileTabs: workspace.fileTabs.map((tab) => ({ ...tab })),
		activeFileTabId: workspace.activeFileTabId,
		filePath: workspace.filePath,
	};
}

function restoreWorkspaceFileNavigation(
	workspace: WorkspaceState,
	snapshot: WorkspaceFileNavigationSnapshot,
): void {
	workspace.activeProjectId = snapshot.activeProjectId;
	workspace.activeProjectPath = snapshot.activeProjectPath;
	workspace.pane = snapshot.pane;
	workspace.fileTabs = snapshot.fileTabs.map((tab) => ({ ...tab }));
	workspace.activeFileTabId = snapshot.activeFileTabId;
	workspace.filePath = snapshot.filePath;
}

/**
 * Commit file-tab navigation only after FileViewer has saved the previous
 * target and successfully opened the new one. On cancel/save failure, restore
 * the exact prior tab object too (the normal reuse path mutates it in place).
 */
async function commitWorkspaceFileNavigation(
	workspace: WorkspaceState,
	snapshot: WorkspaceFileNavigationSnapshot,
): Promise<boolean> {
	let opened = false;
	try {
		opened = await applyWorkspacePane(workspace, { deferFileNavigationCommit: true });
	} catch (err) {
		recordDebugTrace(`file-navigation:open-failed error=${err instanceof Error ? err.message : String(err)}`);
	}
	if (!opened) {
		restoreWorkspaceFileNavigation(workspace, snapshot);
		syncWorkspaceTabsBar();
		syncContentTabsBar(workspace);
		syncSidebarSelectionFromWorkspace(workspace);
		await applyWorkspacePane(workspace).catch((err) => {
			recordDebugTrace(`file-navigation:rollback-render-failed error=${err instanceof Error ? err.message : String(err)}`);
		});
		return false;
	}
	persistWorkspaces();
	syncWorkspaceTabsBar();
	syncContentTabsBar(workspace);
	syncSidebarSelectionFromWorkspace(workspace);
	return true;
}

function resetWorkspaceContentTabs(
	workspace: WorkspaceState,
	project: { id?: string | null; path?: string | null } | null = { id: workspace.activeProjectId, path: workspace.activeProjectPath },
): void {
	const previousPane = workspace.pane;
	setWorkspaceActiveProject(workspace, project);
	workspace.sessionTabs = [createSessionTab(NEW_SESSION_TAB_TITLE, null, workspace.activeProjectId, workspace.activeProjectPath)];
	workspace.activeSessionTabId = workspace.sessionTabs[0].id;
	workspace.fileTabs = [];
	workspace.activeFileTabId = null;
	workspace.filePath = null;
	workspace.sessionTitle = NEW_SESSION_TAB_TITLE;
	workspace.pane = previousPane === "settings" || previousPane === "packages" ? previousPane : "chat";
}

function createAndActivateEmptySessionTab(
	workspace: WorkspaceState,
	title = NEW_SESSION_TAB_TITLE,
	projectId: string | null = workspace.activeProjectId,
	projectPath: string | null = workspace.activeProjectPath,
	options: { forceNewTab?: boolean } = {},
): WorkspaceSessionTab {
	ensureWorkspaceContentState(workspace);
	const forceNewTab = options.forceNewTab ?? false;
	const activeSessionTab = workspace.sessionTabs.find((entry) => entry.id === workspace.activeSessionTabId) ?? workspace.sessionTabs[0] ?? null;
	if (activeSessionTab && !forceNewTab && !isSessionTabRuntimeRunning(workspace.id, activeSessionTab.id)) {
		if (isEphemeralSessionTab(activeSessionTab) && activeSessionTab.sessionPath && (activeSessionTab.messageCount ?? 0) <= 0) {
			scheduleDiscardEphemeralSessionPaths([activeSessionTab.sessionPath]);
		}
		activeSessionTab.sessionPath = null;
		activeSessionTab.title = title.trim() || NEW_SESSION_TAB_TITLE;
		activeSessionTab.messageCount = 0;
		activeSessionTab.ephemeral = true;
		clearSessionAttention(activeSessionTab);
		setSessionTabProject(activeSessionTab, projectId, projectPath);
		workspace.activeSessionTabId = activeSessionTab.id;
		workspace.sessionTitle = activeSessionTab.title;
		setWorkspaceActiveProject(workspace, { id: activeSessionTab.projectId, path: activeSessionTab.projectPath });
		workspace.pane = "chat";
		return activeSessionTab;
	}
	const tab = createSessionTab(title, null, projectId, projectPath);
	tab.messageCount = 0;
	tab.ephemeral = true;
	workspace.sessionTabs.push(tab);
	workspace.activeSessionTabId = tab.id;
	workspace.sessionTitle = tab.title;
	setWorkspaceActiveProject(workspace, { id: tab.projectId, path: tab.projectPath });
	workspace.pane = "chat";
	return tab;
}

function collectEphemeralSessionPaths(tabs: Array<WorkspaceSessionTab | null | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const tab of tabs) {
		if (!isEphemeralSessionTab(tab) || !tab?.sessionPath) continue;
		const normalized = normalizeSessionPath(tab.sessionPath);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(tab.sessionPath);
	}
	return result;
}

async function discardEphemeralSessionPaths(sessionPaths: string[]): Promise<void> {
	if (sessionPaths.length === 0) return;
	const { remove } = await import("@tauri-apps/plugin-fs");
	await Promise.all(
		sessionPaths.map(async (sessionPath) => {
			sidebar?.removeSessionPath(sessionPath);
			try {
				await remove(sessionPath);
			} catch (err) {
				console.warn("Failed to discard empty draft session:", sessionPath, err);
			}
		}),
	);
	scheduleSidebarSessionsRefresh(0);
}

function scheduleDiscardEphemeralSessionPaths(sessionPaths: string[]): void {
	if (sessionPaths.length === 0) return;
	void discardEphemeralSessionPaths(sessionPaths);
}

function scheduleDiscardEphemeralSessionTabs(tabs: Array<WorkspaceSessionTab | null | undefined>): void {
	const sessionPaths = collectEphemeralSessionPaths(tabs);
	scheduleDiscardEphemeralSessionPaths(sessionPaths);
}

function pruneInactiveEphemeralSessionTabs(workspace: WorkspaceState, keepTabIds: string[] = []): boolean {
	ensureWorkspaceContentState(workspace);
	const keep = new Set(keepTabIds);
	const removedTabs = workspace.sessionTabs.filter(
		(tab) =>
			isEphemeralSessionTab(tab) &&
			(tab.messageCount ?? 0) <= 0 &&
			!keep.has(tab.id) &&
			!isSessionTabRuntimeRunning(workspace.id, tab.id),
	);
	if (removedTabs.length === 0) return false;

	const removedIds = new Set(removedTabs.map((tab) => tab.id));
	workspace.sessionTabs = workspace.sessionTabs.filter((tab) => !removedIds.has(tab.id));

	if (removedIds.has(workspace.activeSessionTabId ?? "")) {
		const nextSession = workspace.sessionTabs[0] ?? null;
		workspace.activeSessionTabId = nextSession?.id ?? null;
		workspace.sessionTitle = nextSession?.title ?? NEW_SESSION_TAB_TITLE;
	}

	scheduleDiscardEphemeralSessionTabs(removedTabs);
	ensureWorkspaceContentState(workspace);
	return true;
}

function pruneEphemeralTabsWhenLeavingDraft(workspace: WorkspaceState, keepTabIds: string[] = []): boolean {
	if (!workspace.sessionTabs.some((tab) => !isEphemeralSessionTab(tab) || keepTabIds.includes(tab.id))) {
		return false;
	}
	return pruneInactiveEphemeralSessionTabs(workspace, keepTabIds);
}

function workspaceProjectsStorageKey(workspaceId: string): string {
	return `${WORKSPACE_PROJECTS_KEY_PREFIX}.${workspaceId}`;
}

function clampSidebarWidth(value: number): number {
	return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value));
}

function loadSidebarWidth(): void {
	try {
		const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
		if (!raw) {
			sidebarWidth = 320;
			return;
		}
		const parsed = Number(raw);
		sidebarWidth = Number.isFinite(parsed) ? clampSidebarWidth(parsed) : 320;
	} catch {
		sidebarWidth = 320;
	}
}

function persistSidebarWidth(): void {
	try {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebarWidth)));
	} catch {
		// ignore
	}
}

function isSidebarCollapsedState(): boolean {
	if (sidebar) return sidebar.isCollapsed();
	try {
		return localStorage.getItem(SIDEBAR_COLLAPSED_STATE_KEY) === "1";
	} catch {
		return false;
	}
}

function applyWorkspaceTopbarOffset(): void {
	const root = document.documentElement;
	const collapsed = isSidebarCollapsedState();
	const offset = collapsed ? 0 : Math.round(sidebarWidth) + 6;
	root.style.setProperty("--workspace-topbar-offset", `${offset}px`);
}

function syncSidebarCollapseToggleButton(): void {
	const button = document.getElementById("sidebar-collapse-toggle");
	if (!button) return;
	const collapsed = isSidebarCollapsedState();
	button.classList.toggle("hidden", !collapsed);
	button.classList.toggle("collapsed", collapsed);
	button.setAttribute("aria-expanded", compactSidebarOverlayOpen ? "true" : "false");
}

function toggleSidebarFromChrome(): void {
	const compact = window.matchMedia("(max-width: 760px)").matches;
	compactSidebarOverlayOpen = toggleCompactSidebarOverlay(compact, compactSidebarOverlayOpen);
	document
		.querySelector<HTMLElement>(".content-shell")
		?.classList.toggle("compact-sidebar-open", compactSidebarOverlayOpen);
	if (!compact) {
		sidebar?.toggleCollapsed();
	}
	syncSidebarCollapseToggleButton();
}

function applySidebarWidth(): void {
	const root = document.documentElement;
	root.style.setProperty("--sidebar-width", `${Math.round(sidebarWidth)}px`);
	applyWorkspaceTopbarOffset();
}

function assertProjectTaskCurrent(version: number): void {
	if (version !== projectSwitchVersion) {
		throw new StaleProjectTaskError();
	}
}

function queueProjectTask(
	task: (version: number) => Promise<void>,
	onError?: (err: unknown) => void,
	options: { invalidatePending?: boolean; label?: string; onDiscarded?: () => void } = {},
): Promise<void> {
	const invalidatePending = options.invalidatePending ?? true;
	const label = options.label ?? "project-task";
	const onDiscarded = options.onDiscarded;
	const version = invalidatePending ? ++projectSwitchVersion : projectSwitchVersion;
	recordDebugTrace(`queue ${label} v=${version}${invalidatePending ? "" : " (keep-version)"}`);
	projectSwitchTask = projectSwitchTask
		.then(async () => {
			recordDebugTrace(`run ${label} v=${version}`);
			assertProjectTaskCurrent(version);
			await task(version);
			recordDebugTrace(`done ${label} v=${version}`);
		})
		.catch((err) => {
			if (err instanceof StaleProjectTaskError) {
				recordDebugTrace(`stale ${label} v=${version}`);
				onDiscarded?.();
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			if (version !== projectSwitchVersion) {
				recordDebugTrace(`ignored-error ${label} v=${version}: ${message}`);
				onDiscarded?.();
				return;
			}
			if (isCliMissingError(message)) {
				recordDebugTrace(`missing-cli ${label} v=${version}: ${message}`);
				connectionError = message;
				renderApp();
				return;
			}
			recordDebugTrace(`error ${label} v=${version}: ${message}`);
			onError?.(err);
		});
	return projectSwitchTask;
}

function isRpcTimeoutError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /timeout waiting for response/i.test(message) || /timed out/i.test(message);
}

async function withRpcRetry<T>(label: string, run: () => Promise<T>, attempts = 2, delayMs = 250): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			recordDebugTrace(`rpc ${label} attempt=${attempt}`);
			return await run();
		} catch (err) {
			lastError = err;
			recordDebugTrace(`rpc ${label} failed attempt=${attempt}: ${err instanceof Error ? err.message : String(err)}`);
			if (attempt >= attempts || !isRpcTimeoutError(err)) {
				throw err;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function renameSessionFromWorkspace(projectId: string, sessionPath: string, nextName: string): Promise<boolean> {
	const workspace = getActiveWorkspace();
	const project = sidebar?.getProjectById(projectId);
	const trimmedName = nextName.trim();
	if (!workspace || !project || !trimmedName) return false;

	ensureWorkspaceContentState(workspace);
	const targetTab = workspace.sessionTabs.find((tab) => normalizeSessionPath(tab.sessionPath) === normalizeSessionPath(sessionPath));
	const previousTabTitle = targetTab?.title ?? "";
	const previousWorkspaceTitle = workspace.sessionTitle;
	if (targetTab) {
		setSessionTabProject(targetTab, project.id, project.path);
		targetTab.title = trimmedName;
		if (workspace.activeSessionTabId === targetTab.id) {
			workspace.sessionTitle = trimmedName;
		}
		persistWorkspaces();
		syncContentTabsBar(workspace);
	}

	let failed = false;
	let persisted = false;
	await queueProjectTask(
		async () => {
			const normalizedTarget = normalizeSessionPath(sessionPath);
			const openTargetTab = workspace.sessionTabs.find((tab) => normalizeSessionPath(tab.sessionPath) === normalizedTarget) ?? null;
			const activeTarget = Boolean(openTargetTab && workspace.activeSessionTabId === openTargetTab.id);

			if (openTargetTab) {
				const targetRuntime = await ensureRuntimeForSessionTab(workspace, openTargetTab, project.path, activeTarget);
				await targetRuntime.bridge.setSessionName(trimmedName);
				persisted = true;
				if (activeTarget) {
					await chatView?.refreshFromBackend({ throwOnError: true }).catch((err) => {
						console.warn("Session renamed but chat refresh failed:", err);
					});
				}
			} else {
				const maintenanceBridge = new RpcBridge(uid("rename_rpc"));
				maintenanceBridge.setPreferredPiPath(findPiBinaryPath());
				try {
					await maintenanceBridge.start({ cliPath: findCliPath(), piPath: findPiBinaryPath(), cwd: project.path });
					const switched = await maintenanceBridge.switchSession(sessionPath);
					if (switched.cancelled) throw new Error("Session rename was cancelled");
					await maintenanceBridge.setSessionName(trimmedName);
					persisted = true;
				} finally {
					await maintenanceBridge.stop().catch(() => {
						/* ignore */
					});
					await maintenanceBridge.teardownListeners().catch(() => {
						/* ignore */
					});
				}
			}

			scheduleSidebarSessionsRefresh(0);
			syncContentTabsBar(workspace);
			await applyWorkspacePane(workspace);
		},
		(err) => {
			if (persisted) {
				console.warn("Session rename persisted but follow-up refresh failed:", err);
				return;
			}
			failed = true;
			console.error("Failed to rename session:", err);
			chatView?.notify(t("app.errors.renameSession"), "error");
		},
		{
			label: "sidebar-session-rename",
			onDiscarded: () => {
				if (!persisted) failed = true;
			},
		},
	);

	if (!persisted) {
		failed = true;
	}
	if (targetTab && shouldRollbackSessionTitle(persisted, failed, targetTab.title === trimmedName)) {
		targetTab.title = previousTabTitle;
		if (workspace.activeSessionTabId === targetTab.id && workspace.sessionTitle === trimmedName) {
			workspace.sessionTitle = previousWorkspaceTitle;
		}
		persistWorkspaces();
		syncWorkspaceTabsBar();
		syncContentTabsBar(workspace);
	}

	return !failed;
}

async function reloadActiveWorkspaceRuntime(): Promise<boolean> {
	const workspace = getActiveWorkspace();
	if (!workspace) return false;

	ensureWorkspaceContentState(workspace);
	const activeSession = getActiveSessionTab(workspace);
	if (!activeSession) return false;
	const projectPath = getSessionTabProjectPath(activeSession) ?? getWorkspaceActiveProjectPath(workspace);
	if (!projectPath) return false;

	syncActiveChatRuntimeBinding(workspace, { forceReset: true, statusText: t("app.status.reloadingRuntime") });

	let failed = false;
	// 本流程在 ensureRuntimeForSessionTab 之外自己把 phase 设成 starting，却不具备它的
	// catch 收尾（那边失败会落到 failed）。若 stop() 期间任务版本失效，
	// StaleProjectTaskError 会被队列静默吃掉，这个 starting 就永久留在 runtime 上：
	// 广义保护会判它不可复用、不可回收，并让配置重载无限推迟。
	let stoppedRuntime: SessionRuntime | null = null;
	const recoverStoppedRuntimePhase = (): void => {
		if (!stoppedRuntime) return;
		if (stoppedRuntime.phase === "starting" && !stoppedRuntime.bridge.isConnected) {
			stoppedRuntime.phase = "failed";
			recordDebugTrace(`reload-runtime:phase-recovered instance=${stoppedRuntime.instanceId}`);
			syncDebugOverlay();
		}
	};
	await queueProjectTask(
		async (version) => {
			assertProjectTaskCurrent(version);
			const runtime = getRuntimeForTab(workspace.id, activeSession.id);
			if (runtime?.bridge.isConnected) {
				stoppedRuntime = runtime;
				runtime.phase = "starting";
				await runtime.bridge.stop().catch(() => {
					/* ignore */
				});
				runtime.draftInitialized = false;
				runtime.lastKnownSessionPath = null;
				setRuntimeRunning(runtime, false, { suppressNotify: true });
			}

			assertProjectTaskCurrent(version);
			await ensureRuntimeForSessionTab(workspace, activeSession, projectPath, true, version);
			assertProjectTaskCurrent(version);
			await chatView?.refreshFromBackend({ throwOnError: true });
			assertProjectTaskCurrent(version);
			await chatView?.refreshModels();
			await packagesView?.refreshPackages(true).catch(() => {
				/* ignore package refresh errors during reload */
			});
			scheduleSidebarSessionsRefresh(0);
			syncContentTabsBar(workspace);
			await applyWorkspacePane(workspace);
		},
		(err) => {
			failed = true;
			recoverStoppedRuntimePhase();
			console.error("Failed to reload runtime:", err);
			chatView?.notify(formatErrorNotice(t("app.errors.reloadRuntime"), err), "error");
		},
		{
			label: "slash-reload-runtime",
			// 任务被丢弃（用户在 stop() 期间又切了会话/项目）时，reload 并未完成：
			// 除了恢复 phase，还必须报 failed，否则会向 /reload 和配置重载链路谎报成功，
			// 后者会误以为新配置已生效。
			onDiscarded: () => {
				failed = true;
				recoverStoppedRuntimePhase();
			},
		},
	);

	return !failed;
}

function scheduleSidebarSessionsRefresh(delayMs = 180): void {
	if (sidebarSessionsRefreshTimer) {
		clearTimeout(sidebarSessionsRefreshTimer);
	}
	sidebarSessionsRefreshTimer = setTimeout(() => {
		sidebarSessionsRefreshTimer = null;
		sidebar?.refreshActiveProjectSessions();
	}, delayMs);
}

function scheduleTerminalCommandRefresh(delayMs = 260): void {
	if (terminalCommandRefreshTimer) {
		clearTimeout(terminalCommandRefreshTimer);
	}
	terminalCommandRefreshTimer = setTimeout(() => {
		terminalCommandRefreshTimer = null;
		void (async () => {
			try {
				// 终端里可能执行过 pi login/logout：清模型缓存再刷新。
				rpcBridge.clearAvailableModelsCache();
				await chatView?.refreshModels();
			} catch {
				// ignore refresh model failures from terminal-triggered updates
			}
			try {
				await chatView?.refreshFromBackend();
			} catch {
				// ignore refresh failures from terminal-triggered updates
			}
			if (packagesView) {
				void packagesView.refreshPackages(false).catch(() => {
					// ignore package refresh failures here
				});
			}
			scheduleSidebarSessionsRefresh(0);
		})();
	}, delayMs);
}

async function refreshDesktopStateAfterAuthChangeWithoutProject(): Promise<void> {
	// auth 已变：不重启 runtime 的路径必须显式清掉模型列表缓存，否则拿到旧列表。
	rpcBridge.clearAvailableModelsCache();
	try {
		await chatView?.refreshModels();
	} catch {
		// ignore auth-change model refresh failures without active project runtime
	}
	try {
		await chatView?.refreshFromBackend();
	} catch {
		// ignore auth-change backend refresh failures without active project runtime
	}
	if (packagesView) {
		void packagesView.refreshPackages(false).catch(() => {
			// ignore package refresh failures here
		});
	}
	scheduleSidebarSessionsRefresh(0);
}

function isActiveRuntimeStreamingForAuthReload(): boolean {
	if (isSessionRuntimeProtected(getActiveRuntime())) return true;
	return Boolean(chatView?.getState()?.isStreaming);
}

function queueAuthConfigDrivenReload(trigger: string, delayMs = AUTH_CONFIG_RELOAD_DEBOUNCE_MS): void {
	// RUNTIME-03/04：配置保存即递增 revision 并淘汰旧 warm runtime；
	// "queued"/"run-idle" 是同一次变更的重放，不重复递增。
	if (trigger !== "queued" && trigger !== "run-idle") {
		bumpRuntimeConfigRevision(trigger);
	}
	if (authConfigReloadDebounceTimer) {
		clearTimeout(authConfigReloadDebounceTimer);
	}
	authConfigReloadDebounceTimer = setTimeout(() => {
		authConfigReloadDebounceTimer = null;
		void runAuthConfigDrivenReload(trigger);
	}, delayMs);
}

async function runAuthConfigDrivenReload(trigger: string): Promise<void> {
	if (authConfigReloadInFlight) {
		authConfigReloadQueued = true;
		recordDebugTrace(`auth-reload queued trigger=${trigger}`);
		return;
	}
	if (isActiveRuntimeStreamingForAuthReload()) {
		authConfigReloadPendingUntilIdle = true;
		recordDebugTrace(`auth-reload deferred trigger=${trigger} reason=streaming`);
		return;
	}

	authConfigReloadInFlight = true;
	authConfigReloadPendingUntilIdle = false;
	recordDebugTrace(`auth-reload start trigger=${trigger}`);
	try {
		const workspace = getActiveWorkspace();
		const projectPath = workspace ? getWorkspaceActiveProjectPath(workspace) : null;
		if (workspace && projectPath) {
			const reloaded = await reloadActiveWorkspaceRuntime();
			if (!reloaded) {
				await refreshDesktopStateAfterAuthChangeWithoutProject();
			}
			return;
		}
		await refreshDesktopStateAfterAuthChangeWithoutProject();
	} catch (err) {
		console.error("Failed to apply auth-driven runtime reload:", err);
	} finally {
		authConfigReloadInFlight = false;
		if (authConfigReloadQueued) {
			authConfigReloadQueued = false;
			queueAuthConfigDrivenReload("queued", 120);
		}
	}
}

function flushPendingAuthConfigReload(): void {
	if (!authConfigReloadPendingUntilIdle) return;
	authConfigReloadPendingUntilIdle = false;
	queueAuthConfigDrivenReload("run-idle", 120);
}

// ---------------------------------------------------------------------------
// W4 项目信任提示卡（PRD 4.3 D 节）
// pi 0.81.1 RPC 模式无信任提示：项目含 .pi 资源或祖先 .agents/skills 且
// trust.json 无保存决定时，项目资源不加载。这里在聊天区顶部提示，用户
// 确认后写入 ~/.pi/agent/trust.json 并走 D7 重载链路重启该项目 runtime。
// ---------------------------------------------------------------------------

/** 本会话内点了「暂不」的项目（下次启动应用会重新提示）。 */
const dismissedProjectTrustPrompts = new Set<string>();
let projectTrustCheckSeq = 0;

async function refreshProjectTrustPrompt(projectPath: string | null): Promise<void> {
	const seq = ++projectTrustCheckSeq;
	if (!chatView) return;
	if (!projectPath || dismissedProjectTrustPrompts.has(projectPath)) {
		chatView.setProjectTrustPrompt(null);
		return;
	}
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const status = await invoke<{
			canonical_path: string;
			has_resources: boolean;
			decision: boolean | null;
			trusted: boolean;
		}>("get_project_trust_status", { projectPath });
		if (seq !== projectTrustCheckSeq) return;
		if (status.has_resources && status.decision === null) {
			chatView.setProjectTrustPrompt({ projectPath });
		} else {
			chatView.setProjectTrustPrompt(null);
		}
	} catch {
		if (seq === projectTrustCheckSeq) chatView?.setProjectTrustPrompt(null);
	}
}

async function trustActiveProjectAndReload(): Promise<void> {
	const workspace = getActiveWorkspace();
	const projectPath = workspace ? getWorkspaceActiveProjectPath(workspace) : null;
	if (!projectPath || !chatView) return;
	chatView.setProjectTrustPromptBusy(true);
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("set_project_trust", { projectPath, trusted: true });
		chatView.setProjectTrustPrompt(null);
		chatView.notify(t("extensions.trust.trustApplied"), "success");
		// 与 auth/渠道变更同级别：D7 重载编排（streaming 时推迟到 idle）。
		queueAuthConfigDrivenReload("project-trust");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		chatView.setProjectTrustPromptBusy(false, `${t("extensions.trust.bannerFailed")}${message}`);
	}
}

async function resolvePiAuthConfigPath(): Promise<string | null> {
	const { homeDir } = await import("@tauri-apps/api/path");
	const home = (await homeDir()).replace(/\\/g, "/").replace(/\/+$/, "");
	if (!home) return null;
	return joinFsPath(joinFsPath(joinFsPath(home, ".pi"), "agent"), "auth.json");
}

async function readAuthConfigSnapshot(path: string): Promise<string> {
	try {
		const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
		if (!(await exists(path))) {
			return AUTH_CONFIG_SNAPSHOT_MISSING;
		}
		return await readTextFile(path);
	} catch {
		return AUTH_CONFIG_SNAPSHOT_ERROR;
	}
}

async function probeAuthConfigChanges(trigger: string): Promise<void> {
	const path = authConfigPath;
	if (!path) return;
	const nextSnapshot = await readAuthConfigSnapshot(path);
	if (authConfigPath !== path) return;
	if (nextSnapshot === authConfigSnapshot) return;
	authConfigSnapshot = nextSnapshot;
	recordDebugTrace(`auth-config changed trigger=${trigger}`);
	queueAuthConfigDrivenReload(trigger);
}

function stopAuthConfigChangeMonitor(): void {
	if (authConfigWatchUnlisten) {
		try {
			authConfigWatchUnlisten();
		} catch {
			// ignore unwatch errors
		}
		authConfigWatchUnlisten = null;
	}
	if (authConfigPollTimer) {
		clearInterval(authConfigPollTimer);
		authConfigPollTimer = null;
	}
	if (authConfigReloadDebounceTimer) {
		clearTimeout(authConfigReloadDebounceTimer);
		authConfigReloadDebounceTimer = null;
	}
	authConfigPath = null;
	authConfigSnapshot = "";
	authConfigReloadQueued = false;
	authConfigReloadPendingUntilIdle = false;
}

async function startAuthConfigChangeMonitor(): Promise<void> {
	stopAuthConfigChangeMonitor();
	const path = await resolvePiAuthConfigPath().catch(() => null);
	if (!path) return;
	authConfigPath = path;
	authConfigSnapshot = await readAuthConfigSnapshot(path);

	let startedWatch = false;
	try {
		const { watch } = await import("@tauri-apps/plugin-fs");
		authConfigWatchUnlisten = await watch(
			path,
			() => {
				void probeAuthConfigChanges("watch");
			},
			{ recursive: false, delayMs: 220 },
		);
		startedWatch = true;
		recordDebugTrace(`auth-watch started path=${path}`);
	} catch (err) {
		console.warn("Failed to watch auth.json; falling back to polling:", err);
		recordDebugTrace(`auth-watch fallback=poll reason=${err instanceof Error ? err.message : String(err)}`);
	}

	if (!startedWatch) {
		authConfigPollTimer = setInterval(() => {
			void probeAuthConfigChanges("poll");
		}, AUTH_CONFIG_FALLBACK_POLL_MS);
	}
}

function stopSidebarSessionsWarmRefresh(): void {
	if (sidebarSessionsWarmInterval) {
		clearInterval(sidebarSessionsWarmInterval);
		sidebarSessionsWarmInterval = null;
	}
	if (sidebarSessionsWarmStopTimer) {
		clearTimeout(sidebarSessionsWarmStopTimer);
		sidebarSessionsWarmStopTimer = null;
	}
}

function startSidebarSessionsWarmRefresh(durationMs = 90_000, intervalMs = 1_200): void {
	scheduleSidebarSessionsRefresh(0);
	if (!sidebarSessionsWarmInterval) {
		sidebarSessionsWarmInterval = setInterval(() => {
			sidebar?.refreshActiveProjectSessions();
		}, intervalMs);
	}
	if (sidebarSessionsWarmStopTimer) {
		clearTimeout(sidebarSessionsWarmStopTimer);
	}
	sidebarSessionsWarmStopTimer = setTimeout(() => {
		stopSidebarSessionsWarmRefresh();
	}, durationMs);
}

function setupSidebarResize(): void {
	removeSidebarResizeHandlers?.();
	removeSidebarResizeHandlers = null;

	const sidebarEl = document.getElementById("sidebar-container");
	const handle = document.getElementById("sidebar-resize-handle");
	if (!sidebarEl || !handle) return;

	const onPointerDown = (event: PointerEvent) => {
		if (sidebarEl.classList.contains("collapsed")) return;
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = sidebarWidth;

		handle.classList.add("dragging");
		document.body.classList.add("sidebar-resizing");

		let moveScheduled = false;
		let pendingDelta = 0;
		const onMove = (moveEvent: PointerEvent) => {
			const delta = moveEvent.clientX - startX;
			if (moveScheduled) {
				pendingDelta = delta;
				return;
			}
			pendingDelta = delta;
			moveScheduled = true;
			requestAnimationFrame(() => {
				moveScheduled = false;
				sidebarWidth = clampSidebarWidth(startWidth + pendingDelta);
				applySidebarWidth();
			});
		};

		const onUp = () => {
			handle.classList.remove("dragging");
			document.body.classList.remove("sidebar-resizing");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			persistSidebarWidth();
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	handle.addEventListener("pointerdown", onPointerDown);
	removeSidebarResizeHandlers = () => {
		handle.removeEventListener("pointerdown", onPointerDown);
	};
}

function normalizePiBinaryPath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function applyPreferredPiBinaryPath(path: string | null): void {
	preferredPiBinaryPath = normalizePiBinaryPath(path);
	rpcBridge.setPreferredPiPath(preferredPiBinaryPath);
	for (const runtime of sessionRuntimes.values()) {
		runtime.bridge.setPreferredPiPath(preferredPiBinaryPath);
	}
}

async function loadPreferredPiBinaryPathFromSettings(): Promise<void> {
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const saved = (await invoke("load_settings")) as { pi_path?: string | null };
		applyPreferredPiBinaryPath(normalizePiBinaryPath(saved?.pi_path ?? null));
	} catch {
		applyPreferredPiBinaryPath(null);
	}
}

function findCliPath(): string | null {
	if (import.meta.env.DEV) {
		// Optional local dev path (if running next to pi-mono)
		return null;
	}
	return null;
}

function findPiBinaryPath(): string | null {
	return preferredPiBinaryPath;
}

function getCwd(): string {
	try {
		const defaultWorkspaceRaw = localStorage.getItem(workspaceProjectsStorageKey(WORKSPACE_DEFAULT_ID));
		if (defaultWorkspaceRaw) {
			const projects = JSON.parse(defaultWorkspaceRaw) as Array<{ path?: string }>;
			if (projects[0]?.path) return projects[0].path;
		}

		const legacyRaw = localStorage.getItem(LEGACY_PROJECTS_STORAGE_KEY);
		if (legacyRaw) {
			const projects = JSON.parse(legacyRaw) as Array<{ path?: string }>;
			if (projects[0]?.path) return projects[0].path;
		}
	} catch {
		// ignore and fallback
	}
	return ".";
}

const WORKSPACE_DEFAULT_EMOJIS = ["💻", "🧠", "🚀", "📝", "📦", "🔧", "⚡️", "🌙", "🔥", "🧪", "📁", "💬", "🎯", "🎨", "🏔️", "🌊", "☕", "🛰️"] as const;

function nextWorkspaceIndex(): number {
	const used = new Set<number>();
	for (const workspace of workspaces) {
		const match = /^(?:Workspace|工作区)\s*(\d+)$/i.exec(workspace.title.trim());
		if (match) used.add(Number(match[1]));
	}
	let idx = 1;
	while (used.has(idx)) idx += 1;
	return idx;
}

function pickWorkspaceDefaultEmoji(seed: string): string {
	let hash = 0;
	for (const char of seed) {
		hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
	}
	return WORKSPACE_DEFAULT_EMOJIS[hash % WORKSPACE_DEFAULT_EMOJIS.length];
}

function ensureWorkspaceEmoji(workspace: WorkspaceState): boolean {
	const normalized = typeof workspace.emoji === "string" ? workspace.emoji.trim() : "";
	if (normalized.length > 0) {
		workspace.emoji = normalized;
		return false;
	}
	workspace.emoji = pickWorkspaceDefaultEmoji(`${workspace.id}:${workspace.title}`);
	return true;
}

function defaultWorkspace(): WorkspaceState {
	const seedSessionTab = createSessionTab(NEW_SESSION_TAB_TITLE, null);
	return {
		id: WORKSPACE_DEFAULT_ID,
		title: t("app.workspace.defaultTitle", { index: 1 }),
		color: null,
		emoji: pickWorkspaceDefaultEmoji(WORKSPACE_DEFAULT_ID),
		pinned: false,
		leftMode: "projects",
		pane: "chat",
		activeProjectId: null,
		activeProjectPath: null,
		filePath: null,
		terminalOpen: false,
		sessionTitle: NEW_SESSION_TAB_TITLE,
		sessionTabs: [seedSessionTab],
		activeSessionTabId: seedSessionTab.id,
		fileTabs: [],
		activeFileTabId: null,
	};
}

function createWorkspace(title?: string, emoji?: string | null): WorkspaceState {
	const seedSessionTab = createSessionTab(NEW_SESSION_TAB_TITLE, null);
	const id = uid("workspace");
	const normalizedEmoji = typeof emoji === "string" && emoji.trim().length > 0 ? emoji.trim() : pickWorkspaceDefaultEmoji(id);
	return {
		id,
		title: title || t("app.workspace.defaultTitle", { index: nextWorkspaceIndex() }),
		color: null,
		emoji: normalizedEmoji,
		pinned: false,
		leftMode: "projects",
		pane: "chat",
		activeProjectId: null,
		activeProjectPath: null,
		filePath: null,
		terminalOpen: false,
		sessionTitle: NEW_SESSION_TAB_TITLE,
		sessionTabs: [seedSessionTab],
		activeSessionTabId: seedSessionTab.id,
		fileTabs: [],
		activeFileTabId: null,
	};
}

function normalizeWorkspaceOrder(): boolean {
	let changed = false;
	for (const workspace of workspaces) {
		if (workspace.pinned) {
			workspace.pinned = false;
			changed = true;
		}
	}
	return changed;
}

function applyWorkspaceTabOrder(orderedIds: string[]): boolean {
	if (orderedIds.length !== workspaces.length) return false;
	const order = new Map<string, number>();
	orderedIds.forEach((id, index) => order.set(id, index));
	if (order.size !== workspaces.length) return false;
	const before = workspaces.map((workspace) => workspace.id).join("|");
	workspaces.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
	normalizeWorkspaceOrder();
	return before !== workspaces.map((workspace) => workspace.id).join("|");
}

function setWorkspacePinned(_workspaceId: string, _pinned: boolean): boolean {
	return false;
}

function persistWorkspaces(): void {
	try {
		localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces));
		if (activeWorkspaceId) {
			localStorage.setItem(WORKSPACES_ACTIVE_STORAGE_KEY, activeWorkspaceId);
		} else {
			localStorage.removeItem(WORKSPACES_ACTIVE_STORAGE_KEY);
		}
	} catch {
		// ignore
	}
}

function loadWorkspaces(): void {
	try {
		const raw = localStorage.getItem(WORKSPACES_STORAGE_KEY);
		const active = localStorage.getItem(WORKSPACES_ACTIVE_STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Array<Partial<WorkspaceState>>;
			workspaces = parsed
				.filter((w) => typeof w.id === "string" && w.id.length > 0)
				.map((w, idx) => {
					const fallbackSessionTitle =
						typeof w.sessionTitle === "string" && w.sessionTitle.trim().length > 0
							? w.sessionTitle.trim()
							: NEW_SESSION_TAB_TITLE;
					const rawSessionTabs = Array.isArray(w.sessionTabs) ? (w.sessionTabs as Array<Partial<WorkspaceSessionTab>>) : [];
					const rawFileTabs = Array.isArray(w.fileTabs) ? (w.fileTabs as Array<Partial<WorkspaceFileTab>>) : [];

					const sessionTabs = rawSessionTabs
						.filter((tab) => typeof tab.id === "string" && tab.id.length > 0)
						.map((tab) => {
							const sessionPath = normalizeStoredPath(tab.sessionPath);
							const storedMessageCount = tab.messageCount;
							const needsAttentionRaw = tab.needsAttention;
							const attentionMessageRaw = tab.attentionMessage;
							return {
								id: tab.id!,
								projectId: normalizeStoredId(tab.projectId),
								projectPath: normalizeStoredPath(tab.projectPath),
								sessionPath,
								title: typeof tab.title === "string" && tab.title.trim().length > 0 ? tab.title.trim() : fallbackSessionTitle,
								messageCount: typeof storedMessageCount === "number" && Number.isFinite(storedMessageCount) ? storedMessageCount : sessionPath ? null : 0,
								ephemeral: typeof tab.ephemeral === "boolean" ? Boolean(tab.ephemeral) : !sessionPath,
								needsAttention: typeof needsAttentionRaw === "boolean" ? needsAttentionRaw : false,
								attentionMessage:
									typeof attentionMessageRaw === "string" && attentionMessageRaw.trim().length > 0
										? attentionMessageRaw.trim()
										: null,
								isFork: Boolean(tab.isFork),
								parentSessionPath: normalizeStoredPath(tab.parentSessionPath),
							};
						});

					if (sessionTabs.length === 0) {
						sessionTabs.push(
							createSessionTab(
								fallbackSessionTitle,
								null,
								normalizeStoredId(w.activeProjectId),
								normalizeStoredPath(w.activeProjectPath),
							),
						);
					}

					const fileTabs = rawFileTabs
						.filter((tab) => typeof tab.id === "string" && tab.id.length > 0)
						.map((tab) => {
							const path = normalizeStoredPath(tab.path);
							const projectPath = normalizeStoredPath(tab.projectPath);
							return {
								id: tab.id!,
								projectId: normalizeStoredId(tab.projectId),
								projectPath,
								path,
								title:
									typeof tab.title === "string" && tab.title.trim().length > 0
										? tab.title.trim()
										: path
											? baseName(path)
											: NEW_FILE_TAB_TITLE,
								draftDirectoryPath: path ? null : normalizeStoredPath(tab.draftDirectoryPath) ?? projectPath,
								draftAnchorPath: path ? null : normalizeStoredPath(tab.draftAnchorPath),
							};
						});

					if (fileTabs.length === 0 && typeof w.filePath === "string" && w.filePath.trim().length > 0) {
						fileTabs.push({
							id: uid("filetab"),
							projectId: normalizeStoredId(w.activeProjectId),
							projectPath: normalizeStoredPath(w.activeProjectPath),
							path: w.filePath,
							title: baseName(w.filePath),
							draftDirectoryPath: null,
							draftAnchorPath: null,
						});
					}

					const workspace: WorkspaceState = {
						id: w.id!,
						title: typeof w.title === "string" && w.title.trim().length > 0 ? w.title : t("app.workspace.defaultTitle", { index: idx + 1 }),
						color: typeof w.color === "string" && w.color.trim().length > 0 ? w.color : null,
						emoji: typeof w.emoji === "string" && w.emoji.trim().length > 0 ? w.emoji.trim() : null,
						pinned: false,
						leftMode: w.leftMode === "files" ? "files" : "projects",
						pane: w.pane === "packages" || w.pane === "settings" ? w.pane : "chat",
						activeProjectId: normalizeStoredId(w.activeProjectId),
						activeProjectPath: normalizeStoredPath(w.activeProjectPath),
						filePath: typeof w.filePath === "string" ? w.filePath : null,
						terminalOpen: Boolean(w.terminalOpen || w.pane === "terminal"),
						sessionTitle: fallbackSessionTitle,
						sessionTabs,
						activeSessionTabId:
							typeof w.activeSessionTabId === "string" && sessionTabs.some((tab) => tab.id === w.activeSessionTabId)
								? w.activeSessionTabId
								: sessionTabs[0]?.id ?? null,
						fileTabs,
						activeFileTabId:
							typeof w.activeFileTabId === "string" && fileTabs.some((tab) => tab.id === w.activeFileTabId)
								? w.activeFileTabId
								: fileTabs[0]?.id ?? null,
					};

					ensureWorkspaceContentState(workspace);
					return workspace;
				});
			activeWorkspaceId = active && workspaces.some((w) => w.id === active) ? active : workspaces[0]?.id ?? null;
		}
	} catch {
		workspaces = [];
		activeWorkspaceId = null;
	}

	if (workspaces.length === 0) {
		workspaces = [defaultWorkspace()];
		activeWorkspaceId = workspaces[0].id;
		persistWorkspaces();
	}

	let mutatedWorkspaceMetadata = false;
	for (const workspace of workspaces) {
		ensureWorkspaceContentState(workspace);
		mutatedWorkspaceMetadata = ensureWorkspaceEmoji(workspace) || mutatedWorkspaceMetadata;
	}

	const normalizedWorkspaceOrder = normalizeWorkspaceOrder();
	if (normalizedWorkspaceOrder || mutatedWorkspaceMetadata) {
		persistWorkspaces();
	}

	if (!activeWorkspaceId || !workspaces.some((w) => w.id === activeWorkspaceId)) {
		activeWorkspaceId = workspaces[0].id;
		persistWorkspaces();
	}
}

function getActiveWorkspace(): WorkspaceState | null {
	if (!activeWorkspaceId) return null;
	return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
}

function syncWorkspaceTabsBar(): void {
	const workspaceItems: SidebarWorkspaceItem[] = workspaces.map((workspace) => ({
		id: workspace.id,
		title: workspace.title,
		color: workspace.color,
		emoji: workspace.emoji,
		pinned: false,
		closable: true,
	}));
	workspaceTabsBar?.setTabs(workspaceItems, activeWorkspaceId);
	sidebar?.setWorkspaces(workspaceItems, activeWorkspaceId);
}

function syncSidebarSettingsNavigation(): void {
	if (!sidebar) return;
	if (!settingsPanel) {
		sidebar.setSettingsNavigation([], null);
		return;
	}
	const navigation = settingsPanel.getNavigationState();
	sidebar.setSettingsNavigation(
		navigation.items.map((item) => ({
			id: item.id,
			label: item.label,
			description: item.description,
			disabled: item.disabled,
		})),
		navigation.activeSection,
	);
}

function syncWorkspaceContextChrome(workspace: WorkspaceState | null = getActiveWorkspace()): void {
	const packagesOpen = workspace?.pane === "packages";
	const settingsOpen = workspace?.pane === "settings";
	workspaceTabsBar?.setPackagesToolbarVisible(packagesOpen);
	sidebar?.setPackagesOpen(packagesOpen);
	sidebar?.setSettingsShellActive(Boolean(settingsOpen));
	if (settingsOpen) syncSidebarSettingsNavigation();
}

function syncCliUpdateUiHint(): void {
	sidebar?.setCliUpdateStatus(Boolean(cliUpdateStatus?.update_available), cliUpdateStatus?.latest_version ?? null);
}

function syncDesktopUpdateUiHint(): void {
	sidebar?.setDesktopUpdateStatus(Boolean(desktopUpdateStatus?.updateAvailable), desktopUpdateStatus?.latestVersion ?? null);
}

function syncDebugOverlay(): void {
	const el = document.getElementById("runtime-debug-overlay");
	if (!el) return;

	const workspace = getActiveWorkspace();
	const runtime = getActiveRuntime();
	const sessionTab = workspace ? getActiveSessionTab(workspace) : null;
	const fileTab = workspace ? getActiveFileTab(workspace) : null;
	const sidebarProject = sidebar?.getActiveProject() ?? null;
	const chatDebug = chatView?.getDebugInfo() ?? null;

	const traceLines = debugTraceLines.slice(-12);
	const lines = [
		`workspace=${workspace?.id ?? "-"}`,
		`workspaceProjectId=${workspace?.activeProjectId ?? "-"}`,
		`workspaceProjectPath=${workspace?.activeProjectPath ?? "-"}`,
		`sidebarProjectId=${sidebarProject?.id ?? "-"}`,
		`sidebarProjectPath=${sidebarProject?.path ?? "-"}`,
		`activeSessionTab=${sessionTab?.id ?? "-"}`,
		`sessionTabProjectPath=${sessionTab?.projectPath ?? "-"}`,
		`sessionTabSessionPath=${sessionTab?.sessionPath ?? "-"}`,
		`activeFileTab=${fileTab?.id ?? "-"}`,
		`fileTabProjectPath=${fileTab?.projectPath ?? "-"}`,
		`fileTabPath=${fileTab?.path ?? "-"}`,
		`runtimeKey=${runtime?.key ?? "-"}`,
		`runtimeInstance=${runtime?.instanceId ?? rpcBridge.getInstanceId()}`,
		`runtimeProjectPath=${runtime?.projectPath ?? "-"}`,
		`runtimePhase=${runtime?.phase ?? "-"}`,
		`runtimeLastError=${runtime?.lastError ?? "-"}`,
		`runtimeLastKnownSessionPath=${runtime?.lastKnownSessionPath ?? "-"}`,
		`runtimeRunning=${runtime?.running ? "yes" : "no"}`,
		`bridgeConnected=${rpcBridge.isConnected ? "yes" : "no"}`,
		`bridgeDiscovery=${rpcBridge.discoveryInfo ?? "-"}`,
		`chatProjectPath=${chatDebug?.projectPath ?? "-"}`,
		`chatConnected=${chatDebug?.isConnected ? "yes" : "no"}`,
		`chatMessages=${chatDebug?.messageCount ?? 0}`,
		`chatBackendSessionFile=${chatDebug?.backendSessionFile ?? "-"}`,
		`chatRefreshError=${chatDebug?.lastBackendRefreshError ?? "-"}`,
		`modelsLoading=${chatDebug?.loadingModels ? "yes" : "no"}`,
		`modelCount=${chatDebug?.availableModelCount ?? 0}`,
		`modelLoadError=${chatDebug?.lastModelLoadError ?? "-"}`,
		"",
		"trace:",
		...traceLines,
	];

	el.textContent = lines.join("\n");
}

function ensureDebugOverlayPolling(): void {
	if (debugOverlayInterval) return;
	debugOverlayInterval = setInterval(() => {
		syncDebugOverlay();
	}, 250);
}

function syncSidebarSelectionFromWorkspace(workspace: WorkspaceState | null = getActiveWorkspace()): void {
	if (!sidebar) {
		chatView?.setWelcomeProjects([], workspace?.activeProjectId ?? null);
		return;
	}
	if (!workspace) {
		sidebar.clearActiveProject();
		sidebar.setActiveSessionPath(null);
		sidebar.setActiveFilePath(null);
		sidebar.setSuppressedSessionPaths([]);
		sidebar.setAttentionSessions([]);
		sidebar.setTransientSessionDraft(null);
		chatView?.setWelcomeProjects(sidebar.listProjects(), null);
		return;
	}

	ensureWorkspaceContentState(workspace);
	if (!workspace.activeProjectId && workspace.activeProjectPath) {
		const project = sidebar.getProjectByPath(workspace.activeProjectPath);
		if (project) {
			setWorkspaceActiveProject(workspace, project);
		}
	}
	if (workspace.activeProjectId) {
		sidebar.setActiveProject(workspace.activeProjectId, false);
	} else {
		sidebar.clearActiveProject();
	}
	chatView?.setWelcomeProjects(sidebar.listProjects(), getWorkspaceActiveProjectId(workspace));

	const suppressedDraftSessionPaths = workspace.sessionTabs
		.filter((tab) => isEphemeralSessionTab(tab) && Boolean(tab.sessionPath))
		.map((tab) => tab.sessionPath as string);
	sidebar.setSuppressedSessionPaths(suppressedDraftSessionPaths);
	const attentionEntries = workspace.sessionTabs
		.filter((tab) => Boolean(tab.needsAttention) && Boolean(tab.sessionPath))
		.map((tab) => ({ path: tab.sessionPath as string, message: tab.attentionMessage }));
	sidebar.setAttentionSessions(attentionEntries);

	sidebar.setActiveFilePath(getActiveFileTab(workspace)?.path ?? null);
	if (workspace.pane !== "chat") {
		sidebar.setActiveSessionPath(null);
		sidebar.setTransientSessionDraft(null);
		return;
	}

	const activeSession = getActiveSessionTab(workspace) ?? null;
	sidebar.setActiveSessionPath(activeSession?.sessionPath ?? null);
	if (activeSession && isEphemeralSessionTab(activeSession)) {
		const projectId = getSessionTabProjectId(activeSession) ?? getWorkspaceActiveProjectId(workspace);
		if (projectId) {
			sidebar.setTransientSessionDraft({
				projectId,
				path: activeSession.sessionPath,
				name: activeSession.title || NEW_SESSION_TAB_TITLE,
			});
			return;
		}
	}
	sidebar.setTransientSessionDraft(null);
}

function syncActiveChatRuntimeBinding(
	workspace: WorkspaceState | null = getActiveWorkspace(),
	options: { forceReset?: boolean; statusText?: string } = {},
): void {
	if (!workspace || !chatView) {
		if (!workspace) {
			setActiveRuntime(null);
			chatView?.prepareForSessionSwitch(null);
		}
		return;
	}
	ensureWorkspaceContentState(workspace);
	const activeSessionTab = getActiveSessionTab(workspace);
	const projectPath = getSessionTabProjectPath(activeSessionTab) ?? getWorkspaceActiveProjectPath(workspace);
	const expectedRuntime = getRuntimeForTab(workspace.id, activeSessionTab.id);
	const expectedRuntimeKey = expectedRuntime?.key ?? null;
	const runtimeChanged = expectedRuntimeKey !== activeSessionRuntimeKey;
	if (runtimeChanged) {
		recordDebugTrace(`syncActiveChatRuntimeBinding runtime=${expectedRuntimeKey ?? "-"} tab=${activeSessionTab.id}`);
		setActiveRuntime(expectedRuntime);
	}
	if (options.forceReset || runtimeChanged || !expectedRuntime) {
		chatView.prepareForSessionSwitch(
			projectPath,
			options.statusText ?? (activeSessionTab.sessionPath ? t("app.status.loadingSession") : t("app.status.startingSession")),
			activeSessionTab.sessionPath,
		);
	}
}

function listVisibleSessionTabsForContentBar(workspace: WorkspaceState): WorkspaceSessionTab[] {
	ensureWorkspaceContentState(workspace);
	return workspace.sessionTabs.filter((tab) => {
		if (!isEphemeralSessionTab(tab)) return true;
		if (workspace.pane !== "chat") return false;
		return tab.id === workspace.activeSessionTabId;
	});
}

/** fork 家族根：isFork 标签沿 parentSessionPath 链向上找到非 fork 的主线程会话；
 * 链中断（父会话标签已关闭）时退化为当前标签自身。 */
function resolveForkFamilyRootPath(workspace: WorkspaceState, tab: WorkspaceSessionTab): string | null {
	const byPath = new Map<string, WorkspaceSessionTab>();
	for (const entry of workspace.sessionTabs) {
		const path = normalizeSessionPath(entry.sessionPath);
		if (path) byPath.set(path, entry);
	}
	let current: WorkspaceSessionTab = tab;
	for (let guard = 0; guard < 16 && current.isFork; guard += 1) {
		const parentPath = normalizeSessionPath(current.parentSessionPath);
		const parent = parentPath ? byPath.get(parentPath) : undefined;
		if (!parent) break;
		current = parent;
	}
	return normalizeSessionPath(current.sessionPath) || null;
}

/**
 * 顶部 tab 栏只服务 fork 线程：仅当活动标签所属 fork 家族（主线程 + 其 fork 链）
 * 内存在 fork 分支标签时返回该家族的可见标签；否则返回空（普通会话切换走左侧栏，
 * 不上 tab）。
 */
function listForkThreadTabsForContentBar(workspace: WorkspaceState): WorkspaceSessionTab[] {
	const visibleTabs = listVisibleSessionTabsForContentBar(workspace);
	if (visibleTabs.length === 0) return [];
	const activeTab = workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId) ?? null;
	if (!activeTab || !visibleTabs.some((tab) => tab.id === activeTab.id)) return [];
	const rootPath = resolveForkFamilyRootPath(workspace, activeTab);
	if (!rootPath) return [];
	const family = visibleTabs.filter((tab) => resolveForkFamilyRootPath(workspace, tab) === rootPath);
	if (!family.some((tab) => tab.isFork)) return [];
	return family;
}

function getVisibleContentTabCount(workspace: WorkspaceState): number {
	const visibleSessionTabs = listVisibleSessionTabsForContentBar(workspace);
	return visibleSessionTabs.length;
}

function syncContentTabsBar(workspace: WorkspaceState | null = getActiveWorkspace()): void {
	if (workspace) {
		ensureWorkspaceContentState(workspace);
	}
	const hasProject = Boolean(workspace && getWorkspaceActiveProjectPath(workspace));
	const paneHidesTabs = workspace?.pane === "packages" || workspace?.pane === "settings" || !hasProject;
	// 顶部固定显示当前任务标题；fork 标签只在活动标签所属 fork 家族（主线程 + fork 链）
	// 内存在分支时展开，普通会话仍通过左侧栏切换。
	const forkThreadTabs = workspace && !paneHidesTabs
		? listForkThreadTabsForContentBar(workspace)
		: [];
	const hasVisibleForkTab = forkThreadTabs.length > 0;
	const collapseTabs = !paneHidesTabs && !hasVisibleForkTab;
	const tabsContainer = document.getElementById("content-tabs-container");
	if (tabsContainer) {
		tabsContainer.classList.toggle("hidden", paneHidesTabs);
		tabsContainer.classList.toggle("tabs-collapsed", collapseTabs);
	}

	const activeSessionTitle = workspace
		? workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId)?.title || workspace.sessionTitle || NEW_SESSION_TAB_TITLE
		: "";
	contentTabsBar?.setCurrentTaskTitle(paneHidesTabs ? "" : activeSessionTitle);

	if (!contentTabsBar || !workspace || workspace.pane === "packages" || workspace.pane === "settings" || !hasProject) {
		contentTabsBar?.setCollapsed(false);
		contentTabsBar?.setTerminalActive(false);
		contentTabsBar?.setTabs([], null);
		return;
	}

	ensureWorkspaceContentState(workspace);
	contentTabsBar.setCollapsed(collapseTabs);

	const tabs = forkThreadTabs.map((tab) => ({
		id: tab.id,
		type: "session" as const,
		title: tab.title || NEW_SESSION_TAB_TITLE,
		needsAttention: Boolean(tab.needsAttention),
		attentionLabel: tab.attentionMessage ?? undefined,
		isFork: Boolean(tab.isFork),
		closable: forkThreadTabs.length > 1 || Boolean(tab.sessionPath),
	}));

	const activeTabId = workspace.activeSessionTabId;

	contentTabsBar.setTerminalActive(workspace.pane === "chat" && workspace.terminalOpen);
	contentTabsBar.setTabs(tabs, activeTabId);
}

function setPaneVisibility(
	pane: WorkspaceState["pane"],
	options: { showFileSplit?: boolean } = {},
): void {
	const chatFileLayout = document.getElementById("chat-file-layout");
	const sessionPane = document.getElementById("session-pane");
	const fileSplitResizeHandle = document.getElementById("file-split-resize-handle");
	const filePane = document.getElementById("file-pane");
	const terminalPane = document.getElementById("terminal-pane");
	const packagesPane = document.getElementById("packages-pane");
	const settingsPane = document.getElementById("settings-pane");
	if (!chatFileLayout || !sessionPane || !fileSplitResizeHandle || !filePane || !packagesPane || !settingsPane) return;

	const showChatLayout = pane === "chat" || pane === "file";
	const showFileSplit = showChatLayout && Boolean(options.showFileSplit);
	chatFileLayout.classList.toggle("hidden-pane", !showChatLayout);
	sessionPane.classList.toggle("hidden-pane", !showChatLayout);
	fileSplitResizeHandle.classList.toggle("hidden-pane", !showFileSplit);
	filePane.classList.toggle("hidden-pane", !showFileSplit);
	if (showFileSplit) applyFileSplitWidth();
	packagesPane.classList.toggle("hidden-pane", pane !== "packages");
	settingsPane.classList.toggle("hidden-pane", pane !== "settings");
	// 扩展状态 chip（如 MCP）只在聊天布局的状态行显示，设置/包管理等 pane 不渲染。
	extensionUiHandler?.setChatPaneActive(showChatLayout);
	if (!showChatLayout) {
		terminalPane?.classList.add("hidden-pane");
		terminalPane?.classList.remove("terminal-dock-visible");
	}
}

function syncTerminalDockVisibility(workspace: WorkspaceState | null = getActiveWorkspace()): void {
	const terminalPane = document.getElementById("terminal-pane");
	if (!terminalPane) return;
	terminalPane.style.setProperty("--terminal-dock-height", `${terminalDockHeightPx}px`);
	const shouldShow = Boolean(workspace && workspace.pane === "chat" && workspace.terminalOpen);
	terminalPane.classList.toggle("hidden-pane", !shouldShow);
	terminalPane.classList.toggle("terminal-dock-visible", shouldShow);
	if (shouldShow && workspace) {
		terminalPanel?.setProjectPath(getWorkspaceActiveProjectPath(workspace));
	}
}

function resolveSettingsRuntimeProjectPath(workspace: WorkspaceState | null): string | null {
	if (!workspace) return null;
	return getWorkspaceActiveProjectPath(workspace);
}

interface ApplyWorkspacePaneOptions {
	/**
	 * File navigation callers use this to keep sidebar/tab chrome on the
	 * previously committed target until FileViewer confirms that pending edits
	 * were saved and the new target actually opened.
	 */
	deferFileNavigationCommit?: boolean;
}

async function applyWorkspacePane(
	workspace: WorkspaceState | null = getActiveWorkspace(),
	options: ApplyWorkspacePaneOptions = {},
): Promise<boolean> {
	const applyVersion = ++workspacePaneApplyVersion;
	const isStale = (): boolean => applyVersion !== workspacePaneApplyVersion;
	const syncWorkspaceChrome = (): void => {
		syncWorkspaceContextChrome(workspace);
		syncSidebarSelectionFromWorkspace(workspace);
		syncContentTabsBar(workspace);
	};

	if (!options.deferFileNavigationCommit) {
		syncWorkspaceChrome();
	}
	if (isStale()) return true;

	if (!workspace) {
		const resolved = getResolvedDesktopTheme();
		const profiles = loadDesktopAppearanceProfiles();
		void syncDesktopThemeWithPiTheme(null).finally(() => {
			applyDesktopAppearanceProfileToRoot(resolved, profiles);
		});
		if (isStale()) return true;
		settingsPanel?.hideWithoutClearing();
		syncRunningSessionIndicators();
		setPaneVisibility("chat");
		syncTerminalDockVisibility(null);
		return true;
	}

	ensureWorkspaceContentState(workspace);
	if (workspace.pane === "terminal") {
		workspace.pane = "chat";
		workspace.terminalOpen = true;
		persistWorkspaces();
		syncWorkspaceTabsBar();
	}
	const workspaceProjectPath = getWorkspaceActiveProjectPath(workspace);
	const resolved = getResolvedDesktopTheme();
	const profiles = loadDesktopAppearanceProfiles();
	void syncDesktopThemeWithPiTheme(workspaceProjectPath).finally(() => {
		applyDesktopAppearanceProfileToRoot(resolved, profiles);
	});
	if (isStale()) return true;

	chatView?.setProjectPath(workspaceProjectPath);
	packagesView?.setProjectPath(workspaceProjectPath);
	terminalPanel?.setProjectPath(workspaceProjectPath);
	void refreshProjectTrustPrompt(workspaceProjectPath);
	if (workspace.pane === "file") {
		workspace.pane = "chat";
		persistWorkspaces();
		syncWorkspaceTabsBar();
	}
	if (workspace.pane !== "settings") {
		settingsPanel?.hideWithoutClearing();
	}
	syncTerminalDockVisibility(workspace);
	if (isStale()) return true;

	const activeFileTab = workspace.pane === "chat" ? getActiveFileTab(workspace) : null;
	const showFileSplit = workspace.pane === "chat" && Boolean(activeFileTab);
	if (showFileSplit && activeFileTab) {
		const draftBasePath = isDraftFileTab(activeFileTab) ? normalizeStoredPath(activeFileTab.draftDirectoryPath) : null;
		fileViewer?.setProjectPath(draftBasePath ?? getFileTabProjectPath(activeFileTab) ?? workspaceProjectPath);
		if (activeFileTab.path) {
			const opened = fileViewer ? await fileViewer.openFile(activeFileTab.path) : true;
			if (isStale()) return true;
			if (!opened) return false;
		} else {
			const draftId = activeFileTab.id;
			const draftTitle = activeFileTab.title || NEW_FILE_TAB_TITLE;
			const opened = fileViewer ? await fileViewer.openDraft(draftId, draftTitle) : true;
			if (isStale()) return true;
			if (!opened) return false;
		}
	} else {
		fileViewer?.setProjectPath(workspaceProjectPath);
	}
	if (options.deferFileNavigationCommit) {
		syncWorkspaceChrome();
	}

	if (workspace.pane === "packages") {
		syncTerminalDockVisibility({ ...workspace, terminalOpen: false, pane: "packages" });
		settingsPanel?.hideWithoutClearing();
		packagesView?.setProjectPath(getWorkspaceActiveProjectPath(workspace));
		if (isStale()) return true;
		setPaneVisibility("packages");
		await packagesView?.open();
		if (isStale()) return true;
		workspaceTabsBar?.setPackagesSearchQuery(packagesView?.getQuery() ?? "");
		syncDebugOverlay();
		return true;
	}

	if (workspace.pane === "settings") {
		syncTerminalDockVisibility({ ...workspace, terminalOpen: false, pane: "settings" });
		if (isStale()) return true;
		setPaneVisibility("settings");
		try {
			const panel = mountSettingsPanel();
			panel.setRuntimeProjectPath(resolveSettingsRuntimeProjectPath(workspace));
			await panel.open();
			if (isStale()) return true;
		} catch (err) {
			console.error("Failed to render settings pane:", err);
			settingsPanel = null;
			const panel = mountSettingsPanel();
			panel.setRuntimeProjectPath(resolveSettingsRuntimeProjectPath(workspace));
			await panel.open();
			if (isStale()) return true;
		}
		scheduleSettingsPaneRecovery("apply-settings");
		syncDebugOverlay();
		return true;
	}

	if (isStale()) return true;
	settingsPanel?.hideWithoutClearing();
	syncActiveChatRuntimeBinding(workspace);
	setPaneVisibility("chat", { showFileSplit });
	syncTerminalDockVisibility(workspace);
	if (workspace.terminalOpen) {
		terminalPanel?.focusInput();
	} else {
		chatView?.focusInput();
	}
	syncDebugOverlay();
	return true;
}

// ---------------------------------------------------------------------------
// Runtime 预热池：为活跃项目预 spawn 一个 pi runtime 保持热备。
// 新建会话/切会话时直接「收养」热备 bridge（随后 switch_session 即可），省掉
// 1-2s+ 的进程冷启动。池内 runtime 占用并发名额（enforceRuntimeConcurrencyLimit
// 会把它们计入），但预热是纯投机行为：名额满时跳过预热，绝不为它驱逐真实会话。
// ---------------------------------------------------------------------------

const WARM_RUNTIME_POOL_PREFIX = "pool__";
let warmRuntimeCounter = 0;

function isWarmPoolRuntime(runtime: SessionRuntime): boolean {
	return runtime.key.startsWith(WARM_RUNTIME_POOL_PREFIX);
}

function findWarmRuntimeForProject(projectPath: string): SessionRuntime | null {
	const normalized = normalizeProjectPath(projectPath);
	if (!normalized) return null;
	for (const runtime of sessionRuntimes.values()) {
		if (!isWarmPoolRuntime(runtime)) continue;
		if (normalizeProjectPath(runtime.projectPath) !== normalized) continue;
		return runtime;
	}
	return null;
}

function createWarmRuntime(projectPath: string): SessionRuntime {
	// key/instanceId 每次唯一：收养后旧 bridge 仍以原 instanceId 存活，
	// 重建的热备绝不能与它撞 Tauri 事件路由。
	const key = `${WARM_RUNTIME_POOL_PREFIX}${++warmRuntimeCounter}`;
	const instanceId = sessionRuntimeInstanceId(key);
	const bridge = new RpcBridge(instanceId);
	bridge.setPreferredPiPath(preferredPiBinaryPath);
	const runtime: SessionRuntime = {
		key,
		instanceId,
		bridge,
		workspaceId: "",
		tabId: "",
		projectPath,
		lastKnownSessionPath: null,
		running: false,
		awaitingAgentSettled: false,
		runEpoch: 0,
		pendingSettleTimer: null,
		restartAfterSettlement: false,
		draftInitialized: false,
		phase: "idle",
		lastError: null,
		eventUnlisten: null,
		suspended: false,
		lastActivityAt: Date.now(),
		ensureInFlight: null,
		configRevision: runtimeConfigRevision,
	};
	runtime.eventUnlisten = runtime.bridge.onEvent((event) => {
		touchRuntime(runtime);
		if (event.type === "rpc_connected") {
			// 同 getOrCreateRuntimeForTab：热备进程的 rpc_connected 同样触发兼容性检查。
			void runStartupCompatibilityCheck(runtime.bridge, event.discovery);
		}
		handleSessionRuntimeLifecycleEvent(runtime, event);
		handleBackgroundRuntimeNotifyEvent(runtime.key, event);
	});
	sessionRuntimes.set(key, runtime);
	return runtime;
}

/** 后台预 spawn（fire-and-forget）。并发名额满时直接跳过，不为预热驱逐真实会话。 */
function ensureWarmRuntimeForProject(projectPath: string | null): void {
	if (!projectPath) return;
	let existing = findWarmRuntimeForProject(projectPath);
	if (existing && !existing.ensureInFlight && existing.configRevision < runtimeConfigRevision) {
		// RUNTIME-04：旧配置的热备不再可用，淘汰后按新配置重建。
		recordDebugTrace(`warm-runtime stale-evict instance=${existing.instanceId} rev=${existing.configRevision} current=${runtimeConfigRevision}`);
		removeRuntimeByKey(existing.key);
		existing = null;
	}
	if (existing) {
		if (existing.ensureInFlight) return;
		if (!existing.suspended && existing.bridge.isConnected) return;
	}
	const connectedCount = [...sessionRuntimes.values()].filter(
		(runtime) => !runtime.suspended && runtime.bridge.isConnected,
	).length;
	if (connectedCount >= maxRunningRuntimes) {
		recordDebugTrace(`warm-runtime skip project=${projectPath} reason=concurrency-cap connected=${connectedCount} max=${maxRunningRuntimes}`);
		return;
	}
	const runtime = existing ?? createWarmRuntime(projectPath);
	runtime.projectPath = projectPath;
	const startedAt = Date.now();
	const flight = (async (): Promise<SessionRuntime> => {
		try {
			runtime.phase = "starting";
			recordDebugTrace(`warm-runtime:start project=${projectPath} instance=${runtime.instanceId}`);
			// 打戳用「启动前」的 revision 快照：启动期间配置再 bump 时保持旧 rev（stale），
			// 由 bump 时的热备淘汰链路 / 收养前的 stale 检查处理，绝不用旧配置冒充新配置。
			const startConfigRevision = runtimeConfigRevision;
			await runtime.bridge.start({ cliPath: findCliPath(), piPath: findPiBinaryPath(), cwd: projectPath });
			runtime.configRevision = startConfigRevision;
			runtime.suspended = false;
			runtime.draftInitialized = true;
			runtime.phase = "ready";
			touchRuntime(runtime);
			recordDebugTrace(`warm-runtime:ready project=${projectPath} instance=${runtime.instanceId} tookMs=${Date.now() - startedAt}`);
			return runtime;
		} catch (err) {
			recordDebugTrace(`warm-runtime:failed project=${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
			// 预热失败不留坏 bridge 在池里，避免被反复收养。
			removeRuntimeByKey(runtime.key);
			throw err;
		} finally {
			syncDebugOverlay();
		}
	})();
	runtime.ensureInFlight = flight;
	void flight
		.catch(() => {
			// 失败已记录并清理，无需上浮
		})
		.finally(() => {
			if (runtime.ensureInFlight === flight) {
				runtime.ensureInFlight = null;
			}
		});
}

/** 把热备 runtime 的 bridge 过户给目标 tab runtime（进程与事件监听一并移交）。 */
function adoptWarmRuntimeBridge(runtime: SessionRuntime, warm: SessionRuntime): void {
	warm.eventUnlisten?.();
	warm.eventUnlisten = null;
	sessionRuntimes.delete(warm.key);
	clearRuntimeRunState(warm.key);

	runtime.eventUnlisten?.();
	runtime.eventUnlisten = null;
	// 目标 runtime 的旧 bridge 从未连接（能走到这必未启动），只需拆掉它的 Tauri 监听。
	void runtime.bridge.teardownListeners().catch(() => {
		/* ignore */
	});
	runtime.bridge = warm.bridge;
	runtime.instanceId = warm.instanceId;
	runtime.configRevision = warm.configRevision;
	runtime.eventUnlisten = runtime.bridge.onEvent((event) => {
		touchRuntime(runtime);
		handleSessionRuntimeLifecycleEvent(runtime, event);
		handleBackgroundRuntimeNotifyEvent(runtime.key, event);
	});
}

async function ensureRuntimeForSessionTab(
	workspace: WorkspaceState,
	sessionTab: WorkspaceSessionTab,
	projectPath: string,
	makeActive = true,
	taskVersion?: number,
): Promise<SessionRuntime> {
	const runtime = getOrCreateRuntimeForTab(workspace.id, sessionTab.id, projectPath);
	if (runtime.ensureInFlight) {
		// hover 预热或上一次切换已在启动同一 runtime：先等在途启动结束，
		// 再走常规流程（此时 start/switch 多半已完成，剩余校验很快）。
		try {
			await runtime.ensureInFlight;
		} catch {
			// 在途启动失败：继续按当前参数重试，错误由本次调用抛出。
		}
		if (typeof taskVersion === "number") {
			assertProjectTaskCurrent(taskVersion);
		}
	}
	const flight = runEnsureRuntimeForSessionTab(workspace, sessionTab, projectPath, makeActive, taskVersion);
	runtime.ensureInFlight = flight;
	try {
		return await flight;
	} finally {
		if (runtime.ensureInFlight === flight) {
			runtime.ensureInFlight = null;
		}
	}
}

async function runEnsureRuntimeForSessionTab(
	workspace: WorkspaceState,
	sessionTab: WorkspaceSessionTab,
	projectPath: string,
	makeActive = true,
	taskVersion?: number,
): Promise<SessionRuntime> {
	if (typeof taskVersion === "number") {
		assertProjectTaskCurrent(taskVersion);
	}
	const ensureStartedAt = Date.now();
	setSessionTabProject(sessionTab, sessionTab.projectId ?? workspace.activeProjectId, projectPath);
	if (makeActive) {
		setWorkspaceActiveProject(workspace, { id: sessionTab.projectId, path: projectPath });
		chatView?.setProjectPath(projectPath);
		packagesView?.setProjectPath(projectPath);
		terminalPanel?.setProjectPath(projectPath);
		fileViewer?.setProjectPath(projectPath);
	}

	const runtime = getOrCreateRuntimeForTab(workspace.id, sessionTab.id, projectPath);
	// 预热收养会替换 runtime.bridge，bridge 必须可取最新值。
	let bridge = runtime.bridge;
	// Session to (re)attach: the tab's own path, or — when resuming a suspended
	// runtime whose tab never got a session path — the runtime's last known one.
	const resumeSessionPath = sessionTab.sessionPath ?? (runtime.suspended ? runtime.lastKnownSessionPath : null);

	const projectChanged = normalizeProjectPath(runtime.projectPath) !== normalizeProjectPath(projectPath);
	const configStale = bridge.isConnected && runtime.configRevision < runtimeConfigRevision;
	const replacementProtected = (projectChanged || configStale) && isSessionRuntimeProtected(runtime);
	// 两种「不能现在替换」要分开判：replacementProtected 包含 starting/
	// switching_session 等中间态，适合做「先别重启，等它安定下来」的编排判断；
	// 但它不代表后台真有任务，所以向用户报「仍在后台运行」并拒绝时只能用运行围栏。
	if (projectChanged && isSessionRuntimeAgentRunning(runtime)) {
		throw new Error("当前线程仍在后台运行，不能把它的 runtime 切换到另一个项目");
	}
	runtime.projectPath = projectPath;
	runtime.lastError = null;
	// RUNTIME-03：已连接但配置 revision 过期的 runtime，激活前重启加载新配置。
	if (configStale && replacementProtected) {
		runtime.restartAfterSettlement = true;
		recordDebugTrace(
			`ensureRuntime:config-stale-deferred instance=${runtime.instanceId} rev=${runtime.configRevision} current=${runtimeConfigRevision}`,
		);
	}
	recordDebugTrace(
		`ensureRuntime:start workspace=${workspace.id} tab=${sessionTab.id} project=${projectPath} session=${sessionTab.sessionPath ?? "draft"}`,
	);

	try {
		if ((projectChanged || configStale) && bridge.isConnected && !replacementProtected) {
			runtime.phase = "starting";
			if (configStale && !projectChanged) {
				recordDebugTrace(`ensureRuntime:config-stale-restart instance=${runtime.instanceId} rev=${runtime.configRevision} current=${runtimeConfigRevision}`);
			}
			runtime.restartAfterSettlement = false;
			await bridge.stop().catch(() => {
				/* ignore */
			});
			if (typeof taskVersion === "number") {
				assertProjectTaskCurrent(taskVersion);
			}
			runtime.draftInitialized = false;
			runtime.lastKnownSessionPath = null;
			setRuntimeRunning(runtime, false, { suppressNotify: true });
		}

		if (!bridge.isConnected) {
			runtime.phase = "starting";
			// 预热池命中：直接收养热备 runtime 的 bridge，跳过 1-2s+ 的进程冷启动。
			let warm = findWarmRuntimeForProject(projectPath);
			if (warm?.ensureInFlight) {
				recordDebugTrace(`ensureRuntime:await-warm instance=${runtime.instanceId} warm=${warm.instanceId}`);
				await warm.ensureInFlight.catch(() => {
					// 预热失败：回落到正常 spawn 路径
				});
				if (typeof taskVersion === "number") {
					assertProjectTaskCurrent(taskVersion);
				}
				warm = findWarmRuntimeForProject(projectPath);
			}
			if (warm && warm.configRevision < runtimeConfigRevision) {
				// RUNTIME-04：配置变化后旧 revision 的热备不可收养，淘汰后走冷启动。
				recordDebugTrace(`ensureRuntime:skip-stale-warm warm=${warm.instanceId} rev=${warm.configRevision} current=${runtimeConfigRevision}`);
				removeRuntimeByKey(warm.key);
				warm = null;
			}
			if (warm && !warm.suspended && warm.bridge.isConnected) {
				adoptWarmRuntimeBridge(runtime, warm);
				bridge = runtime.bridge;
				runtime.draftInitialized = true;
				// 收养的 bridge 是全新草稿进程，不附带任何会话：清掉旧会话句柄，
				// 让下面的 switch_session 一定重新附着 resumeSessionPath。
				runtime.lastKnownSessionPath = null;
				runtime.suspended = false;
				recordDebugTrace(`ensureRuntime:adopt-warm instance=${runtime.instanceId} project=${projectPath}`);
			}
		}

		if (!bridge.isConnected) {
			runtime.phase = "starting";
			recordDebugTrace(`ensureRuntime:start-bridge instance=${runtime.instanceId}`);
			await enforceRuntimeConcurrencyLimit(runtime.key);
			const spawnStartedAt = Date.now();
			// 打戳用「启动前」的 revision 快照：进程加载的是启动那一刻的配置；
			// 启动期间配置再 bump 时保持旧 rev（stale），ready 后立即走 stale 重启链路。
			const startConfigRevision = runtimeConfigRevision;
			await bridge.start({ cliPath: findCliPath(), piPath: findPiBinaryPath(), cwd: projectPath });
			runtime.configRevision = startConfigRevision;
			if (startConfigRevision < runtimeConfigRevision) {
				recordDebugTrace(`config-revision bumped-during-start instance=${runtime.instanceId} startRev=${startConfigRevision} current=${runtimeConfigRevision}`);
			}
			recordDebugTrace(
				`ensureRuntime:bridge-started instance=${runtime.instanceId} discovery=${bridge.discoveryInfo ?? "-"} spawnMs=${Date.now() - spawnStartedAt}`,
			);
			if (typeof taskVersion === "number") {
				assertProjectTaskCurrent(taskVersion);
			}
			runtime.draftInitialized = true;
			if (runtime.suspended) {
				// Process was recycled by the supervisor: forget the stale session
				// handle so the switch below re-attaches resumeSessionPath.
				runtime.lastKnownSessionPath = null;
			}
			runtime.suspended = false;
		}

		if (resumeSessionPath) {
			const targetSessionPath = resumeSessionPath;
			if (normalizeSessionPath(targetSessionPath) !== normalizeSessionPath(runtime.lastKnownSessionPath)) {
				if (isSessionRuntimeAgentRunning(runtime)) {
					throw new Error("当前线程仍在后台运行，不能切换它所附着的会话");
				}
				runtime.phase = "switching_session";
				const switchStartedAt = Date.now();
				const switched = await withRpcRetry(
					`switch_session ${runtime.instanceId}`,
					() => bridge.switchSession(targetSessionPath),
				);
				recordDebugTrace(`ensureRuntime:switch-session-done instance=${runtime.instanceId} switchMs=${Date.now() - switchStartedAt}`);
				if (typeof taskVersion === "number") {
					assertProjectTaskCurrent(taskVersion);
				}
				if (!switched.cancelled) {
					runtime.lastKnownSessionPath = targetSessionPath;
					runtime.draftInitialized = true;
				}
			}
		} else {
			runtime.draftInitialized = true;
		}

		const state = await withRpcRetry(`get_state ${runtime.instanceId}`, () => bridge.getState());
		if (typeof taskVersion === "number") {
			assertProjectTaskCurrent(taskVersion);
		}
		if (state.sessionFile) {
			runtime.lastKnownSessionPath = state.sessionFile;
		}
		if (sessionTab.sessionPath && normalizeSessionPath(state.sessionFile) !== normalizeSessionPath(sessionTab.sessionPath)) {
			throw new Error(
				`Activated wrong session for ${runtime.instanceId}: expected ${sessionTab.sessionPath}, got ${state.sessionFile ?? "-"}`,
			);
		}

		setRuntimeRunning(runtime, Boolean(state.isStreaming));
		runtime.phase = "ready";
		runtime.suspended = false;
		touchRuntime(runtime);
		syncSuspendedSessionIndicators();
		recordDebugTrace(
			`ensureRuntime:ready instance=${runtime.instanceId} session=${runtime.lastKnownSessionPath ?? "-"} totalMs=${Date.now() - ensureStartedAt}`,
		);
		if (runtime.configRevision < runtimeConfigRevision) {
			// 启动期间配置又 bump 过：进程实际加载的是旧配置，打戳保持旧 rev（stale），
			// 完成启动后按 stale 链路重启；若 run/ensure 尚未落定则继续延迟。
			recordDebugTrace(`config-stale:after-start instance=${runtime.instanceId} rev=${runtime.configRevision} current=${runtimeConfigRevision}`);
			scheduleStaleRuntimeRestart(runtime);
		}
		// 用掉/错过热备后补齐一个（仅活跃项目；并发名额满时自动跳过）。
		const activeProjectPath = getWorkspaceActiveProjectPath(workspace);
		if (activeProjectPath && normalizeProjectPath(activeProjectPath) === normalizeProjectPath(projectPath)) {
			ensureWarmRuntimeForProject(projectPath);
		}
		if (
			makeActive &&
			workspace.activeSessionTabId === sessionTab.id &&
			normalizeProjectPath(getSessionTabProjectPath(sessionTab) ?? getWorkspaceActiveProjectPath(workspace)) === normalizeProjectPath(projectPath)
		) {
			setActiveRuntime(runtime);
			// CLI 更新检查可能走网络/子进程，不阻塞会话就绪关键路径；完成后自行刷新标题栏与通知。
			void refreshCliUpdateStatus();
		}
		return runtime;
	} catch (err) {
		runtime.phase = "failed";
		runtime.lastError = err instanceof Error ? err.message : String(err);
		recordDebugTrace(`ensureRuntime:failed instance=${runtime.instanceId}: ${runtime.lastError}`);
		if (activeSessionRuntimeKey === runtime.key) {
			setActiveRuntime(null);
		}
		syncRunningSessionIndicators();
		ensureRunningSessionPoller();
		throw err;
	} finally {
		syncDebugOverlay();
	}
}

async function ensureRpcForProject(projectPath: string, taskVersion?: number): Promise<SessionRuntime | null> {
	if (typeof taskVersion === "number") {
		assertProjectTaskCurrent(taskVersion);
	}
	const workspace = getActiveWorkspace();
	if (!workspace) return null;
	ensureWorkspaceContentState(workspace);
	const activeSessionTab = getActiveSessionTab(workspace);
	setSessionTabProject(activeSessionTab, activeSessionTab.projectId ?? workspace.activeProjectId, projectPath);
	setWorkspaceActiveProject(workspace, { id: activeSessionTab.projectId, path: projectPath });
	return ensureRuntimeForSessionTab(workspace, activeSessionTab, projectPath, true, taskVersion);
}

async function activateWorkspace(workspaceId: string, taskVersion?: number): Promise<void> {
	const workspace = workspaces.find((w) => w.id === workspaceId);
	if (!workspace || !sidebar) return;
	if (typeof taskVersion === "number") {
		assertProjectTaskCurrent(taskVersion);
	}

	recordDebugTrace(`activateWorkspace:start id=${workspaceId}`);
	activeWorkspaceId = workspace.id;
	ensureWorkspaceContentState(workspace);
	persistWorkspaces();
	syncWorkspaceTabsBar();

	await sidebar.setWorkspace(workspace.id);
	if (typeof taskVersion === "number") {
		assertProjectTaskCurrent(taskVersion);
	}
	sidebar.setMode(workspace.leftMode);
	if (workspace.activeProjectId && !workspace.activeProjectPath) {
		const persistedProject = sidebar.getProjectById(workspace.activeProjectId);
		if (persistedProject?.path) {
			setWorkspaceActiveProject(workspace, persistedProject);
		}
	}
	syncSidebarSelectionFromWorkspace(workspace);
	await applyWorkspacePane(workspace);
	if (typeof taskVersion === "number") {
		assertProjectTaskCurrent(taskVersion);
	}

	const activeProjectPath = getWorkspaceActiveProjectPath(workspace);
	recordDebugTrace(`activateWorkspace:project id=${workspaceId} path=${activeProjectPath ?? "-"}`);
	if (activeProjectPath) {
		await ensureRpcForProject(activeProjectPath, taskVersion);
		if (typeof taskVersion === "number") {
			assertProjectTaskCurrent(taskVersion);
		}
		// 会话状态刷新与模型目录加载互不依赖，并行发出 RPC 缩短首屏等待。
		await Promise.all([chatView?.refreshFromBackend({ throwOnError: true }), chatView?.refreshModels()]);
	} else {
		setActiveRuntime(null);
		chatView?.setProjectPath(null);
		packagesView?.setProjectPath(null);
		terminalPanel?.setProjectPath(null);
		fileViewer?.setProjectPath(null);
		syncSidebarSelectionFromWorkspace(workspace);
		syncRunningSessionIndicators();
	}

	if (typeof taskVersion === "number") {
		assertProjectTaskCurrent(taskVersion);
	}
	await applyWorkspacePane(workspace);
	clearVisibleActiveSessionAttention();
	recordDebugTrace(`activateWorkspace:done id=${workspaceId}`);
}

async function focusNotificationTarget(target: NotificationActionTarget, taskVersion?: number): Promise<void> {
	if (typeof taskVersion === "number") {
		assertProjectTaskCurrent(taskVersion);
	}
	const targetWorkspace = target.workspaceId
		? workspaces.find((workspace) => workspace.id === target.workspaceId) ?? null
		: getActiveWorkspace();
	if (!targetWorkspace) {
		recordDebugTrace("notify-action:workspace-missing");
		return;
	}

	if (activeWorkspaceId !== targetWorkspace.id) {
		await activateWorkspace(targetWorkspace.id, taskVersion);
		if (typeof taskVersion === "number") {
			assertProjectTaskCurrent(taskVersion);
		}
	}

	const workspace = workspaces.find((entry) => entry.id === targetWorkspace.id) ?? targetWorkspace;
	ensureWorkspaceContentState(workspace);

	let resolution = target.tabId ? "tab-id" : "none";
	let focusedTab = target.tabId ? setActiveSessionTab(workspace, target.tabId) : null;
	if (!focusedTab && target.sessionPath) {
		const normalizedSessionPath = normalizeSessionPath(target.sessionPath);
		const existingTab = workspace.sessionTabs.find((tab) => normalizeSessionPath(tab.sessionPath) === normalizedSessionPath) ?? null;
		if (existingTab) {
			focusedTab = setActiveSessionTab(workspace, existingTab.id);
			resolution = "session-path-existing";
		}
	}

	if (!focusedTab && target.sessionPath) {
		focusedTab = openOrActivateSessionTab(
			workspace,
			target.sessionPath,
			workspace.activeProjectId,
			workspace.activeProjectPath,
		);
		resolution = "session-path-open";
	}

	if (!focusedTab) {
		focusedTab = getActiveSessionTab(workspace);
		resolution = "active-tab-fallback";
	}

	recordDebugTrace(
		`notify-action:focus workspace=${workspace.id} tab=${focusedTab?.id ?? "-"} session=${focusedTab?.sessionPath ?? target.sessionPath ?? "-"} via=${resolution}`,
	);

	persistWorkspaces();
	syncWorkspaceTabsBar();
	syncContentTabsBar(workspace);
	syncSidebarSelectionFromWorkspace(workspace);
	syncActiveChatRuntimeBinding(workspace, { forceReset: false });
	await applyWorkspacePane(workspace);
}

function closeWorkspace(workspaceId: string): void {
	if (workspaces.length <= 1) return;
	const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
	if (index === -1) return;

	const removedWorkspace = workspaces[index];
	const wasActive = activeWorkspaceId === workspaceId;
	scheduleDiscardEphemeralSessionTabs(removedWorkspace?.sessionTabs ?? []);
	removeRuntimesForWorkspace(workspaceId);
	workspaces.splice(index, 1);

	if (wasActive) {
		const next = workspaces[index] ?? workspaces[index - 1] ?? workspaces[0];
		activeWorkspaceId = next?.id ?? null;
	}

	persistWorkspaces();
	syncWorkspaceTabsBar();

	if (wasActive && activeWorkspaceId) {
		void queueProjectTask(
			async (version) => {
				await activateWorkspace(activeWorkspaceId!, version);
			},
			(err) => {
				console.error("Failed to activate workspace:", err);
			},
			{ label: "close-workspace-activate" },
		);
	}
}

function applyInitialTheme(): void {
	initializeDesktopTheme();
	const resolved = getResolvedDesktopTheme();
	const profiles = loadDesktopAppearanceProfiles();
	void syncDesktopThemeWithPiTheme(null).finally(() => {
		applyDesktopAppearanceProfileToRoot(resolved, profiles);
	});
}

async function applyNativeWindowVisualFixes(): Promise<void> {
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		const win = getCurrentWindow();
		await win.setBackgroundColor({ red: 0, green: 0, blue: 0, alpha: 0 });
	} catch {
		// Ignore in web / non-tauri runtimes
	}
}

/**
 * 已完成兼容性检查的 pi binary（按实际连上的 binary 去重，失败不计入）。
 * 检查挂到每个 runtime bridge 的 rpc_connected 事件上执行（全局 proxy 只转发
 * active bridge 的事件，首次 start 发生在激活之前，必须在 runtime 级监听），
 * 启动时序不再影响检查；proxy 上的监听作为 default bridge 启动路径的兜底。
 * 每个实际使用的 binary 至少检查一次，多 runtime 实例与自动重连不重复弹；
 * 设置里换 pi 路径后等新 binary 真正连上时 discovery 变化，key 随之变化，自动重新检查。
 */
const rpcCompatCheckedBinaries = new Set<string>();
const rpcCompatChecksInFlight = new Map<string, Promise<void>>();

/** 兼容性检查目标：实际连上 pi 的 bridge（runtime 级 RpcBridge 或全局 proxy）。 */
interface RpcCompatCheckTarget {
	readonly isConnected: boolean;
	readonly discoveryInfo: string | null;
	checkRpcCompatibility(): Promise<RpcCompatibilityReport>;
	getCliUpdateStatus(): Promise<CliUpdateStatus>;
}

/** Pure binary identity normalizer used by the per-binary compatibility map. */
export function rpcCompatibilityBinaryKey(discovery: unknown, preferredPath: string | null = null): string {
	const resolved = typeof discovery === "string" && discovery.trim().length > 0 ? discovery.trim() : null;
	if (resolved) {
		// discovery 尾部带 rpc_start 追加的 [instance:xxx]，key 只保留 binary 部分，
		// 保证「同一 binary 只查一次」，不会退化成每个 runtime 实例各弹一次。
		const binaryPart = resolved.replace(/\s*\[instance:[^\]]*\]\s*$/, "");
		return `discovery:${binaryPart}`;
	}
	if (preferredPath) return `path:${preferredPath}`;
	return "discovery:unknown";
}

function rpcCompatBinaryKey(target: RpcCompatCheckTarget, discovery?: unknown): string {
	const fromEvent = typeof discovery === "string" && discovery.trim().length > 0 ? discovery.trim() : null;
	const fromBridge = target.discoveryInfo?.trim() || null;
	return rpcCompatibilityBinaryKey(fromEvent ?? fromBridge, preferredPiBinaryPath);
}

async function runStartupCompatibilityCheck(target: RpcCompatCheckTarget, discovery?: unknown): Promise<void> {
	if (!target.isConnected) return;
	const binaryKey = rpcCompatBinaryKey(target, discovery);
	if (rpcCompatCheckedBinaries.has(binaryKey)) return;
	const existing = rpcCompatChecksInFlight.get(binaryKey);
	if (existing) return existing;
	const check = (async () => {
		try {
			const report = await target.checkRpcCompatibility();
			if (!target.isConnected) {
				// 检查期间断线：结果不可信，不计入已检查，等下次 rpc_connected 重试。
				recordDebugTrace("rpc-compat skipped: disconnected mid-check");
				return;
			}
			rpcCompatCheckedBinaries.add(binaryKey);
			if (report.ok) return;
			recordDebugTrace(`rpc-compat failed error=${report.error ?? "-"}`);
			chatView?.notify(
				t("app.updates.rpcIncompatible", { detail: await probeCliVersionDetail(target) }),
				"error",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			recordDebugTrace(`rpc-compat check error: ${message}`);
			chatView?.notify(
				t("app.updates.rpcIncompatibleWithError", { detail: await probeCliVersionDetail(target), error: message }),
				"error",
			);
		}
	})();
	rpcCompatChecksInFlight.set(binaryKey, check);
	try {
		await check;
	} finally {
		if (rpcCompatChecksInFlight.get(binaryKey) === check) {
			rpcCompatChecksInFlight.delete(binaryKey);
		}
	}
}

/** 读取当前 pi CLI 版本并拼进不兼容提示；取不到时返回空串（不影响主提示）。 */
async function probeCliVersionDetail(target: Pick<RpcCompatCheckTarget, "getCliUpdateStatus">): Promise<string> {
	try {
		// 必须从刚受检的 bridge 读取版本；全局 active bridge 可能已经切到
		// 另一项目、另一 pi binary，不能拿它的版本拼进当前失败提示。
		const status = await target.getCliUpdateStatus();
		const current = typeof status?.current_version === "string" ? status.current_version.trim() : "";
		if (current) {
			return t("app.updates.rpcIncompatibleVersion", { version: current });
		}
	} catch {
		// 版本探测失败不阻塞主提示
	}
	return "";
}

function applyCliStatusToTitlebar(): void {
	// top titlebar removed; keep runtime polling state only
}

async function refreshCliUpdateStatus(): Promise<void> {
	if (cliUpdateChecking) return;
	cliUpdateChecking = true;
	try {
		cliUpdateStatus = await rpcBridge.getCliUpdateStatus();
		if (cliUpdateStatus?.update_available && shouldNotifyCliUpdate()) {
			chatView?.notify(
				t("app.updates.cliAvailable", {
					version: cliUpdateStatus.latest_version ? `（v${cliUpdateStatus.latest_version}）` : "",
				}),
				"info",
			);
			markCliUpdateNotified();
		}
	} catch (err) {
		console.warn("Failed to refresh CLI update status:", err);
		cliUpdateStatus = null;
	} finally {
		cliUpdateChecking = false;
		syncCliUpdateUiHint();
		applyCliStatusToTitlebar();
	}
}

async function refreshDesktopUpdateStatus(): Promise<void> {
	if (desktopUpdateChecking) return;
	desktopUpdateChecking = true;
	try {
		desktopUpdateStatus = await fetchDesktopUpdateStatus();
		if (desktopUpdateStatus.updateAvailable && shouldNotifyDesktopUpdate()) {
			chatView?.notify(
				t("app.updates.desktopAvailable", {
					version: desktopUpdateStatus.latestVersion ? `（v${desktopUpdateStatus.latestVersion}）` : "",
				}),
				"info",
			);
			markDesktopUpdateNotified();
		}
	} catch (err) {
		console.warn("Failed to refresh desktop update status:", err);
		desktopUpdateStatus = null;
	} finally {
		desktopUpdateChecking = false;
		syncDesktopUpdateUiHint();
	}
}

function startCliUpdatePolling(): void {
	if (cliUpdatePollingTimer) {
		clearInterval(cliUpdatePollingTimer);
	}
	cliUpdatePollingTimer = setInterval(() => {
		void refreshCliUpdateStatus();
	}, UPDATE_NOTICE_INTERVAL_MS);
}

function startDesktopUpdatePolling(): void {
	if (desktopUpdatePollingTimer) {
		clearInterval(desktopUpdatePollingTimer);
	}
	desktopUpdatePollingTimer = setInterval(() => {
		void refreshDesktopUpdateStatus();
	}, UPDATE_NOTICE_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// One-click update from the sidebar icon: confirm → update → relaunch
// ---------------------------------------------------------------------------

let oneClickUpdateInProgress = false;

/** 侧栏更新 icon 点击：直接完成更新并重启，不再跳设置页。 */
async function runOneClickUpdate(): Promise<void> {
	if (oneClickUpdateInProgress) return;
	// 与 icon 展示优先级一致：桌面版更新优先于 CLI 更新
	if (desktopUpdateStatus?.updateAvailable) {
		await runDesktopOneClickUpdate();
		return;
	}
	if (cliUpdateStatus?.update_available) {
		await runCliOneClickUpdate();
		return;
	}
	// 状态尚未就绪或已没有可用更新：回退到设置页查看详情
	requestOpenSettingsPanel("updates");
}

async function runCliOneClickUpdate(): Promise<void> {
	const version = cliUpdateStatus?.latest_version ?? null;
	const confirmed = await confirmDialog({
		title: t("app.updates.oneClickCliTitle"),
		desc: version
			? t("app.updates.oneClickCliDesc", { version })
			: t("app.updates.oneClickCliDescUnknown"),
		confirmLabel: t("app.updates.oneClickConfirm"),
	});
	if (!confirmed) return;

	oneClickUpdateInProgress = true;
	sidebar?.setUpdateInProgress(true);
	chatView?.notify(t("app.updates.oneClickCliRunning"), "info");
	try {
		const report = await rpcBridge.updateCliAndReport();
		if (!report.success) {
			const base = t("app.updates.oneClickCliFailed", { code: report.exit_code });
			const reason = report.error ?? report.output_tail;
			await alertDialog(reason ? `${base}\n${reason}` : base, {
				title: t("app.updates.oneClickCliFailedTitle"),
				danger: true,
			});
			return;
		}
		const doneVersion = report.new_version ?? version ?? "";
		chatView?.notify(t("app.updates.oneClickCliDone", { version: doneVersion }), "success");
		// 成功后立即重启，无需等待状态刷新
		await relaunchApp();
	} catch (err) {
		await alertDialog(err instanceof Error ? err.message : String(err), {
			title: t("app.updates.oneClickCliFailedTitle"),
			danger: true,
		});
	} finally {
		oneClickUpdateInProgress = false;
		sidebar?.setUpdateInProgress(false);
		void refreshCliUpdateStatus();
	}
}

async function runDesktopOneClickUpdate(): Promise<void> {
	const status = desktopUpdateStatus;
	if (!status?.updateAvailable) return;
	// 应用内下载安装已禁用（UPDATE-01/02/03：更新源/校验/先删后拷风险），
	// 一键更新统一改为打开发布页面手动下载。
	try {
		await openDesktopUpdate(status);
	} catch (err) {
		console.warn("Failed to open desktop update:", err);
	}
}

// ---------------------------------------------------------------------------
// pi session auto-import: surface existing TUI projects in the sidebar
// ---------------------------------------------------------------------------

let piSessionAutoImportAttempted = false;

/** Record a user-removed project path so auto-import never re-adds it. */
async function recordAutoImportExclusion(projectPath: string): Promise<void> {
	const normalized = normalizeProjectPath(projectPath);
	if (!normalized) return;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		// Bail when settings are unreadable rather than clobbering them with defaults.
		const current = (await invoke("load_settings")) as Record<string, unknown> | null;
		const existing = Array.isArray(current?.auto_import_excluded)
			? (current!.auto_import_excluded as unknown[]).filter((entry): entry is string => typeof entry === "string")
			: [];
		if (existing.some((entry) => normalizeProjectPath(entry) === normalized)) return;
		await invoke("save_settings", {
			settings: {
				...(current ?? {}),
				auto_import_excluded: [...existing, projectPath],
			},
		});
	} catch (err) {
		console.warn("Failed to record auto-import exclusion:", err);
	}
}

/** Once per startup (after workspace hydration): import pi TUI session projects
 * that are not already in the sidebar and not user-removed. */
async function autoImportPiSessionProjects(): Promise<void> {
	if (piSessionAutoImportAttempted) return;
	piSessionAutoImportAttempted = true;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const [candidates, settings] = await Promise.all([
			invoke<Array<{ cwd: string; session_count: number; last_active: string }>>("list_pi_session_projects"),
			invoke<Record<string, unknown>>("load_settings").catch(() => null),
		]);
		if (!Array.isArray(candidates) || candidates.length === 0) return;

		const excluded = new Set(
			(Array.isArray(settings?.auto_import_excluded) ? (settings!.auto_import_excluded as unknown[]) : [])
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => normalizeProjectPath(entry)),
		);
		const existing = new Set((sidebar?.listProjects() ?? []).map((project) => normalizeProjectPath(project.path)));

		const { exists } = await import("@tauri-apps/plugin-fs");
		let imported = 0;
		for (const candidate of candidates) {
			const cwd = typeof candidate?.cwd === "string" ? candidate.cwd.trim() : "";
			const normalized = normalizeProjectPath(cwd);
			if (!normalized || excluded.has(normalized) || existing.has(normalized)) continue;
			// The cwd may belong to a since-deleted directory; skip those.
			const cwdExists = await exists(cwd).catch(() => false);
			if (!cwdExists) continue;
			const added = (await sidebar?.addProjectByPath(cwd)) === true;
			if (added) {
				imported += 1;
				existing.add(normalized);
			}
		}

		if (imported > 0) {
			recordDebugTrace(`pi-session-auto-import imported=${imported}`);
			chatView?.notify(t("sidebar.autoImport.imported", { count: imported }), "info");
		}
	} catch (err) {
		console.warn("pi session auto-import failed:", err);
	}
}

async function initialize(): Promise<void> {
	stopAuthConfigChangeMonitor();
	chatView?.disconnect();
	chatView = null;
	if (debugOverlayInterval) {
		clearInterval(debugOverlayInterval);
		debugOverlayInterval = null;
	}

	const app = document.getElementById("app");
	if (!app) throw new Error(t("app.errors.appContainerMissing"));

	render(
		html`
			<div class="app-shell loading">
				<div class="loading-view">
					<div class="ui-skeleton" role="status" aria-label=${t("app.loading")}>
						<span class="skeleton-bar" style="width:46%"></span>
						<span class="skeleton-bar" style="width:72%"></span>
						<span class="skeleton-bar" style="width:58%"></span>
						<span class="skeleton-bar" style="width:64%"></span>
					</div>
				</div>
			</div>
		`,
		app,
	);

	initializeComponents();
	loadWorkspaces();
	await loadPreferredPiBinaryPathFromSettings();
	await loadRuntimeSupervisorSettings();
	ensureRuntimeSupervisor();
	loadSidebarWidth();
	applySidebarWidth();
	await ensureBundledThemesInstalled();
	// Bundled install may have rewritten default theme files (contentVersion bump);
	// re-run theme sync so the first session after an upgrade picks up new values.
	applyInitialTheme();
	const compatInstall = await ensureDesktopSdkCompatExtensionInstalled();
	if (compatInstall.error && !compatInstall.skipped) {
		console.warn("Failed to install desktop compatibility extension:", compatInstall.error);
	}
	const notifyBridgeInstall = await ensureDesktopNotifyBridgeExtensionInstalled();
	if (notifyBridgeInstall.error && !notifyBridgeInstall.skipped) {
		console.warn("Failed to install desktop notify bridge extension:", notifyBridgeInstall.error);
	}
	const smartVoiceNotifyHostMode = await ensureSmartVoiceNotifyDesktopHostMode();
	if (smartVoiceNotifyHostMode.error && !smartVoiceNotifyHostMode.skipped) {
		console.warn("Failed to enforce smart voice notify desktop host mode:", smartVoiceNotifyHostMode.error);
	}

	try {
		connectionError = null;
		renderApp();
		mountSettingsPanel();
		// Ensure creatorskill exists on first run (copied from packaged assets if available)
		await packagesView?.ensureCreatorSkillInstalled();
		// Refresh discovered resources so Packages view shows the new skill immediately
		try {
			await packagesView?.refreshPackages(true);
		} catch {
			// ignore
		}

		const chatContainer = document.getElementById("chat-container");
		if (!chatContainer) throw new Error(t("app.errors.chatContainerMissing"));
		chatView = new ChatView(chatContainer);
		chatView.setProjectPath(null);
		chatView.connect();
		chatView.setOnStateChange((state) => {
			const runtime = getActiveRuntime();
			if (!runtime) {
				recordDebugTrace(`state-change ignored: no active runtime session=${state.sessionFile ?? "-"}`);
				return;
			}
			sidebar?.setActiveSessionPath(state.sessionFile ?? null);
			updateRuntimeFromState(runtime, state);
			if (state.sessionFile) {
				runtime.lastKnownSessionPath = state.sessionFile;
				runtime.draftInitialized = true;
			}
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			if (workspace.activeSessionTabId !== runtime.tabId) {
				recordDebugTrace(
					`state-change ignored: runtime-tab=${runtime.tabId} active-tab=${workspace.activeSessionTabId ?? "-"} session=${state.sessionFile ?? "-"}`,
				);
				return;
			}
			ensureWorkspaceContentState(workspace);
			const incomingName = (state.sessionName || "").trim();
			const incomingIsPlaceholder = incomingName.length === 0 || incomingName.toLowerCase() === "chat";
			const activeSession = getActiveSessionTab(workspace);
			if (state.sessionFile) {
				activeSession.sessionPath = state.sessionFile;
				if (!incomingIsPlaceholder) {
					activeSession.title = incomingName;
				} else if (isSessionTabPlaceholderTitle(activeSession.title || "")) {
					// pi 对未命名会话不返回 sessionName：仅当现有标题也是占位文案时
					// 才归一到「新会话」，真实标题（如侧栏 preview 派生的名字）保持不变，
					// 不能被兜底文案「会话」覆盖。
					activeSession.title = NEW_SESSION_TAB_TITLE;
				}
			} else if (incomingName && activeSession.sessionPath) {
				activeSession.title = incomingName;
			} else if (!activeSession.sessionPath && !activeSession.title.trim()) {
				activeSession.title = NEW_SESSION_TAB_TITLE;
			}
			activeSession.messageCount = typeof state.messageCount === "number" ? state.messageCount : activeSession.messageCount;
			if ((state.messageCount ?? 0) > 0) {
				activeSession.ephemeral = false;
			}
			workspace.sessionTitle = activeSession.title || NEW_SESSION_TAB_TITLE;
			workspace.activeSessionTabId = activeSession.id;
			syncSidebarSelectionFromWorkspace(workspace);
			if (state.sessionFile && (state.messageCount ?? 0) > 0) {
				const projectId = getSessionTabProjectId(activeSession) ?? getWorkspaceActiveProjectId(workspace);
				if (projectId) {
					// 占位标题（「会话」/chat 等）不能作为会话名写入侧栏；
					// 传空让 upsertSession 保留已有名字，后续扫描会重新派生 preview。
					const currentTabTitle = (activeSession.title || "").trim();
					const upsertName =
						incomingName ||
						(isSessionTabPlaceholderTitle(currentTabTitle) && currentTabTitle !== NEW_SESSION_TAB_TITLE ? "" : currentTabTitle);
					sidebar?.upsertSession(projectId, {
						id: state.sessionId,
						name: upsertName || null,
						path: state.sessionFile,
						optimistic: true,
					});
				}
			}
			persistWorkspaces();
			syncContentTabsBar(workspace);
			if (state.sessionFile) {
				scheduleSidebarSessionsRefresh();
			}
		});
		chatView.setOnSessionForked((info) => {
			preserveForkSourceSessionTab(info);
		});
		chatView.setOnOpenProjectFile(async (reference) => {
			const workspace = getActiveWorkspace();
			const projectRoot = workspace ? getWorkspaceActiveProjectPath(workspace) : null;
			if (!workspace || !projectRoot) return false;
			const resolvedPath = resolveProjectFileReference(projectRoot, reference);
			if (!resolvedPath) {
				chatView?.notify(t("chatView.notice.localFileOutsideProject"), "error");
				return false;
			}
			try {
				const { stat } = await import("@tauri-apps/plugin-fs");
				const info = await stat(resolvedPath);
				if (!info.isFile) {
					chatView?.notify(t("chatView.notice.localFileMissing", { path: reference }), "error");
					return false;
				}
			} catch {
				chatView?.notify(t("chatView.notice.localFileMissing", { path: reference }), "error");
				return false;
			}
			const projectId = getWorkspaceActiveProjectId(workspace);
			const navigationSnapshot = captureWorkspaceFileNavigation(workspace);
			openOrActivateFileTab(workspace, resolvedPath, projectId, projectRoot, { allowCreateTab: false });
			const opened = await commitWorkspaceFileNavigation(workspace, navigationSnapshot);
			if (!opened) {
				chatView?.notify(t("chatView.notice.localFileOpenFailed"), "error");
			}
			return opened;
		});
		chatView.setOnOpenTerminal(async (commandText) => {
			const command = (commandText ?? "").trim();
			if (command) {
				toggleTerminalDock(true);
				requestAnimationFrame(() => {
					void terminalPanel?.runCommand(command);
				});
				return;
			}
			toggleTerminalDock();
			terminalPanel?.focusInput();
		});
		chatView.setOnAddProject(() => {
			void sidebar?.openFolder();
		});
		chatView.setOnOpenSettings((sectionId) => {
			requestOpenSettingsPanel(sectionId);
		});
		chatView.setOnOpenPackages(() => {
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			workspace.pane = workspace.pane === "packages" ? "chat" : "packages";
			persistWorkspaces();
			syncWorkspaceTabsBar();
			void applyWorkspacePane(workspace);
		});
		chatView.setOnOpenExtensionConfig(async (commandName, args) => {
			const normalizedName = normalizeExtensionCommandName(commandName);
			if (!isExtensionConfigIntent(normalizedName, args)) return false;
			openPackagesPane();
			if (!packagesView) return false;
			await packagesView.refreshPackages(false);
			return await packagesView.openExtensionConfigByCommand(normalizedName, args);
		});
		chatView.setOnOpenProviderConfig(async (provider) => {
			const normalizedProvider = provider.trim().toLowerCase().replace(/^\/+/, "");
			if (!normalizedProvider) return false;
			openPackagesPane();
			if (!packagesView) return false;
			await packagesView.refreshPackages(false);
			return await packagesView.openExtensionConfigByProvider(normalizedProvider);
		});
		chatView.setOnBeginRenameCurrentSession(() => {
			const workspace = getActiveWorkspace();
			if (!workspace) return false;
			const activeSession = getActiveSessionTab(workspace);
			const projectId = getSessionTabProjectId(activeSession) ?? getWorkspaceActiveProjectId(workspace);
			const sessionPath = normalizeSessionPath(chatView?.getState()?.sessionFile ?? activeSession.sessionPath ?? "");
			if (!projectId || !sessionPath) return false;
			return sidebar?.beginSessionRename(projectId, sessionPath) ?? false;
		});
		chatView.setOnRenameCurrentSession(async (nextName) => {
			const workspace = getActiveWorkspace();
			if (!workspace) return false;
			const activeSession = getActiveSessionTab(workspace);
			const projectId = getSessionTabProjectId(activeSession) ?? getWorkspaceActiveProjectId(workspace);
			const sessionPath = normalizeSessionPath(chatView?.getState()?.sessionFile ?? activeSession.sessionPath ?? "");
			if (projectId && sessionPath) {
				return await renameSessionFromWorkspace(projectId, sessionPath, nextName);
			}
			try {
				await rpcBridge.setSessionName(nextName);
				activeSession.title = nextName;
				if (workspace.activeSessionTabId === activeSession.id) {
					workspace.sessionTitle = nextName;
				}
				persistWorkspaces();
				syncContentTabsBar(workspace);
				await chatView?.refreshFromBackend({ throwOnError: true });
				return true;
			} catch (err) {
				console.error("Failed to rename current session:", err);
				chatView?.notify(t("app.errors.renameSession"), "error");
				return false;
			}
		});
		chatView.setOnCreateFreshSession(async () => {
			const workspace = getActiveWorkspace();
			if (!workspace) return false;
			if (!getWorkspaceActiveProjectPath(workspace)) {
				chatView?.notify(t("app.sessions.addProjectFirst"), "info");
				return false;
			}
			await startFreshSessionTab();
			return true;
		});
		chatView.setOnReloadRuntime(async () => {
			const workspace = getActiveWorkspace();
			if (!workspace || !getWorkspaceActiveProjectPath(workspace)) {
				chatView?.notify(t("app.sessions.addProjectBeforeReload"), "info");
				return false;
			}
			return await reloadActiveWorkspaceRuntime();
		});
		chatView.setOnTrustProject(() => {
			void trustActiveProjectAndReload();
		});
		chatView.setOnDismissProjectTrust(() => {
			const workspace = getActiveWorkspace();
			const projectPath = workspace ? getWorkspaceActiveProjectPath(workspace) : null;
			if (projectPath) dismissedProjectTrustPrompts.add(projectPath);
			chatView?.setProjectTrustPrompt(null);
		});
		chatView.setOnOpenSessionBrowser((query) => {
			void sessionBrowser?.open({ query });
		});
		chatView.setOnOpenShortcuts(() => {
			shortcutsPanel?.open();
		});
		chatView.setOnQuitApp(() => {
			void (async () => {
				try {
					const { getCurrentWindow } = await import("@tauri-apps/api/window");
					await getCurrentWindow().close();
				} catch {
					window.close();
				}
			})();
		});
		chatView.setOnSelectWelcomeProject((projectId) => {
			sidebar?.setActiveProject(projectId, true);
		});
		chatView.setOnPromptSubmitted(() => {
			const runtime = getActiveRuntime();
			if (runtime) {
				markRuntimeRunStarted(runtime.key);
				setRuntimeRunning(runtime, true);
			}
			startSidebarSessionsWarmRefresh();
		});
		chatView.setOnRunStateChange((running) => {
			const runtime = getActiveRuntime();
			if (runtime) {
				const currentSessionPath = chatView?.getState()?.sessionFile ?? runtime.lastKnownSessionPath;
				if (currentSessionPath) {
					runtime.lastKnownSessionPath = currentSessionPath;
				}
				setRuntimeRunning(runtime, running);
				if (running && currentSessionPath) {
					syncRunningSessionIndicators();
				}
			}
			if (running) {
				startSidebarSessionsWarmRefresh();
			} else {
				stopSidebarSessionsWarmRefresh();
				scheduleSidebarSessionsRefresh(0);
				flushPendingAuthConfigReload();
			}
		});
		chatView.render();
		ensureDebugOverlayPolling();
		syncDebugOverlay();

		extensionUiHandler?.setEditorTextHandler((text) => chatView?.setInputText(text));
		wireCommandPaletteBuiltins();
		commandPalette?.setOnRunSlashCommand(async (commandText) => {
			if (!chatView) return false;
			return await chatView.runSlashCommandText(commandText);
		});

		const startupWorkspace = getActiveWorkspace();
		if (startupWorkspace) {
			await applyWorkspacePane(startupWorkspace);
		}

		const startupWorkspaceId = activeWorkspaceId;
		if (startupWorkspaceId) {
			void queueProjectTask(
				async (version) => {
					await activateWorkspace(startupWorkspaceId, version);
					void autoImportPiSessionProjects();
				},
				(err) => {
					console.error("Startup workspace activation failed:", err);
					recordDebugTrace(`startup-activation-error: ${err instanceof Error ? err.message : String(err)}`);
					chatView?.notify(formatErrorNotice(t("app.errors.restoreWorkspaceRuntime"), err), "error");
				},
				{ label: "startup-activate-workspace" },
			);
		}

		await runStartupCompatibilityCheck(rpcBridge);
		await refreshCliUpdateStatus();
		await refreshDesktopUpdateStatus();
		startCliUpdatePolling();
		startDesktopUpdatePolling();
		void startAuthConfigChangeMonitor();
	} catch (err) {
		connectionError = err instanceof Error ? err.message : String(err);
		recordDebugTrace(`initialize-fatal: ${connectionError}`);
		renderApp();
	}
}

function mountSettingsPanel(): SettingsPanel {
	const settingsContainer = document.getElementById("settings-pane");
	if (!settingsContainer) {
		throw new Error(t("app.errors.settingsContainerMissing"));
	}
	if (settingsPanel) {
		settingsPanel.setContainer(settingsContainer);
		syncSidebarSettingsNavigation();
		return settingsPanel;
	}
	const panel = new SettingsPanel(settingsContainer);
	panel.setOnDesktopStatusChange((status) => {
		desktopUpdateStatus = status;
		syncDesktopUpdateUiHint();
	});
	panel.setOnCliStatusChange((status) => {
		cliUpdateStatus = status;
		syncCliUpdateUiHint();
	});
	panel.setOnPiBinaryPathChange((path) => {
		const previous = preferredPiBinaryPath;
		applyPreferredPiBinaryPath(path);
		recordDebugTrace(`pi-path-override updated path=${path ?? "-"}`);
		if (previous !== preferredPiBinaryPath && preferredPiBinaryPath) {
			chatView?.notify(t("app.updates.piPathSaved"), "info");
		}
	});
	panel.setOnClose(() => {
		const workspace = getActiveWorkspace();
		if (!workspace || workspace.pane !== "settings") return;
		workspace.pane = "chat";
		persistWorkspaces();
		syncWorkspaceTabsBar();
		void applyWorkspacePane(workspace);
	});
	panel.setOnRequestAddProject(() => {
		void sidebar?.openFolder();
	});
	panel.setOnNavigationStateChange(() => {
		syncSidebarSettingsNavigation();
	});
	// W3 模型渠道：配置保存后走 D7 —— 复用 auth.json 变更驱动的重载链路
	// （debounce + streaming 中推迟到 agent_settled 后 idle 再重载）。
	panel.setOnChannelsConfigChanged(() => {
		if (isActiveRuntimeStreamingForAuthReload()) {
			chatView?.notify(t("channels.msg.pendingApply"), "info");
		}
		queueAuthConfigDrivenReload("channels-settings");
	});
	// W4 扩展 tab：skills/散放扩展/MCP/信任变更与 auth 变更同级别，走同一
	// D7 重载链路。
	panel.setOnExtensionsConfigChanged(() => {
		if (isActiveRuntimeStreamingForAuthReload()) {
			chatView?.notify(t("channels.msg.pendingApply"), "info");
		}
		queueAuthConfigDrivenReload("extensions-settings");
	});
	// 扩展 tab 顶部的包管理入口：跳转现有 Packages 视图。
	panel.setOnExtensionsOpenPackages(() => {
		openPackagesPane();
	});
	// OAuth 订阅登录：纯文案引导 + 唤起内嵌终端（无 workspace 时 no-op）。
	panel.setOnChannelsOAuthTerminal(() => {
		toggleTerminalDock(true);
	});
	settingsPanel = panel;
	syncSidebarSettingsNavigation();
	return panel;
}

function initializeComponents(): void {
	if (commandPalette || sessionBrowser || shortcutsPanel || extensionUiHandler) {
		return;
	}

	const commandPaletteContainer = document.createElement("div");
	commandPaletteContainer.id = "command-palette-container";
	document.body.appendChild(commandPaletteContainer);
	commandPalette = new CommandPalette(commandPaletteContainer);

	const sessionBrowserContainer = document.createElement("div");
	sessionBrowserContainer.id = "session-browser-container";
	document.body.appendChild(sessionBrowserContainer);
	sessionBrowser = new SessionBrowser(sessionBrowserContainer);
	sessionBrowser.setOnSessionSelected(async (selection) => {
		if (selection.kind === "new") {
			await startFreshSessionTab();
			return;
		}
		const workspace = getActiveWorkspace();
		if (!workspace) return;
		const project =
			sidebar?.getProjectByPath(selection.cwd) ??
			sidebar?.getProjectById(getWorkspaceActiveProjectId(workspace));
		if (!project) {
			chatView?.notify(t("app.sessions.addProjectFirst"), "info");
			return;
		}
		await activateProjectSession(
			project.id,
			selection.path,
			selection.name ?? undefined,
			{ label: "session-browser-select" },
		);
	});
	sessionBrowser.setOnForkText(async (text) => {
		await chatView?.refreshFromBackend({ throwOnError: true });
		chatView?.setInputText(text);
	});

	const shortcutsPanelContainer = document.createElement("div");
	shortcutsPanelContainer.id = "shortcuts-panel-container";
	document.body.appendChild(shortcutsPanelContainer);
	shortcutsPanel = new ShortcutsPanel(shortcutsPanelContainer);

	extensionUiHandler = new ExtensionUiHandler();
	extensionUiHandler.setTraceHandler(recordDebugTrace);
	// MCP chip：点击弹层的数据源（list_mcp_servers）与「管理 MCP…」入口（设置→扩展→MCP tab）。
	extensionUiHandler.setMcpServersProvider(async (): Promise<McpChipServerInfo[]> => {
		const workspace = getActiveWorkspace();
		const projectPath = workspace ? getWorkspaceActiveProjectPath(workspace) : null;
		const { invoke } = await import("@tauri-apps/api/core");
		const result = await invoke<{ servers: McpChipServerInfo[] }>("list_mcp_servers", { projectPath });
		return result.servers;
	});
	extensionUiHandler.setOpenMcpSettingsHandler(() => {
		requestOpenSettingsPanel("extensions", "mcp");
	});
	ensureNotificationAttentionListeners();
	extensionUiHandler.setNotificationActionHandler((target) => {
		void queueProjectTask(
			async (version) => {
				await focusNotificationTarget(target, version);
			},
			(err) => {
				console.error("Failed to focus notification target:", err);
			},
			{ label: "notification-action-focus" },
		);
	});

	// extension-ui 路由契约（回复方向）：handler 把回复连同来源 runtimeId 抛回 window，
	// 这里按 runtimeId 找到对应 runtime 的 bridge 送回 pi 进程；找不到则丢弃并告警。
	window.addEventListener("extension-ui-response-route", (event) => {
		const detail = (event as CustomEvent<{ runtimeId?: unknown; id?: unknown; data?: unknown }>).detail;
		const runtimeId = typeof detail?.runtimeId === "string" ? detail.runtimeId.trim() : "";
		const requestId = typeof detail?.id === "string" ? detail.id.trim() : "";
		const data = detail?.data && typeof detail.data === "object" ? (detail.data as Record<string, unknown>) : {};
		if (!runtimeId || !requestId) return;
		const runtime = [...sessionRuntimes.values()].find((entry) => entry.instanceId === runtimeId) ?? null;
		const targetBridge = runtime?.bridge ?? (rpcBridge.getInstanceId() === runtimeId ? rpcBridge : null);
		if (!targetBridge) {
			console.warn(`[pi-desktop] extension-ui-response-route: 未找到 runtimeId=${runtimeId} 对应的 runtime，回复 id=${requestId} 已丢弃`);
			recordDebugTrace(`extension-ui-response-route dropped runtime=${runtimeId} id=${requestId}`);
			return;
		}
		void targetBridge.sendExtensionUiResponse({ type: "extension_ui_response", id: requestId, ...data });
	});

	rpcBridge.onEvent((event) => {
		const type = typeof event.type === "string" ? event.type : "unknown";
		if (type === "agent_start" || type === "agent_end" || type === "agent_settled" || type === "error" || type === "extension_ui_request") {
			recordDebugTrace(`rpc:event type=${type}`);
		}

		// 兼容性检查的 proxy 兜底（runtime 级监听见 getOrCreateRuntimeForTab）：
		// 覆盖 default bridge 启动路径；按 binary 去重，重连不重复弹。
		if (type === "rpc_connected") {
			void runStartupCompatibilityCheck(rpcBridge, event.discovery);
		}

		// 断线瞬间的在途用户消息已标记失败：提示该条消息可能未送达。
		if (type === "rpc_inflight_lost") {
			chatView?.notify(t("app.errors.rpcInflightLost"), "error");
		}
		// 重连期间离线队列触顶：新消息被拒绝，提示稍后再试。
		if (type === "rpc_offline_queue_full") {
			const max = typeof event.max === "number" ? event.max : 100;
			chatView?.notify(t("app.errors.rpcOfflineQueueFull", { max }), "error");
		}

		// RUNTIME-05：supervisor 自动重连结果。恢复成功后刷新会话视图；最终失败给中文提示。
		if (type === "rpc_reconnecting" || type === "rpc_reconnected" || type === "rpc_reconnect_failed") {
			recordDebugTrace(`rpc:event type=${type} attempt=${typeof event.attempt === "number" ? event.attempt : "-"}`);
			if (type === "rpc_reconnected") {
				void chatView?.refreshFromBackend().catch(() => {
					/* ignore refresh failure right after reconnect */
				});
			}
			if (type === "rpc_reconnect_failed") {
				chatView?.notify(t("app.errors.rpcReconnectFailed"), "error");
			}
		}

		const runtime = getActiveRuntime();

		if (type === "extension_ui_request") {
			const method = typeof event.method === "string" ? event.method : "unknown";
			const message = typeof event.message === "string" ? event.message : "";
			recordDebugTrace(`extension_ui_request method=${method} message=${message.slice(0, 80)}`);

			const request = { ...(event as Record<string, unknown>) } as Record<string, unknown>;
			// extension-ui 路由契约：标出来源 runtime，handler 回复经 extension-ui-response-route 按它路由回对应 bridge。
			request.runtimeId = runtime?.instanceId ?? rpcBridge.getInstanceId();
			if (method === "notify") {
				if (runtime) {
					markRuntimeRunNotifyObserved(runtime.key);
					const target = resolveRuntimeNotifyTarget(runtime);
					attachNotifyTargetToRequest(request, target, "active", runtime);
				} else {
					const workspace = getActiveWorkspace();
					const activeTab = workspace ? getActiveSessionTab(workspace) : null;
					const targetWorkspaceId = workspace?.id ?? undefined;
					const targetTabId = activeTab?.id ?? undefined;
					const targetSessionPath = activeTab?.sessionPath ?? undefined;
					const targetWorkspaceLabel = workspace?.title?.trim() || undefined;
					const targetSessionLabel = activeTab?.title?.trim() || (targetSessionPath ? baseName(targetSessionPath) : undefined);
					if (targetWorkspaceId || targetTabId || targetSessionPath) {
						request.notifyTargetWorkspaceId = targetWorkspaceId;
						request.notifyTargetTabId = targetTabId;
						request.notifyTargetSessionPath = targetSessionPath;
						request.notifyTargetWorkspaceLabel = targetWorkspaceLabel;
						request.notifyTargetSessionLabel = targetSessionLabel;
						recordDebugTrace(
							`notify-target workspace=${targetWorkspaceId ?? "-"} tab=${targetTabId ?? "-"} session=${targetSessionPath ?? "-"} source=active runtime=-`,
						);
						markSessionAttentionTarget({
							workspaceId: targetWorkspaceId,
							tabId: targetTabId,
							sessionPath: targetSessionPath,
						});
					}
				}
			}

			const normalizedRequest = normalizeExtensionUiRequest(request);
			if (!normalizedRequest) {
				const requestId = typeof request.id === "string" ? request.id.trim() : "";
				const unsupportedMethod = typeof request.method === "string" ? request.method : "unknown";
				recordDebugTrace(`extension_ui_request unsupported method=${unsupportedMethod} source=active`);
				if (requestId) {
					if (extensionUiHandler) {
						void extensionUiHandler.respondUnsupportedRequest(requestId, unsupportedMethod, "active", request.runtimeId as string | undefined);
					} else {
						void rpcBridge.sendExtensionUiResponse({
							type: "extension_ui_response",
							id: requestId,
							success: false,
							error: `Unsupported extension UI capability: ${unsupportedMethod}`,
						});
					}
				}
				return;
			}

			void extensionUiHandler?.handleRequest(normalizedRequest);
		}
	});
}

function openPackagesPane(): void {
	const workspace = getActiveWorkspace();
	if (!workspace) return;
	workspace.pane = "packages";
	persistWorkspaces();
	syncWorkspaceTabsBar();
	void applyWorkspacePane(workspace);
}

function toggleTerminalDock(forceOpen?: boolean): void {
	const workspace = getActiveWorkspace();
	if (!workspace) return;
	const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : workspace.pane !== "chat" ? true : !workspace.terminalOpen;
	workspace.terminalOpen = shouldOpen;
	workspace.pane = "chat";
	persistWorkspaces();
	syncWorkspaceTabsBar();
	void applyWorkspacePane(workspace);
}

function activateProjectSession(
	projectId: string,
	sessionPath: string,
	sessionName?: string,
	options?: {
		label?: string;
		onActivated?: () => void | Promise<void>;
		onFailed?: (err: unknown) => void;
	},
): Promise<void> {
	const workspace = getActiveWorkspace();
	const project = sidebar?.getProjectById(projectId);
	if (!workspace || !project) return Promise.resolve();

	const autoTabCountBefore = getVisibleContentTabCount(workspace);
	const canAutoCreateTab = autoTabCountBefore < DEFAULT_AUTO_CONTENT_TAB_LIMIT;
	setWorkspaceActiveProject(workspace, project);

	const sessionTab = openOrActivateSessionTab(
		workspace,
		sessionPath,
		project.id,
		project.path,
		sessionName,
		{
			allowCreateTab: canAutoCreateTab,
		},
	);
	pruneInactiveEphemeralSessionTabs(workspace, [sessionTab.id]);
	persistWorkspaces();
	syncWorkspaceTabsBar();
	syncContentTabsBar(workspace);
	syncActiveChatRuntimeBinding(workspace, {
		forceReset: true,
		statusText: t("app.status.loadingSession"),
	});
	void applyWorkspacePane(workspace);

	return queueProjectTask(
		async (version) => {
			await ensureRuntimeForSessionTab(workspace, sessionTab, project.path, true, version);
			assertProjectTaskCurrent(version);
			await Promise.all([
				chatView?.refreshFromBackend({ throwOnError: true }),
				chatView?.refreshModels(),
			]);
			assertProjectTaskCurrent(version);
			await applyWorkspacePane(workspace);
			if (options?.onActivated) {
				await options.onActivated();
			}
		},
		(err) => {
			console.error("Failed to switch session:", err);
			chatView?.notify(formatErrorNotice(t("app.errors.switchSession"), err), "error");
			options?.onFailed?.(err);
		},
		{ label: options?.label ?? "session-select" },
	);
}

async function startFreshSessionTab(options: { forceNewTab?: boolean; title?: string } = {}): Promise<void> {
	const workspace = getActiveWorkspace();
	if (!workspace) return;
	ensureWorkspaceContentState(workspace);
	const projectPath = getWorkspaceActiveProjectPath(workspace);
	if (!projectPath) return;

	pruneInactiveEphemeralSessionTabs(workspace);
	createAndActivateEmptySessionTab(
		workspace,
		options.title?.trim() || NEW_SESSION_TAB_TITLE,
		getWorkspaceActiveProjectId(workspace),
		projectPath,
		{
			forceNewTab: options.forceNewTab ?? false,
		},
	);
	persistWorkspaces();
	syncWorkspaceTabsBar();
	syncContentTabsBar(workspace);
	syncActiveChatRuntimeBinding(workspace, { forceReset: true, statusText: t("app.status.startingSession") });
	await applyWorkspacePane(workspace);

	await queueProjectTask(
		async (version) => {
			await ensureRpcForProject(projectPath, version);
			assertProjectTaskCurrent(version);
			await chatView?.refreshFromBackend({ throwOnError: true });
			assertProjectTaskCurrent(version);
			await applyWorkspacePane(workspace ?? null);
		},
		(err) => {
			console.error("Failed to create session tab:", err);
			chatView?.notify(t("app.errors.createSession"), "error");
		},
		{ label: options.forceNewTab ? "fresh-session-tab-explicit" : "fresh-session-tab" },
	);
}

function wireCommandPaletteBuiltins(): void {
	commandPalette?.setBuiltins([
		{
			name: t("app.palette.newSession.name"),
			description: t("app.palette.newSession.description"),
			action: async () => startFreshSessionTab(),
		},
		{
			name: t("app.palette.sessions.name"),
			description: t("app.palette.sessions.description"),
			action: async () => sessionBrowser?.open(),
		},
		{
			name: t("app.palette.settings.name"),
			description: t("app.palette.settings.description"),
			action: async () => requestOpenSettingsPanel(),
		},
		{
			name: t("app.palette.packages.name"),
			description: t("app.palette.packages.description"),
			action: async () => openPackagesPane(),
		},
		{
			name: t("app.palette.terminal.name"),
			description: t("app.palette.terminal.description"),
			action: async () => toggleTerminalDock(),
		},
		{
			name: t("app.palette.fork.name"),
			description: t("app.palette.fork.description"),
			action: async () => chatView?.openHistoryViewerForFork({ loading: false, sessionName: null }),
		},
		{
			name: t("app.palette.history.name"),
			description: t("app.palette.history.description"),
			action: async () => chatView?.openHistoryViewer(),
		},
		{
			name: t("app.palette.compact.name"),
			description: t("app.palette.compact.description"),
			action: async () => {
				await chatView?.compactNow();
			},
		},
	]);
}

function scheduleSettingsPaneRecovery(reason: string, delayMs = 80): void {
	if (settingsPaneRecoveryTimer) {
		clearTimeout(settingsPaneRecoveryTimer);
	}
	settingsPaneRecoveryTimer = setTimeout(() => {
		settingsPaneRecoveryTimer = null;
		void recoverSettingsPaneIfBlank(reason);
	}, delayMs);
}

async function recoverSettingsPaneIfBlank(reason: string): Promise<void> {
	const workspace = getActiveWorkspace();
	if (!workspace || workspace.pane !== "settings") return;
	const settingsContainer = document.getElementById("settings-pane");
	if (!settingsContainer) return;
	if (settingsContainer.childElementCount > 0 && settingsPanel?.isVisible()) return;
	recordDebugTrace(`settings-recover reason=${reason}`);
	try {
		settingsPanel = null;
		const panel = mountSettingsPanel();
		panel.setRuntimeProjectPath(resolveSettingsRuntimeProjectPath(workspace));
		await panel.open();
	} catch (err) {
		console.error("Settings pane blank recovery failed:", err);
	}
}

function normalizeSettingsSectionId(sectionId: string | null | undefined): SettingsSectionId | null {
	switch ((sectionId || "").trim().toLowerCase()) {
		case "general":
			return "general";
		case "appearance":
			return "appearance";
		case "account":
			// 账户 tab 已移除，登录状态并入「模型渠道」
			return "channels";
		case "channels":
			return "channels";
		case "extensions":
			return "extensions";
		case "updates":
			return "updates";
		default:
			return null;
	}
}

function requestOpenSettingsPanel(sectionId?: string, extensionsView?: ExtensionsViewId): void {
	const workspace = getActiveWorkspace();
	if (!workspace) return;
	const targetSection = normalizeSettingsSectionId(sectionId);
	workspace.pane = "settings";
	persistWorkspaces();
	syncWorkspaceTabsBar();
	setPaneVisibility("settings");
	try {
		const panel = mountSettingsPanel();
		panel.setRuntimeProjectPath(resolveSettingsRuntimeProjectPath(workspace));
		if (targetSection) panel.setActiveSection(targetSection);
		if (extensionsView) panel.setExtensionsView(extensionsView);
	} catch (mountErr) {
		console.error("Failed to prepare settings panel before open:", mountErr);
	}
	void applyWorkspacePane(workspace)
		.catch((err) => {
			console.error("Failed to open settings pane:", err);
			try {
				settingsPanel = null;
				setPaneVisibility("settings");
				const panel = mountSettingsPanel();
				panel.setRuntimeProjectPath(resolveSettingsRuntimeProjectPath(workspace));
				if (targetSection) panel.setActiveSection(targetSection);
				if (extensionsView) panel.setExtensionsView(extensionsView);
				void panel.open();
			} catch (innerErr) {
				console.error("Settings pane recovery failed:", innerErr);
			}
		})
		.finally(() => {
			scheduleSettingsPaneRecovery("request-open");
		});
}

function openSettings(): void {
	requestOpenSettingsPanel();
}

function openCommandPalette(): void {
	void commandPalette?.open();
}

function openSessionBrowser(): void {
	void sessionBrowser?.open();
}

function openShortcuts(): void {
	shortcutsPanel?.open();
}

function toggleThemeQuickly(): void {
	toggleDesktopTheme();
}

(window as any).openSettings = openSettings;
(window as any).openCommandPalette = openCommandPalette;
(window as any).openSessionBrowser = openSessionBrowser;
(window as any).openShortcuts = openShortcuts;

function setupKeyboardShortcuts(): void {
	document.addEventListener("keydown", (e: KeyboardEvent) => {
		const isCtrlOrMeta = e.ctrlKey || e.metaKey;
		const isShift = e.shiftKey;
		const target = e.target as HTMLElement;
		const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
		if (e.defaultPrevented) return;

		if (isCtrlOrMeta && e.key.toLowerCase() === "n") {
			e.preventDefault();
			void startFreshSessionTab();
			return;
		}

		if (isCtrlOrMeta && e.key.toLowerCase() === "l") {
			e.preventDefault();
			chatView?.focusInput();
			return;
		}

		if (isCtrlOrMeta && isShift && e.key.toLowerCase() === "c") {
			e.preventDefault();
			void chatView?.copyLastMessage();
			return;
		}

		if (isCtrlOrMeta && e.key.toLowerCase() === "e" && !isShift) {
			e.preventDefault();
			void chatView?.exportToHtml();
			return;
		}

		if (isCtrlOrMeta && isShift && e.key.toLowerCase() === "e") {
			e.preventDefault();
			void chatView?.shareAsGist();
			return;
		}

		if (isCtrlOrMeta && e.key.toLowerCase() === "k") {
			e.preventDefault();
			void commandPalette?.open();
			return;
		}

		if (isCtrlOrMeta && e.key.toLowerCase() === "p" && !isShift) {
			e.preventDefault();
			void commandPalette?.open();
			return;
		}

		if (isCtrlOrMeta && e.key === ",") {
			e.preventDefault();
			requestOpenSettingsPanel();
			return;
		}

		if (isCtrlOrMeta && isShift && e.key.toLowerCase() === "r") {
			e.preventDefault();
			void sessionBrowser?.open();
			return;
		}

		if (isCtrlOrMeta && isShift && e.key.toLowerCase() === "h") {
			e.preventDefault();
			chatView?.openHistoryViewer();
			return;
		}

		if (isCtrlOrMeta && e.key === "/") {
			e.preventDefault();
			shortcutsPanel?.open();
			return;
		}

		const terminalHotkey =
			(isCtrlOrMeta && (e.code === "Backquote" || e.key === "`" || e.key === "Dead" || e.key === "´")) ||
			(e.metaKey && e.altKey && e.key.toLowerCase() === "t");
		if (terminalHotkey) {
			e.preventDefault();
			toggleTerminalDock();
			return;
		}

		if (isCtrlOrMeta && isShift && e.key.toLowerCase() === "t") {
			e.preventDefault();
			toggleThemeQuickly();
			return;
		}

		if (isCtrlOrMeta && e.key.toLowerCase() === "m" && !isShift) {
			e.preventDefault();
			void rpcBridge
				.cycleModel()
				.then(async () => {
					await chatView?.refreshFromBackend({ throwOnError: true });
				})
				.catch((err) => console.error("Failed to cycle model:", err));
			return;
		}

		if (e.key === "Tab" && isShift && !isInput) {
			e.preventDefault();
			void rpcBridge
				.cycleThinkingLevel()
				.then(async () => {
					await chatView?.refreshFromBackend({ throwOnError: true });
				})
				.catch(() => {
					/* noop */
				});
			return;
		}

		if (isCtrlOrMeta && e.key.toLowerCase() === "t" && !isShift) {
			e.preventDefault();
			chatView?.toggleThinkingBlocks();
			return;
		}

		if (e.key === "Escape") {
			if (commandPalette?.isVisible()) {
				e.preventDefault();
				commandPalette.close();
				return;
			}
			if (sessionBrowser?.isVisible()) {
				e.preventDefault();
				sessionBrowser.close();
				return;
			}
			if (shortcutsPanel?.isVisible()) {
				e.preventDefault();
				shortcutsPanel.close();
				return;
			}
			if (settingsPanel?.isVisible()) {
				e.preventDefault();
				settingsPanel.close();
				return;
			}
			return;
		}

		if (e.key === "/" && !isInput) {
			e.preventDefault();
			void commandPalette?.open();
		}
	});
}

function renderApp(): void {
	const app = document.getElementById("app");
	if (!app) return;

	if (connectionError) {
		removeSidebarResizeHandlers?.();
		removeSidebarResizeHandlers = null;
		const cliMissing = isCliMissingError(connectionError);
		const windowsHost = isLikelyWindowsHost();
		render(
			html`
				<div class="error-shell">
					<div class="error-card ${cliMissing ? "onboarding-card" : ""}">
						<h1>${cliMissing ? t("app.onboarding.installCliTitle") : t("app.onboarding.connectionFailed")}</h1>
						${cliMissing
							? html`
								<p>${t("app.onboarding.cliMissingBefore")}<code>pi</code>${t("app.onboarding.cliMissingAfter")}</p>
								<div class="onboarding-command-block">
									<div class="onboarding-command-label">${t("app.onboarding.runInTerminal")}</div>
									<code>${CLI_INSTALL_COMMAND}</code>
								</div>
								${windowsHost
									? html`
										<div class="onboarding-command-block">
											<div class="onboarding-command-label">${t("app.onboarding.installNodeFirst")}</div>
											<code>${WINDOWS_NODE_INSTALL_COMMAND}</code>
										</div>
									`
									: nothing}
								<div class="onboarding-actions">
									<button class="ghost-btn" @click=${() => void copyCliInstallCommand()}>${t("app.onboarding.copyInstallCommand")}</button>
									${windowsHost
										? html`<button class="ghost-btn" @click=${() => void copyWindowsNodeInstallCommand()}>${t("app.onboarding.copyNodeCommand")}</button>`
										: nothing}
									<button @click=${() => {
										connectionError = null;
										void initialize();
									}}>${t("app.onboarding.installedRetry")}</button>
								</div>
								<p class="onboarding-footnote">${t("app.onboarding.npmFootnote")}</p>
								${windowsHost
									? html`
										<p class="onboarding-footnote">
											${t("app.onboarding.wslBefore")}<code>pi</code>${t("app.onboarding.wslAfter")}
										</p>
									`
									: nothing}
							`
							: html`
								<p>${connectionError}</p>
								<button @click=${() => {
									connectionError = null;
									void initialize();
								}}>${t("common.retry")}</button>
							`}
					</div>
				</div>
			`,
			app,
		);
		return;
	}

	render(
		html`
			<div class="app-shell">
				<pre id="runtime-debug-overlay" class="runtime-debug-overlay ${shouldShowDebugOverlay() ? "" : "hidden"}"></pre>
					<div class="content-shell ${compactSidebarOverlayOpen ? "compact-sidebar-open" : ""}">
					<div id="sidebar-container"></div>
					<div id="sidebar-resize-handle" title=${t("app.chrome.resizeSidebar")}></div>
					<div id="main-pane">
						<button
								id="sidebar-collapse-toggle"
								class="workspace-sidebar-toggle ${isSidebarCollapsedState() ? "collapsed" : "hidden"}"
								title=${t("app.chrome.toggleSidebar")}
								aria-label=${t("app.chrome.toggleSidebar")}
								@click=${() => {
									toggleSidebarFromChrome();
								}}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M3 3.5h10v9H3z" />
								<path d="M6 3.5v9" />
							</svg>
						</button>
						<div id="content-tabs-container" data-tauri-drag-region></div>
						<div id="chat-file-layout">
							<div id="session-pane">
								<div id="chat-container"></div>
								<div id="terminal-pane" class="hidden-pane"></div>
							</div>
							<div id="file-split-resize-handle" class="hidden-pane" title=${t("app.chrome.resizeFilePanel")}></div>
							<div id="file-pane" class="hidden-pane"></div>
						</div>
						<div id="packages-pane" class="hidden-pane"></div>
						<div id="settings-pane" class="hidden-pane"></div>
					</div>
				</div>
			</div>
		`,
		app,
	);
	const settingsPaneContainer = document.getElementById("settings-pane");
	if (settingsPanel && settingsPaneContainer) {
		settingsPanel.setContainer(settingsPaneContainer);
		if (settingsPanel.isVisible() && !settingsPanel.hasRenderedContent()) {
			settingsPanel.render();
		}
	}
	const activeWorkspace = getActiveWorkspace();
	if (activeWorkspace?.pane === "settings" && settingsPaneContainer && settingsPaneContainer.childElementCount === 0) {
		scheduleSettingsPaneRecovery("render-app");
	}

	applySidebarWidth();
	setupSidebarResize();
	applyFileSplitWidth();
	setupFileSplitResize();
	syncSidebarCollapseToggleButton();

	const contentTabsContainer = document.getElementById("content-tabs-container");
	if (contentTabsContainer) {
		contentTabsBar = new ContentTabs(contentTabsContainer);
		contentTabsBar.setOnSelect((tabId) => {
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			ensureWorkspaceContentState(workspace);

			if (tabId === "terminal") {
				workspace.terminalOpen = true;
				workspace.pane = "chat";
				pruneEphemeralTabsWhenLeavingDraft(workspace);
				persistWorkspaces();
				syncWorkspaceTabsBar();
				void applyWorkspacePane(workspace);
				return;
			}


			const candidateSessionTab = workspace.sessionTabs.find((tab) => tab.id === tabId) ?? null;
			if (!candidateSessionTab) return;

			const sessionTab = setActiveSessionTab(workspace, tabId);
			if (!sessionTab) return;
			pruneInactiveEphemeralSessionTabs(workspace, [sessionTab.id]);
			persistWorkspaces();
			syncWorkspaceTabsBar();
			syncContentTabsBar(workspace);
			syncActiveChatRuntimeBinding(workspace, { forceReset: true, statusText: sessionTab.sessionPath ? t("app.status.loadingSession") : t("app.status.startingSession") });
			void applyWorkspacePane(workspace);

			const projectPath = getSessionTabProjectPath(sessionTab);
			void queueProjectTask(
				async (version) => {
					if (projectPath) {
						await ensureRuntimeForSessionTab(workspace, sessionTab, projectPath, true, version);
						assertProjectTaskCurrent(version);
						await chatView?.refreshFromBackend({ throwOnError: true });
						assertProjectTaskCurrent(version);
						await chatView?.refreshModels();
					}
					assertProjectTaskCurrent(version);
					await applyWorkspacePane(workspace);
				},
				(err) => {
					console.error("Failed to switch content-tab session:", err);
					chatView?.notify(formatErrorNotice(t("app.errors.switchSessionTab"), err), "error");
				},
			);
		});
		contentTabsBar.setOnOpenTerminal(() => {
			toggleTerminalDock();
		});
		contentTabsBar.setOnCreateTab(() => {
			void startFreshSessionTab({ forceNewTab: true, title: NEW_GENERIC_TAB_TITLE });
		});
		contentTabsBar.setOnRename((tabId, nextTitle) => {
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			ensureWorkspaceContentState(workspace);
			const title = nextTitle.trim();
			if (!title) return;

			const sessionTab = workspace.sessionTabs.find((tab) => tab.id === tabId);
			if (!sessionTab) return;
			const projectId = getSessionTabProjectId(sessionTab) ?? getWorkspaceActiveProjectId(workspace);
			const sessionPath = normalizeSessionPath(sessionTab.sessionPath ?? "");
			if (projectId && sessionPath) {
				void renameSessionFromWorkspace(projectId, sessionPath, title);
				return;
			}

			// 尚未落盘的新会话没有可持久化的 session 文件，先保留本地标题；
			// 首次消息创建文件后，既有 workspace/session 同步链路会继续沿用该标题。
			sessionTab.title = title;
			if (workspace.activeSessionTabId === sessionTab.id) {
				workspace.sessionTitle = title;
			}
			persistWorkspaces();
			syncWorkspaceTabsBar();
			syncContentTabsBar(workspace);
		});
		contentTabsBar.setOnTitleRename(async (nextTitle) => {
			const workspace = getActiveWorkspace();
			if (!workspace) return false;
			ensureWorkspaceContentState(workspace);
			const title = nextTitle.trim();
			if (!title) return false;

			const sessionTab = getActiveSessionTab(workspace);
			const projectId = getSessionTabProjectId(sessionTab) ?? getWorkspaceActiveProjectId(workspace);
			const sessionPath = normalizeSessionPath(sessionTab.sessionPath ?? "");
			if (projectId && sessionPath) {
				return renameSessionFromWorkspace(projectId, sessionPath, title);
			}

			sessionTab.title = title;
			workspace.sessionTitle = title;
			persistWorkspaces();
			syncWorkspaceTabsBar();
			syncContentTabsBar(workspace);
			return true;
		});

		contentTabsBar.setOnClose((tabId) => {
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			ensureWorkspaceContentState(workspace);

			if (tabId === "terminal") {
				workspace.terminalOpen = false;
				workspace.pane = "chat";
				persistWorkspaces();
				syncWorkspaceTabsBar();
				void applyWorkspacePane(workspace);
				return;
			}


			const sessionIndex = workspace.sessionTabs.findIndex((tab) => tab.id === tabId);
			if (sessionIndex === -1) return;

			const wasActive = workspace.activeSessionTabId === tabId;
			const removedTab = workspace.sessionTabs[sessionIndex] ?? null;
			workspace.sessionTabs.splice(sessionIndex, 1);
			scheduleDiscardEphemeralSessionTabs(removedTab ? [removedTab] : []);
			let nextSession: WorkspaceSessionTab | null = null;

			if (workspace.sessionTabs.length === 0) {
				nextSession = createSessionTab(
					NEW_SESSION_TAB_TITLE,
					null,
					removedTab?.projectId ?? workspace.activeProjectId,
					removedTab?.projectPath ?? workspace.activeProjectPath,
				);
				workspace.sessionTabs = [nextSession];
				workspace.activeSessionTabId = nextSession.id;
				workspace.sessionTitle = nextSession.title;
				workspace.pane = "chat";
			} else if (wasActive) {
				nextSession = workspace.sessionTabs[sessionIndex] ?? workspace.sessionTabs[sessionIndex - 1] ?? workspace.sessionTabs[0] ?? null;
				workspace.activeSessionTabId = nextSession?.id ?? null;
				workspace.sessionTitle = nextSession?.title ?? NEW_SESSION_TAB_TITLE;
				workspace.pane = "chat";
			}

			ensureWorkspaceContentState(workspace);
			persistWorkspaces();
			syncWorkspaceTabsBar();
			syncContentTabsBar(workspace);
			syncActiveChatRuntimeBinding(workspace, {
				forceReset: true,
				statusText: nextSession?.sessionPath ? t("app.status.loadingSession") : t("app.status.startingSession"),
			});
			void applyWorkspacePane(workspace);

			const disposeRemovedRuntime = () => {
				if (removedTab) {
					removeRuntimeForTab(workspace.id, removedTab.id);
				}
			};

			if (!wasActive) {
				disposeRemovedRuntime();
				void applyWorkspacePane(workspace);
				return;
			}

			const nextProjectPath = getSessionTabProjectPath(nextSession) ?? getWorkspaceActiveProjectPath(workspace);
			void queueProjectTask(
				async (version) => {
					if (nextProjectPath && nextSession) {
						await ensureRuntimeForSessionTab(workspace, nextSession, nextProjectPath, true, version);
						assertProjectTaskCurrent(version);
						await chatView?.refreshFromBackend({ throwOnError: true });
					}
					assertProjectTaskCurrent(version);
					disposeRemovedRuntime();
					scheduleSidebarSessionsRefresh(0);
					await applyWorkspacePane(workspace);
				},
				(err) => {
					console.error("Failed to switch after closing session tab:", err);
					chatView?.notify(formatErrorNotice(t("app.errors.switchSessionTab"), err), "error");
				},
			);
		});
	}

	const filePane = document.getElementById("file-pane");
	if (filePane) {
		fileViewer = new FileViewer(filePane);
		fileViewer.setProjectPath(null);
		fileViewer.setOnClose(() => {
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			ensureWorkspaceContentState(workspace);
			workspace.fileTabs = [];
			workspace.activeFileTabId = null;
			workspace.filePath = null;
			persistWorkspaces();
			syncWorkspaceTabsBar();
			syncSidebarSelectionFromWorkspace(workspace);
			void applyWorkspacePane(workspace);
		});
		fileViewer.setOnDraftFileCreated(({ draftId, filePath, projectPath }: DraftFileCreatedEvent) => {
			const owner = findDraftFileOwner(workspaces, draftId);
			if (!owner) {
				recordDebugTrace(`draft-file-created:stale draft=${draftId} path=${filePath}`);
				return;
			}

			const { workspace, tab } = owner;
			const anchorPath = normalizeStoredPath(tab.draftAnchorPath);
			tab.path = filePath;
			tab.title = baseName(filePath);
			tab.draftDirectoryPath = null;
			tab.draftAnchorPath = null;
			setFileTabProject(tab, tab.projectId, tab.projectPath ?? projectPath);
			if (anchorPath && tab.projectId) {
				sidebar?.setNewFilePlacementHint(tab.projectId, filePath, anchorPath);
			}

			const ownerIsActive = workspace.id === activeWorkspaceId;
			const tabIsActive = workspace.activeFileTabId === tab.id;
			if (tabIsActive) {
				workspace.filePath = filePath;
				ensureWorkspaceContentState(workspace);
			}
			persistWorkspaces();
			syncWorkspaceTabsBar();

			// Never let an inactive owner replace the current workspace UI.
			if (!ownerIsActive || !tabIsActive) return;
			syncContentTabsBar(workspace);
			syncSidebarSelectionFromWorkspace(workspace);
			sidebar?.refreshActiveProjectFiles(true);
			void applyWorkspacePane(workspace);
		});
	}

	const terminalPane = document.getElementById("terminal-pane");
	if (terminalPane) {
		setupTerminalDockResize(terminalPane);
		terminalPanel = new TerminalPanel(terminalPane);
		terminalPanel.setProjectPath(null);
		terminalPanel.setOnCommandComplete(({ command, result }) => {
			const normalized = command.trim().toLowerCase();
			if (!/^pi(?:\s|$)/.test(normalized)) return;
			if (result && typeof result.code === "number" && result.code !== 0) return;
			scheduleTerminalCommandRefresh();
			if (/\b(?:login|logout)\b/.test(normalized)) {
				setTimeout(() => {
					void probeAuthConfigChanges("terminal-auth-command");
				}, 120);
			}
		});
		terminalPanel.setOnRequestClose(() => {
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			workspace.terminalOpen = false;
			workspace.pane = "chat";
			persistWorkspaces();
			syncWorkspaceTabsBar();
			void applyWorkspacePane(workspace);
		});
	}

	const packagesPane = document.getElementById("packages-pane");
	if (packagesPane) {
		packagesView = new PackagesView(packagesPane);
		packagesView.setProjectPath(null);
		packagesView.setOnBack(() => {
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			workspace.pane = "chat";
			persistWorkspaces();
			syncWorkspaceTabsBar();
			void applyWorkspacePane(workspace);
		});
		packagesView.setOnInsertPromptTemplate(async (commandText) => {
			const workspace = getActiveWorkspace();
			if (!workspace) return;
			workspace.pane = "chat";
			persistWorkspaces();
			syncWorkspaceTabsBar();
			await applyWorkspacePane(workspace);
			chatView?.stageComposerCommand(commandText);
			clearVisibleActiveSessionAttention();
		});
	}

	const sidebarContainer = document.getElementById("sidebar-container");
	if (!sidebarContainer) return;
	sidebar = new Sidebar(sidebarContainer);
	packagesView?.setProjectOptionsProvider(() => sidebar?.listProjects() ?? []);
	sidebar.setOnCollapsedChange(() => {
		applyWorkspaceTopbarOffset();
		syncSidebarCollapseToggleButton();
	});
	syncSidebarCollapseToggleButton();
	syncCliUpdateUiHint();
	syncDesktopUpdateUiHint();

	sidebar.setOnWorkspaceSelect((workspaceId) => {
		void queueProjectTask(
			async (version) => {
				assertProjectTaskCurrent(version);
				await activateWorkspace(workspaceId, version);
			},
			(err) => {
				console.error("Failed to switch workspace:", err);
				chatView?.notify(t("app.errors.switchWorkspace"), "error");
			},
			{ label: "workspace-select" },
		);
	});

	sidebar.setOnWorkspaceCreate((draft) => {
		const title = draft?.title?.trim();
		const emoji = draft?.emoji ?? null;
		const workspace = createWorkspace(title && title.length > 0 ? title : undefined, emoji);
		workspaces.push(workspace);
		activeWorkspaceId = workspace.id;
		persistWorkspaces();
		syncWorkspaceTabsBar();
		void queueProjectTask(
			async (version) => {
				assertProjectTaskCurrent(version);
				await activateWorkspace(workspace.id, version);
			},
			(err) => {
				console.error("Failed to create workspace:", err);
				chatView?.notify(t("app.errors.createWorkspace"), "error");
			},
			{ label: "workspace-add" },
		);
	});

	sidebar.setOnWorkspaceEmoji((workspaceId, emoji) => {
		const workspace = workspaces.find((entry) => entry.id === workspaceId);
		if (!workspace) return;
		workspace.emoji = emoji ?? pickWorkspaceDefaultEmoji(workspace.id);
		persistWorkspaces();
		syncWorkspaceTabsBar();
	});


	sidebar.setOnWorkspaceRename((workspaceId, nextTitle) => {
		const workspace = workspaces.find((entry) => entry.id === workspaceId);
		const title = nextTitle.trim();
		if (!workspace || !title || title === workspace.title) return;
		workspace.title = title;
		persistWorkspaces();
		syncWorkspaceTabsBar();
	});

	sidebar.setOnWorkspaceDelete((workspaceId) => {
		closeWorkspace(workspaceId);
	});

	sidebar.setOnWorkspaceReorder((orderedIds) => {
		if (!applyWorkspaceTabOrder(orderedIds)) return;
		persistWorkspaces();
		syncWorkspaceTabsBar();
	});

	sidebar.setOnOpenSettings((sectionId) => {
		requestOpenSettingsPanel(sectionId);
	});

	// 侧栏更新 icon：一键更新（确认 → 更新 → 重启），不跳设置页
	sidebar.setOnUpdateIconClick(() => {
		void runOneClickUpdate();
	});

	sidebar.setOnCloseSettings(() => {
		settingsPanel?.close();
	});

	sidebar.setOnTogglePackages(() => {
		const workspace = getActiveWorkspace();
		if (!workspace) return;
		workspace.pane = workspace.pane === "packages" ? "chat" : "packages";
		persistWorkspaces();
		syncWorkspaceTabsBar();
		void applyWorkspacePane(workspace);
	});

	sidebar.setOnModeChange((mode) => {
		const workspace = getActiveWorkspace();
		if (!workspace) return;
		workspace.leftMode = mode;
		persistWorkspaces();
		syncWorkspaceTabsBar();
	});

	sidebar.setOnSettingsNavSelect((sectionId) => {
		if (!settingsPanel) return;
		settingsPanel.setActiveSection(sectionId as SettingsSectionId);
		syncSidebarSettingsNavigation();
	});

	sidebar.setOnProjectRemoved((project) => {
		void recordAutoImportExclusion(project.path);
	});

	sidebar.setOnProjectMarkRead((project) => {
		const workspace = getActiveWorkspace();
		if (!workspace) return;
		ensureWorkspaceContentState(workspace);
		const changed = clearMatchingSessionAttention(
			workspace.sessionTabs,
			(tab) =>
				tab.projectId === project.id ||
				normalizeProjectPath(tab.projectPath) === normalizeProjectPath(project.path),
		);
		if (!changed) return;
		persistWorkspaces();
		syncContentTabsBar(workspace);
		syncSidebarSelectionFromWorkspace(workspace);
	});

	sidebar.setOnProjectSelect((project) => {
		const workspace = getActiveWorkspace();
		if (!workspace) return;
		ensureWorkspaceContentState(workspace);

		const currentProjectId = getWorkspaceActiveProjectId(workspace);
		const currentProjectPath = getWorkspaceActiveProjectPath(workspace);
		const selectingSameProject =
			project !== null &&
			currentProjectId === project.id &&
			normalizeProjectPath(currentProjectPath) === normalizeProjectPath(project.path);
		if (selectingSameProject) {
			setWorkspaceActiveProject(workspace, project);
			persistWorkspaces();
			syncWorkspaceTabsBar();
			void applyWorkspacePane(workspace);
			return;
		}

		if (!project) {
			const oldRuntimeKeys = listRuntimeKeysForWorkspace(workspace.id);
			const discardedSessionTabs = [...workspace.sessionTabs];
			scheduleDiscardEphemeralSessionTabs(discardedSessionTabs);
			setWorkspaceActiveProject(workspace, null);
			setActiveRuntime(null);
			resetWorkspaceContentTabs(workspace, null);
			persistWorkspaces();
			syncWorkspaceTabsBar();
			chatView?.setProjectPath(null);
			packagesView?.setProjectPath(null);
			terminalPanel?.setProjectPath(null);
			fileViewer?.setProjectPath(null);
			void applyWorkspacePane(workspace);
			void queueProjectTask(
				async (version) => {
					assertProjectTaskCurrent(version);
					removeRuntimeKeys(oldRuntimeKeys);
					syncRunningSessionIndicators();
					await applyWorkspacePane(workspace);
				},
				(err) => {
					console.error("Failed to clear active project:", err);
					chatView?.notify(t("app.errors.clearActiveProject"), "error");
				},
			);
			return;
		}

		const preferredSession = sidebar?.getPreferredSessionForProject(project.id) ?? null;
		const autoTabCountBefore = getVisibleContentTabCount(workspace);
		const canAutoCreateTab = autoTabCountBefore < DEFAULT_AUTO_CONTENT_TAB_LIMIT;
		setWorkspaceActiveProject(workspace, project);

		if (preferredSession) {
			const sessionTab = openOrActivateSessionTab(workspace, preferredSession.path, project.id, project.path, preferredSession.name, {
				allowCreateTab: canAutoCreateTab,
			});
			pruneInactiveEphemeralSessionTabs(workspace, [sessionTab.id]);
			persistWorkspaces();
			syncWorkspaceTabsBar();
			syncContentTabsBar(workspace);
			syncActiveChatRuntimeBinding(workspace, { forceReset: true, statusText: t("app.status.loadingSession") });
			void applyWorkspacePane(workspace);

			void queueProjectTask(
				async (version) => {
					await ensureRuntimeForSessionTab(workspace, sessionTab, project.path, true, version);
					assertProjectTaskCurrent(version);
					// 状态刷新与模型目录加载并行，缩短首屏等待。
					await Promise.all([chatView?.refreshFromBackend({ throwOnError: true }), chatView?.refreshModels()]);
					assertProjectTaskCurrent(version);
					await applyWorkspacePane(workspace);
				},
				(err) => {
					console.error("Failed to switch project session:", err);
					chatView?.notify(formatErrorNotice(t("app.errors.switchProject"), err), "error");
				},
				{ label: "sidebar-project-select" },
			);
			return;
		}

		createAndActivateEmptySessionTab(workspace, NEW_SESSION_TAB_TITLE, project.id, project.path, {
			forceNewTab: canAutoCreateTab,
		});
		persistWorkspaces();
		syncWorkspaceTabsBar();
		syncContentTabsBar(workspace);
		syncActiveChatRuntimeBinding(workspace, { forceReset: true, statusText: t("app.status.startingSession") });
		void applyWorkspacePane(workspace);

		void queueProjectTask(
			async (version) => {
				await ensureRpcForProject(project.path, version);
				assertProjectTaskCurrent(version);
				// 状态刷新与模型目录加载并行，缩短首屏等待。
				await Promise.all([chatView?.refreshFromBackend({ throwOnError: true }), chatView?.refreshModels()]);
				assertProjectTaskCurrent(version);
				await applyWorkspacePane(workspace);
			},
			(err) => {
				console.error("Failed to switch project:", err);
				chatView?.notify(formatErrorNotice(t("app.errors.switchProject"), err), "error");
			},
			{ label: "sidebar-project-select" },
		);
	});

	sidebar.setOnNewSessionInProject((project) => {
		const workspace = getActiveWorkspace();
		if (!workspace) return;

		setWorkspaceActiveProject(workspace, project);
		pruneInactiveEphemeralSessionTabs(workspace);
		createAndActivateEmptySessionTab(workspace, NEW_SESSION_TAB_TITLE, project.id, project.path, { forceNewTab: true });
		persistWorkspaces();
		syncWorkspaceTabsBar();
		syncContentTabsBar(workspace);
		syncActiveChatRuntimeBinding(workspace, { forceReset: true, statusText: t("app.status.startingSession") });
		void applyWorkspacePane(workspace);

		void queueProjectTask(
			async (version) => {
				await ensureRpcForProject(project.path, version);
				assertProjectTaskCurrent(version);
				// 状态刷新与模型目录加载并行，缩短首屏等待。
				await Promise.all([chatView?.refreshFromBackend({ throwOnError: true }), chatView?.refreshModels()]);
				assertProjectTaskCurrent(version);
				await applyWorkspacePane(workspace);
			},
			(err) => {
				console.error("Failed to create project session:", err);
				chatView?.notify(formatErrorNotice(t("app.errors.createProjectSession"), err), "error");
			},
			{ label: "sidebar-new-session" },
		);
	});

	sidebar.setOnNewFileInProject(async (project) => {
		const workspace = getActiveWorkspace();
		if (!workspace) return;
		const navigationSnapshot = captureWorkspaceFileNavigation(workspace);
		const draftDirectoryPath = normalizeStoredPath(project.directoryPath) ?? normalizeStoredPath(project.path);
		const draftAnchorPath = normalizeStoredPath(project.anchorPath);
		setWorkspaceActiveProject(workspace, project);
		createAndActivateEmptyFileTab(workspace, NEW_FILE_TAB_TITLE, project.id, project.path, draftDirectoryPath, draftAnchorPath);
		await commitWorkspaceFileNavigation(workspace, navigationSnapshot);
	});

	const SESSION_PREWARM_THROTTLE_MS = 5_000;
	const sessionPrewarmAt = new Map<string, number>();

	/**
	 * hover/按下会话行时预热对应 runtime：被挂起或未启动的提前恢复，
	 * 真正点击时 ensureRuntime 直接复用在途启动（见 ensureRuntimeForSessionTab 的去重包装）。
	 */
	const prewarmSessionRuntime = (projectId: string, sessionPath: string): void => {
		const workspace = getActiveWorkspace();
		const project = sidebar?.getProjectById(projectId);
		if (!workspace || !project) return;
		ensureWorkspaceContentState(workspace);
		const normalizedTarget = normalizeSessionPath(sessionPath);
		if (!normalizedTarget) return;
		const tab = workspace.sessionTabs.find((entry) => normalizeSessionPath(entry.sessionPath) === normalizedTarget) ?? null;
		if (!tab) return; // 没有 tab 就没有 runtime 可预热；文件先行已保证首屏够快
		if (workspace.activeSessionTabId === tab.id) return; // 当前会话由正常切换链路负责
		const runtime = getRuntimeForTab(workspace.id, tab.id);
		if (runtime) {
			if (runtime.ensureInFlight) return;
			if (!runtime.suspended && runtime.bridge.isConnected) return;
		}
		const now = Date.now();
		if (now - (sessionPrewarmAt.get(normalizedTarget) ?? 0) < SESSION_PREWARM_THROTTLE_MS) return;
		sessionPrewarmAt.set(normalizedTarget, now);
		recordDebugTrace(`prewarm-runtime tab=${tab.id} session=${sessionPath}`);
		void ensureRuntimeForSessionTab(workspace, tab, project.path, false).catch((err) => {
			recordDebugTrace(`prewarm-runtime failed tab=${tab.id}: ${err instanceof Error ? err.message : String(err)}`);
		});
	};

	sidebar.setOnSessionPrewarm((projectId, sessionPath) => {
		prewarmSessionRuntime(projectId, sessionPath);
	});

	sidebar.setOnSessionSelect((projectId, sessionPath, sessionName) => {
		void activateProjectSession(projectId, sessionPath, sessionName, { label: "sidebar-session-select" });
	});

	sidebar.setOnSessionFork((projectId, sessionPath, sessionName) => {
		chatView?.openHistoryViewerForFork({ loading: true, sessionName });
		void activateProjectSession(projectId, sessionPath, sessionName, {
			label: "sidebar-session-fork",
			onActivated: () => {
				chatView?.openHistoryViewerForFork({ loading: false, sessionName });
			},
			onFailed: () => {
				chatView?.openHistoryViewerForFork({ loading: false, sessionName });
			},
		});
	});

	sidebar.setOnSessionMarkUnread((_projectId, sessionPath, _sessionName) => {
		const workspace = getActiveWorkspace();
		if (!workspace) return;
		ensureWorkspaceContentState(workspace);
		const normalizedTarget = normalizeSessionPath(sessionPath);
		const targetTab = workspace.sessionTabs.find((tab) => normalizeSessionPath(tab.sessionPath) === normalizedTarget) ?? null;
		if (!targetTab) {
			chatView?.notify(t("app.sessions.openBeforeMarkUnread"), "info");
			return;
		}
		setSessionAttention(targetTab, true, pickSessionAttentionMessage(targetTab.attentionMessage));
		persistWorkspaces();
		syncContentTabsBar(workspace);
		syncSidebarSelectionFromWorkspace(workspace);
		chatView?.notify(t("app.sessions.markedUnread"), "info");
	});

	sidebar.setOnSessionRename((projectId, sessionPath, _currentName, nextName) => {
		void renameSessionFromWorkspace(projectId, sessionPath, nextName);
	});

	// 删除会话文件前的 runtime 停止：sidebar 移入废纸篓前 await
	// window.__piGuiPrepareSessionDelete（内部走 awaitRuntimeStoppedForSession），
	// 另有 SESSION_WILL_DELETE_EVENT 同步监听兜底（见文件顶部，两者共享在途 promise）。

	sidebar.setOnSessionDelete((projectId, sessionPath) => {
		const workspace = getActiveWorkspace();
		const project = sidebar?.getProjectById(projectId);
		if (!workspace || !project) return;

		ensureWorkspaceContentState(workspace);
		const normalizedTarget = normalizeSessionPath(sessionPath);
		const removedIndices = workspace.sessionTabs
			.map((tab, index) => ({ tab, index }))
			.filter(({ tab }) => normalizeSessionPath(tab.sessionPath) === normalizedTarget)
			.map(({ index }) => index);

		if (removedIndices.length === 0) {
			scheduleSidebarSessionsRefresh(0);
			return;
		}

		const firstRemovedIndex = removedIndices[0];
		const removedTabs = workspace.sessionTabs.filter((tab) => normalizeSessionPath(tab.sessionPath) === normalizedTarget);
		const activeTab = workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId) ?? null;
		const activeWasRemoved = Boolean(activeTab && normalizeSessionPath(activeTab.sessionPath) === normalizedTarget);

		workspace.sessionTabs = workspace.sessionTabs.filter((tab) => normalizeSessionPath(tab.sessionPath) !== normalizedTarget);

		let nextSession: WorkspaceSessionTab | null = null;

		if (workspace.sessionTabs.length === 0) {
			nextSession = createSessionTab(NEW_SESSION_TAB_TITLE, null, project.id, project.path);
			workspace.sessionTabs = [nextSession];
			workspace.activeSessionTabId = nextSession.id;
			workspace.sessionTitle = nextSession.title;
		} else if (activeWasRemoved) {
			nextSession = workspace.sessionTabs[firstRemovedIndex] ?? workspace.sessionTabs[firstRemovedIndex - 1] ?? workspace.sessionTabs[0] ?? null;
			workspace.activeSessionTabId = nextSession?.id ?? null;
			workspace.sessionTitle = nextSession?.title ?? NEW_SESSION_TAB_TITLE;
		} else {
			const stillActive = workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId) ?? workspace.sessionTabs[0] ?? null;
			workspace.activeSessionTabId = stillActive?.id ?? null;
			workspace.sessionTitle = stillActive?.title ?? NEW_SESSION_TAB_TITLE;
		}

		ensureWorkspaceContentState(workspace);
		persistWorkspaces();
		syncWorkspaceTabsBar();
		syncContentTabsBar(workspace);
		scheduleSidebarSessionsRefresh(0);
		syncActiveChatRuntimeBinding(workspace, {
			forceReset: true,
			statusText: nextSession?.sessionPath ? t("app.status.loadingSession") : t("app.status.startingSession"),
		});
		void applyWorkspacePane(workspace);

		const disposeRemovedRuntimes = () => {
			removedTabs.forEach((tab) => removeRuntimeForTab(workspace.id, tab.id));
		};

		if (!activeWasRemoved) {
			disposeRemovedRuntimes();
			void applyWorkspacePane(workspace);
			return;
		}

		sidebar?.setActiveSessionPath(nextSession?.sessionPath ?? null);

		const nextProjectPath = getSessionTabProjectPath(nextSession) ?? getWorkspaceActiveProjectPath(workspace);
		void queueProjectTask(
			async (version) => {
				if (nextSession && nextProjectPath) {
					await ensureRuntimeForSessionTab(workspace, nextSession, nextProjectPath, true, version);
					assertProjectTaskCurrent(version);
					await chatView?.refreshFromBackend({ throwOnError: true });
				}
				assertProjectTaskCurrent(version);
				disposeRemovedRuntimes();
				scheduleSidebarSessionsRefresh(0);
				await applyWorkspacePane(workspace);
			},
			(err) => {
				console.error("Failed to switch session after delete:", err);
				chatView?.notify(formatErrorNotice(t("app.errors.switchSessionAfterDelete"), err), "error");
			},
		);
	});

	sidebar.setOnFileDelete((projectId, filePath) => {
		const workspace = getActiveWorkspace();
		const project = sidebar?.getProjectById(projectId);
		if (!workspace || !project) return;

		ensureWorkspaceContentState(workspace);
		const normalizedTarget = normalizeProjectPath(filePath);
		const removedIndices = workspace.fileTabs
			.map((tab, index) => ({ tab, index }))
			.filter(({ tab }) => normalizeProjectPath(tab.path) === normalizedTarget)
			.map(({ index }) => index);

		if (removedIndices.length === 0) {
			if (normalizeProjectPath(workspace.filePath) === normalizedTarget) {
				workspace.filePath = null;
				workspace.activeFileTabId = null;
				if (workspace.pane === "file") workspace.pane = "chat";
				persistWorkspaces();
				syncWorkspaceTabsBar();
				syncContentTabsBar(workspace);
				void applyWorkspacePane(workspace);
			}
			return;
		}

		const firstRemovedIndex = removedIndices[0];
		const activeFileTab = workspace.fileTabs.find((tab) => tab.id === workspace.activeFileTabId) ?? null;
		const activeWasRemoved = Boolean(activeFileTab && normalizeProjectPath(activeFileTab.path) === normalizedTarget);
		workspace.fileTabs = workspace.fileTabs.filter((tab) => normalizeProjectPath(tab.path) !== normalizedTarget);

		if (workspace.fileTabs.length === 0) {
			workspace.activeFileTabId = null;
			workspace.filePath = null;
			if (workspace.pane === "file") workspace.pane = "chat";
		} else if (activeWasRemoved) {
			const nextFile = workspace.fileTabs[firstRemovedIndex] ?? workspace.fileTabs[firstRemovedIndex - 1] ?? workspace.fileTabs[0] ?? null;
			workspace.activeFileTabId = nextFile?.id ?? null;
			workspace.filePath = nextFile?.path ?? null;
		} else if (!workspace.fileTabs.some((tab) => tab.id === workspace.activeFileTabId)) {
			workspace.activeFileTabId = workspace.fileTabs[0]?.id ?? null;
			workspace.filePath = workspace.fileTabs[0]?.path ?? null;
		}

		ensureWorkspaceContentState(workspace);
		persistWorkspaces();
		syncWorkspaceTabsBar();
		syncContentTabsBar(workspace);
		void applyWorkspacePane(workspace);
	});

	sidebar.setOnFileOpen(async (projectId, filePath) => {
		const workspace = getActiveWorkspace();
		const project = sidebar?.getProjectById(projectId);
		if (!workspace || !project) return;

		const navigationSnapshot = captureWorkspaceFileNavigation(workspace);
		setWorkspaceActiveProject(workspace, project);
		openOrActivateFileTab(workspace, filePath, project.id, project.path, { allowCreateTab: false });
		await commitWorkspaceFileNavigation(workspace, navigationSnapshot);
	});

	syncRunningSessionIndicators();
	ensureRunningSessionPoller();
	syncWorkspaceTabsBar();
	syncWorkspaceContextChrome(getActiveWorkspace());
}

function setupThemeSyncListeners(): void {
	const refreshThemeProjection = () => {
		const resolved = getResolvedDesktopTheme();
		const profiles = loadDesktopAppearanceProfiles();
		const workspace = getActiveWorkspace();
		const projectPath = workspace ? getWorkspaceActiveProjectPath(workspace) : null;
		void syncDesktopThemeWithPiTheme(projectPath).finally(() => {
			applyDesktopAppearanceProfileToRoot(resolved, profiles);
		});
	};
	window.addEventListener(DESKTOP_THEME_CHANGED_EVENT, refreshThemeProjection);
	window.addEventListener(DESKTOP_APPEARANCE_PROFILE_CHANGED_EVENT, refreshThemeProjection);
}

function setupCompactSidebarBreakpointListener(): void {
	const media = window.matchMedia("(max-width: 760px)");
	media.addEventListener("change", (event) => {
		if (event.matches || !compactSidebarOverlayOpen) return;
		compactSidebarOverlayOpen = false;
		document.querySelector<HTMLElement>(".content-shell")?.classList.remove("compact-sidebar-open");
		syncSidebarCollapseToggleButton();
	});
}

applyInitialTheme();
void applyNativeWindowVisualFixes();
setupThemeSyncListeners();
setupCompactSidebarBreakpointListener();
setupKeyboardShortcuts();
void initialize();
