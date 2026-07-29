/**
 * Sidebar - single left pane (projects with sessions, or files)
 */

import { html, nothing, render, type TemplateResult } from "lit";
import { t } from "../i18n/index.js";
import { alertDialog, confirmDialog, promptDialog } from "./app-dialog.js";
import { clearActiveDraggedFilePaths, setActiveDraggedFilePaths } from "./file-drag-transfer.js";
import {
	resolveSidebarSessionStatus,
	type SessionRunOutcome,
} from "./sidebar-session-status.js";
import { EMOJI_CATALOG } from "./workspace-tabs.js";

export type SidebarMode = "projects" | "files";

export interface SidebarWorkspaceItem {
	id: string;
	title: string;
	emoji?: string | null;
	color?: string | null;
	pinned?: boolean;
	closable?: boolean;
}

export interface SidebarSettingsNavItem {
	id: string;
	label: string;
	description?: string;
	disabled?: boolean;
}

interface SidebarSession {
	id: string;
	name: string;
	path: string;
	createdAt: number;
	modifiedAt: number;
	tokens: number;
	cost: number;
	optimistic?: boolean;
	transient?: boolean;
	/** fork 分支会话的父会话文件路径（pi 会话 header 的 parentSession），非分叉会话为 null。 */
	parentSessionPath?: string | null;
}

/** list_sessions（Rust 侧全量扫盘）返回的原始会话信息。 */
interface ScannedSessionInfo {
	id: string;
	name: string | null;
	preview: string | null;
	path: string;
	cwd: string | null;
	parent_session: string | null;
	created_at: number;
	modified_at: number;
	tokens: number;
	cost: number;
}

/**
 * list_sessions 每次都会扫描全部会话文件，连续展开多个项目时逐个触发就是重复全量扫描。
 * 这里给用户驱动的展开加 2s 共享缓存（合并在途请求）；变更驱动的静默刷新
 * （重命名/删除/新消息后的 scheduleSidebarSessionsRefresh）一律绕过并重建缓存。
 */
/**
 * 会话文件即将删除（移入废纸篓）前在 window 上广播的事件。
 * detail: { projectId: string; sessionPath: string }。
 * main.ts 监听后走「关闭会话 tab」同一套 runtime 停止路径（removeRuntimeForTab），
 * 保证 pi 进程先停、会话文件后移，避免进程仍挂着 JSONL 继续写入。
 */
export const SESSION_WILL_DELETE_EVENT = "pi-gui:session-will-delete";

declare global {
	interface Window {
		/**
		 * main.ts 注入的删除前置钩子：停止并等待所有附着该 session 的 runtime 退出
		 * （含租约释放，内部有超时兜底，不会永久挂起）。未注入时删除流程退化为
		 * 仅广播 SESSION_WILL_DELETE_EVENT。
		 */
		__piGuiPrepareSessionDelete?: (sessionPath: string) => Promise<void>;
	}
}

const SESSION_SCAN_CACHE_TTL_MS = 2_000;
let sessionScanCache: { at: number; sessions: ScannedSessionInfo[] } | null = null;
let sessionScanInFlight: Promise<ScannedSessionInfo[]> | null = null;

/**
 * 防御性清洗会话显示名：剥掉开头的 XML/skill 标签（含配对块与连续标签），
 * 避免首条用户消息里的机器生成标签串直接显示成会话名。剥完为空返回 ""，
 * 由调用方回退到「未命名会话」。Rust 侧 extract_session_preview 已做同样
 * 处理，这里兜底缓存/乐观条目里可能残留的脏数据。
 */
function sanitizeSessionLabel(raw: string | null | undefined): string {
	let text = (raw ?? "").trim();
	for (let guard = 0; guard < 50; guard++) {
		// 配对块：<skill name="…">…大段生成内容…</skill>
		const pair = text.match(/^<([A-Za-z][\w:.-]*)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/);
		if (pair) {
			text = text.slice(pair[0].length).trim();
			continue;
		}
		// 单个标签或注释
		const lone = text.match(/^<!--[\s\S]*?-->|^<\/?[A-Za-z][\w:.-]*(\s[^>]*)?\/?>/);
		if (lone) {
			text = text.slice(lone[0].length).trim();
			continue;
		}
		break;
	}
	return text;
}

async function scanAllSessions(options?: { bypassCache?: boolean }): Promise<ScannedSessionInfo[]> {
	if (options?.bypassCache) {
		sessionScanCache = null;
	} else if (sessionScanCache && Date.now() - sessionScanCache.at < SESSION_SCAN_CACHE_TTL_MS) {
		return sessionScanCache.sessions;
	}
	if (sessionScanInFlight) return sessionScanInFlight;
	sessionScanInFlight = (async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		const sessions = await invoke<ScannedSessionInfo[]>("list_sessions");
		sessionScanCache = { at: Date.now(), sessions };
		return sessions;
	})();
	try {
		return await sessionScanInFlight;
	} finally {
		sessionScanInFlight = null;
	}
}

interface Project {
	id: string;
	path: string;
	name: string;
	color: string;
	emoji: string;
	expanded: boolean;
	sessions: SidebarSession[];
	loadingSessions: boolean;
	sessionsLoaded: boolean;
	lastSessionsLoadedAt: number;
	pathExists: boolean | null;
	checkingPath: boolean;
}

interface PersistedProject {
	id: string;
	path: string;
	name: string;
	color: string;
	emoji?: string;
}

interface FileNode {
	id: string;
	name: string;
	path: string;
	displayPath: string;
	isDirectory: boolean;
	isSymlink: boolean;
	expanded: boolean;
	loading: boolean;
	loadError: boolean;
	depth: number;
	children?: FileNode[];
}

type SidebarContextTarget =
	| { kind: "session"; projectId: string; sessionPath: string }
	| { kind: "file"; projectId: string; filePath: string; isDirectory: boolean }
	| { kind: "workspace"; workspaceId: string };

const LEGACY_STORAGE_KEY = "pi-desktop.projects.v1";
const WORKSPACE_STORAGE_KEY_PREFIX = "pi-desktop.workspace-projects.v1";
const SIDEBAR_COLLAPSED_KEY = "pi-desktop.sidebar.collapsed.v1";
const PINNED_SECTION_COLLAPSED_KEY = "pi-desktop.sidebar.pinned-section-collapsed.v1";
const PROJECT_LIST_EXPANDED_KEY = "pi-desktop.sidebar.project-list-expanded.v1";
const PROJECT_LIST_COLLAPSED_LIMIT = 5;
const SESSION_PINS_STORAGE_KEY_SUFFIX = ".session-pins.v1";
const WORKSPACE_DRAG_THRESHOLD_PX = 5;
const WORKSPACE_SWIPE_THRESHOLD_PX = 34;
const WORKSPACE_SWIPE_IDLE_MS = 420;
const WORKSPACE_SWIPE_COOLDOWN_MS = 180;
const FOCUSABLE_SELECTOR = [
	"button:not([disabled])",
	"[href]",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

function uid(prefix = "id"): string {
	return `${prefix}_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

function workspaceStorageKey(workspaceId: string): string {
	return `${WORKSPACE_STORAGE_KEY_PREFIX}.${workspaceId}`;
}

const PROJECT_COLOR_PRESETS = ["#8b4a46", "#4f755f", "#846a3f", "#4d6f95", "#7a5891", "#4f8b8b", "#c06c2f", "#a8516e"] as const;

function stringToColor(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
	return PROJECT_COLOR_PRESETS[Math.abs(hash) % PROJECT_COLOR_PRESETS.length];
}

function normalizeProjectEmoji(emoji: string | null | undefined): string {
	const normalized = typeof emoji === "string" ? emoji.trim() : "";
	return normalized.length > 0 ? normalized : "📁";
}

function normalizePath(path: string | null | undefined): string {
	if (!path) return "";
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function sessionBelongsToProject(
	sessionCwd: string | null | undefined,
	projectPath: string | null | undefined,
): boolean {
	const normalizedSessionCwd = normalizePath(sessionCwd);
	const normalizedProjectPath = normalizePath(projectPath);
	return Boolean(normalizedSessionCwd && normalizedProjectPath && normalizedSessionCwd === normalizedProjectPath);
}

function pathBaseName(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalized.split("/");
	return parts[parts.length - 1] || normalized || path;
}

function joinFsPath(base: string, name: string): string {
	const sep = base.includes("\\") ? "\\" : "/";
	const normalizedBase = base.replace(/[\\/]+$/, "");
	return `${normalizedBase}${sep}${name}`;
}

function parentFsPath(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	if (!trimmed) return "";
	const parent = trimmed.replace(/[\\/][^\\/]+$/, "");
	if (parent && parent !== trimmed) {
		if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
		return parent;
	}
	if (/^[A-Za-z]:[\\/]/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
	if (trimmed.startsWith("/")) return "/";
	return parent || trimmed;
}

function isAbsolutePath(path: string): boolean {
	if (!path) return false;
	return /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(path);
}

function toFileUri(path: string): string {
	let normalized = path.replace(/\\/g, "/");
	if (/^[A-Za-z]:\//.test(normalized)) {
		normalized = `/${normalized}`;
	}
	return `file://${encodeURI(normalized)}`;
}

function fileExtension(name: string): string {
	const idx = name.lastIndexOf(".");
	if (idx === -1) return "";
	return name.slice(idx + 1).toLowerCase();
}

function fileIconKind(name: string): string {
	const lower = name.toLowerCase();
	const ext = fileExtension(lower);
	if (lower === "package.json" || lower === "tsconfig.json" || lower.endsWith(".config.json") || ext === "json") return "json";
	if (lower === ".gitignore" || lower === ".gitattributes" || lower.startsWith(".git")) return "git";
	if (lower.endsWith(".lock") || lower.includes("lockfile")) return "lock";
	if (ext === "md" || ext === "markdown" || ext === "mdx") return "md";
	if (ext === "ts" || ext === "tsx") return "ts";
	if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "js";
	if (ext === "jsonc" || ext === "yaml" || ext === "yml" || ext === "toml" || ext === "ini" || ext === "conf") return "config";
	if (ext === "html" || ext === "xml" || ext === "svg") return "markup";
	if (ext === "css" || ext === "scss" || ext === "sass" || ext === "less") return "style";
	if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "fish") return "shell";
	if (ext === "csv" || ext === "tsv") return "table";
	if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "heic"].includes(ext)) return "image";
	if (ext === "txt" || ext === "log") return "text";
	return "file";
}

function formatRelativeDate(ts: number): string {
	if (!ts) return "";
	const now = Date.now();
	const diff = Math.max(0, now - ts);
	const hour = 1000 * 60 * 60;
	const day = hour * 24;
	if (diff < hour) return `${Math.max(1, Math.floor(diff / (1000 * 60)))}m`;
	if (diff < day) return `${Math.floor(diff / hour)}h`;
	return `${Math.floor(diff / day)}d`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function formatCost(cost: number): string {
	if (!cost) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

export class Sidebar {
	private container: HTMLElement;
	private projects: Project[] = [];
	private activeProjectId: string | null = null;
	private activeSessionPath: string | null = null;
	private activeFilePath: string | null = null;
	private runningSessionPaths = new Set<string>();
	private suspendedSessionPaths = new Set<string>();
	private sessionRunOutcomes = new Map<string, SessionRunOutcome>();
	private attentionSessionMessages = new Map<string, string>();
	private workspaces: SidebarWorkspaceItem[] = [];
	private activeWorkspaceId: string | null = null;
	private workspaceMenuOpen = false;
	private workspaceRenameDraft: { workspaceId: string; value: string } | null = null;
	private workspaceCreateDialogOpen = false;
	private workspaceCreateName = "";
	private workspaceCreateEmoji = "✨";
	private workspaceCreateEmojiPickerOpen = false;
	private workspaceCreateEmojiQuery = "";
	private emojiPickerWorkspaceId: string | null = null;
	private emojiPickerX = 0;
	private emojiPickerY = 0;
	private emojiSearchQuery = "";
	private pendingWorkspaceDragId: string | null = null;
	private draggingWorkspaceId: string | null = null;
	private workspaceDragOverId: string | null = null;
	private workspaceDragPointerId: number | null = null;
	private workspaceDragStartX = 0;
	private workspaceDragStartY = 0;
	private workspaceDragSuppressClickUntil = 0;
	private workspaceSwipeAccumulatorX = 0;
	private workspaceSwipeLastInputAt = 0;
	private workspaceSwipeLastSwitchAt = 0;
	private workspaceSwipeGestureConsumed = false;
	private workspaceHydrationToken = 0;
	private projectEmojiPickerProjectId: string | null = null;
	private projectEmojiPickerX = 0;
	private projectEmojiPickerY = 0;
	private projectEmojiSearchQuery = "";
	private projectEmojiPortalHost: HTMLElement | null = null;
	private workspaceEmojiPortalHost: HTMLElement | null = null;
	private workspaceCreatePortalHost: HTMLElement | null = null;
	private workspaceCreateDialogFocusTrapActive = false;
	private workspaceCreateDialogRestoreFocus: HTMLElement | null = null;
	private pendingProjectDragId: string | null = null;
	private draggingProjectId: string | null = null;
	private projectDragOverId: string | null = null;
	private projectDragPointerId: number | null = null;
	private projectDragStartY = 0;
	private projectDragSuppressClickUntil = 0;
	private mode: SidebarMode = "projects";
	private settingsShellActive = false;
	private settingsNavItems: SidebarSettingsNavItem[] = [];
	private activeSettingsNavId: string | null = null;
	private query = "";
	private collapsed = false;
	private pinnedSectionCollapsed = false;
	private projectListExpanded = false;
	private pinnedHydrationAttempted = new Set<string>();
	private storageKey = workspaceStorageKey("workspace_default");

	private fileTrees = new Map<string, FileNode[]>();
	private fileTreeErrors = new Map<string, string>();
	private loadingFileTreeForProject = new Set<string>();
	private sessionLoadsInFlight = new Map<string, Promise<void>>();
	private sessionReloadQueued = new Set<string>();
	private packagesOpen = false;
	private openProjectMenuId: string | null = null;
	private modeFilterMenuOpen = false;
	private desktopUpdateAvailable = false;
	private desktopUpdateLatestVersion: string | null = null;
	private cliUpdateAvailable = false;
	private cliUpdateLatestVersion: string | null = null;
	private updateInProgress = false;
	private sessionOrganize: "byProject" | "chronological" = "byProject";
	private sessionSortBy: "updated" | "created" = "updated";
	private sessionShow: "all" | "relevant" = "all";
	private fileSort: "nameAsc" | "nameDesc" = "nameAsc";
	private fileKind: "all" | "files" | "dirs" = "all";
	private sessionRenameDraft: { projectId: string; sessionPath: string; value: string } | null = null;
	private fileRenameDraft: { projectId: string; filePath: string; value: string } | null = null;
	private contextMenu: { x: number; y: number; target: SidebarContextTarget } | null = null;
	private transientSessionDraft: { projectId: string; path: string | null; name: string; createdAt: number } | null = null;
	private suppressedSessionPaths = new Set<string>();
	private pinnedSessionPaths = new Set<string>();
	/** 轻量操作提示（如「已移到废纸篓」）：自动消失，不用模态框打断。 */
	private sidebarNotice: { id: number; text: string } | null = null;
	private sidebarNoticeSeq = 0;
	/** 正在走删除流程（停 runtime → 移废纸篓）的会话路径（normalize 后），用于防重复点击。 */
	private deletingSessionPaths = new Set<string>();

	private onOpenSettings: ((sectionId?: string) => void) | null = null;
	private onUpdateIconClick: (() => void) | null = null;
	private onCloseSettings: (() => void) | null = null;
	private onTogglePackages: (() => void) | null = null;
	private onWorkspaceSelect: ((workspaceId: string) => void) | null = null;
	private onWorkspaceCreate: ((workspace?: { title?: string; emoji?: string | null }) => void) | null = null;
	private onWorkspaceEmoji: ((workspaceId: string, emoji: string | null) => void) | null = null;
	private onWorkspaceReorder: ((orderedIds: string[]) => void) | null = null;
	private onWorkspaceRename: ((workspaceId: string, nextTitle: string) => void) | null = null;
	private onWorkspaceDelete: ((workspaceId: string) => void) | null = null;
	private onProjectSelect: ((project: { id: string; name: string; path: string } | null) => void) | null = null;
	private onProjectRemoved: ((project: { id: string; name: string; path: string }) => void) | null = null;
	private onSessionSelect: ((projectId: string, sessionPath: string, sessionName?: string) => void) | null = null;
	private onSessionPrewarm: ((projectId: string, sessionPath: string) => void) | null = null;
	private sessionPrewarmTimer: ReturnType<typeof setTimeout> | null = null;
	private sessionPrewarmTarget: string | null = null;
	private onSessionRename: ((projectId: string, sessionPath: string, currentName: string, nextName: string) => void) | null = null;
	private onSessionDelete: ((projectId: string, sessionPath: string) => void) | null = null;
	private onSessionFork: ((projectId: string, sessionPath: string, sessionName?: string) => void) | null = null;
	private onSessionMarkUnread: ((projectId: string, sessionPath: string, sessionName?: string) => void) | null = null;
	private onNewSessionInProject: ((project: { id: string; name: string; path: string }) => void) | null = null;
	private onNewFileInProject: ((project: { id: string; name: string; path: string; directoryPath?: string | null; anchorPath?: string | null }) => void) | null = null;
	private newFilePlacementHint: { projectId: string; anchorPath: string; newPath: string; expiresAt: number } | null = null;
	private onFileOpen: ((projectId: string, filePath: string) => void) | null = null;
	private onFileDelete: ((projectId: string, filePath: string) => void) | null = null;
	private onModeChange: ((mode: SidebarMode) => void) | null = null;
	private onSettingsNavSelect: ((id: string) => void) | null = null;
	private onCollapsedChange: ((collapsed: boolean) => void) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
		this.loadSidebarState();
		this.loadPersistedProjects();
		this.loadPinnedSessions();
		this.render();
		this.workspaceHydrationToken += 1;
		void this.hydrateProjects(this.workspaceHydrationToken);
	}

	private loadSidebarState(): void {
		try {
			this.collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
		} catch {
			this.collapsed = false;
		}
		try {
			this.pinnedSectionCollapsed = localStorage.getItem(PINNED_SECTION_COLLAPSED_KEY) === "1";
		} catch {
			this.pinnedSectionCollapsed = false;
		}
		try {
			this.projectListExpanded = localStorage.getItem(PROJECT_LIST_EXPANDED_KEY) === "1";
		} catch {
			this.projectListExpanded = false;
		}
	}

	private persistSidebarState(): void {
		try {
			localStorage.setItem(SIDEBAR_COLLAPSED_KEY, this.collapsed ? "1" : "0");
		} catch {
			// ignore
		}
	}

	private persistPinnedSectionState(): void {
		try {
			localStorage.setItem(PINNED_SECTION_COLLAPSED_KEY, this.pinnedSectionCollapsed ? "1" : "0");
		} catch {
			// ignore
		}
	}

	private persistProjectListState(): void {
		try {
			localStorage.setItem(PROJECT_LIST_EXPANDED_KEY, this.projectListExpanded ? "1" : "0");
		} catch {
			// ignore
		}
	}

	private togglePinnedSectionCollapsed(): void {
		this.pinnedSectionCollapsed = !this.pinnedSectionCollapsed;
		this.persistPinnedSectionState();
		this.render();
	}

	private toggleProjectListExpanded(): void {
		this.projectListExpanded = !this.projectListExpanded;
		this.persistProjectListState();
		this.render();
	}

	async setWorkspace(workspaceId: string): Promise<void> {
		const nextKey = workspaceStorageKey(workspaceId);
		if (this.storageKey === nextKey) return;

		this.workspaceHydrationToken += 1;
		const hydrationToken = this.workspaceHydrationToken;

		this.storageKey = nextKey;
		this.query = "";
		this.projects = [];
		this.activeProjectId = null;
		this.activeSessionPath = null;
		this.activeFilePath = null;
		this.runningSessionPaths.clear();
		this.suspendedSessionPaths.clear();
		this.sessionRunOutcomes.clear();
		this.attentionSessionMessages.clear();
		this.fileTrees.clear();
		this.fileTreeErrors.clear();
		this.loadingFileTreeForProject.clear();
		this.sessionLoadsInFlight.clear();
		this.sessionReloadQueued.clear();
		this.openProjectMenuId = null;
		this.modeFilterMenuOpen = false;
		this.workspaceMenuOpen = false;
		this.workspaceRenameDraft = null;
		this.closeWorkspaceCreateDialog(false, false);
		this.workspaceCreateName = "";
		this.workspaceCreateEmoji = "✨";
		this.workspaceCreateEmojiPickerOpen = false;
		this.workspaceCreateEmojiQuery = "";
		this.cancelWorkspacePointerDrag(false);
		this.cancelProjectPointerDrag(false);
		this.closeWorkspaceEmojiPicker(false);
		this.closeProjectEmojiPicker(false);
		this.transientSessionDraft = null;
		this.suppressedSessionPaths.clear();
		this.pinnedSessionPaths.clear();
		this.pinnedHydrationAttempted.clear();
		this.clearInlineDrafts();
		this.closeContextMenu(false);

		this.loadPersistedProjects();
		this.loadPinnedSessions();
		this.render();
		void this.hydrateProjects(hydrationToken);
	}

	toggleCollapsed(): void {
		this.setCollapsed(!this.collapsed);
	}

	setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) return;
		this.collapsed = collapsed;
		this.persistSidebarState();
		this.render();
		this.onCollapsedChange?.(collapsed);
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	setOnOpenSettings(cb: (sectionId?: string) => void): void {
		this.onOpenSettings = cb;
	}

	/** 更新 icon 点击：由 main.ts 接管为一键更新流程（确认→更新→重启），不再跳设置页。 */
	setOnUpdateIconClick(cb: (() => void) | null): void {
		this.onUpdateIconClick = cb;
	}

	/** 一键更新进行中：icon 显示 spinner 并禁用。 */
	setUpdateInProgress(inProgress: boolean): void {
		if (this.updateInProgress === inProgress) return;
		this.updateInProgress = inProgress;
		this.render();
	}

	setOnCloseSettings(cb: () => void): void {
		this.onCloseSettings = cb;
	}

	setOnTogglePackages(cb: () => void): void {
		this.onTogglePackages = cb;
	}

	setOnWorkspaceSelect(cb: (workspaceId: string) => void): void {
		this.onWorkspaceSelect = cb;
	}

	setOnWorkspaceCreate(cb: (workspace?: { title?: string; emoji?: string | null }) => void): void {
		this.onWorkspaceCreate = cb;
	}

	setOnWorkspaceEmoji(cb: (workspaceId: string, emoji: string | null) => void): void {
		this.onWorkspaceEmoji = cb;
	}

	setOnWorkspaceReorder(cb: (orderedIds: string[]) => void): void {
		this.onWorkspaceReorder = cb;
	}

	setOnWorkspaceRename(cb: (workspaceId: string, nextTitle: string) => void): void {
		this.onWorkspaceRename = cb;
	}

	setOnWorkspaceDelete(cb: (workspaceId: string) => void): void {
		this.onWorkspaceDelete = cb;
	}

	setWorkspaces(workspaces: SidebarWorkspaceItem[], activeWorkspaceId: string | null): void {
		const next = workspaces.map((workspace) => ({
			id: workspace.id,
			title: workspace.title,
			emoji: workspace.emoji ?? null,
			color: workspace.color ?? null,
			pinned: Boolean(workspace.pinned),
			closable: Boolean(workspace.closable),
		}));
		const nextActive = activeWorkspaceId && next.some((workspace) => workspace.id === activeWorkspaceId)
			? activeWorkspaceId
			: next[0]?.id ?? null;

		const sameList =
			next.length === this.workspaces.length &&
			next.every((workspace, index) => {
				const current = this.workspaces[index];
				return Boolean(current) &&
					current.id === workspace.id &&
					current.title === workspace.title &&
					(current.emoji ?? null) === (workspace.emoji ?? null) &&
					(current.color ?? null) === (workspace.color ?? null) &&
					Boolean(current.pinned) === Boolean(workspace.pinned) &&
					Boolean(current.closable) === Boolean(workspace.closable);
			});

		if (sameList && this.activeWorkspaceId === nextActive) return;

		this.workspaces = next;
		this.activeWorkspaceId = nextActive;
		if (this.workspaceMenuOpen && !next.some((workspace) => workspace.id === this.activeWorkspaceId)) {
			this.workspaceMenuOpen = false;
		}
		if (
			(this.pendingWorkspaceDragId && !next.some((workspace) => workspace.id === this.pendingWorkspaceDragId)) ||
			(this.draggingWorkspaceId && !next.some((workspace) => workspace.id === this.draggingWorkspaceId)) ||
			(this.workspaceDragOverId && !next.some((workspace) => workspace.id === this.workspaceDragOverId))
		) {
			this.cancelWorkspacePointerDrag(false);
		}
		if (this.emojiPickerWorkspaceId && !next.some((workspace) => workspace.id === this.emojiPickerWorkspaceId)) {
			this.emojiPickerWorkspaceId = null;
			this.emojiSearchQuery = "";
		}
		if (this.workspaceRenameDraft && !next.some((workspace) => workspace.id === this.workspaceRenameDraft?.workspaceId)) {
			this.workspaceRenameDraft = null;
		}
		this.render();
		if (this.workspaceRenameDraft && this.workspaceRenameDraft.workspaceId === this.activeWorkspaceId) {
			this.focusWorkspaceRenameInput(this.workspaceRenameDraft.workspaceId);
		}
	}

	setPackagesOpen(open: boolean): void {
		if (this.packagesOpen === open) return;
		this.packagesOpen = open;
		this.render();
	}

	setDesktopUpdateStatus(updateAvailable: boolean, latestVersion: string | null = null): void {
		const normalizedLatest = latestVersion && latestVersion.trim().length > 0 ? latestVersion.trim() : null;
		if (this.desktopUpdateAvailable === updateAvailable && this.desktopUpdateLatestVersion === normalizedLatest) return;
		this.desktopUpdateAvailable = updateAvailable;
		this.desktopUpdateLatestVersion = normalizedLatest;
		this.render();
	}

	setCliUpdateStatus(updateAvailable: boolean, latestVersion: string | null = null): void {
		const normalizedLatest = latestVersion && latestVersion.trim().length > 0 ? latestVersion.trim() : null;
		if (this.cliUpdateAvailable === updateAvailable && this.cliUpdateLatestVersion === normalizedLatest) return;
		this.cliUpdateAvailable = updateAvailable;
		this.cliUpdateLatestVersion = normalizedLatest;
		this.render();
	}

	setOnProjectSelect(cb: (project: { id: string; name: string; path: string } | null) => void): void {
		this.onProjectSelect = cb;
	}

	setOnProjectRemoved(cb: (project: { id: string; name: string; path: string }) => void): void {
		this.onProjectRemoved = cb;
	}

	setOnSessionSelect(cb: (projectId: string, sessionPath: string, sessionName?: string) => void): void {
		this.onSessionSelect = cb;
	}

	setOnSessionPrewarm(cb: (projectId: string, sessionPath: string) => void): void {
		this.onSessionPrewarm = cb;
	}

	private cancelSessionPrewarmTimer(): void {
		if (this.sessionPrewarmTimer) {
			clearTimeout(this.sessionPrewarmTimer);
			this.sessionPrewarmTimer = null;
		}
		this.sessionPrewarmTarget = null;
	}

	/** hover 短暂停留后预热；pointerdown 立即预热（点击意图明确）。 */
	private handleSessionPrewarmEnter(projectId: string, sessionPath: string): void {
		if (!sessionPath) return;
		this.cancelSessionPrewarmTimer();
		this.sessionPrewarmTarget = `${projectId}::${sessionPath}`;
		this.sessionPrewarmTimer = setTimeout(() => {
			this.sessionPrewarmTimer = null;
			this.onSessionPrewarm?.(projectId, sessionPath);
		}, 120);
	}

	private handleSessionPrewarmLeave(projectId: string, sessionPath: string): void {
		if (this.sessionPrewarmTarget === `${projectId}::${sessionPath}`) {
			this.cancelSessionPrewarmTimer();
		}
	}

	private handleSessionPrewarmDown(projectId: string, sessionPath: string): void {
		if (!sessionPath) return;
		this.cancelSessionPrewarmTimer();
		this.onSessionPrewarm?.(projectId, sessionPath);
	}

	setOnSessionRename(cb: (projectId: string, sessionPath: string, currentName: string, nextName: string) => void): void {
		this.onSessionRename = cb;
	}

	setOnSessionDelete(cb: (projectId: string, sessionPath: string) => void): void {
		this.onSessionDelete = cb;
	}

	setOnSessionFork(cb: (projectId: string, sessionPath: string, sessionName?: string) => void): void {
		this.onSessionFork = cb;
	}

	setOnSessionMarkUnread(cb: (projectId: string, sessionPath: string, sessionName?: string) => void): void {
		this.onSessionMarkUnread = cb;
	}

	setOnNewSessionInProject(cb: (project: { id: string; name: string; path: string }) => void): void {
		this.onNewSessionInProject = cb;
	}

	setOnNewFileInProject(cb: (project: { id: string; name: string; path: string; directoryPath?: string | null; anchorPath?: string | null }) => void): void {
		this.onNewFileInProject = cb;
	}

	setOnFileOpen(cb: (projectId: string, filePath: string) => void): void {
		this.onFileOpen = cb;
	}

	setOnFileDelete(cb: (projectId: string, filePath: string) => void): void {
		this.onFileDelete = cb;
	}

	setOnModeChange(cb: (mode: SidebarMode) => void): void {
		this.onModeChange = cb;
	}

	setOnSettingsNavSelect(cb: ((id: string) => void) | null): void {
		this.onSettingsNavSelect = cb;
	}

	setSettingsShellActive(active: boolean): void {
		if (this.settingsShellActive === active) return;
		this.settingsShellActive = active;
		this.modeFilterMenuOpen = false;
		this.openProjectMenuId = null;
		this.closeContextMenu(false);
		this.render();
	}

	setSettingsNavigation(items: SidebarSettingsNavItem[], activeId: string | null): void {
		this.settingsNavItems = items.map((item) => ({
			id: item.id,
			label: item.label,
			description: item.description,
			disabled: Boolean(item.disabled),
		}));
		this.activeSettingsNavId = activeId;
		if (this.settingsShellActive) this.render();
	}

	setOnCollapsedChange(cb: (collapsed: boolean) => void): void {
		this.onCollapsedChange = cb;
	}

	private clearInlineDrafts(shouldRender = false): void {
		const hadDraft = Boolean(this.sessionRenameDraft || this.fileRenameDraft);
		this.sessionRenameDraft = null;
		this.fileRenameDraft = null;
		if (shouldRender && hadDraft) {
			this.render();
		}
	}

	private readonly onWindowContextMenuPointerDown = (event: PointerEvent): void => {
		if (!this.contextMenu) return;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest(".sidebar-context-menu")) return;
		this.closeContextMenu();
	};

	private readonly onWindowContextMenuMouseDown = (event: MouseEvent): void => {
		if (!this.contextMenu) return;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest(".sidebar-context-menu")) return;
		this.closeContextMenu();
	};

	private closeContextMenu(shouldRender = true): void {
		if (!this.contextMenu) return;
		this.contextMenu = null;
		window.removeEventListener("pointerdown", this.onWindowContextMenuPointerDown, true);
		window.removeEventListener("mousedown", this.onWindowContextMenuMouseDown, true);
		if (shouldRender) this.render();
	}

	/** Esc 统一收回侧栏各弹层（右键菜单 / emoji 弹层 / 项目菜单 / 筛选菜单）。 */
	private readonly onWindowPopupKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		let changed = false;
		if (this.contextMenu) {
			this.closeContextMenu(false);
			changed = true;
		}
		if (this.emojiPickerWorkspaceId) {
			this.closeWorkspaceEmojiPicker(false);
			changed = true;
		}
		if (this.projectEmojiPickerProjectId) {
			this.closeProjectEmojiPicker(false);
			changed = true;
		}
		if (this.openProjectMenuId) {
			this.openProjectMenuId = null;
			changed = true;
		}
		if (this.modeFilterMenuOpen) {
			this.modeFilterMenuOpen = false;
			changed = true;
		}
		if (!changed) return;
		event.preventDefault();
		event.stopPropagation();
		this.render();
	};

	/** 侧栏内容滚动后 emoji 弹层会与锚定图标脱节，直接收回；弹层内部滚动除外。 */
	private readonly onWindowPopupScroll = (event: Event): void => {
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest(".workspace-emoji-picker")) return;
		let changed = false;
		if (this.emojiPickerWorkspaceId) {
			this.closeWorkspaceEmojiPicker(false);
			changed = true;
		}
		if (this.projectEmojiPickerProjectId) {
			this.closeProjectEmojiPicker(false);
			changed = true;
		}
		if (changed) this.render();
	};

	private popupGlobalListenersBound = false;

	/** 有任一弹层打开时才挂全局监听，全部关闭后摘掉；在 render() 末尾同步。 */
	private syncPopupGlobalListeners(): void {
		const anyOpen = Boolean(this.contextMenu) ||
			Boolean(this.emojiPickerWorkspaceId) ||
			Boolean(this.projectEmojiPickerProjectId) ||
			Boolean(this.openProjectMenuId) ||
			this.modeFilterMenuOpen;
		if (anyOpen && !this.popupGlobalListenersBound) {
			window.addEventListener("keydown", this.onWindowPopupKeyDown, true);
			window.addEventListener("scroll", this.onWindowPopupScroll, true);
			this.popupGlobalListenersBound = true;
		} else if (!anyOpen && this.popupGlobalListenersBound) {
			window.removeEventListener("keydown", this.onWindowPopupKeyDown, true);
			window.removeEventListener("scroll", this.onWindowPopupScroll, true);
			this.popupGlobalListenersBound = false;
		}
	}

	private openContextMenu(e: MouseEvent, target: SidebarContextTarget): void {
		e.preventDefault();
		e.stopPropagation();
		const menuWidth = 170;
		const menuHeight = target.kind === "workspace"
			? 92
			: target.kind === "session"
				? 194
				: target.isDirectory
					? 52
					: 122;
		const padding = 8;
		const bounds = this.container.getBoundingClientRect();
		const minX = Math.max(padding, Math.floor(bounds.left + padding));
		const maxX = Math.min(window.innerWidth - menuWidth - padding, Math.floor(bounds.right - menuWidth - padding));
		const minY = Math.max(padding, Math.floor(bounds.top + padding));
		const maxY = Math.min(window.innerHeight - menuHeight - padding, Math.floor(bounds.bottom - menuHeight - padding));
		const x = Math.max(minX, Math.min(e.clientX, Math.max(minX, maxX)));
		const y = Math.max(minY, Math.min(e.clientY, Math.max(minY, maxY)));
		this.closeWorkspaceEmojiPicker(false);
		this.closeProjectEmojiPicker(false);
		this.contextMenu = { x, y, target };
		window.removeEventListener("pointerdown", this.onWindowContextMenuPointerDown, true);
		window.removeEventListener("mousedown", this.onWindowContextMenuMouseDown, true);
		window.addEventListener("pointerdown", this.onWindowContextMenuPointerDown, true);
		window.addEventListener("mousedown", this.onWindowContextMenuMouseDown, true);
		this.render();
	}

	private findSession(projectId: string, sessionPath: string): { project: Project; session: SidebarSession } | null {
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) return null;
		const session = project.sessions.find((entry) => normalizePath(entry.path) === normalizePath(sessionPath));
		if (!session) return null;
		return { project, session };
	}

	private findFileNode(projectId: string, filePath: string): FileNode | null {
		const normalized = normalizePath(filePath);
		const walk = (nodes: FileNode[]): FileNode | null => {
			for (const node of nodes) {
				if (normalizePath(node.path) === normalized) return node;
				if (node.children?.length) {
					const found = walk(node.children);
					if (found) return found;
				}
			}
			return null;
		};
		return walk(this.fileTrees.get(projectId) ?? []);
	}

	setMode(mode: SidebarMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.query = "";
		this.modeFilterMenuOpen = false;
		this.cancelProjectPointerDrag(false);
		this.clearInlineDrafts();
		this.closeContextMenu(false);
		if (mode === "files") {
			const expandedProjects = this.projects.filter((project) => project.expanded);
			if (expandedProjects.length === 0) {
				void this.ensureFileTreeForActiveProject();
			} else {
				expandedProjects.forEach((project) => {
					void this.ensureFileTreeForProject(project.id);
				});
			}
		}
		this.render();
		this.onModeChange?.(mode);
	}

	getMode(): SidebarMode {
		return this.mode;
	}

	getActiveProject(): { id: string; name: string; path: string } | null {
		const p = this.projects.find((x) => x.id === this.activeProjectId);
		return p ? { id: p.id, name: p.name, path: p.path } : null;
	}

	listProjects(): Array<{ id: string; name: string; path: string }> {
		return this.projects.map((project) => ({ id: project.id, name: project.name, path: project.path }));
	}

	getProjectById(projectId: string | null | undefined): { id: string; name: string; path: string } | null {
		if (!projectId) return null;
		const project = this.projects.find((entry) => entry.id === projectId) ?? null;
		return project ? { id: project.id, name: project.name, path: project.path } : null;
	}

	getProjectByPath(projectPath: string | null | undefined): { id: string; name: string; path: string } | null {
		const normalized = normalizePath(projectPath);
		if (!normalized) return null;
		const project = this.projects.find((entry) => normalizePath(entry.path) === normalized) ?? null;
		return project ? { id: project.id, name: project.name, path: project.path } : null;
	}

	clearActiveProject(emitSelect = false): void {
		const changed = this.activeProjectId !== null;
		this.activeProjectId = null;
		this.activeSessionPath = null;
		this.activeFilePath = null;
		this.clearInlineDrafts();
		this.closeContextMenu(false);
		this.render();
		if (emitSelect && changed) {
			this.onProjectSelect?.(null);
		}
	}

	setActiveProject(projectId: string | null, emitSelect = false): void {
		if (!projectId) {
			this.clearActiveProject(emitSelect);
			return;
		}
		this.selectProject(projectId, emitSelect);
	}

	setActiveSessionPath(sessionPath: string | null): void {
		const normalized = sessionPath ? normalizePath(sessionPath) : null;
		if (this.activeSessionPath === normalized) return;
		this.activeSessionPath = normalized;
		this.render();
	}

	beginSessionRename(projectId: string, sessionPath: string): boolean {
		const found = this.findSession(projectId, sessionPath);
		if (!found) return false;
		this.selectProject(found.project.id, false);
		this.activeSessionPath = normalizePath(found.session.path);
		this.activeFilePath = null;
		this.startSessionRename(found.project, found.session);
		return true;
	}

	setActiveFilePath(filePath: string | null): void {
		const normalized = filePath ? normalizePath(filePath) : null;
		if (this.activeFilePath === normalized) return;
		this.activeFilePath = normalized;
		this.render();
	}

	setRunningSessionPaths(sessionPaths: string[]): void {
		const next = new Set(
			sessionPaths
				.map((sessionPath) => normalizePath(sessionPath))
				.filter((sessionPath) => Boolean(sessionPath)),
		);

		if (next.size === this.runningSessionPaths.size) {
			let identical = true;
			for (const sessionPath of next) {
				if (!this.runningSessionPaths.has(sessionPath)) {
					identical = false;
					break;
				}
			}
			if (identical) return;
		}

		this.runningSessionPaths = next;
		this.render();
	}

	setRunningSessionPath(sessionPath: string | null): void {
		this.setRunningSessionPaths(sessionPath ? [sessionPath] : []);
	}

	setSuspendedSessionPaths(sessionPaths: string[]): void {
		const next = new Set(
			sessionPaths
				.map((sessionPath) => normalizePath(sessionPath))
				.filter((sessionPath) => Boolean(sessionPath)),
		);

		if (next.size === this.suspendedSessionPaths.size) {
			let identical = true;
			for (const sessionPath of next) {
				if (!this.suspendedSessionPaths.has(sessionPath)) {
					identical = false;
					break;
				}
			}
			if (identical) return;
		}

		this.suspendedSessionPaths = next;
		this.render();
	}

	setSessionRunOutcomes(entries: Array<{ path: string; outcome: SessionRunOutcome }>): void {
		const next = new Map<string, SessionRunOutcome>();
		for (const entry of entries) {
			const path = normalizePath(entry.path);
			if (!path) continue;
			next.set(path, entry.outcome);
		}

		if (next.size === this.sessionRunOutcomes.size) {
			let identical = true;
			for (const [path, outcome] of next) {
				if (this.sessionRunOutcomes.get(path) !== outcome) {
					identical = false;
					break;
				}
			}
			if (identical) return;
		}

		this.sessionRunOutcomes = next;
		this.render();
	}

	setAttentionSessions(entries: Array<{ path: string; message?: string | null }>): void {
		const next = new Map<string, string>();
		for (const entry of entries) {
			const normalizedPath = normalizePath(entry.path);
			if (!normalizedPath) continue;
			const message = typeof entry.message === "string" && entry.message.trim().length > 0
				? entry.message.trim()
				: t("sidebar.session.attentionFallback");
			next.set(normalizedPath, message);
		}

		if (next.size === this.attentionSessionMessages.size) {
			let identical = true;
			for (const [path, message] of next) {
				if (this.attentionSessionMessages.get(path) !== message) {
					identical = false;
					break;
				}
			}
			if (identical) return;
		}

		this.attentionSessionMessages = next;
		this.render();
	}

	setSuppressedSessionPaths(sessionPaths: string[]): void {
		const next = new Set(
			sessionPaths
				.map((sessionPath) => normalizePath(sessionPath))
				.filter((sessionPath) => Boolean(sessionPath)),
		);
		if (next.size === this.suppressedSessionPaths.size) {
			let identical = true;
			for (const sessionPath of next) {
				if (!this.suppressedSessionPaths.has(sessionPath)) {
					identical = false;
					break;
				}
			}
			if (identical) return;
		}
		this.suppressedSessionPaths = next;
		this.render();
	}

	setTransientSessionDraft(draft: { projectId: string; path?: string | null; name?: string | null } | null): void {
		const next = draft
			? {
				projectId: draft.projectId,
				path: draft.path ? draft.path : null,
				name: draft.name?.trim() || t("sidebar.session.new"),
				createdAt: Date.now(),
			}
			: null;
		const same =
			this.transientSessionDraft?.projectId === next?.projectId &&
			normalizePath(this.transientSessionDraft?.path) === normalizePath(next?.path) &&
			this.transientSessionDraft?.name === next?.name;
		if (same) return;
		this.transientSessionDraft = next;
		this.render();
	}

	async ensureSessionsLoadedForProject(projectId: string): Promise<void> {
		const project = this.projects.find((entry) => entry.id === projectId);
		if (!project) return;
		if (project.loadingSessions || project.sessionsLoaded) return;
		await this.loadSessionsForProject(projectId, { silent: true });
	}

	getPreferredSessionForProject(projectId: string): { path: string; name: string } | null {
		const project = this.projects.find((entry) => entry.id === projectId);
		if (!project) return null;
		const sessions = this.sortedSessions(
			project.sessions.filter((session) => {
				const normalizedPath = normalizePath(session.path);
				return Boolean(normalizedPath) && !this.suppressedSessionPaths.has(normalizedPath);
			}),
		);
		const session = sessions[0] ?? null;
		return session ? { path: session.path, name: session.name } : null;
	}

	removeSessionPath(sessionPath: string): void {
		const normalized = normalizePath(sessionPath);
		if (!normalized) return;
		let changed = false;
		for (const project of this.projects) {
			const nextSessions = project.sessions.filter((entry) => normalizePath(entry.path) !== normalized);
			if (nextSessions.length !== project.sessions.length) {
				project.sessions = nextSessions;
				changed = true;
			}
		}
		if (this.activeSessionPath === normalized) {
			this.activeSessionPath = null;
			changed = true;
		}
		if (changed) {
			this.render();
		}
	}

	refreshActiveProjectSessions(): void {
		const active = this.getActiveProject();
		if (!active) return;
		void this.loadSessionsForProject(active.id, { silent: true });
	}

	upsertSession(
		projectId: string,
		session: {
			id?: string | null;
			name?: string | null;
			path: string;
			createdAt?: number | null;
			modifiedAt?: number | null;
			tokens?: number | null;
			cost?: number | null;
			optimistic?: boolean;
		},
	): void {
		const project = this.projects.find((entry) => entry.id === projectId);
		if (!project) return;
		const normalized = normalizePath(session.path);
		if (!normalized) return;
		const now = Date.now();
		const existing = project.sessions.find((entry) => normalizePath(entry.path) === normalized) ?? null;
		const nextName = session.name?.trim() || existing?.name || t("sidebar.session.untitled");
		if (existing) {
			existing.id = session.id?.trim() || existing.id;
			existing.name = nextName;
			existing.createdAt = session.createdAt ?? existing.createdAt ?? now;
			existing.modifiedAt = session.modifiedAt ?? existing.modifiedAt ?? now;
			existing.tokens = session.tokens ?? existing.tokens ?? 0;
			existing.cost = session.cost ?? existing.cost ?? 0;
			existing.optimistic = session.optimistic ?? existing.optimistic ?? false;
		} else {
			project.sessions.unshift({
				id: session.id?.trim() || uid("session"),
				name: nextName,
				path: session.path,
				createdAt: session.createdAt ?? session.modifiedAt ?? now,
				modifiedAt: session.modifiedAt ?? session.createdAt ?? now,
				tokens: session.tokens ?? 0,
				cost: session.cost ?? 0,
				optimistic: session.optimistic ?? false,
			});
		}
		project.sessionsLoaded = true;
		project.lastSessionsLoadedAt = Date.now();
		this.render();
	}

	refreshActiveProjectFiles(forceReload = true): void {
		const active = this.getActiveProject();
		if (!active) return;
		void this.ensureFileTreeForProject(active.id, forceReload);
	}

	setNewFilePlacementHint(projectId: string, newFilePath: string, anchorPath: string): void {
		const normalizedProjectId = projectId.trim();
		const normalizedNewPath = normalizePath(newFilePath);
		const normalizedAnchorPath = normalizePath(anchorPath);
		if (!normalizedProjectId || !normalizedNewPath || !normalizedAnchorPath) return;
		this.newFilePlacementHint = {
			projectId: normalizedProjectId,
			newPath: normalizedNewPath,
			anchorPath: normalizedAnchorPath,
			expiresAt: Date.now() + 120_000,
		};
	}

	// Legacy compatibility for existing keybindings in main.ts
	setActiveView(_view: string): void {
		// no-op
	}

	async openFolder(): Promise<void> {
		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const selected = await open({
				directory: true,
				multiple: false,
				title: t("sidebar.dialogs.openProjectFolder"),
			});
			if (!selected || typeof selected !== "string") return;

			const normalized = normalizePath(selected);
			const existing = this.projects.find((p) => normalizePath(p.path) === normalized);
			if (existing) {
				this.selectProject(existing.id, true);
				void this.refreshProjectPathStatus(existing.id);
				return;
			}

			const name = pathBaseName(selected);
			const project: Project = {
				id: crypto.randomUUID(),
				path: selected,
				name,
				color: stringToColor(name),
				emoji: normalizeProjectEmoji(null),
				expanded: true,
				sessions: [],
				loadingSessions: false,
				sessionsLoaded: false,
				lastSessionsLoadedAt: 0,
				pathExists: true,
				checkingPath: false,
			};

			this.projects.unshift(project);
			this.sortProjectsInPlace();
			this.persistProjects();
			this.selectProject(project.id, true);
			void this.refreshProjectPathStatus(project.id);
			await this.loadSessionsForProject(project.id);
			if (this.mode === "files") {
				await this.ensureFileTreeForProject(project.id, true);
			}
		} catch (err) {
			console.error("Failed to open folder:", err);
		}
	}

	/** Add a project without a dialog and without selecting it (pi session auto-import).
	 * Returns false when the path is empty or already in the list. Sessions stay lazy:
	 * they load through the normal per-project chain when the user expands/selects it. */
	async addProjectByPath(path: string): Promise<boolean> {
		const trimmed = path.trim();
		if (!trimmed) return false;
		const normalized = normalizePath(trimmed);
		if (this.projects.some((p) => normalizePath(p.path) === normalized)) return false;

		const name = pathBaseName(trimmed);
		const project: Project = {
			id: crypto.randomUUID(),
			path: trimmed,
			name,
			color: stringToColor(name),
			emoji: normalizeProjectEmoji(null),
			expanded: false,
			sessions: [],
			loadingSessions: false,
			sessionsLoaded: false,
			lastSessionsLoadedAt: 0,
			pathExists: true,
			checkingPath: false,
		};

		this.projects.unshift(project);
		this.sortProjectsInPlace();
		this.persistProjects();
		this.render();
		void this.refreshProjectPathStatus(project.id);
		return true;
	}

	private async createFileInActiveProject(): Promise<void> {
		const project = this.getActiveProject();
		if (!project) return;
		await this.createFileInDirectory(project.id, project.path);
	}

	private async createFileInDirectory(projectId: string, directoryPath: string): Promise<void> {
		const project = this.projects.find((entry) => entry.id === projectId) ?? null;
		if (!project) return;

		const input = (await promptDialog({ title: t("sidebar.file.newFilePrompt"), value: "new-file.txt" }))?.trim();
		if (!input) return;
		if (input.includes("/") || input.includes("\\")) {
			await alertDialog(t("sidebar.file.noFoldersInName"));
			return;
		}

		const targetDir = directoryPath || project.path;
		const filePath = joinFsPath(targetDir, input);
		try {
			const { exists, writeTextFile } = await import("@tauri-apps/plugin-fs");
			if (await exists(filePath)) {
				await alertDialog(t("sidebar.file.nameExists"));
				return;
			}

			await writeTextFile(filePath, "");
			await this.ensureFileTreeForProject(projectId, true);
			this.openFile(projectId, filePath);
		} catch (err) {
			console.error("Failed to create file:", err);
			await alertDialog(err instanceof Error ? err.message : String(err), { title: t("common.error") });
		}
	}

	private startFileRename(projectId: string, node: FileNode): void {
		if (node.isDirectory) return;
		this.sessionRenameDraft = null;
		this.fileRenameDraft = {
			projectId,
			filePath: normalizePath(node.path),
			value: node.name,
		};
		this.render();
	}

	private cancelFileRename(): void {
		if (!this.fileRenameDraft) return;
		this.fileRenameDraft = null;
		this.render();
	}

	private async commitFileRename(projectId: string, node: FileNode): Promise<void> {
		if (node.isDirectory) return;
		const draft = this.fileRenameDraft;
		if (!draft) return;
		if (draft.projectId !== projectId || draft.filePath !== normalizePath(node.path)) return;

		const currentName = node.name;
		const nextName = draft.value.trim();
		if (!nextName || nextName === currentName) {
			this.fileRenameDraft = null;
			this.render();
			return;
		}
		if (nextName.includes("/") || nextName.includes("\\")) {
			await alertDialog(t("sidebar.file.noFoldersInName"));
			return;
		}

		const parentPath = node.path.replace(/[\\/][^\\/]+$/, "");
		const nextPath = joinFsPath(parentPath, nextName);
		try {
			const { exists, rename } = await import("@tauri-apps/plugin-fs");
			if (await exists(nextPath)) {
				await alertDialog(t("sidebar.file.nameExists"));
				return;
			}
			await rename(node.path, nextPath);
			this.fileRenameDraft = null;
			if (this.activeFilePath === normalizePath(node.path)) {
				this.activeFilePath = normalizePath(nextPath);
			}
			await this.ensureFileTreeForProject(projectId, true);
			this.openFile(projectId, nextPath);
		} catch (err) {
			console.error("Failed to rename file:", err);
			await alertDialog(err instanceof Error ? err.message : String(err), { title: t("common.error") });
		}
	}

	private startSessionRename(project: Project, session: SidebarSession): void {
		this.fileRenameDraft = null;
		this.sessionRenameDraft = {
			projectId: project.id,
			sessionPath: normalizePath(session.path),
			value: session.name,
		};
		this.render();
	}

	private cancelSessionRename(): void {
		if (!this.sessionRenameDraft) return;
		this.sessionRenameDraft = null;
		this.render();
	}

	private commitSessionRename(project: Project, session: SidebarSession): void {
		const draft = this.sessionRenameDraft;
		if (!draft) return;
		if (draft.projectId !== project.id || draft.sessionPath !== normalizePath(session.path)) return;

		const currentName = session.name;
		const nextName = draft.value.trim();
		this.sessionRenameDraft = null;

		if (!nextName || nextName === currentName) {
			this.render();
			return;
		}

		session.name = nextName;
		this.render();
		this.onSessionRename?.(project.id, session.path, currentName, nextName);
	}

	private async deleteSession(project: Project, session: SidebarSession): Promise<void> {
		const normalizedSessionPath = normalizePath(session.path);
		if (this.deletingSessionPaths.has(normalizedSessionPath)) return;
		this.deletingSessionPaths.add(normalizedSessionPath);
		this.render();
		// 等待 runtime 停止期间挂出的常驻提示 id，用于结束后精准清除
		// （成功路径会被「已移到废纸篓」顶掉，id 不同所以不受影响）。
		let stoppingNoticeId: number | null = null;
		try {
			// 删文件之前先广播：main.ts 监听 SESSION_WILL_DELETE_EVENT 后走
			// 「关闭会话 tab」同一套 runtime 停止路径（removeRuntimeForTab），
			// 避免 pi 进程仍挂着 JSONL 写入时文件被移走。
			window.dispatchEvent(
				new CustomEvent(SESSION_WILL_DELETE_EVENT, {
					detail: { projectId: project.id, sessionPath: session.path },
				}),
			);
			// main.ts 注入的钩子会停止并等待附着该 session 的所有 runtime 退出
			// （含租约释放，内部有超时兜底）；钩子不存在时退化为仅靠上面的 dispatch。
			if (window.__piGuiPrepareSessionDelete) {
				stoppingNoticeId = ++this.sidebarNoticeSeq;
				this.sidebarNotice = { id: stoppingNoticeId, text: t("sidebar.session.stoppingRuntime") };
				this.render();
				try {
					await window.__piGuiPrepareSessionDelete(session.path);
				} catch (prepareErr) {
					console.error("Failed to stop session runtime before delete:", prepareErr);
					const proceed = await confirmDialog({
						title: t("sidebar.session.deleteTitle"),
						desc: t("sidebar.session.stopRuntimeFailed", { name: session.name }),
						confirmLabel: t("sidebar.session.moveToTrashAnyway"),
						danger: true,
					});
					if (!proceed) return;
				}
			}
			// 不物理删除：移入系统废纸篓，可从访达恢复。
			const { invoke } = await import("@tauri-apps/api/core");
			const { exists } = await import("@tauri-apps/plugin-fs");
			if (await exists(session.path)) {
				await invoke("move_path_to_trash", { path: session.path, projectPath: project.path });
			}
			project.sessions = project.sessions.filter((entry) => normalizePath(entry.path) !== normalizePath(session.path));
			this.clearSessionPin(session.path);
			if (this.activeSessionPath === normalizePath(session.path)) {
				this.activeSessionPath = null;
			}
			this.sessionRenameDraft = null;
			this.onSessionDelete?.(project.id, session.path);
			this.render();
			this.showSidebarNotice(t("sidebar.session.movedToTrash"));
		} catch (err) {
			console.error("Failed to delete session:", err);
			await alertDialog(err instanceof Error ? err.message : String(err), { title: t("common.error") });
		} finally {
			this.deletingSessionPaths.delete(normalizedSessionPath);
			if (stoppingNoticeId !== null && this.sidebarNotice?.id === stoppingNoticeId) {
				this.sidebarNotice = null;
			}
			this.render();
		}
	}

	/** 删除会话等操作的轻量提示：展示 4s 后自动消失（重复触发只留最新一条）。 */
	private showSidebarNotice(text: string): void {
		const id = ++this.sidebarNoticeSeq;
		this.sidebarNotice = { id, text };
		this.render();
		setTimeout(() => {
			if (this.sidebarNotice?.id !== id) return;
			this.sidebarNotice = null;
			this.render();
		}, 4000);
	}

	private renderSidebarNotice(): TemplateResult | typeof nothing {
		if (!this.sidebarNotice) return nothing;
		return html`<div class="sidebar-notice" role="status">${this.sidebarNotice.text}</div>`;
	}

	private async confirmDeleteSession(project: Project, session: SidebarSession): Promise<void> {
		const confirmed = await confirmDialog({
			title: t("sidebar.session.deleteTitle"),
			desc: t("sidebar.session.deleteConfirm", { name: session.name }),
			confirmLabel: t("common.delete"),
			danger: true,
		});
		if (!confirmed) return;
		void this.deleteSession(project, session);
	}

	private removeFileNodeFromTree(projectId: string, filePath: string): void {
		const normalized = normalizePath(filePath);
		if (!normalized) return;
		const nodes = this.fileTrees.get(projectId);
		if (!nodes) return;

		const prune = (list: FileNode[]): FileNode[] =>
			list
				.filter((entry) => normalizePath(entry.path) !== normalized)
				.map((entry) => {
					if (entry.children?.length) {
						entry.children = prune(entry.children);
					}
					return entry;
				});

		this.fileTrees.set(projectId, prune(nodes));
	}

	private async deleteFileNode(projectId: string, node: FileNode): Promise<void> {
		if (node.isDirectory) return;

		try {
			const { remove } = await import("@tauri-apps/plugin-fs");
			await remove(node.path);
			if (this.activeFilePath === normalizePath(node.path)) {
				this.activeFilePath = null;
			}
			this.fileRenameDraft = null;
			this.removeFileNodeFromTree(projectId, node.path);
			this.onFileDelete?.(projectId, node.path);
			this.render();
		} catch (err) {
			console.error("Failed to delete file:", err);
			await alertDialog(err instanceof Error ? err.message : String(err), { title: t("common.error") });
		}
	}

	private handleSessionContextMenu(e: MouseEvent, project: Project, session: SidebarSession): void {
		this.selectProject(project.id, false);
		this.activeSessionPath = normalizePath(session.path);
		this.activeFilePath = null;
		this.clearInlineDrafts();
		this.openContextMenu(e, { kind: "session", projectId: project.id, sessionPath: session.path });
	}

	private handleFileContextMenu(e: MouseEvent, projectId: string, node: FileNode): void {
		this.selectProject(projectId, false);
		this.activeSessionPath = null;
		this.activeFilePath = node.isDirectory ? null : normalizePath(node.path);
		this.clearInlineDrafts();
		this.openContextMenu(e, { kind: "file", projectId, filePath: node.path, isDirectory: node.isDirectory });
	}

	private handleWorkspaceContextMenu(e: MouseEvent, workspaceId: string): void {
		this.openContextMenu(e, { kind: "workspace", workspaceId });
	}

	private runSessionContextAction(action: "rename" | "delete" | "fork" | "markUnread" | "togglePin"): void {
		const target = this.contextMenu?.target;
		if (!target || target.kind !== "session") return;
		this.closeContextMenu();
		const found = this.findSession(target.projectId, target.sessionPath);
		if (!found) {
			this.render();
			return;
		}
		if (action === "rename") {
			this.startSessionRename(found.project, found.session);
			return;
		}
		if (action === "fork") {
			this.onSessionFork?.(found.project.id, found.session.path, found.session.name);
			return;
		}
		if (action === "markUnread") {
			this.onSessionMarkUnread?.(found.project.id, found.session.path, found.session.name);
			return;
		}
		if (action === "togglePin") {
			this.toggleSessionPinned(found.session.path);
			this.render();
			return;
		}
		void this.deleteSession(found.project, found.session);
	}

	private runFileContextAction(action: "newFile" | "rename" | "delete"): void {
		const target = this.contextMenu?.target;
		if (!target || target.kind !== "file") return;
		this.closeContextMenu();
		if (action === "newFile") {
			const project = this.projects.find((entry) => entry.id === target.projectId) ?? null;
			if (!project) {
				this.render();
				return;
			}
			const baseDir = target.isDirectory ? target.filePath : parentFsPath(target.filePath);
			this.onNewFileInProject?.({
				id: project.id,
				name: project.name,
				path: project.path,
				directoryPath: baseDir,
				anchorPath: target.isDirectory ? null : target.filePath,
			});
			return;
		}
		const node = this.findFileNode(target.projectId, target.filePath);
		if (!node) {
			this.render();
			return;
		}
		if (action === "rename") {
			this.startFileRename(target.projectId, node);
			return;
		}
		void this.deleteFileNode(target.projectId, node);
	}

	private runWorkspaceContextAction(action: "rename" | "delete"): void {
		const target = this.contextMenu?.target;
		if (!target || target.kind !== "workspace") return;
		this.closeContextMenu();
		const workspace = this.workspaces.find((entry) => entry.id === target.workspaceId) ?? null;
		if (!workspace) {
			this.render();
			return;
		}

		if (action === "rename") {
			this.startWorkspaceRename(workspace.id);
			return;
		}

		if (this.workspaces.length <= 1) {
			this.render();
			return;
		}

		this.onWorkspaceDelete?.(workspace.id);
	}

	private renderContextMenu(): TemplateResult | typeof nothing {
		const menu = this.contextMenu;
		if (!menu) return nothing;

		const target = menu.target;
		let menuContent: TemplateResult;
		if (target.kind === "session") {
			const canPinSession = normalizePath(target.sessionPath).length > 0;
			const pinned = canPinSession && this.isSessionPinned(target.sessionPath);
			menuContent = html`
				<div class="sidebar-context-menu" style=${`left:${menu.x}px;top:${menu.y}px`} @click=${(e: Event) => e.stopPropagation()}>
					<button @click=${() => this.runSessionContextAction("fork")}>${t("sidebar.session.fork")}</button>
					<button @click=${() => this.runSessionContextAction("markUnread")}>${t("sidebar.session.markUnread")}</button>
					<button ?disabled=${!canPinSession} @click=${() => this.runSessionContextAction("togglePin")}>${pinned ? t("sidebar.session.unpin") : t("sidebar.session.pin")}</button>
					<div class="sidebar-context-menu-divider"></div>
					<button @click=${() => this.runSessionContextAction("rename")}>${t("sidebar.session.rename")}</button>
					<button class="danger" @click=${() => this.runSessionContextAction("delete")}>${t("sidebar.session.delete")}</button>
				</div>
			`;
		} else if (target.kind === "file") {
			const node = this.findFileNode(target.projectId, target.filePath);
			const isDirectory = node?.isDirectory ?? target.isDirectory;
			menuContent = html`
				<div class="sidebar-context-menu" style=${`left:${menu.x}px;top:${menu.y}px`} @click=${(e: Event) => e.stopPropagation()}>
					<button @click=${() => this.runFileContextAction("newFile")}>${t("sidebar.file.new")}</button>
					${isDirectory
						? nothing
						: html`
							<div class="sidebar-context-menu-divider"></div>
							<button @click=${() => this.runFileContextAction("rename")}>${t("sidebar.file.rename")}</button>
							<button class="danger" @click=${() => this.runFileContextAction("delete")}>${t("sidebar.file.delete")}</button>
						`}
				</div>
			`;
		} else {
			const canDeleteWorkspace = this.workspaces.length > 1;
			menuContent = html`
				<div class="sidebar-context-menu" style=${`left:${menu.x}px;top:${menu.y}px`} @click=${(e: Event) => e.stopPropagation()}>
					<button
						@click=${(e: MouseEvent) => {
							const target = this.contextMenu?.target;
							if (target?.kind === "workspace") {
								const workspaceId = target.workspaceId;
								this.closeContextMenu();
								this.openWorkspaceEmojiPicker(workspaceId, e);
							}
						}}
					>
						${t("sidebar.workspace.changeEmoji")}
					</button>
					<button @click=${() => this.runWorkspaceContextAction("rename")}>${t("sidebar.workspace.rename")}</button>
					<button
						class="danger"
						?disabled=${!canDeleteWorkspace}
						title=${canDeleteWorkspace ? t("sidebar.workspace.delete") : t("sidebar.workspace.deleteRequired")}
						@click=${() => this.runWorkspaceContextAction("delete")}
					>
						${t("sidebar.workspace.delete")}
					</button>
				</div>
			`;
		}

		return html`
			<div class="sidebar-context-menu-backdrop" @click=${() => this.closeContextMenu()}></div>
			${menuContent}
		`;
	}

	private async triggerPrimaryTopAction(): Promise<void> {
		if (this.mode === "files") {
			this.triggerNewFileForActiveProject();
			return;
		}
		this.triggerNewSessionForActiveProject();
	}

	private async handleModeCreateAction(): Promise<void> {
		await this.openFolder();
	}

	private toggleModeFilterMenu(): void {
		this.modeFilterMenuOpen = !this.modeFilterMenuOpen;
		this.render();
	}

	private handleProjectMainClick(projectId: string): void {
		const wasActive = this.activeProjectId === projectId;
		this.selectProject(projectId, true);
		if (wasActive) {
			this.toggleProject(projectId);
		}
	}

	private renderModeFilterMenu(): TemplateResult | typeof nothing {
		if (!this.modeFilterMenuOpen) return nothing;

		if (this.mode === "projects") {
			return html`
				<div class="sidebar-mode-filter-menu sidebar-mode-filter-menu--sessions" @click=${(e: Event) => e.stopPropagation()}>
					<div class="sidebar-mode-filter-section">
						<div class="sidebar-mode-filter-label">${t("sidebar.filter.organize")}</div>
						<button class=${this.sessionOrganize === "byProject" ? "active" : ""} @click=${() => {
							this.sessionOrganize = "byProject";
							this.modeFilterMenuOpen = false;
							this.render();
						}}>
							<span>${t("sidebar.filter.byProject")}</span>
							${this.sessionOrganize === "byProject" ? html`<span class="sidebar-mode-filter-check">✓</span>` : nothing}
						</button>
						<button class=${this.sessionOrganize === "chronological" ? "active" : ""} @click=${() => {
							this.sessionOrganize = "chronological";
							this.modeFilterMenuOpen = false;
							this.render();
						}}>
							<span>${t("sidebar.filter.chronological")}</span>
							${this.sessionOrganize === "chronological" ? html`<span class="sidebar-mode-filter-check">✓</span>` : nothing}
						</button>
					</div>
					<div class="sidebar-mode-filter-section">
						<div class="sidebar-mode-filter-label">${t("sidebar.filter.sortBy")}</div>
						<button class=${this.sessionSortBy === "created" ? "active" : ""} @click=${() => {
							this.sessionSortBy = "created";
							this.modeFilterMenuOpen = false;
							this.render();
						}}>
							<span>${t("sidebar.filter.created")}</span>
							${this.sessionSortBy === "created" ? html`<span class="sidebar-mode-filter-check">✓</span>` : nothing}
						</button>
						<button class=${this.sessionSortBy === "updated" ? "active" : ""} @click=${() => {
							this.sessionSortBy = "updated";
							this.modeFilterMenuOpen = false;
							this.render();
						}}>
							<span>${t("sidebar.filter.updated")}</span>
							${this.sessionSortBy === "updated" ? html`<span class="sidebar-mode-filter-check">✓</span>` : nothing}
						</button>
					</div>
					<div class="sidebar-mode-filter-section">
						<div class="sidebar-mode-filter-label">${t("sidebar.filter.show")}</div>
						<button class=${this.sessionShow === "all" ? "active" : ""} @click=${() => {
							this.sessionShow = "all";
							this.modeFilterMenuOpen = false;
							this.render();
						}}>
							<span>${t("sidebar.filter.allThreads")}</span>
							${this.sessionShow === "all" ? html`<span class="sidebar-mode-filter-check">✓</span>` : nothing}
						</button>
						<button class=${this.sessionShow === "relevant" ? "active" : ""} @click=${() => {
							this.sessionShow = "relevant";
							this.modeFilterMenuOpen = false;
							this.render();
						}}>
							<span>${t("sidebar.filter.relevant")}</span>
							${this.sessionShow === "relevant" ? html`<span class="sidebar-mode-filter-check">✓</span>` : nothing}
						</button>
					</div>
				</div>
			`;
		}

		return html`
			<div class="sidebar-mode-filter-menu" @click=${(e: Event) => e.stopPropagation()}>
				<div class="sidebar-mode-filter-section">
					<div class="sidebar-mode-filter-label">${t("sidebar.filter.sortFiles")}</div>
					<button class=${this.fileSort === "nameAsc" ? "active" : ""} @click=${() => {
						this.fileSort = "nameAsc";
						this.modeFilterMenuOpen = false;
						this.render();
					}}>${t("sidebar.filter.nameAsc")}</button>
					<button class=${this.fileSort === "nameDesc" ? "active" : ""} @click=${() => {
						this.fileSort = "nameDesc";
						this.modeFilterMenuOpen = false;
						this.render();
					}}>${t("sidebar.filter.nameDesc")}</button>
				</div>
				<div class="sidebar-mode-filter-section">
					<div class="sidebar-mode-filter-label">${t("sidebar.filter.show")}</div>
					<button class=${this.fileKind === "all" ? "active" : ""} @click=${() => {
						this.fileKind = "all";
						this.modeFilterMenuOpen = false;
						this.render();
					}}>${t("sidebar.filter.all")}</button>
					<button class=${this.fileKind === "files" ? "active" : ""} @click=${() => {
						this.fileKind = "files";
						this.modeFilterMenuOpen = false;
						this.render();
					}}>${t("sidebar.filter.files")}</button>
					<button class=${this.fileKind === "dirs" ? "active" : ""} @click=${() => {
						this.fileKind = "dirs";
						this.modeFilterMenuOpen = false;
						this.render();
					}}>${t("sidebar.filter.folders")}</button>
				</div>
			</div>
		`;
	}

	private isWorkspaceHydrationCurrent(hydrationToken?: number): boolean {
		return typeof hydrationToken !== "number" || hydrationToken === this.workspaceHydrationToken;
	}

	private async hydrateProjects(hydrationToken = this.workspaceHydrationToken): Promise<void> {
		if (!this.isWorkspaceHydrationCurrent(hydrationToken)) return;
		await Promise.all(this.projects.map((project) => this.refreshProjectPathStatus(project.id, hydrationToken)));
		if (!this.isWorkspaceHydrationCurrent(hydrationToken)) return;
		if (this.activeProjectId) {
			void this.loadSessionsForProject(this.activeProjectId, { hydrationToken });
		}
		if (this.mode === "files" && this.isWorkspaceHydrationCurrent(hydrationToken)) {
			void this.ensureFileTreeForActiveProject();
		}
	}

	private selectProject(projectId: string, emitSelect = true): void {
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) return;
		const changed = this.activeProjectId !== projectId;
		this.activeProjectId = projectId;
		if (changed) {
			this.activeSessionPath = null;
			this.activeFilePath = null;
			this.clearInlineDrafts();
			this.closeContextMenu(false);
		}

		if (this.mode === "files") {
			void this.ensureFileTreeForProject(project.id);
		}
		if (!project.sessionsLoaded && !project.loadingSessions) {
			void this.loadSessionsForProject(project.id);
		}

		this.render();

		if ((changed || emitSelect) && emitSelect) {
			this.onProjectSelect?.({ id: project.id, name: project.name, path: project.path });
		}
	}

	private toggleProject(projectId: string): void {
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) return;
		project.expanded = !project.expanded;
		if (project.expanded && this.mode === "projects" && !project.sessionsLoaded && !project.loadingSessions) {
			void this.loadSessionsForProject(project.id);
		}
		if (project.expanded && this.mode === "files") {
			void this.ensureFileTreeForProject(project.id);
		}
		this.render();
	}

	private async refreshProjectPathStatus(projectId: string, hydrationToken?: number): Promise<void> {
		if (!this.isWorkspaceHydrationCurrent(hydrationToken)) return;
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) return;
		project.checkingPath = true;
		this.render();

		try {
			const { exists } = await import("@tauri-apps/plugin-fs");
			const pathExists = await exists(project.path);
			if (!this.isWorkspaceHydrationCurrent(hydrationToken) || !this.projects.includes(project)) {
				return;
			}
			project.pathExists = pathExists;
		} catch (err) {
			if (!this.isWorkspaceHydrationCurrent(hydrationToken) || !this.projects.includes(project)) {
				return;
			}
			console.warn("Failed to verify project path:", err);
			project.pathExists = null;
		} finally {
			if (!this.isWorkspaceHydrationCurrent(hydrationToken) || !this.projects.includes(project)) {
				return;
			}
			project.checkingPath = false;
			this.render();
		}
	}

	private async relinkProject(projectId: string): Promise<void> {
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) return;

		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const selected = await open({
				directory: true,
				multiple: false,
				title: t("sidebar.dialogs.relinkProject", { name: project.name }),
			});
			if (!selected || typeof selected !== "string") return;

			const normalized = normalizePath(selected);
			const duplicate = this.projects.find((p) => p.id !== projectId && normalizePath(p.path) === normalized);
			if (duplicate) {
				this.selectProject(duplicate.id, true);
				return;
			}

			project.path = selected;
			project.name = pathBaseName(selected);
			this.sortProjectsInPlace();
			project.pathExists = true;
			project.sessions = [];
			project.sessionsLoaded = false;
			project.lastSessionsLoadedAt = 0;
			this.fileTrees.delete(project.id);
			this.sortProjectsInPlace();
			this.fileTreeErrors.delete(project.id);
			this.persistProjects();
			this.render();
			this.selectProject(project.id, true);
			await this.loadSessionsForProject(project.id);
			if (this.mode === "files") {
				await this.ensureFileTreeForProject(project.id, true);
			}
		} catch (err) {
			console.error("Failed to relink project:", err);
		}
	}

	private async loadSessionsForProject(projectId: string, options?: { silent?: boolean; hydrationToken?: number }): Promise<void> {
		const hydrationToken = options?.hydrationToken;
		if (!this.isWorkspaceHydrationCurrent(hydrationToken)) return;

		const existingLoad = this.sessionLoadsInFlight.get(projectId);
		if (existingLoad) {
			this.sessionReloadQueued.add(projectId);
			return existingLoad;
		}

		const run = (async () => {
			if (!this.isWorkspaceHydrationCurrent(hydrationToken)) return;
			const project = this.projects.find((p) => p.id === projectId);
			if (!project) return;
			const isStale = () => !this.isWorkspaceHydrationCurrent(hydrationToken) || !this.projects.includes(project);
			const silent = options?.silent === true;
			const now = Date.now();
			if (silent && project.sessionsLoaded && now - project.lastSessionsLoadedAt < 2200) {
				return;
			}
			const loadingBefore = project.loadingSessions;
			if (!silent) {
				project.loadingSessions = true;
				if (!isStale()) {
					this.render();
				}
			}

			const hadLoadedSessions = project.sessionsLoaded;
			try {
				// 静默刷新由数据变更驱动，必须拿到最新盘态（绕过共享缓存并重建）。
				const sessions = await scanAllSessions({ bypassCache: silent });
				if (isStale()) return;

				// Session ownership is defined only by the exact cwd persisted in
				// the session header. Path/name containment makes a parent project
				// (for example Desktop) absorb every nested project's sessions.
				const byProject = sessions.filter((session) =>
					sessionBelongsToProject(session.cwd, project.path)
				);

				const visibleProjectSessions = byProject.filter((session) => !this.suppressedSessionPaths.has(normalizePath(session.path)));
				const scannedSessions = visibleProjectSessions.slice(0, 40).map((s) => ({
					id: s.id,
					// 显示优先级：显式 name > 首条用户消息派生的 preview > 未命名会话
					// sanitizeSessionLabel 剥掉残留的 XML/skill 标签垃圾串，剥空则回退未命名
					name: sanitizeSessionLabel(s.name) || sanitizeSessionLabel(s.preview) || t("sidebar.session.untitled"),
					path: s.path,
					createdAt: s.created_at ?? s.modified_at,
					modifiedAt: s.modified_at,
					tokens: s.tokens ?? 0,
					cost: s.cost ?? 0,
					optimistic: false,
					parentSessionPath: s.parent_session ?? null,
				} satisfies SidebarSession));

				const scannedByPath = new Map<string, SidebarSession>(
					scannedSessions.map((entry) => [normalizePath(entry.path), entry] as const),
				);
				const preserveUntil = Date.now() - 120_000;
				const preservedOptimistic = project.sessions.filter((entry) => {
					if (!entry.optimistic || entry.transient) return false;
					const normalizedPath = normalizePath(entry.path);
					if (!normalizedPath || scannedByPath.has(normalizedPath)) return false;
					if (normalizedPath === this.activeSessionPath) return true;
					return (entry.modifiedAt || entry.createdAt || 0) >= preserveUntil;
				});

				for (const entry of preservedOptimistic) {
					scannedByPath.set(normalizePath(entry.path), entry);
				}

				if (isStale()) return;
				project.sessions = [...scannedByPath.values()];
				project.sessionsLoaded = true;
				project.lastSessionsLoadedAt = Date.now();
			} catch (err) {
				if (isStale()) return;
				console.error("Failed to load sessions:", err);
				if (!silent) {
					project.sessions = [];
				}
				if (!hadLoadedSessions) {
					project.sessionsLoaded = false;
					project.lastSessionsLoadedAt = 0;
				}
			} finally {
				if (isStale()) return;
				project.loadingSessions = silent ? loadingBefore : false;
				this.render();
			}
		})();

		this.sessionLoadsInFlight.set(projectId, run);
		try {
			await run;
		} finally {
			this.sessionLoadsInFlight.delete(projectId);
			if (this.sessionReloadQueued.has(projectId) && this.isWorkspaceHydrationCurrent(hydrationToken)) {
				this.sessionReloadQueued.delete(projectId);
				queueMicrotask(() => {
					if (!this.isWorkspaceHydrationCurrent(hydrationToken)) return;
					void this.loadSessionsForProject(projectId, { silent: true, hydrationToken });
				});
			} else {
				this.sessionReloadQueued.delete(projectId);
			}
		}
	}

	private async ensureFileTreeForActiveProject(): Promise<void> {
		const active = this.getActiveProject();
		if (!active) return;
		await this.ensureFileTreeForProject(active.id);
	}

	private async resolveGitDirPointer(pointerPath: string, parentReadPath: string): Promise<string | null> {
		try {
			const [{ readTextFile, exists, stat }, { resolve }] = await Promise.all([
				import("@tauri-apps/plugin-fs"),
				import("@tauri-apps/api/path"),
			]);
			const content = await readTextFile(pointerPath);
			const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
			const match = /^gitdir:\s*(.+)$/i.exec(firstLine);
			if (!match) return null;
			const rawTarget = match[1].trim();
			const targetPath = isAbsolutePath(rawTarget) ? rawTarget : await resolve(parentReadPath, rawTarget);
			const targetExists = await exists(targetPath);
			if (!targetExists) return null;
			const info = await stat(targetPath);
			return info.isDirectory ? targetPath : null;
		} catch {
			return null;
		}
	}

	private async mapDirectoryEntries(readBasePath: string, displayBasePath: string, depth: number): Promise<FileNode[]> {
		const { readDir, stat } = await import("@tauri-apps/plugin-fs");
		const entries = await readDir(readBasePath);

		const nodes = await Promise.all(
			entries.map(async (entry) => {
				const actualPath = joinFsPath(readBasePath, entry.name);
				const displayPath = joinFsPath(displayBasePath, entry.name);

				let isDirectory = entry.isDirectory;
				if (!isDirectory && entry.isSymlink) {
					try {
						const info = await stat(actualPath);
						isDirectory = info.isDirectory;
					} catch {
						// ignore symlink stat issues
					}
				}

				let resolvedPath = actualPath;
				if (!isDirectory && entry.name === ".git" && entry.isFile) {
					const gitTarget = await this.resolveGitDirPointer(actualPath, readBasePath);
					if (gitTarget) {
						resolvedPath = gitTarget;
						isDirectory = true;
					}
				}

				return {
					id: uid("file"),
					name: entry.name,
					path: resolvedPath,
					displayPath,
					isDirectory,
					isSymlink: Boolean(entry.isSymlink),
					expanded: false,
					loading: false,
					loadError: false,
					depth,
				} satisfies FileNode;
			}),
		);

		return nodes.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	private async ensureFileTreeForProject(projectId: string, forceReload = false): Promise<void> {
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) return;
		if (!forceReload && this.fileTrees.has(projectId)) return;
		if (this.loadingFileTreeForProject.has(projectId)) return;

		this.loadingFileTreeForProject.add(projectId);
		this.render();

		try {
			const nodes = await this.mapDirectoryEntries(project.path, project.path, 0);
			this.fileTrees.set(projectId, nodes);
			this.fileTreeErrors.delete(projectId);
		} catch (err) {
			console.error("Failed to load file tree:", err);
			this.fileTrees.set(projectId, []);
			this.fileTreeErrors.set(projectId, err instanceof Error ? err.message : String(err));
		} finally {
			this.loadingFileTreeForProject.delete(projectId);
			this.render();
		}
	}

	private async toggleDirectory(projectId: string, node: FileNode): Promise<void> {
		if (!node.isDirectory) return;
		node.expanded = !node.expanded;
		this.render();

		if (!node.expanded) return;
		if (node.children) return;
		node.loading = true;
		node.loadError = false;
		this.render();

		try {
			node.children = await this.mapDirectoryEntries(node.path, node.displayPath, node.depth + 1);
			node.loadError = false;
		} catch (err) {
			console.error("Failed to load folder contents:", err);
			node.children = [];
			node.loadError = true;
		} finally {
			node.loading = false;
			this.render();
		}
	}

	private openFile(projectId: string, filePath: string): void {
		this.onFileOpen?.(projectId, filePath);
	}

	private toggleProjectMenu(projectId: string): void {
		this.closeContextMenu(false);
		this.openProjectMenuId = this.openProjectMenuId === projectId ? null : projectId;
		this.render();
	}

	private setProjectColor(projectId: string, color: string | null): void {
		const project = this.projects.find((entry) => entry.id === projectId);
		if (!project) return;
		project.color = color ?? stringToColor(project.name);
		this.openProjectMenuId = null;
		this.persistProjects();
		this.render();
	}

	private async renameProject(projectId: string): Promise<void> {
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) return;
		const nextName = (await promptDialog({ title: t("sidebar.dialogs.renameProject"), value: project.name }))?.trim();
		if (!nextName || nextName === project.name) {
			this.openProjectMenuId = null;
			this.render();
			return;
		}

		project.name = nextName;
		this.persistProjects();
		this.openProjectMenuId = null;
		this.render();

		if (this.activeProjectId === project.id) {
			this.onProjectSelect?.({ id: project.id, name: project.name, path: project.path });
		}
	}

	private removeProject(projectId: string): void {
		const removed = this.projects.find((p) => p.id === projectId) ?? null;
		this.projects = this.projects.filter((p) => p.id !== projectId);
		this.fileTrees.delete(projectId);
		this.fileTreeErrors.delete(projectId);
		this.openProjectMenuId = this.openProjectMenuId === projectId ? null : this.openProjectMenuId;

		if (this.activeProjectId === projectId) {
			this.activeProjectId = this.projects[0]?.id ?? null;
			const next = this.projects[0];
			if (next) {
				this.onProjectSelect?.({ id: next.id, name: next.name, path: next.path });
			} else {
				this.onProjectSelect?.(null);
			}
		}
		this.persistProjects();
		this.render();
		if (removed) {
			this.onProjectRemoved?.({ id: removed.id, name: removed.name, path: removed.path });
		}
	}

	private triggerNewSessionForActiveProject(): void {
		const project = this.getActiveProject();
		if (!project) return;
		this.onNewSessionInProject?.(project);
		setTimeout(() => {
			void this.loadSessionsForProject(project.id, { silent: true });
		}, 900);
	}

	private triggerNewFileForActiveProject(): void {
		const project = this.getActiveProject();
		if (!project) return;
		this.onNewFileInProject?.(project);
	}

	private persistProjects(): void {
		const data: PersistedProject[] = this.projects.map((p) => ({
			id: p.id,
			path: p.path,
			name: p.name,
			color: p.color,
			emoji: normalizeProjectEmoji(p.emoji),
		}));
		localStorage.setItem(this.storageKey, JSON.stringify(data));
	}

	private sessionPinsStorageKey(): string {
		return `${this.storageKey}${SESSION_PINS_STORAGE_KEY_SUFFIX}`;
	}

	private loadPinnedSessions(): void {
		try {
			const raw = localStorage.getItem(this.sessionPinsStorageKey());
			if (!raw) {
				this.pinnedSessionPaths.clear();
				return;
			}
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				this.pinnedSessionPaths.clear();
				return;
			}
			const next = parsed
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => normalizePath(entry))
				.filter((entry) => entry.length > 0);
			this.pinnedSessionPaths = new Set(next);
		} catch {
			this.pinnedSessionPaths.clear();
		}
	}

	private persistPinnedSessions(): void {
		try {
			if (this.pinnedSessionPaths.size === 0) {
				localStorage.removeItem(this.sessionPinsStorageKey());
				return;
			}
			localStorage.setItem(this.sessionPinsStorageKey(), JSON.stringify([...this.pinnedSessionPaths]));
		} catch {
			// ignore
		}
	}

	private isSessionPinned(sessionPath: string): boolean {
		const normalized = normalizePath(sessionPath);
		if (!normalized) return false;
		return this.pinnedSessionPaths.has(normalized);
	}

	private toggleSessionPinned(sessionPath: string): boolean {
		const normalized = normalizePath(sessionPath);
		if (!normalized) return false;
		const nextPinned = !this.pinnedSessionPaths.has(normalized);
		if (nextPinned) {
			this.pinnedSessionPaths.add(normalized);
		} else {
			this.pinnedSessionPaths.delete(normalized);
		}
		this.persistPinnedSessions();
		return nextPinned;
	}

	private clearSessionPin(sessionPath: string): void {
		const normalized = normalizePath(sessionPath);
		if (!normalized) return;
		if (!this.pinnedSessionPaths.delete(normalized)) return;
		this.persistPinnedSessions();
	}

	/** Sessions load lazily per project; pinned rows live in a cross-project section,
	 * so kick a one-shot silent load for projects that likely own an unresolved pin. */
	private ensurePinnedSessionsHydrated(): void {
		if (this.pinnedSessionPaths.size === 0) return;
		for (const pinnedPath of this.pinnedSessionPaths) {
			const resolved = this.projects.some((project) =>
				project.sessions.some((session) => normalizePath(session.path) === pinnedPath),
			);
			if (resolved) continue;
			const owner = this.projects.find((project) => {
				const projectPath = normalizePath(project.path);
				if (projectPath && pinnedPath.includes(projectPath)) return true;
				const projectName = normalizePath(project.name);
				return Boolean(projectName) && pinnedPath.includes(projectName);
			});
			if (!owner || owner.sessionsLoaded || owner.loadingSessions) continue;
			if (this.pinnedHydrationAttempted.has(owner.id)) continue;
			this.pinnedHydrationAttempted.add(owner.id);
			void this.loadSessionsForProject(owner.id, { silent: true });
		}
	}

	private collectPinnedSessions(projects: Project[]): Array<{ project: Project; session: SidebarSession }> {
		const q = this.query.trim().toLowerCase();
		const out: Array<{ project: Project; session: SidebarSession }> = [];
		for (const project of projects) {
			for (const session of project.sessions) {
				const normalized = normalizePath(session.path);
				if (!normalized || !this.pinnedSessionPaths.has(normalized)) continue;
				if (this.suppressedSessionPaths.has(normalized)) continue;
				if (q && !`${session.name} ${session.path} ${project.name}`.toLowerCase().includes(q)) continue;
				out.push({ project, session });
			}
		}
		out.sort((a, b) => {
			const aTs = this.sessionSortBy === "created"
				? a.session.createdAt || a.session.modifiedAt
				: a.session.modifiedAt || a.session.createdAt;
			const bTs = this.sessionSortBy === "created"
				? b.session.createdAt || b.session.modifiedAt
				: b.session.modifiedAt || b.session.createdAt;
			return bTs - aTs || a.session.name.localeCompare(b.session.name);
		});
		return out;
	}

	private loadPersistedProjects(): void {
		try {
			let raw = localStorage.getItem(this.storageKey);

			// one-time migration path for first/default workspace
			if (!raw && this.storageKey === workspaceStorageKey("workspace_default")) {
				raw = localStorage.getItem(LEGACY_STORAGE_KEY);
				if (raw) {
					localStorage.setItem(this.storageKey, raw);
				}
			}

			if (!raw) {
				this.projects = [];
				this.activeProjectId = null;
				this.activeSessionPath = null;
				return;
			}

			const data = JSON.parse(raw) as PersistedProject[];
			const seenPaths = new Set<string>();
			this.projects = data
				.filter((p) => typeof p.path === "string" && p.path.trim().length > 0)
				.filter((p) => {
					const key = normalizePath(p.path);
					if (!key || seenPaths.has(key)) return false;
					seenPaths.add(key);
					return true;
				})
				.map((p, idx) => ({
					id: p.id,
					path: p.path,
					name: p.name,
					color: typeof p.color === "string" && p.color.trim().length > 0 ? p.color : stringToColor(p.name || pathBaseName(p.path)),
					emoji: normalizeProjectEmoji(p.emoji),
					expanded: idx === 0,
					sessions: [],
					loadingSessions: false,
					sessionsLoaded: false,
					lastSessionsLoadedAt: 0,
					pathExists: null,
					checkingPath: false,
				}));
			this.sortProjectsInPlace();
			this.activeProjectId = this.projects[0]?.id ?? null;
		} catch {
			this.projects = [];
			this.activeProjectId = null;
			this.activeSessionPath = null;
		}
	}

	private sortProjectsInPlace(): void {
		// Keep explicit drag order; no project pin groups.
	}

	private filteredProjects(includeQuery = true): Project[] {
		const q = this.query.trim().toLowerCase();
		let list = this.projects;

		if (includeQuery && q) {
			list = list.filter((project) => {
				if (`${project.name} ${project.path}`.toLowerCase().includes(q)) return true;
				return project.sessions.some((session) => `${session.name} ${session.path}`.toLowerCase().includes(q));
			});
		}

		return [...list];
	}

	private sortedSessions(sessions: SidebarSession[]): SidebarSession[] {
		const sorted = [...sessions];
		sorted.sort((a, b) => {
			const pinDelta = Number(this.isSessionPinned(b.path)) - Number(this.isSessionPinned(a.path));
			if (pinDelta !== 0) return pinDelta;
			const aTs = this.sessionSortBy === "created" ? a.createdAt || a.modifiedAt : a.modifiedAt || a.createdAt;
			const bTs = this.sessionSortBy === "created" ? b.createdAt || b.modifiedAt : b.modifiedAt || b.createdAt;
			return bTs - aTs || a.name.localeCompare(b.name);
		});
		return sorted;
	}

	/**
	 * fork 嵌套重排：把分支会话（parentSessionPath 指向列表内某会话）移动到
	 * 父会话紧后面，多级 fork 递归展开。父不在列表内（被筛选/置顶分离等）时
	 * 子项保留在原排序位置，渲染层按「父是否已渲染」降级为普通行。
	 */
	private nestForkSessions<T>(items: T[], getSession: (item: T) => SidebarSession): T[] {
		const keyOf = (session: SidebarSession): string => normalizePath(session.path);
		const byPath = new Map<string, T>();
		for (const item of items) {
			const key = keyOf(getSession(item));
			if (key) byPath.set(key, item);
		}
		const childrenByParent = new Map<string, T[]>();
		const roots: T[] = [];
		for (const item of items) {
			const session = getSession(item);
			const parentKey = session.parentSessionPath ? normalizePath(session.parentSessionPath) : "";
			if (parentKey && parentKey !== keyOf(session) && byPath.has(parentKey)) {
				const siblings = childrenByParent.get(parentKey) ?? [];
				siblings.push(item);
				childrenByParent.set(parentKey, siblings);
			} else {
				roots.push(item);
			}
		}
		const out: T[] = [];
		const emit = (item: T): void => {
			out.push(item);
			const key = keyOf(getSession(item));
			const children = childrenByParent.get(key);
			if (!children) return;
			childrenByParent.delete(key);
			for (const child of children) emit(child);
		};
		for (const root of roots) emit(root);
		// 防御环状 parent 链导致的残留（emit 时已 delete，不会死循环）。
		for (const children of [...childrenByParent.values()]) {
			for (const child of children) emit(child);
		}
		return out;
	}

	private visibleSessions(project: Project): SidebarSession[] {
		const q = this.query.trim().toLowerCase();
		let sessions = project.sessions.filter((session) => !this.suppressedSessionPaths.has(normalizePath(session.path)));
		const transientDraft =
			this.transientSessionDraft && this.transientSessionDraft.projectId === project.id
				? ({
					id: `transient_${project.id}`,
					name: this.transientSessionDraft.name,
					path: this.transientSessionDraft.path ?? "",
					createdAt: this.transientSessionDraft.createdAt,
					modifiedAt: this.transientSessionDraft.createdAt,
					tokens: 0,
					cost: 0,
					optimistic: true,
					transient: true,
				} satisfies SidebarSession)
				: null;
		if (transientDraft) {
			const transientPath = normalizePath(transientDraft.path);
			sessions = [
				transientDraft,
				...sessions.filter((session) => normalizePath(session.path) !== transientPath || !transientPath),
			];
		}
		if (q) {
			sessions = sessions.filter((session) => `${session.name} ${session.path}`.toLowerCase().includes(q));
		}
		sessions = this.sortedSessions(sessions);
		let visible: SidebarSession[];
		if (this.sessionShow === "all" || q) {
			visible = sessions;
		} else {
			const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 14;
			const pinned = sessions.filter((session) => this.isSessionPinned(session.path));
			const recent = sessions.filter((session) => session.transient || (session.modifiedAt || session.createdAt || 0) >= cutoff);
			const merged = [...pinned, ...recent.filter((session) => !this.isSessionPinned(session.path))];
			visible = merged.length > 0 ? merged : sessions.slice(0, 5);
		}
		return this.nestForkSessions(visible, (session) => session);
	}

	private chronologicalSessions(projects: Project[]): Array<{ project: Project; session: SidebarSession }> {
		const list: Array<{ project: Project; session: SidebarSession }> = [];
		for (const project of projects) {
			for (const session of this.visibleSessions(project)) {
				list.push({ project, session });
			}
		}
		list.sort((a, b) => {
			const pinDelta = Number(this.isSessionPinned(b.session.path)) - Number(this.isSessionPinned(a.session.path));
			if (pinDelta !== 0) return pinDelta;
			const aTs = this.sessionSortBy === "created"
				? a.session.createdAt || a.session.modifiedAt
				: a.session.modifiedAt || a.session.createdAt;
			const bTs = this.sessionSortBy === "created"
				? b.session.createdAt || b.session.modifiedAt
				: b.session.modifiedAt || b.session.createdAt;
			return bTs - aTs || a.project.name.localeCompare(b.project.name);
		});
		// 时间排序后再做一次 fork 嵌套，分支会话仍然紧跟父会话。
		return this.nestForkSessions(list, (row) => row.session);
	}

	private compareFileNodes(a: FileNode, b: FileNode): number {
		const hint = this.newFilePlacementHint;
		if (hint && Date.now() > hint.expiresAt) {
			this.newFilePlacementHint = null;
		}
		if (hint && this.activeProjectId === hint.projectId) {
			const aPath = normalizePath(a.path);
			const bPath = normalizePath(b.path);
			const matchesPair =
				(aPath === hint.newPath && bPath === hint.anchorPath) ||
				(aPath === hint.anchorPath && bPath === hint.newPath);
			if (matchesPair) {
				const aParent = normalizePath(parentFsPath(a.path));
				const bParent = normalizePath(parentFsPath(b.path));
				const hintParent = normalizePath(parentFsPath(hint.newPath));
				if (aParent && aParent === bParent && aParent === hintParent) {
					return aPath === hint.newPath ? 1 : -1;
				}
			}
		}
		if (this.fileKind === "all" && a.isDirectory !== b.isDirectory) {
			return a.isDirectory ? -1 : 1;
		}
		const cmp = a.name.localeCompare(b.name);
		return this.fileSort === "nameDesc" ? -cmp : cmp;
	}

	private nodeMatchesQuery(node: FileNode, query: string): boolean {
		const textMatches = !query || node.name.toLowerCase().includes(query);

		const typeMatches =
			this.fileKind === "all" ||
			(this.fileKind === "dirs" && node.isDirectory) ||
			(this.fileKind === "files" && !node.isDirectory);

		if (textMatches && typeMatches) return true;
		if (!node.isDirectory) return false;

		if (!node.children) {
			return this.fileKind === "files" || (this.fileKind === "dirs" && textMatches);
		}

		return node.children.some((child) => this.nodeMatchesQuery(child, query));
	}

	private renderFileIcon(node: FileNode): TemplateResult {
		if (node.isDirectory) {
			return html`
				<span class="sidebar-file-icon folder-icon ${node.expanded ? "open" : ""}">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path class="folder-tab" d="M1.8 4.8h4l1.2 1.4H14a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5.8a1 1 0 0 1 .8-1z" />
						<path class="folder-body" d="M1.8 5.8h12.3a.9.9 0 0 1 .9.9v5.1a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6.7a.9.9 0 0 1 .8-.9z" />
					</svg>
				</span>
			`;
		}

		const kind = fileIconKind(node.name);
		return html`
			<span class="sidebar-file-icon file-icon kind-${kind} ${node.isSymlink ? "symlink" : ""}">
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path class="file-shell" d="M4 1.7h5.2L13 5.5v8.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.7a1 1 0 0 1 1-1z" />
					<path class="file-fold" d="M9.2 1.7v3.2a.6.6 0 0 0 .6.6H13" />
					<rect class="file-accent" x="4.9" y="10.7" width="6.2" height="1.5" rx="0.75" />
					${node.isSymlink ? html`<path class="file-link" d="M6.1 8.4h3.8M8.6 7l1.3 1.4L8.6 9.8" />` : nothing}
				</svg>
			</span>
		`;
	}

	private primeFileDragPayload(node: FileNode, fileRenameActive: boolean, event?: PointerEvent | MouseEvent): void {
		if (node.isDirectory || fileRenameActive) return;
		if (event && event.button !== 0) return;
		setActiveDraggedFilePaths([node.path]);
	}

	private handleFileDragStart(event: DragEvent, node: FileNode, fileRenameActive: boolean): void {
		if (node.isDirectory || fileRenameActive) {
			event.preventDefault();
			return;
		}
		this.primeFileDragPayload(node, fileRenameActive);
		const transfer = event.dataTransfer;
		if (!transfer) return;
		transfer.effectAllowed = "copy";
		try {
			transfer.setData("text/plain", node.path);
			transfer.setData("text", node.path);
			transfer.setData("text/uri-list", toFileUri(node.path));
			transfer.setData("application/x-pi-file-path", node.path);
			transfer.setData("application/x-pi-file-paths-json", JSON.stringify([node.path]));
		} catch {
			// Some desktop runtimes reject custom MIME types; fallback channel remains active.
		}
		const dragSource = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		if (dragSource) {
			try {
				transfer.setDragImage(dragSource, 12, 12);
			} catch {
				// ignore unsupported drag-image calls
			}
		}
	}

	private handleFileDragEnd(): void {
		// Keep active drag payload alive briefly for drop-target fallback paths.
		// It will be cleared by the drop consumer or TTL expiry.
	}

	private renderFileNode(projectId: string, node: FileNode, query: string): TemplateResult | typeof nothing {
		if (!this.nodeMatchesQuery(node, query)) return nothing;
		const indent = node.depth * 14;
		const activeFile = !node.isDirectory && normalizePath(node.path) === this.activeFilePath;
		const fileRenameActive =
			!node.isDirectory &&
			Boolean(this.fileRenameDraft) &&
			this.fileRenameDraft?.projectId === projectId &&
			this.fileRenameDraft?.filePath === normalizePath(node.path);

		return html`
			<div>
				<div
					class="sidebar-file-row ${node.isDirectory ? "dir" : "file"} ${!node.isDirectory && !fileRenameActive ? "is-draggable" : ""}"
					style=${`--indent:${indent}px`}
					.draggable=${!node.isDirectory && !fileRenameActive}
					@pointerdown=${(event: PointerEvent) => this.primeFileDragPayload(node, fileRenameActive, event)}
					@dragstart=${(event: DragEvent) => this.handleFileDragStart(event, node, fileRenameActive)}
					@dragend=${() => this.handleFileDragEnd()}
				>
					<button
						class="sidebar-file-main ${activeFile ? "active-file" : ""}"
						.draggable=${!node.isDirectory && !fileRenameActive}
						@pointerdown=${(event: PointerEvent) => this.primeFileDragPayload(node, fileRenameActive, event)}
						@dragstart=${(event: DragEvent) => this.handleFileDragStart(event, node, fileRenameActive)}
						@dragend=${() => this.handleFileDragEnd()}
						@click=${() => {
							clearActiveDraggedFilePaths();
							if (node.isDirectory) {
								void this.toggleDirectory(projectId, node);
							} else {
								if (fileRenameActive) return;
								this.selectProject(projectId, false);
								this.activeSessionPath = null;
								this.activeFilePath = normalizePath(node.path);
								this.render();
								this.openFile(projectId, node.path);
							}
						}}
						@contextmenu=${(e: MouseEvent) => this.handleFileContextMenu(e, projectId, node)}
						title=${node.displayPath}
					>
						<span class="sidebar-file-caret">${node.isDirectory ? (node.expanded ? "▾" : "▸") : ""}</span>
						${this.renderFileIcon(node)}
						${fileRenameActive
							? html`
								<input
									class="sidebar-inline-input sidebar-file-inline-input"
									.value=${this.fileRenameDraft?.value ?? node.name}
									@click=${(e: Event) => e.stopPropagation()}
									@input=${(e: Event) => {
										const target = e.target as HTMLInputElement;
										if (!this.fileRenameDraft) return;
										this.fileRenameDraft = { ...this.fileRenameDraft, value: target.value };
									}}
									@keydown=${(e: KeyboardEvent) => {
										if (e.key === "Enter") {
											e.preventDefault();
											void this.commitFileRename(projectId, node);
											return;
										}
										if (e.key === "Escape") {
											e.preventDefault();
											this.cancelFileRename();
										}
									}}
									@blur=${() => void this.commitFileRename(projectId, node)}
									autofocus
								/>
							`
							: html`<span class="sidebar-file-name">${node.name}</span>`}
					</button>
				</div>
				${node.loading
					? html`<div class="sidebar-file-loading" style=${`--indent:${indent + 28}px`} role="status" aria-label=${t("common.loading")}><span class="ui-loading-spinner small"></span></div>`
					: nothing}
				${node.expanded && node.loadError
					? html`<div class="sidebar-file-empty" style=${`--indent:${indent + 28}px`}>${t("sidebar.file.cannotReadFolder")}</div>`
					: nothing}
				${node.expanded && !node.loadError && node.children && node.children.length === 0
					? html`<div class="sidebar-file-empty" style=${`--indent:${indent + 28}px`}>${t("sidebar.file.emptyFolder")}</div>`
					: nothing}
				${node.expanded && !node.loadError && node.children && node.children.length > 0
					? html`${[...node.children].sort((a, b) => this.compareFileNodes(a, b)).map((child) => this.renderFileNode(projectId, child, query))}`
					: nothing}
			</div>
		`;
	}

	private renderProjectMarker(project: Project): TemplateResult {
		return html`<span class="sidebar-project-leading-emoji">${normalizeProjectEmoji(project.emoji)}</span>`;
	}

	private getProjectAttentionCount(project: Project): number {
		let count = 0;
		for (const session of project.sessions) {
			if (this.attentionSessionMessages.has(normalizePath(session.path))) {
				count += 1;
			}
		}
		return count;
	}

	/**
	 * emoji 弹层定位：锚定触发 emoji 图标正下方 8px；右缘不越过侧栏边界 +8px
	 * （侧栏过窄放不下时退回视口内 clamp）；下方空间不足时改弹到图标上方。
	 */
	private computeEmojiPickerPosition(
		anchor: { left: number; top: number; bottom: number },
		pickerWidth: number,
		pickerHeight: number,
	): { x: number; y: number } {
		const pad = 10;
		const gap = 8;
		const sidebarRight = Math.floor(this.container.getBoundingClientRect().right);
		const maxX = Math.max(pad, Math.min(sidebarRight + gap - pickerWidth, window.innerWidth - pickerWidth - pad));
		const x = Math.max(pad, Math.min(Math.round(anchor.left), maxX));
		const belowY = Math.round(anchor.bottom + gap);
		const aboveY = Math.round(anchor.top - gap - pickerHeight);
		const y =
			belowY + pickerHeight <= window.innerHeight - pad
				? belowY
				: aboveY >= pad
					? aboveY
					: Math.max(pad, Math.min(belowY, window.innerHeight - pickerHeight - pad));
		return { x, y };
	}

	/** 项目 emoji 弹层锚点：始终贴到项目行首的 emoji 图标（从「…」菜单打开时不锚在菜单项上），找不到再退回事件坐标。 */
	private resolveProjectEmojiAnchor(projectId: string, event: MouseEvent): { left: number; top: number; bottom: number } {
		const icon = this.container.querySelector<HTMLElement>(
			`.sidebar-project-row[data-project-id="${projectId}"] .sidebar-project-leading-emoji`,
		);
		const rect = icon?.getBoundingClientRect();
		if (rect && (rect.width > 0 || rect.height > 0)) {
			return { left: rect.left, top: rect.top, bottom: rect.bottom };
		}
		const target = event.currentTarget as HTMLElement | null;
		const targetRect = target?.getBoundingClientRect();
		if (targetRect && (targetRect.width > 0 || targetRect.height > 0)) {
			return { left: targetRect.left, top: targetRect.top, bottom: targetRect.bottom };
		}
		return { left: event.clientX, top: event.clientY, bottom: event.clientY };
	}

	private openProjectEmojiPicker(projectId: string, event: MouseEvent): void {
		event.stopPropagation();
		if (this.projectEmojiPickerProjectId === projectId) {
			this.closeProjectEmojiPicker();
			return;
		}
		const pickerWidth = 272;
		const pickerHeight = 332;
		const { x, y } = this.computeEmojiPickerPosition(this.resolveProjectEmojiAnchor(projectId, event), pickerWidth, pickerHeight);
		this.openProjectMenuId = null;
		this.projectEmojiPickerProjectId = projectId;
		this.projectEmojiSearchQuery = "";
		this.projectEmojiPickerX = x;
		this.projectEmojiPickerY = y;
		this.render();
		requestAnimationFrame(() => {
			const input = this.projectEmojiPortalHost?.querySelector<HTMLInputElement>(`.project-emoji-search[data-project-id="${projectId}"]`);
			input?.focus();
			input?.select();
		});
	}

	private closeProjectEmojiPicker(shouldRender = true): void {
		if (!this.projectEmojiPickerProjectId) return;
		this.projectEmojiPickerProjectId = null;
		this.projectEmojiSearchQuery = "";
		if (shouldRender) this.render();
	}

	private filteredProjectEmojis(): typeof EMOJI_CATALOG {
		const query = this.projectEmojiSearchQuery.trim().toLowerCase();
		if (!query) return EMOJI_CATALOG;
		return EMOJI_CATALOG.filter((entry) => entry.search.includes(query));
	}

	private applyProjectEmoji(projectId: string, emoji: string | null): void {
		const project = this.projects.find((entry) => entry.id === projectId);
		if (!project) return;
		project.emoji = normalizeProjectEmoji(emoji);
		this.persistProjects();
		this.closeProjectEmojiPicker();
	}

	private readonly onProjectDragPointerMove = (event: PointerEvent): void => {
		if (event.pointerId !== this.projectDragPointerId) return;
		if (!this.pendingProjectDragId) return;

		event.preventDefault();

		if (!this.draggingProjectId) {
			if (Math.abs(event.clientY - this.projectDragStartY) < WORKSPACE_DRAG_THRESHOLD_PX) {
				return;
			}
			this.draggingProjectId = this.pendingProjectDragId;
			this.projectDragOverId = this.pendingProjectDragId;
			this.render();
		}

		const draggedProjectId = this.draggingProjectId;
		if (!draggedProjectId) return;
		const hoveredProjectId = this.resolveProjectIdFromPoint(event.clientX, event.clientY, draggedProjectId);
		if (!hoveredProjectId || hoveredProjectId === this.projectDragOverId) return;
		this.projectDragOverId = hoveredProjectId;
		this.render();
	};

	private readonly onProjectDragPointerEnd = (event: PointerEvent): void => {
		if (event.pointerId !== this.projectDragPointerId) return;
		event.preventDefault();
		this.finishProjectPointerDrag(true);
	};

	private beginProjectPointerDrag(event: PointerEvent, projectId: string): void {
		if (event.button !== 0) return;
		this.pendingProjectDragId = projectId;
		this.projectDragPointerId = event.pointerId;
		this.projectDragStartY = event.clientY;
		this.projectDragOverId = projectId;
		window.addEventListener("pointermove", this.onProjectDragPointerMove, true);
		window.addEventListener("pointerup", this.onProjectDragPointerEnd, true);
		window.addEventListener("pointercancel", this.onProjectDragPointerEnd, true);
	}

	private isCompatibleProjectDropTarget(draggedProjectId: string, targetProjectId: string): boolean {
		const dragged = this.projects.find((project) => project.id === draggedProjectId) ?? null;
		const target = this.projects.find((project) => project.id === targetProjectId) ?? null;
		return Boolean(dragged && target);
	}

	private resolveProjectIdFromPoint(clientX: number, clientY: number, draggedProjectId: string): string | null {
		const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
		const directRow = target?.closest<HTMLElement>(".sidebar-project-row[data-project-id]");
		if (directRow?.dataset.projectId) {
			return this.isCompatibleProjectDropTarget(draggedProjectId, directRow.dataset.projectId)
				? directRow.dataset.projectId
				: null;
		}

		const list = this.container.querySelector<HTMLElement>(".sidebar-project-list");
		if (!list) return null;
		const rows = [...list.querySelectorAll<HTMLElement>(".sidebar-project-row[data-project-id]")];
		if (rows.length === 0) return null;
		const compatibleRows = rows.filter((row) => {
			const projectId = row.dataset.projectId;
			if (!projectId) return false;
			return this.isCompatibleProjectDropTarget(draggedProjectId, projectId);
		});
		if (compatibleRows.length === 0) return null;
		const listRect = list.getBoundingClientRect();
		if (clientY < listRect.top) {
			return compatibleRows[0]?.dataset.projectId ?? null;
		}
		if (clientY > listRect.bottom) {
			return compatibleRows[compatibleRows.length - 1]?.dataset.projectId ?? null;
		}

		let nearestProjectId: string | null = null;
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (const row of compatibleRows) {
			const rowRect = row.getBoundingClientRect();
			const center = rowRect.top + rowRect.height / 2;
			const distance = Math.abs(clientY - center);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestProjectId = row.dataset.projectId ?? null;
			}
		}
		return nearestProjectId;
	}

	private applyProjectReorderByIds(draggedProjectId: string, targetProjectId: string): void {
		const fromIndex = this.projects.findIndex((project) => project.id === draggedProjectId);
		const toIndex = this.projects.findIndex((project) => project.id === targetProjectId);
		if (
			fromIndex === -1 ||
			toIndex === -1 ||
			fromIndex === toIndex ||
			!this.isCompatibleProjectDropTarget(draggedProjectId, targetProjectId)
		) {
			this.draggingProjectId = null;
			this.projectDragOverId = null;
			this.projectDragSuppressClickUntil = Date.now() + 180;
			this.render();
			return;
		}

		const ordered = [...this.projects];
		const [moved] = ordered.splice(fromIndex, 1);
		if (!moved) {
			this.draggingProjectId = null;
			this.projectDragOverId = null;
			this.projectDragSuppressClickUntil = Date.now() + 180;
			this.render();
			return;
		}
		ordered.splice(toIndex, 0, moved);
		this.projects = ordered;
		this.draggingProjectId = null;
		this.projectDragOverId = null;
		this.projectDragSuppressClickUntil = Date.now() + 220;
		this.persistProjects();
		this.render();
	}

	private finishProjectPointerDrag(commitReorder: boolean): void {
		window.removeEventListener("pointermove", this.onProjectDragPointerMove, true);
		window.removeEventListener("pointerup", this.onProjectDragPointerEnd, true);
		window.removeEventListener("pointercancel", this.onProjectDragPointerEnd, true);

		const draggedProjectId = this.draggingProjectId;
		const targetProjectId = this.projectDragOverId;
		const hadDragState = Boolean(this.pendingProjectDragId || this.draggingProjectId || this.projectDragOverId);

		this.pendingProjectDragId = null;
		this.projectDragPointerId = null;
		this.projectDragStartY = 0;

		if (commitReorder && draggedProjectId && targetProjectId && draggedProjectId !== targetProjectId) {
			this.applyProjectReorderByIds(draggedProjectId, targetProjectId);
			return;
		}

		if (draggedProjectId) {
			this.projectDragSuppressClickUntil = Date.now() + 180;
		}
		this.draggingProjectId = null;
		this.projectDragOverId = null;
		if (hadDragState) {
			this.render();
		}
	}

	private cancelProjectPointerDrag(shouldRender = true): void {
		const hadDragState = Boolean(this.pendingProjectDragId || this.draggingProjectId || this.projectDragOverId || this.projectDragPointerId);
		window.removeEventListener("pointermove", this.onProjectDragPointerMove, true);
		window.removeEventListener("pointerup", this.onProjectDragPointerEnd, true);
		window.removeEventListener("pointercancel", this.onProjectDragPointerEnd, true);
		this.pendingProjectDragId = null;
		this.projectDragPointerId = null;
		this.projectDragStartY = 0;
		this.draggingProjectId = null;
		this.projectDragOverId = null;
		if (hadDragState && shouldRender) {
			this.render();
		}
	}

	private shouldSuppressProjectMainClick(projectId: string): boolean {
		if (this.draggingProjectId === projectId) return true;
		if (Date.now() <= this.projectDragSuppressClickUntil) {
			return true;
		}
		return false;
	}

	private getActiveWorkspaceItem(): SidebarWorkspaceItem | null {
		if (this.workspaces.length === 0) return null;
		if (this.activeWorkspaceId) {
			const match = this.workspaces.find((workspace) => workspace.id === this.activeWorkspaceId) ?? null;
			if (match) return match;
		}
		return this.workspaces[0] ?? null;
	}

	private focusWorkspaceRenameInput(workspaceId: string): void {
		requestAnimationFrame(() => {
			const input = this.container.querySelector<HTMLInputElement>(`.sidebar-workspace-title-input[data-workspace-id="${workspaceId}"]`);
			input?.focus();
			input?.select();
		});
	}

	private startWorkspaceRename(workspaceId: string): void {
		const workspace = this.workspaces.find((entry) => entry.id === workspaceId) ?? null;
		if (!workspace) return;
		this.closeWorkspaceCreateDialog(false, false);
		this.workspaceRenameDraft = { workspaceId, value: workspace.title };
		if (this.activeWorkspaceId !== workspaceId) {
			this.onWorkspaceSelect?.(workspaceId);
		}
		this.workspaceMenuOpen = false;
		this.render();
		this.focusWorkspaceRenameInput(workspaceId);
	}

	private commitWorkspaceRename(): void {
		const draft = this.workspaceRenameDraft;
		if (!draft) return;
		const workspace = this.workspaces.find((entry) => entry.id === draft.workspaceId) ?? null;
		const nextTitle = draft.value.trim();
		this.workspaceRenameDraft = null;
		if (workspace && nextTitle && nextTitle !== workspace.title) {
			this.onWorkspaceRename?.(workspace.id, nextTitle);
			return;
		}
		this.render();
	}

	private cancelWorkspaceRename(): void {
		if (!this.workspaceRenameDraft) return;
		this.workspaceRenameDraft = null;
		this.render();
	}

	private nextWorkspaceDraftName(): string {
		const used = new Set<number>();
		for (const workspace of this.workspaces) {
			const match = /^(?:Workspace|工作区)\s*(\d+)$/i.exec(workspace.title.trim());
			if (match) {
				used.add(Number(match[1]));
			}
		}
		let idx = 1;
		while (used.has(idx)) idx += 1;
		return t("sidebar.workspace.defaultName", { index: idx });
	}

	private readonly onWorkspaceCreateDialogFocusIn = (event: FocusEvent): void => {
		if (!this.workspaceCreateDialogOpen) return;
		const dialog = this.getWorkspaceCreateDialogElement();
		if (!dialog) return;
		const target = event.target instanceof Node ? event.target : null;
		if (target && dialog.contains(target)) return;
		this.focusWorkspaceCreateDialogPrimaryInput();
	};

	private readonly onWorkspaceCreateDialogKeyDown = (event: KeyboardEvent): void => {
		if (!this.workspaceCreateDialogOpen) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.closeWorkspaceCreateDialog();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = this.getWorkspaceCreateDialogFocusableElements();
		if (focusable.length === 0) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const currentIndex = active ? focusable.findIndex((entry) => entry === active) : -1;
		const nextIndex = event.shiftKey
			? currentIndex <= 0
				? focusable.length - 1
				: currentIndex - 1
			: currentIndex === -1 || currentIndex >= focusable.length - 1
				? 0
				: currentIndex + 1;
		event.preventDefault();
		event.stopPropagation();
		focusable[nextIndex]?.focus();
	};

	private getWorkspaceCreateDialogElement(): HTMLElement | null {
		const host = this.workspaceCreatePortalHost && document.body.contains(this.workspaceCreatePortalHost)
			? this.workspaceCreatePortalHost
			: this.container;
		return host.querySelector<HTMLElement>(".sidebar-space-dialog");
	}

	private getWorkspaceCreateDialogFocusableElements(): HTMLElement[] {
		const dialog = this.getWorkspaceCreateDialogElement();
		if (!dialog) return [];
		return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
	}

	private focusWorkspaceCreateDialogPrimaryInput(selectText = false): void {
		const dialog = this.getWorkspaceCreateDialogElement();
		if (!dialog) return;
		const input = dialog.querySelector<HTMLInputElement>(".sidebar-space-name-input");
		if (input) {
			input.focus();
			if (selectText) input.select();
			return;
		}
		const firstFocusable = this.getWorkspaceCreateDialogFocusableElements()[0] ?? null;
		firstFocusable?.focus();
	}

	private enableWorkspaceCreateDialogFocusTrap(): void {
		if (this.workspaceCreateDialogFocusTrapActive) return;
		window.addEventListener("keydown", this.onWorkspaceCreateDialogKeyDown, true);
		document.addEventListener("focusin", this.onWorkspaceCreateDialogFocusIn, true);
		this.workspaceCreateDialogFocusTrapActive = true;
	}

	private disableWorkspaceCreateDialogFocusTrap(): void {
		if (!this.workspaceCreateDialogFocusTrapActive) return;
		window.removeEventListener("keydown", this.onWorkspaceCreateDialogKeyDown, true);
		document.removeEventListener("focusin", this.onWorkspaceCreateDialogFocusIn, true);
		this.workspaceCreateDialogFocusTrapActive = false;
	}

	private restoreWorkspaceCreateDialogFocus(): void {
		const target = this.workspaceCreateDialogRestoreFocus;
		this.workspaceCreateDialogRestoreFocus = null;
		if (!target || !document.contains(target)) return;
		requestAnimationFrame(() => target.focus());
	}

	private openWorkspaceCreateDialog(): void {
		this.workspaceRenameDraft = null;
		this.workspaceCreateDialogRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		this.workspaceCreateDialogOpen = true;
		this.workspaceCreateName = this.nextWorkspaceDraftName();
		this.workspaceCreateEmoji = "✨";
		this.workspaceCreateEmojiPickerOpen = false;
		this.workspaceCreateEmojiQuery = "";
		this.workspaceMenuOpen = false;
		this.closeWorkspaceEmojiPicker(false);
		this.closeContextMenu(false);
		this.enableWorkspaceCreateDialogFocusTrap();
		this.render();
		requestAnimationFrame(() => this.focusWorkspaceCreateDialogPrimaryInput(true));
	}

	private closeWorkspaceCreateDialog(shouldRender = true, restoreFocus = true): void {
		const wasOpen = this.workspaceCreateDialogOpen;
		this.workspaceCreateDialogOpen = false;
		this.workspaceCreateEmojiPickerOpen = false;
		this.workspaceCreateEmojiQuery = "";
		this.disableWorkspaceCreateDialogFocusTrap();
		if (restoreFocus && wasOpen) this.restoreWorkspaceCreateDialogFocus();
		else this.workspaceCreateDialogRestoreFocus = null;
		if (shouldRender && wasOpen) this.render();
	}

	private filteredWorkspaceCreateEmojis(): typeof EMOJI_CATALOG {
		const query = this.workspaceCreateEmojiQuery.trim().toLowerCase();
		if (!query) return EMOJI_CATALOG;
		return EMOJI_CATALOG.filter((entry) => entry.search.includes(query));
	}

	private createWorkspaceFromDialog(): void {
		const title = this.workspaceCreateName.trim() || this.nextWorkspaceDraftName();
		const emoji = this.workspaceCreateEmoji.trim() || "✨";
		this.closeWorkspaceCreateDialog(false, false);
		this.onWorkspaceCreate?.({ title, emoji });
		this.render();
	}

	private toggleWorkspaceMenu(nextOpen?: boolean): void {
		const open = typeof nextOpen === "boolean" ? nextOpen : !this.workspaceMenuOpen;
		if (this.workspaceMenuOpen === open) return;
		this.workspaceMenuOpen = open;
		if (!open) {
			this.cancelWorkspacePointerDrag(false);
			this.closeWorkspaceEmojiPicker(false);
		}
		this.render();
	}

	/** 空间 emoji 弹层锚点：直接点 emoji 图标（dock pill 等）时锚定触发器本身；从右键菜单打开时贴回该空间的 dock emoji 图标。 */
	private resolveWorkspaceEmojiAnchor(workspaceId: string, event: MouseEvent): { left: number; top: number; bottom: number } {
		const target = event.currentTarget as HTMLElement | null;
		const directTrigger =
			target?.matches(".sidebar-workspace-pill, .sidebar-workspace-avatar-btn, .sidebar-workspace-trigger-emoji") ? target : null;
		const icon =
			directTrigger ??
			this.container.querySelector<HTMLElement>(`.sidebar-workspace-pill[data-workspace-id="${workspaceId}"]`) ??
			target;
		const rect = icon?.getBoundingClientRect();
		if (rect && (rect.width > 0 || rect.height > 0)) {
			return { left: rect.left, top: rect.top, bottom: rect.bottom };
		}
		return { left: event.clientX, top: event.clientY, bottom: event.clientY };
	}

	private openWorkspaceEmojiPicker(workspaceId: string, event: MouseEvent): void {
		event.stopPropagation();
		if (this.emojiPickerWorkspaceId === workspaceId) {
			this.closeWorkspaceEmojiPicker();
			return;
		}
		const pickerWidth = 272;
		const pickerHeight = 332;
		const { x, y } = this.computeEmojiPickerPosition(this.resolveWorkspaceEmojiAnchor(workspaceId, event), pickerWidth, pickerHeight);
		this.emojiPickerWorkspaceId = workspaceId;
		this.emojiSearchQuery = "";
		this.emojiPickerX = x;
		this.emojiPickerY = y;
		this.render();
		requestAnimationFrame(() => {
			const input = this.workspaceEmojiPortalHost?.querySelector<HTMLInputElement>(`.workspace-emoji-search[data-workspace-id="${workspaceId}"]`);
			input?.focus();
			input?.select();
		});
	}

	private closeWorkspaceEmojiPicker(shouldRender = true): void {
		if (!this.emojiPickerWorkspaceId) return;
		this.emojiPickerWorkspaceId = null;
		this.emojiSearchQuery = "";
		if (shouldRender) this.render();
	}

	private filteredWorkspaceEmojis(): typeof EMOJI_CATALOG {
		const query = this.emojiSearchQuery.trim().toLowerCase();
		if (!query) return EMOJI_CATALOG;
		return EMOJI_CATALOG.filter((entry) => entry.search.includes(query));
	}

	private applyWorkspaceEmoji(workspaceId: string, emoji: string | null): void {
		this.onWorkspaceEmoji?.(workspaceId, emoji);
		this.closeWorkspaceEmojiPicker();
	}

	private readonly onWorkspaceDragPointerMove = (event: PointerEvent): void => {
		if (event.pointerId !== this.workspaceDragPointerId) return;
		if (!this.pendingWorkspaceDragId) return;

		let startedDrag = false;
		if (!this.draggingWorkspaceId) {
			const distance = Math.hypot(event.clientX - this.workspaceDragStartX, event.clientY - this.workspaceDragStartY);
			if (distance < WORKSPACE_DRAG_THRESHOLD_PX) {
				return;
			}
			this.draggingWorkspaceId = this.pendingWorkspaceDragId;
			this.workspaceDragOverId = this.pendingWorkspaceDragId;
			startedDrag = true;
		}

		event.preventDefault();
		if (!this.draggingWorkspaceId) return;
		if (this.workspaceCreateDialogOpen) {
			this.closeWorkspaceCreateDialog(false, false);
		}
		if (startedDrag) {
			this.render();
		}

		const draggedWorkspaceId = this.draggingWorkspaceId;
		if (!draggedWorkspaceId) return;
		const hoveredWorkspaceId = this.resolveWorkspaceIdFromPoint(event.clientX, event.clientY, draggedWorkspaceId);
		if (!hoveredWorkspaceId || hoveredWorkspaceId === this.workspaceDragOverId) return;
		this.workspaceDragOverId = hoveredWorkspaceId;
		this.render();
	};

	private readonly onWorkspaceDragPointerEnd = (event: PointerEvent): void => {
		if (event.pointerId !== this.workspaceDragPointerId) return;
		event.preventDefault();
		this.finishWorkspacePointerDrag(true);
	};

	private beginWorkspacePointerDrag(event: PointerEvent, workspaceId: string): void {
		if (event.button !== 0) return;
		this.pendingWorkspaceDragId = workspaceId;
		this.workspaceDragPointerId = event.pointerId;
		this.workspaceDragStartX = event.clientX;
		this.workspaceDragStartY = event.clientY;
		this.workspaceDragOverId = workspaceId;
		window.addEventListener("pointermove", this.onWorkspaceDragPointerMove, true);
		window.addEventListener("pointerup", this.onWorkspaceDragPointerEnd, true);
		window.addEventListener("pointercancel", this.onWorkspaceDragPointerEnd, true);
	}

	private isCompatibleWorkspaceDropTarget(draggedWorkspaceId: string, targetWorkspaceId: string): boolean {
		const dragged = this.workspaces.find((workspace) => workspace.id === draggedWorkspaceId) ?? null;
		const target = this.workspaces.find((workspace) => workspace.id === targetWorkspaceId) ?? null;
		return Boolean(dragged && target);
	}

	private resolveWorkspaceIdFromPoint(clientX: number, clientY: number, draggedWorkspaceId: string): string | null {
		const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
		const directPill = target?.closest<HTMLElement>(".sidebar-workspace-pill[data-workspace-id]");
		if (directPill?.dataset.workspaceId) {
			return this.isCompatibleWorkspaceDropTarget(draggedWorkspaceId, directPill.dataset.workspaceId)
				? directPill.dataset.workspaceId
				: null;
		}

		const list = this.container.querySelector<HTMLElement>(".sidebar-workspace-dock-list");
		if (!list) return null;
		const pills = [...list.querySelectorAll<HTMLElement>(".sidebar-workspace-pill[data-workspace-id]")];
		if (pills.length === 0) return null;
		const compatiblePills = pills.filter((pill) => {
			const workspaceId = pill.dataset.workspaceId;
			if (!workspaceId) return false;
			return this.isCompatibleWorkspaceDropTarget(draggedWorkspaceId, workspaceId);
		});
		if (compatiblePills.length === 0) return null;
		const listRect = list.getBoundingClientRect();
		if (clientX < listRect.left) {
			return compatiblePills[0]?.dataset.workspaceId ?? null;
		}
		if (clientX > listRect.right) {
			return compatiblePills[compatiblePills.length - 1]?.dataset.workspaceId ?? null;
		}

		let nearestWorkspaceId: string | null = null;
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (const pill of compatiblePills) {
			const pillRect = pill.getBoundingClientRect();
			const center = pillRect.left + pillRect.width / 2;
			const distance = Math.abs(clientX - center);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestWorkspaceId = pill.dataset.workspaceId ?? null;
			}
		}
		return nearestWorkspaceId;
	}

	private applyWorkspaceReorderByIds(draggedWorkspaceId: string, targetWorkspaceId: string): void {
		const fromIndex = this.workspaces.findIndex((workspace) => workspace.id === draggedWorkspaceId);
		const toIndex = this.workspaces.findIndex((workspace) => workspace.id === targetWorkspaceId);
		if (
			fromIndex === -1 ||
			toIndex === -1 ||
			fromIndex === toIndex ||
			!this.isCompatibleWorkspaceDropTarget(draggedWorkspaceId, targetWorkspaceId)
		) {
			this.draggingWorkspaceId = null;
			this.workspaceDragOverId = null;
			this.workspaceDragSuppressClickUntil = Date.now() + 180;
			this.render();
			return;
		}

		const ordered = [...this.workspaces];
		const [moved] = ordered.splice(fromIndex, 1);
		if (!moved) {
			this.draggingWorkspaceId = null;
			this.workspaceDragOverId = null;
			this.workspaceDragSuppressClickUntil = Date.now() + 180;
			this.render();
			return;
		}
		ordered.splice(toIndex, 0, moved);
		this.workspaces = ordered;
		this.draggingWorkspaceId = null;
		this.workspaceDragOverId = null;
		this.workspaceDragSuppressClickUntil = Date.now() + 220;
		this.onWorkspaceReorder?.(ordered.map((workspace) => workspace.id));
		this.render();
	}

	private finishWorkspacePointerDrag(commitReorder: boolean): void {
		window.removeEventListener("pointermove", this.onWorkspaceDragPointerMove, true);
		window.removeEventListener("pointerup", this.onWorkspaceDragPointerEnd, true);
		window.removeEventListener("pointercancel", this.onWorkspaceDragPointerEnd, true);

		const draggedWorkspaceId = this.draggingWorkspaceId;
		const targetWorkspaceId = this.workspaceDragOverId;
		const hadDragState = Boolean(this.pendingWorkspaceDragId || this.draggingWorkspaceId || this.workspaceDragOverId);

		this.pendingWorkspaceDragId = null;
		this.workspaceDragPointerId = null;
		this.workspaceDragStartX = 0;
		this.workspaceDragStartY = 0;

		if (commitReorder && draggedWorkspaceId && targetWorkspaceId && draggedWorkspaceId !== targetWorkspaceId) {
			this.applyWorkspaceReorderByIds(draggedWorkspaceId, targetWorkspaceId);
			return;
		}

		if (draggedWorkspaceId) {
			this.workspaceDragSuppressClickUntil = Date.now() + 180;
		}
		this.draggingWorkspaceId = null;
		this.workspaceDragOverId = null;
		if (hadDragState) {
			this.render();
		}
	}

	private cancelWorkspacePointerDrag(shouldRender = true): void {
		const hadDragState = Boolean(this.pendingWorkspaceDragId || this.draggingWorkspaceId || this.workspaceDragOverId || this.workspaceDragPointerId);
		window.removeEventListener("pointermove", this.onWorkspaceDragPointerMove, true);
		window.removeEventListener("pointerup", this.onWorkspaceDragPointerEnd, true);
		window.removeEventListener("pointercancel", this.onWorkspaceDragPointerEnd, true);
		this.pendingWorkspaceDragId = null;
		this.workspaceDragPointerId = null;
		this.workspaceDragStartX = 0;
		this.workspaceDragStartY = 0;
		this.draggingWorkspaceId = null;
		this.workspaceDragOverId = null;
		if (hadDragState && shouldRender) {
			this.render();
		}
	}

	private shouldSuppressWorkspaceRowClick(): boolean {
		if (Date.now() <= this.workspaceDragSuppressClickUntil) {
			return true;
		}
		return false;
	}

	private shouldHandleWorkspaceSwipe(target: HTMLElement | null): boolean {
		if (!target) return false;
		if (this.workspaceCreateDialogOpen || this.contextMenu || this.emojiPickerWorkspaceId || this.projectEmojiPickerProjectId) {
			return false;
		}
		if (target.closest("button, input, textarea, select, a, [contenteditable='true']")) return false;
		if (target.closest(".sidebar-context-menu, .workspace-emoji-picker, .sidebar-space-dialog, .sidebar-mode-filter-menu")) return false;
		if (target.closest(".sidebar-window-row, .sidebar-topbar, .sidebar-mode-row, .sidebar-footer, .sidebar-workspace-dock")) return false;

		const panelBody = target.closest(".sidebar-panel-body");
		if (!panelBody) return false;
		if (
			target.closest(
				".sidebar-project-list, .sidebar-chrono-list, .sidebar-files-tree, .sidebar-project-row, .sidebar-project-head, .sidebar-project-sessions, .sidebar-project-files, .sidebar-session-row, .sidebar-file-row, .sidebar-warning",
			)
		) {
			return false;
		}
		return true;
	}

	private switchWorkspaceByOffset(offset: 1 | -1): void {
		if (this.workspaces.length <= 1) return;
		const activeIndex = this.workspaces.findIndex((workspace) => workspace.id === this.activeWorkspaceId);
		if (activeIndex === -1) return;
		const nextIndex = activeIndex + offset;
		if (nextIndex < 0 || nextIndex >= this.workspaces.length) return;
		const nextWorkspace = this.workspaces[nextIndex] ?? null;
		if (!nextWorkspace || nextWorkspace.id === this.activeWorkspaceId) return;
		this.onWorkspaceSelect?.(nextWorkspace.id);
	}

	private handleSidebarWheel(event: WheelEvent): void {
		if (event.defaultPrevented) return;
		if (this.workspaces.length <= 1) return;
		if (this.pendingWorkspaceDragId || this.draggingWorkspaceId) return;

		const now = Date.now();
		if (now - this.workspaceSwipeLastInputAt > WORKSPACE_SWIPE_IDLE_MS) {
			this.workspaceSwipeAccumulatorX = 0;
			this.workspaceSwipeGestureConsumed = false;
		}

		if (!this.shouldHandleWorkspaceSwipe(event.target as HTMLElement | null)) {
			this.workspaceSwipeAccumulatorX = 0;
			return;
		}

		const deltaX = event.deltaX;
		const deltaY = event.deltaY;
		if (Math.abs(deltaX) < Math.max(10, Math.abs(deltaY) * 1.1)) {
			return;
		}

		this.workspaceSwipeLastInputAt = now;

		if (this.workspaceSwipeGestureConsumed) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		this.workspaceSwipeAccumulatorX += deltaX;
		if (Math.abs(this.workspaceSwipeAccumulatorX) < WORKSPACE_SWIPE_THRESHOLD_PX) {
			return;
		}
		if (now - this.workspaceSwipeLastSwitchAt < WORKSPACE_SWIPE_COOLDOWN_MS) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		const direction: 1 | -1 = this.workspaceSwipeAccumulatorX > 0 ? 1 : -1;
		this.workspaceSwipeAccumulatorX = 0;
		this.workspaceSwipeLastSwitchAt = now;
		this.workspaceSwipeGestureConsumed = true;
		this.switchWorkspaceByOffset(direction);
	}

	private async invokeWindowControl(action: "close" | "minimize" | "maximize"): Promise<void> {
		try {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			const currentWindow = getCurrentWindow();
			if (action === "close") {
				await currentWindow.close();
				return;
			}
			if (action === "minimize") {
				await currentWindow.minimize();
				return;
			}
			await currentWindow.toggleMaximize();
		} catch {
			// no-op outside Tauri runtime
		}
	}

	private renderWorkspaceSwitcher(): TemplateResult | typeof nothing {
		const activeWorkspace = this.getActiveWorkspaceItem();
		if (!activeWorkspace) return nothing;
		const emojiPickerWorkspace = this.emojiPickerWorkspaceId
			? this.workspaces.find((workspace) => workspace.id === this.emojiPickerWorkspaceId) ?? null
			: null;
		const filteredEmojis = this.filteredWorkspaceEmojis();

		return html`
			<div class="sidebar-workspace-switcher" data-tauri-drag-region>
				<div class="sidebar-workspace-switcher-row" data-tauri-drag-region>
					<div class="sidebar-window-controls" @click=${(e: Event) => e.stopPropagation()}>
						<button class="sidebar-window-dot red" title=${t("sidebar.window.close")} @click=${(e: Event) => {
							e.stopPropagation();
							void this.invokeWindowControl("close");
						}}></button>
						<button class="sidebar-window-dot yellow" title=${t("sidebar.window.minimize")} @click=${(e: Event) => {
							e.stopPropagation();
							void this.invokeWindowControl("minimize");
						}}></button>
						<button class="sidebar-window-dot green" title=${t("sidebar.window.maximize")} @click=${(e: Event) => {
							e.stopPropagation();
							void this.invokeWindowControl("maximize");
						}}></button>
					</div>
					<div
						class="sidebar-workspace-trigger ${this.workspaceMenuOpen ? "open" : ""}"
						title=${t("sidebar.workspace.switch")}
						@contextmenu=${(e: MouseEvent) => this.handleWorkspaceContextMenu(e, activeWorkspace.id)}
					>
						<button
							class="sidebar-workspace-trigger-emoji"
							title=${t("sidebar.workspace.changeEmoji")}
							@click=${(e: MouseEvent) => this.openWorkspaceEmojiPicker(activeWorkspace.id, e)}
						>
							<span class="sidebar-workspace-avatar">${activeWorkspace.emoji || "💼"}</span>
						</button>
						<button
							class="sidebar-workspace-trigger-main"
							@click=${(e: Event) => {
								e.stopPropagation();
								this.toggleWorkspaceMenu();
							}}
						>
							<span class="sidebar-workspace-trigger-title">${activeWorkspace.title}</span>
						</button>
						<span class="sidebar-workspace-chevron" aria-hidden="true">${this.workspaceMenuOpen ? "▴" : "▾"}</span>
					</div>
					<button
						class="workspace-sidebar-toggle"
						title=${t("sidebar.sidebarToggle.collapse")}
						@click=${(e: Event) => {
							e.stopPropagation();
							this.toggleCollapsed();
						}}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path d="M3 3.5h10v9H3z" />
							<path d="M6 3.5v9" />
						</svg>
					</button>
				</div>
				${this.workspaceMenuOpen
					? html`
						<div class="sidebar-workspace-menu" @click=${(e: Event) => e.stopPropagation()}>
							<div class="sidebar-workspace-list">
								${this.workspaces.map((workspace, index) => {
									const active = workspace.id === this.activeWorkspaceId;
									const dragOver = workspace.id === this.workspaceDragOverId && this.draggingWorkspaceId !== workspace.id;
									const prevWorkspace = this.workspaces[index - 1] ?? null;
									const showPinnedDivider = Boolean(prevWorkspace?.pinned) && !Boolean(workspace.pinned);
									return html`
										${showPinnedDivider ? html`<div class="sidebar-workspace-pin-divider" role="separator" aria-hidden="true"></div>` : nothing}
										<div
											class="sidebar-workspace-row ${active ? "active" : ""} ${dragOver ? "drag-over" : ""} ${workspace.id === this.draggingWorkspaceId ? "dragging" : ""}"
											data-workspace-id=${workspace.id}
											@contextmenu=${(e: MouseEvent) => this.handleWorkspaceContextMenu(e, workspace.id)}
										>
											<span
												class="sidebar-workspace-grip"
												aria-hidden="true"
												title=${t("sidebar.workspace.dragReorder")}
												@pointerdown=${(e: PointerEvent) => this.beginWorkspacePointerDrag(e, workspace.id)}
											>⋮⋮</span>
											<button
												class="sidebar-workspace-avatar-btn row"
												title=${t("sidebar.workspace.changeEmoji")}
												@click=${(e: MouseEvent) => this.openWorkspaceEmojiPicker(workspace.id, e)}
											>
												<span class="sidebar-workspace-avatar">${workspace.emoji || "💼"}</span>
											</button>
											<button
												class="sidebar-workspace-row-main"
												@click=${() => {
													if (this.shouldSuppressWorkspaceRowClick()) return;
													this.toggleWorkspaceMenu(false);
													if (!active) this.onWorkspaceSelect?.(workspace.id);
												}}
											>
												<span class="sidebar-workspace-row-title">${workspace.title}</span>
											</button>
										</div>
									`;
								})}
							</div>
							<div class="sidebar-workspace-menu-divider"></div>
							<button
								class="sidebar-workspace-new"
								@click=${() => {
									this.toggleWorkspaceMenu(false);
									this.onWorkspaceCreate?.();
								}}
							>
								<span class="sidebar-workspace-new-plus" aria-hidden="true">＋</span>
								<span>${t("sidebar.workspace.new")}</span>
							</button>
						</div>
					`
					: nothing}
				${this.emojiPickerWorkspaceId
					? html`
						<div class="workspace-emoji-picker" style=${`left:${this.emojiPickerX}px;top:${this.emojiPickerY}px`} @click=${(event: Event) => event.stopPropagation()}>
							<input
								class="workspace-emoji-search"
								data-workspace-id=${this.emojiPickerWorkspaceId}
								type="text"
								placeholder=${t("sidebar.emojiPicker.searchPlaceholder")}
								.value=${this.emojiSearchQuery}
								@input=${(event: Event) => {
									this.emojiSearchQuery = (event.target as HTMLInputElement).value;
									this.render();
								}}
								@keydown=${(event: KeyboardEvent) => {
									if (event.key === "Escape") {
										event.preventDefault();
										this.closeWorkspaceEmojiPicker();
									}
								}}
							/>
							<div class="workspace-emoji-scroll">
								<div class="workspace-emoji-grid">
									${filteredEmojis.length > 0
										? filteredEmojis.map((entry) => html`
											<button
												class="workspace-emoji-swatch ${emojiPickerWorkspace?.emoji === entry.emoji ? "selected" : ""}"
												title=${entry.name}
												@click=${() => this.applyWorkspaceEmoji(this.emojiPickerWorkspaceId!, entry.emoji)}
											>${entry.emoji}</button>
										`)
										: html`<div class="workspace-emoji-empty">${t("sidebar.emojiPicker.empty")}</div>`}
								</div>
							</div>
						</div>
					`
					: nothing}
			</div>
		`;
	}

	private renderWorkspaceWindowRow(): TemplateResult {
		return html`
			<div class="sidebar-window-row" data-tauri-drag-region>
				<div class="sidebar-window-controls" @click=${(e: Event) => e.stopPropagation()}>
					<button class="sidebar-window-dot red" title=${t("sidebar.window.close")} @click=${(e: Event) => {
						e.stopPropagation();
						void this.invokeWindowControl("close");
					}}></button>
					<button class="sidebar-window-dot yellow" title=${t("sidebar.window.minimize")} @click=${(e: Event) => {
						e.stopPropagation();
						void this.invokeWindowControl("minimize");
					}}></button>
					<button class="sidebar-window-dot green" title=${t("sidebar.window.maximize")} @click=${(e: Event) => {
						e.stopPropagation();
						void this.invokeWindowControl("maximize");
					}}></button>
				</div>
				<div class="sidebar-window-row-actions">
					${this.renderUpdateIcon()}
					<button
						class="workspace-sidebar-toggle"
						title=${t("sidebar.sidebarToggle.collapse")}
						@click=${(e: Event) => {
							e.stopPropagation();
							this.toggleCollapsed();
						}}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path d="M3 3.5h10v9H3z" />
							<path d="M6 3.5v9" />
						</svg>
					</button>
				</div>
			</div>
		`;
	}

	private renderUpdateIcon(): TemplateResult | typeof nothing {
		if (this.updateInProgress) {
			return html`
				<button class="sidebar-update-icon-btn" title=${t("sidebar.updates.updating")} disabled>
					<span class="ui-loading-spinner small" aria-hidden="true"></span>
				</button>
			`;
		}
		if (!this.desktopUpdateAvailable && !this.cliUpdateAvailable) return nothing;
		const label = this.desktopUpdateAvailable ? t("sidebar.updates.desktopAvailable") : t("sidebar.updates.cliAvailable");
		const version = this.desktopUpdateAvailable ? this.desktopUpdateLatestVersion : this.cliUpdateLatestVersion;
		const title = `${label}${version ? ` · v${version}` : ""}，${t("sidebar.updates.clickToUpdate")}`;
		return html`
			<button
				class="sidebar-update-icon-btn"
				title=${title}
				@click=${(e: Event) => {
					e.stopPropagation();
					if (this.onUpdateIconClick) {
						this.onUpdateIconClick();
					} else {
						this.onOpenSettings?.("updates");
					}
				}}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M8 2.8v6.4" />
					<path d="M5.2 6.6L8 9.4l2.8-2.8" />
					<path d="M3.2 10.8v1.6c0 .9.7 1.6 1.6 1.6h6.4c.9 0 1.6-.7 1.6-1.6v-1.6" />
				</svg>
				<span class="sidebar-update-dot" aria-hidden="true"></span>
			</button>
		`;
	}

	private renderWorkspaceHeader(): TemplateResult | typeof nothing {
		const activeWorkspace = this.getActiveWorkspaceItem();
		if (!activeWorkspace) return nothing;
		const isRenaming = this.workspaceRenameDraft?.workspaceId === activeWorkspace.id;
		return html`
			<div
				class="sidebar-workspace-header"
				@contextmenu=${(e: MouseEvent) => this.handleWorkspaceContextMenu(e, activeWorkspace.id)}
			>
				<div class="sidebar-workspace-header-main">
					${isRenaming
						? html`
							<input
								class="sidebar-workspace-title-input"
								data-workspace-id=${activeWorkspace.id}
								.value=${this.workspaceRenameDraft?.value ?? activeWorkspace.title}
								@input=${(event: Event) => {
									if (!this.workspaceRenameDraft) return;
									this.workspaceRenameDraft = {
										...this.workspaceRenameDraft,
										value: (event.target as HTMLInputElement).value,
									};
								}}
								@keydown=${(event: KeyboardEvent) => {
									if (event.key === "Enter") {
										event.preventDefault();
										this.commitWorkspaceRename();
										return;
									}
									if (event.key === "Escape") {
										event.preventDefault();
										this.cancelWorkspaceRename();
									}
								}}
								@blur=${() => this.commitWorkspaceRename()}
							/>
						`
						: html`<div class="sidebar-workspace-header-title">${activeWorkspace.title}</div>`}
				</div>
			</div>
		`;
	}

	private renderWorkspaceDock(): TemplateResult {
		return html`
			<div class="sidebar-workspace-dock" data-tauri-drag-region>
				<button
					class="sidebar-settings-icon-btn"
					title=${t("sidebar.settings.label")}
					@click=${(e: Event) => {
						e.preventDefault();
						e.stopPropagation();
						this.onOpenSettings?.();
					}}
				>
					<svg class="sidebar-icon-svg" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M6.6 1.9h2.8l.3 1.5c.4.1.7.3 1 .5l1.4-.6 1.4 2.4-1.1 1c.1.4.1.8 0 1.2l1.1 1-1.4 2.4-1.4-.6c-.3.2-.6.4-1 .5l-.3 1.5H6.6l-.3-1.5c-.4-.1-.7-.3-1-.5l-1.4.6-1.4-2.4 1.1-1a3.8 3.8 0 0 1 0-1.2l-1.1-1 1.4-2.4 1.4.6c.3-.2.6-.4 1-.5z" />
						<circle cx="8" cy="8" r="2.1" />
					</svg>
				</button>
				<div class="sidebar-workspace-dock-list" @click=${(e: Event) => e.stopPropagation()}>
					${this.workspaces.map((workspace) => {
						const active = workspace.id === this.activeWorkspaceId;
						const dragOver = workspace.id === this.workspaceDragOverId && this.draggingWorkspaceId !== workspace.id;
						return html`
							<button
								class="sidebar-workspace-pill ${active ? "active" : ""} ${dragOver ? "drag-over" : ""} ${workspace.id === this.draggingWorkspaceId ? "dragging" : ""}"
								data-workspace-id=${workspace.id}
								title=${workspace.title}
								@contextmenu=${(e: MouseEvent) => this.handleWorkspaceContextMenu(e, workspace.id)}
								@pointerdown=${(e: PointerEvent) => this.beginWorkspacePointerDrag(e, workspace.id)}
								@click=${(e: MouseEvent) => {
									if (this.shouldSuppressWorkspaceRowClick()) return;
									if (active) {
										this.openWorkspaceEmojiPicker(workspace.id, e);
									} else {
										this.onWorkspaceSelect?.(workspace.id);
									}
								}}
							>
								<span class="sidebar-workspace-pill-emoji">${workspace.emoji || "💼"}</span>
							</button>
						`;
					})}
				</div>
				<button
					class="sidebar-workspace-dock-add"
					title=${t("sidebar.spaceDialog.create")}
					@click=${(e: Event) => {
						e.stopPropagation();
						this.openWorkspaceCreateDialog();
					}}
				>
					＋
				</button>
			</div>
		`;
	}

	private renderWorkspaceEmojiPicker(): TemplateResult | typeof nothing {
		if (!this.emojiPickerWorkspaceId) return nothing;
		const emojiPickerWorkspace = this.workspaces.find((workspace) => workspace.id === this.emojiPickerWorkspaceId) ?? null;
		const filteredEmojis = this.filteredWorkspaceEmojis();
		return html`
			<button
				type="button"
				class="workspace-emoji-picker-backdrop"
				aria-label=${t("sidebar.emojiPicker.close")}
				@click=${() => this.closeWorkspaceEmojiPicker()}
			></button>
			<div class="workspace-emoji-picker" style=${`left:${this.emojiPickerX}px;top:${this.emojiPickerY}px`} @click=${(event: Event) => event.stopPropagation()}>
				<input
					class="workspace-emoji-search"
					data-workspace-id=${this.emojiPickerWorkspaceId}
					type="text"
					placeholder=${t("sidebar.emojiPicker.searchPlaceholder")}
					.value=${this.emojiSearchQuery}
					@input=${(event: Event) => {
						this.emojiSearchQuery = (event.target as HTMLInputElement).value;
						this.render();
					}}
					@keydown=${(event: KeyboardEvent) => {
						if (event.key === "Escape") {
							event.preventDefault();
							this.closeWorkspaceEmojiPicker();
						}
					}}
				/>
				<div class="workspace-emoji-scroll">
					<div class="workspace-emoji-grid">
						${filteredEmojis.length > 0
							? filteredEmojis.map((entry) => html`
								<button
									class="workspace-emoji-swatch ${emojiPickerWorkspace?.emoji === entry.emoji ? "selected" : ""}"
									title=${entry.name}
									@click=${() => this.applyWorkspaceEmoji(this.emojiPickerWorkspaceId!, entry.emoji)}
								>${entry.emoji}</button>
							`)
							: html`<div class="workspace-emoji-empty">${t("sidebar.emojiPicker.empty")}</div>`}
					</div>
				</div>
			</div>
		`;
	}

	private renderWorkspaceCreateDialog(): TemplateResult | typeof nothing {
		if (!this.workspaceCreateDialogOpen) return nothing;
		const filteredEmojis = this.filteredWorkspaceCreateEmojis();
		return html`
			<div class="sidebar-space-dialog-backdrop" role="presentation" @click=${() => this.closeWorkspaceCreateDialog()}>
				<div
					class="sidebar-space-dialog"
					role="dialog"
					aria-modal="true"
					aria-label=${t("sidebar.spaceDialog.create")}
					@click=${(event: Event) => event.stopPropagation()}
					@keydown=${(event: KeyboardEvent) => event.stopPropagation()}
				>
					<div class="sidebar-space-dialog-title">${t("sidebar.spaceDialog.create")}</div>
					<div class="sidebar-space-dialog-copy">${t("sidebar.spaceDialog.description")}</div>
					<div class="sidebar-space-name-row">
						<button
							class="sidebar-space-emoji-trigger"
							title=${t("sidebar.emojiPicker.choose")}
							@click=${(event: Event) => {
								event.stopPropagation();
								this.workspaceCreateEmojiPickerOpen = !this.workspaceCreateEmojiPickerOpen;
								this.render();
							}}
						>
							${this.workspaceCreateEmoji || "✨"}
						</button>
						<input
							class="sidebar-space-name-input"
							type="text"
							placeholder=${t("sidebar.spaceDialog.namePlaceholder")}
							.value=${this.workspaceCreateName}
							@input=${(event: Event) => {
								this.workspaceCreateName = (event.target as HTMLInputElement).value;
							}}
							@keydown=${(event: KeyboardEvent) => {
								if (event.key === "Enter") {
									event.preventDefault();
									this.createWorkspaceFromDialog();
									return;
								}
								if (event.key === "Escape") {
									event.preventDefault();
									this.closeWorkspaceCreateDialog();
								}
							}}
						/>
					</div>
					${this.workspaceCreateEmojiPickerOpen
						? html`
							<div class="sidebar-space-emoji-picker">
								<input
									class="sidebar-space-emoji-search"
									type="text"
									placeholder=${t("sidebar.emojiPicker.searchPlaceholder")}
									.value=${this.workspaceCreateEmojiQuery}
									@input=${(event: Event) => {
										this.workspaceCreateEmojiQuery = (event.target as HTMLInputElement).value;
										this.render();
									}}
								/>
								<div class="sidebar-space-emoji-grid">
									${filteredEmojis.length > 0
										? filteredEmojis.slice(0, 120).map((entry) => html`
											<button
												class="sidebar-space-emoji-option ${this.workspaceCreateEmoji === entry.emoji ? "selected" : ""}"
												title=${entry.name}
												@click=${() => {
													this.workspaceCreateEmoji = entry.emoji;
													this.workspaceCreateEmojiPickerOpen = false;
													this.workspaceCreateEmojiQuery = "";
													this.render();
												}}
											>${entry.emoji}</button>
										`)
										: html`<div class="workspace-emoji-empty">${t("sidebar.emojiPicker.empty")}</div>`}
								</div>
							</div>
						`
						: nothing}
					<div class="sidebar-space-dialog-actions">
						<button class="sidebar-space-create-btn" @click=${() => this.createWorkspaceFromDialog()}>${t("sidebar.spaceDialog.createButton")}</button>
						<button class="sidebar-space-cancel-btn" @click=${() => this.closeWorkspaceCreateDialog()}>${t("common.cancel")}</button>
					</div>
				</div>
			</div>
		`;
	}

	private renderProjectEmojiPicker(): TemplateResult | typeof nothing {
		if (!this.projectEmojiPickerProjectId) return nothing;
		const project = this.projects.find((entry) => entry.id === this.projectEmojiPickerProjectId) ?? null;
		const filteredEmojis = this.filteredProjectEmojis();
		return html`
			<button
				type="button"
				class="project-emoji-picker-backdrop"
				aria-label=${t("sidebar.emojiPicker.close")}
				@click=${() => this.closeProjectEmojiPicker()}
			></button>
			<div class="workspace-emoji-picker project-emoji-picker" style=${`left:${this.projectEmojiPickerX}px;top:${this.projectEmojiPickerY}px`} @click=${(event: Event) => event.stopPropagation()}>
				<input
					class="workspace-emoji-search project-emoji-search"
					data-project-id=${this.projectEmojiPickerProjectId}
					type="text"
					placeholder=${t("sidebar.emojiPicker.searchPlaceholder")}
					.value=${this.projectEmojiSearchQuery}
					@input=${(event: Event) => {
						this.projectEmojiSearchQuery = (event.target as HTMLInputElement).value;
						this.render();
					}}
					@keydown=${(event: KeyboardEvent) => {
						if (event.key === "Escape") {
							event.preventDefault();
							this.closeProjectEmojiPicker();
						}
					}}
				/>
				<div class="workspace-emoji-scroll">
					<div class="workspace-emoji-grid">
						${filteredEmojis.length > 0
							? filteredEmojis.map((entry) => html`
								<button
									class="workspace-emoji-swatch ${project?.emoji === entry.emoji ? "selected" : ""}"
									title=${entry.name}
									@click=${() => this.applyProjectEmoji(this.projectEmojiPickerProjectId!, entry.emoji)}
								>${entry.emoji}</button>
							`)
							: html`<div class="workspace-emoji-empty">${t("sidebar.emojiPicker.empty")}</div>`}
					</div>
				</div>
			</div>
		`;
	}

	private ensureWorkspaceCreateDialogPortalHost(): HTMLElement | null {
		if (typeof document === "undefined") return null;
		if (this.workspaceCreatePortalHost && document.body.contains(this.workspaceCreatePortalHost)) return this.workspaceCreatePortalHost;
		const host = document.createElement("div");
		host.className = "sidebar-space-dialog-portal-host";
		document.body.appendChild(host);
		this.workspaceCreatePortalHost = host;
		return host;
	}

	private renderWorkspaceCreateDialogPortal(): void {
		const host = this.ensureWorkspaceCreateDialogPortalHost();
		if (!host) return;
		render(this.renderWorkspaceCreateDialog(), host);
	}

	private ensureProjectEmojiPortalHost(): HTMLElement | null {
		if (typeof document === "undefined") return null;
		if (this.projectEmojiPortalHost && document.body.contains(this.projectEmojiPortalHost)) return this.projectEmojiPortalHost;
		const host = document.createElement("div");
		host.className = "sidebar-emoji-portal-host";
		document.body.appendChild(host);
		this.projectEmojiPortalHost = host;
		return host;
	}

	private renderProjectEmojiPickerPortal(): void {
		const host = this.ensureProjectEmojiPortalHost();
		if (!host) return;
		render(this.renderProjectEmojiPicker(), host);
	}

	/** workspace emoji 弹层同样走 body portal：.sidebar-single 的 backdrop-filter 会把 fixed 后代限制在侧栏内，backdrop 盖不住主内容区。 */
	private ensureWorkspaceEmojiPortalHost(): HTMLElement | null {
		if (typeof document === "undefined") return null;
		if (this.workspaceEmojiPortalHost && document.body.contains(this.workspaceEmojiPortalHost)) return this.workspaceEmojiPortalHost;
		const host = document.createElement("div");
		host.className = "sidebar-emoji-portal-host";
		document.body.appendChild(host);
		this.workspaceEmojiPortalHost = host;
		return host;
	}

	private renderWorkspaceEmojiPickerPortal(): void {
		const host = this.ensureWorkspaceEmojiPortalHost();
		if (!host) return;
		render(this.renderWorkspaceEmojiPicker(), host);
	}

	private renderSessionPiIcon(
		running = false,
		suspended = false,
		outcome: SessionRunOutcome | null = null,
	): TemplateResult | typeof nothing {
		const status = resolveSidebarSessionStatus(running, suspended, outcome);
		if (!status) return nothing;
		const stateTitle =
			status === "running"
				? t("sidebar.session.running")
				: status === "suspended"
					? t("sidebar.session.suspended")
					: status === "completed"
						? t("sidebar.session.completed")
						: t("sidebar.session.failed");
		if (status === "completed") {
			return html`
				<span class="sidebar-session-pi completed" title=${stateTitle} role="img" aria-label=${stateTitle}>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="8" cy="8" r="5.7"></circle>
						<path d="m5.2 8.1 1.8 1.8 3.9-4"></path>
					</svg>
				</span>
			`;
		}
		if (status === "failed") {
			return html`
				<span class="sidebar-session-pi failed" title=${stateTitle} role="img" aria-label=${stateTitle}>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="8" cy="8" r="5.7"></circle>
						<path d="m6 6 4 4M10 6l-4 4"></path>
					</svg>
				</span>
			`;
		}
		return html`
			<span class="sidebar-session-pi ${status}" title=${stateTitle} role="img" aria-label=${stateTitle}>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M3.3 3.3H10.3V8H8V10.3H5.7V12.7H3.3Z"></path>
					<path d="M10.3 8H12.7V12.7H10.3Z"></path>
				</svg>
			</span>
		`;
	}

	/** fork 分支会话的分叉图标（行内标记，配合嵌套缩进使用）。 */
	private renderSessionForkIcon(): TemplateResult {
		return html`
			<span class="sidebar-session-fork" title=${t("sidebar.session.forkBadge")} aria-hidden="true">
				<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.3"></circle><circle cx="12" cy="3.5" r="1.3"></circle><circle cx="8" cy="12.5" r="1.3"></circle><path d="M4 4.8v1.4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4.8"></path><path d="M8 8.2v3"></path></svg>
			</span>
		`;
	}

	/** 分支会话显示名：保证带「分叉-」前缀（用户重命名掉前缀时补上）。 */
	private forkChildDisplayName(session: SidebarSession): string {
		const prefix = t("sidebar.session.forkPrefix");
		return session.name.startsWith(prefix) ? session.name : `${prefix}${session.name}`;
	}

	private renderProjectMenu(project: Project): TemplateResult {
		return html`
			<div class="sidebar-project-menu" @click=${(e: Event) => e.stopPropagation()}>
				<button @click=${() => void this.renameProject(project.id)}>${t("sidebar.project.rename")}</button>
				<button @click=${(event: MouseEvent) => this.openProjectEmojiPicker(project.id, event)}>${t("sidebar.project.changeEmoji")}</button>
				<div class="sidebar-project-menu-divider"></div>
				<button @click=${() => this.removeProject(project.id)}>${t("sidebar.project.remove")}</button>
			</div>
		`;
	}

	private renderChronologicalProjectsMode(projects: Project[]): TemplateResult {
		const rows = this.chronologicalSessions(projects);
		// fork 子项判定：父会话已渲染（嵌套重排保证父在子前）才按子项缩进显示。
		const renderedChronoPaths = new Set<string>();
		if (rows.length === 0) {
			if (this.query.trim()) {
				return html`<div class="sidebar-empty">${t("sidebar.session.noMatch")}</div>`;
			}
			return html`<div class="sidebar-empty">${this.sessionShow === "relevant" ? t("sidebar.session.emptyRelevant") : t("sidebar.session.empty")}</div>`;
		}

		return html`
			<div class="sidebar-chrono-list">
				${rows.map(({ project, session }, index) => {
					const ts = this.sessionSortBy === "created" ? session.createdAt || session.modifiedAt : session.modifiedAt || session.createdAt;
					const normalizedSessionPath = normalizePath(session.path);
					const activeSession = normalizedSessionPath
						? normalizedSessionPath === this.activeSessionPath
						: Boolean(session.transient && this.activeProjectId === project.id && !this.activeSessionPath);
					const runningSession = this.runningSessionPaths.has(normalizedSessionPath);
					const suspendedSession = !runningSession && this.suspendedSessionPaths.has(normalizedSessionPath);
					const sessionRunOutcome = this.sessionRunOutcomes.get(normalizedSessionPath) ?? null;
					const attentionMessage = this.attentionSessionMessages.get(normalizedSessionPath) ?? null;
					const pinnedSession = this.isSessionPinned(session.path);
					const prevPinned = index > 0 ? this.isSessionPinned(rows[index - 1]?.session.path ?? "") : false;
					const showPinnedDivider = prevPinned && !pinnedSession;
					const forkParentKey = session.parentSessionPath ? normalizePath(session.parentSessionPath) : "";
					const isForkChild = Boolean(forkParentKey) && renderedChronoPaths.has(forkParentKey);
					if (normalizedSessionPath) renderedChronoPaths.add(normalizedSessionPath);
					return html`
						${showPinnedDivider ? html`<div class="sidebar-session-pin-divider" role="separator" aria-hidden="true"></div>` : nothing}
						<button
							class="sidebar-chrono-row ${activeSession ? "active-session" : ""} ${pinnedSession ? "pinned" : ""} ${isForkChild ? "sidebar-chrono-row--fork" : ""}"
							@click=${() => {
								if (session.transient && !session.path) return;
								this.selectProject(project.id, false);
								this.activeSessionPath = normalizePath(session.path);
								this.activeFilePath = null;
								this.render();
								this.onSessionSelect?.(project.id, session.path, session.name);
							}}
							@pointerenter=${() => this.handleSessionPrewarmEnter(project.id, session.path)}
							@pointerleave=${() => this.handleSessionPrewarmLeave(project.id, session.path)}
							@pointerdown=${() => this.handleSessionPrewarmDown(project.id, session.path)}
							@contextmenu=${(e: MouseEvent) => this.handleSessionContextMenu(e, project, session)}
							title=${session.path}
						>
							<span class="sidebar-project-emoji-inline">${normalizeProjectEmoji(project.emoji)}</span>
							<span class="sidebar-session-leading">
								${this.renderSessionPiIcon(runningSession, suspendedSession, sessionRunOutcome)}
							</span>
							<span class="sidebar-chrono-main">
								<span class="sidebar-chrono-name sidebar-session-name ${attentionMessage ? "needs-attention" : ""}">${isForkChild ? this.renderSessionForkIcon() : nothing}${isForkChild ? this.forkChildDisplayName(session) : session.name}</span>
								<span class="sidebar-chrono-project">${project.name}</span>
							</span>
							<span class="sidebar-chrono-time">${formatRelativeDate(ts)}</span>
						</button>
					`;
				})}
			</div>
		`;
	}

	private activateSession(project: Project, session: SidebarSession): void {
		if (session.transient && !session.path) return;
		this.selectProject(project.id, false);
		this.activeSessionPath = normalizePath(session.path);
		this.activeFilePath = null;
		this.render();
		this.onSessionSelect?.(project.id, session.path, session.name);
	}

	private renderSessionRowActions(project: Project, session: SidebarSession): TemplateResult | typeof nothing {
		if (!normalizePath(session.path)) return nothing;
		const pinned = this.isSessionPinned(session.path);
		const deleting = this.deletingSessionPaths.has(normalizePath(session.path));
		return html`
			<div class="sidebar-session-actions">
				<button
					class="sidebar-session-action pin ${pinned ? "active" : ""}"
					title=${pinned ? t("sidebar.session.unpin") : t("sidebar.session.pin")}
					@click=${(e: Event) => {
						e.stopPropagation();
						this.toggleSessionPinned(session.path);
						this.render();
					}}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M5 2.5h6v2l-1.2 3 2.7 2v1H3.5v-1l2.7-2-1.2-3z" />
						<path d="M8 10.5v3" />
					</svg>
				</button>
				<button
					class="sidebar-session-action danger"
					title=${t("sidebar.session.delete")}
					?disabled=${deleting}
					@click=${(e: Event) => {
						e.stopPropagation();
						void this.confirmDeleteSession(project, session);
					}}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M3 4.5h10" />
						<path d="M6.5 4.5V3.4c0-.2.2-.4.4-.4h2.2c.2 0 .4.2.4.4v1.1" />
						<path d="M4.5 4.5l.5 8.1c0 .3.2.4.4.4h5.2c.2 0 .4-.2.4-.4l.5-8.1" />
						<path d="M6.7 7v3.8" />
						<path d="M9.3 7v3.8" />
					</svg>
				</button>
			</div>
		`;
	}

	private renderPinnedSessionRow(project: Project, session: SidebarSession): TemplateResult {
		const normalizedSessionPath = normalizePath(session.path);
		const activeSession = normalizedSessionPath === this.activeSessionPath;
		const runningSession = this.runningSessionPaths.has(normalizedSessionPath);
		const suspendedSession = !runningSession && this.suspendedSessionPaths.has(normalizedSessionPath);
		const sessionRunOutcome = this.sessionRunOutcomes.get(normalizedSessionPath) ?? null;
		const attentionMessage = this.attentionSessionMessages.get(normalizedSessionPath) ?? null;
		const sessionRenameActive =
			Boolean(this.sessionRenameDraft) &&
			this.sessionRenameDraft?.projectId === project.id &&
			this.sessionRenameDraft?.sessionPath === normalizedSessionPath;
		return html`
			<div class="sidebar-session-row sidebar-pinned-session-row ${activeSession ? "active" : ""} pinned">
				<span class="sidebar-session-leading">
					${this.renderSessionPiIcon(runningSession, suspendedSession, sessionRunOutcome)}
				</span>
				<button
					class="sidebar-session ${activeSession ? "active-session" : ""}"
					@click=${() => {
						if (sessionRenameActive) return;
						this.activateSession(project, session);
					}}
					@pointerenter=${() => this.handleSessionPrewarmEnter(project.id, session.path)}
					@pointerleave=${() => this.handleSessionPrewarmLeave(project.id, session.path)}
					@pointerdown=${() => this.handleSessionPrewarmDown(project.id, session.path)}
					@contextmenu=${(e: MouseEvent) => this.handleSessionContextMenu(e, project, session)}
					title=${session.path}
				>
					${sessionRenameActive
						? html`
							<input
								class="sidebar-inline-input sidebar-session-inline-input"
								.value=${this.sessionRenameDraft?.value ?? session.name}
								@click=${(e: Event) => e.stopPropagation()}
								@input=${(e: Event) => {
									const target = e.target as HTMLInputElement;
									if (!this.sessionRenameDraft) return;
									this.sessionRenameDraft = { ...this.sessionRenameDraft, value: target.value };
								}}
								@keydown=${(e: KeyboardEvent) => {
									if (e.key === "Enter") {
										e.preventDefault();
										this.commitSessionRename(project, session);
										return;
									}
									if (e.key === "Escape") {
										e.preventDefault();
										this.cancelSessionRename();
									}
								}}
								@blur=${() => this.commitSessionRename(project, session)}
								autofocus
							/>
						`
						: html`
							<span class="sidebar-pinned-session-main">
								<span class="sidebar-session-name ${attentionMessage ? "needs-attention" : ""}">${session.name}</span>
								<span class="sidebar-pinned-session-project">${project.name}</span>
							</span>
						`}
				</button>
				${sessionRenameActive ? nothing : this.renderSessionRowActions(project, session)}
			</div>
		`;
	}

	private renderPinnedSessionsSection(projects: Project[]): TemplateResult | typeof nothing {
		const pinned = this.collectPinnedSessions(projects);
		if (pinned.length === 0) return nothing;
		const collapsed = this.pinnedSectionCollapsed;
		return html`
			<div class="sidebar-pinned-section">
				<button
					class="sidebar-pinned-header"
					title=${collapsed ? t("sidebar.pinned.expand") : t("sidebar.pinned.collapse")}
					@click=${() => this.togglePinnedSectionCollapsed()}
				>
					<span class="sidebar-pinned-chevron" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
					<span class="sidebar-pinned-title">${t("sidebar.pinned.title")}</span>
				</button>
				${collapsed
					? nothing
					: html`
						<div class="sidebar-pinned-list">
							${pinned.map(({ project, session }) => this.renderPinnedSessionRow(project, session))}
						</div>
					`}
			</div>
		`;
	}

	private renderProjectListToggle(totalProjects: number): TemplateResult | typeof nothing {
		if (this.query.trim()) return nothing;
		if (totalProjects <= PROJECT_LIST_COLLAPSED_LIMIT) return nothing;
		const expanded = this.projectListExpanded;
		return html`
			<button
				class="sidebar-project-list-toggle"
				title=${expanded ? t("sidebar.projectList.collapse") : t("sidebar.projectList.expand")}
				@click=${() => this.toggleProjectListExpanded()}
			>
				<span class="sidebar-project-list-toggle-chevron" aria-hidden="true">${expanded ? "▴" : "▾"}</span>
				<span>${expanded ? t("sidebar.projectList.collapse") : t("sidebar.projectList.expand")}</span>
			</button>
		`;
	}

	private renderProjectsMode(): TemplateResult {
		const projects = this.filteredProjects();
		if (this.projects.length === 0) {
			return html`<div class="sidebar-empty">${t("sidebar.project.empty")}</div>`;
		}
		if (projects.length === 0) {
			return html`<div class="sidebar-empty">${t("sidebar.project.noMatch")}</div>`;
		}
		if (this.sessionOrganize === "chronological") {
			return this.renderChronologicalProjectsMode(projects);
		}

		this.ensurePinnedSessionsHydrated();
		const collapseProjectList =
			!this.query.trim() &&
			!this.projectListExpanded &&
			projects.length > PROJECT_LIST_COLLAPSED_LIMIT;
		const listedProjects = collapseProjectList ? projects.slice(0, PROJECT_LIST_COLLAPSED_LIMIT) : projects;

		return html`
			${this.renderPinnedSessionsSection(projects)}
			<div class="sidebar-project-list">
				${listedProjects.map((project, index) => {
					const active = this.activeProjectId === project.id;
					const menuOpen = this.openProjectMenuId === project.id;
					const sessions = this.visibleSessions(project).filter((session) => !this.isSessionPinned(session.path));
					// fork 子项判定：父会话已渲染（嵌套重排保证父在子前）才按子项缩进显示。
					const renderedSessionPaths = new Set<string>();
					const unreadCount = this.getProjectAttentionCount(project);
					const showBlockingSessionLoad = project.loadingSessions && sessions.length === 0;
					const showInlineSessionRefresh = project.loadingSessions && sessions.length > 0;
					const dragOver = project.id === this.projectDragOverId && this.draggingProjectId !== project.id;
					return html`
						<div class="sidebar-project-row ${active ? "active" : ""} ${menuOpen ? "menu-open" : ""} ${dragOver ? "drag-over" : ""} ${project.id === this.draggingProjectId ? "dragging" : ""}" data-project-id=${project.id}>
							<div class="sidebar-project-head">
								<div class="sidebar-project-main-wrap">
									<button
										class="sidebar-project-indicator-btn"
										title=${project.expanded ? t("sidebar.actions.collapse") : t("sidebar.actions.expand")}
										@click=${(e: Event) => {
											e.stopPropagation();
											this.toggleProject(project.id);
										}}
									>
										${this.renderProjectMarker(project)}
										<span class="sidebar-project-toggle-icon">${project.expanded ? "▾" : "▸"}</span>
									</button>
									<button
										class="sidebar-project-main"
										@pointerdown=${(e: PointerEvent) => this.beginProjectPointerDrag(e, project.id)}
										@click=${() => {
											if (this.shouldSuppressProjectMainClick(project.id)) return;
											this.handleProjectMainClick(project.id);
										}}
										title=${project.path}
									>
										<span class="sidebar-project-title-wrap">
											<span class="sidebar-project-title">${project.name}</span>
											${unreadCount > 0
												? html`<span class="sidebar-project-unread-count" title=${t("sidebar.project.unreadTitle", { count: unreadCount })}>${unreadCount}</span>`
												: nothing}
										</span>
									</button>
								</div>
								<div class="sidebar-project-row-actions ${menuOpen ? "open" : ""}">
									<button
										class="sidebar-project-action"
										title=${t("sidebar.actions.newSession")}
										@click=${(e: Event) => {
											e.stopPropagation();
											this.selectProject(project.id, false);
											this.onNewSessionInProject?.({ id: project.id, name: project.name, path: project.path });
										}}
									>
										<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v9h-10z"/><path d="M6.2 8h3.6"/><path d="M8 6.2v3.6"/></svg>
									</button>
									<button
										class="sidebar-project-action menu"
										title=${t("sidebar.actions.projectActions")}
										@click=${(e: Event) => {
											e.stopPropagation();
											this.toggleProjectMenu(project.id);
										}}
									>
										<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12" cy="8" r="1.1"/></svg>
									</button>
									${showInlineSessionRefresh ? html`<span class="sidebar-project-inline-status">${t("sidebar.actions.refreshing")}</span>` : nothing}
									${menuOpen ? this.renderProjectMenu(project) : nothing}
								</div>
							</div>

							${project.expanded
								? html`
									<div class="sidebar-project-sessions">
										${project.pathExists === false
											? html`
												<div class="sidebar-warning">
													${t("sidebar.project.pathMissing")}
													<button @click=${() => this.relinkProject(project.id)}>${t("sidebar.project.relink")}</button>
												</div>
											`
											: nothing}
										${showBlockingSessionLoad
											? html`<div class="ui-loading compact" role="status" aria-label=${t("sidebar.session.loading")}><span class="ui-loading-spinner small"></span></div>`
											: sessions.length === 0
												? html`<div class="sidebar-empty">${this.sessionShow === "relevant" ? t("sidebar.session.emptyRelevant") : t("sidebar.session.empty")}</div>`
												: sessions.map(
                                                    (session) => {
                                                        const normalizedSessionPath = normalizePath(session.path);
                                                        const activeSession = normalizedSessionPath
                                                            ? normalizedSessionPath === this.activeSessionPath
                                                            : Boolean(session.transient && this.activeProjectId === project.id && !this.activeSessionPath);
                                                        const runningSession = this.runningSessionPaths.has(normalizedSessionPath);
                                                        const suspendedSession = !runningSession && this.suspendedSessionPaths.has(normalizedSessionPath);
                                                        const sessionRunOutcome = this.sessionRunOutcomes.get(normalizedSessionPath) ?? null;
                                                        const attentionMessage = this.attentionSessionMessages.get(normalizedSessionPath) ?? null;
                                                        const sessionRenameActive =
                                                            Boolean(this.sessionRenameDraft) &&
                                                            this.sessionRenameDraft?.projectId === project.id &&
                                                            this.sessionRenameDraft?.sessionPath === normalizePath(session.path);
                                                        const forkParentKey = session.parentSessionPath ? normalizePath(session.parentSessionPath) : "";
                                                        const isForkChild = Boolean(forkParentKey) && renderedSessionPaths.has(forkParentKey);
                                                        if (normalizedSessionPath) renderedSessionPaths.add(normalizedSessionPath);
                                                        return html`
                                                            <div class="sidebar-session-row ${activeSession ? "active" : ""} ${isForkChild ? "sidebar-session-row--fork" : ""}">
                                                                <span class="sidebar-session-leading">
                                                                    ${this.renderSessionPiIcon(runningSession, suspendedSession, sessionRunOutcome)}
                                                                </span>
                                                                <button
                                                                    class="sidebar-session ${activeSession ? "active-session" : ""}"
                                                                    @click=${() => {
                                                                        if (sessionRenameActive) return;
                                                                        if (session.transient && !session.path) return;
                                                                        this.selectProject(project.id, false);
                                                                        this.activeSessionPath = normalizePath(session.path);
                                                                        this.activeFilePath = null;
                                                                        this.render();
                                                                        this.onSessionSelect?.(project.id, session.path, session.name);
                                                                    }}
                                                                    @pointerenter=${() => this.handleSessionPrewarmEnter(project.id, session.path)}
                                                                    @pointerleave=${() => this.handleSessionPrewarmLeave(project.id, session.path)}
                                                                    @pointerdown=${() => this.handleSessionPrewarmDown(project.id, session.path)}
                                                                    @contextmenu=${(e: MouseEvent) => this.handleSessionContextMenu(e, project, session)}
                                                                    title=${session.path}
                                                                >
                                                                    ${sessionRenameActive
                                                                        ? html`
                                                                            <input
                                                                                class="sidebar-inline-input sidebar-session-inline-input"
                                                                                .value=${this.sessionRenameDraft?.value ?? session.name}
                                                                                @click=${(e: Event) => e.stopPropagation()}
                                                                                @input=${(e: Event) => {
                                                                                    const target = e.target as HTMLInputElement;
                                                                                    if (!this.sessionRenameDraft) return;
                                                                                    this.sessionRenameDraft = { ...this.sessionRenameDraft, value: target.value };
                                                                                }}
                                                                                @keydown=${(e: KeyboardEvent) => {
                                                                                    if (e.key === "Enter") {
                                                                                        e.preventDefault();
                                                                                        this.commitSessionRename(project, session);
                                                                                        return;
                                                                                    }
                                                                                    if (e.key === "Escape") {
                                                                                        e.preventDefault();
                                                                                        this.cancelSessionRename();
                                                                                    }
                                                                                }}
                                                                                @blur=${() => this.commitSessionRename(project, session)}
                                                                                autofocus
                                                                            />
                                                                        `
                                                                        : html`<span class="sidebar-session-name ${attentionMessage ? "needs-attention" : ""}">${isForkChild ? this.renderSessionForkIcon() : nothing}${isForkChild ? this.forkChildDisplayName(session) : session.name}</span>`}
                                                                </button>
                                                                ${sessionRenameActive ? nothing : this.renderSessionRowActions(project, session)}
                                                            </div>
                                                        `;
                                                    },
                                                  )}
									</div>
								`
								: nothing}
						</div>
					`;
				})}
			</div>
			${this.renderProjectListToggle(projects.length)}
		`;
	}

	private renderFilesMode(): TemplateResult {
		if (this.projects.length === 0) {
			return html`<div class="sidebar-empty">${t("sidebar.project.empty")}</div>`;
		}

		const projects = this.filteredProjects(false);
		if (projects.length === 0) {
			return html`<div class="sidebar-empty">${t("sidebar.project.noMatchFiles")}</div>`;
		}

		const query = this.query.trim().toLowerCase();

		return html`
			<div class="sidebar-project-list">
				${projects.map((project, index) => {
					const active = this.activeProjectId === project.id;
					const menuOpen = this.openProjectMenuId === project.id;
					const unreadCount = this.getProjectAttentionCount(project);
					const loading = this.loadingFileTreeForProject.has(project.id);
					const showInlineSessionRefresh = project.loadingSessions && project.sessions.length > 0;
					const nodes = this.fileTrees.get(project.id) ?? [];
					const fileTreeError = this.fileTreeErrors.get(project.id) ?? null;
					const hasMatchingNode = nodes.some((node) => this.nodeMatchesQuery(node, query));
					const dragOver = project.id === this.projectDragOverId && this.draggingProjectId !== project.id;

					return html`
						<div class="sidebar-project-row ${active ? "active" : ""} ${menuOpen ? "menu-open" : ""} ${dragOver ? "drag-over" : ""} ${project.id === this.draggingProjectId ? "dragging" : ""}" data-project-id=${project.id}>
							<div class="sidebar-project-head">
								<div class="sidebar-project-main-wrap">
									<button
										class="sidebar-project-indicator-btn"
										title=${project.expanded ? t("sidebar.actions.collapse") : t("sidebar.actions.expand")}
										@click=${(e: Event) => {
											e.stopPropagation();
											this.toggleProject(project.id);
										}}
									>
										${this.renderProjectMarker(project)}
										<span class="sidebar-project-toggle-icon">${project.expanded ? "▾" : "▸"}</span>
									</button>
									<button
										class="sidebar-project-main"
										@pointerdown=${(e: PointerEvent) => this.beginProjectPointerDrag(e, project.id)}
										@click=${() => {
											if (this.shouldSuppressProjectMainClick(project.id)) return;
											this.handleProjectMainClick(project.id);
										}}
										title=${project.path}
									>
										<span class="sidebar-project-title-wrap">
											<span class="sidebar-project-title">${project.name}</span>
											${unreadCount > 0
												? html`<span class="sidebar-project-unread-count" title=${t("sidebar.project.unreadTitle", { count: unreadCount })}>${unreadCount}</span>`
												: nothing}
										</span>
									</button>
								</div>
								<div class="sidebar-project-row-actions ${menuOpen ? "open" : ""}">
									<button
										class="sidebar-project-action"
										title=${t("sidebar.actions.newFile")}
										@click=${(e: Event) => {
											e.stopPropagation();
											this.selectProject(project.id, false);
											this.onNewFileInProject?.({ id: project.id, name: project.name, path: project.path });
										}}
									>
										<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h6l2 2v8.3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.3a1 1 0 0 1 1-1z"/><path d="M10 2.5v2.2h2"/><path d="M8 6.2v3.6"/><path d="M6.2 8h3.6"/></svg>
									</button>
									<button
										class="sidebar-project-action menu"
										title=${t("sidebar.actions.projectActions")}
										@click=${(e: Event) => {
											e.stopPropagation();
											this.toggleProjectMenu(project.id);
										}}
									>
										<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12" cy="8" r="1.1"/></svg>
									</button>
									${showInlineSessionRefresh ? html`<span class="sidebar-project-inline-status">${t("sidebar.actions.refreshing")}</span>` : nothing}
									${menuOpen ? this.renderProjectMenu(project) : nothing}
								</div>
							</div>

							${project.expanded
								? html`
									<div class="sidebar-project-files">
										${project.pathExists === false
											? html`
												<div class="sidebar-warning">
													${t("sidebar.project.pathMissing")}
													<button @click=${() => this.relinkProject(project.id)}>${t("sidebar.project.relink")}</button>
												</div>
											`
											 : loading
												? html`<div class="ui-loading compact" role="status" aria-label=${t("sidebar.file.loading")}><span class="ui-loading-spinner small"></span></div>`
												: fileTreeError
													? html`<div class="sidebar-file-group-empty">${t("sidebar.file.readError")}</div>`
													: nodes.length === 0
														? html`<div class="sidebar-file-group-empty">${t("sidebar.file.emptyProject")}</div>`
														: !hasMatchingNode
														? html`<div class="sidebar-file-group-empty">${t("sidebar.file.noMatch")}</div>`
														: html`
															<div class="sidebar-files-tree">
																${[...nodes]
																	.sort((a, b) => this.compareFileNodes(a, b))
																	.map((node) => this.renderFileNode(project.id, node, query))}
															</div>
														`}
									</div>
								`
								: nothing}
						</div>
					`;
				})}
			</div>
		`;
	}

	private renderSettingsShellBody(): TemplateResult {
		if (this.settingsNavItems.length === 0) {
			return html`<div class="ui-loading compact" role="status" aria-label=${t("sidebar.settings.loadingSections")}><span class="ui-loading-spinner small"></span></div>`;
		}

		return html`
			<div class="sidebar-settings-nav-list">
				${this.settingsNavItems.map((item) => {
					const active = item.id === this.activeSettingsNavId;
					return html`
						<button
							class="sidebar-settings-nav-item ${active ? "active" : ""}"
							?disabled=${Boolean(item.disabled)}
							@click=${() => {
								if (item.disabled) return;
								this.onSettingsNavSelect?.(item.id);
							}}
						>
							<span class="sidebar-settings-nav-label">${item.label}</span>
							${item.description ? html`<span class="sidebar-settings-nav-desc">${item.description}</span>` : nothing}
						</button>
					`;
				})}
			</div>
		`;
	}

	private renderModeBody(): TemplateResult {
		if (this.settingsShellActive) return this.renderSettingsShellBody();
		if (this.mode === "files") return this.renderFilesMode();
		return this.renderProjectsMode();
	}

	private handleRefreshActive(): void {
		const active = this.getActiveProject();
		if (!active) return;
		const activeProject = this.projects.find((project) => project.id === active.id) ?? null;
		void this.refreshProjectPathStatus(active.id);
		void this.loadSessionsForProject(active.id, { silent: Boolean(activeProject?.sessions.length) });
		if (this.mode === "files") void this.ensureFileTreeForProject(active.id, true);
	}


	private renderModeIcon(mode: SidebarMode): TemplateResult {
		if (mode === "projects") {
			return html`
				<svg class="sidebar-mode-svg" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M3 3.5h7v7h-7z" />
					<path d="M6 6.5h7v7h-7z" />
				</svg>
			`;
		}

		return html`
			<svg class="sidebar-mode-svg" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M4 2.8h6l2 2v8.4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-9.4a1 1 0 0 1 1-1z" />
				<path d="M10 2.8v2.4h2" />
				<path d="M5.8 8h4.4" />
				<path d="M5.8 10.2h4.4" />
			</svg>
		`;
	}

	private renderModeSwitch(): TemplateResult {
		const modes: Array<{ id: SidebarMode; label: string }> = [
			{ id: "projects", label: t("sidebar.modes.sessions") },
			{ id: "files", label: t("sidebar.modes.files") },
		];

		return html`${modes.map(
			(mode) => html`
				<button class="sidebar-mode-btn ${this.mode === mode.id ? "active" : ""}" title=${mode.label} @click=${() => this.setMode(mode.id)}>
					${this.renderModeIcon(mode.id)}<span class="sidebar-mode-btn-label">${mode.label}</span>
				</button>
			`,
		)}`;
	}

	render(): void {
		this.container.classList.toggle("collapsed", this.collapsed);
		const hasActiveProject = Boolean(this.getActiveProject());

		const template = html`
			<div
				class="sidebar-single"
				@wheel=${(e: WheelEvent) => this.handleSidebarWheel(e)}
				@click=${(e: Event) => {
					const target = e.target instanceof Element ? e.target : null;
					let changed = false;

					if (this.openProjectMenuId && !target?.closest(".sidebar-project-menu") && !target?.closest(".sidebar-project-action.menu")) {
						this.openProjectMenuId = null;
						changed = true;
					}

					if (this.modeFilterMenuOpen && !target?.closest(".sidebar-mode-filter-menu") && !target?.closest(".sidebar-mode-filter-btn")) {
						this.modeFilterMenuOpen = false;
						changed = true;
					}

					if ((this.pendingProjectDragId || this.draggingProjectId) && !target?.closest(".sidebar-project-list")) {
						this.cancelProjectPointerDrag(false);
						changed = true;
					}

					if ((this.pendingWorkspaceDragId || this.draggingWorkspaceId) && !target?.closest(".sidebar-workspace-dock")) {
						this.cancelWorkspacePointerDrag(false);
						changed = true;
					}

					if (
						this.workspaceRenameDraft &&
						!target?.closest(".sidebar-workspace-title-input")
					) {
						this.commitWorkspaceRename();
						return;
					}

					if (
						this.workspaceCreateDialogOpen &&
						!target?.closest(".sidebar-space-dialog") &&
						!target?.closest(".sidebar-workspace-dock-add")
					) {
						this.closeWorkspaceCreateDialog(false);
						changed = true;
					}

					if (
						this.workspaceCreateEmojiPickerOpen &&
						!target?.closest(".sidebar-space-emoji-picker") &&
						!target?.closest(".sidebar-space-emoji-trigger")
					) {
						this.workspaceCreateEmojiPickerOpen = false;
						this.workspaceCreateEmojiQuery = "";
						changed = true;
					}

					if (
						this.emojiPickerWorkspaceId &&
						!target?.closest(".workspace-emoji-picker") &&
						!target?.closest(".sidebar-workspace-header-emoji")
					) {
						this.closeWorkspaceEmojiPicker(false);
						changed = true;
					}

					if (
						this.projectEmojiPickerProjectId &&
						!target?.closest(".project-emoji-picker")
					) {
						this.closeProjectEmojiPicker(false);
						changed = true;
					}

					if (this.contextMenu && !target?.closest(".sidebar-context-menu")) {
						this.closeContextMenu(false);
						changed = true;
					}

					if (changed) this.render();
				}}
			>
				${this.renderWorkspaceWindowRow()}

				<div class="sidebar-topbar" data-tauri-drag-region>
					${this.settingsShellActive ? nothing : this.renderWorkspaceHeader()}
					${this.settingsShellActive
						? html`
							<div class="sidebar-settings-shell-header">
								<button class="sidebar-settings-back-btn" @click=${() => this.onCloseSettings?.()}>
									<span class="sidebar-settings-back-arrow" aria-hidden="true">←</span>
									<span>${t("common.back")}</span>
								</button>
								<div class="sidebar-mode-current">${t("sidebar.settings.label")}</div>
								<div class="sidebar-settings-shell-subtitle">${t("sidebar.settings.chooseSection")}</div>
							</div>
						`
						: html`
							<div class="sidebar-top-actions sidebar-top-actions-primary">
								<button
									class="sidebar-top-action-btn"
									title=${this.mode === "files" ? t("sidebar.actions.newFile") : t("sidebar.actions.newSession")}
									?disabled=${!hasActiveProject}
									@click=${() => void this.triggerPrimaryTopAction()}
								>
									<span>${this.mode === "files" ? t("sidebar.actions.newFile") : t("sidebar.actions.newSession")}</span>
								</button>
								<button class="sidebar-top-action-btn ${this.packagesOpen ? "active" : ""}" title=${t("sidebar.packages.label")} @click=${() => this.onTogglePackages?.()}>
									<span>${t("sidebar.packages.label")}</span>
								</button>
							</div>
						`}
				</div>

				<div class="sidebar-section-divider" aria-hidden="true"></div>

				${this.settingsShellActive
					? nothing
					: html`
						<div class="sidebar-mode-row">
							<div class="sidebar-mode-meta">
								<div class="sidebar-mode-switch">
									${this.renderModeSwitch()}
								</div>
							</div>
							<div class="sidebar-mode-actions">
								<button class="sidebar-mode-create-btn" title=${t("sidebar.actions.addProject")} @click=${() => void this.handleModeCreateAction()}>
									<svg class="sidebar-icon-svg" viewBox="0 0 16 16" aria-hidden="true">
										<path d="M2.5 4.5h4l1.3 1.5h5.7v5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" />
										<path d="M8 7.2v3.6" />
										<path d="M6.2 9h3.6" />
									</svg>
								</button>
								<button class="sidebar-mode-filter-btn" title=${this.mode === "projects" ? t("sidebar.actions.organizeSessions") : t("sidebar.actions.filterFiles")} @click=${() => this.toggleModeFilterMenu()}>
									<svg class="sidebar-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10"/><path d="M5 8h6"/><path d="M7 12h2"/></svg>
								</button>
								${this.renderModeFilterMenu()}
							</div>
						</div>
					`}

				<div class="sidebar-panel-body ${this.settingsShellActive ? "sidebar-panel-body-settings" : ""}">
					${this.renderModeBody()}
				</div>

				<div class="sidebar-footer">
					${this.renderWorkspaceDock()}
				</div>

				${this.renderContextMenu()}
				${this.renderSidebarNotice()}
			</div>
		`;

		render(template, this.container);
		this.renderWorkspaceCreateDialogPortal();
		this.renderProjectEmojiPickerPortal();
		this.renderWorkspaceEmojiPickerPortal();
		this.syncPopupGlobalListeners();
	}
}
