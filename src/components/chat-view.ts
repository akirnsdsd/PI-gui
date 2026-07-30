/**
 * ChatView - rich RPC chat surface for Pi Desktop
 */

import "@mariozechner/mini-lit/dist/CodeBlock.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { html, nothing, render, type TemplateResult } from "lit";
import { t } from "../i18n/index.js";
import { promptDialog } from "./app-dialog.js";
import {
	resolveModelPickerSubmenuPlacement,
	resolveSessionRefreshScrollAction,
	resolveViewportPopoverLeft,
	subtractBlockedThinkingLevels,
} from "./desktop-ui-behavior.js";
import { openImageLightbox } from "./image-lightbox.js";
import { TodoPanel, parseTodoDetails, type TodoItem } from "./todo-panel.js";
import {
	type PiAuthProviderStatus,
	type RpcImageInput,
	type RpcSessionState,
	type SessionRewriteResult,
	type ThinkingLevel,
	THINKING_LEVEL_ORDER,
	SessionRewriteCommittedError,
	rpcBridge,
} from "../rpc/bridge.js";
import { buildGitBranchIndex, findGitBranchEntryByQuery, type GitBranchEntry } from "../git/branches.js";
import {
	createSlashPaletteItems,
	filterSlashPaletteItemsByQuery,
	findSlashPaletteItemByName,
	getSlashQueryFromInput,
	normalizeRuntimeSlashCommands,
	parseSlashInputText,
	type RuntimeSlashCommand,
	type SlashCommandSource,
	type SlashPaletteItem,
} from "../commands/slash-command-runtime.js";
import {
	formatModelDisplayName,
	parseListModelsCatalog,
	type ModelOption,
} from "../models/model-options.js";
import {
	buildModelPickerProviderGroups,
	resolveActiveModelPickerProvider,
} from "../models/model-picker-provider-groups.js";
import {
	resolveModelCandidateFromArg,
	resolvePreferredModelPickerProvider,
	resolveProviderHintFromModelArg,
} from "../models/model-selection.js";
import { isExtensionConfigIntent, normalizeExtensionCommandName } from "../extensions/extension-command-intent.js";
import { renderComposerControlsView } from "./chat-view/composer-controls-view.js";
import {
	renderComposerSkillDraftPillView,
	renderPendingFileReferencesView,
	renderPendingImagesView,
	renderQueuedComposerMessagesView,
} from "./chat-view/composer-fragments-view.js";
import {
	handleComposerDragOverEvent,
	handleComposerDropEvent,
	handleComposerFilePickerChangeEvent,
	handleComposerInputEvent,
	COMPOSER_TEXTAREA_MAX_HEIGHT,
	handleComposerKeyDownEvent,
	handleComposerPasteEvent,
} from "./chat-view/composer-input-events.js";
import { extractLocalFileReferenceFromClick } from "./chat-view/local-file-reference.js";
import { renderSlashPaletteView } from "./chat-view/composer-slash-palette-view.js";
import { renderComposerStatsView } from "./chat-view/composer-stats-view.js";
import { deriveForkSessionName, buildForkEntryIdByMessageId, resolveForkEntryId } from "./chat-view/history-fork-utils.js";
import { compactTreeLinePrefix, parseSessionTreeRows } from "./chat-view/history-tree-utils.js";
import { renderHistoryViewerView } from "./chat-view/history-viewer-view.js";
import { closeAllSettingsSelects, SettingsSelectDropdown } from "./settings-select-dropdown.js";
import type { ForkOption, HistoryTreeRow, HistoryViewerRole } from "./chat-view/history-viewer-types.js";
import { loadWelcomeDashboardInventory } from "./chat-view/welcome-dashboard-data.js";
import { renderCenteredWelcomeView } from "./chat-view/welcome-dashboard-view.js";
import { renderAssistantWorkflowView } from "./chat-view/assistant-workflow-view.js";
import { mapBackendMessages as mapBackendMessagesView } from "./chat-view/backend-message-mapper.js";
import {
	handleCompactionAndRetryEvent,
	handleMessageStreamEvent,
} from "./chat-view/event-stream-handlers.js";
import { handleRuntimeStatusEvent } from "./chat-view/event-runtime-status-handlers.js";
import {
	createAndCheckoutBranchAction,
	fetchGitRemotesAction,
	switchGitBranchAction,
	switchRemoteTrackingBranchAction,
} from "./chat-view/git-branch-actions.js";
import {
	extractAssistantPartialContent as extractAssistantPartialContentValue,
	extractImagesFromContent,
	extractTextContent,
	extractToolOutputText,
	mergeStreamingText as mergeStreamingTextValue,
} from "./chat-view/message-content-utils.js";
import { renderGitRepoControlView } from "./chat-view/git-repo-control-view.js";
import { renderReviewPanelView, ReviewPanelStore } from "./review-panel.js";
import {
	clearActiveDraggedFilePaths,
	peekActiveDraggedFilePaths,
} from "./file-drag-transfer.js";
import {
	createDropSignature,
	extractFilePathsFromDropPayload as extractFilePathsFromDropPayloadValue,
	fileNameFromPath as fileNameFromPathValue,
	isImageFile as isImageFileValue,
	isImageName as isImageNameValue,
	mimeFromFileName as mimeFromFileNameValue,
	toBase64Bytes,
} from "./chat-view/image-file-utils.js";
import { mapAvailableModelsFromRpc } from "./chat-view/models-load-utils.js";
import {
	computeSessionStatsFallback,
	computeSessionStatsFromRaw,
} from "./chat-view/session-stats-refresh.js";
import { sendMessageFlow } from "./chat-view/send-message-flow.js";
import { deriveLatestAssistantContextTokens as deriveLatestAssistantContextTokensFromMessages } from "./chat-view/session-stats-utils.js";
import {
	renderAssistantMessageRow,
	renderChangelogMessageRow,
	renderCompactionCycleRow,
	renderMessageTimelineRows,
	renderSystemMessageRow,
	renderUserMessageEditRow,
} from "./chat-view/message-timeline-view.js";
import {
	executeBuiltinSlashCommand as executeBuiltinSlashCommandView,
	formatSessionInfoBlock as formatSessionInfoBlockView,
} from "./chat-view/slash-builtin-command.js";
import {
	collectAssistantWorkflow,
	isStandaloneCodeBlockMarkdown,
	normalizeThinkingText,
	resolveWorkflowExpansionState,
	summarizeToolCall,
	type AssistantWorkflow,
	type AssistantWorkflowCandidate,
} from "./chat-view/workflow-utils.js";
import {
	displayProviderLabel as displayProviderLabelFromCatalog,
	isOAuthProviderId as isOAuthProviderIdInCatalog,
	normalizeAuthProviderArg as normalizeAuthProviderArgValue,
	normalizeConfiguredProviderAuth as normalizeConfiguredProviderAuthEntries,
	normalizeOAuthProviderCatalog as normalizeOAuthProviderCatalogEntries,
	normalizeProviderKey as normalizeProviderKeyValue,
	resolveProviderSetupCommand as resolveProviderSetupCommandForProvider,
	unwrapQuotedValue as unwrapQuotedArgValue,
	type OAuthProviderCatalogEntry,
} from "../auth/provider-auth.js";

type DeliveryMode = "prompt" | "steer" | "followUp";

type UiRole = HistoryViewerRole;

interface PendingImage {
	id: string;
	name: string;
	path?: string;
	mimeType: string;
	data: string;
	previewUrl: string;
	size: number;
}

interface PendingFileReference {
	id: string;
	name: string;
	path: string;
	token: string;
}

interface QueuedComposerMessage {
	id: string;
	text: string;
	attachments: PendingImage[];
	imageCount: number;
	createdAt: number;
	/** 连接中本地排队的消息：尚未发给 runtime，不参与后端 pendingMessageCount 对齐，
	 * 由 flushOfflineComposerQueue 在会话就绪后自动发出。 */
	awaitingConnection?: boolean;
}

interface ToolCallBlock {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: string;
	streamingOutput?: string;
	isError?: boolean;
	isRunning: boolean;
	isExpanded: boolean;
	startedAt?: number;
	endedAt?: number;
}

interface UiMessage {
	id: string;
	sessionEntryId?: string;
	role: UiRole;
	text: string;
	toolCalls: ToolCallBlock[];
	startedAt?: number;
	endedAt?: number;
	attachments?: PendingImage[];
	thinking?: string;
	thinkingExpanded?: boolean;
	thinkingScrollTop?: number;
	isThinkingStreaming?: boolean;
	isStreaming?: boolean;
	errorText?: string;
	deliveryMode?: DeliveryMode;
	label?: string;
	renderAsMarkdown?: boolean;
	collapsibleTitle?: string;
	collapsibleExpanded?: boolean;
}

interface Notice {
	id: string;
	text: string;
	kind: "info" | "success" | "error";
}

interface SessionStatsSummary {
	tokens: number | null;
	lifetimeTokens: number | null;
	costUsd: number | null;
	messageCount: number;
	pendingCount: number;
	contextWindow: number | null;
	usageRatio: number | null;
	updatedAt: number;
}

interface GitSummary {
	isRepo: boolean;
	branch: string | null;
	branches: string[];
	branchEntries: GitBranchEntry[];
	hasRemoteBranches: boolean;
	dirtyFiles: number;
	additions: number;
	deletions: number;
	updatedAt: number;
}

interface WelcomeDashboardSummary {
	loading: boolean;
	skills: string[];
	extensions: string[];
	themes: string[];
	currentCliVersion: string | null;
	latestCliVersion: string | null;
	updateAvailable: boolean;
	error: string | null;
	updatedAt: number;
}

interface WelcomeProjectSummary {
	id: string;
	name: string;
	path: string;
}

interface ComposerSkillDraft {
	name: string;
	commandText: string;
	scope: string | null;
}

interface CompactionCycleState {
	id: string;
	status: "running" | "done" | "aborted" | "error";
	startedAt: number;
	endedAt: number | null;
	summary: string;
	errorMessage: string | null;
	details: string[];
	expanded: boolean;
}

const MODEL_PICKER_AUTH_CACHE_MS = 15_000;
const MODEL_PICKER_CATALOG_CACHE_MS = 60_000;
// 历史分页大小：与 Rust 端 get_session_page 默认 limit 保持一致。
const HISTORY_PAGE_SIZE = 40;

/** CHAT-02 附件上限：单文件 ≤10MB、待发（含在途读取）累计 ≤10 个、待发附件总计 ≤50MB（防 renderer 内存爆）。 */
const ATTACHMENT_MAX_FILES = 10;
const ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * 流式渲染最小间隔。高频 tool/assistant 增量事件下将渲染降到 ~12fps；
 * 人眼对流式文本的连续感在这个量级仍然成立，主线程却能留出响应输入的余量。
 */
const STREAM_RENDER_MIN_INTERVAL_MS = 80;

function uid(prefix = "id"): string {
	return `${prefix}_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

function truncate(value: string, len: number): string {
	if (value.length <= len) return value;
	return `${value.slice(0, len - 1)}…`;
}

function normalizeComparablePath(value: string | null | undefined): string {
	return (value ?? "").replace(/\\/g, "/").replace(/\/+$|\s+$/g, "").toLowerCase();
}

function formatUsd(value: number): string {
	if (value < 0.01) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function readNumberPath(source: Record<string, unknown>, path: string): number | null {
	const parts = path.split(".");
	let current: unknown = source;
	for (const part of parts) {
		if (!current || typeof current !== "object") return null;
		current = (current as Record<string, unknown>)[part];
	}
	if (typeof current === "number" && Number.isFinite(current)) return current;
	if (typeof current === "string") {
		const cleaned = current.replace(/,/g, "").trim();
		const parsedDirect = Number(cleaned);
		if (Number.isFinite(parsedDirect)) return parsedDirect;
		const match = cleaned.match(/-?\d+(?:\.\d+)?/);
		if (match) {
			const parsed = Number(match[0]);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}

function pickNumber(source: Record<string, unknown>, paths: string[]): number | null {
	for (const path of paths) {
		const value = readNumberPath(source, path);
		if (value !== null) return value;
	}
	return null;
}

function readStringPath(source: Record<string, unknown>, path: string): string | null {
	const parts = path.split(".");
	let current: unknown = source;
	for (const part of parts) {
		if (!current || typeof current !== "object") return null;
		current = (current as Record<string, unknown>)[part];
	}
	if (typeof current === "string") {
		const value = current.trim();
		return value.length > 0 ? value : null;
	}
	if (typeof current === "number" || typeof current === "boolean") {
		return String(current);
	}
	if (current && typeof current === "object") {
		const nested = current as Record<string, unknown>;
		for (const key of ["name", "label", "id", "model", "provider"]) {
			const value = nested[key];
			if (typeof value === "string" && value.trim().length > 0) return value.trim();
		}
	}
	return null;
}

function pickString(source: Record<string, unknown>, paths: string[]): string | null {
	for (const path of paths) {
		const value = readStringPath(source, path);
		if (value !== null) return value;
	}
	return null;
}

function normalizeText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value && typeof value === "object") {
		const nested = value as Record<string, unknown>;
		for (const key of ["name", "label", "id", "model", "provider"]) {
			const candidate = nested[key];
			if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
		}
	}
	return "";
}

function formatThinkingDisplayName(level: ThinkingLevel): string {
	switch (level) {
		case "off":
			return t("chatView.thinkingLevel.off");
		case "minimal":
			return t("chatView.thinkingLevel.minimal");
		case "low":
			return t("chatView.thinkingLevel.low");
		case "medium":
			return t("chatView.thinkingLevel.medium");
		case "high":
			return t("chatView.thinkingLevel.high");
		case "xhigh":
			return t("chatView.thinkingLevel.xhigh");
		case "max":
			return t("chatView.thinkingLevel.max");
		default:
			return t("chatView.thinkingLevel.off");
	}
}

/**
 * 快捷键循环的兼容顺序。包含 `max`（pi 的最高档）。
 *
 * 实际循环时会跳过当前模型不支持的档，优先用
 * `get_available_thinking_levels` 拿到的权威列表，拿不到才回退到本常量。
 */
const THINKING_LEVEL_CYCLE_ORDER: ThinkingLevel[] = [...THINKING_LEVEL_ORDER];

function uiIcon(name: "edit" | "retry" | "copy" | "attach" | "send" | "stop" | "spinner" | "spark" | "terminal" | "git" | "diff" | "fork" | "plus"): TemplateResult {
	switch (name) {
		case "plus":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.3v9.4"></path><path d="M3.3 8h9.4"></path></svg>`;
		case "fork":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.3"></circle><circle cx="12" cy="3.5" r="1.3"></circle><circle cx="8" cy="12.5" r="1.3"></circle><path d="M4 4.8v1.4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4.8"></path><path d="M8 8.2v3"></path></svg>`;
		case "diff":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.2h4.4v9.6H3z"></path><path d="M9 3.2h4v9.6H9z"></path><path d="M10.7 6h1.6"></path><path d="M4.6 8.2h1.2"></path><path d="M10.7 10h1.6"></path><path d="M11.5 9.2v1.6"></path></svg>`;
		case "edit":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 11.8l.5-2.5L10.2 2.8a1.2 1.2 0 0 1 1.7 0l1.3 1.3a1.2 1.2 0 0 1 0 1.7l-6.5 6.5z"></path><path d="M3.2 11.8l2.5-.5"></path></svg>`;
		case "retry":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.7 8a4.7 4.7 0 1 1-1.4-3.4"></path><path d="M12.7 4.2v2.4h-2.4"></path></svg>`;
		case "copy":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.4"></rect><rect x="3" y="3" width="8" height="8" rx="1.4"></rect></svg>`;
		case "attach":
			return html`
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M4.2 2.6h5.1l2.5 2.5v7.1a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 12.2V3.8a1.2 1.2 0 0 1 1.2-1.2z"></path>
					<path d="M9.3 2.6v2.5h2.5"></path>
					<path d="M5.6 4.5v3.6a2.4 2.4 0 1 0 4.8 0V4.9a1.6 1.6 0 1 0-3.2 0v3a.8.8 0 1 0 1.6 0V5.5"></path>
				</svg>
			`;
		case "send":
			return html`<svg class="send-arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.7V3.6"></path><path d="M4.6 7L8 3.6 11.4 7"></path></svg>`;
		case "stop":
			return html`<svg class="stop-square-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.35" y="3.35" width="9.3" height="9.3" rx="1.65"></rect></svg>`;
		case "spinner":
			return html`<svg class="spinner-icon" viewBox="0 0 16 16" aria-hidden="true"><circle class="spinner-track" cx="8" cy="8" r="5.4"></circle><path class="spinner-arc" d="M8 2.6a5.4 5.4 0 0 1 5.4 5.4"></path></svg>`;
		case "spark":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5l1.3 3.1 3.2 1.3-3.2 1.3L8 11.3l-1.3-3.1-3.2-1.3 3.2-1.3z"></path></svg>`;
		case "terminal":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.2h10v9.6H3z"></path><path d="M5.1 6.2l1.9 1.8-1.9 1.8"></path><path d="M8.6 9.8h2.6"></path></svg>`;
		case "git":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.6" r="1.2"></circle><circle cx="4" cy="12.4" r="1.2"></circle><circle cx="12" cy="8" r="1.2"></circle><path d="M4 4.8v6.4"></path><path d="M5 4.2l5.8 2.9"></path><path d="M5 11.8l5.8-2.9"></path></svg>`;
	}
}

function skillGlyphIcon(): TemplateResult {
	return html`<svg class="filled" viewBox="0 0 20 20" aria-hidden="true"><path d="M9.2 2.3a1.5 1.5 0 0 1 3 0v3.8h.8V3.8a1.5 1.5 0 0 1 3 0v6.4a4.8 4.8 0 0 1-4.8 4.8H9.8A4.8 4.8 0 0 1 5 10.2V7.8a1.5 1.5 0 1 1 3 0v1.4h.8V2.3a1.5 1.5 0 0 1 .4-1z"></path></svg>`;
}

function piGlyphIcon(): TemplateResult {
	return html`
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<path d="M3.3 3.3H10.3V8H8V10.3H5.7V12.7H3.3Z"></path>
			<path d="M10.3 8H12.7V12.7H10.3Z"></path>
		</svg>
	`;
}

/**
 * 一次显式分叉（fork）完成后的会话落点信息：
 * 分叉动作会把当前 runtime 切到新的分支会话文件（forkedSessionPath），
 * sourceSessionPath/sourceTitle 是分叉前原会话的落点，供外层把原会话保留为独立标签页。
 */
export interface SessionForkedInfo {
	sourceSessionPath: string | null;
	sourceTitle: string | null;
	forkedSessionPath: string | null;
}

export class ChatView {
	private container: HTMLElement;
	private messages: UiMessage[] = [];
	private inputText = "";
	private state: RpcSessionState | null = null;
	private isConnected = false;
	private scrollContainer: HTMLElement | null = null;
	private unsubscribeEvents: (() => void) | null = null;
	private nativeFileDropUnlisteners: Array<() => void> = [];
	private lastDropSignature = "";
	private lastDropAt = 0;
	private onStateChange: ((state: RpcSessionState) => void) | null = null;
	private onOpenTerminal: ((command?: string) => void | Promise<void>) | null = null;
	private onAddProject: (() => void) | null = null;
	private onOpenSettings: ((sectionId?: string) => void) | null = null;
	private onOpenPackages: (() => void) | null = null;
	private onOpenExtensionConfig: ((commandName: string, args: string) => boolean | Promise<boolean>) | null = null;
	private onOpenProviderConfig: ((provider: string) => boolean | Promise<boolean>) | null = null;
	private onOpenProjectFile: ((reference: string) => boolean | Promise<boolean>) | null = null;
	private onBeginRenameCurrentSession: (() => boolean | Promise<boolean>) | null = null;
	private onRenameCurrentSession: ((nextName: string) => boolean | Promise<boolean>) | null = null;
	private onCreateFreshSession: (() => boolean | Promise<boolean>) | null = null;
	private onReloadRuntime: (() => boolean | Promise<boolean>) | null = null;
	private onOpenSessionBrowser: ((query?: string) => void) | null = null;
	private onOpenShortcuts: (() => void) | null = null;
	private onQuitApp: (() => void) | null = null;
	private onSelectWelcomeProject: ((projectId: string) => void) | null = null;
	private onPromptSubmitted: (() => void) | null = null;
	private onRunStateChange: ((running: boolean) => void) | null = null;
	private onSessionForked: ((info: SessionForkedInfo) => void) | null = null;
	private availableModels: ModelOption[] = [];
	private modelCatalog: ModelOption[] = [];
	private loadingModels = false;
	private loadingModelCatalog = false;
	private loadingProviderAuth = false;
	private modelLoadRequestSeq = 0;
	private modelCatalogLoadedAt = 0;
	private providerAuthLoadedAt = 0;
	private providerAuthById = new Map<string, Pick<PiAuthProviderStatus, "source" | "kind">>();
	private providerAuthConfigured = new Set<string>();
	private providerAuthForcedLoggedOut = new Set<string>();
	private oauthProviderCatalogLoadedAt = 0;
	private oauthProviderCatalogLoading = false;
	private oauthProviderCatalog = new Map<string, OAuthProviderCatalogEntry>();
	private lastBackendRefreshError: string | null = null;
	private lastModelLoadError: string | null = null;
	private lastBackendSessionFile: string | null = null;
	private settingModel = false;
	private settingThinking = false;
	private unsupportedThinkingLevelsByModel = new Map<string, Set<ThinkingLevel>>();
	/**
	 * 按模型缓存的可用思考档位（权威源：pi 的 get_available_thinking_levels，
	 * 其背后是 pi-ai 的 getSupportedThinkingLevels）。
	 * key 与 unsupportedThinkingLevelsByModel 同一格式：`provider::modelId`。
	 */
	private availableThinkingLevelsByModel = new Map<string, ThinkingLevel[]>();
	/** 防重：同一模型的拉取只跑一次。 */
	private thinkingLevelsFetchKey: string | null = null;
	private modelPickerOpen = false;
	private modelPickerSubmenuOpen = false;
	private addMenuOpen = false;
	private thinkingMenuOpen = false;
	private modelPickerActiveProvider = "";
	private modelPickerGlobalListenersBound = false;
	private modelPickerLayoutFrame: number | null = null;
	private modelPickerResizeObserver: ResizeObserver | null = null;
	private runningProviderAuthAction: { provider: string; action: "login" | "logout" } | null = null;
	private sendingPrompt = false;
	private pendingImages: PendingImage[] = [];
	/** CHAT-02：在途附件读取的占用登记（个数/字节）。闸门判定通过后同步入账，
	 * 读取并提交完成后释放，使并发批次按进入闸门的顺序串行裁决，不会叠加超限。 */
	private pendingImageReservedCount = 0;
	private pendingImageReservedBytes = 0;
	private pendingFileReferences: PendingFileReference[] = [];
	private notices: Notice[] = [];
	private projectTrustPrompt: { projectPath: string; busy: boolean; error: string } | null = null;
	private onTrustProject: (() => void) | null = null;
	private onDismissProjectTrust: (() => void) | null = null;
	private changelogCacheMarkdown: string | null = null;
	private changelogCacheAt = 0;
	private loadingChangelog = false;
	private allThinkingExpanded = false;
	private retryStatus = "";
	private compactionCycle: CompactionCycleState | null = null;
	private compactionInsertIndex: number | null = null;
	private lastRuntimeNoticeSignature = "";
	private lastRuntimeNoticeAt = 0;
	private extensionCompatibilityHintsShown = new Set<string>();
	private pendingDeliveryMode: DeliveryMode = "prompt";
	private queuedComposerMessages: QueuedComposerMessage[] = [];
	private forkOptions: ForkOption[] = [];
	private historyViewerOpen = false;
	private historyViewerMode: "browse" | "fork" = "browse";
	private historyViewerLoading = false;
	private historyViewerSessionLabel = "";
	private historyTreeRows: HistoryTreeRow[] = [];
	private historyTreeRequestSeq = 0;
	private forkEntryIdByMessageId = new Map<string, string>();
	private forkTargetsRequestSeq = 0;
	// 历史分页状态：首页只加载会话文件尾部一页，向上翻页增量prepend。
	private historySessionFile: string | null = null;
	private historyHasMore = false;
	private historyOldestEntryId: string | null = null;
	private historyLoadingMore = false;
	/** SESSION-02：历史分页代次。会话切换 / 权威刷新重锚分页状态时 +1，
	 * 让 await 返回的旧分页结果在提交 DOM 前被识别并丢弃。 */
	private historyPagingGeneration = 0;
	/** SESSION-02：权威刷新代次。每次 refreshFromBackend 开始 / 切会话时 +1，
	 * 在途的旧刷新响应（含其分页重锚）在提交前被识别并丢弃，避免旧会话数据覆盖新会话。 */
	private refreshGeneration = 0;
	// 「编辑并重发」就地编辑状态：气泡内直接编辑，发送时先 fork 到该消息之前，再在新分支里 prompt。
	// 同一时间只允许一个编辑态；切会话或消息流更新时清空。
	private timelineEditMessageId: string | null = null;
	private timelineEditEntryId: string | null = null;
	private timelineEditDraft = "";
	private resolvingMessageAction = false;
	private historyQuery = "";
	private historyRoleFilter: UiRole | "all" = "all";
	private readonly historyRoleFilterSelect = new SettingsSelectDropdown({ requestRender: () => this.render() });
	private autoFollowChat = true;
	private expandedToolWorkflowIds = new Set<string>();
	private expandedToolGroupByWorkflowId = new Map<string, string>();
	private expandedWorkflowThinkingIds = new Set<string>();
	private collapsedAutoWorkflowIds = new Set<string>();
	private selectedSkillDraft: ComposerSkillDraft | null = null;
	private slashPaletteOpen = false;
	private slashPaletteQuery = "";
	private slashPaletteIndex = 0;
	private slashPaletteNavigationMode: "pointer" | "keyboard" = "pointer";
	private slashRuntimeCommands: RuntimeSlashCommand[] = [];
	private slashCommandsLoading = false;
	private slashCommandsUpdatedAt = 0;
	private composerInputHistory: string[] = [];
	private composerHistoryIndex = -1;
	private composerHistoryDraft = "";
	private runHasAssistantText = false;
	private runSawToolActivity = false;
	private runStartedAt = 0;
	private keepWorkflowExpandedUntilAssistantText = false;
	private readonly workingStatusPhrases = [
		t("chatView.working.phrases.starting"),
		t("chatView.working.phrases.warmingUp"),
		t("chatView.working.phrases.workingOnIt"),
		t("chatView.working.phrases.planningNextSteps"),
		t("chatView.working.phrases.runningTools"),
		t("chatView.working.phrases.checkingFiles"),
		t("chatView.working.phrases.readingContext"),
		t("chatView.working.phrases.mappingDependencies"),
		t("chatView.working.phrases.editingSafely"),
		t("chatView.working.phrases.verifyingOutput"),
		t("chatView.working.phrases.reviewingDetails"),
		t("chatView.working.phrases.applyingChanges"),
		t("chatView.working.phrases.thinkingThrough"),
		t("chatView.working.phrases.finalizing"),
		t("chatView.working.phrases.wrappingUp"),
	];
	private workingStatusPhraseIndex = 0;
	private workingStatusPhase: "typing" | "hold" = "typing";
	private workingStatusCharCount = 0;
	private workingStatusTimer: ReturnType<typeof setTimeout> | null = null;
	private workflowElapsedTimer: ReturnType<typeof setInterval> | null = null;
	private disconnectNoticeTimer: ReturnType<typeof setTimeout> | null = null;
	private streamingReconcileTimer: ReturnType<typeof setTimeout> | null = null;
	/** 高频流式事件的合帧渲染句柄（见 scheduleStreamRender）。 */
	private streamRenderRaf: number | null = null;
	private streamRenderLastAt = 0;
	private streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
	/** scrollToBottom 的合帧句柄（高频流式事件下避免堆积 rAF + 同步布局）。 */
	private scrollToBottomRaf: number | null = null;
	/**
	 * Todo 面板（composer 上方的任务条）。
	 * 数据源是 `todo` 扩展的结构化 details，不解析 setWidget 的纯文本。
	 * 没装扩展时永不出现（todos 为空就不渲染）。
	 */
	private todoPanel: TodoPanel | null = null;
	private todoPanelSlot: HTMLElement | null = null;
	/** 清单的权威副本（面板重建时靠它恢复）。 */
	private todoItems: TodoItem[] = [];
	/** 面板重建时携带的视图态（展开/关闭）。 */
	private todoViewState = { expanded: false, dismissed: false };
	/** 最近一次分页读取带回的 todo 快照（Rust 侧全文件扇描得到）。 */
	private pendingTodoSnapshot: unknown = null;
	/**
	 * 实时 todo 更新的代次。
	 *
	 * 刷新是 async 的：`refreshFromBackend` 读历史页期间，`tool_execution_end`
	 * 可能已经写入了更新的清单。若不记代次，较旧的历史快照会把它盖回去。
	 */
	private todoLiveGeneration = 0;
	private composerResizeObserver: ResizeObserver | null = null;
	private observedComposerElement: HTMLElement | null = null;
	private composerOffsetPx = 196;
	private sessionStats: SessionStatsSummary = {
		tokens: null,
		lifetimeTokens: null,
		costUsd: null,
		messageCount: 0,
		pendingCount: 0,
		contextWindow: null,
		usageRatio: null,
		updatedAt: 0,
	};
	private lastAssistantContextTokens: number | null = null;
	private refreshingSessionStats = false;
	private sessionStatsHover = false;
	private gitSummary: GitSummary = {
		isRepo: false,
		branch: null,
		branches: [],
		branchEntries: [],
		hasRemoteBranches: false,
		dirtyFiles: 0,
		additions: 0,
		deletions: 0,
		updatedAt: 0,
	};
	private refreshingGitSummary = false;
	private gitMenuOpen = false;
	private gitBranchQuery = "";
	private switchingGitBranch = false;
	private fetchingGitRemotes = false;
	private creatingGitRepo = false;
	private reviewPanel = new ReviewPanelStore(() => this.render());
	private projectPath: string | null = null;
	private bindingStatusText: string | null = null;
	/** 当前绑定等待属于「全新会话启动」：此时 welcome 立即可见，不用骨架屏挡住首屏。 */
	private bindingForFreshSession = false;
	/** 会话切换「文件先行」预览的竞态守卫：seq 单调递增，过期预览直接丢弃。 */
	private sessionPreviewSeq = 0;
	private sessionPreviewPath: string | null = null;
	/** 会话切换后的强制落底代次；只允许当前切换链路安排滚动。 */
	private sessionScrollGeneration = 0;
	private pendingSessionScrollGeneration: number | null = null;
	private previewSettledSessionScrollGeneration: number | null = null;
	private sessionScrollFrame: number | null = null;
	private sessionScrollSettleFrame: number | null = null;
	private gitKnownBranchesByProject = new Map<string, string[]>();
	private welcomeDashboard: WelcomeDashboardSummary = {
		loading: false,
		skills: [],
		extensions: [],
		themes: [],
		currentCliVersion: null,
		latestCliVersion: null,
		updateAvailable: false,
		error: null,
		updatedAt: 0,
	};
	private welcomeProjectMenuOpen = false;
	private welcomeProjects: WelcomeProjectSummary[] = [];
	private welcomeActiveProjectId: string | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
	}

	setOnStateChange(cb: (state: RpcSessionState) => void): void {
		this.onStateChange = cb;
	}

	setOnSessionForked(cb: (info: SessionForkedInfo) => void): void {
		this.onSessionForked = cb;
	}

	setOnOpenTerminal(cb: (command?: string) => void | Promise<void>): void {
		this.onOpenTerminal = cb;
	}

	setOnAddProject(cb: () => void): void {
		this.onAddProject = cb;
	}

	setOnOpenSettings(cb: (sectionId?: string) => void): void {
		this.onOpenSettings = cb;
	}

	setOnOpenPackages(cb: () => void): void {
		this.onOpenPackages = cb;
	}

	setOnOpenExtensionConfig(cb: (commandName: string, args: string) => boolean | Promise<boolean>): void {
		this.onOpenExtensionConfig = cb;
	}

	setOnOpenProviderConfig(cb: (provider: string) => boolean | Promise<boolean>): void {
		this.onOpenProviderConfig = cb;
	}

	setOnOpenProjectFile(cb: (reference: string) => boolean | Promise<boolean>): void {
		this.onOpenProjectFile = cb;
	}

	setOnBeginRenameCurrentSession(cb: () => boolean | Promise<boolean>): void {
		this.onBeginRenameCurrentSession = cb;
	}

	setOnRenameCurrentSession(cb: (nextName: string) => boolean | Promise<boolean>): void {
		this.onRenameCurrentSession = cb;
	}

	setOnCreateFreshSession(cb: () => boolean | Promise<boolean>): void {
		this.onCreateFreshSession = cb;
	}

	setOnReloadRuntime(cb: () => boolean | Promise<boolean>): void {
		this.onReloadRuntime = cb;
	}

	setOnOpenSessionBrowser(cb: (query?: string) => void): void {
		this.onOpenSessionBrowser = cb;
	}

	setOnOpenShortcuts(cb: () => void): void {
		this.onOpenShortcuts = cb;
	}

	setOnQuitApp(cb: () => void): void {
		this.onQuitApp = cb;
	}

	setOnSelectWelcomeProject(cb: (projectId: string) => void): void {
		this.onSelectWelcomeProject = cb;
	}

	setWelcomeProjects(projects: Array<{ id: string; name: string; path: string }>, activeProjectId: string | null): void {
		this.welcomeProjects = projects
			.filter((entry) => Boolean(entry?.id) && Boolean(entry?.name) && Boolean(entry?.path))
			.map((entry) => ({ id: entry.id, name: entry.name, path: entry.path }));
		this.welcomeActiveProjectId = activeProjectId;
		this.render();
	}

	setOnPromptSubmitted(cb: () => void): void {
		this.onPromptSubmitted = cb;
	}

	setOnRunStateChange(cb: (running: boolean) => void): void {
		this.onRunStateChange = cb;
	}

	private resetSessionUiTransientState(): void {
		this.modelPickerOpen = false;
		this.modelPickerSubmenuOpen = false;
		this.addMenuOpen = false;
		this.thinkingMenuOpen = false;
		this.selectedSkillDraft = null;
		this.pendingFileReferences = [];
		this.clearTimelineMessageEditing();
		this.slashPaletteOpen = false;
		this.slashPaletteQuery = "";
		this.slashPaletteIndex = 0;
		this.slashCommandsUpdatedAt = 0;
		this.slashRuntimeCommands = [];
		this.expandedToolWorkflowIds.clear();
		this.expandedToolGroupByWorkflowId.clear();
		this.expandedWorkflowThinkingIds.clear();
		this.collapsedAutoWorkflowIds.clear();
		this.compactionCycle = null;
		this.compactionInsertIndex = null;
		this.runningProviderAuthAction = null;
		this.keepWorkflowExpandedUntilAssistantText = false;
	}

	private resetRunActivityState(): void {
		this.runHasAssistantText = false;
		this.runSawToolActivity = false;
		this.runStartedAt = 0;
		this.clearWorkingStatusTimer(true);
	}

	private markAssistantTextObserved(): void {
		this.runHasAssistantText = true;
		if (this.runSawToolActivity) {
			this.keepWorkflowExpandedUntilAssistantText = false;
		}
	}

	private markToolActivityObserved(): void {
		this.runSawToolActivity = true;
		this.keepWorkflowExpandedUntilAssistantText = true;
	}

	setProjectPath(path: string | null): void {
		if (this.projectPath === path) return;
		const previous = this.projectPath;
		this.projectPath = path;
		const push = (window as typeof window & {
			__PI_DESKTOP_PUSH_TRACE__?: (message: string) => void;
		}).__PI_DESKTOP_PUSH_TRACE__;
		push?.(`chat:setProjectPath ${previous ?? "-"} -> ${path ?? "-"}`);
		this.gitMenuOpen = false;
		this.welcomeProjectMenuOpen = false;
		this.reviewPanel.setCwd(path);
		this.resetSessionUiTransientState();
		this.modelCatalogLoadedAt = 0;
		if (!path) {
			this.bindingStatusText = null;
			this.bindingForFreshSession = false;
			this.modelLoadRequestSeq += 1;
			this.loadingModels = false;
			this.loadingModelCatalog = false;
			this.loadingProviderAuth = false;
			this.modelCatalog = [];
			this.providerAuthById.clear();
			this.providerAuthConfigured.clear();
			this.providerAuthForcedLoggedOut.clear();
			this.providerAuthLoadedAt = 0;
			this.resetRunActivityState();
			void this.refreshWelcomeDashboard(true);
		}
		void this.refreshGitSummary(true);
		this.render();
	}

	prepareForSessionSwitch(projectPath: string | null, statusText?: string, sessionPath?: string | null): void {
		if (this.projectPath !== projectPath) {
			this.setProjectPath(projectPath);
		}
		// 旧会话连接窗口里排队的消息还没发出：还原成草稿，避免误发到新会话。
		this.restoreOfflineQueueToComposerDraft();
		this.isConnected = rpcBridge.isConnected;
		this.state = null;
		this.messages = [];
		// todo 清单是会话级状态：必须在此处清。不能只依赖
		// rebuildTodoStateFromBackend——它只在刷新成功后跑，而且切到一个没有 todo
		// 记录的会话时，旧清单会在刷新完成前一直挂在新会话的 composer 上。
		this.resetTodoState();
		this.lastBackendSessionFile = null;
		this.lastBackendRefreshError = null;
		this.pendingDeliveryMode = "prompt";
		this.historySessionFile = null;
		this.historyHasMore = false;
		this.historyOldestEntryId = null;
		this.historyLoadingMore = false;
		this.historyPagingGeneration += 1;
		this.autoFollowChat = true;
		this.sessionScrollGeneration += 1;
		this.pendingSessionScrollGeneration = this.sessionScrollGeneration;
		this.previewSettledSessionScrollGeneration = null;
		this.cancelScheduledSessionScroll();
		// 切会话同时作废仍在途的权威刷新：旧会话的 refresh 响应不得再提交到新会话视图。
		this.refreshGeneration += 1;
		this.resetSessionUiTransientState();
		this.providerAuthForcedLoggedOut.clear();
		this.resetRunActivityState();
		this.bindingStatusText = projectPath ? (statusText ?? t("chatView.session.loading")) : null;
		// 无 sessionPath = 全新会话（草稿 tab）：welcome 先出，runtime 在后台启动。
		this.bindingForFreshSession = Boolean(projectPath) && !sessionPath;
		// 文件先行：会话 JSONL 就在本地，首页渲染不等 switch_session 完成。
		this.sessionPreviewSeq += 1;
		this.sessionPreviewPath = sessionPath ?? null;
		if (projectPath && sessionPath) {
			void this.loadSessionPreview(sessionPath, this.sessionPreviewSeq);
		}
		this.render();
	}

	/**
	 * 直接读会话文件首页（get_session_page 是纯文件读，~90ms），先把历史渲染出来；
	 * 权威状态（composer、模型等）仍由随后的 refreshFromBackend 补齐。
	 */
	private async loadSessionPreview(sessionPath: string, seq: number): Promise<void> {
		const startedAt = Date.now();
		try {
			const page = await rpcBridge.getSessionPage(sessionPath, null, HISTORY_PAGE_SIZE);
			if (seq !== this.sessionPreviewSeq || this.sessionPreviewPath !== sessionPath) return;
			// 权威链路已先渲染了同一会话（runtime 复用时可能更快），预览直接让位。
			if (this.lastBackendSessionFile === sessionPath && this.messages.length > 0) return;
			this.historyPagingGeneration += 1;
			this.historyLoadingMore = false;
			this.historySessionFile = sessionPath;
			this.historyHasMore = page.hasMore;
			this.historyOldestEntryId = page.oldestEntryId;
			this.messages = this.mapBackendMessages(this.adaptSessionPageEntries(page.entries));
			if (this.bindingStatusText) {
				this.bindingStatusText = t("chatView.session.connecting");
			}
			const push = (window as typeof window & {
				__PI_DESKTOP_PUSH_TRACE__?: (message: string) => void;
			}).__PI_DESKTOP_PUSH_TRACE__;
			push?.(`chat:session-preview ok entries=${page.entries.length} tookMs=${Date.now() - startedAt}`);
			this.render();
			const scrollGeneration = this.pendingSessionScrollGeneration;
			if (scrollGeneration !== null) {
				this.pendingSessionScrollGeneration = null;
				this.previewSettledSessionScrollGeneration = scrollGeneration;
				this.scheduleSessionScrollToLatest(scrollGeneration);
			}
		} catch (err) {
			// 预览失败静默降级：保留骨架屏，等权威链路刷新。
			console.warn("session preview failed:", err);
		}
	}

	getState(): RpcSessionState | null {
		return this.state;
	}

	private getComposerTextarea(): HTMLTextAreaElement | null {
		return this.container.querySelector("#chat-input") as HTMLTextAreaElement | null;
	}

	private syncComposerTextarea(
		text: string,
		options: { maxHeight?: number; focus?: boolean; moveCaretToEnd?: boolean } = {},
	): void {
		const textarea = this.getComposerTextarea();
		if (!textarea) return;
		textarea.value = text;
		textarea.style.height = "auto";
		if (typeof options.maxHeight === "number" && options.maxHeight > 0) {
			textarea.style.height = `${Math.min(textarea.scrollHeight, options.maxHeight)}px`;
		}
		if (options.moveCaretToEnd) {
			const end = text.length;
			textarea.setSelectionRange(end, end);
		}
		if (options.focus) textarea.focus();
	}

	private syncComposerTextareaDeferred(
		text: string,
		options: { maxHeight?: number; focus?: boolean; moveCaretToEnd?: boolean } = {},
	): void {
		requestAnimationFrame(() => this.syncComposerTextarea(text, options));
	}

	setInputText(text: string): void {
		this.inputText = text;
		this.resetComposerHistoryNavigation();
		this.updateSlashPaletteStateFromInput();
		this.render();
		this.syncComposerTextareaDeferred(text, { maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT, focus: true });
	}

	stageComposerCommand(commandText: string): void {
		const draft = this.parseComposerSkillDraftFromCommand(commandText);
		if (draft) {
			this.selectedSkillDraft = draft;
			this.inputText = "";
			this.resetComposerHistoryNavigation();
			this.updateSlashPaletteStateFromInput();
			this.render();
			this.syncComposerTextareaDeferred(this.inputText, { focus: true });
			return;
		}
		this.selectedSkillDraft = null;
		this.inputText = commandText;
		this.resetComposerHistoryNavigation();
		this.closeSlashPalette();
		this.render();
		this.syncComposerTextareaDeferred(commandText, { maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT, focus: true });
	}

	private normalizeSkillSlashCommandText(commandText: string): string {
		return commandText.trim().replace(/^\/+skill:/i, "/skill:");
	}

	private stageSkillSlashCommand(commandText: string): boolean {
		const normalizedCommand = this.normalizeSkillSlashCommandText(commandText);
		const draft = this.parseComposerSkillDraftFromCommand(normalizedCommand);
		if (!draft) return false;
		this.stageComposerCommand(draft.commandText);
		return true;
	}

	private parseComposerSkillDraftFromCommand(commandText: string): ComposerSkillDraft | null {
		const trimmed = commandText.trim();
		const match = trimmed.match(/^\/skill:([a-zA-Z0-9._-]+)\b([\s\S]*)$/);
		if (!match) return null;
		const name = match[1] || "";
		const suffix = (match[2] || "").trim();
		if (!suffix) {
			return { name, commandText: `/skill:${name}`, scope: null };
		}
		if (!suffix.startsWith("{")) {
			return { name, commandText: `/skill:${name} ${suffix}`, scope: null };
		}
		try {
			const payload = JSON.parse(suffix) as { scope?: unknown };
			return {
				name,
				commandText: `/skill:${name} ${suffix}`,
				scope: typeof payload.scope === "string" && payload.scope.trim().length > 0 ? payload.scope.trim() : null,
			};
		} catch {
			return { name, commandText: `/skill:${name} ${suffix}`, scope: null };
		}
	}

	private removeComposerSkillDraft(): void {
		this.selectedSkillDraft = null;
		this.render();
		this.syncComposerTextareaDeferred(this.inputText, { focus: true });
	}

	private slashQueryFromInput(): string | null {
		return getSlashQueryFromInput(this.inputText);
	}

	private updateSlashPaletteStateFromInput(): void {
		const query = this.slashQueryFromInput();
		if (query === null) {
			this.slashPaletteOpen = false;
			this.slashPaletteQuery = "";
			this.slashPaletteIndex = 0;
			this.slashPaletteNavigationMode = "pointer";
			return;
		}
		const wasOpen = this.slashPaletteOpen;
		const normalized = query.toLowerCase();
		if (!wasOpen || normalized !== this.slashPaletteQuery) {
			this.slashPaletteIndex = 0;
			this.slashPaletteNavigationMode = "pointer";
		}
		this.slashPaletteOpen = true;
		this.slashPaletteQuery = normalized;
		void this.ensureSlashCommandsLoaded(!wasOpen);
	}

	private closeSlashPalette(clearInput = false): void {
		this.slashPaletteOpen = false;
		this.slashPaletteQuery = "";
		this.slashPaletteIndex = 0;
		this.slashPaletteNavigationMode = "pointer";
		if (clearInput) this.inputText = "";
	}

	private parseSlashInput(value: string): { commandText: string; commandName: string; args: string } | null {
		return parseSlashInputText(value);
	}

	private async ensureSlashCommandsLoaded(force = false): Promise<void> {
		if (this.slashCommandsLoading) return;
		if (!force && this.slashRuntimeCommands.length > 0 && Date.now() - this.slashCommandsUpdatedAt < 15_000) return;
		this.slashCommandsLoading = true;
		if (this.slashPaletteOpen || this.addMenuOpen) this.render();
		try {
			const runtimeCommands = await rpcBridge.getCommands().catch(() => []);
			this.slashRuntimeCommands = normalizeRuntimeSlashCommands(runtimeCommands as Array<Record<string, unknown>>);
			this.slashCommandsUpdatedAt = Date.now();
		} catch {
			this.slashRuntimeCommands = this.slashRuntimeCommands.slice();
			this.slashCommandsUpdatedAt = Date.now();
		} finally {
			this.slashCommandsLoading = false;
			if (this.slashPaletteOpen || this.addMenuOpen) this.render();
		}
	}

	private buildAllSlashPaletteItems(): SlashPaletteItem[] {
		return createSlashPaletteItems(this.slashRuntimeCommands);
	}

	private getSlashPaletteItems(): SlashPaletteItem[] {
		if (!this.slashPaletteOpen) return [];
		return filterSlashPaletteItemsByQuery(this.buildAllSlashPaletteItems(), this.slashPaletteQuery);
	}

	private findSlashPaletteItemByName(commandName: string): SlashPaletteItem | null {
		return findSlashPaletteItemByName(this.buildAllSlashPaletteItems(), commandName);
	}

	private unwrapQuotedArg(value: string): string {
		return unwrapQuotedArgValue(value);
	}

	private normalizedAuthProviderArg(rawArgs: string): string {
		return normalizeAuthProviderArgValue(rawArgs);
	}

	private providerKey(provider: string): string {
		return normalizeProviderKeyValue(provider);
	}

	private isUnknownRuntimeModel(provider: string, modelId: string): boolean {
		const providerKey = this.providerKey(provider);
		const modelKey = normalizeText(modelId).toLowerCase();
		return providerKey === "unknown" && (modelKey.length === 0 || modelKey === "unknown");
	}

	private currentModelSelection(state: RpcSessionState | null | undefined = this.state): { provider: string; modelId: string } {
		const provider = normalizeText(state?.model?.provider);
		const modelId = normalizeText(state?.model?.id);
		if (this.isUnknownRuntimeModel(provider, modelId)) {
			return { provider: "", modelId: "" };
		}
		return { provider, modelId };
	}

	private isOAuthProviderId(provider: string): boolean {
		return isOAuthProviderIdInCatalog(provider, this.oauthProviderCatalog);
	}

	private displayProviderLabel(provider: string): string {
		return displayProviderLabelFromCatalog(provider, this.oauthProviderCatalog);
	}

	private async loadOAuthProviderCatalog(force = false): Promise<void> {
		if (this.oauthProviderCatalogLoading) return;
		const stale = Date.now() - this.oauthProviderCatalogLoadedAt > MODEL_PICKER_AUTH_CACHE_MS;
		if (!force && this.oauthProviderCatalogLoadedAt > 0 && !stale) return;
		this.oauthProviderCatalogLoading = true;
		try {
			const raw = await rpcBridge.getPiOAuthProviders();
			this.oauthProviderCatalog = normalizeOAuthProviderCatalogEntries(raw);
			this.oauthProviderCatalogLoadedAt = Date.now();
		} catch (err) {
			console.error("Failed to load OAuth provider catalog:", err);
			if (this.oauthProviderCatalogLoadedAt === 0) {
				this.oauthProviderCatalog = normalizeOAuthProviderCatalogEntries([]);
			}
		} finally {
			this.oauthProviderCatalogLoading = false;
			this.render();
		}
	}

	private recomputeProviderAuthConfigured(): void {
		const next = new Set<string>();
		for (const provider of this.providerAuthById.keys()) {
			if (this.providerAuthForcedLoggedOut.has(provider)) continue;
			next.add(provider);
		}
		this.providerAuthConfigured = next;
	}

	private async loadProviderAuthStatus(force = false): Promise<void> {
		if (this.loadingProviderAuth) return;
		const stale = Date.now() - this.providerAuthLoadedAt > MODEL_PICKER_AUTH_CACHE_MS;
		if (!force && this.providerAuthLoadedAt > 0 && !stale) return;
		this.loadingProviderAuth = true;
		try {
			const raw = await rpcBridge.getPiAuthStatus();
			const next = normalizeConfiguredProviderAuthEntries(raw?.configured_providers);
			this.providerAuthById = next;
			this.providerAuthLoadedAt = Date.now();
			for (const provider of next.keys()) {
				this.providerAuthForcedLoggedOut.delete(provider);
			}
			this.recomputeProviderAuthConfigured();
		} catch (err) {
			console.error("Failed to load provider auth status:", err);
			if (this.providerAuthLoadedAt === 0) {
				this.providerAuthById = new Map();
			}
			this.recomputeProviderAuthConfigured();
		} finally {
			this.loadingProviderAuth = false;
			this.render();
		}
	}

	private async loadModelCatalog(force = false): Promise<void> {
		if (this.loadingModelCatalog) return;
		const stale = Date.now() - this.modelCatalogLoadedAt > MODEL_PICKER_CATALOG_CACHE_MS;
		if (!force && this.modelCatalogLoadedAt > 0 && !stale) return;
		this.loadingModelCatalog = true;
		try {
			const result = await rpcBridge.runPiCliCommand(["--list-models"], {
				cwd: this.projectPath || ".",
			});
			if (result.exit_code !== 0) {
				throw new Error(result.stderr || result.stdout || `pi --list-models failed with exit ${result.exit_code}`);
			}
			const parsed = parseListModelsCatalog(result.stdout || "");
			this.modelCatalog = parsed;
			this.modelCatalogLoadedAt = Date.now();
		} catch (err) {
			console.error("Failed to load model catalog:", err);
		} finally {
			this.loadingModelCatalog = false;
			this.render();
		}
	}

	private resolveProviderSetupCommand(provider: string): string | null {
		return resolveProviderSetupCommandForProvider(provider, this.slashRuntimeCommands);
	}

	private async openProviderSetup(provider: string): Promise<boolean> {
		const providerKey = this.providerKey(provider);
		if (!providerKey) return false;
		if (this.onOpenProviderConfig) {
			try {
				const handled = await this.onOpenProviderConfig(providerKey);
				if (handled) return true;
			} catch {
				// ignore and continue fallback flow
			}
		}
		await this.ensureSlashCommandsLoaded();
		const setupCommand = this.resolveProviderSetupCommand(providerKey);
		if (setupCommand && this.onOpenExtensionConfig) {
			const handled = await this.onOpenExtensionConfig(setupCommand, "config");
			if (handled) return true;
		}
		return false;
	}

	private async handleProviderAuthAction(provider: string, action: "login" | "logout"): Promise<void> {
		const providerKey = this.providerKey(provider);
		if (!providerKey) return;
		if (this.runningProviderAuthAction) return;

		this.runningProviderAuthAction = { provider: providerKey, action };
		this.render();
		const providerLabel = this.displayProviderLabel(providerKey);

		try {
			if (action === "login") {
				if (!this.isOAuthProviderId(providerKey)) {
					await this.loadOAuthProviderCatalog(true);
				}
				if (this.isOAuthProviderId(providerKey)) {
					const loginCommand = `pi login ${providerKey}`;
					if (this.onOpenTerminal) {
						await this.onOpenTerminal(loginCommand);
						this.pushNotice(t("chatView.auth.terminalLoginStarted", { provider: providerLabel }), "info");
						return;
					}
					this.pushNotice(t("chatView.auth.runInTerminal", { command: loginCommand }), "info");
					return;
				}
				const openedPackageConfig = await this.openProviderSetup(providerKey);
				if (openedPackageConfig) {
					this.pushNotice(t("chatView.auth.openedSetup", { provider: providerLabel }), "info");
					return;
				}
				if (this.onOpenSettings) {
					this.onOpenSettings("account");
				}
				this.appendSystemMessage(
					t("chatView.auth.openSetupInPackages", { provider: providerLabel }),
					{ label: "auth", markdown: true },
				);
				this.pushNotice(t("chatView.auth.openedAccountSetup", { provider: providerLabel }), "info");
				return;
			}

			const result = await rpcBridge.clearPiProviderAuth(providerKey);
			if (result.removed) {
				// auth 变了，可用模型列表随之变化：清掉该 runtime 的模型缓存。
				rpcBridge.clearAvailableModelsCache();
				this.providerAuthForcedLoggedOut.add(providerKey);
				this.providerAuthById.delete(providerKey);
				this.recomputeProviderAuthConfigured();
				this.pushNotice(t("chatView.auth.loggedOut", { provider: providerLabel }), "success");
			} else if (result.source === "environment") {
				this.pushNotice(t("chatView.auth.envVarConfigured", { provider: providerLabel }), "info");
			} else {
				this.providerAuthForcedLoggedOut.add(providerKey);
				this.providerAuthById.delete(providerKey);
				this.recomputeProviderAuthConfigured();
				this.pushNotice(t("chatView.auth.noStoredCredentials", { provider: providerLabel }), "info");
			}

			if (this.onReloadRuntime) {
				try {
					await this.onReloadRuntime();
				} catch {
					// best-effort reload only
				}
			}

			await Promise.all([
				this.refreshFromBackend(),
				this.loadProviderAuthStatus(true),
				this.loadOAuthProviderCatalog(true),
				this.loadAvailableModels(),
				this.loadModelCatalog(true),
			]);
			await this.switchAwayFromLoggedOutProvider(providerKey);
		} catch (err) {
			console.error(`Provider auth action failed (${action}:${providerKey}):`, err);
			this.pushNotice(err instanceof Error ? err.message : t("chatView.auth.actionFailed"), "error");
		} finally {
			this.runningProviderAuthAction = null;
			this.render();
		}
	}

	private async switchAwayFromLoggedOutProvider(providerKey: string): Promise<void> {
		const currentProvider = this.providerKey(this.state?.model?.provider ?? "");
		if (!currentProvider || currentProvider !== providerKey) return;
		const fallback = this.availableModels.find((model) => this.providerKey(model.provider) !== providerKey) ?? null;
		if (!fallback) {
			this.pushNotice(t("chatView.auth.noOtherModels"), "info");
			return;
		}
		await this.setModel(fallback.provider, fallback.id);
	}

	private async pickSessionImportPathFromDialog(): Promise<string | null> {
		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const selected = await open({
				multiple: false,
				directory: false,
				filters: [{ name: t("chatView.session.importFilter"), extensions: ["jsonl", "json"] }],
				defaultPath: this.projectPath || undefined,
			});
			if (Array.isArray(selected)) {
				const first = selected.find((entry) => typeof entry === "string" && entry.trim().length > 0);
				return typeof first === "string" ? first : null;
			}
			if (typeof selected === "string" && selected.trim().length > 0) {
				return selected;
			}
			return null;
		} catch (err) {
			console.error("Failed to open session import picker:", err);
			this.pushNotice(t("chatView.notice.openImportPickerFailed"), "error");
			return null;
		}
	}

	private async pickSessionExportPathFromDialog(): Promise<string | null> {
		try {
			const { save } = await import("@tauri-apps/plugin-dialog");
			const basePath = this.projectPath ? `${this.projectPath.replace(/\\/g, "/")}/session.html` : "session.html";
			const selected = await save({
				title: t("chatView.session.exportTitle"),
				defaultPath: basePath,
				filters: [{ name: "HTML", extensions: ["html"] }],
			});
			if (typeof selected === "string" && selected.trim().length > 0) {
				return selected;
			}
			return null;
		} catch (err) {
			console.error("Failed to open export picker:", err);
			this.pushNotice(t("chatView.notice.openExportPickerFailed"), "error");
			return null;
		}
	}

	private async executeSlashCommandFromComposer(): Promise<void> {
		const slashQuery = this.slashQueryFromInput();
		const parsed = this.parseSlashInput(this.inputText);
		if (!parsed && slashQuery === null) return;
		if (parsed && parsed.commandName.startsWith("skill:")) {
			const skillCommandText = `/${parsed.commandName}${parsed.args ? ` ${parsed.args}` : ""}`;
			if (this.stageSkillSlashCommand(skillCommandText)) return;
		}
		if (this.pendingImages.length > 0 || this.pendingFileReferences.length > 0) {
			this.pushNotice(t("chatView.composer.slashWithAttachments"), "info");
			return;
		}
		await this.ensureSlashCommandsLoaded();
		const liveItems = this.getSlashPaletteItems();
		if (parsed) {
			const exact = this.findSlashPaletteItemByName(parsed.commandName);
			if (exact) {
				if (exact.source === "skill" && this.stageSkillSlashCommand(parsed.commandText)) return;
				await this.runSlashCommand(parsed.commandText, exact, parsed.args);
				return;
			}
		}
		if (this.slashPaletteOpen && liveItems.length > 0) {
			const picked = liveItems[Math.max(0, Math.min(this.slashPaletteIndex, liveItems.length - 1))];
			const pickedArgs = parsed && parsed.commandName === picked.commandName ? parsed.args : "";
			const commandText = `/${picked.commandName}${pickedArgs ? ` ${pickedArgs}` : ""}`;
			if (picked.source === "skill" && this.stageSkillSlashCommand(commandText)) return;
			await this.runSlashCommand(commandText, picked, pickedArgs);
			return;
		}
		if (parsed) {
			const adhocRuntimeItem: SlashPaletteItem = {
				id: `adhoc:${parsed.commandName}`,
				section: "Commands",
				label: `/${parsed.commandName}`,
				hint: t("chatView.composer.runRuntimeSlashHint"),
				commandName: parsed.commandName,
				source: "other",
			};
			await this.runSlashCommand(parsed.commandText, adhocRuntimeItem, parsed.args);
			return;
		}
		this.pushNotice(t("chatView.composer.selectSlashCommand"), "info");
	}

	async runSlashCommandText(commandText: string): Promise<boolean> {
		const parsed = this.parseSlashInput(commandText);
		if (!parsed) return false;
		await this.ensureSlashCommandsLoaded();
		const exact = this.findSlashPaletteItemByName(parsed.commandName);
		if (exact) {
			await this.runSlashCommand(parsed.commandText, exact, parsed.args);
			return true;
		}
		const fallbackItem: SlashPaletteItem = {
			id: `adhoc:${parsed.commandName}`,
			section: "Commands",
			label: `/${parsed.commandName}`,
			hint: t("chatView.composer.runRuntimeSlashHint"),
			commandName: parsed.commandName,
			source: "other",
		};
		await this.runSlashCommand(parsed.commandText, fallbackItem, parsed.args);
		return true;
	}

	private async runSlashCommand(commandText: string, item: SlashPaletteItem, args: string): Promise<void> {
		const trimmedCommandText = commandText.trim();
		if (!trimmedCommandText) return;
		this.rememberComposerHistoryEntry(trimmedCommandText);
		this.clearComposer();
		this.sendingPrompt = true;
		this.render();
		try {
			if (item.source === "builtin") {
				await this.executeBuiltinSlashCommand(item.commandName, args);
			} else {
				await this.executeRuntimeSlashCommand(trimmedCommandText, item.source, item.commandName, args);
			}
		} catch (err) {
			console.error(`Slash command failed (${item.commandName}):`, err);
			const message = err instanceof Error ? err.message : String(err);
			this.pushNotice(message || t("chatView.composer.runSlashFailed", { name: item.commandName }), "error");
		} finally {
			this.sendingPrompt = false;
			this.render();
		}
	}

	private async executeRuntimeSlashCommand(
		commandText: string,
		source: Exclude<SlashCommandSource, "builtin">,
		commandName: string,
		args: string,
	): Promise<void> {
		if (source === "extension" && this.onOpenExtensionConfig) {
			const normalizedName = normalizeExtensionCommandName(commandName);
			if (isExtensionConfigIntent(normalizedName, args)) {
				const handled = await this.onOpenExtensionConfig(normalizedName, args);
				if (handled) return;
			}
		}
		const options = this.currentIsStreaming() ? { streamingBehavior: "steer" as const } : {};
		await rpcBridge.prompt(commandText, options);
		this.onPromptSubmitted?.();
	}

	private ensureModelPickerDataLoaded(): void {
		if (!this.loadingModels && this.availableModels.length === 0) {
			void this.loadAvailableModels();
		}
		if (!this.loadingProviderAuth) {
			void this.loadProviderAuthStatus();
		}
		if (!this.oauthProviderCatalogLoading) {
			void this.loadOAuthProviderCatalog();
		}
		if (!this.loadingModelCatalog && this.modelCatalog.length === 0) {
			void this.loadModelCatalog();
		}
	}

	private setModelPickerActiveProvider(provider: string): void {
		const normalized = normalizeText(provider);
		if (!normalized) return;
		const changed = this.modelPickerActiveProvider !== normalized || !this.modelPickerSubmenuOpen;
		this.modelPickerActiveProvider = normalized;
		this.modelPickerSubmenuOpen = true;
		if (!changed) return;
		this.render();
		this.clampModelPickerPopover();
	}

	private closeModelPicker(options: { focusComposer?: boolean } = {}): void {
		if (!this.modelPickerOpen) return;
		this.modelPickerOpen = false;
		this.modelPickerSubmenuOpen = false;
		this.cancelModelPickerLayout();
		this.render();
		if (options.focusComposer) {
			requestAnimationFrame(() => this.focusInput());
		}
	}

	private openModelPicker(options: { preferredProvider?: string } = {}): void {
		this.ensureModelPickerDataLoaded();
		const providerPool = [...this.availableModels, ...this.modelCatalog];
		const preferred = resolvePreferredModelPickerProvider(normalizeText(options.preferredProvider), providerPool);
		if (preferred) {
			this.modelPickerActiveProvider = preferred;
		}
		if (!this.modelPickerActiveProvider) {
			const currentProvider = this.currentModelSelection().provider;
			if (currentProvider) {
				this.modelPickerActiveProvider = currentProvider;
			}
		}
		this.modelPickerOpen = true;
		this.modelPickerSubmenuOpen = false;
		this.addMenuOpen = false;
		this.thinkingMenuOpen = false;
		this.render();
		this.clampModelPickerPopover();
	}

	/**
	 * 弹层固定从 composer 向上弹出（bottom 锚定触发器），窗口偏矮时顶部会被裁掉。
	 * 打开后量一次触发器上方可用空间，用 inline max-height 把弹层压进可视区域：
	 * 上方空间不足时不设硬下限、继续压低高度，保证弹层顶部距窗口上边缘 ≥ 8px；
	 * 高度收缩后内容各自内部滚动（CSS overflow-y: auto）。
	 * 触发器尚未排版（rect 全 0）时下一帧重试一次，仍失败则交给 CSS max-height 兜底。
	 */
	private clampUpwardPopover(rootSelector: string, popoverSelector: string, preferredMaxHeight: number, retried = false): void {
		requestAnimationFrame(() => {
			const root = this.container.querySelector<HTMLElement>(rootSelector);
			const popover = this.container.querySelector<HTMLElement>(popoverSelector);
			if (!root || !popover) return;
			const rootRect = root.getBoundingClientRect();
			if (rootRect.top === 0 && rootRect.height === 0) {
				if (!retried) this.clampUpwardPopover(rootSelector, popoverSelector, preferredMaxHeight, true);
				return;
			}
			// 8px 弹层与触发器间距（bottom: calc(100% + 8px)）+ 8px 视口上边距
			const available = Math.floor(rootRect.top - 16);
			const maxHeight = Math.min(preferredMaxHeight, Math.max(available, 0));
			popover.style.maxHeight = `${maxHeight}px`;
		});
	}

	private clampModelPickerPopover(): void {
		this.clampUpwardPopover(".model-picker-root", ".model-picker-popover", 244);
		this.scheduleModelPickerLayout();
	}

	private positionModelPickerSubmenu(): void {
		this.scheduleModelPickerLayout();
	}

	private scheduleModelPickerLayout(): void {
		if (!this.modelPickerOpen || this.modelPickerLayoutFrame !== null) return;
		this.modelPickerLayoutFrame = requestAnimationFrame(() => {
			this.modelPickerLayoutFrame = null;
			this.layoutModelPicker();
		});
	}

	private cancelModelPickerLayout(): void {
		if (this.modelPickerLayoutFrame !== null) {
			cancelAnimationFrame(this.modelPickerLayoutFrame);
			this.modelPickerLayoutFrame = null;
		}
		this.modelPickerResizeObserver?.disconnect();
	}

	private layoutModelPicker(): void {
		if (!this.modelPickerOpen) return;
		const root = this.container.querySelector<HTMLElement>(".model-picker-root");
		const popover = this.container.querySelector<HTMLElement>(".model-picker-popover");
		const activeRow = popover?.querySelector<HTMLElement>(".model-picker-provider-row.active");
		const submenu = popover?.querySelector<HTMLElement>(".model-picker-model-submenu");
		if (!root || !popover) return;
		const chatRoot = root.closest<HTMLElement>(".chat-root") ?? this.container.querySelector<HTMLElement>(".chat-root");
		this.observeModelPickerLayout(root, popover, chatRoot);
		const rootRect = root.getBoundingClientRect();
		const popoverRect = popover.getBoundingClientRect();
		if (rootRect.width === 0 || popoverRect.width === 0) return;
		const chatRect = chatRoot?.getBoundingClientRect();
		const contentLeft = Math.max(8, (chatRect?.left ?? 0) + 8);
		const contentRight = Math.min(window.innerWidth - 8, (chatRect?.right ?? window.innerWidth) - 8);
		const preferredPopoverLeft = resolveViewportPopoverLeft(
			rootRect.right,
			popoverRect.width,
			window.innerWidth,
		);

		if (!activeRow || !submenu || !this.modelPickerSubmenuOpen) {
			const maximumLeft = Math.max(contentLeft, contentRight - popoverRect.width);
			const clampedLeft = Math.min(Math.max(preferredPopoverLeft, contentLeft), maximumLeft);
			popover.style.right = "auto";
			popover.style.left = `${Math.round(clampedLeft - rootRect.left)}px`;
			return;
		}

		submenu.style.width = "";
		submenu.style.maxHeight = "";
		const activeRowRect = activeRow.getBoundingClientRect();
		const naturalSubmenuRect = submenu.getBoundingClientRect();
		if (activeRowRect.height === 0 || naturalSubmenuRect.width === 0) return;
		const rootStyle = getComputedStyle(root);
		const configuredSubmenuWidth = Number.parseFloat(rootStyle.getPropertyValue("--model-picker-submenu-width")) || naturalSubmenuRect.width;
		const submenuGap = Number.parseFloat(rootStyle.getPropertyValue("--model-picker-submenu-gap")) || 3;
		const placement = resolveModelPickerSubmenuPlacement({
			preferredPopoverLeft,
			popoverWidth: popoverRect.width,
			popoverTop: popoverRect.top,
			anchorTop: activeRowRect.top,
			submenuWidth: configuredSubmenuWidth,
			submenuHeight: naturalSubmenuRect.height,
			contentLeft,
			contentRight,
			contentBottom: rootRect.top - 8,
			gap: submenuGap,
		});
		popover.style.right = "auto";
		popover.style.left = `${Math.round(placement.popoverLeft - rootRect.left)}px`;
		submenu.style.right = "auto";
		submenu.style.left = `${Math.round(placement.submenuLeft - placement.popoverLeft - popover.clientLeft)}px`;
		submenu.style.top = `${Math.round(placement.top - popover.clientTop)}px`;
		submenu.style.width = `${Math.round(placement.submenuWidth)}px`;
		submenu.style.maxHeight = `${Math.round(placement.submenuMaxHeight)}px`;
		submenu.dataset.side = placement.side;
	}

	private observeModelPickerLayout(
		root: HTMLElement,
		popover: HTMLElement,
		chatRoot: HTMLElement | null,
	): void {
		if (typeof ResizeObserver === "undefined") return;
		this.modelPickerResizeObserver ??= new ResizeObserver(() => this.scheduleModelPickerLayout());
		this.modelPickerResizeObserver.disconnect();
		this.modelPickerResizeObserver.observe(root);
		this.modelPickerResizeObserver.observe(popover);
		if (chatRoot) this.modelPickerResizeObserver.observe(chatRoot);
	}

	private toggleModelPicker(preferredProvider = ""): void {
		if (this.modelPickerOpen) {
			this.closeModelPicker();
			return;
		}
		this.openModelPicker({ preferredProvider });
	}

	private closeAddMenu(options: { focusComposer?: boolean } = {}): void {
		if (!this.addMenuOpen) return;
		this.addMenuOpen = false;
		this.render();
		if (options.focusComposer) {
			requestAnimationFrame(() => this.focusInput());
		}
	}

	private openAddMenu(): void {
		this.addMenuOpen = true;
		this.modelPickerOpen = false;
		this.thinkingMenuOpen = false;
		this.render();
		this.clampAddMenuPopover();
		// 技能列表来自 slash runtime 的 get_commands；异步加载完成后刷新菜单内容
		// （ensureSlashCommandsLoaded 在 addMenuOpen 时也会触发 render）。
		void this.ensureSlashCommandsLoaded();
	}

	private toggleAddMenu(): void {
		if (this.addMenuOpen) {
			this.closeAddMenu({ focusComposer: true });
			return;
		}
		this.openAddMenu();
	}

	/** 与 clampModelPickerPopover 同理：把向上弹出的菜单压进触发器上方的可视区域。 */
	private clampAddMenuPopover(): void {
		this.clampUpwardPopover(".add-menu-root", ".add-menu-popover", 360);
	}

	private closeThinkingMenu(options: { focusComposer?: boolean } = {}): void {
		if (!this.thinkingMenuOpen) return;
		this.thinkingMenuOpen = false;
		this.render();
		if (options.focusComposer) {
			requestAnimationFrame(() => this.focusInput());
		}
	}

	private openThinkingMenu(): void {
		this.thinkingMenuOpen = true;
		this.modelPickerOpen = false;
		this.addMenuOpen = false;
		this.render();
		this.clampThinkingMenuPopover();
	}

	private toggleThinkingMenu(): void {
		if (this.thinkingMenuOpen) {
			this.closeThinkingMenu();
			return;
		}
		this.openThinkingMenu();
	}

	private clampThinkingMenuPopover(): void {
		this.clampUpwardPopover(".thinking-select-root", ".thinking-menu-popover", 240);
	}

	/** 「+」菜单点击技能：复用斜杠面板的 skill stage 逻辑，生成 /skill:<name> 草稿 pill。 */
	private stageSkillFromAddMenu(name: string): void {
		this.addMenuOpen = false;
		if (!this.stageSkillSlashCommand(`/skill:${name}`)) {
			this.render();
		}
	}

	private addMenuSkills(): { name: string; description: string }[] {
		return this.slashRuntimeCommands
			.filter((command) => command.source === "skill")
			.map((command) => ({ name: command.name, description: command.description }));
	}

	private resolveProviderHintFromModelArg(rawArg: string): string | null {
		return resolveProviderHintFromModelArg(rawArg, [...this.availableModels, ...this.modelCatalog]);
	}

	private resolveModelCandidateFromArg(rawArg: string): ModelOption | null {
		return resolveModelCandidateFromArg(rawArg, this.availableModels);
	}

	private async executeBuiltinSlashCommand(commandName: string, args: string): Promise<void> {
		await executeBuiltinSlashCommandView({
			commandName,
			args,
			availableModelsCount: this.availableModels.length,
			onOpenSettings: this.onOpenSettings,
			pushNotice: this.pushNotice.bind(this),
			truncate,
			openModelPicker: this.openModelPicker.bind(this),
			loadAvailableModels: this.loadAvailableModels.bind(this),
			resolveModelCandidateFromArg: this.resolveModelCandidateFromArg.bind(this),
			resolveProviderHintFromModelArg: this.resolveProviderHintFromModelArg.bind(this),
			setModel: this.setModel.bind(this),
			unwrapQuotedArg: this.unwrapQuotedArg.bind(this),
			pickSessionExportPathFromDialog: this.pickSessionExportPathFromDialog.bind(this),
			pickSessionImportPathFromDialog: this.pickSessionImportPathFromDialog.bind(this),
			refreshFromBackend: this.refreshFromBackend.bind(this),
			shareAsGist: this.shareAsGist.bind(this),
			copyLastMessage: this.copyLastMessage.bind(this),
			onBeginRenameCurrentSession: this.onBeginRenameCurrentSession,
			renameSession: this.renameSession.bind(this),
			renameSessionTo: this.renameSessionTo.bind(this),
			refreshSessionStats: this.refreshSessionStats.bind(this),
			buildSessionInfoBlock: () =>
				formatSessionInfoBlockView({
					state: this.state,
					sessionStats: this.sessionStats,
					messages: this.messages,
				}),
			appendSystemMessage: this.appendSystemMessage.bind(this),
			loadPiAgentChangelogMarkdown: this.loadPiAgentChangelogMarkdown.bind(this),
			extractLatestChangelogSections: this.extractLatestChangelogSections.bind(this),
			onOpenShortcuts: this.onOpenShortcuts,
			onOpenTerminal: this.onOpenTerminal,
			sessionName: this.state?.sessionName ?? null,
			openHistoryViewerForFork: this.openHistoryViewerForFork.bind(this),
			openHistoryViewer: this.openHistoryViewer.bind(this),
			normalizedAuthProviderArg: this.normalizedAuthProviderArg.bind(this),
			handleProviderAuthAction: this.handleProviderAuthAction.bind(this),
			onCreateFreshSession: this.onCreateFreshSession,
			newSession: this.newSession.bind(this),
			compactNow: this.compactNow.bind(this),
			onOpenSessionBrowser: this.onOpenSessionBrowser,
			onReloadRuntime: this.onReloadRuntime,
			ensureSlashCommandsLoaded: this.ensureSlashCommandsLoaded.bind(this),
			loadProviderAuthStatus: this.loadProviderAuthStatus.bind(this),
			loadOAuthProviderCatalog: this.loadOAuthProviderCatalog.bind(this),
			loadModelCatalog: this.loadModelCatalog.bind(this),
			onQuitApp: this.onQuitApp,
		});
	}

	private previewSlashPaletteItem(item: SlashPaletteItem): void {
		const parsed = this.parseSlashInput(this.inputText);
		const args = parsed && parsed.commandName === item.commandName ? parsed.args : "";
		const commandText = `/${item.commandName}${args ? ` ${args}` : ""}`;
		if (this.inputText === commandText) return;
		this.inputText = commandText;
		this.syncComposerTextareaDeferred(commandText, {
			maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT,
			moveCaretToEnd: true,
		});
	}

	private selectSlashPaletteItem(item: SlashPaletteItem): void {
		const parsed = this.parseSlashInput(this.inputText);
		const args = parsed && parsed.commandName === item.commandName ? parsed.args : "";
		const commandText = `/${item.commandName}${args ? ` ${args}` : ""}`;
		if (item.source === "skill" && this.stageSkillSlashCommand(commandText)) return;
		void this.runSlashCommand(commandText, item, args);
	}

	private async bindNativeFileDropListener(): Promise<void> {
		if (this.nativeFileDropUnlisteners.length > 0) return;

		const handler = (event: { payload?: unknown }) => {
			const payload = event.payload as { type?: string; paths?: string[] };
			if (payload?.type !== "drop") return;
			if (!this.projectPath) return;

			const nativePaths = Array.isArray(payload.paths) ? payload.paths : [];
			if (this.handleDroppedPathCandidates(nativePaths, { quietImageReadFailure: true })) {
				if (nativePaths.length > 0) {
					clearActiveDraggedFilePaths();
				}
				return;
			}

			const sidebarFallbackPaths = peekActiveDraggedFilePaths();
			if (sidebarFallbackPaths.length > 0) {
				const handledFromSidebarFallback = this.handleDroppedPathCandidates(sidebarFallbackPaths, {
					quietImageReadFailure: true,
				});
				clearActiveDraggedFilePaths();
				if (handledFromSidebarFallback) return;
			}

			if (nativePaths.length > 0) {
				this.pushNotice(t("chatView.notice.noReadableDropped"), "info");
			}
		};

		try {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			const unlisten = await getCurrentWindow().onDragDropEvent(handler as any);
			this.nativeFileDropUnlisteners.push(unlisten);
		} catch (err) {
			console.warn("Failed to bind native window file-drop listener:", err);
		}

		try {
			const { getCurrentWebview } = await import("@tauri-apps/api/webview");
			const unlisten = await getCurrentWebview().onDragDropEvent(handler as any);
			this.nativeFileDropUnlisteners.push(unlisten);
		} catch (err) {
			console.warn("Failed to bind native webview file-drop listener:", err);
		}
	}

	/**
	 * 流式事件的节流渲染。
	 *
	 * 背景：tool_execution_update / assistant 增量这类事件可能以每秒几十上百条的
	 * 频率到达，而有些工具（典型如 subagent 扩展）的 onUpdate 载荷是「累积到当前
	 * 的全量文本」而不是增量。直连 render() 会变成 O(n²)：输出越长，每条 update
	 * 要 diff 的模板越大，主线程被打满，整个窗口失去响应。
	 *
	 * 策略：rAF 合帧 + 最小间隔。同一帧内的多次请求合为一次；超过帧预算时按
	 * STREAM_RENDER_MIN_INTERVAL_MS 降频。注意这里不能改 render() 本体：它有很多
	 * 调用方渲染后立即读 DOM（测尺寸、定位弹层），异步化会造成读到旧布局。
	 */
	/**
	 * 把 TodoPanel 绑到每次渲染后的插槽上。
	 *
	 * lit 重渲染会重用 DOM 节点，但不保证同一个引用；节点换了就重建面板
	 * 并把已有清单重新写回，否则面板会突然变空。
	 */
	private syncTodoPanelMount(): void {
		const slot = this.container.querySelector<HTMLElement>("#todo-panel-slot");
		if (!slot) {
			this.todoPanel = null;
			return;
		}
		if (this.todoPanelSlot === slot && this.todoPanel) {
			this.todoPanel.render();
			return;
		}
		this.todoPanelSlot = slot;
		// 插槽节点被 lit 换掉时面板要重建，但用户的展开/关闭选择不能因此丢失。
		const carriedViewState = this.todoPanel?.exportViewState() ?? this.todoViewState;
		const panel = new TodoPanel(slot, (state) => {
			this.todoViewState = state;
		});
		panel.restoreViewState(carriedViewState);
		if (this.todoItems.length > 0) panel.setTodos(this.todoItems);
		// setTodos 在内容变化时会重置 dismissed（有新任务就应该重新出现），
		// 重建场景下内容未变，所以这里再把视图态盖回去。
		panel.restoreViewState(carriedViewState);
		this.todoPanel = panel;
		panel.render();
	}

	/**
	 * 从工具结果的 details 里提取清单。由两条路径调：
	 * - 运行中：`tool_execution_end` 事件；
	 * - 切会话/重载：`get_messages` 的 toolResult 回放。
	 */
	private applyTodoDetails(details: unknown): void {
		const parsed = parseTodoDetails(details);
		if (!parsed) return;
		// 实时更新总是比历史快照新：递增代次，让在途刷新的结果作废。
		this.todoLiveGeneration += 1;
		this.todoItems = parsed;
		this.todoPanel?.setTodos(parsed);
	}

	/** 切会话时清空：清单是会话级状态，绝不能串到另一个会话。 */
	private resetTodoState(): void {
		this.todoItems = [];
		this.todoViewState = { expanded: false, dismissed: false };
		this.todoPanel?.reset();
	}

	/**
	 * 从后端消息回放重建清单。
	 *
	 * 两个关键约束：
	 *
	 * 1. **不能用 mapBackendMessages 的结果**——它丢掉了 `details`（只保留文本），
	 *    所以这里扫原始消息。清单本身是全量快照，所以最后一条 toolResult 即最终态。
	 *
	 * 2. **找不到时绝不清空。** `backendMessages` 只是 `getSessionPage(..., 40)` 的
	 *    尾页，不是全量历史。最后一次 todo 调用一旦被后续 40 条 entry 挤出去，
	 *    这里就看不到它了——此时若清空面板，长会话里清单会无故消失。
	 *    切会话的真正清空在 setSession 里做（resetTodoState），不靠这里。
	 */
	private rebuildTodoStateFromBackend(backendMessages: Array<Record<string, unknown>>): void {
		// 优先用 Rust 侧全文件扇描得到的快照；没有（旧版后端或 get_messages
		// 回退路径）才退而扫手里这批消息。
		let latest: unknown = this.pendingTodoSnapshot;
		if (latest === null || latest === undefined) {
			for (const message of backendMessages) {
				if (message.role !== "toolResult") continue;
				if (message.toolName !== "todo") continue;
				if ("details" in message) latest = message.details;
			}
		}
		if (latest === null || latest === undefined) return;
		const parsed = parseTodoDetails(latest);
		if (!parsed) return;
		this.todoItems = parsed;
		this.todoPanel?.setTodos(parsed);
	}

	private scheduleStreamRender(): void {
		if (this.streamRenderRaf !== null || this.streamRenderTimer !== null) return;

		const flush = (): void => {
			this.streamRenderRaf = null;
			this.streamRenderTimer = null;
			this.streamRenderLastAt = Date.now();
			this.render();
		};

		const sinceLast = Date.now() - this.streamRenderLastAt;
		if (sinceLast >= STREAM_RENDER_MIN_INTERVAL_MS) {
			this.streamRenderRaf = requestAnimationFrame(flush);
			return;
		}
		this.streamRenderTimer = setTimeout(() => {
			this.streamRenderTimer = null;
			this.streamRenderRaf = requestAnimationFrame(flush);
		}, STREAM_RENDER_MIN_INTERVAL_MS - sinceLast);
	}

	/** 流结束/切会话时丢掉未落地的节流帧，避免它在新状态上多渲染一次。 */
	private cancelStreamRender(): void {
		if (this.streamRenderRaf !== null) {
			cancelAnimationFrame(this.streamRenderRaf);
			this.streamRenderRaf = null;
		}
		if (this.streamRenderTimer !== null) {
			clearTimeout(this.streamRenderTimer);
			this.streamRenderTimer = null;
		}
	}

	/**
	 * 只在组件销毁时调：丢掉未落地的滚动帧。
	 * 不能并入 cancelStreamRender——后者在流结束时也会调，而那些调用方只补 render()
	 * 不补 scrollToBottom()，在那里取消会直接丢掉流的最后一次滚到底。
	 * 窗口转后台时 rAF 会暂停，旧 ChatView 可能被保留到恢复之后，届时这个回调
	 * 会去操作已经不归它的滚动容器。
	 */
	private cancelPendingScrollFrame(): void {
		if (this.scrollToBottomRaf === null) return;
		cancelAnimationFrame(this.scrollToBottomRaf);
		this.scrollToBottomRaf = null;
	}

	private scheduleStreamingUiReconcile(delayMs = 1800): void {
		if (this.streamingReconcileTimer) {
			clearTimeout(this.streamingReconcileTimer);
		}
		this.streamingReconcileTimer = setTimeout(() => {
			this.streamingReconcileTimer = null;
			void this.reconcileStreamingUiState();
		}, delayMs);
	}

	private cancelStreamingUiReconcile(): void {
		if (!this.streamingReconcileTimer) return;
		clearTimeout(this.streamingReconcileTimer);
		this.streamingReconcileTimer = null;
	}

	private onGlobalPointerDownForModelPicker = (event: Event): void => {
		if (this.modelPickerOpen) {
			const target = event.target;
			if (!(target instanceof Element && target.closest(".model-picker-root"))) {
				this.closeModelPicker();
			}
		}
		if (this.addMenuOpen) {
			const target = event.target;
			if (!(target instanceof Element && target.closest(".add-menu-root"))) {
				this.closeAddMenu();
			}
		}
		if (this.thinkingMenuOpen) {
			const target = event.target;
			if (!(target instanceof Element && target.closest(".thinking-select-root"))) {
				this.closeThinkingMenu();
			}
		}
	};

	private onGlobalEscapeForModelPicker = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		if (this.modelPickerOpen) {
			event.preventDefault();
			this.closeModelPicker();
		}
		if (this.addMenuOpen) {
			event.preventDefault();
			this.closeAddMenu();
		}
		if (this.thinkingMenuOpen) {
			event.preventDefault();
			this.closeThinkingMenu();
		}
	};

	private onGlobalViewportChangeForModelPicker = (): void => {
		if (!this.modelPickerOpen) return;
		this.clampModelPickerPopover();
	};

	private bindModelPickerGlobalListeners(): void {
		if (this.modelPickerGlobalListenersBound || typeof document === "undefined") return;
		document.addEventListener("pointerdown", this.onGlobalPointerDownForModelPicker, true);
		document.addEventListener("mousedown", this.onGlobalPointerDownForModelPicker, true);
		document.addEventListener("keydown", this.onGlobalEscapeForModelPicker, true);
		window.addEventListener("resize", this.onGlobalViewportChangeForModelPicker, true);
		this.modelPickerGlobalListenersBound = true;
	}

	private unbindModelPickerGlobalListeners(): void {
		if (!this.modelPickerGlobalListenersBound || typeof document === "undefined") return;
		document.removeEventListener("pointerdown", this.onGlobalPointerDownForModelPicker, true);
		document.removeEventListener("mousedown", this.onGlobalPointerDownForModelPicker, true);
		document.removeEventListener("keydown", this.onGlobalEscapeForModelPicker, true);
		window.removeEventListener("resize", this.onGlobalViewportChangeForModelPicker, true);
		this.modelPickerGlobalListenersBound = false;
	}

	connect(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = rpcBridge.onEvent((event) => this.handleEvent(event));
		this.bindModelPickerGlobalListeners();
		void this.bindNativeFileDropListener();
		this.isConnected = rpcBridge.isConnected;
		if (!this.isConnected) return;
		void this.refreshFromBackend();
		void this.loadAvailableModels();
		void this.refreshAvailableThinkingLevels();
		void this.loadProviderAuthStatus();
		void this.loadOAuthProviderCatalog();
		void this.loadModelCatalog();
	}

	disconnect(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = null;
		this.cancelStreamingUiReconcile();
		this.cancelStreamRender();
		this.cancelPendingScrollFrame();
		this.runHasAssistantText = false;
		this.runSawToolActivity = false;
		this.keepWorkflowExpandedUntilAssistantText = false;
		this.clearWorkingStatusTimer(true);
		this.clearWorkflowElapsedTicker();
		this.cancelScheduledSessionScroll();
		for (const unlisten of this.nativeFileDropUnlisteners) {
			unlisten();
		}
		this.nativeFileDropUnlisteners = [];
		this.unbindModelPickerGlobalListeners();
		this.cancelModelPickerLayout();
		this.modelPickerResizeObserver = null;
		this.composerResizeObserver?.disconnect();
		this.composerResizeObserver = null;
		this.observedComposerElement = null;
	}

	async refreshFromBackend(options: { throwOnError?: boolean } = {}): Promise<void> {
		const push = (window as typeof window & {
			__PI_DESKTOP_PUSH_TRACE__?: (message: string) => void;
		}).__PI_DESKTOP_PUSH_TRACE__;
		const requestInstanceId = rpcBridge.getInstanceId();
		// SESSION-02：每次刷新独占一个代次。切会话（prepareForSessionSwitch）或更新的
		// 刷新开始都会使本代次过期；在途旧响应在每个 await 之后、提交之前整体丢弃。
		const generation = ++this.refreshGeneration;
		const isStale = (): boolean =>
			generation !== this.refreshGeneration || requestInstanceId !== rpcBridge.getInstanceId();
		const startedAt = Date.now();
		push?.(`chat:refreshFromBackend start instance=${requestInstanceId} gen=${generation}`);
		// 刷新开始时快照 todo 代次：读历史页期间若有实时更新到达，
		// 历史快照就已过时，不能拿它覆盖。
		const todoGenerationAtStart = this.todoLiveGeneration;
		try {
			const state = await rpcBridge.getState();
			if (isStale()) {
				push?.(
					`chat:refreshFromBackend stale instance=${requestInstanceId} active=${rpcBridge.getInstanceId()} gen=${generation} activeGen=${this.refreshGeneration}`,
				);
				return;
			}
			const backendMessages = await this.loadLatestBackendMessages(state, isStale);
			if (isStale()) {
				push?.(
					`chat:refreshFromBackend stale instance=${requestInstanceId} active=${rpcBridge.getInstanceId()} gen=${generation} activeGen=${this.refreshGeneration}`,
				);
				return;
			}
			this.isConnected = rpcBridge.isConnected;
			const previousSessionFile = this.lastBackendSessionFile;
			const currentSessionFile = state.sessionFile ?? null;
			this.state = state;
			this.syncComposerQueueFromState(state);
			this.recomputeProviderAuthConfigured();
			this.lastBackendSessionFile = currentSessionFile;
			if ((previousSessionFile ?? "") !== (currentSessionFile ?? "")) {
				// 会话已切换：跨会话的「编辑并重发」就地编辑状态不再有效。
				this.clearTimelineMessageEditing();
				this.sessionStats = {
					tokens: null,
					lifetimeTokens: null,
					costUsd: null,
					messageCount: state.messageCount ?? 0,
					pendingCount: state.pendingMessageCount ?? 0,
					contextWindow: this.resolveContextWindow() ?? null,
					usageRatio: null,
					updatedAt: 0,
				};
				if (this.historyViewerOpen && this.historyViewerMode === "browse") {
					this.historyTreeRows = [];
					this.historyViewerLoading = true;
					void this.loadSessionTreeForHistory();
				}
			}
			this.lastBackendRefreshError = null;
			this.onStateChange?.(state);
			this.messages = this.mapBackendMessages(backendMessages);
			// 从会话历史重建 todo 清单：`details` 会落盘进 session JSONL，
			// 所以切会话/重载后面板能恢复。按时间序回放，最后一条胜出。
			if (this.todoLiveGeneration === todoGenerationAtStart) {
				this.rebuildTodoStateFromBackend(backendMessages);
			}
			if (this.compactionInsertIndex !== null) {
				this.compactionInsertIndex = Math.max(0, Math.min(this.compactionInsertIndex, this.messages.length));
			}
			this.expandedToolWorkflowIds.clear();
			this.expandedToolGroupByWorkflowId.clear();
			this.expandedWorkflowThinkingIds.clear();
			this.collapsedAutoWorkflowIds.clear();
			this.forkEntryIdByMessageId.clear();
			this.lastAssistantContextTokens = this.deriveLatestAssistantContextTokens(backendMessages);
			if (state.isStreaming) {
				if (this.runStartedAt <= 0) {
					this.runStartedAt = Date.now();
				}
				let lastUserIndex = -1;
				for (let i = backendMessages.length - 1; i >= 0; i -= 1) {
					if ((backendMessages[i].role as string) === "user") {
						lastUserIndex = i;
						break;
					}
				}
				const streamWindow = lastUserIndex >= 0 ? backendMessages.slice(lastUserIndex + 1) : backendMessages;
				this.runHasAssistantText = streamWindow.some((entry) => {
					if ((entry.role as string) !== "assistant") return false;
					return this.extractText((entry as Record<string, unknown>).content).trim().length > 0;
				});
				const sawToolInStreamWindow = streamWindow.some((entry) => {
					const role = (entry.role as string) ?? "";
					if (role === "toolResult") return true;
					if (role !== "assistant") return false;
					const directToolCalls = (entry as { toolCalls?: unknown }).toolCalls;
					if (Array.isArray(directToolCalls) && directToolCalls.length > 0) return true;
					const content = (entry as Record<string, unknown>).content;
					if (!Array.isArray(content)) return false;
					return content.some((part) => {
						if (!part || typeof part !== "object") return false;
						const rec = part as Record<string, unknown>;
						const type = typeof rec.type === "string" ? rec.type.toLowerCase() : "";
						return type.includes("tool") || Boolean(rec.toolCall);
					});
				});
				this.runSawToolActivity = this.runSawToolActivity || sawToolInStreamWindow;
				if (this.runSawToolActivity) {
					this.keepWorkflowExpandedUntilAssistantText = !this.runHasAssistantText;
				}
			} else {
				this.runHasAssistantText = false;
				this.runSawToolActivity = false;
				this.runStartedAt = 0;
				this.keepWorkflowExpandedUntilAssistantText = false;
			}
			this.pendingDeliveryMode = state.isStreaming ? "steer" : "prompt";
			this.bindingStatusText = null;
			this.bindingForFreshSession = false;
			this.render();
			const sessionScrollGeneration = this.pendingSessionScrollGeneration;
			const scrollAction = resolveSessionRefreshScrollAction(
				sessionScrollGeneration,
				this.previewSettledSessionScrollGeneration,
				this.autoFollowChat,
			);
			if (scrollAction === "schedule-latest" && sessionScrollGeneration !== null) {
				this.pendingSessionScrollGeneration = null;
				this.previewSettledSessionScrollGeneration = null;
				this.scheduleSessionScrollToLatest(sessionScrollGeneration);
			} else if (scrollAction === "follow-stream") {
				this.scrollToBottom();
			}
			this.previewSettledSessionScrollGeneration = null;
			// runtime 就绪：把连接窗口里本地排队的消息自动发出去。
			void this.flushOfflineComposerQueue();
			void this.refreshSessionStats(true);
			void this.refreshGitSummary(true);
			void this.refreshAvailableThinkingLevels();
			if (!this.loadingModels && this.availableModels.length === 0) {
				void this.loadAvailableModels();
			}
			if (!this.loadingProviderAuth && this.providerAuthLoadedAt === 0) {
				void this.loadProviderAuthStatus();
			}
			if (!this.oauthProviderCatalogLoading && this.oauthProviderCatalogLoadedAt === 0) {
				void this.loadOAuthProviderCatalog();
			}
			if (!this.loadingModelCatalog && this.modelCatalog.length === 0) {
				void this.loadModelCatalog();
			}
			push?.(`chat:refreshFromBackend ok session=${state.sessionFile ?? "-"} messages=${backendMessages.length} tookMs=${Date.now() - startedAt}`);
		} catch (err) {
			// 过期刷新的失败不覆盖新会话状态（接管的新刷新会各自上报错误）。
			if (isStale()) return;
			console.error("Failed to refresh chat state:", err);
			this.lastBackendRefreshError = err instanceof Error ? err.message : String(err);
			push?.(`chat:refreshFromBackend failed ${this.lastBackendRefreshError}`);
			if (options.throwOnError) {
				throw err;
			}
		}
	}

	async refreshModels(): Promise<void> {
		await Promise.all([
			this.loadAvailableModels(),
			this.loadProviderAuthStatus(true),
			this.loadOAuthProviderCatalog(true),
			this.loadModelCatalog(true),
		]);
	}

	/**
	 * 加载会话历史的最新一页（默认尾部 40 条 entry），并适配成
	 * backend-message-mapper 期望的消息形状。会话文件不可用时退化为
	 * RPC get_messages 全量历史（例如会话未持久化到磁盘）。
	 */
	private async loadLatestBackendMessages(
		state: RpcSessionState,
		isStale?: () => boolean,
	): Promise<Array<Record<string, unknown>>> {
		const sessionFile = state.sessionFile ?? null;
		// SESSION-02：权威链路重锚分页状态，作废仍在途的旧分页请求（其 loading 态一并接管）。
		// 重锚与本刷新代次检查点之间无 await，过期刷新不会覆盖更新刷新的锚点。
		this.historyPagingGeneration += 1;
		this.historyLoadingMore = false;
		this.historySessionFile = sessionFile;
		this.historyHasMore = false;
		this.historyOldestEntryId = null;
		if (!sessionFile) {
			this.pendingTodoSnapshot = null;
			return rpcBridge.getMessages();
		}
		try {
			const page = await rpcBridge.getSessionPage(sessionFile, null, HISTORY_PAGE_SIZE);
			// 刷新已过期（切会话或有更新刷新接管）：不写分页锚点，结果由调用方整体丢弃。
			if (isStale?.()) return [];
			this.historyHasMore = page.hasMore;
			this.historyOldestEntryId = page.oldestEntryId;
			// 尾页里可能没有 todo 调用（长会话会把它挤出去），所以用 Rust 侧
			// 全文件扇描得到的快照。这是清单能从长会话恢复的唯一保证。
			this.pendingTodoSnapshot = page.latestTodoDetails ?? null;
			return this.adaptSessionPageEntries(page.entries);
		} catch (err) {
			console.warn("get_session_page failed, falling back to get_messages:", err);
			this.pendingTodoSnapshot = null;
			return rpcBridge.getMessages();
		}
	}

	private adaptSessionPageEntries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
		const mapped: Array<Record<string, unknown>> = [];
		for (const entry of entries) {
			const adapted = this.adaptSessionPageEntry(entry);
			if (adapted) mapped.push(adapted);
		}
		return mapped;
	}

	/** 把 JSONL entry 转成 get_messages 返回的消息形状（与 pi buildSessionContext 对齐）。 */
	private adaptSessionPageEntry(entry: Record<string, unknown>): Record<string, unknown> | null {
		const type = typeof entry.type === "string" ? entry.type : "";
		const id = typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id : undefined;
		switch (type) {
			case "message": {
				const message = entry.message;
				if (!message || typeof message !== "object") return null;
				return { ...(message as Record<string, unknown>), id };
			}
			case "custom_message":
				return { role: "custom", customType: entry.customType, content: entry.content, id };
			case "branch_summary":
				return { role: "branchSummary", summary: entry.summary, id };
			case "compaction":
				return { role: "compactionSummary", summary: entry.summary, id };
			default:
				return null;
		}
	}

	/** 向上翻一页历史，prepend 到时间线头部并保持滚动位置不跳。 */
	private async loadOlderHistory(): Promise<void> {
		if (this.historyLoadingMore || !this.historyHasMore) return;
		const sessionFile = this.historySessionFile;
		const beforeEntryId = this.historyOldestEntryId;
		if (!sessionFile || !beforeEntryId) return;
		// SESSION-02：请求绑定 sessionPath + 分页代次；await 期间切会话/权威刷新
		// 会推进代次或改锚 historySessionFile，返回结果在提交 DOM 前直接丢弃。
		const generation = this.historyPagingGeneration;
		const isStale = (): boolean => generation !== this.historyPagingGeneration || this.historySessionFile !== sessionFile;

		this.historyLoadingMore = true;
		this.render();
		const container = this.scrollContainer;
		const prevScrollHeight = container?.scrollHeight ?? 0;
		const prevScrollTop = container?.scrollTop ?? 0;
		try {
			const page = await rpcBridge.getSessionPage(sessionFile, beforeEntryId, HISTORY_PAGE_SIZE);
			// 当前活动会话已不再是发起时的会话：整页丢弃，不 prepend 到新会话视图。
			if (isStale()) return;
			const older = this.mapBackendMessages(this.adaptSessionPageEntries(page.entries));
			this.messages = [...older, ...this.messages];
			this.historyHasMore = page.hasMore;
			this.historyOldestEntryId = page.oldestEntryId;
			if (this.compactionInsertIndex !== null) {
				this.compactionInsertIndex += older.length;
			}
			this.render();
			// 滚动锚点：prepend 后视口停留在原来的消息上。
			if (container) {
				requestAnimationFrame(() => {
					const el = this.scrollContainer;
					if (!el || el !== container) return;
					el.scrollTop = el.scrollHeight - prevScrollHeight + prevScrollTop;
				});
			}
		} catch (err) {
			if (isStale()) return;
			console.error("Failed to load older history:", err);
			this.pushNotice(t("timeline.history.loadEarlierFailed"), "error");
		} finally {
			// 过期请求的 loading 态由新会话/权威链路各自重置，这里不覆盖。
			if (!isStale()) {
				this.historyLoadingMore = false;
				this.render();
			}
		}
	}

	private renderHistoryLoadEarlierRow(): TemplateResult | typeof nothing {
		if (!this.historyHasMore && !this.historyLoadingMore) return nothing;
		return html`
			<div class="chat-row system-row history-load-earlier-row">
				<button
					class="ghost-btn history-load-earlier-btn"
					?disabled=${this.historyLoadingMore}
					@click=${() => void this.loadOlderHistory()}
				>
					${this.historyLoadingMore ? t("timeline.history.loadingEarlier") : t("timeline.history.loadEarlier")}
				</button>
			</div>
		`;
	}

	private mapBackendMessages(backendMessages: Array<Record<string, unknown>>): UiMessage[] {
		return mapBackendMessagesView({
			backendMessages,
			allThinkingExpanded: this.allThinkingExpanded,
			createId: uid,
			extractText: this.extractText.bind(this),
			extractImages: this.extractImages.bind(this),
			extractToolOutput: this.extractToolOutput.bind(this),
		}) as UiMessage[];
	}

	private extractText(content: unknown): string {
		return extractTextContent(content);
	}

	private extractToolOutput(payload: unknown, depth = 0): string {
		return extractToolOutputText(payload, depth);
	}

	private mergeStreamingText(current: string, partial: string | null, deltaCandidate: unknown): string {
		return mergeStreamingTextValue(current, partial, deltaCandidate);
	}

	private extractImages(content: unknown): PendingImage[] {
		return extractImagesFromContent(content, uid) as PendingImage[];
	}

	private extractAssistantPartialContent(assistantEvent: Record<string, unknown>, mode: "text" | "thinking"): string | null {
		return extractAssistantPartialContentValue(assistantEvent, mode);
	}

	private async loadAvailableModels(): Promise<void> {
		const push = (window as typeof window & {
			__PI_DESKTOP_PUSH_TRACE__?: (message: string) => void;
		}).__PI_DESKTOP_PUSH_TRACE__;
		const requestInstanceId = rpcBridge.getInstanceId();
		if (!rpcBridge.isConnected) {
			this.loadingModels = false;
			this.render();
			return;
		}

		const requestSeq = ++this.modelLoadRequestSeq;
		push?.(`chat:loadModels start instance=${rpcBridge.getInstanceId()} seq=${requestSeq}`);
		this.loadingModels = true;
		this.render();
		try {
			const models = await Promise.race([
				rpcBridge.getAvailableModels(),
				new Promise<Array<Record<string, unknown>>>((_, reject) => {
					setTimeout(() => reject(new Error(t("chatView.notice.modelsLoadTimeout"))), 8000);
				}),
			]);
			if (requestSeq !== this.modelLoadRequestSeq) return;
			if (requestInstanceId !== rpcBridge.getInstanceId()) {
				push?.(`chat:loadModels stale instance=${requestInstanceId} active=${rpcBridge.getInstanceId()}`);
				return;
			}
			const mapped = mapAvailableModelsFromRpc(models);
			this.availableModels = mapped;
			this.recomputeProviderAuthConfigured();
			this.lastModelLoadError = null;
			push?.(`chat:loadModels ok count=${mapped.length}`);
		} catch (err) {
			console.error("Failed to load available models:", err);
			this.lastModelLoadError = err instanceof Error ? err.message : String(err);
			push?.(`chat:loadModels failed ${this.lastModelLoadError}`);
			if (this.availableModels.length === 0) {
				this.pushNotice(t("chatView.notice.modelsLoadFailed", { reason: truncate(this.lastModelLoadError, 120) }), "info");
			}
		} finally {
			if (requestSeq !== this.modelLoadRequestSeq) return;
			this.loadingModels = false;
			this.render();
		}
	}

	private async setModel(provider: string, modelId: string): Promise<boolean> {
		if (this.settingModel) return false;
		this.modelPickerOpen = false;
		this.settingModel = true;
		this.render();
		try {
			await rpcBridge.setModel(provider, modelId);
			this.state = await rpcBridge.getState();
			this.syncComposerQueueFromState(this.state);
			this.recomputeProviderAuthConfigured();
			if (this.state) this.onStateChange?.(this.state);
			// 可用思考档位是按模型算的（pi-ai getSupportedThinkingLevels），换了模型必须重拉。
			void this.refreshAvailableThinkingLevels(true);
			void this.refreshSessionStats(true);
			this.pushNotice(t("chatView.notice.modelSwitched", { model: `${provider}/${modelId}` }), "success");
			return true;
		} catch (err) {
			console.error("Failed to set model:", err);
			this.pushNotice(t("chatView.notice.modelSwitchFailed"), "error");
			return false;
		} finally {
			this.settingModel = false;
			this.render();
		}
	}

	private thinkingLevelModelKey(state: RpcSessionState | null | undefined = this.state): string {
		const { provider, modelId } = this.currentModelSelection(state);
		if (!provider || !modelId) return "";
		return `${provider}::${modelId}`;
	}

	private markThinkingLevelUnsupported(level: ThinkingLevel, state: RpcSessionState | null | undefined = this.state): void {
		const key = this.thinkingLevelModelKey(state);
		if (!key) return;
		const existing = this.unsupportedThinkingLevelsByModel.get(key) ?? new Set<ThinkingLevel>();
		existing.add(level);
		this.unsupportedThinkingLevelsByModel.set(key, existing);
	}

	private clearThinkingLevelUnsupported(level: ThinkingLevel, state: RpcSessionState | null | undefined = this.state): void {
		const key = this.thinkingLevelModelKey(state);
		if (!key) return;
		const existing = this.unsupportedThinkingLevelsByModel.get(key);
		if (!existing) return;
		existing.delete(level);
		if (existing.size === 0) {
			this.unsupportedThinkingLevelsByModel.delete(key);
		}
	}

	private unsupportedThinkingLevelsForCurrentModel(): Set<ThinkingLevel> {
		const key = this.thinkingLevelModelKey(this.state);
		if (!key) return new Set<ThinkingLevel>();
		return this.unsupportedThinkingLevelsByModel.get(key) ?? new Set<ThinkingLevel>();
	}

	/**
	 * 当前模型可用的思考档位。**三态**，不能崩成两态：
	 * - `null` = 尚未拿到权威列表（未拉取/拉取中/拉取失败）——此时**不猜**模型能力；
	 * - `[]` = pi 明确告知一档也不可用（自定义模型确实可能得到空集）；
	 * - 非空数组 = 权威列表，再减去本地已知被夹取过的档（缓存可能陈旧）。
	 *
	 * 把未知当成「全 7 档可用」是错的：`reasoning: false` 的模型只有 `off`，
	 * 基础档也可被 `thinkingLevelMap[level] = null` 禁用，那会给出整片假选项。
	 */
	private availableThinkingLevelsForCurrentModel(): ThinkingLevel[] | null {
		const key = this.thinkingLevelModelKey(this.state);
		if (!key) return null;
		const cached = this.availableThinkingLevelsByModel.get(key);
		if (!cached) return null;
		return subtractBlockedThinkingLevels(cached, this.unsupportedThinkingLevelsByModel.get(key));
	}

	/**
	 * 拉当前模型的可用档位。模型变了就得重拉——pi 侧这个列表是
	 * `getSupportedThinkingLevels(model)` 算的，换模型后结果不同。
	 *
	 * 失败不报错：这只是下拉选项的优化，拿不到就保持未知态，不能打扰用户。
	 * 旧版 pi（无此命令）会返回 Unknown command，走同一条 catch。
	 */
	private async refreshAvailableThinkingLevels(force = false): Promise<void> {
		const key = this.thinkingLevelModelKey(this.state);
		if (!key) return;
		// 已有缓存且非强制：不重拉。缓存存在性才是「已完成」的标志，
		// 不能拿在途标记兼任这个职责——否则一次被丢弃的拉取会永久堵住重试。
		if (!force && this.availableThinkingLevelsByModel.has(key)) return;
		// 同一模型的拉取已在途：不叠发。
		if (this.thinkingLevelsFetchKey === key) return;
		this.thinkingLevelsFetchKey = key;
		try {
			const levels = await rpcBridge.getAvailableThinkingLevels();
			// 拉取期间可能已经换了模型或会话，写回前确认 key 没变
			if (this.thinkingLevelModelKey(this.state) !== key) return;
			const previous = this.availableThinkingLevelsByModel.get(key);
			const changed = !previous || previous.join(",") !== levels.join(",");
			// 空列表也是权威结果（pi 明确说一档不可用），照存。
			this.availableThinkingLevelsByModel.set(key, levels);
			// 权威结果到手，反应式推断就该让位（否则陈旧的 blocked 会持续减项）。
			if (levels.length > 0) this.unsupportedThinkingLevelsByModel.delete(key);
			if (changed) this.render();
		} catch (err) {
			console.warn("Failed to fetch available thinking levels:", err);
		} finally {
			// 无论成败都释放在途标记，下次触发点还能重试。
			if (this.thinkingLevelsFetchKey === key) this.thinkingLevelsFetchKey = null;
		}
	}

	private async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel | null> {
		if (this.settingThinking) return this.state?.thinkingLevel ?? null;
		const requestedLevel = level;
		if (this.state) {
			this.state = { ...this.state, thinkingLevel: requestedLevel };
		}
		this.settingThinking = true;
		this.render();
		// 在 await 之前快照模型 key：rpcBridge 是多会话包装，set 与随后的 getState
		// 是两次独立转发。快速切会话/切模型时，第二次可能已经落到另一个
		// bridge 上，拿 B 的状态去判定 A 的请求是否被夹取，会污染缓存并误弹提示。
		const requestModelKey = this.thinkingLevelModelKey(this.state);
		try {
			await rpcBridge.setThinkingLevel(requestedLevel);
			const nextState = await rpcBridge.getState();
			// 模型/会话已变：这次结果不属于当前上下文，丢弃（不写状态、不记缓存、不提示）。
			if (this.thinkingLevelModelKey(nextState) !== requestModelKey) {
				return nextState?.thinkingLevel ?? null;
			}
			this.state = nextState;
			this.syncComposerQueueFromState(this.state);
			if (this.state) this.onStateChange?.(this.state);
			if (this.state?.thinkingLevel === requestedLevel) {
				this.clearThinkingLevelUnsupported(requestedLevel, this.state);
			} else {
				this.markThinkingLevelUnsupported(requestedLevel, this.state);
			}
			// 夹取提示对所有档位生效，不只 xhigh：pi 会静默夹取任何不支持的档，
			// 不告知的话用户以为选上了。
			const applied = this.state?.thinkingLevel;
			if (applied && applied !== requestedLevel) {
				this.pushNotice(
					t("chatView.notice.thinkingLevelClamped", {
						requested: formatThinkingDisplayName(requestedLevel),
						level: formatThinkingDisplayName(applied),
					}),
					"info",
				);
				// 夹取意味着本地的可用列表过时了，重拉一次
				void this.refreshAvailableThinkingLevels(true);
			}
			void this.refreshSessionStats(true);
			return this.state?.thinkingLevel ?? null;
		} catch (err) {
			console.error("Failed to set thinking level:", err);
			this.pushNotice(t("chatView.notice.thinkingSetFailed"), "error");
			return this.state?.thinkingLevel ?? null;
		} finally {
			this.settingThinking = false;
			this.render();
		}
	}

	private async cycleThinkingLevel(direction: 1 | -1 = 1): Promise<void> {
		if (this.settingThinking) return;
		const order = THINKING_LEVEL_CYCLE_ORDER;
		// 权威列表优先：它直接告诉我们哪些档不存在，不必靠夹取失败去发现。
		// null = 尚未拿到，此时不设限，仍靠 blocked 反应式跳过。
		const authoritative = this.availableThinkingLevelsForCurrentModel();
		const allowed = authoritative === null ? null : new Set(authoritative);
		let cursor = Math.max(0, order.indexOf((this.state?.thinkingLevel ?? "off") as ThinkingLevel));

		for (let attempt = 0; attempt < order.length; attempt += 1) {
			const blocked = this.unsupportedThinkingLevelsForCurrentModel();
			let candidate: ThinkingLevel | null = null;
			for (let step = 1; step <= order.length; step += 1) {
				const nextIndex = (cursor + step * direction + order.length * 2) % order.length;
				const nextLevel = order[nextIndex] ?? "off";
				if (blocked.has(nextLevel)) continue;
				// allowed 为 null 说明拿不到权威列表，此时不设限。
				if (allowed && allowed.size > 0 && !allowed.has(nextLevel)) continue;
				candidate = nextLevel;
				cursor = nextIndex;
				break;
			}
			if (!candidate) return;
			const applied = await this.setThinkingLevel(candidate);
			if (applied === candidate) return;
			const appliedIndex = order.indexOf((applied ?? candidate) as ThinkingLevel);
			if (appliedIndex >= 0) {
				cursor = appliedIndex;
			}
		}
	}

	private resolveContextWindow(raw?: Record<string, unknown>): number | null {
		const stateWindow =
			typeof this.state?.model?.contextWindow === "number" && Number.isFinite(this.state.model.contextWindow)
				? this.state.model.contextWindow
				: null;
		if (stateWindow && stateWindow > 0) return stateWindow;

		const { provider, modelId } = this.currentModelSelection();
		if (provider && modelId) {
			const fromCatalog = this.availableModels.find((m) => m.provider === provider && m.id === modelId)?.contextWindow;
			if (typeof fromCatalog === "number" && Number.isFinite(fromCatalog) && fromCatalog > 0) {
				return fromCatalog;
			}
		}

		if (raw) {
			const fromRaw = pickNumber(raw, [
				"contextWindow",
				"context_window",
				"contextUsage.contextWindow",
				"contextUsage.context_window",
				"usage.contextWindow",
				"usage.context_window",
			]);
			if (fromRaw && fromRaw > 0) return fromRaw;
		}

		return null;
	}

	private normalizeUsageRatio(rawRatio: number | null): number | null {
		if (rawRatio === null || !Number.isFinite(rawRatio)) return null;
		if (rawRatio > 1) return Math.min(1, Math.max(0, rawRatio / 100));
		return Math.min(1, Math.max(0, rawRatio));
	}

	private deriveLatestAssistantContextTokens(messages: Array<Record<string, unknown>>): number | null {
		return deriveLatestAssistantContextTokensFromMessages(messages);
	}

	private markContextUsageUnknown(): void {
		this.lastAssistantContextTokens = null;
		this.sessionStats = {
			...this.sessionStats,
			tokens: null,
			usageRatio: null,
			updatedAt: Date.now(),
		};
	}

	private refreshAfterCompaction(): void {
		void (async () => {
			try {
				await this.refreshFromBackend();
			} catch {
				// ignore and still attempt stats refresh
			}
			await this.refreshSessionStats(true);
		})();
	}

	private async refreshSessionStats(force = false): Promise<void> {
		if (this.refreshingSessionStats) return;
		if (!force && Date.now() - this.sessionStats.updatedAt < 1800) return;
		this.refreshingSessionStats = true;
		const stateMessageCount = this.state?.messageCount ?? 0;
		const statePendingCount = this.state?.pendingMessageCount ?? 0;
		try {
			const raw = (await rpcBridge.getSessionStats()) as Record<string, unknown>;
			this.sessionStats = computeSessionStatsFromRaw({
				raw,
				stateMessageCount,
				statePendingCount,
				lastAssistantContextTokens: this.lastAssistantContextTokens,
				resolveContextWindow: (inputRaw) => this.resolveContextWindow(inputRaw),
				normalizeUsageRatio: (value) => this.normalizeUsageRatio(value),
			});
		} catch {
			this.sessionStats = computeSessionStatsFallback({
				stateMessageCount,
				statePendingCount,
				previous: this.sessionStats,
				resolveContextWindow: (inputRaw) => this.resolveContextWindow(inputRaw),
			});
		} finally {
			this.refreshingSessionStats = false;
			this.render();
		}
	}

	private sessionStatsLines(): string[] {
		const parts: string[] = [];
		if (this.sessionStats.tokens !== null) {
			parts.push(t("chatView.stats.contextTokens", { value: Math.round(this.sessionStats.tokens).toLocaleString() }));
		}
		if (this.sessionStats.contextWindow) {
			parts.push(t("chatView.stats.contextWindow", { value: Math.round(this.sessionStats.contextWindow).toLocaleString() }));
		}
		if (this.sessionStats.usageRatio !== null) {
			parts.push(t("chatView.stats.usage", { value: (this.sessionStats.usageRatio * 100).toFixed(1) }));
		}
		if (this.sessionStats.lifetimeTokens !== null) {
			parts.push(t("chatView.stats.totalTokens", { value: Math.round(this.sessionStats.lifetimeTokens).toLocaleString() }));
		}
		if (this.sessionStats.costUsd !== null) {
			parts.push(t("chatView.stats.cost", { value: formatUsd(this.sessionStats.costUsd) }));
		}
		parts.push(t("chatView.stats.messages", { value: this.sessionStats.messageCount }));
		parts.push(t("chatView.stats.pending", { value: this.sessionStats.pendingCount }));
		return parts;
	}

	private sessionStatsTooltip(): string {
		const lines = this.sessionStatsLines();
		if (lines.length === 0) return t("chatView.session.stats");
		return lines.join("\n");
	}

	private parseBashResult(raw: unknown): { stdout: string; stderr: string; exitCode: number } {
		const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const output = typeof source.output === "string" ? source.output : "";
		const stdout = typeof source.stdout === "string" ? source.stdout : output;
		const stderr = typeof source.stderr === "string" ? source.stderr : "";
		const exit = source.exitCode ?? source.exit_code;
		if (typeof exit === "number" && Number.isFinite(exit)) {
			return { stdout, stderr, exitCode: exit };
		}
		if (typeof exit === "string") {
			const parsed = Number(exit);
			if (Number.isFinite(parsed)) return { stdout, stderr, exitCode: parsed };
		}
		return { stdout, stderr, exitCode: 0 };
	}

	private extractLatestChangelogSections(markdown: string, maxSections = 2): string {
		const lines = markdown.split(/\r?\n/);
		const firstSectionIndex = lines.findIndex((line) => line.startsWith("## "));
		if (firstSectionIndex < 0) return markdown;

		const header = lines.slice(0, firstSectionIndex).join("\n").trim();
		const sections: string[] = [];
		let index = firstSectionIndex;
		while (index < lines.length && sections.length < maxSections) {
			if (!lines[index].startsWith("## ")) {
				index += 1;
				continue;
			}
			let end = index + 1;
			while (end < lines.length && !lines[end].startsWith("## ")) {
				end += 1;
			}
			sections.push(lines.slice(index, end).join("\n").trimEnd());
			index = end;
		}

		const body = sections.join("\n\n").trim();
		return `${header ? `${header}\n\n` : ""}${body}`.trim();
	}

	private async loadPiAgentChangelogMarkdown(force = false): Promise<string> {
		if (this.loadingChangelog) {
			return this.changelogCacheMarkdown ?? "";
		}
		if (!force && this.changelogCacheMarkdown && Date.now() - this.changelogCacheAt < 45_000) {
			return this.changelogCacheMarkdown;
		}
		this.loadingChangelog = true;
		try {
			const result = await rpcBridge.getPiChangelog();
			const markdown = (result.content || "").trim();
			if (!markdown) {
				throw new Error(t("chatView.changelog.empty"));
			}
			this.changelogCacheMarkdown = markdown;
			this.changelogCacheAt = Date.now();
			return markdown;
		} finally {
			this.loadingChangelog = false;
		}
	}

	private parseNumstat(output: string): { additions: number; deletions: number } {
		let additions = 0;
		let deletions = 0;
		for (const line of output.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const [rawAdd, rawDel] = line.split(/\t+/);
			const add = Number(rawAdd);
			const del = Number(rawDel);
			if (Number.isFinite(add)) additions += add;
			if (Number.isFinite(del)) deletions += del;
		}
		return { additions, deletions };
	}

	private async runGit(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		if (!this.projectPath) {
			return { stdout: "", stderr: t("chatView.git.noActiveProject"), exitCode: -1 };
		}
		try {
			const raw = await rpcBridge.runGitCommand(args, { cwd: this.projectPath });
			return this.parseBashResult(raw);
		} catch (err) {
			return {
				stdout: "",
				stderr: err instanceof Error ? err.message : String(err),
				exitCode: -1,
			};
		}
	}

	private knownBranchesForCurrentProject(): string[] {
		if (!this.projectPath) return [];
		return this.gitKnownBranchesByProject.get(this.projectPath) ?? [];
	}

	private rememberGitBranches(branches: string[]): void {
		if (!this.projectPath) return;
		const clean = branches.map((branch) => branch.trim()).filter(Boolean);
		if (clean.length === 0) return;
		const current = this.gitKnownBranchesByProject.get(this.projectPath) ?? [];
		this.gitKnownBranchesByProject.set(this.projectPath, [...new Set([...current, ...clean])]);
	}

	private clearKnownBranchesForCurrentProject(): void {
		if (!this.projectPath) return;
		this.gitKnownBranchesByProject.delete(this.projectPath);
	}

	private async hasGitHeadCommit(): Promise<boolean> {
		const probe = await this.runGit(["rev-parse", "--verify", "HEAD"]);
		return probe.exitCode === 0;
	}

	private async switchUnbornHeadBranch(branch: string): Promise<{ ok: boolean; error: string }> {
		const bySymbolic = await this.runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
		if (bySymbolic.exitCode === 0) {
			return { ok: true, error: "" };
		}
		const orphan = await this.runGit(["checkout", "--orphan", branch]);
		if (orphan.exitCode === 0) {
			return { ok: true, error: "" };
		}
		return {
			ok: false,
			error: orphan.stderr.trim() || bySymbolic.stderr.trim() || orphan.stdout.trim() || bySymbolic.stdout.trim(),
		};
	}

	private async refreshGitSummary(force = false): Promise<void> {
		if (this.refreshingGitSummary) return;
		if (!force && Date.now() - this.gitSummary.updatedAt < 2200) return;
		this.refreshingGitSummary = true;
		this.render();
		try {
			if (!this.projectPath) {
				this.gitSummary = {
					isRepo: false,
					branch: null,
					branches: [],
					branchEntries: [],
					hasRemoteBranches: false,
					dirtyFiles: 0,
					additions: 0,
					deletions: 0,
					updatedAt: Date.now(),
				};
				this.gitMenuOpen = false;
				this.gitBranchQuery = "";
				return;
			}

			const probe = await this.runGit(["rev-parse", "--is-inside-work-tree"]);
			const inRepo = probe.exitCode === 0 && probe.stdout.trim() === "true";
			if (!inRepo) {
				this.clearKnownBranchesForCurrentProject();
				this.gitSummary = {
					isRepo: false,
					branch: null,
					branches: [],
					branchEntries: [],
					hasRemoteBranches: false,
					dirtyFiles: 0,
					additions: 0,
					deletions: 0,
					updatedAt: Date.now(),
				};
				this.gitMenuOpen = false;
				this.gitBranchQuery = "";
				return;
			}

			const [branchPrimary, refsResult, statusResult, diffResult, stagedResult, hasCommit] = await Promise.all([
				this.runGit(["symbolic-ref", "--short", "HEAD"]),
				this.runGit(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]),
				this.runGit(["status", "--porcelain"]),
				this.runGit(["diff", "--numstat"]),
				this.runGit(["diff", "--cached", "--numstat"]),
				this.hasGitHeadCommit(),
			]);

			let branch = branchPrimary.stdout.trim() || null;
			if (!branch || branchPrimary.exitCode !== 0) {
				const fallback = await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
				const fallbackBranch = fallback.stdout.trim();
				branch = fallbackBranch && fallbackBranch !== "HEAD" ? fallbackBranch : null;
			} else if (branch === "HEAD") {
				branch = null;
			}

			const refs = refsResult.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			const branchIndex = buildGitBranchIndex(refs, {
				currentBranch: branch,
				knownLocalBranches: hasCommit ? [] : this.knownBranchesForCurrentProject(),
			});
			const branches = branchIndex.localNames;

			this.rememberGitBranches(branches);
			if (branch) this.rememberGitBranches([branch]);

			const dirtyFiles = statusResult.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean).length;

			const unstaged = this.parseNumstat(diffResult.stdout);
			const staged = this.parseNumstat(stagedResult.stdout);

			this.gitSummary = {
				isRepo: true,
				branch,
				branches,
				branchEntries: branchIndex.entries,
				hasRemoteBranches: branchIndex.hasRemoteEntries,
				dirtyFiles,
				additions: unstaged.additions + staged.additions,
				deletions: unstaged.deletions + staged.deletions,
				updatedAt: Date.now(),
			};
		} catch {
			this.gitSummary = {
				isRepo: false,
				branch: null,
				branches: [],
				branchEntries: [],
				hasRemoteBranches: false,
				dirtyFiles: 0,
				additions: 0,
				deletions: 0,
				updatedAt: Date.now(),
			};
			this.gitMenuOpen = false;
			this.gitBranchQuery = "";
		} finally {
			this.refreshingGitSummary = false;
			this.render();
		}
	}

	private resolveGitBranchSelection(query: string): GitBranchEntry | null {
		return findGitBranchEntryByQuery(query, this.gitSummary.branchEntries);
	}

	private async switchGitBranchEntry(entry: GitBranchEntry): Promise<void> {
		if (entry.scope === "remote") {
			await this.switchRemoteTrackingBranch(entry);
			return;
		}
		await this.switchGitBranch(entry.name);
	}

	private async switchRemoteTrackingBranch(entry: GitBranchEntry): Promise<void> {
		await switchRemoteTrackingBranchAction({
			entry,
			branches: this.gitSummary.branches,
			switchGitBranch: this.switchGitBranch.bind(this),
			isSwitchingGitBranch: () => this.switchingGitBranch,
			setSwitchingGitBranch: (next) => {
				this.switchingGitBranch = next;
			},
			render: this.render.bind(this),
			closeGitMenu: () => {
				this.gitMenuOpen = false;
				this.gitBranchQuery = "";
			},
			pushNotice: this.pushNotice.bind(this),
			runGit: this.runGit.bind(this),
			hasGitHeadCommit: this.hasGitHeadCommit.bind(this),
			switchUnbornHeadBranch: this.switchUnbornHeadBranch.bind(this),
			refreshGitSummary: this.refreshGitSummary.bind(this),
		});
	}

	private async fetchGitRemotes(): Promise<void> {
		await fetchGitRemotesAction({
			isRepo: this.gitSummary.isRepo,
			fetchingGitRemotes: this.fetchingGitRemotes,
			isSwitchingGitBranch: () => this.switchingGitBranch,
			setFetchingGitRemotes: (next) => {
				this.fetchingGitRemotes = next;
			},
			render: this.render.bind(this),
			pushNotice: this.pushNotice.bind(this),
			runGit: this.runGit.bind(this),
			refreshGitSummary: this.refreshGitSummary.bind(this),
		});
	}

	private async switchGitBranch(branch: string): Promise<void> {
		await switchGitBranchAction({
			branch,
			currentBranch: this.gitSummary.branch || "",
			isSwitchingGitBranch: () => this.switchingGitBranch,
			setSwitchingGitBranch: (next) => {
				this.switchingGitBranch = next;
			},
			render: this.render.bind(this),
			closeGitMenu: () => {
				this.gitMenuOpen = false;
				this.gitBranchQuery = "";
			},
			pushNotice: this.pushNotice.bind(this),
			runGit: this.runGit.bind(this),
			hasGitHeadCommit: this.hasGitHeadCommit.bind(this),
			switchUnbornHeadBranch: this.switchUnbornHeadBranch.bind(this),
			refreshGitSummary: this.refreshGitSummary.bind(this),
		});
	}

	private async createAndCheckoutBranch(rawName = ""): Promise<void> {
		await createAndCheckoutBranchAction({
			rawName,
			gitBranchQuery: this.gitBranchQuery,
			resolveGitBranchSelection: this.resolveGitBranchSelection.bind(this),
			switchGitBranchEntry: this.switchGitBranchEntry.bind(this),
			isSwitchingGitBranch: () => this.switchingGitBranch,
			setSwitchingGitBranch: (next) => {
				this.switchingGitBranch = next;
			},
			render: this.render.bind(this),
			closeGitMenu: () => {
				this.gitMenuOpen = false;
				this.gitBranchQuery = "";
			},
			pushNotice: this.pushNotice.bind(this),
			runGit: this.runGit.bind(this),
			hasGitHeadCommit: this.hasGitHeadCommit.bind(this),
			switchUnbornHeadBranch: this.switchUnbornHeadBranch.bind(this),
			refreshGitSummary: this.refreshGitSummary.bind(this),
		});
	}

	private renderGitRepoControl(): TemplateResult {
		return renderGitRepoControlView({
			summary: this.gitSummary,
			creatingGitRepo: this.creatingGitRepo,
			refreshingGitSummary: this.refreshingGitSummary,
			switchingGitBranch: this.switchingGitBranch,
			fetchingGitRemotes: this.fetchingGitRemotes,
			gitMenuOpen: this.gitMenuOpen,
			gitBranchQuery: this.gitBranchQuery,
			resolveGitBranchSelection: this.resolveGitBranchSelection.bind(this),
			gitIcon: () => uiIcon("git"),
			onCreateRepo: this.createGitRepository.bind(this),
			onToggleMenu: () => {
				this.gitMenuOpen = !this.gitMenuOpen;
				if (!this.gitMenuOpen) this.gitBranchQuery = "";
				this.render();
			},
			onSetBranchQuery: (value) => {
				this.gitBranchQuery = value;
				this.render();
			},
			onCreateAndCheckoutBranch: this.createAndCheckoutBranch.bind(this),
			onFetchRemotes: this.fetchGitRemotes.bind(this),
			onSwitchGitBranchEntry: this.switchGitBranchEntry.bind(this),
		});
	}

	private renderReviewToggle(): TemplateResult | typeof nothing {
		if (!this.gitSummary.isRepo) return nothing;
		const count = this.gitSummary.dirtyFiles;
		return html`
			<button
				class="review-toggle-btn ${this.reviewPanel.isOpen ? "open" : ""}"
				title=${t("review.title")}
				@click=${(event: Event) => {
					event.stopPropagation();
					this.reviewPanel.toggle();
				}}
			>
				${uiIcon("diff")}
				<span>${t("review.toggle")}</span>
				${count > 0 ? html`<span class="review-toggle-badge">${count.toLocaleString()}</span>` : nothing}
			</button>
		`;
	}

	private extractRuntimeErrorMessage(event: Record<string, unknown> | null | undefined): string {
		if (!event || typeof event !== "object") return "";
		const direct = pickString(event, [
			"errorMessage",
			"error.message",
			"error",
			"message",
			"reason",
			"details.message",
			"details.error",
			"finalError",
			"providerError.message",
			"providerError.error",
		]);
		if (direct) return direct;
		const nestedError = event.error;
		if (nestedError && typeof nestedError === "object") {
			return pickString(nestedError as Record<string, unknown>, ["message", "error", "detail", "reason"]) ?? "";
		}
		return "";
	}

	private extractAssistantMessageError(message: Record<string, unknown> | null | undefined): string {
		if (!message || typeof message !== "object") return "";
		const stopReason = pickString(message, ["stopReason", "stop_reason", "reason"])
			?.trim()
			.toLowerCase() ?? "";
		const errorMessage = this.extractRuntimeErrorMessage(message).trim();
		if (stopReason === "aborted") {
			if (errorMessage && errorMessage.toLowerCase() !== "request was aborted") {
				return errorMessage;
			}
			return t("chatView.error.operationAborted");
		}
		if (stopReason === "error") {
			return errorMessage || t("chatView.error.unknown");
		}
		return "";
	}

	private toRuntimeInlineLine(text: string): string {
		const raw = text.trim();
		if (!raw) return "";
		if (/^error\b[:\s-]*/i.test(raw)) return raw;
		const stripped = raw
			.replace(/^runtime error(?:\s*\([^)]*\))?[:\s-]*/i, "")
			.replace(/^extension error(?:\s*\([^)]*\))?[:\s-]*/i, "")
			.replace(/^run failed[:\s-]*/i, "")
			.replace(/^streaming error[:\s-]*/i, "")
			.trim();
		if (/^error\b[:\s-]*/i.test(stripped)) return stripped;
		return t("chatView.error.prefix", { text: stripped || raw });
	}

	private appendSystemMessage(
		text: string,
		options: { label?: string; idPrefix?: string; markdown?: boolean; collapsibleTitle?: string; collapsedByDefault?: boolean } = {},
	): void {
		const line = text.trim();
		if (!line) return;
		const isCollapsible = Boolean(options.collapsibleTitle && options.collapsibleTitle.trim().length > 0);
		this.messages.push({
			id: uid(options.idPrefix ?? "system"),
			role: "system",
			text: line,
			label: options.label,
			renderAsMarkdown: options.markdown,
			collapsibleTitle: isCollapsible ? options.collapsibleTitle : undefined,
			collapsibleExpanded: isCollapsible ? !(options.collapsedByDefault ?? true) : undefined,
			toolCalls: [],
		});
		this.render();
		this.scrollToBottom();
	}

	private pushRuntimeNotice(text: string, kind: Notice["kind"] = "error", dedupeMs = 2000): void {
		const normalized = text.trim().toLowerCase();
		if (!normalized) return;
		const now = Date.now();
		if (this.lastRuntimeNoticeSignature === normalized && now - this.lastRuntimeNoticeAt < dedupeMs) {
			return;
		}
		this.lastRuntimeNoticeSignature = normalized;
		this.lastRuntimeNoticeAt = now;
		const inlineLine = this.toRuntimeInlineLine(text);
		if (inlineLine) {
			this.appendSystemMessage(inlineLine, { idPrefix: "runtimeError" });
		}
		this.pushNotice(text, kind);
	}

	private extensionLabelFromPath(pathValue: string | null | undefined): string {
		const value = normalizeText(pathValue);
		if (!value) return t("chatView.error.extensionFallback");
		const normalized = value.replace(/\\/g, "/");
		const parts = normalized.split("/").filter((part) => part.length > 0);
		if (parts.length === 0) return value;
		const last = parts[parts.length - 1];
		if (/^index\.(?:ts|js|mjs|cjs)$/i.test(last) && parts.length >= 2) {
			return parts[parts.length - 2];
		}
		return last;
	}

	private maybePushExtensionCompatibilityHint(event: Record<string, unknown>, errorMessage: string): void {
		const normalizedError = errorMessage.trim().toLowerCase();
		if (!normalizedError.includes("modelregistry.getapikey is not a function")) return;
		const extensionPath = pickString(event, ["extensionPath", "extension", "path"]);
		const callbackEvent = pickString(event, ["event", "callback", "method"]);
		const signature = `${(extensionPath ?? "").toLowerCase()}::${(callbackEvent ?? "").toLowerCase()}::modelregistry.getapikey`;
		if (this.extensionCompatibilityHintsShown.has(signature)) return;
		this.extensionCompatibilityHintsShown.add(signature);
		const extensionLabel = this.extensionLabelFromPath(extensionPath);
		const during = callbackEvent ? t("chatView.error.duringEvent", { event: callbackEvent }) : "";
		this.pushRuntimeNotice(
			t("chatView.error.deprecatedGetApiKey", { label: extensionLabel, during }),
			"error",
			12000,
		);
	}

	private handleEvent(event: Record<string, unknown>): void {
		const type = event.type as string;
		if (type === "response") return;

		if (
			handleMessageStreamEvent(type, event, {
				promoteQueuedMessageFromUserEvent: this.promoteQueuedMessageFromUserEvent.bind(this),
				getLastMessage: () => this.messages[this.messages.length - 1] ?? null,
				ensureStreamingAssistantMessage: this.ensureStreamingAssistantMessage.bind(this),
				extractText: this.extractText.bind(this),
				extractAssistantMessageError: this.extractAssistantMessageError.bind(this),
				markAssistantTextObserved: this.markAssistantTextObserved.bind(this),
				markToolActivityObserved: this.markToolActivityObserved.bind(this),
				extractToolOutput: this.extractToolOutput.bind(this),
				findToolCall: this.findToolCall.bind(this),
				findMostRecentRunningToolByName: this.findMostRecentRunningToolByName.bind(this),
				attachOrphanToolResult: this.attachOrphanToolResult.bind(this),
				render: this.render.bind(this),
				scheduleStreamRender: this.scheduleStreamRender.bind(this),
				onToolDetails: (_toolName, details) => this.applyTodoDetails(details),
				scrollToBottom: this.scrollToBottom.bind(this),
				extractRuntimeErrorMessage: this.extractRuntimeErrorMessage.bind(this),
				extractAssistantPartialContent: this.extractAssistantPartialContent.bind(this),
				mergeStreamingText: this.mergeStreamingText.bind(this),
				scheduleStreamingUiReconcile: this.scheduleStreamingUiReconcile.bind(this),
				createId: uid,
			})
		) {
			return;
		}

		if (
			handleCompactionAndRetryEvent(type, event, {
				messagesLength: () => this.messages.length,
				getCompactionCycle: () => this.compactionCycle,
				setCompactionCycle: (cycle) => {
					this.compactionCycle = cycle;
				},
				setCompactionInsertIndex: (index) => {
					this.compactionInsertIndex = index;
				},
				createId: uid,
				extractToolOutput: this.extractToolOutput.bind(this),
				extractRuntimeErrorMessage: this.extractRuntimeErrorMessage.bind(this),
				truncate,
				pushNotice: this.pushNotice.bind(this),
				pushRuntimeNotice: this.pushRuntimeNotice.bind(this),
				markContextUsageUnknown: this.markContextUsageUnknown.bind(this),
				refreshAfterCompaction: this.refreshAfterCompaction.bind(this),
				setRetryStatus: (status) => {
					this.retryStatus = status;
				},
				appendSystemMessage: this.appendSystemMessage.bind(this),
				render: this.render.bind(this),
				scheduleStreamRender: this.scheduleStreamRender.bind(this),
			})
		) {
			return;
		}

		if (
			handleRuntimeStatusEvent(type, event, {
				projectPath: this.projectPath,
				isLoadingModels: () => this.loadingModels,
				isRpcConnected: () => rpcBridge.isConnected,
				getLastMessage: () => this.messages[this.messages.length - 1] ?? null,
				setConnected: (connected) => {
					this.isConnected = connected;
				},
				setBindingStatusText: (text) => {
					this.bindingStatusText = text;
				},
				clearDisconnectNoticeTimer: () => {
					if (!this.disconnectNoticeTimer) return;
					clearTimeout(this.disconnectNoticeTimer);
					this.disconnectNoticeTimer = null;
				},
				scheduleDisconnectNoticeTimer: (callback, delayMs) => {
					this.disconnectNoticeTimer = setTimeout(() => {
						this.disconnectNoticeTimer = null;
						callback();
					}, delayMs);
				},
				setLoadingModels: (loading) => {
					this.loadingModels = loading;
				},
				bumpModelLoadRequestSeq: () => {
					this.modelLoadRequestSeq += 1;
				},
				cancelStreamingUiReconcile: this.cancelStreamingUiReconcile.bind(this),
				scheduleStreamingUiReconcile: this.scheduleStreamingUiReconcile.bind(this),
				setPendingDeliveryMode: (mode) => {
					this.pendingDeliveryMode = mode;
				},
				setRunFlags: ({ hasAssistantText, sawToolActivity, keepWorkflowExpanded }) => {
					this.runHasAssistantText = hasAssistantText;
					this.runSawToolActivity = sawToolActivity;
					this.keepWorkflowExpandedUntilAssistantText = keepWorkflowExpanded;
				},
				clearCollapsedAutoWorkflowIds: () => this.collapsedAutoWorkflowIds.clear(),
				setStateStreaming: (streaming) => {
					if (!this.state) return;
					this.state = { ...this.state, isStreaming: streaming };
					this.onStateChange?.(this.state);
				},
				setAutoFollowChat: (next) => {
					this.autoFollowChat = next;
				},
				onRunStateChange: (running) => {
					this.onRunStateChange?.(running);
				},
				setRetryStatus: (status) => {
					this.retryStatus = status;
				},
				pushRuntimeNotice: this.pushRuntimeNotice.bind(this),
				pushNotice: this.pushNotice.bind(this),
				extractRuntimeErrorMessage: this.extractRuntimeErrorMessage.bind(this),
				truncate,
				extensionLabelFromPath: this.extensionLabelFromPath.bind(this),
				maybePushExtensionCompatibilityHint: this.maybePushExtensionCompatibilityHint.bind(this),
				render: this.render.bind(this),
				scrollToBottom: this.scrollToBottom.bind(this),
				refreshFromBackend: this.refreshFromBackend.bind(this),
				loadAvailableModels: this.loadAvailableModels.bind(this),
				refreshStateAfterAgentEnd: () => {
					rpcBridge
						.getState()
						.then((state) => {
							this.state = state;
							this.syncComposerQueueFromState(state);
							this.pendingDeliveryMode = state.isStreaming ? "steer" : "prompt";
							this.onStateChange?.(state);
							void this.refreshSessionStats(true);
							void this.refreshGitSummary(true);
							this.reviewPanel.refreshIfOpen();
							this.render();
						})
						.catch(() => {
							/* ignore */
						});
				},
			})
		) {
			return;
		}
	}

	private findToolCall(id: string): ToolCallBlock | null {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			const found = message.toolCalls.find((tc) => tc.id === id);
			if (found) return found;
		}
		return null;
	}

	private findMostRecentRunningToolByName(name: string): ToolCallBlock | null {
		const normalized = name.trim().toLowerCase();
		if (!normalized) return null;
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			for (let j = message.toolCalls.length - 1; j >= 0; j--) {
				const tool = message.toolCalls[j];
				if (tool.name.trim().toLowerCase() !== normalized) continue;
				if (!tool.isRunning && tool.result) continue;
				return tool;
			}
		}
		return null;
	}

	private findMostRecentAssistantMessage(): UiMessage | null {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role === "assistant") return message;
		}
		return null;
	}

	private attachOrphanToolResult(toolName: string, output: string, isError: boolean): void {
		const assistantMessage = this.findMostRecentAssistantMessage();
		if (!assistantMessage) {
			const outputText = output || t("chatView.tool.noOutput");
			this.messages.push({
				id: uid("toolResult"),
				role: "system",
				text: isError ? t("chatView.tool.resultError", { output: outputText }) : t("chatView.tool.result", { output: outputText }),
				label: "tool-result",
				toolCalls: [],
			});
			return;
		}
		assistantMessage.toolCalls.push({
			id: uid("tc"),
			name: toolName || "tool",
			args: {},
			result: output || t("chatView.tool.noOutput"),
			isError,
			isRunning: false,
			isExpanded: false,
			startedAt: Date.now(),
			endedAt: Date.now(),
		});
	}

	private pushNotice(text: string, kind: Notice["kind"]): void {
		const id = uid("notice");
		this.notices = [...this.notices, { id, text, kind }];
		this.render();
		setTimeout(() => {
			this.notices = this.notices.filter((n) => n.id !== id);
			this.render();
		}, 4200);
	}

	private isImageName(name: string): boolean {
		return isImageNameValue(name);
	}

	private mimeFromFileName(name: string): string {
		return mimeFromFileNameValue(name);
	}

	private toBase64(bytes: Uint8Array): string {
		return toBase64Bytes(bytes);
	}

	private isImageFile(file: File): boolean {
		return isImageFileValue(file);
	}

	private fileNameFromPath(path: string): string {
		return fileNameFromPathValue(path);
	}

	private shouldIgnoreDuplicateDrop(names: string[]): boolean {
		const signature = createDropSignature(names);
		if (!signature) return false;
		const now = Date.now();
		if (this.lastDropSignature === signature && now - this.lastDropAt < 1200) {
			return true;
		}
		this.lastDropSignature = signature;
		this.lastDropAt = now;
		return false;
	}

	private extractFilePathsFromDropPayload(raw: string): string[] {
		return extractFilePathsFromDropPayloadValue(raw);
	}

	private normalizeDroppedPath(path: string): string {
		return path.replace(/\\/g, "/").trim();
	}

	private formatDroppedPathToken(path: string): string {
		const normalized = this.normalizeDroppedPath(path);
		if (!normalized) return "";
		const projectRoot = this.projectPath ? this.normalizeDroppedPath(this.projectPath).replace(/\/+$/, "") : "";
		let token = normalized;
		if (projectRoot) {
			const lowerPath = normalized.toLowerCase();
			const lowerRoot = projectRoot.toLowerCase();
			if (lowerPath === lowerRoot) {
				token = ".";
			} else if (lowerPath.startsWith(`${lowerRoot}/`)) {
				token = `./${normalized.slice(projectRoot.length + 1)}`;
			}
		}
		if (/\s/.test(token)) {
			return `"${token.replace(/"/g, '\\"')}"`;
		}
		return token;
	}

	private appendDroppedPathReferences(paths: string[]): void {
		const seen = new Set<string>(this.pendingFileReferences.map((entry) => entry.token.toLowerCase()));
		const next: PendingFileReference[] = [];
		for (const rawPath of paths) {
			const normalizedPath = this.normalizeDroppedPath(rawPath);
			if (!normalizedPath) continue;
			const token = this.formatDroppedPathToken(normalizedPath);
			if (!token) continue;
			const key = token.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			next.push({
				id: uid("file"),
				name: this.fileNameFromPath(normalizedPath),
				path: normalizedPath,
				token,
			});
		}
		if (next.length === 0) return;
		this.pendingFileReferences = [...this.pendingFileReferences, ...next];
		this.renderComposerAttachmentChange();
	}

	private dedupeDroppedPaths(paths: string[]): string[] {
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const rawPath of paths) {
			const normalized = this.normalizeDroppedPath(rawPath);
			if (!normalized) continue;
			const key = normalized.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			unique.push(normalized);
		}
		return unique;
	}

	private handleDroppedPathCandidates(
		paths: string[],
		options: { quietImageReadFailure?: boolean } = {},
	): boolean {
		const normalizedPaths = this.dedupeDroppedPaths(paths);
		if (normalizedPaths.length === 0) return false;
		const signatureNames = normalizedPaths.map((path) => this.fileNameFromPath(path));
		if (signatureNames.length > 0 && this.shouldIgnoreDuplicateDrop(signatureNames)) {
			return true;
		}
		const imagePaths = normalizedPaths.filter((path) => this.isImageName(this.fileNameFromPath(path)));
		const filePaths = normalizedPaths.filter((path) => !this.isImageName(this.fileNameFromPath(path)));

		let handled = false;
		if (imagePaths.length > 0) {
			void this.prepareImagesFromPaths(imagePaths, {
				quietIfNone: options.quietImageReadFailure ?? true,
			});
			handled = true;
		}
		if (filePaths.length > 0) {
			this.appendDroppedPathReferences(filePaths);
			handled = true;
		}
		return handled;
	}

	private pathFromDroppedFile(file: File): string {
		const maybePath = file as File & { path?: string; webkitRelativePath?: string };
		const pathValue =
			typeof maybePath.path === "string" && maybePath.path.trim().length > 0
				? maybePath.path
				: typeof maybePath.webkitRelativePath === "string" && maybePath.webkitRelativePath.trim().length > 0
					? maybePath.webkitRelativePath
					: file.name || "";
		return this.normalizeDroppedPath(pathValue);
	}

	private async prepareImagesFromPaths(paths: string[], options: { quietIfNone?: boolean } = {}): Promise<void> {
		if (paths.length === 0) return;
		try {
			const { readFile, stat } = await import("@tauri-apps/plugin-fs");
			// CHAT-02：先 stat 收集文件大小，过 数量/单文件大小/总量 闸门后再读内容，
			// 避免超限大文件进入 renderer 内存。
			const candidates: Array<{ name: string; size: number; path: string }> = [];
			for (const path of paths) {
				const cleanPath = path.trim();
				if (!cleanPath) continue;
				const name = this.fileNameFromPath(cleanPath);
				if (!this.isImageName(name)) continue;
				try {
					const info = await stat(cleanPath);
					candidates.push({ name, size: info.size, path: cleanPath });
				} catch {
					// ignore unreadable file
				}
			}
			const accepted = this.gatePendingImageCandidates(candidates);
			if (accepted.length === 0) {
				if (candidates.length === 0 && !options.quietIfNone) {
					this.pushNotice(t("chatView.notice.readImagesFailed"), "info");
				}
				return;
			}
			// 闸门已同步登记占用，读取结束（含提前返回与异常）必须在 finally 中释放。
			const reservedBytes = accepted.reduce((sum, candidate) => sum + candidate.size, 0);
			try {
				const next: PendingImage[] = [];
				for (const candidate of accepted) {
					try {
						const bytes = await readFile(candidate.path);
						const mime = this.mimeFromFileName(candidate.name);
						const base64 = this.toBase64(bytes);
						next.push({
							id: uid("img"),
							name: candidate.name,
							path: candidate.path,
							mimeType: mime,
							data: base64,
							previewUrl: `data:${mime};base64,${base64}`,
							size: bytes.length,
						});
					} catch {
						// ignore unreadable file
					}
				}
				if (next.length === 0) {
					if (!options.quietIfNone) {
						this.pushNotice(t("chatView.notice.readImagesFailed"), "info");
					}
					return;
				}
				this.pendingImages = [...this.pendingImages, ...next];
				this.renderComposerAttachmentChange();
			} finally {
				this.releasePendingImageReservation(accepted.length, reservedBytes);
			}
		} catch {
			this.pushNotice(t("chatView.notice.dropBlocked"), "error");
		}
	}

	private handleDroppedDataTransfer(dataTransfer: DataTransfer | null): void {
		const activeSidebarPaths = peekActiveDraggedFilePaths();
		if (!dataTransfer) {
			const handledFromSidebarFallback = this.handleDroppedPathCandidates(activeSidebarPaths, {
				quietImageReadFailure: true,
			});
			if (activeSidebarPaths.length > 0) {
				clearActiveDraggedFilePaths();
			}
			if (!handledFromSidebarFallback && activeSidebarPaths.length > 0) {
				this.pushNotice(t("chatView.notice.noReadableDropped"), "info");
			}
			return;
		}

		const customPayload = dataTransfer.getData("application/x-pi-file-path") || "";
		const customPaths = customPayload
			.split(/\r?\n/)
			.map((value) => value.trim())
			.filter(Boolean);
		const customJsonPayload = dataTransfer.getData("application/x-pi-file-paths-json") || "";
		let customJsonPaths: string[] = [];
		if (customJsonPayload) {
			try {
				const parsed = JSON.parse(customJsonPayload) as unknown;
				if (Array.isArray(parsed)) {
					customJsonPaths = parsed.filter((value): value is string => typeof value === "string");
				}
			} catch {
				// ignore malformed payload
			}
		}
		const uriPayload = [customPayload, customJsonPaths.join("\n"), dataTransfer.getData("text/uri-list"), dataTransfer.getData("text/plain")]
			.map((value) => value || "")
			.join("\n");
		const uriPaths = this.extractFilePathsFromDropPayload(uriPayload);
		const droppedPathsFromPayload = this.dedupeDroppedPaths([...customPaths, ...customJsonPaths, ...uriPaths]);

		const directFiles = Array.from(dataTransfer.files || []);
		const fromItems = Array.from(dataTransfer.items || [])
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter((f): f is File => Boolean(f));
		const fileObjects = directFiles.length > 0 ? directFiles : fromItems;

		const imageFiles = fileObjects.filter((file) => this.isImageFile(file));
		const imagePathsFromPayload = droppedPathsFromPayload.filter((path) => this.isImageName(this.fileNameFromPath(path)));
		const filePathsFromPayload = droppedPathsFromPayload.filter((path) => !this.isImageName(this.fileNameFromPath(path)));
		const filePathsFromObjects = this.dedupeDroppedPaths(
			fileObjects
				.filter((file) => !this.isImageFile(file))
				.map((file) => this.pathFromDroppedFile(file))
				.filter(Boolean),
		);

		const hasPayloadCandidates =
			imageFiles.length > 0 ||
			imagePathsFromPayload.length > 0 ||
			filePathsFromPayload.length > 0 ||
			filePathsFromObjects.length > 0;
		const fallbackSidebarPaths = !hasPayloadCandidates ? this.dedupeDroppedPaths(activeSidebarPaths) : [];
		const fallbackImagePaths = fallbackSidebarPaths.filter((path) => this.isImageName(this.fileNameFromPath(path)));
		const fallbackFilePaths = fallbackSidebarPaths.filter((path) => !this.isImageName(this.fileNameFromPath(path)));

		const imagePaths = imagePathsFromPayload.length > 0 ? imagePathsFromPayload : fallbackImagePaths;
		const filePaths = this.dedupeDroppedPaths(
			filePathsFromPayload.length > 0
				? filePathsFromPayload
				: filePathsFromObjects.length > 0
					? filePathsFromObjects
					: fallbackFilePaths,
		);

		if (customPaths.length > 0 || customJsonPaths.length > 0 || fallbackSidebarPaths.length > 0) {
			clearActiveDraggedFilePaths();
		}

		const signatureNames = [
			...imageFiles.map((file) => file.name || ""),
			...imagePaths.map((path) => this.fileNameFromPath(path)),
			...filePaths.map((path) => this.fileNameFromPath(path)),
		];
		if (signatureNames.length > 0 && this.shouldIgnoreDuplicateDrop(signatureNames)) return;

		let handled = false;
		if (imageFiles.length > 0) {
			void this.prepareImages(imageFiles);
			handled = true;
		} else if (imagePaths.length > 0) {
			void this.prepareImagesFromPaths(imagePaths, { quietIfNone: true });
			handled = true;
		}

		if (filePaths.length > 0) {
			this.appendDroppedPathReferences(filePaths);
			handled = true;
		}

		if (!handled && activeSidebarPaths.length > 0) {
			const handledFromSidebarFallback = this.handleDroppedPathCandidates(activeSidebarPaths, {
				quietImageReadFailure: true,
			});
			clearActiveDraggedFilePaths();
			if (handledFromSidebarFallback) {
				handled = true;
			}
		}

		if (!handled) {
			this.pushNotice(t("chatView.notice.noReadableDropped"), "info");
		}
	}

	private async prepareComposerFiles(files: FileList | File[]): Promise<void> {
		const list = Array.from(files || []);
		if (list.length === 0) return;
		const imageFiles = list.filter((file) => this.isImageFile(file));
		const filePaths = this.dedupeDroppedPaths(
			list
				.filter((file) => !this.isImageFile(file))
				.map((file) => this.pathFromDroppedFile(file))
				.filter(Boolean),
		);
		if (imageFiles.length > 0) {
			await this.prepareImages(imageFiles);
		}
		if (filePaths.length > 0) {
			this.appendDroppedPathReferences(filePaths);
		}
		if (imageFiles.length === 0 && filePaths.length === 0) {
			this.pushNotice(t("chatView.notice.noReadableSelected"), "info");
		}
	}

	/**
	 * CHAT-02 附件闸门：单文件 ≤10MB、（含已有待发与在途读取）累计 ≤10 个、累计总字节 ≤50MB。
	 * 返回允许加入的候选子集：单文件超限只剔除该文件，数量超限截断到可容纳部分并提示，
	 * 总字节超限整批拒绝。判定与占用登记在同一同步临界段完成（先入账再读内容），
	 * 调用方读取结束后必须调用 releasePendingImageReservation 释放登记。
	 */
	private gatePendingImageCandidates<T extends { name: string; size: number }>(candidates: T[]): T[] {
		if (candidates.length === 0) return candidates;
		const accepted: T[] = [];
		let oversized = 0;
		for (const candidate of candidates) {
			if (candidate.size > ATTACHMENT_MAX_FILE_BYTES) {
				oversized += 1;
				continue;
			}
			accepted.push(candidate);
		}
		if (oversized > 0) {
			this.pushNotice(
				t("chatView.notice.attachTooLarge", { count: oversized, max: ATTACHMENT_MAX_FILE_BYTES / (1024 * 1024) }),
				accepted.length > 0 ? "info" : "error",
			);
		}
		if (accepted.length === 0) return [];
		// 数量上限按「已有待发 + 在途读取 + 本次候选」累计：容纳得下多少收多少，超出部分跳过。
		const occupiedCount = this.pendingImages.length + this.pendingImageReservedCount;
		const availableCount = ATTACHMENT_MAX_FILES - occupiedCount;
		if (availableCount <= 0) {
			this.pushNotice(t("chatView.notice.attachTooMany", { max: ATTACHMENT_MAX_FILES }), "error");
			return [];
		}
		let batch = accepted;
		if (accepted.length > availableCount) {
			batch = accepted.slice(0, availableCount);
			this.pushNotice(
				t("chatView.notice.attachTooManyTruncated", {
					accepted: batch.length,
					skipped: accepted.length - batch.length,
					max: ATTACHMENT_MAX_FILES,
				}),
				"info",
			);
		}
		// 总字节同样按「已有待发 + 在途读取 + 本次候选」累计。
		const occupiedBytes =
			this.pendingImages.reduce((sum, img) => sum + (img.size || 0), 0) + this.pendingImageReservedBytes;
		const incomingBytes = batch.reduce((sum, item) => sum + item.size, 0);
		if (occupiedBytes + incomingBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
			this.pushNotice(t("chatView.notice.attachTotalTooLarge", { max: ATTACHMENT_MAX_TOTAL_BYTES / (1024 * 1024) }), "error");
			return [];
		}
		// 同步临界段收尾：占用先入账，并发批次以此为准串行裁决；读取完成后释放。
		this.pendingImageReservedCount += batch.length;
		this.pendingImageReservedBytes += incomingBytes;
		return batch;
	}

	/** 释放 gatePendingImageCandidates 登记的在途占用（个数/字节须与通过批次一致）。 */
	private releasePendingImageReservation(count: number, bytes: number): void {
		this.pendingImageReservedCount = Math.max(0, this.pendingImageReservedCount - count);
		this.pendingImageReservedBytes = Math.max(0, this.pendingImageReservedBytes - bytes);
	}

	private async prepareImages(files: FileList | File[]): Promise<void> {
		const list = Array.from(files).filter((f) => this.isImageFile(f));
		if (list.length === 0) {
			this.pushNotice(t("chatView.notice.dropImageOnly"), "info");
			return;
		}
		// CHAT-02：读入内存前先过 数量/单文件大小/总量 闸门（File.size 免读可得）；
		// 闸门已同步登记占用，读取结束（含提前返回与异常）必须在 finally 中释放。
		const allowedList = this.gatePendingImageCandidates(list);
		if (allowedList.length === 0) return;
		const reservedBytes = allowedList.reduce((sum, file) => sum + file.size, 0);

		const next: PendingImage[] = [];
		let failed = 0;

		try {
			for (const file of allowedList) {
				const safeName = file.name || `image-${Date.now()}.png`;
				const mime = file.type || this.mimeFromFileName(safeName);
				const rawPathHint = this.pathFromDroppedFile(file);
				const pathHint = rawPathHint && rawPathHint !== safeName ? rawPathHint : undefined;
				let base64 = "";

				try {
					base64 = await this.fileToBase64(file);
				} catch {
					try {
						const dataUrl = await this.fileToDataUrl(file);
						const [head, fromDataUrl = ""] = dataUrl.split(",");
						base64 = fromDataUrl;
						if (!file.type) {
							const parsedMime = head.match(/data:(.*);base64/)?.[1];
							if (parsedMime) {
								next.push({
									id: uid("img"),
									name: safeName,
									path: pathHint,
									mimeType: parsedMime,
									data: base64,
									previewUrl: `data:${parsedMime};base64,${base64}`,
									size: file.size,
								});
								continue;
							}
						}
					} catch {
						failed += 1;
						continue;
					}
				}

				if (!base64) {
					failed += 1;
					continue;
				}

				next.push({
					id: uid("img"),
					name: safeName,
					path: pathHint,
					mimeType: mime,
					data: base64,
					previewUrl: `data:${mime};base64,${base64}`,
					size: file.size,
				});
			}

			if (next.length === 0) {
				this.pushNotice(t("chatView.notice.readImagesFailed"), "error");
				return;
			}

			this.pendingImages = [...this.pendingImages, ...next];
			this.renderComposerAttachmentChange();
			if (failed > 0) {
				this.pushNotice(t("chatView.notice.attachPartial", { count: next.length, failed }), "info");
			}
		} finally {
			this.releasePendingImageReservation(allowedList.length, reservedBytes);
		}
	}

	private async fileToBase64(file: File): Promise<string> {
		const buffer = await file.arrayBuffer();
		return this.toBase64(new Uint8Array(buffer));
	}

	private fileToDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result || ""));
			reader.onerror = () => reject(reader.error || new Error(t("chatView.notice.readFileFailed")));
			reader.readAsDataURL(file);
		});
	}

	private removePendingImage(id: string): void {
		this.pendingImages = this.pendingImages.filter((img) => img.id !== id);
		this.renderComposerAttachmentChange();
	}

	/** 点开图片大图查看器（composer 待发图片与时间线已发图片共用）。 */
	private previewImages(images: PendingImage[] | undefined, imageId: string): void {
		const list = images ?? [];
		if (list.length === 0) return;
		const index = Math.max(0, list.findIndex((img) => img.id === imageId));
		openImageLightbox(
			list.map((img) => ({ name: img.name, src: img.previewUrl, path: img.path, mimeType: img.mimeType, data: img.data })),
			index,
		);
	}

	private removePendingFileReference(id: string): void {
		this.pendingFileReferences = this.pendingFileReferences.filter((entry) => entry.id !== id);
		this.renderComposerAttachmentChange();
	}

	private renderComposerAttachmentChange(): void {
		const currentInput = this.container.querySelector<HTMLTextAreaElement>("#chat-input");
		const selectionStart = currentInput?.selectionStart ?? this.inputText.length;
		const selectionEnd = currentInput?.selectionEnd ?? selectionStart;
		this.render();
		requestAnimationFrame(() => {
			const nextInput = this.container.querySelector<HTMLTextAreaElement>("#chat-input");
			if (!nextInput || nextInput.disabled) return;
			nextInput.focus({ preventScroll: true });
			nextInput.setSelectionRange(
				Math.min(selectionStart, nextInput.value.length),
				Math.min(selectionEnd, nextInput.value.length),
			);
		});
	}

	private composedPromptText(rawText: string): string {
		const baseText = rawText.trim();
		const fileTokens = this.pendingFileReferences.map((entry) => entry.token).filter((token) => token.length > 0);
		if (fileTokens.length === 0) return baseText;
		const fileBlock = fileTokens.join("\n");
		return baseText ? `${baseText}\n\n${fileBlock}` : fileBlock;
	}

	private currentIsStreaming(): boolean {
		return Boolean(this.state?.isStreaming) || this.messages.some((m) => m.isStreaming);
	}

	private isComposerInteractionLocked(): boolean {
		if (!this.projectPath) return true;
		// 连接中/绑定中（bindingStatusText 非空）不再锁输入：允许输入并本地排队，
		// 就绪后自动发送。仅当彻底断开（无连接且无任何绑定进度）时才锁死。
		if (!this.isConnected && !this.bindingStatusText) return true;
		return false;
	}

	/** runtime 尚在启动/切换/重连窗口：消息应本地排队，而不是立即走 RPC。 */
	private isConnectionPending(): boolean {
		return Boolean(this.projectPath) && Boolean(this.bindingStatusText);
	}

	private toRpcImages(images: PendingImage[]): RpcImageInput[] {
		return images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));
	}

	private cloneImages(images?: PendingImage[]): PendingImage[] {
		if (!images || images.length === 0) return [];
		return images.map((img) => ({ ...img, id: uid("img") }));
	}

	private hasRenderableAssistantContent(msg: UiMessage): boolean {
		if (msg.role !== "assistant") return false;
		if (msg.toolCalls.length > 0) return true;
		if (msg.text.trim().length > 0) return true;
		if ((msg.thinking ?? "").trim().length > 0) return true;
		return (msg.errorText ?? "").trim().length > 0;
	}

	private ensureStreamingAssistantMessage(seed?: { text?: string; errorText?: string }): UiMessage {
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "assistant" && last.isStreaming) {
			if (seed?.text && seed.text.trim().length > 0 && last.text.trim().length === 0) {
				last.text = seed.text;
			}
			if (seed?.errorText && !last.errorText) {
				last.errorText = seed.errorText;
			}
			return last;
		}
			const next: UiMessage = {
				id: uid("assistant"),
				role: "assistant",
				text: seed?.text ?? "",
				errorText: seed?.errorText,
				toolCalls: [],
				startedAt: Date.now(),
				isStreaming: true,
			isThinkingStreaming: false,
			thinkingExpanded: this.allThinkingExpanded,
		};
		this.messages.push(next);
		return next;
	}

	private messagePreview(msg: UiMessage): string {
		const text = msg.text?.trim();
		if (text) return text;
		if (msg.role === "assistant" && msg.toolCalls.length > 0) {
			return t("chatView.message.toolCalls", { names: msg.toolCalls.map((tc) => tc.name).join(", ") });
		}
		if (msg.attachments && msg.attachments.length > 0) {
			return t("chatView.message.imageAttachments", { count: msg.attachments.length });
		}
		return t("chatView.message.empty");
	}

	private pushUserEcho(text: string, mode: DeliveryMode, images: PendingImage[]): string {
		// 新消息进入消息流：退出可能存在的「编辑并重发」就地编辑态。
		this.clearTimelineMessageEditing();
		const id = uid("user");
		this.messages.push({
			id,
			role: "user",
			text,
			toolCalls: [],
			attachments: images,
			deliveryMode: mode,
		});
		this.autoFollowChat = true;
		if (this.runStartedAt <= 0) {
			this.runStartedAt = Date.now();
		}
		this.runHasAssistantText = false;
		this.runSawToolActivity = false;
		this.keepWorkflowExpandedUntilAssistantText = false;
		this.collapsedAutoWorkflowIds.clear();
		this.render();
		this.scrollToBottom(true);
		return id;
	}

	private promoteQueuedMessageFromUserEvent(message: Record<string, unknown>): boolean {
		// 连接中本地排队的条目（awaitingConnection）还没有后端回声，不参与提升匹配。
		const candidates = this.queuedComposerMessages.filter((entry) => !entry.awaitingConnection);
		if (candidates.length === 0) return false;
		const normalize = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
		const eventTextRaw = this.extractText(message.content ?? "");
		const eventText = normalize(eventTextRaw);
		let matchIndex = -1;
		if (eventText.length > 0) {
			matchIndex = candidates.findIndex((entry) => normalize(entry.text) === eventText);
		} else {
			matchIndex = candidates.findIndex((entry) => normalize(entry.text).length === 0);
			if (matchIndex < 0 && candidates.length === 1) {
				matchIndex = 0;
			}
		}
		if (matchIndex < 0) return false;
		const queued = candidates[matchIndex];
		const queueIndex = this.queuedComposerMessages.findIndex((entry) => entry.id === queued.id);
		if (queueIndex < 0) return false;
		this.queuedComposerMessages.splice(queueIndex, 1);
		const last = this.messages[this.messages.length - 1];
		if (
			last?.role === "user" &&
			last.deliveryMode === "followUp" &&
			normalize(last.text) === normalize(queued.text) &&
			(last.attachments?.length ?? 0) === queued.attachments.length
		) {
			return true;
		}
		this.pushUserEcho(queued.text, "followUp", this.cloneImages(queued.attachments));
		return true;
	}

	private enqueueComposerQueueMessage(text: string, attachments: PendingImage[]): string {
		const clonedAttachments = this.cloneImages(attachments);
		const entry: QueuedComposerMessage = {
			id: uid("queued"),
			text,
			attachments: clonedAttachments,
			imageCount: clonedAttachments.length,
			createdAt: Date.now(),
		};
		this.queuedComposerMessages = [...this.queuedComposerMessages, entry].slice(-6);
		return entry.id;
	}

	private removeComposerQueueMessage(id: string): void {
		const next = this.queuedComposerMessages.filter((entry) => entry.id !== id);
		if (next.length === this.queuedComposerMessages.length) return;
		this.queuedComposerMessages = next;
	}

	private clearComposerQueueMessages(): void {
		if (this.queuedComposerMessages.length === 0) return;
		this.queuedComposerMessages = [];
	}

	/** 连接中本地排队：复用队列 UI 展示，标记 awaitingConnection 以便就绪后自动发出。 */
	private enqueueOfflineQueueMessage(text: string, attachments: PendingImage[]): void {
		const clonedAttachments = this.cloneImages(attachments);
		const entry: QueuedComposerMessage = {
			id: uid("queued"),
			text,
			attachments: clonedAttachments,
			imageCount: clonedAttachments.length,
			createdAt: Date.now(),
			awaitingConnection: true,
		};
		this.queuedComposerMessages = [...this.queuedComposerMessages, entry].slice(-6);
	}

	private offlineQueueFlushInFlight = false;

	/**
	 * 会话就绪（refreshFromBackend 成功）后逐条发出连接中排队的消息。
	 * 第二条起若已 streaming，走 steer/followUp（与手动连发行为一致）。
	 */
	private async flushOfflineComposerQueue(): Promise<void> {
		if (this.offlineQueueFlushInFlight) return;
		if (!this.queuedComposerMessages.some((entry) => entry.awaitingConnection)) return;
		this.offlineQueueFlushInFlight = true;
		try {
			for (;;) {
				if (this.isConnectionPending() || !this.isConnected) break;
				const next = this.queuedComposerMessages.find((entry) => entry.awaitingConnection);
				if (!next) break;
				this.removeComposerQueueMessage(next.id);
				this.inputText = next.text;
				this.pendingImages = next.attachments.map((img) => ({ ...img }));
				await this.sendMessage(this.currentIsStreaming() ? this.pendingDeliveryMode : "prompt");
			}
		} finally {
			this.offlineQueueFlushInFlight = false;
			this.render();
		}
	}

	/** 切换会话/项目时，把尚未发出的本地排队消息还原成 composer 草稿，避免发到错误的会话。 */
	private restoreOfflineQueueToComposerDraft(): void {
		const awaiting = this.queuedComposerMessages.filter((entry) => entry.awaitingConnection);
		if (awaiting.length === 0) return;
		this.queuedComposerMessages = this.queuedComposerMessages.filter((entry) => !entry.awaitingConnection);
		if (this.inputText.trim()) return;
		this.inputText = awaiting
			.map((entry) => entry.text)
			.filter((text) => text.trim().length > 0)
			.join("\n");
		const restoredImages = awaiting.flatMap((entry) => entry.attachments);
		if (restoredImages.length > 0 && this.pendingImages.length === 0) {
			this.pendingImages = restoredImages.map((img) => ({ ...img }));
		}
	}

	private syncComposerQueueFromState(state: RpcSessionState | null | undefined): void {
		const pendingCount = Math.max(0, state?.pendingMessageCount ?? 0);
		// 只统计已发给后端的排队条目；连接中本地排队的条目不占后端 pending 名额。
		const backendQueuedCount = this.queuedComposerMessages.filter((entry) => !entry.awaitingConnection).length;
		if (pendingCount > 0 && backendQueuedCount > pendingCount) {
			let excess = backendQueuedCount - pendingCount;
			this.queuedComposerMessages = this.queuedComposerMessages.filter((entry) => {
				if (entry.awaitingConnection || excess <= 0) return true;
				excess -= 1;
				return false;
			});
		}
	}

	private resetComposerHistoryNavigation(): void {
		this.composerHistoryIndex = -1;
		this.composerHistoryDraft = "";
	}

	private rememberComposerHistoryEntry(rawText: string): void {
		const text = rawText.trim();
		if (!text) return;
		const last = this.composerInputHistory[this.composerInputHistory.length - 1] ?? "";
		if (last !== text) {
			this.composerInputHistory.push(text);
			if (this.composerInputHistory.length > 120) {
				this.composerInputHistory.splice(0, this.composerInputHistory.length - 120);
			}
		}
		this.resetComposerHistoryNavigation();
	}

	private shouldHandleComposerHistoryKey(event: KeyboardEvent, textarea: HTMLTextAreaElement, direction: "up" | "down"): boolean {
		if (event.altKey || event.ctrlKey || event.metaKey) return false;
		if (textarea.selectionStart !== textarea.selectionEnd) return false;
		const caret = textarea.selectionStart;
		if (direction === "up") {
			return textarea.value.slice(0, caret).indexOf("\n") === -1;
		}
		if (this.composerHistoryIndex < 0) return false;
		return textarea.value.indexOf("\n", caret) === -1;
	}

	private applyComposerText(text: string): void {
		this.inputText = text;
		this.updateSlashPaletteStateFromInput();
		this.render();
		this.syncComposerTextareaDeferred(text, {
			maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT,
			moveCaretToEnd: true,
			focus: true,
		});
	}

	private navigateComposerHistory(direction: "up" | "down"): void {
		if (this.composerInputHistory.length === 0) return;
		if (direction === "up") {
			if (this.composerHistoryIndex < 0) {
				this.composerHistoryDraft = this.inputText;
				this.composerHistoryIndex = this.composerInputHistory.length - 1;
			} else if (this.composerHistoryIndex > 0) {
				this.composerHistoryIndex -= 1;
			}
			const entry = this.composerInputHistory[this.composerHistoryIndex] ?? "";
			this.applyComposerText(entry);
			return;
		}
		if (this.composerHistoryIndex < 0) return;
		if (this.composerHistoryIndex < this.composerInputHistory.length - 1) {
			this.composerHistoryIndex += 1;
			const entry = this.composerInputHistory[this.composerHistoryIndex] ?? "";
			this.applyComposerText(entry);
			return;
		}
		const draft = this.composerHistoryDraft;
		this.resetComposerHistoryNavigation();
		this.applyComposerText(draft);
	}

	private clearComposer(): void {
		this.inputText = "";
		this.pendingImages = [];
		this.pendingFileReferences = [];
		this.selectedSkillDraft = null;
		this.resetComposerHistoryNavigation();
		this.closeSlashPalette();
		this.render();
		this.syncComposerTextarea("", { maxHeight: 0 });
	}

	async sendMessage(
		mode: DeliveryMode = this.pendingDeliveryMode,
		options: { restoreComposerOnFailure?: boolean } = {},
	): Promise<void> {
		await sendMessageFlow({
			mode,
			bindingStatusText: this.bindingStatusText,
			isComposerInteractionLocked: this.isComposerInteractionLocked.bind(this),
			connectionPending: this.isConnectionPending(),
			inputText: this.composedPromptText(this.inputText),
			selectedSkillCommandText: this.selectedSkillDraft?.commandText?.trim() ?? "",
			pendingImages: [...this.pendingImages],
			slashQueryFromInput: () => (this.pendingFileReferences.length > 0 ? null : this.slashQueryFromInput()),
			executeSlashCommandFromComposer: this.executeSlashCommandFromComposer.bind(this),
			rememberComposerHistoryEntry: this.rememberComposerHistoryEntry.bind(this),
			currentIsStreaming: this.currentIsStreaming.bind(this),
			applyBackendState: (state) => {
				this.state = state;
				this.syncComposerQueueFromState(state);
				this.onStateChange?.(state);
			},
			clearStreamingUiState: this.clearStreamingUiState.bind(this),
			render: this.render.bind(this),
			enqueueComposerQueueMessage: this.enqueueComposerQueueMessage.bind(this),
			enqueueOfflineQueueMessage: this.enqueueOfflineQueueMessage.bind(this),
			pushNotice: this.pushNotice.bind(this),
			pushUserEcho: this.pushUserEcho.bind(this),
			removeUserEcho: (id) => {
				this.messages = this.messages.filter((message) => message.id !== id);
			},
			clearComposer: this.clearComposer.bind(this),
			setSendingPrompt: (value) => {
				this.sendingPrompt = value;
			},
			toRpcImages: this.toRpcImages.bind(this),
			removeComposerQueueMessage: this.removeComposerQueueMessage.bind(this),
			onSendFailure: options.restoreComposerOnFailure
				? (text, images) => {
					this.pendingFileReferences = [];
					this.inputText = text;
					this.pendingImages = this.cloneImages(images);
					this.render();
					this.syncComposerTextareaDeferred(text, {
						maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT,
						moveCaretToEnd: true,
						focus: true,
					});
				}
				: undefined,
			onPromptSubmitted: this.onPromptSubmitted ?? undefined,
		});
	}

	private async copyMessage(msg: UiMessage): Promise<void> {
		const text = this.messagePreview(msg);
		if (!text || text === t("chatView.message.empty")) {
			this.pushNotice(t("chatView.notice.nothingToCopy"), "info");
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			this.pushNotice(t("chatView.notice.copiedMessage"), "success");
		} catch (err) {
			console.error("Failed to copy message:", err);
			this.pushNotice(t("chatView.notice.copyFailed"), "error");
		}
	}

	private editUserMessage(msg: UiMessage): void {
		this.pendingImages = this.cloneImages(msg.attachments);
		this.pendingFileReferences = [];
		this.setInputText(msg.text || "");
		this.pushNotice(t("chatView.composer.loadedMessage"), "info");
	}

	private async withdrawUserMessage(msg: UiMessage): Promise<void> {
		const text = msg.text || "";
		const images = this.cloneImages(msg.attachments);
		if (!text.trim() && images.length === 0) {
			this.pushNotice(t("chatView.notice.cannotWithdrawEmpty"), "info");
			return;
		}
		if (this.resolvingMessageAction) return;
		if (this.currentIsStreaming()) {
			this.pushNotice(t("chatView.rewrite.streamingBlocked"), "info");
			return;
		}
		const entryId = msg.sessionEntryId?.trim();
		if (!entryId) {
			this.pushNotice(t("chatView.rewrite.entryUnresolved"), "error");
			return;
		}

		this.resolvingMessageAction = true;
		try {
			await this.rewriteTimelineBeforeUserEntry(entryId);
			this.pendingImages = images;
			this.pendingFileReferences = [];
			this.setInputText(text);
			this.pushNotice(t("chatView.composer.withdrawHint"), "success");
		} catch (err) {
			console.error("Failed to withdraw message:", err);
			if (err instanceof SessionRewriteCommittedError) {
				this.applyCommittedRewriteLocally(msg.id);
				this.pendingImages = images;
				this.pendingFileReferences = [];
				this.setInputText(text);
				this.pushNotice(
					t("chatView.rewrite.committedRecoveryFailed", { reason: err.message }),
					"error",
				);
				return;
			}
			this.pushNotice(
				t("chatView.rewrite.failed", { reason: err instanceof Error ? err.message : String(err) }),
				"error",
			);
		} finally {
			this.resolvingMessageAction = false;
		}
	}

	async copyLastMessage(): Promise<boolean> {
		try {
			const text = await rpcBridge.getLastAssistantText();
			if (!text) {
				this.pushNotice(t("chatView.notice.noAssistantToCopy"), "info");
				return false;
			}
			await navigator.clipboard.writeText(text);
			this.pushNotice(t("chatView.notice.copiedLastAssistant"), "success");
			return true;
		} catch (err) {
			console.error("Failed to copy:", err);
			this.pushNotice(t("chatView.notice.copyFailed"), "error");
			return false;
		}
	}

	async exportToHtml(): Promise<void> {
		try {
			const { path } = await rpcBridge.exportHtml();
			this.pushNotice(t("chatView.session.exportedTo", { path: truncate(path, 70) }), "success");
			const { open } = await import("@tauri-apps/plugin-shell");
			await open(path);
		} catch (err) {
			console.error("Failed to export HTML:", err);
			this.pushNotice(t("chatView.session.exportFailed"), "error");
		}
	}

	private async createGitRepository(): Promise<void> {
		if (this.creatingGitRepo) return;
		this.creatingGitRepo = true;
		this.render();
		try {
			const init = await this.runGit(["init"]);
			if (init.exitCode !== 0) {
				this.pushNotice(init.stderr.trim() || init.stdout.trim() || t("chatView.git.createFailed"), "error");
				return;
			}

			const setMain = await this.runGit(["symbolic-ref", "HEAD", "refs/heads/main"]);
			if (setMain.exitCode !== 0) {
				await this.runGit(["branch", "-M", "main"]);
			}

			this.pushNotice(t("chatView.git.repoReady"), "success");
			await this.refreshGitSummary(true);
		} catch (err) {
			console.error("Failed to create git repository:", err);
			this.pushNotice(t("chatView.git.createFailed"), "error");
		} finally {
			this.creatingGitRepo = false;
			this.render();
		}
	}

	async shareAsGist(): Promise<boolean> {
		try {
			const { tempDir } = await import("@tauri-apps/api/path");
			const tempRoot = (await tempDir()).replace(/\\/g, "/").replace(/\/+$/, "");
			const exportPath = `${tempRoot}/session.html`;
			const { path } = await rpcBridge.exportHtml(exportPath);
			const shared = await rpcBridge.createShareGist(path);
			this.appendSystemMessage(`[${t("chatView.session.openShared")}](${shared.preview_url}) · [${t("chatView.session.openGist")}](${shared.gist_url})`, {
				label: "share",
				markdown: true,
			});
			this.pushNotice(t("chatView.session.sharedAsGist"), "success");
			return true;
		} catch (err) {
			console.error("Failed to share as gist:", err);
			const message = err instanceof Error ? err.message : String(err);
			this.pushNotice(truncate(message || t("chatView.session.shareFailed"), 180), "error");
			return false;
		}
	}

	private clearStreamingUiState(): void {
		this.cancelStreamingUiReconcile();
		// 丢掉未落地的节流帧：它持有的是旧流的中间态，在新状态上渲染会闪一下旧内容。
		this.cancelStreamRender();
		this.clearWorkingStatusTimer(true);
		if (this.state) {
			this.state = { ...this.state, isStreaming: false };
			this.onStateChange?.(this.state);
		}
		for (const message of this.messages) {
			if (message.role !== "assistant") continue;
			message.isStreaming = false;
			message.isThinkingStreaming = false;
			if (message.startedAt && !message.endedAt) {
				message.endedAt = Date.now();
			}
			for (const toolCall of message.toolCalls) {
				toolCall.isRunning = false;
				toolCall.streamingOutput = undefined;
			}
		}
		this.retryStatus = "";
		if (this.compactionCycle?.status === "running") {
			this.compactionCycle.status = "aborted";
			this.compactionCycle.summary = t("chatView.compaction.interrupted");
			this.compactionCycle.endedAt = Date.now();
			this.compactionCycle.details.push(t("chatView.compaction.interruptedDetail"));
		}
		this.pendingDeliveryMode = "prompt";
		this.runHasAssistantText = false;
		this.runSawToolActivity = false;
		this.runStartedAt = 0;
		this.keepWorkflowExpandedUntilAssistantText = false;
		this.collapsedAutoWorkflowIds.clear();
		this.onRunStateChange?.(false);
	}

	private async reconcileStreamingUiState(): Promise<void> {
		try {
			const state = await rpcBridge.getState();
			this.state = state;
			this.syncComposerQueueFromState(state);
			this.pendingDeliveryMode = state.isStreaming ? "steer" : "prompt";
			this.onStateChange?.(state);
			this.onRunStateChange?.(Boolean(state.isStreaming));
			if (!state.isStreaming) {
				this.clearStreamingUiState();
			} else {
				this.scheduleStreamingUiReconcile(2200);
			}
		} catch {
			this.clearStreamingUiState();
		} finally {
			this.render();
		}
	}

	async abortCurrentRun(): Promise<void> {
		const hadRetry = Boolean(this.retryStatus);
		this.clearStreamingUiState();
		this.render();
		try {
			if (hadRetry) await rpcBridge.abortRetry();
			await rpcBridge.abort();
			this.pushNotice(t("chatView.notice.aborted"), "info");
		} catch (err) {
			console.error("Failed to abort:", err);
			this.pushNotice(t("chatView.notice.abortFailed"), "error");
		} finally {
			setTimeout(() => {
				void this.reconcileStreamingUiState();
			}, 120);
		}
	}

	async newSession(): Promise<boolean> {
		try {
			await rpcBridge.newSession();
			this.messages = [];
			this.resetTodoState();
			await this.refreshFromBackend();
			this.pushNotice(t("chatView.session.started"), "success");
			return true;
		} catch (err) {
			console.error("Failed to create session:", err);
			this.pushNotice(t("chatView.session.createFailed"), "error");
			return false;
		}
	}

	async compactNow(customInstructions?: string): Promise<boolean> {
		if (this.compactionCycle?.status === "running") {
			this.pushNotice(t("chatView.compaction.alreadyRunning"), "info");
			return false;
		}
		const normalizedInstructions = customInstructions?.trim() || undefined;
		this.compactionInsertIndex = this.messages.length;
		this.compactionCycle = {
			id: uid("compaction"),
			status: "running",
			startedAt: Date.now(),
			endedAt: null,
			summary: t("chatView.compaction.running"),
			errorMessage: null,
			details: normalizedInstructions
				? [t("chatView.compaction.customInstructions", { instructions: truncate(normalizedInstructions, 180) })]
				: [t("chatView.compaction.manualStarted")],
			expanded: false,
		};
		this.render();
		this.scrollToBottom();
		try {
			const result = await rpcBridge.compact(normalizedInstructions);
			const summary = pickString(result as Record<string, unknown>, ["summary"]) || t("chatView.compaction.complete");
			const tokensBefore = pickNumber(result as Record<string, unknown>, ["tokensBefore", "tokens_before"]);
			const firstKeptEntry = pickString(result as Record<string, unknown>, ["firstKeptEntryId", "first_kept_entry_id"]);
			if (this.compactionCycle) {
				this.compactionCycle.status = "done";
				this.compactionCycle.endedAt = Date.now();
				this.compactionCycle.summary = summary;
				if (typeof tokensBefore === "number" && Number.isFinite(tokensBefore)) {
					this.compactionCycle.details.push(t("chatView.compaction.before", { count: Math.round(tokensBefore).toLocaleString() }));
				}
				if (firstKeptEntry) {
					this.compactionCycle.details.push(t("chatView.compaction.firstKept", { id: truncate(firstKeptEntry, 48) }));
				}
				this.compactionCycle.details.push(t("chatView.compaction.completedDetail"));
			}
			this.markContextUsageUnknown();
			this.render();
			await this.refreshFromBackend();
			await this.refreshSessionStats(true);
			if (this.compactionCycle && typeof this.sessionStats.tokens === "number" && Number.isFinite(this.sessionStats.tokens)) {
				this.compactionCycle.details.push(t("chatView.compaction.after", { count: Math.round(this.sessionStats.tokens).toLocaleString() }));
			}
			this.pushNotice(t("chatView.compaction.complete"), "success");
			this.render();
			return true;
		} catch (err) {
			console.error("Failed to compact:", err);
			if (this.compactionCycle) {
				this.compactionCycle.status = "error";
				this.compactionCycle.endedAt = Date.now();
				this.compactionCycle.summary = t("chatView.compaction.failed");
				this.compactionCycle.errorMessage = err instanceof Error ? truncate(err.message, 220) : t("chatView.compaction.unknownError");
			}
			this.pushNotice(t("chatView.compaction.failed"), "error");
			this.render();
			return false;
		}
	}

	private async renameSessionTo(nextNameRaw: string): Promise<boolean> {
		const nextName = nextNameRaw.trim();
		if (!nextName) return false;
		try {
			if (this.onRenameCurrentSession) {
				const handled = await this.onRenameCurrentSession(nextName);
				if (handled) {
					this.pushNotice(t("chatView.session.renamed"), "success");
					return true;
				}
			}
			await rpcBridge.setSessionName(nextName);
			await this.refreshFromBackend();
			this.pushNotice(t("chatView.session.renamed"), "success");
			return true;
		} catch (err) {
			this.pushNotice(t("chatView.session.renameFailed"), "error");
			return false;
		}
	}

	async renameSession(): Promise<void> {
		const current = this.state?.sessionName || "";
		const next = await promptDialog({ title: t("chatView.session.namePrompt"), value: current });
		if (!next || !next.trim()) return;
		await this.renameSessionTo(next.trim());
	}

	async openForkPicker(): Promise<void> {
		this.openHistoryViewerForFork({
			loading: false,
			sessionName: this.state?.sessionName ?? null,
		});
	}

	private async forkFrom(entryId: string, options: { successNotice?: string } = {}): Promise<void> {
		const sourceSessionName = this.historyViewerSessionLabel.trim() || this.state?.sessionName?.trim() || "";
		const sourceSessionPath = this.state?.sessionFile ?? null;
		const forkSessionName = deriveForkSessionName(sourceSessionName);
		try {
			const result = await rpcBridge.fork(entryId);
			if (!result.cancelled) {
				try {
					await rpcBridge.setSessionName(forkSessionName);
				} catch (renameErr) {
					console.warn("Failed to rename fork session:", renameErr);
				}
			}
			if (!result.cancelled && result.text) {
				this.setInputText(result.text);
			}
			await this.refreshFromBackend();
			if (!result.cancelled) {
				// fork 已把当前 runtime 切到分支会话文件：通知外层把原会话保留成独立标签页，
				// 让分叉结果以「原会话 + 分支会话」两个 tab 呈现和管理。
				this.onSessionForked?.({
					sourceSessionPath,
					sourceTitle: sourceSessionName || null,
					forkedSessionPath: this.state?.sessionFile ?? null,
				});
			}
			this.pushNotice(result.cancelled ? t("chatView.fork.cancelled") : (options.successNotice ?? t("chatView.fork.ready")), "success");
			if (this.historyViewerMode === "fork") {
				this.closeHistoryViewer();
			}
		} catch (err) {
			console.error("Failed to fork:", err);
			this.pushNotice(t("chatView.fork.failed"), "error");
		}
	}

	/**
	 * 把时间线上的用户消息映射到 pi 的 entryId。
	 *
	 * 背景：pi 0.81.1 的 get_messages 返回的 AgentMessage（UserMessage 等）
	 * 本身没有 id 字段（见 pi-ai types.d.ts），无法直接透传 entryId。
	 * 这里点击时实时调用 get_fork_messages（pi 侧 getUserMessagesForForking，
	 * 按会话文件顺序返回全部 user 消息的 entryId+text），再按
	 * 「空白归一化后的文本 + 出现次序」与时间线 user 消息对齐
	 * （buildForkEntryIdByMessageId，与历史树分叉同一套算法）。
	 * 当前分支的消息是文件顺序的子序列，因此按序对齐是稳定的。
	 */
	private async resolveForkEntryIdForMessage(msg: UiMessage): Promise<string | null> {
		try {
			const options = await rpcBridge.getForkMessages();
			const map = buildForkEntryIdByMessageId(this.messages, options);
			return map.get(msg.id) ?? msg.sessionEntryId ?? null;
		} catch (err) {
			console.error("Failed to resolve fork entry:", err);
			return null;
		}
	}

	private async forkUserMessageFromTimeline(msg: UiMessage): Promise<void> {
		if (this.resolvingMessageAction) return;
		this.resolvingMessageAction = true;
		try {
			const entryId = await this.resolveForkEntryIdForMessage(msg);
			if (!entryId) {
				this.pushNotice(t("chatView.fork.entryUnresolved"), "error");
				return;
			}
			await this.forkFrom(entryId, { successNotice: t("chatView.fork.done") });
		} finally {
			this.resolvingMessageAction = false;
		}
	}

	/**
	 * 点用户消息的「编辑并重发」：先解析出该消息对应的 entryId，
	 * 然后气泡就地变成编辑器（预填原文），全程不碰底部 composer。
	 * 同一时间只允许一个编辑态：再次点击会直接覆盖旧编辑态。
	 */
	private async startEditResendFromTimeline(msg: UiMessage): Promise<void> {
		if (this.resolvingMessageAction) return;
		if (this.currentIsStreaming()) {
			this.pushNotice(t("chatView.rewrite.streamingBlocked"), "info");
			return;
		}
		this.resolvingMessageAction = true;
		try {
			// Destructive same-session rewrites must use the exact persisted ID.
			// Never fall back to text/occurrence matching as explicit forks do.
			const entryId = msg.sessionEntryId?.trim() ?? "";
			if (!entryId) {
				this.pushNotice(t("chatView.rewrite.entryUnresolved"), "error");
				return;
			}
			this.timelineEditMessageId = msg.id;
			this.timelineEditEntryId = entryId;
			this.timelineEditDraft = msg.text || "";
			this.render();
			this.focusTimelineEditInput();
		} finally {
			this.resolvingMessageAction = false;
		}
	}

	private clearTimelineMessageEditing(): void {
		this.timelineEditMessageId = null;
		this.timelineEditEntryId = null;
		this.timelineEditDraft = "";
	}

	private cancelTimelineMessageEditing(): void {
		if (!this.timelineEditMessageId) return;
		this.clearTimelineMessageEditing();
		this.render();
	}

	private getTimelineEditTextarea(): HTMLTextAreaElement | null {
		return this.container.querySelector(".user-bubble-editing .user-edit-input") as HTMLTextAreaElement | null;
	}

	private focusTimelineEditInput(): void {
		requestAnimationFrame(() => {
			const textarea = this.getTimelineEditTextarea();
			if (!textarea) return;
			this.autosizeTimelineEditInput(textarea);
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		});
	}

	private autosizeTimelineEditInput(textarea: HTMLTextAreaElement): void {
		textarea.style.height = "auto";
		// 与 .user-edit-input 的 max-height 一致（已是 220）。
		textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
	}

	private handleTimelineEditInput(event: Event): void {
		const textarea = event.currentTarget as HTMLTextAreaElement | null;
		if (!textarea) return;
		this.timelineEditDraft = textarea.value;
		this.autosizeTimelineEditInput(textarea);
		// render 让「发送」禁用态跟随输入刷新；.value 绑定值与当前相同，不会重置光标。
		this.render();
	}

	private handleTimelineEditKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || event.keyCode === 229) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.cancelTimelineMessageEditing();
			return;
		}
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void this.sendTimelineEditResend();
		}
	}

	private applyCommittedRewriteLocally(messageId: string): void {
		const messageIndex = this.messages.findIndex((message) => message.id === messageId);
		if (messageIndex >= 0) {
			this.messages = this.messages.slice(0, messageIndex);
		}
		this.clearTimelineMessageEditing();
	}

	private async rewriteTimelineBeforeUserEntry(entryId: string): Promise<SessionRewriteResult> {
		if (this.queuedComposerMessages.length > 0 || this.offlineQueueFlushInFlight) {
			throw new Error(t("chatView.rewrite.queuedBlocked"));
		}
		if (
			this.inputText.trim().length > 0 ||
			this.pendingImages.length > 0 ||
			this.pendingFileReferences.length > 0 ||
			this.selectedSkillDraft !== null
		) {
			throw new Error(t("chatView.rewrite.composerBlocked"));
		}
		const sourceSessionName = this.state?.sessionName?.trim() || "";
		const result = await rpcBridge.rewriteSessionBeforeUserEntry(entryId);
		if (sourceSessionName) {
			try {
				await rpcBridge.setSessionName(sourceSessionName);
			} catch (renameErr) {
				console.warn("Failed to restore session name after rewrite:", renameErr);
				this.pushNotice(t("chatView.rewrite.nameRestoreFailed"), "info");
			}
		}
		try {
			await this.refreshFromBackend({ throwOnError: true });
		} catch (refreshError) {
			const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
			throw new SessionRewriteCommittedError(result, `会话历史已改写，但刷新界面失败：${message}`);
		}
		return result;
	}

	/**
	 * Edit one persisted user turn in place: atomically truncate the current
	 * session immediately before that turn, restart the same file, then submit
	 * the edited text and original images as the replacement turn.
	 */
	private async sendTimelineEditResend(): Promise<void> {
		const messageId = this.timelineEditMessageId;
		const entryId = this.timelineEditEntryId;
		if (!messageId || !entryId) return;
		if (this.currentIsStreaming()) {
			this.pushNotice(t("chatView.rewrite.streamingBlocked"), "info");
			return;
		}
		const draft = this.timelineEditDraft;
		const text = draft.trim();
		// Rebuild refreshes the timeline, so preserve attachments before rewrite.
		const sourceAttachments = this.cloneImages(this.messages.find((m) => m.id === messageId)?.attachments);
		if (!text && sourceAttachments.length === 0) return;

		this.clearTimelineMessageEditing();
		this.resolvingMessageAction = true;
		try {
			await this.rewriteTimelineBeforeUserEntry(entryId);
		} catch (err) {
			console.error("Failed to rewrite for edit-resend:", err);
			if (err instanceof SessionRewriteCommittedError) {
				this.applyCommittedRewriteLocally(messageId);
				this.pendingFileReferences = [];
				this.inputText = text;
				this.pendingImages = sourceAttachments;
				this.render();
				this.syncComposerTextareaDeferred(text, {
					maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT,
					moveCaretToEnd: true,
					focus: true,
				});
				this.pushNotice(
					t("chatView.rewrite.committedRecoveryFailed", { reason: err.message }),
					"error",
				);
				return;
			}
			this.pushNotice(
				t("chatView.rewrite.failed", { reason: err instanceof Error ? err.message : String(err) }),
				"error",
			);
			this.timelineEditMessageId = messageId;
			this.timelineEditEntryId = entryId;
			this.timelineEditDraft = draft;
			this.render();
			this.focusTimelineEditInput();
			return;
		} finally {
			this.resolvingMessageAction = false;
		}

		// Same session, same title; this prompt replaces the removed turn.
		this.pendingFileReferences = [];
		this.inputText = text;
		this.pendingImages = sourceAttachments;
		await this.sendMessage("prompt", { restoreComposerOnFailure: true });
	}

	openHistoryViewer(options?: { query?: string }): void {
		this.historyViewerOpen = true;
		this.historyViewerMode = "browse";
		this.historyViewerLoading = true;
		this.historyViewerSessionLabel = "";
		this.historyTreeRows = [];
		this.historyQuery = options?.query?.trim() ?? "";
		this.historyRoleFilter = "all";
		this.render();
		void this.loadSessionTreeForHistory();
	}

	openHistoryViewerForFork(options?: { loading?: boolean; sessionName?: string | null; query?: string }): void {
		this.historyViewerOpen = true;
		this.historyViewerMode = "fork";
		this.historyViewerLoading = options?.loading ?? false;
		this.historyViewerSessionLabel = options?.sessionName?.trim() || this.state?.sessionName?.trim() || "";
		this.historyQuery = options?.query?.trim() ?? "";
		this.historyRoleFilter = "all";
		this.forkOptions = [];
		this.render();
		if (!this.historyViewerLoading) {
			void this.loadForkTargetsForHistory();
		}
	}

	private closeHistoryViewer(): void {
		closeAllSettingsSelects();
		this.historyViewerOpen = false;
		this.historyViewerMode = "browse";
		this.historyViewerLoading = false;
		this.historyViewerSessionLabel = "";
		this.historyTreeRows = [];
		this.historyTreeRequestSeq += 1;
		this.historyQuery = "";
		this.historyRoleFilter = "all";
		this.forkOptions = [];
		this.forkEntryIdByMessageId.clear();
		this.render();
	}

	private async loadForkTargetsForHistory(): Promise<void> {
		if (this.historyViewerMode !== "fork") return;
		const requestId = ++this.forkTargetsRequestSeq;
		this.historyViewerLoading = true;
		this.render();
		try {
			const options = await rpcBridge.getForkMessages();
			if (requestId !== this.forkTargetsRequestSeq || this.historyViewerMode !== "fork") return;
			this.forkOptions = options;
			this.forkEntryIdByMessageId = buildForkEntryIdByMessageId(this.messages, options);
		} catch (err) {
			if (requestId !== this.forkTargetsRequestSeq || this.historyViewerMode !== "fork") return;
			console.error("Failed to load fork points:", err);
			this.pushNotice(t("chatView.fork.loadPointsFailed"), "error");
			this.forkOptions = [];
			this.forkEntryIdByMessageId.clear();
		} finally {
			if (requestId !== this.forkTargetsRequestSeq || this.historyViewerMode !== "fork") return;
			this.historyViewerLoading = false;
			this.render();
		}
	}

	private revealMessage(messageId: string): void {
		const escaped = (window as any).CSS?.escape ? (window as any).CSS.escape(messageId) : messageId;
		const target = this.container.querySelector(`[data-message-id="${escaped}"]`) as HTMLElement | null;
		if (!target) return;
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		this.closeHistoryViewer();
	}

	private thinkingContentElement(messageId: string): HTMLElement | null {
		const escaped = (window as any).CSS?.escape ? (window as any).CSS.escape(messageId) : messageId;
		return this.container.querySelector(`[data-thinking-for="${escaped}"]`) as HTMLElement | null;
	}

	toggleThinkingBlocks(): void {
		this.allThinkingExpanded = !this.allThinkingExpanded;
		for (const message of this.messages) {
			if (message.role === "assistant" && message.thinking) {
				message.thinkingExpanded = this.allThinkingExpanded;
			}
		}
		this.render();
	}

	private isNearChatBottom(target: HTMLElement, threshold = 84): boolean {
		return target.scrollHeight - target.scrollTop - target.clientHeight <= threshold;
	}

	private handleChatScroll(event: Event): void {
		const target = event.currentTarget as HTMLElement | null;
		if (!target) return;
		const nextFollow = this.isNearChatBottom(target);
		if (this.autoFollowChat !== nextFollow) {
			this.autoFollowChat = nextFollow;
			this.render();
		}
		// 滚动接近顶部时自动向上翻页（loadOlderHistory 自带并发/hasMore 守卫）。
		if (target.scrollTop <= 120) {
			void this.loadOlderHistory();
		}
	}

	private jumpToLatest(): void {
		this.autoFollowChat = true;
		this.scrollToBottom(true);
		this.render();
	}

	private renderJumpToLatest(): TemplateResult | typeof nothing {
		if (this.autoFollowChat) return nothing;
		return html`
			<button class="chat-jump-latest" aria-label=${t("chatView.jump.latest")} title=${t("chatView.jump.latest")} @click=${() => this.jumpToLatest()}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v7.9"></path><path d="M5.2 8.3L8 11.1l2.8-2.8"></path></svg>
			</button>
		`;
	}

	private cancelScheduledSessionScroll(): void {
		if (this.sessionScrollFrame !== null) {
			cancelAnimationFrame(this.sessionScrollFrame);
			this.sessionScrollFrame = null;
		}
		if (this.sessionScrollSettleFrame !== null) {
			cancelAnimationFrame(this.sessionScrollSettleFrame);
			this.sessionScrollSettleFrame = null;
		}
	}

	/**
	 * 会话切换落底使用双 RAF：第一次等待历史 DOM 提交，第二次吸收 markdown /
	 * composer 尺寸在下一帧产生的布局变化。全程只改 scrollTop，不转移焦点。
	 */
	private scheduleSessionScrollToLatest(generation: number): void {
		if (generation !== this.sessionScrollGeneration) return;
		this.cancelScheduledSessionScroll();
		this.autoFollowChat = true;
		this.sessionScrollFrame = requestAnimationFrame(() => {
			this.sessionScrollFrame = null;
			if (generation !== this.sessionScrollGeneration || !this.scrollContainer) return;
			this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
			this.sessionScrollSettleFrame = requestAnimationFrame(() => {
				this.sessionScrollSettleFrame = null;
				if (generation !== this.sessionScrollGeneration || !this.scrollContainer) return;
				this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
			});
		});
	}

	private scrollToBottom(force = false): void {
		const shouldFollow = force || this.autoFollowChat;
		if (!shouldFollow) return;
		// 合帧：流式事件每条都调这里，旧写法每次单独排一个 rAF，高频下同一帧里
		// 堆出几十上百个回调，每个都读 scrollHeight 触发同步布局。渲染已经降频了，
		// 滚动也必须跟上，否则 layout 成为新的主线程瓶颈。
		if (this.scrollToBottomRaf !== null) return;
		this.scrollToBottomRaf = requestAnimationFrame(() => {
			this.scrollToBottomRaf = null;
			if (!this.scrollContainer) return;
			this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
		});
	}

	private updateComposerOffset(): void {
		const chatRoot = this.container.querySelector<HTMLElement>(".chat-root");
		if (!chatRoot) return;
		const composer = this.container.querySelector<HTMLElement>(".composer-shell");
		if (!this.projectPath || !composer) {
			chatRoot.style.setProperty("--composer-offset", "196px");
			// 同步到 :root：扩展 widget 槽位是 fixed 且挂在 body 上，继承不到
			// .chat-root 上的变量。
			document.documentElement.style.setProperty("--composer-offset", "196px");
			this.composerOffsetPx = 196;
			this.composerResizeObserver?.disconnect();
			this.composerResizeObserver = null;
			this.observedComposerElement = null;
			return;
		}

		const apply = () => {
			const measured = Math.max(140, Math.ceil(composer.getBoundingClientRect().height) + 18);
			if (Math.abs(measured - this.composerOffsetPx) < 2) return;
			this.composerOffsetPx = measured;
			chatRoot.style.setProperty("--composer-offset", `${measured}px`);
			document.documentElement.style.setProperty("--composer-offset", `${measured}px`);
			if (this.autoFollowChat) this.scrollToBottom();
		};

		apply();
		if (!this.composerResizeObserver) {
			this.composerResizeObserver = new ResizeObserver(() => apply());
		}
		if (this.observedComposerElement !== composer) {
			this.composerResizeObserver.disconnect();
			this.composerResizeObserver.observe(composer);
			this.observedComposerElement = composer;
		}
	}

	private renderNotices(): TemplateResult | typeof nothing {
		if (this.notices.length === 0) return nothing;
		return html`
			<div class="absolute top-4 right-4 z-30 flex flex-col gap-2 max-w-sm pointer-events-none">
				${this.notices.map((notice) => {
					const cls =
						notice.kind === "error"
							? "bg-red-500/95"
							: notice.kind === "success"
								? "bg-emerald-500/95"
								: "bg-zinc-800/95";
					return html`<div class="rounded-xl px-3 py-2 text-xs text-white shadow-xl backdrop-blur ${cls}">${notice.text}</div>`;
				})}
			</div>
		`;
	}

	private currentWorkingPhrase(): string {
		const candidate = this.workingStatusPhrases[this.workingStatusPhraseIndex] ?? t("chatView.working.fallback");
		const normalized = candidate.trim();
		return normalized.length > 0 ? normalized : t("chatView.working.fallback");
	}

	private currentWorkingLabel(): string {
		const phrase = this.currentWorkingPhrase();
		const count = Math.max(1, Math.min(this.workingStatusCharCount, phrase.length));
		return phrase.slice(0, count);
	}

	private clearWorkingStatusTimer(reset = false): void {
		if (this.workingStatusTimer) {
			clearTimeout(this.workingStatusTimer);
		}
		this.workingStatusTimer = null;
		if (!reset) return;
		this.workingStatusPhraseIndex = 0;
		this.workingStatusPhase = "typing";
		this.workingStatusCharCount = 0;
	}

	private hasRunningWorkflowElapsedTime(): boolean {
		if (this.compactionCycle?.status === "running") return true;
		const hasActiveWorkflow = this.messages.some(
			(message) =>
				message.role === "assistant" &&
				(Boolean((message.thinking ?? "").trim()) ||
					message.toolCalls.some((toolCall) => Boolean(toolCall.startedAt))),
		);
		return hasActiveWorkflow && this.currentIsStreaming();
	}

	private clearWorkflowElapsedTicker(): void {
		if (this.workflowElapsedTimer) {
			clearInterval(this.workflowElapsedTimer);
		}
		this.workflowElapsedTimer = null;
	}

	/** 全时间线共用一个秒级 ticker；结束或离开会话后立即释放。 */
	private syncWorkflowElapsedTicker(): void {
		if (!this.hasRunningWorkflowElapsedTime()) {
			this.clearWorkflowElapsedTicker();
			return;
		}
		if (this.workflowElapsedTimer) return;
		this.workflowElapsedTimer = setInterval(() => {
			if (!this.hasRunningWorkflowElapsedTime()) {
				this.clearWorkflowElapsedTicker();
				return;
			}
			this.render();
		}, 1000);
	}

	private scheduleWorkingStatusTick(delayMs: number): void {
		this.clearWorkingStatusTimer(false);
		this.workingStatusTimer = setTimeout(() => {
			this.workingStatusTimer = null;
			this.stepWorkingStatusText();
		}, delayMs);
	}

	private stepWorkingStatusText(): void {
		if (!this.shouldShowWorkingIndicator()) {
			this.clearWorkingStatusTimer(true);
			return;
		}

		const phrase = this.currentWorkingPhrase();
		let nextDelay = 320;
		if (this.workingStatusPhase === "typing") {
			this.workingStatusCharCount = Math.min(phrase.length, this.workingStatusCharCount + 1);
			if (this.workingStatusCharCount >= phrase.length) {
				this.workingStatusPhase = "hold";
				nextDelay = 4600;
			} else {
				nextDelay = 130 + Math.floor(Math.random() * 80);
			}
			this.render();
		} else {
			this.workingStatusPhase = "typing";
			this.workingStatusPhraseIndex = (this.workingStatusPhraseIndex + 1) % this.workingStatusPhrases.length;
			this.workingStatusCharCount = 0;
			nextDelay = 920;
			this.render();
		}

		this.scheduleWorkingStatusTick(nextDelay);
	}

	private syncWorkingStatusAnimation(): void {
		if (this.shouldShowWorkingIndicator()) {
			if (!this.workingStatusTimer) {
				this.scheduleWorkingStatusTick(320);
			}
			return;
		}
		this.clearWorkingStatusTimer(true);
	}

	private renderWorkingChip(): TemplateResult {
		return html`
			<div class="chat-working-indicator" aria-label=${t("chatView.working.ariaLabel")} title=${t("chatView.working.ariaLabel")}>
				<span class="chat-working-pi" aria-hidden="true">${piGlyphIcon()}</span>
				<span class="chat-working-text">
					<span class="chat-working-label">${this.currentWorkingLabel()}</span>
					<span class="chat-working-dots">...</span>
				</span>
			</div>
		`;
	}

	private hasExpandedWorkflowInTimeline(): boolean {
		for (let index = 0; index < this.messages.length; index += 1) {
			const msg = this.messages[index];
			if (msg.role !== "assistant") continue;
			const workflowCandidate = this.collectAssistantWorkflow(index);
			if (!workflowCandidate) continue;
			const { expanded } = this.resolveWorkflowExpansionState(
				workflowCandidate.workflow.id,
				workflowCandidate.workflow.toolCalls,
				workflowCandidate.workflow.isTerminal,
			);
			if (expanded) return true;
			index = workflowCandidate.nextIndex - 1;
		}
		return false;
	}

	private shouldShowWorkingIndicator(): boolean {
		if (!this.currentIsStreaming()) return false;
		if (this.hasExpandedWorkflowInTimeline()) return false;
		return !this.runHasAssistantText;
	}

	private renderWorkingIndicatorRow(): TemplateResult {
		return html`
			<div class="chat-row assistant-row working-row">
				<div class="message-shell assistant-message-shell">
					<div class="assistant-block">${this.renderWorkingChip()}</div>
				</div>
			</div>
		`;
	}

	private renderUserMessage(msg: UiMessage): TemplateResult {
		// 「编辑并重发」就地编辑态：该消息气泡就地变成编辑器，不渲染普通气泡与操作按钮。
		if (this.timelineEditMessageId === msg.id) {
			return renderUserMessageEditRow({
				message: msg,
				draft: this.timelineEditDraft,
				canSend: this.timelineEditDraft.trim().length > 0 || (msg.attachments?.length ?? 0) > 0,
				onEditInput: (event) => this.handleTimelineEditInput(event),
				onEditKeyDown: (event) => this.handleTimelineEditKeyDown(event),
				onEditCancel: () => this.cancelTimelineMessageEditing(),
				onEditSend: () => void this.sendTimelineEditResend(),
			});
		}
		return html`
			<div class="chat-row user-row" data-message-id=${msg.id}>
				<div class="message-shell user-message-shell">
					<div class="bubble user-bubble">
						${msg.deliveryMode === "steer" ? html`<div class="bubble-chip">${t("chatView.message.steer")}</div>` : nothing}
						${msg.text ? html`<div class="bubble-text">${msg.text}</div>` : nothing}
						${msg.attachments && msg.attachments.length > 0
							? html`
								<div class="attachment-grid">
									${msg.attachments.map(
										(img) => html`
											<div
												class="attachment-item"
												title=${img.name}
												role="button"
												tabindex="0"
												aria-label=${img.name}
												@click=${() => this.previewImages(msg.attachments, img.id)}
												@keydown=${(event: KeyboardEvent) => {
													if (event.key !== "Enter" && event.key !== " ") return;
													event.preventDefault();
													this.previewImages(msg.attachments, img.id);
												}}
											>
												<img src=${img.previewUrl} alt=${img.name} draggable="false" />
											</div>
										`,
									)}
								</div>
							`
							: nothing}
					</div>
					<div class="message-actions">
						${msg.text.trim().length > 0
							? html`
								<button class="message-action-btn icon" title=${t("chatView.message.fork")} @click=${() => void this.forkUserMessageFromTimeline(msg)}>${uiIcon("fork")}</button>
							`
							: nothing}
						${msg.text.trim().length > 0 || (msg.attachments?.length ?? 0) > 0
							? html`
								<button class="message-action-btn icon" title=${t("chatView.message.editResend")} @click=${() => void this.startEditResendFromTimeline(msg)}>${uiIcon("edit")}</button>
								<button class="message-action-btn icon" title=${t("chatView.message.withdraw")} @click=${() => void this.withdrawUserMessage(msg)}>${uiIcon("retry")}</button>
							`
							: nothing}
						<button class="message-action-btn icon" title=${t("chatView.message.copy")} @click=${() => this.copyMessage(msg)}>${uiIcon("copy")}</button>
					</div>
				</div>
			</div>
		`;
	}

	private normalizeThinkingText(value: string): string {
		return normalizeThinkingText(value);
	}

	private isStandaloneCodeBlockMarkdown(value: string): boolean {
		return isStandaloneCodeBlockMarkdown(value);
	}

	private renderThinking(msg: UiMessage): TemplateResult | typeof nothing {
		if (!msg.thinking) return nothing;
		const expanded = msg.thinkingExpanded ?? false;
		const label = t("chatView.thinking.label");
		const toggleClass = `thinking-toggle ${msg.isStreaming ? "animating" : "done"}`;
		const thinkingText = this.normalizeThinkingText(msg.thinking.replace(/^\s+/, ""));
		if (!thinkingText) return nothing;
		return html`
			<div class="thinking-block ${expanded ? "expanded" : ""}">
				<button
					type="button"
					class=${toggleClass}
					aria-expanded=${expanded ? "true" : "false"}
					aria-label=${t("chatView.thinking.toggle")}
					title=${t("chatView.thinking.toggle")}
					@click=${() => {
						if (expanded) {
							const content = this.thinkingContentElement(msg.id);
							if (content) msg.thinkingScrollTop = content.scrollTop;
						}
						this.autoFollowChat = false;
						msg.thinkingExpanded = !expanded;
						this.render();
						if (!expanded) {
							requestAnimationFrame(() => {
								const content = this.thinkingContentElement(msg.id);
								if (!content) return;
								content.scrollTop = msg.thinkingScrollTop ?? 0;
							});
						}
					}}
				>
					${label.split("").map((char, index) => html`<span class="thinking-char" style=${`--thinking-char-index:${index};`}>${char}</span>`)}
				</button>
				<div
					class="thinking-content"
					data-thinking-for=${msg.id}
					@scroll=${(event: Event) => {
						msg.thinkingScrollTop = (event.currentTarget as HTMLElement).scrollTop;
					}}
				>${thinkingText}</div>
			</div>
		`;
	}

	private summarizeToolCall(tc: ToolCallBlock): string {
		return summarizeToolCall(tc, truncate);
	}

	private isToolWorkflowExpanded(workflowId: string): boolean {
		return this.expandedToolWorkflowIds.has(workflowId);
	}

	private clearWorkflowThinkingExpansion(workflowId: string): void {
		for (const thinkingId of Array.from(this.expandedWorkflowThinkingIds)) {
			if (thinkingId.startsWith(`${workflowId}:thinking:`)) {
				this.expandedWorkflowThinkingIds.delete(thinkingId);
			}
		}
	}

	private toggleToolWorkflowExpanded(workflowId: string, autoExpanded = false, currentlyExpanded = false): void {
		if (currentlyExpanded) {
			this.expandedToolWorkflowIds.delete(workflowId);
			this.expandedToolGroupByWorkflowId.delete(workflowId);
			this.clearWorkflowThinkingExpansion(workflowId);
			if (autoExpanded) {
				this.collapsedAutoWorkflowIds.add(workflowId);
			}
		} else {
			this.expandedToolWorkflowIds.add(workflowId);
			this.collapsedAutoWorkflowIds.delete(workflowId);
		}
		this.render();
	}

	private isWorkflowThinkingExpanded(thinkingId: string): boolean {
		return this.expandedWorkflowThinkingIds.has(thinkingId);
	}

	private toggleWorkflowThinkingExpanded(thinkingId: string): void {
		if (this.expandedWorkflowThinkingIds.has(thinkingId)) {
			this.expandedWorkflowThinkingIds.delete(thinkingId);
		} else {
			this.expandedWorkflowThinkingIds.add(thinkingId);
		}
		this.render();
	}

	private isToolGroupExpanded(workflowId: string, groupId: string): boolean {
		return this.expandedToolGroupByWorkflowId.get(workflowId) === groupId;
	}

	private toggleToolGroupExpanded(workflowId: string, groupId: string): void {
		if (this.expandedToolGroupByWorkflowId.get(workflowId) === groupId) {
			this.expandedToolGroupByWorkflowId.delete(workflowId);
		} else {
			this.expandedToolGroupByWorkflowId.set(workflowId, groupId);
		}
		this.render();
	}

	private renderToolPreview(preview: string): TemplateResult {
		const match = preview.match(/^(Edited|Wrote)\s+(.+)$/);
		if (!match) return html`${preview}`;
		const [, verb, target] = match;
		const verbLabel = verb === "Edited" ? t("chatView.tool.edited") : t("chatView.tool.wrote");
		return html`${verbLabel} <span class="tool-file-target">${target}</span>`;
	}

	private collectAssistantWorkflow(startIndex: number): AssistantWorkflowCandidate | null {
		return collectAssistantWorkflow({
			messages: this.messages,
			startIndex,
			currentIsStreaming: this.currentIsStreaming(),
			runHasAssistantText: this.runHasAssistantText,
			fallbackStartedAt: this.runStartedAt,
			truncateText: truncate,
		});
	}

	private resolveWorkflowExpansionState(
		workflowId: string,
		toolCalls: ToolCallBlock[],
		isTerminal: boolean,
	): {
		total: number;
		running: number;
		autoExpanded: boolean;
		expanded: boolean;
	} {
		return resolveWorkflowExpansionState({
			workflowId,
			toolCalls,
			isTerminal,
			keepWorkflowExpandedUntilAssistantText: this.keepWorkflowExpandedUntilAssistantText,
			runSawToolActivity: this.runSawToolActivity,
			expandedWorkflowIds: this.expandedToolWorkflowIds,
			collapsedAutoWorkflowIds: this.collapsedAutoWorkflowIds,
		});
	}

	private renderAssistantWorkflow(workflow: AssistantWorkflow): TemplateResult {
		return renderAssistantWorkflowView({
			workflow,
			resolveWorkflowExpansionState: (workflowId, toolCalls, isTerminal) =>
				this.resolveWorkflowExpansionState(workflowId, toolCalls, isTerminal),
			normalizeThinkingText: (value) => this.normalizeThinkingText(value),
			summarizeToolCall: (toolCall) => this.summarizeToolCall(toolCall),
			renderToolPreview: (preview) => this.renderToolPreview(preview),
			formatDuration,
			isWorkflowThinkingExpanded: (thinkingId) => this.isWorkflowThinkingExpanded(thinkingId),
			toggleWorkflowThinkingExpanded: (thinkingId) => this.toggleWorkflowThinkingExpanded(thinkingId),
			isToolGroupExpanded: (workflowId, groupId) => this.isToolGroupExpanded(workflowId, groupId),
			toggleToolGroupExpanded: (workflowId, groupId) => this.toggleToolGroupExpanded(workflowId, groupId),
			toggleToolWorkflowExpanded: (workflowId, autoExpanded, currentlyExpanded) =>
				this.toggleToolWorkflowExpanded(workflowId, autoExpanded, currentlyExpanded),
			clearCollapsedWorkflowState: (workflowId) => {
				this.expandedToolGroupByWorkflowId.delete(workflowId);
				this.clearWorkflowThinkingExpansion(workflowId);
			},
			piGlyphIcon,
		});
	}

	private renderMessageTimeline(): TemplateResult[] {
		return renderMessageTimelineRows({
			messages: this.messages,
			compactionCycle: this.compactionCycle,
			compactionInsertIndex: this.compactionInsertIndex,
			collectAssistantWorkflow: (index) => this.collectAssistantWorkflow(index),
			renderAssistantWorkflow: (workflow) => this.renderAssistantWorkflow(workflow),
			renderUserMessage: (message) => this.renderUserMessage(message),
			hasRenderableAssistantContent: (message) => this.hasRenderableAssistantContent(message),
			renderAssistantMessage: (message) => this.renderAssistantMessage(message),
			renderChangelogMessage: (message) => this.renderChangelogMessage(message),
			renderSystemMessage: (message) => this.renderSystemMessage(message),
			renderCompactionCycle: () => this.renderCompactionCycle(),
		});
	}

	private renderAssistantMessage(msg: UiMessage): TemplateResult {
		return renderAssistantMessageRow({
			message: msg,
			renderThinking: (message) => this.renderThinking(message),
			isStandaloneCodeBlockMarkdown: (value) => this.isStandaloneCodeBlockMarkdown(value),
			copyIcon: uiIcon("copy"),
			onCopyMessage: (message) => this.copyMessage(message),
		});
	}

	private renderSystemMessage(msg: UiMessage): TemplateResult {
		return renderSystemMessageRow({ message: msg });
	}

	private renderChangelogMessage(msg: UiMessage): TemplateResult {
		return renderChangelogMessageRow({
			message: msg,
			onToggleExpanded: (message, nextExpanded) => {
				message.collapsibleExpanded = nextExpanded;
				this.render();
			},
		});
	}

	private renderCompactionCycle(): TemplateResult | typeof nothing {
		return renderCompactionCycleRow({
			cycle: this.compactionCycle,
			piGlyphIcon,
			onToggleExpanded: (nextExpanded) => {
				if (!this.compactionCycle) return;
				this.compactionCycle.expanded = nextExpanded;
				this.render();
			},
		});
	}

	private renderBindingState(): TemplateResult {
		// 骨架屏占位（Codex 风）：比整屏文案感知更快，状态文字保留在 composer。
		return html`
			<div class="chat-loading-skeleton" role="status" aria-label=${this.bindingStatusText ?? t("chatView.session.loading")}>
				<div class="skeleton-row skeleton-row-assistant">
					<span class="skeleton-bar" style="width: 72%"></span>
					<span class="skeleton-bar" style="width: 48%"></span>
				</div>
				<div class="skeleton-row skeleton-row-user">
					<span class="skeleton-bar" style="width: 34%"></span>
				</div>
				<div class="skeleton-row skeleton-row-assistant">
					<span class="skeleton-bar" style="width: 81%"></span>
					<span class="skeleton-bar" style="width: 63%"></span>
					<span class="skeleton-bar" style="width: 42%"></span>
				</div>
				<div class="skeleton-row skeleton-row-user">
					<span class="skeleton-bar" style="width: 27%"></span>
				</div>
				<div class="skeleton-row skeleton-row-assistant">
					<span class="skeleton-bar" style="width: 58%"></span>
				</div>
			</div>
		`;
	}

	private async refreshWelcomeDashboard(force = false): Promise<void> {
		if (this.welcomeDashboard.loading) return;
		if (!force && Date.now() - this.welcomeDashboard.updatedAt < 90_000) return;

		this.welcomeDashboard = {
			...this.welcomeDashboard,
			loading: true,
			error: null,
		};
		this.render();

		try {
			const inventory = await loadWelcomeDashboardInventory(() => rpcBridge.getCliUpdateStatus());
			this.welcomeDashboard = {
				loading: false,
				skills: inventory.skills,
				extensions: inventory.extensions,
				themes: inventory.themes,
				currentCliVersion: inventory.currentCliVersion,
				latestCliVersion: inventory.latestCliVersion,
				updateAvailable: inventory.updateAvailable,
				error: null,
				updatedAt: Date.now(),
			};
		} catch (err) {
			this.welcomeDashboard = {
				...this.welcomeDashboard,
				loading: false,
				error: err instanceof Error ? err.message : String(err),
				updatedAt: Date.now(),
			};
		}

		this.render();
	}

	private renderCenteredWelcome(): TemplateResult {
		const snapshot = this.welcomeDashboard;
		const brandIconUrl = new URL("../../assets/branding/pi-desktop-icon.svg", import.meta.url).href;
		const comparableProjectPath = normalizeComparablePath(this.projectPath);
		const activeProject =
			this.welcomeProjects.find((project) => project.id === this.welcomeActiveProjectId) ??
			this.welcomeProjects.find((project) => normalizeComparablePath(project.path) === comparableProjectPath) ??
			null;
		const hasProject = Boolean(activeProject || this.projectPath);
		const projectLabel = activeProject?.name ?? (this.projectPath ? this.fileNameFromPath(this.projectPath) : t("chatView.welcome.addProject"));

		return renderCenteredWelcomeView({
			brandIconUrl,
			projectLabel,
			hasProject,
			projectMenuOpen: this.welcomeProjectMenuOpen,
			projects: this.welcomeProjects,
			activeProjectId: activeProject?.id ?? null,
			snapshot,
			composer: this.renderComposerPanel(),
			onSuggestionClick: (promptText) => this.handleWelcomeSuggestionClick(promptText),
			onToggleProjectMenu: () => {
				this.welcomeProjectMenuOpen = !this.welcomeProjectMenuOpen;
				this.render();
			},
			onSelectProject: (projectId) => {
				this.welcomeProjectMenuOpen = false;
				if (projectId !== activeProject?.id) this.onSelectWelcomeProject?.(projectId);
			},
			onAddProject: () => {
				this.welcomeProjectMenuOpen = false;
				this.onAddProject?.();
			},
			onOpenPackages: () => {
				this.welcomeProjectMenuOpen = false;
				this.onOpenPackages?.();
			},
			onOpenSettings: () => {
				this.welcomeProjectMenuOpen = false;
				this.onOpenSettings?.();
			},
		});
	}

	/**
	 * welcome 建议卡片：把引导 prompt 填进 composer（不发送），与「重发」走同一条
	 * setInputText 路径。无项目时 composer 处于锁定态，先把文案放进去（inputText 跨
	 * 项目切换保留），再进入添加项目流程，项目就绪后即可直接发送。
	 */
	private handleWelcomeSuggestionClick(promptText: string): void {
		this.setInputText(promptText);
		if (!this.projectPath) {
			this.onAddProject?.();
		}
	}

	private async openComposerFilePicker(): Promise<void> {
		if (this.isComposerInteractionLocked()) return;
		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const selected = await open({
				multiple: true,
				directory: false,
				title: t("chatView.composer.attachFilesTitle"),
			});
			if (selected === null) return;
			const paths = this.dedupeDroppedPaths(
				(Array.isArray(selected) ? selected : [selected])
					.filter((value): value is string => typeof value === "string")
					.map((value) => value.trim())
					.filter(Boolean),
			);
			if (paths.length === 0) return;
			const imagePaths = paths.filter((path) => this.isImageName(this.fileNameFromPath(path)));
			const filePaths = paths.filter((path) => !this.isImageName(this.fileNameFromPath(path)));
			if (imagePaths.length > 0) {
				await this.prepareImagesFromPaths(imagePaths, { quietIfNone: true });
			}
			if (filePaths.length > 0) {
				this.appendDroppedPathReferences(filePaths);
			}
			return;
		} catch {
			// fallback to file input
		}
		const input = this.container.querySelector("#file-picker") as HTMLInputElement | null;
		input?.click();
	}

	private renderComposerControls(canSend: boolean, isStreaming: boolean, interactionLocked: boolean): TemplateResult {
		const { provider: currentProvider, modelId: currentModelId } = this.currentModelSelection();
		const currentModelValue = currentProvider && currentModelId ? `${currentProvider}::${currentModelId}` : "";
		const currentModelDisplay = currentModelId ? formatModelDisplayName(currentModelId) : t("chatView.model.selectModel");
		const currentProviderDisplay = currentProvider ? this.displayProviderLabel(currentProvider) : "";
		const currentModelTitle = currentProvider && currentModelId ? `${currentProviderDisplay} / ${currentModelId}` : t("chatView.model.selectModel");
		const thinkingValue = (this.state?.thinkingLevel ?? "off") as ThinkingLevel;
		const thinkingLabel = formatThinkingDisplayName(thinkingValue);

		// 只列出已配置（有 auth）的渠道；未配置的不再展示，改为弹层底部的「管理渠道…」入口。
		const providerGroups = buildModelPickerProviderGroups({
			availableModels: this.availableModels,
			modelCatalog: this.modelCatalog,
			currentProvider,
			currentModelId,
			providerAuthById: this.providerAuthById,
			providerAuthConfigured: this.providerAuthConfigured,
			providerAuthForcedLoggedOut: this.providerAuthForcedLoggedOut,
			oauthProviderCatalog: this.oauthProviderCatalog,
			getProviderLabel: (provider) => this.displayProviderLabel(provider),
		}).filter((group) => group.authConfigured);
		const resolvedActiveProvider = resolveActiveModelPickerProvider(
			providerGroups,
			this.modelPickerActiveProvider,
			currentProvider,
		);
		const activeProviderGroup = providerGroups.find((group) => group.providerKey === resolvedActiveProvider) ?? null;

		return renderComposerControlsView({
			canSend,
			isStreaming,
			interactionLocked,
			sendingPrompt: this.sendingPrompt,
			settingModel: this.settingModel,
			settingThinking: this.settingThinking,
			thinkingValue,
			thinkingAvailableLevels: this.availableThinkingLevelsForCurrentModel(),
			thinkingLabel,
			thinkingMenuOpen: this.thinkingMenuOpen,
			currentProvider,
			currentModelId,
			currentModelValue,
			currentModelTitle,
			currentModelDisplay,
			currentProviderDisplay,
			modelPickerOpen: this.modelPickerOpen,
			modelPickerSubmenuOpen: this.modelPickerSubmenuOpen,
			loadingModels: this.loadingModels,
			loadingModelCatalog: this.loadingModelCatalog,
			providerGroups,
			activeProviderGroup,
			resolvedActiveProvider,
			runningProviderAuthActionProvider: this.runningProviderAuthAction?.provider ?? null,
			plusIcon: uiIcon("plus"),
			stopIcon: uiIcon("stop"),
			spinnerIcon: uiIcon("spinner"),
			sendIcon: uiIcon("send"),
			addMenuOpen: this.addMenuOpen,
			addMenuSkills: this.addMenuSkills(),
			addMenuSkillsLoading: this.slashCommandsLoading,
			onToggleAddMenu: () => this.toggleAddMenu(),
			onCloseAddMenu: (options) => this.closeAddMenu(options),
			onAttachFile: () => this.openComposerFilePicker(),
			onSelectSkill: (name) => this.stageSkillFromAddMenu(name),
			onCloseModelPicker: (options) => this.closeModelPicker(options),
			onToggleModelPicker: (preferredProvider) => this.toggleModelPicker(preferredProvider),
			onSetModelPickerActiveProvider: (provider) => this.setModelPickerActiveProvider(provider),
			onPositionModelPickerSubmenu: () => this.positionModelPickerSubmenu(),
			onProviderAuthAction: (provider, action) => this.handleProviderAuthAction(provider, action),
			onSelectModel: (provider, modelId) => this.setModel(provider, modelId),
			onSetThinkingLevel: (value) => this.setThinkingLevel(value),
			onToggleThinkingMenu: () => this.toggleThinkingMenu(),
			onCloseThinkingMenu: (options) => this.closeThinkingMenu(options),
			onAbort: () => this.abortCurrentRun(),
			onSend: () => this.sendMessage("prompt"),
			onManageChannels: () => {
				this.closeModelPicker();
				this.onOpenSettings?.("channels");
			},
		});
	}


	private ensureActiveSlashItemVisible(): void {
		if (!this.slashPaletteOpen || this.slashPaletteNavigationMode !== "keyboard") return;
		requestAnimationFrame(() => {
			const menu = this.container.querySelector<HTMLElement>(".composer-slash-menu");
			const activeItem = this.container.querySelector<HTMLElement>(".composer-slash-item.active");
			if (!menu || !activeItem) return;
			activeItem.scrollIntoView({ block: "nearest" });
			const itemTop = activeItem.offsetTop;
			if (itemTop < menu.scrollTop + 4) {
				menu.scrollTop = Math.max(0, itemTop - 4);
			}
		});
	}

	private handleSlashPaletteMouseMove(event: MouseEvent): void {
		if (this.slashPaletteNavigationMode === "keyboard") {
			const moved = Math.abs(event.movementX) + Math.abs(event.movementY) > 0;
			if (!moved) return;
			this.slashPaletteNavigationMode = "pointer";
		}
		const target = event.target instanceof Element ? (event.target.closest(".composer-slash-item") as HTMLElement | null) : null;
		if (!target) return;
		const indexRaw = target.dataset.index;
		if (!indexRaw) return;
		const index = Number(indexRaw);
		if (!Number.isFinite(index)) return;
		if (this.slashPaletteIndex !== index) {
			this.slashPaletteIndex = index;
			this.render();
		}
	}

	private renderSlashPalette(items: SlashPaletteItem[]): TemplateResult | typeof nothing {
		return renderSlashPaletteView({
			open: this.slashPaletteOpen,
			loading: this.slashCommandsLoading,
			query: this.slashPaletteQuery,
			items,
			activeIndex: this.slashPaletteIndex,
			navigationMode: this.slashPaletteNavigationMode,
			onMouseMove: (event) => this.handleSlashPaletteMouseMove(event),
			onSelect: (item) => this.selectSlashPaletteItem(item),
		});
	}

	private setSessionStatsHover(next: boolean): void {
		if (this.sessionStatsHover === next) return;
		this.sessionStatsHover = next;
		this.render();
	}

	private handleComposerInput(event: Event, interactionLocked: boolean): void {
		handleComposerInputEvent({
			event,
			interactionLocked,
			slashPaletteOpenBefore: this.slashPaletteOpen,
			onSetInputText: (text) => {
				this.inputText = text;
			},
			onResetComposerHistoryNavigation: () => this.resetComposerHistoryNavigation(),
			onUpdateSlashPaletteStateFromInput: () => this.updateSlashPaletteStateFromInput(),
			onIsSlashPaletteOpen: () => this.slashPaletteOpen,
			onRender: () => this.render(),
			onComposerHeightChange: () => this.updateComposerOffset(),
		});
	}

	private handleComposerPaste(event: ClipboardEvent, interactionLocked: boolean): void {
		handleComposerPasteEvent({
			event,
			interactionLocked,
			onPrepareImages: (files) => this.prepareImages(files),
		});
	}

	private handleComposerDragOver(event: DragEvent, interactionLocked: boolean): void {
		handleComposerDragOverEvent({ event, interactionLocked });
	}

	private handleComposerDrop(event: DragEvent, interactionLocked: boolean): void {
		handleComposerDropEvent({
			event,
			interactionLocked,
			onHandleDroppedDataTransfer: (dataTransfer) => this.handleDroppedDataTransfer(dataTransfer),
		});
	}

	private handleComposerKeyDown(event: KeyboardEvent, interactionLocked: boolean, isStreaming: boolean): void {
		handleComposerKeyDownEvent({
			event,
			interactionLocked,
			isStreaming,
			modelPickerOpen: this.modelPickerOpen,
			inputText: this.inputText,
			hasSelectedSkillDraft: Boolean(this.selectedSkillDraft),
			slashPaletteOpen: this.slashPaletteOpen,
			composerHistoryIndex: this.composerHistoryIndex,
			onCloseModelPicker: () => this.closeModelPicker(),
			onRemoveSelectedSkillDraft: () => this.removeComposerSkillDraft(),
			onCycleThinkingLevel: (step) => this.cycleThinkingLevel(step),
			shouldHandleComposerHistoryKey: (ev, textarea, direction) => this.shouldHandleComposerHistoryKey(ev, textarea, direction),
			onNavigateComposerHistory: (direction) => this.navigateComposerHistory(direction),
			getSlashPaletteItems: () => this.getSlashPaletteItems(),
			onSetSlashPaletteNavigationMode: (mode) => {
				this.slashPaletteNavigationMode = mode;
			},
			getSlashPaletteIndex: () => this.slashPaletteIndex,
			onSetSlashPaletteIndex: (index) => {
				this.slashPaletteIndex = index;
			},
			onPreviewSlashPaletteItem: (item) => this.previewSlashPaletteItem(item),
			onRender: () => this.render(),
			onEnsureActiveSlashItemVisible: () => this.ensureActiveSlashItemVisible(),
			onCloseSlashPalette: () => this.closeSlashPalette(),
			slashQueryFromInput: () => this.slashQueryFromInput(),
			onExecuteSlashCommandFromComposer: () => this.executeSlashCommandFromComposer(),
			onSendMessage: (mode) => this.sendMessage(mode),
		});
	}

	private handleComposerFilePickerChange(event: Event, interactionLocked: boolean): void {
		handleComposerFilePickerChangeEvent({
			event,
			interactionLocked,
			onPrepareFiles: (files) => this.prepareComposerFiles(files),
		});
	}

	private renderComposerPanel(): TemplateResult {
		const isStreaming = this.currentIsStreaming();
		const interactionLocked = this.isComposerInteractionLocked();
		const slashItems = this.getSlashPaletteItems();
		const canSend =
			!interactionLocked &&
			(this.inputText.trim().length > 0 || this.pendingImages.length > 0 || this.pendingFileReferences.length > 0 || Boolean(this.selectedSkillDraft));
		if (slashItems.length > 0 && this.slashPaletteIndex >= slashItems.length) {
			this.slashPaletteIndex = slashItems.length - 1;
		}
		const connectivityStatus = this.bindingStatusText || (!this.isConnected && this.projectPath ? t("chatView.session.rpcDisconnected") : "");
		const connectionPending = this.isConnectionPending();
		const placeholder = !this.projectPath
			? t("chatView.welcome.composerNoProject")
			: interactionLocked
				? connectivityStatus || t("chatView.session.notReady")
				: connectionPending
					? `${connectivityStatus || t("chatView.session.connecting")} · ${t("chatView.session.connectingQueueHint")}`
					: this.messages.length === 0
						? t("chatView.welcome.composerPlaceholder")
						: t("chatView.composer.placeholder");

		return html`
			<div class="composer-panel">
				${this.pendingImages.length > 0 || this.pendingFileReferences.length > 0
					? html`
						<div class="composer-attachment-tray">
							${renderPendingImagesView(this.pendingImages, (id) => this.removePendingImage(id), (id) => this.previewImages(this.pendingImages, id))}
							${renderPendingFileReferencesView(this.pendingFileReferences, truncate, (id) => this.removePendingFileReference(id))}
						</div>
					`
					: nothing}
				<div class="composer-row">
					${renderComposerSkillDraftPillView(this.selectedSkillDraft, skillGlyphIcon(), () => this.removeComposerSkillDraft())}
					<textarea
						id="chat-input"
						class="chat-input"
						draggable="false"
						placeholder=${placeholder}
						rows="1"
						?disabled=${interactionLocked}
						.value=${this.inputText}
						@input=${(event: Event) => this.handleComposerInput(event, interactionLocked)}
						@paste=${(event: ClipboardEvent) => this.handleComposerPaste(event, interactionLocked)}
						@dragstart=${(event: DragEvent) => event.preventDefault()}
						@dragover=${(event: DragEvent) => this.handleComposerDragOver(event, interactionLocked)}
						@drop=${(event: DragEvent) => this.handleComposerDrop(event, interactionLocked)}
						@keydown=${(event: KeyboardEvent) => this.handleComposerKeyDown(event, interactionLocked, isStreaming)}
					></textarea>
				</div>
				${this.renderSlashPalette(slashItems)}
				${this.renderComposerControls(canSend, isStreaming, interactionLocked)}
				<!-- MCP chip 挂载点：doRender 后由 relocateExtStatusSlot 挪进 composer-controls
				     左组（「+」按钮旁）；模板内位置只是兜底，仍在输入框文档流内。 -->
				<div id="ext-status-slot" class="ext-status-slot"></div>
			</div>
			<input
				id="file-picker"
				type="file"
				multiple
				style="display:none"
				@change=${(event: Event) => this.handleComposerFilePickerChange(event, interactionLocked)}
			/>
		`;
	}

	private renderComposer(): TemplateResult {
		const ratio = Math.min(1, Math.max(0, this.sessionStats.usageRatio ?? 0));
		const ratioPercent = `${Math.round(ratio * 100)}%`;
		const ringRadius = 9;
		const circumference = 2 * Math.PI * ringRadius;
		const strokeOffset = circumference * (1 - ratio);
		const statsLines = this.sessionStatsLines();

		return html`
			<div class="composer-shell">
				<div class="composer-inner">
					<!-- Todo 面板：在 DOM 上真正位于 composer 上方，由 flex 定位。
					     不用 extension-ui-handler 那两个 fixed 容器（它们硬编码
					     bottom-[132px] left-[278px] 猜侧边栏宽度和 composer 高度）。 -->
					<div id="todo-panel-slot" class="hidden-pane"></div>
					${renderQueuedComposerMessagesView(this.queuedComposerMessages, truncate)}
					${this.renderComposerPanel()}

					<div class="composer-under-row">
						<div class="composer-under-row-right">
							${this.renderGitRepoControl()}
							${this.renderReviewToggle()}
							${renderComposerStatsView({
							hover: this.sessionStatsHover,
							refreshing: this.refreshingSessionStats,
							tooltip: this.sessionStatsTooltip(),
							ratioPercent,
							ringRadius,
							circumference,
							strokeOffset,
							statsLines,
							onMouseEnter: () => this.setSessionStatsHover(true),
							onMouseLeave: () => this.setSessionStatsHover(false),
						})}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	private async loadSessionTreeForHistory(): Promise<void> {
		if (this.historyViewerMode !== "browse" || !this.historyViewerOpen) return;
		const requestId = ++this.historyTreeRequestSeq;
		const sessionPath = this.state?.sessionFile?.trim();
		if (!sessionPath) {
			if (requestId !== this.historyTreeRequestSeq || this.historyViewerMode !== "browse") return;
			this.historyTreeRows = [];
			this.historyViewerLoading = false;
			this.render();
			return;
		}

		this.historyViewerLoading = true;
		this.render();
		try {
			const content = await rpcBridge.getSessionContent(sessionPath);
			if (requestId !== this.historyTreeRequestSeq || this.historyViewerMode !== "browse" || !this.historyViewerOpen) return;
			this.historyTreeRows = parseSessionTreeRows({
				sessionContent: content,
				currentSessionEntryIds: this.messages.map((message) => message.sessionEntryId ?? "").filter((id) => id.length > 0),
				extractText: (value) => this.extractText(value),
				extractToolOutput: (value) => this.extractToolOutput(value),
				truncateText: truncate,
				pickString,
				pickNumber,
			});
		} catch (err) {
			if (requestId !== this.historyTreeRequestSeq || this.historyViewerMode !== "browse" || !this.historyViewerOpen) return;
			console.error("Failed to load session tree:", err);
			this.historyTreeRows = [];
		} finally {
			if (requestId !== this.historyTreeRequestSeq || this.historyViewerMode !== "browse" || !this.historyViewerOpen) return;
			this.historyViewerLoading = false;
			this.render();
		}
	}

	private renderHistoryViewer(): TemplateResult | typeof nothing {
		return renderHistoryViewerView<UiMessage>({
			historyViewerOpen: this.historyViewerOpen,
			historyViewerMode: this.historyViewerMode,
			historyViewerLoading: this.historyViewerLoading,
			historyViewerSessionLabel: this.historyViewerSessionLabel,
			historyQuery: this.historyQuery,
			historyRoleFilter: this.historyRoleFilter,
			roleFilterSelect: this.historyRoleFilterSelect,
			messages: this.messages,
			historyTreeRows: this.historyTreeRows,
			forkOptions: this.forkOptions,
			messagePreview: (message) => this.messagePreview(message),
			resolveForkEntryId: (messages, index) => resolveForkEntryId(messages, index, this.forkEntryIdByMessageId),
			onClose: () => this.closeHistoryViewer(),
			onQueryChange: (value) => {
				this.historyQuery = value;
				this.render();
			},
			onRoleFilterChange: (role) => {
				this.historyRoleFilter = role;
				this.render();
			},
			onJumpToMessage: (messageId) => this.revealMessage(messageId),
			onForkFromEntry: (entryId) => void this.forkFrom(entryId),
			compactTreeLinePrefix,
			truncateText: truncate,
		});
	}

	private doRender(): void {
		const hasProject = Boolean(this.projectPath);
		const hasMessages = this.messages.length > 0;
		// Codex-style welcome: shown with no project, or with a project that has
		// no session content yet. The composer card lives inside the welcome view.
		// 全新会话启动期间（bindingForFreshSession）也直接出 welcome：
		// composer 不再被 bindingStatusText 锁死，可输入并本地排队，runtime 就绪后自动发送。
		const showWelcome = !hasProject || (!hasMessages && (!this.bindingStatusText || this.bindingForFreshSession));
		const showWorkingIndicator = hasProject && this.shouldShowWorkingIndicator();
		if (showWelcome && !this.welcomeDashboard.loading && this.welcomeDashboard.updatedAt === 0) {
			void this.refreshWelcomeDashboard();
		}

		const template = html`
			<div
				class="chat-root ${hasProject ? "" : "no-project"}"
				@click=${(e: Event) => {
					const localFileReference = extractLocalFileReferenceFromClick(e);
					if (localFileReference && this.onOpenProjectFile) {
						e.preventDefault();
						e.stopPropagation();
						void Promise.resolve(this.onOpenProjectFile(localFileReference)).catch((err) => {
							console.error("Failed to open project file reference:", err);
							this.pushNotice(t("chatView.notice.localFileOpenFailed"), "error");
						});
						return;
					}
					const target = e.target as HTMLElement;
					let changed = false;

					if (this.slashPaletteOpen && !target.closest(".composer-slash-menu") && !target.closest("#chat-input")) {
						this.closeSlashPalette();
						changed = true;
					}

					if (this.gitMenuOpen && !target.closest(".git-branch-wrap")) {
						this.gitMenuOpen = false;
						this.gitBranchQuery = "";
						changed = true;
					}

					if (this.welcomeProjectMenuOpen && !target.closest(".welcome-project-wrap")) {
						this.welcomeProjectMenuOpen = false;
						changed = true;
					}

					if (changed) this.render();
				}}
				@dragover=${(e: DragEvent) => {
					e.preventDefault();
					if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
				}}
				@drop=${(e: DragEvent) => {
					if (e.defaultPrevented) return;
					e.preventDefault();
					if (!hasProject) return;
					this.handleDroppedDataTransfer(e.dataTransfer ?? null);
				}}
			>
				${hasProject ? this.renderProjectTrustBanner() : nothing}
				<div class="chat-scroll ${showWelcome ? "welcome-scroll" : ""}" id="chat-scroll" @scroll=${(e: Event) => this.handleChatScroll(e)}>
					${showWelcome
						? this.renderCenteredWelcome()
						: hasMessages
							? html`${this.renderHistoryLoadEarlierRow()}${this.renderMessageTimeline()}`
							: this.renderBindingState()}
					${showWorkingIndicator ? this.renderWorkingIndicatorRow() : nothing}
				</div>
				${hasProject && !showWelcome ? this.renderComposer() : nothing}
				${hasProject ? this.renderHistoryViewer() : nothing}
				${hasProject ? renderReviewPanelView(this.reviewPanel) : nothing}
				${hasProject ? this.renderJumpToLatest() : nothing}
				${this.renderNotices()}
			</div>
		`;

		render(template, this.container);
		this.relocateExtStatusSlot();
		this.scrollContainer = this.container.querySelector("#chat-scroll");
		this.syncTodoPanelMount();
		this.updateComposerOffset();
	}

	/**
	 * MCP chip 对齐：把 #ext-status-slot 挪进 composer-controls 左侧按钮组、紧跟
	 * 「+」按钮之后，使扩展状态 chip 与「+」在输入框底栏内同一行、垂直居中对齐。
	 * slot 全程在文档流内，不用绝对定位。lit 重渲染只更新动态绑定，被挪走的静态
	 * slot 节点保持新位置；welcome ↔ chat 结构切换时模板重建，本方法在每次
	 * doRender 后幂等执行，会重新归位。
	 */
	private relocateExtStatusSlot(): void {
		const slot = this.container.querySelector<HTMLElement>("#ext-status-slot");
		if (!slot) return;
		const addMenuRoot = this.container.querySelector<HTMLElement>(".composer-controls .add-menu-root");
		const host = addMenuRoot?.parentElement;
		if (!host) return;
		if (slot.parentElement !== host) {
			addMenuRoot.insertAdjacentElement("afterend", slot);
		}
	}

	render(): void {
		this.doRender();
		this.syncWorkflowElapsedTicker();
		this.syncWorkingStatusAnimation();
		this.ensureActiveSlashItemVisible();
		if (this.modelPickerOpen) this.scheduleModelPickerLayout();
	}

	notify(text: string, kind: "info" | "success" | "error" = "info"): void {
		this.pushNotice(text, kind);
	}

	/** W4 项目信任提示卡：由 main.ts 根据 trust.json 状态驱动显隐。 */
	setProjectTrustPrompt(prompt: { projectPath: string } | null): void {
		const nextPath = prompt?.projectPath ?? null;
		const prevPath = this.projectTrustPrompt?.projectPath ?? null;
		if (nextPath === prevPath) return;
		this.projectTrustPrompt = nextPath ? { projectPath: nextPath, busy: false, error: "" } : null;
		this.render();
	}

	setProjectTrustPromptBusy(busy: boolean, error = ""): void {
		if (!this.projectTrustPrompt) return;
		this.projectTrustPrompt = { ...this.projectTrustPrompt, busy, error };
		this.render();
	}

	setOnTrustProject(callback: () => void): void {
		this.onTrustProject = callback;
	}

	setOnDismissProjectTrust(callback: () => void): void {
		this.onDismissProjectTrust = callback;
	}

	private renderProjectTrustBanner(): TemplateResult | typeof nothing {
		const prompt = this.projectTrustPrompt;
		if (!prompt || prompt.projectPath !== this.projectPath) return nothing;
		return html`
			<div class="chat-trust-banner">
				<div class="chat-trust-banner-text">
					${t("extensions.trust.bannerText")}
					${prompt.error ? html`<span class="ext-error"> ${prompt.error}</span>` : nothing}
				</div>
				<div class="chat-trust-banner-actions">
					<button class="ghost-btn" ?disabled=${prompt.busy} @click=${() => this.onTrustProject?.()}>
						${prompt.busy ? t("extensions.trust.bannerBusy") : t("extensions.trust.bannerTrust")}
					</button>
					<button class="ghost-btn" ?disabled=${prompt.busy} @click=${() => this.onDismissProjectTrust?.()}>
						${t("extensions.trust.bannerDismiss")}
					</button>
				</div>
			</div>
		`;
	}

	getDebugInfo(): {
		projectPath: string | null;
		isConnected: boolean;
		loadingModels: boolean;
		availableModelCount: number;
		messageCount: number;
		backendSessionFile: string | null;
		lastBackendRefreshError: string | null;
		lastModelLoadError: string | null;
	} {
		return {
			projectPath: this.projectPath,
			isConnected: this.isConnected,
			loadingModels: this.loadingModels,
			availableModelCount: this.availableModels.length,
			messageCount: this.messages.length,
			backendSessionFile: this.lastBackendSessionFile,
			lastBackendRefreshError: this.lastBackendRefreshError,
			lastModelLoadError: this.lastModelLoadError,
		};
	}

	focusInput(): void {
		this.getComposerTextarea()?.focus();
	}
}
