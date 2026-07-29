/**
 * Extension UI Handler - handles dialogs and notifications from pi extensions
 *
 * Extensions can request user interaction via:
 * - select: Choose from a list of options
 * - confirm: Yes/no confirmation
 * - input: Free-form text input
 * - editor: Multi-line text editor
 * - notify: Display a notification (fire-and-forget)
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Options as DesktopNotificationOptions, isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { html, nothing, render, type TemplateResult } from "lit";
import { t } from "../i18n/index.js";
import { rpcBridge } from "../rpc/bridge.js";
import {
	mapExtensionStatusText,
	parseMcpConnectionState,
	type McpConnectionPhase,
	type McpConnectionState,
} from "./extension-status-map.js";

/**
 * Explicit desktop capability contract for extension UI requests.
 * Keep this surface small and grow it intentionally.
 */
export const SUPPORTED_EXTENSION_UI_METHODS = [
	"select",
	"confirm",
	"input",
	"editor",
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
] as const;

export type UiMethod = (typeof SUPPORTED_EXTENSION_UI_METHODS)[number];

export interface ExtensionUiRequest {
	id: string;
	method: UiMethod;
	/** 来源 runtime 标识（main.ts 转发 extension_ui 事件时塞入）；回复按它路由回来源 bridge。 */
	runtimeId?: string;
	title?: string;
	message?: string;
	text?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
	notifyTargetWorkspaceId?: string;
	notifyTargetTabId?: string;
	notifyTargetSessionPath?: string;
	notifyTargetWorkspaceLabel?: string;
	notifyTargetSessionLabel?: string;
}

export function isSupportedExtensionUiMethod(value: unknown): value is UiMethod {
	return typeof value === "string" && (SUPPORTED_EXTENSION_UI_METHODS as readonly string[]).includes(value);
}

function normalizeExtensionUiMethod(value: unknown): UiMethod | null {
	if (isSupportedExtensionUiMethod(value)) return value;
	if (typeof value !== "string") return null;
	const raw = value.trim();
	if (!raw) return null;
	switch (raw) {
		case "set_status":
			return "setStatus";
		case "set_widget":
			return "setWidget";
		case "set_title":
			return "setTitle";
		case "setEditorText":
			return "set_editor_text";
		default:
			return null;
	}
}

export function normalizeExtensionUiRequest(raw: Record<string, unknown>): ExtensionUiRequest | null {
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	const method = normalizeExtensionUiMethod(raw.method);
	if (!id || !method) {
		return null;
	}
	const runtimeId = typeof raw.runtimeId === "string" ? raw.runtimeId.trim() : "";
	return {
		...(raw as Partial<ExtensionUiRequest>),
		id,
		method,
		runtimeId: runtimeId || undefined,
	};
}

function sanitizeUiStatusText(text: string): string {
	return text
		.replace(/(?:\u001b|�)\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/ +/g, " ")
		.trim();
}

function shouldSuppressUiStatusText(text: string): boolean {
	if (!text) return true;
	const normalized = text.toLowerCase();
	if (/^(?:💰|\$|usd|eur|dkk|kr|€|£|¥)?\s*\$?\s*\d+(?:[\.,]\d+)?\s*(?:usd|eur|dkk|kr)?$/i.test(text)) {
		return true;
	}
	if (/(?:↑\s*\d|↓\s*\d|(?:^|\s)r\d|(?:^|\s)w\d|\(sub\)|\(auto\)|\/\d+[km]|\bthinking\b)/i.test(normalized)) {
		return true;
	}
	return false;
}

function shouldSuppressUiStatusKey(key: string): boolean {
	const normalized = key.trim().toLowerCase();
	if (!normalized) return false;
	if (normalized === "oqto_title_changed") return true;
	if (normalized === "smart-voice-notify") return true;
	if (normalized.includes("voice-notify")) return true;
	if (/(^|[_.-])title([_.-])?changed($|[_.-])/.test(normalized)) return true;
	if (normalized.includes("session.title_changed")) return true;
	return false;
}

function joinFsPath(base: string, child: string): string {
	const normalizedBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedChild = child.replace(/\\/g, "/").replace(/^\/+/, "");
	return normalizedBase ? `${normalizedBase}/${normalizedChild}` : normalizedChild;
}

function toFileUrl(path: string): string {
	const normalizedPath = path.replace(/\\/g, "/");
	if (/^[a-zA-Z]+:\/\//.test(normalizedPath)) return normalizedPath;
	if (normalizedPath.startsWith("/")) return `file://${normalizedPath}`;
	return `file:///${normalizedPath}`;
}

interface ExtensionUiFocusTracker {
	focused: boolean;
	initialized: boolean;
	subscribers: Set<(focused: boolean) => void>;
}

type WindowWithExtensionUiFocusTracker = typeof window & {
	__PI_DESKTOP_EXTENSION_UI_FOCUS_TRACKER__?: ExtensionUiFocusTracker;
};

function ensureExtensionUiFocusTrackerInitialized(): ExtensionUiFocusTracker | null {
	if (typeof window === "undefined" || typeof document === "undefined") return null;
	const win = window as WindowWithExtensionUiFocusTracker;
	let tracker = win.__PI_DESKTOP_EXTENSION_UI_FOCUS_TRACKER__;
	if (!tracker) {
		tracker = {
			focused: document.visibilityState !== "hidden" && document.hasFocus(),
			initialized: false,
			subscribers: new Set(),
		};
		win.__PI_DESKTOP_EXTENSION_UI_FOCUS_TRACKER__ = tracker;
	}
	if (!tracker.initialized) {
		const publish = (focused: boolean) => {
			if (tracker.focused === focused) return;
			tracker.focused = focused;
			for (const subscriber of tracker.subscribers) {
				subscriber(focused);
			}
		};
		window.addEventListener("focus", () => publish(true));
		window.addEventListener("blur", () => publish(false));
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				publish(false);
				return;
			}
			publish(document.hasFocus());
		});
		tracker.initialized = true;
	}
	return tracker;
}

export interface NotificationActionTarget {
	workspaceId?: string;
	tabId?: string;
	sessionPath?: string;
	workspaceLabel?: string;
	sessionLabel?: string;
}

/** MCP chip 弹层需要的服务器条目（由 main.ts 经 list_mcp_servers 提供）。 */
export interface McpChipServerInfo {
	name: string;
	/** "stdio" | "http" | "socket" | "unknown"，原样展示。 */
	transport: string;
	disabled: boolean;
	/**
	 * 单台服务器的真实连通性相位。当前数据源（list_mcp_servers）只提供配置、
	 * 不提供运行态，缺省时弹层按「状态未知（聚合信息）」中性展示，
	 * 不再把聚合相位套到每台服务器（MCP-01）。
	 */
	connectionState?: McpConnectionPhase;
}

/** 未决弹窗请求登记项：所有响应路径统一经 settle 出口（exactly-once）。 */
interface PendingUiRequest {
	runtimeId?: string;
	timeoutTimer: ReturnType<typeof setTimeout> | null;
	settle: (data: Record<string, unknown>) => void;
}

export class ExtensionUiHandler {
	private overlayContainer: HTMLElement | null = null;
	// 未决请求 registry：key = request.id；settle 幂等，只有第一次生效。
	private pendingRequests = new Map<string, PendingUiRequest>();
	// 当前 overlay 归属的请求 id；新请求顶掉旧 overlay 时按 cancelled 结算旧请求。
	private activeOverlayRequestId: string | null = null;
	private statusContainer: HTMLElement | null = null;
	private widgetAboveContainer: HTMLElement | null = null;
	private widgetBelowContainer: HTMLElement | null = null;
	private onSetEditorText: ((text: string) => void) | null = null;
	private onTrace: ((message: string) => void) | null = null;
	private onNotificationActionTarget: ((target: NotificationActionTarget) => void) | null = null;
	// 状态 chip 只在聊天布局（chat/file pane）可见；main.ts 在 pane 切换时同步。
	private chatPaneActive = true;
	// 最近一次通过抑制/清洗检查的状态文本，供 pane 切回时恢复渲染。
	private lastStatus: { statusKey: string; text: string } | null = null;
	// pi-mcp-adapter 状态文本解析出的连通性，驱动 chip 呼吸灯与弹层行状态。
	private mcpConnection: McpConnectionState | null = null;
	private mcpPanelContainer: HTMLElement | null = null;
	private mcpPanelOpen = false;
	private mcpServersLoading = false;
	private mcpServersFailed = false;
	private mcpServers: McpChipServerInfo[] | null = null;
	private mcpServersProvider: (() => Promise<McpChipServerInfo[]>) | null = null;
	private onOpenMcpSettings: (() => void) | null = null;
	private mcpPanelDismissListener: ((event: MouseEvent) => void) | null = null;
	private mcpPanelKeyListener: ((event: KeyboardEvent) => void) | null = null;
	private appWindowFocused = typeof document !== "undefined" ? document.hasFocus() : true;
	private lastKnownTauriWindowFocus: boolean | null = null;
	private releaseFocusTrackerSubscription: (() => void) | null = null;
	private notificationPermissionRequested = false;
	private notificationActionListenerRegistered = false;
	private releasePermissionBootstrapListeners: (() => void) | null = null;
	private lastNotificationActionTarget: NotificationActionTarget | null = null;
	private lastDesktopNotificationKey = "";
	private lastDesktopNotificationAt = 0;
	private nextDesktopNotificationId = 1;
	private desktopNotificationIconPath: string | null | undefined = undefined;

	constructor() {
		this.createContainers();
		this.ensureAppFocusTracking();
		this.ensureDesktopNotificationPermissionBootstrap();
		this.ensureDesktopNotificationActionListener();
	}

	setEditorTextHandler(handler: (text: string) => void): void {
		this.onSetEditorText = handler;
	}

	setTraceHandler(handler: ((message: string) => void) | null): void {
		this.onTrace = handler;
	}

	setNotificationActionHandler(handler: ((target: NotificationActionTarget) => void) | null): void {
		this.onNotificationActionTarget = handler;
	}

	/** 提供 MCP 服务器列表数据源（list_mcp_servers）；缺省时弹层退化为聚合视图。 */
	setMcpServersProvider(provider: (() => Promise<McpChipServerInfo[]>) | null): void {
		this.mcpServersProvider = provider;
	}

	/** 「管理 MCP…」点击回调（打开 设置→扩展→MCP tab），由 main.ts 接线。 */
	setOpenMcpSettingsHandler(handler: (() => void) | null): void {
		this.onOpenMcpSettings = handler;
	}

	/** pane 可见性门控：仅聊天布局（chat/file）显示扩展状态 chip。 */
	setChatPaneActive(active: boolean): void {
		if (this.chatPaneActive === active) return;
		this.chatPaneActive = active;
		if (!active) {
			this.closeMcpPanel();
		}
		this.renderStatus();
	}

	primeNotificationPermission(): void {
		void this.primeDesktopNotificationPermission();
	}

	private trace(message: string): void {
		this.onTrace?.(message);
		console.debug(`[extension-ui] ${message}`);
	}

	private async isAppBackgrounded(): Promise<boolean> {
		if (typeof document === "undefined") return false;
		const visibilityHidden = document.visibilityState === "hidden";
		const domFocused = document.hasFocus();
		let windowFocused = this.appWindowFocused;
		try {
			windowFocused = await getCurrentWindow().isFocused();
			this.lastKnownTauriWindowFocus = windowFocused;
			this.appWindowFocused = windowFocused;
		} catch {
			this.lastKnownTauriWindowFocus = null;
		}
		return visibilityHidden || !domFocused || !windowFocused;
	}

	private ensureAppFocusTracking(): void {
		const tracker = ensureExtensionUiFocusTrackerInitialized();
		if (!tracker) return;
		this.releaseFocusTrackerSubscription?.();
		this.appWindowFocused = tracker.focused;
		const subscriber = (focused: boolean) => {
			this.appWindowFocused = focused;
		};
		tracker.subscribers.add(subscriber);
		this.releaseFocusTrackerSubscription = () => {
			tracker.subscribers.delete(subscriber);
		};
	}

	private getDesktopNotificationSound(): string | undefined {
		if (typeof navigator === "undefined") return undefined;
		const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
		if (platform.includes("mac")) return "Ping";
		if (platform.includes("linux")) return "message-new-instant";
		return undefined;
	}

	private formatNotificationContextSuffix(request: ExtensionUiRequest): string {
		const workspace = request.notifyTargetWorkspaceLabel?.trim() || "";
		const session = request.notifyTargetSessionLabel?.trim() || "";
		if (!workspace && !session) return "";
		if (!workspace) return `[${session}]`;
		if (!session) return `[${workspace}]`;
		return `[${workspace}] -> [${session}]`;
	}

	private appendNotificationContext(body: string, contextSuffix: string): string {
		if (!contextSuffix) return body;
		const normalizedBody = body.trim();
		if (!normalizedBody) return contextSuffix;
		if (normalizedBody.includes(contextSuffix)) return normalizedBody;
		return `${normalizedBody}\n${contextSuffix}`;
	}

	private nextNotificationId(): number {
		const current = this.nextDesktopNotificationId;
		this.nextDesktopNotificationId = current >= 2_100_000_000 ? 1 : current + 1;
		return current;
	}

	private sanitizeDesktopNotificationText(text: string): string {
		return text
			.replace(/[✅❌❓⚠️]/g, "")
			.replace(/\bpi\s*-\s*/gi, "")
			.replace(/\bsmart voice notify\b/gi, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	private formatDesktopNotificationTitle(request: ExtensionUiRequest): string {
		const cleanedTitle = this.sanitizeDesktopNotificationText(request.title?.trim() || "");
		if (cleanedTitle) return `Pi DESK · ${cleanedTitle}`;
		switch ((request.notifyType || "").toLowerCase()) {
			case "error":
				return t("panels.extensionUi.notify.needsAttention");
			case "warning":
				return t("panels.extensionUi.notify.actionNeeded");
			default:
				return t("panels.extensionUi.notify.update");
		}
	}

	private formatDesktopNotificationBody(request: ExtensionUiRequest, contextSuffix: string): string {
		const cleanedMessage = this.sanitizeDesktopNotificationText(request.message?.trim() || "");
		const cleanedTitle = this.sanitizeDesktopNotificationText(request.title?.trim() || "");
		const base = cleanedMessage || cleanedTitle || t("panels.extensionUi.notify.fallbackBody");
		return this.appendNotificationContext(base, contextSuffix);
	}

	private async resolveDesktopNotificationIconPath(): Promise<string | undefined> {
		if (this.desktopNotificationIconPath !== undefined) return this.desktopNotificationIconPath || undefined;
		try {
			const { resourceDir } = await import("@tauri-apps/api/path");
			const { convertFileSrc } = await import("@tauri-apps/api/core");
			const { exists } = await import("@tauri-apps/plugin-fs");
			const resourcesRoot = (await resourceDir()).replace(/\\/g, "/").replace(/\/+$/, "");
			if (!resourcesRoot) {
				this.desktopNotificationIconPath = null;
				return undefined;
			}
			const candidates = [
				joinFsPath(joinFsPath(resourcesRoot, "icons"), "icon.png"),
				joinFsPath(joinFsPath(resourcesRoot, "icons"), "128x128.png"),
				joinFsPath(joinFsPath(resourcesRoot, "icons"), "32x32.png"),
			];
			for (const candidate of candidates) {
				if (await exists(candidate)) {
					const converted = convertFileSrc(candidate);
					this.desktopNotificationIconPath = converted || toFileUrl(candidate);
					return this.desktopNotificationIconPath;
				}
			}
		} catch {
			// ignore
		}
		this.desktopNotificationIconPath = null;
		return undefined;
	}

	private ensureDesktopNotificationPermissionBootstrap(): void {
		if (typeof window === "undefined" || typeof Notification === "undefined") return;
		if (Notification.permission !== "default") {
			this.notificationPermissionRequested = Notification.permission === "granted";
			return;
		}
		this.releasePermissionBootstrapListeners?.();
		const trigger = () => {
			this.releasePermissionBootstrapListeners?.();
			this.releasePermissionBootstrapListeners = null;
			this.trace("notify:permission-bootstrap trigger=gesture");
			void this.ensureDesktopNotificationPermission(true);
		};
		const options: AddEventListenerOptions = { capture: true, once: true };
		window.addEventListener("pointerdown", trigger, options);
		window.addEventListener("keydown", trigger, options);
		this.releasePermissionBootstrapListeners = () => {
			window.removeEventListener("pointerdown", trigger, true);
			window.removeEventListener("keydown", trigger, true);
		};
	}

	private describeNotificationContext(backgrounded: boolean): string {
		const visibility = typeof document !== "undefined" ? document.visibilityState : "unknown";
		const domFocused = typeof document !== "undefined" ? document.hasFocus() : false;
		const tauriFocused = this.lastKnownTauriWindowFocus;
		return `backgrounded=${backgrounded ? "yes" : "no"} visibility=${visibility} domFocus=${domFocused ? "yes" : "no"} appFocus=${this.appWindowFocused ? "yes" : "no"} tauriFocus=${tauriFocused === null ? "unknown" : tauriFocused ? "yes" : "no"}`;
	}

	private notificationDedupKey(request: ExtensionUiRequest): string {
		const title = request.title?.trim() || "";
		const body = request.message?.trim() || "";
		const targetSession = request.notifyTargetSessionPath?.trim() || "";
		const targetTab = request.notifyTargetTabId?.trim() || "";
		return `${request.notifyType ?? "info"}|${title}|${body}|${targetSession}|${targetTab}`;
	}

	private shouldThrottleDesktopNotification(request: ExtensionUiRequest): boolean {
		const key = this.notificationDedupKey(request);
		const now = Date.now();
		const timeSinceLast = now - this.lastDesktopNotificationAt;
		if (timeSinceLast < 1200) {
			this.trace(`notify:throttled burst deltaMs=${timeSinceLast}`);
			return true;
		}
		if (key === this.lastDesktopNotificationKey && timeSinceLast < 15_000) {
			this.trace(`notify:throttled duplicate deltaMs=${timeSinceLast}`);
			return true;
		}
		this.lastDesktopNotificationKey = key;
		this.lastDesktopNotificationAt = now;
		return false;
	}

	private buildNotificationActionTarget(request: ExtensionUiRequest): NotificationActionTarget | null {
		const workspaceId = request.notifyTargetWorkspaceId?.trim();
		const tabId = request.notifyTargetTabId?.trim();
		const sessionPath = request.notifyTargetSessionPath?.trim();
		const workspaceLabel = request.notifyTargetWorkspaceLabel?.trim();
		const sessionLabel = request.notifyTargetSessionLabel?.trim();
		if (!workspaceId && !tabId && !sessionPath) return null;
		return {
			workspaceId: workspaceId || undefined,
			tabId: tabId || undefined,
			sessionPath: sessionPath || undefined,
			workspaceLabel: workspaceLabel || undefined,
			sessionLabel: sessionLabel || undefined,
		};
	}

	private extractNotificationActionTarget(notification: DesktopNotificationOptions): NotificationActionTarget | null {
		const extra = notification.extra as Record<string, unknown> | undefined;
		if (!extra) return null;
		const workspaceId = typeof extra.notifyTargetWorkspaceId === "string" ? extra.notifyTargetWorkspaceId.trim() : "";
		const tabId = typeof extra.notifyTargetTabId === "string" ? extra.notifyTargetTabId.trim() : "";
		const sessionPath = typeof extra.notifyTargetSessionPath === "string" ? extra.notifyTargetSessionPath.trim() : "";
		const workspaceLabel = typeof extra.notifyTargetWorkspaceLabel === "string" ? extra.notifyTargetWorkspaceLabel.trim() : "";
		const sessionLabel = typeof extra.notifyTargetSessionLabel === "string" ? extra.notifyTargetSessionLabel.trim() : "";
		if (!workspaceId && !tabId && !sessionPath) return null;
		return {
			workspaceId: workspaceId || undefined,
			tabId: tabId || undefined,
			sessionPath: sessionPath || undefined,
			workspaceLabel: workspaceLabel || undefined,
			sessionLabel: sessionLabel || undefined,
		};
	}

	private async ensureDesktopNotificationPermission(prompt = false): Promise<boolean> {
		try {
			const grantedInitially = await isPermissionGranted();
			this.trace(`notify:permission-check prompt=${prompt ? "yes" : "no"} granted=${grantedInitially ? "yes" : "no"}`);
			if (grantedInitially) {
				return true;
			}
			if (!prompt) {
				return false;
			}
			this.notificationPermissionRequested = true;
			const permission = await requestPermission();
			const granted = permission === "granted";
			this.trace(`notify:permission-request result=${permission}`);
			return granted;
		} catch (err) {
			this.trace(`notify:permission-check-failed ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	private async primeDesktopNotificationPermission(): Promise<void> {
		if (this.notificationPermissionRequested) return;
		if (await this.isAppBackgrounded()) {
			this.trace("notify:prime-skipped backgrounded=yes");
			return;
		}
		this.trace("notify:prime-start");
		await this.ensureDesktopNotificationPermission(true);
	}

	private async focusDesktopWindowFromNotification(): Promise<void> {
		window.focus();
		const currentWindow = getCurrentWindow();
		await currentWindow.show().catch(() => {
			/* ignore */
		});
		await currentWindow.setFocus().catch(() => {
			/* ignore */
		});
	}

	private ensureDesktopNotificationActionListener(): void {
		if (this.notificationActionListenerRegistered) return;
		this.notificationActionListenerRegistered = true;
		void onAction(async (notification: DesktopNotificationOptions) => {
			this.trace("notify:action-clicked");
			await this.focusDesktopWindowFromNotification().catch(() => {
				/* ignore */
			});
			const directTarget = this.extractNotificationActionTarget(notification);
			const usedFallback = !directTarget && !!this.lastNotificationActionTarget;
			const target = directTarget ?? this.lastNotificationActionTarget;
			if (!target) {
				this.trace("notify:action-target missing");
				return;
			}
			if (usedFallback) {
				this.trace("notify:action-target fallback=last");
			}
			this.trace(`notify:action-target workspace=${target.workspaceId ?? "-"} tab=${target.tabId ?? "-"} session=${target.sessionPath ?? "-"}`);
			this.onNotificationActionTarget?.(target);
		});
	}

	private createContainers(): void {
		// Overlay for dialogs
		this.overlayContainer = document.createElement("div");
		this.overlayContainer.id = "extension-ui-overlay";
		this.overlayContainer.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/50 hidden";
		document.body.appendChild(this.overlayContainer);

		// Status chip: 挂进 composer 状态行左侧的 #ext-status-slot（文档流内，
		// 与右侧 Git/Review/context 同一排，不再用 fixed 硬算坐标）。
		// slot 尚未渲染时退回 body 级 fixed（原有行为）。
		this.statusContainer = document.createElement("div");
		this.statusContainer.id = "extension-status-container";
		this.statusContainer.className = "hidden fixed bottom-6 left-[292px] z-40 pointer-events-none";
		document.body.appendChild(this.statusContainer);

		// MCP chip 弹层：锚在 chip 正上方（chip 高 28px + 8px 间距）。
		this.mcpPanelContainer = document.createElement("div");
		this.mcpPanelContainer.id = "mcp-status-panel";
		this.mcpPanelContainer.className = "hidden fixed bottom-[60px] left-[292px] z-50";
		document.body.appendChild(this.mcpPanelContainer);

		// Widget containers
		this.widgetAboveContainer = document.createElement("div");
		this.widgetAboveContainer.id = "widget-above";
		this.widgetAboveContainer.className = "hidden fixed bottom-[132px] left-[278px] right-4 z-30";
		document.body.appendChild(this.widgetAboveContainer);

		this.widgetBelowContainer = document.createElement("div");
		this.widgetBelowContainer.id = "widget-below";
		this.widgetBelowContainer.className = "hidden fixed bottom-3 left-[278px] right-4 z-30";
		document.body.appendChild(this.widgetBelowContainer);
	}

	/**
	 * Handle an extension UI request from the RPC bridge
	 */
	async handleRequest(request: ExtensionUiRequest): Promise<void> {
		switch (request.method) {
			case "select":
				await this.showSelectDialog(request);
				break;
			case "confirm":
				await this.showConfirmDialog(request);
				break;
			case "input":
				await this.showInputDialog(request);
				break;
			case "editor":
				await this.showEditorDialog(request);
				break;
			case "notify":
				void this.showNotification(request);
				break;
			case "setStatus":
				this.setStatus(request);
				break;
			case "setWidget":
				this.setWidget(request);
				break;
			case "setTitle":
				await this.setTitle(request);
				break;
			case "set_editor_text":
				this.setEditorText(request);
				break;
		}
	}

	async respondUnsupportedRequest(
		id: string,
		method: string,
		source: "active" | "background" | "unknown" = "unknown",
		runtimeId?: string,
	): Promise<void> {
		this.trace(`unsupported-ui-capability method=${method} source=${source}`);
		await this.sendResponse(
			id,
			{
				success: false,
				error: `Unsupported extension UI capability: ${method}`,
			},
			runtimeId,
		);
	}

	private async showSelectDialog(request: ExtensionUiRequest): Promise<void> {
		if (!this.overlayContainer) return;

		return new Promise((resolve) => {
			const options = request.options || [];
			// 所有响应路径（选择/取消/超时/被新请求顶掉/destroy）统一经 registry
			// 的 settle 出口；settle 幂等（exactly-once），避免来源 runtime 永久等待。
			const respond = this.registerPendingRequest(request, resolve);

			const template = html`
				<div class="bg-background rounded-lg shadow-xl border border-border w-full max-w-md p-4">
					<h3 class="text-sm font-medium mb-3">${request.title || t("panels.extensionUi.selectTitle")}</h3>
					<div class="space-y-1 max-h-60 overflow-y-auto">
						${options.map(
							(opt) => html`
								<button
									class="w-full text-left px-3 py-2 rounded text-sm hover:bg-secondary transition-colors"
									@click=${() => {
										this.closeOverlay();
										respond({ value: opt });
									}}
								>
									${opt}
								</button>
							`,
						)}
					</div>
					<button
						class="mt-3 w-full px-3 py-2 rounded text-sm border border-border hover:bg-secondary transition-colors"
						@click=${() => {
							this.closeOverlay();
							respond({ cancelled: true });
						}}
					>
						${t("common.cancel")}
					</button>
				</div>
			`;

			this.showOverlay(template, request.id);
		});
	}

	private async showConfirmDialog(request: ExtensionUiRequest): Promise<void> {
		if (!this.overlayContainer) return;

		return new Promise((resolve) => {
			// 响应路径统一经 registry settle 出口（exactly-once，含超时/被顶掉/destroy）。
			const respond = this.registerPendingRequest(request, resolve);

			const template = html`
				<div class="bg-background rounded-lg shadow-xl border border-border w-full max-w-sm p-4">
					<h3 class="text-sm font-medium mb-2">${request.title || t("common.confirm")}</h3>
					<p class="text-sm text-muted-foreground mb-4">${request.message || t("panels.extensionUi.confirmMessage")}</p>
					<div class="flex gap-2 justify-end">
						<button
							class="px-3 py-1.5 rounded text-sm border border-border hover:bg-secondary transition-colors"
							@click=${() => {
								this.closeOverlay();
								respond({ confirmed: false });
							}}
						>
							${t("common.cancel")}
						</button>
						<button
							class="px-3 py-1.5 rounded text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
							@click=${() => {
								this.closeOverlay();
								respond({ confirmed: true });
							}}
						>
							${t("common.confirm")}
						</button>
					</div>
				</div>
			`;

			this.showOverlay(template, request.id);
		});
	}

	private async showInputDialog(request: ExtensionUiRequest): Promise<void> {
		if (!this.overlayContainer) return;

		return new Promise((resolve) => {
			let inputValue = "";
			// 响应路径统一经 registry settle 出口（exactly-once）；
			// request.timeout 到期由 registry 自动 settle { cancelled: true }。
			const respond = this.registerPendingRequest(request, resolve);

			const template = html`
				<div class="bg-background rounded-lg shadow-xl border border-border w-full max-w-md p-4">
					<h3 class="text-sm font-medium mb-3">${request.title || t("panels.extensionUi.inputTitle")}</h3>
					<input
						type="text"
						class="w-full px-3 py-2 rounded border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
						placeholder="${request.placeholder || ""}"
						@input=${(e: Event) => {
							inputValue = (e.target as HTMLInputElement).value;
						}}
						@keydown=${(e: KeyboardEvent) => {
							if (e.isComposing || e.keyCode === 229) return;
							if (e.key === "Enter") {
								this.closeOverlay();
								respond({ value: inputValue });
							}
						}}
					/>
					<div class="flex gap-2 justify-end mt-3">
						<button
							class="px-3 py-1.5 rounded text-sm border border-border hover:bg-secondary transition-colors"
							@click=${() => {
								this.closeOverlay();
								respond({ cancelled: true });
							}}
						>
							${t("common.cancel")}
						</button>
						<button
							class="px-3 py-1.5 rounded text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
							@click=${() => {
								this.closeOverlay();
								respond({ value: inputValue });
							}}
						>
							${t("common.submit")}
						</button>
					</div>
				</div>
			`;

			this.showOverlay(template, request.id);

			// Focus input after render
			setTimeout(() => {
				const input = this.overlayContainer?.querySelector("input");
				input?.focus();
			}, 50);
		});
	}

	private async showEditorDialog(request: ExtensionUiRequest): Promise<void> {
		if (!this.overlayContainer) return;

		return new Promise((resolve) => {
			let editorValue = request.prefill || "";
			// 响应路径统一经 registry settle 出口（exactly-once）；
			// request.timeout 到期由 registry 自动 settle { cancelled: true }。
			const respond = this.registerPendingRequest(request, resolve);

			const template = html`
				<div class="bg-background rounded-lg shadow-xl border border-border w-full max-w-2xl h-96 p-4 flex flex-col">
					<h3 class="text-sm font-medium mb-3">${request.title || t("common.edit")}</h3>
					<textarea
						class="flex-1 w-full px-3 py-2 rounded border border-border bg-background text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary"
						@input=${(e: Event) => {
							editorValue = (e.target as HTMLTextAreaElement).value;
						}}
					>${request.prefill || ""}</textarea>
					<div class="flex gap-2 justify-end mt-3">
						<button
							class="px-3 py-1.5 rounded text-sm border border-border hover:bg-secondary transition-colors"
							@click=${() => {
								this.closeOverlay();
								respond({ cancelled: true });
							}}
						>
							${t("common.cancel")}
						</button>
						<button
							class="px-3 py-1.5 rounded text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
							@click=${() => {
								this.closeOverlay();
								respond({ value: editorValue });
							}}
						>
							${t("common.save")}
						</button>
					</div>
				</div>
			`;

			this.showOverlay(template, request.id);

			// Focus textarea after render
			setTimeout(() => {
				const textarea = this.overlayContainer?.querySelector("textarea");
				textarea?.focus();
			}, 50);
		});
	}

	private async showDesktopNotification(request: ExtensionUiRequest): Promise<boolean> {
		const contextSuffix = this.formatNotificationContextSuffix(request);
		const title = this.formatDesktopNotificationTitle(request);
		const body = this.formatDesktopNotificationBody(request, contextSuffix);

		let granted = await this.ensureDesktopNotificationPermission(false);
		if (!granted) {
			granted = await this.ensureDesktopNotificationPermission(true);
		}
		if (!granted) {
			this.trace(`notify:skipped permission-missing message=${request.message ?? ""}`);
			return false;
		}

		const actionTarget = this.buildNotificationActionTarget(request);
		if (actionTarget) {
			this.lastNotificationActionTarget = actionTarget;
		}

		const options: DesktopNotificationOptions = {
			id: this.nextNotificationId(),
			title,
			body,
			largeBody: body,
			summary: contextSuffix || "Pi DESK",
			group: "pi-desk-notifications",
			autoCancel: false,
			extra: {
				notifyType: request.notifyType ?? "info",
				method: request.method,
				...(actionTarget?.workspaceId ? { notifyTargetWorkspaceId: actionTarget.workspaceId } : {}),
				...(actionTarget?.tabId ? { notifyTargetTabId: actionTarget.tabId } : {}),
				...(actionTarget?.sessionPath ? { notifyTargetSessionPath: actionTarget.sessionPath } : {}),
				...(actionTarget?.workspaceLabel ? { notifyTargetWorkspaceLabel: actionTarget.workspaceLabel } : {}),
				...(actionTarget?.sessionLabel ? { notifyTargetSessionLabel: actionTarget.sessionLabel } : {}),
			},
		};
		const iconPath = await this.resolveDesktopNotificationIconPath();
		if (iconPath) {
			options.icon = iconPath;
		}
		const sound = this.getDesktopNotificationSound();
		if (sound) {
			options.sound = sound;
		}
		this.trace(
			`notify:native-attempt type=${request.notifyType ?? "info"} title=${title} body=${body} target=${actionTarget?.tabId ?? "-"}`,
		);
		try {
			sendNotification(options);
			this.trace(`notify:native-dispatched type=${request.notifyType ?? "info"} sound=${sound ?? "none"} delivery=unverified`);
			return true;
		} catch (err) {
			this.trace(`notify:native-failed ${err instanceof Error ? err.message : String(err)}`);
			try {
				sendNotification({
					title,
					body,
					extra: options.extra,
				});
				this.trace(`notify:native-dispatched fallback=minimal type=${request.notifyType ?? "info"}`);
				return true;
			} catch (fallbackErr) {
				this.trace(`notify:native-failed-fallback ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
				return false;
			}
		}
	}

	private async showNotification(request: ExtensionUiRequest): Promise<void> {
		const backgrounded = await this.isAppBackgrounded();
		this.trace(`notify:request type=${request.notifyType ?? "info"} ${this.describeNotificationContext(backgrounded)}`);
		if (!backgrounded) {
			this.trace("notify:skipped foreground");
			return;
		}
		if (this.shouldThrottleDesktopNotification(request)) {
			return;
		}
		const desktopShown = await this.showDesktopNotification(request);
		if (!desktopShown) {
			this.trace(`notify:desktop-missed message=${request.message ?? request.title ?? ""}`);
		}
		this.trace(`notify:dispatch backgrounded=${backgrounded ? "yes" : "no"} desktop=${desktopShown ? "yes" : "no"}`);
	}

	private setStatus(request: ExtensionUiRequest): void {
		const statusKey = typeof request.statusKey === "string" ? request.statusKey.trim() : "";
		if (statusKey && shouldSuppressUiStatusKey(statusKey)) {
			this.lastStatus = null;
		} else if (request.statusText === undefined) {
			// Clear status
			this.lastStatus = null;
		} else {
			const text = sanitizeUiStatusText(request.statusText);
			this.lastStatus = !text || shouldSuppressUiStatusText(text) ? null : { statusKey, text };
		}
		if (statusKey === "mcp") {
			this.mcpConnection = this.lastStatus ? parseMcpConnectionState(statusKey, this.lastStatus.text) : null;
			// 弹层开着时跟随最新连通性刷新行状态。
			if (this.mcpPanelOpen) this.renderMcpPanel();
		}
		this.renderStatus();
	}

	private mountStatusContainer(): void {
		if (!this.statusContainer) return;
		const slot = document.getElementById("ext-status-slot");
		if (slot) {
			if (this.statusContainer.parentElement !== slot) {
				slot.appendChild(this.statusContainer);
				this.statusContainer.className = "hidden ext-status-chip-host";
			}
		} else if (this.statusContainer.parentElement !== document.body) {
			document.body.appendChild(this.statusContainer);
			this.statusContainer.className = "hidden fixed bottom-6 left-[292px] z-40 pointer-events-none";
		}
	}

	private renderStatus(): void {
		if (!this.statusContainer) return;
		this.mountStatusContainer();
		const status = this.chatPaneActive ? this.lastStatus : null;
		if (!status) {
			this.statusContainer.classList.add("hidden");
			this.statusContainer.innerHTML = "";
			return;
		}
		// 已知扩展（如 pi-mcp-adapter）的英文状态文本经映射表中文化，
		// 并折叠为 icon + 徽标的紧凑 chip（hover 显示明细）；
		// 未命中的文本原样以 chip 展示。
		const view = mapExtensionStatusText(status.statusKey, status.text);
		const detail = view?.detail ?? status.text;
		const label = view?.label ?? (view?.icon ? "" : detail);
		const isMcp = status.statusKey === "mcp";
		const phase: McpConnectionPhase = this.mcpConnection?.phase ?? "disconnected";
		const inner = html`
			${view?.icon ? html`<span class="ext-status-chip-icon">${view.icon}</span>` : nothing}
			${isMcp ? html`<span class="ext-status-dot ext-status-dot-${phase}"></span>` : nothing}
			${label ? html`<span class="ext-status-chip-label">${label}</span>` : nothing}
			${view?.badge ? html`<span class="ext-status-chip-badge">${view.badge}</span>` : nothing}
		`;
		this.statusContainer.classList.remove("hidden");
		if (isMcp) {
			// MCP chip 可点击：弹出服务器列表面板；呼吸灯显示连通性。
			render(
				html`<div
					class="ext-status-chip ext-status-chip-clickable"
					title=${detail}
					role="button"
					tabindex="0"
					@click=${() => this.toggleMcpPanel()}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							this.toggleMcpPanel();
						}
					}}
				>
					${inner}
				</div>`,
				this.statusContainer,
			);
		} else {
			render(html`<div class="ext-status-chip" title=${detail}>${inner}</div>`, this.statusContainer);
		}
	}

	private toggleMcpPanel(): void {
		if (this.mcpPanelOpen) {
			this.closeMcpPanel();
		} else {
			this.openMcpPanel();
		}
	}

	private openMcpPanel(): void {
		if (!this.mcpPanelContainer || this.mcpPanelOpen) return;
		this.mcpPanelOpen = true;
		// 弹层锚定 chip 实际位置（上方 8px），不硬编码坐标
		const rect = this.statusContainer?.getBoundingClientRect();
		if (rect && rect.width > 0) {
			this.mcpPanelContainer.style.left = `${Math.max(8, rect.left)}px`;
			this.mcpPanelContainer.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
		}
		this.mcpPanelContainer.classList.remove("hidden");
		this.renderMcpPanel();
		void this.loadMcpServers();
		this.mcpPanelDismissListener = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (!target) return;
			if (this.mcpPanelContainer?.contains(target)) return;
			// chip 上的按下交给 click 走 toggle，避免先关后开。
			if (this.statusContainer?.contains(target)) return;
			this.closeMcpPanel();
		};
		this.mcpPanelKeyListener = (event: KeyboardEvent) => {
			if (event.key === "Escape") this.closeMcpPanel();
		};
		document.addEventListener("mousedown", this.mcpPanelDismissListener, true);
		document.addEventListener("keydown", this.mcpPanelKeyListener, true);
	}

	private closeMcpPanel(): void {
		if (this.mcpPanelDismissListener) {
			document.removeEventListener("mousedown", this.mcpPanelDismissListener, true);
			this.mcpPanelDismissListener = null;
		}
		if (this.mcpPanelKeyListener) {
			document.removeEventListener("keydown", this.mcpPanelKeyListener, true);
			this.mcpPanelKeyListener = null;
		}
		this.mcpPanelOpen = false;
		if (this.mcpPanelContainer) {
			this.mcpPanelContainer.classList.add("hidden");
			this.mcpPanelContainer.innerHTML = "";
		}
	}

	private async loadMcpServers(): Promise<void> {
		if (!this.mcpServersProvider) {
			// 无数据源（如 runtime 未接）：保留 null，弹层退化为聚合视图。
			this.mcpServers = null;
			this.mcpServersFailed = false;
			return;
		}
		this.mcpServersLoading = true;
		this.mcpServersFailed = false;
		if (this.mcpPanelOpen) this.renderMcpPanel();
		try {
			this.mcpServers = await this.mcpServersProvider();
		} catch (err) {
			this.trace(`mcp-panel:load-failed ${err instanceof Error ? err.message : String(err)}`);
			this.mcpServers = null;
			this.mcpServersFailed = true;
		} finally {
			this.mcpServersLoading = false;
			if (this.mcpPanelOpen) this.renderMcpPanel();
		}
	}

	private renderMcpPanel(): void {
		if (!this.mcpPanelContainer) return;
		const connection = this.mcpConnection;
		const servers = this.mcpServers;

		// 头部汇总：优先用适配器快照的 已连接/已启用，其次仅总数。
		let summary: string | null = null;
		if (connection?.enabled != null) {
			summary =
				connection.connected != null
					? t("panels.extensionUi.mcpPanel.connectedRatio", {
							connected: connection.connected,
							enabled: connection.enabled,
						})
					: t("panels.extensionUi.mcpPanel.serversTotal", { count: connection.enabled });
		}

		let body: TemplateResult;
		if (servers && servers.length > 0) {
			body = html`${servers.map((server) => this.renderMcpServerRow(server))}`;
		} else if (this.mcpServersLoading && !servers) {
			body = html`<div class="mcp-panel-note">${t("panels.extensionUi.mcpPanel.loading")}</div>`;
		} else if (this.mcpServersFailed) {
			body = html`<div class="mcp-panel-note">${t("panels.extensionUi.mcpPanel.loadFailed")}</div>
				${this.renderMcpAggregateFallback()}`;
		} else if (servers) {
			body = html`<div class="mcp-panel-note">${t("panels.extensionUi.mcpPanel.empty")}</div>`;
		} else {
			// 无数据源降级：只展示适配器状态文本解析出的聚合信息。
			body = this.renderMcpAggregateFallback();
		}

		render(
			html`<div class="mcp-panel">
				<div class="mcp-panel-header">
					<span class="mcp-panel-title">${t("panels.extensionUi.mcpPanel.title")}</span>
					${summary ? html`<span class="mcp-panel-summary">${summary}</span>` : nothing}
				</div>
				<div class="mcp-panel-body">${body}</div>
				<div class="mcp-panel-footer">
					<button
						class="mcp-panel-manage"
						@click=${() => {
							this.closeMcpPanel();
							this.onOpenMcpSettings?.();
						}}
					>
						${t("panels.extensionUi.mcpPanel.manage")}
					</button>
				</div>
			</div>`,
			this.mcpPanelContainer,
		);
	}

	/** 拿不到服务器清单时的降级内容：适配器状态文本的中文明细（有就显示）。 */
	private renderMcpAggregateFallback(): TemplateResult {
		const status = this.lastStatus?.statusKey === "mcp" ? this.lastStatus : null;
		const detail = status ? (mapExtensionStatusText(status.statusKey, status.text)?.detail ?? status.text) : null;
		if (!detail) return html`<div class="mcp-panel-note">${t("panels.extensionUi.mcpPanel.noStatus")}</div>`;
		return html`<div class="mcp-panel-note">${detail}</div>`;
	}

	private renderMcpServerRow(server: McpChipServerInfo): TemplateResult {
		// MCP-01：连通性只有适配器聚合快照，无法归属到单台服务器。
		// 停用行固定灰色「已停用」；启用行仅在拿到单台真实相位（connectionState）
		// 时按台显示，否则用中性空心点 + 「状态未知（聚合信息）」，
		// 不再把聚合相位套到每台（避免一台已连接时全部显示绿色「已连接」）。
		const phase: McpConnectionPhase | null = server.disabled ? "disconnected" : (server.connectionState ?? null);
		const stateLabel = server.disabled
			? t("panels.extensionUi.mcpPanel.stateDisabled")
			: phase === "connected"
				? t("panels.extensionUi.mcpPanel.stateConnected")
				: phase === "connecting"
					? t("panels.extensionUi.mcpPanel.stateConnecting")
					: phase === "disconnected"
						? t("panels.extensionUi.mcpPanel.stateDisconnected")
						: t("panels.extensionUi.mcpPanel.stateUnknown");
		const dot = phase
			? html`<span class="ext-status-dot ext-status-dot-${phase}"></span>`
			: html`<span class="ext-status-dot" style="box-shadow: inset 0 0 0 1.5px var(--muted-2);"></span>`;
		return html`<div class="mcp-panel-row">
			${dot}
			<span class="mcp-panel-name" title=${server.name}>${server.name}</span>
			<span class="mcp-panel-transport">${server.transport}</span>
			<span class="mcp-panel-state">${stateLabel}</span>
		</div>`;
	}

	private setWidget(request: ExtensionUiRequest): void {
		const container =
			request.widgetPlacement === "belowEditor" ? this.widgetBelowContainer : this.widgetAboveContainer;
		if (!container) return;

		const lines = (request.widgetLines ?? [])
			.map((line) => sanitizeUiStatusText(line))
			.filter((line) => Boolean(line) && !shouldSuppressUiStatusText(line));
		if (lines.length === 0) {
			container.classList.add("hidden");
			container.innerHTML = "";
		} else {
			container.classList.remove("hidden");
			render(
				html`
					<div class="text-xs text-muted-foreground px-3 py-2 bg-secondary/50 border-t border-b border-border">
						${lines.map((line) => html`<div>${line}</div>`)}
					</div>
				`,
				container,
			);
		}
	}

	private async setTitle(request: ExtensionUiRequest): Promise<void> {
		const nextTitle = request.title?.trim();
		if (!nextTitle) return;
		document.title = nextTitle;
		try {
			await rpcBridge.setSessionName(nextTitle);
			this.trace(`setTitle:session-renamed title=${nextTitle}`);
		} catch (err) {
			this.trace(`setTitle:rename-failed ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private setEditorText(request: ExtensionUiRequest): void {
		if (typeof request.text !== "string") return;
		this.onSetEditorText?.(request.text);
	}

	/**
	 * 登记未决弹窗请求，返回统一 settle 出口。
	 * settle 幂等：只有第一次生效，后续调用丢弃（exactly-once）。
	 * request.timeout 到期自动 settle { cancelled: true }；timeout 缺失时保持等待用户（原有行为，不引入新默认超时）。
	 */
	private registerPendingRequest(
		request: ExtensionUiRequest,
		onSettled: () => void,
	): (data: Record<string, unknown>) => void {
		// 同 id 重入防御：先结算旧条目再登记。
		this.settlePendingRequest(request.id, { cancelled: true });
		const entry: PendingUiRequest = {
			runtimeId: request.runtimeId,
			timeoutTimer: null,
			settle: (data: Record<string, unknown>) => {
				if (this.pendingRequests.get(request.id) !== entry) return;
				this.pendingRequests.delete(request.id);
				if (entry.timeoutTimer) {
					clearTimeout(entry.timeoutTimer);
					entry.timeoutTimer = null;
				}
				void this.sendResponse(request.id, data, entry.runtimeId);
				onSettled();
			},
		};
		this.pendingRequests.set(request.id, entry);
		if (request.timeout) {
			entry.timeoutTimer = setTimeout(() => {
				// 超时也是一条取消路径；overlay 仍归该请求时才关闭它。
				if (this.activeOverlayRequestId === request.id) {
					this.closeOverlay();
				}
				this.settlePendingRequest(request.id, { cancelled: true });
			}, request.timeout);
		}
		return entry.settle;
	}

	/** 经 registry 结算指定请求；未登记（已结算）时为空操作，保证幂等。 */
	private settlePendingRequest(id: string, data: Record<string, unknown>): void {
		const entry = this.pendingRequests.get(id);
		if (!entry) return;
		entry.settle(data);
	}

	private showOverlay(template: TemplateResult, requestId?: string): void {
		if (!this.overlayContainer) return;
		if (this.activeOverlayRequestId && this.activeOverlayRequestId !== requestId) {
			// 新请求顶掉旧 overlay：旧请求按 cancelled 结算，避免来源 runtime 挂起。
			this.settlePendingRequest(this.activeOverlayRequestId, { cancelled: true });
		}
		this.activeOverlayRequestId = requestId ?? null;
		this.overlayContainer.classList.remove("hidden");
		render(template, this.overlayContainer);
	}

	private closeOverlay(): void {
		if (!this.overlayContainer) return;
		this.activeOverlayRequestId = null;
		this.overlayContainer.classList.add("hidden");
		this.overlayContainer.innerHTML = "";
	}

	private async sendResponse(id: string, data: Record<string, unknown>, runtimeId?: string): Promise<void> {
		const sourceRuntimeId = typeof runtimeId === "string" ? runtimeId.trim() : "";
		if (sourceRuntimeId && typeof window !== "undefined") {
			// 多 runtime 并存：回复经 main.ts 按 runtimeId 路由回来源 runtime 的 bridge，
			// 避免用户切换会话后回复被发到全局 active bridge（RUNTIME-01）。
			window.dispatchEvent(
				new CustomEvent("extension-ui-response-route", {
					detail: { runtimeId: sourceRuntimeId, id, data },
				}),
			);
			return;
		}
		// 兼容旧路径（请求 detail 无 runtimeId）：仍走全局 rpcBridge。
		await rpcBridge.sendExtensionUiResponse({ type: "extension_ui_response", id, ...data });
	}

	destroy(): void {
		// 结算所有未决弹窗请求（cancelled），避免来源 runtime 永久挂起。
		for (const id of [...this.pendingRequests.keys()]) {
			this.settlePendingRequest(id, { cancelled: true });
		}
		this.releaseFocusTrackerSubscription?.();
		this.releaseFocusTrackerSubscription = null;
		this.releasePermissionBootstrapListeners?.();
		this.releasePermissionBootstrapListeners = null;
		this.closeMcpPanel();
		this.mcpPanelContainer?.remove();
		this.overlayContainer?.remove();
		this.statusContainer?.remove();
		this.widgetAboveContainer?.remove();
		this.widgetBelowContainer?.remove();
	}
}
