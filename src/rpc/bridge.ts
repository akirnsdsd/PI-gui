/**
 * RPC Bridge - typed frontend API for pi --mode rpc
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type QueueMode = "all" | "one-at-a-time";
export type StreamingBehavior = "steer" | "followUp";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RpcStartOptions {
	cliPath: string | null;
	piPath?: string | null;
	cwd: string;
	provider?: string;
	model?: string;
	sessionPath?: string;
	env?: Record<string, string>;
}

export interface SessionRewriteResult {
	instanceId: string;
	generation: number;
	sessionPath: string;
	entryId: string;
	retainedEntryCount: number;
	removedEntryCount: number;
	processStopped: boolean;
}

export class SessionRewriteCommittedError extends Error {
	readonly rewriteResult: SessionRewriteResult;

	constructor(rewriteResult: SessionRewriteResult, message: string) {
		super(message);
		this.name = "SessionRewriteCommittedError";
		this.rewriteResult = rewriteResult;
	}
}

export interface RpcImageInput {
	type: "image";
	data: string;
	mimeType: string;
}

export interface RpcPromptOptions {
	images?: RpcImageInput[];
	streamingBehavior?: StreamingBehavior;
}

export interface RpcSessionState {
	model?: { provider: string; id: string; contextWindow?: number; reasoning?: boolean };
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface PiCliCommandResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	discovery: string;
}

export interface PiAuthProviderStatus {
	provider: string;
	source: "auth_file_api_key" | "auth_file_oauth" | "environment";
	kind: "api_key" | "oauth" | "unknown";
}

export interface PiAuthStatus {
	agent_dir: string | null;
	auth_file: string | null;
	auth_file_exists: boolean;
	configured_providers: PiAuthProviderStatus[];
}

export interface PiProviderAuthClearResult {
	provider: string;
	removed: boolean;
	source: "auth_file" | "environment" | "missing";
}

export interface PiOAuthProviderInfo {
	id: string;
	name: string;
	source: "built_in" | "package";
}

export interface CliUpdateStatus {
	discovery: string;
	current_version: string | null;
	latest_version: string | null;
	update_available: boolean;
	can_update_in_app: boolean;
	npm_available: boolean;
	update_command: string;
	note: string | null;
}

export interface PiChangelogResult {
	path: string;
	content: string;
}

export interface NpmCommandResult {
	stdout: string;
	stderr: string;
	exit_code: number;
}

export interface CliUpdateReport {
	success: boolean;
	exit_code: number;
	npm_path: string | null;
	new_version: string | null;
	output_tail: string;
	error: string | null;
}

export interface GitCommandResult {
	stdout: string;
	stderr: string;
	exit_code: number;
}

export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed" | "typechange";

export interface ReviewFileEntry {
	path: string;
	old_path: string | null;
	status: ReviewFileStatus;
}

export interface GitReviewStatusResult {
	is_repo: boolean;
	/** 仓库是否已有提交；刚 git init 的空仓库为 false。 */
	has_head: boolean;
	staged: ReviewFileEntry[];
	unstaged: ReviewFileEntry[];
	untracked: string[];
	conflicted: string[];
	/** 各列表真实总数；列表本身可能被后端截断（untracked 500 / 其余 2000）。 */
	staged_total: number;
	unstaged_total: number;
	untracked_total: number;
	conflicted_total: number;
}

export type ReviewDiffScope = "staged" | "unstaged";

export interface GitReviewDiffResult {
	patch: string;
	truncated: boolean;
	is_binary: boolean;
}

export interface ShareGistResult {
	gist_url: string;
	gist_id: string;
	preview_url: string;
	stdout: string;
	stderr: string;
}

/** Tail page of timeline entries from a session JSONL file (get_session_page). */
export interface SessionPageResult {
	entries: Array<Record<string, unknown>>;
	hasMore: boolean;
	oldestEntryId: string | null;
}

export interface RpcCompatibilityReport {
	ok: boolean;
	checks: string[];
	error?: string;
	checkedAt: number;
}

export type RpcEventCallback = (event: Record<string, unknown>) => void;

/**
 * Known pi RPC event types (pi 0.81.x).
 *
 * Notes on protocol drift:
 * - `agent_settled` fires after the full session-level run settles (no pending
 *   retry, compaction retry, or queued continuation). `agent_end` only marks the
 *   end of one low-level run and may be followed by more automatic activity.
 * - Compaction events are `compaction_start` / `compaction_end` in current pi;
 *   the legacy `auto_compaction_*` names are kept for backward compatibility.
 * - `summarization_retry_*` events report retries of transient summarization
 *   failures; the desktop UI currently logs and ignores them.
 */
export type RpcEventType =
	| "agent_start"
	| "agent_end"
	| "agent_settled"
	| "turn_start"
	| "turn_end"
	| "message_start"
	| "message_update"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "queue_update"
	| "compaction_start"
	| "compaction_end"
	| "auto_compaction_start"
	| "auto_compaction_update"
	| "auto_compaction_progress"
	| "auto_compaction_end"
	| "auto_retry_start"
	| "auto_retry_end"
	| "summarization_retry_scheduled"
	| "summarization_retry_attempt_start"
	| "summarization_retry_finished"
	| "extension_error"
	| "extension_ui_request"
	| "error"
	| "rpc_connected"
	| "rpc_disconnected"
	| "rpc_reconnecting"
	| "rpc_reconnected"
	| "rpc_reconnect_failed"
	| "rpc_inflight_lost"
	| "rpc_offline_queue_full";

interface RpcLineEventPayload {
	instance_id?: string;
	instanceId?: string;
	generation?: number;
	line?: string;
}

interface RpcClosedEventPayload {
	instance_id?: string;
	instanceId?: string;
	generation?: number;
	reason?: string;
}

interface RpcStartResult {
	discovery: string;
	generation: number;
}

interface PendingRequestEntry {
	resolve: (data: Record<string, unknown>) => void;
	reject: (err: Error) => void;
	/** prompt/steer/follow_up 等用户消息：断线丢失时单独计数并提示「可能未送达」。 */
	isUserMessage?: boolean;
}

function normalizeInstanceId(value: string | null | undefined): string {
	const raw = (value ?? "").trim();
	return raw.length > 0 ? raw : "default";
}

function payloadInstanceId(payload: RpcLineEventPayload | RpcClosedEventPayload): string {
	return normalizeInstanceId(payload.instance_id ?? payload.instanceId ?? "default");
}

function payloadGeneration(payload: RpcLineEventPayload | RpcClosedEventPayload): number | null {
	return typeof payload.generation === "number" && Number.isFinite(payload.generation) ? payload.generation : null;
}

function traceBridge(message: string): void {
	console.debug(`[rpc-bridge] ${message}`);
	const push = (window as typeof window & {
		__PI_DESKTOP_PUSH_TRACE__?: (message: string) => void;
	}).__PI_DESKTOP_PUSH_TRACE__;
	push?.(message);
}

function sanitizeRpcLine(line: string): string {
	let cleaned = line
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim();
	if (!cleaned) return "";
	const firstBrace = cleaned.indexOf("{");
	if (firstBrace > 0) {
		cleaned = cleaned.slice(firstBrace);
	}
	return cleaned;
}

const ACTIONABLE_RUNTIME_ERROR_HINTS = [
	"usage limit",
	"rate limit",
	"quota",
	"insufficient_quota",
	"too many requests",
	"provider unavailable",
	"service unavailable",
	"model overloaded",
	"invalid api key",
	"authentication",
	"unauthorized",
	"forbidden",
	"billing",
	"credits",
	"timed out",
	"timeout",
	"connection reset",
	"context window",
	"max tokens",
	"compaction",
] as const;

function sanitizeRuntimeTextLine(line: string): string {
	return line
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim();
}

function extractRuntimeErrorFromTextLine(line: string): string | null {
	const cleaned = sanitizeRuntimeTextLine(line);
	if (!cleaned) return null;

	const normalized = cleaned.toLowerCase();
	if (/^error\b[:\s-]*/i.test(cleaned)) {
		const withoutPrefix = cleaned.replace(/^error\b[:\s-]*/i, "").trim();
		return withoutPrefix || cleaned;
	}

	const hasErrorWord = /\berror\b/i.test(cleaned);
	const hasFailureWord = /\b(failed|failure|cannot|can't|denied|unavailable)\b/i.test(cleaned);
	const hasActionableHint = ACTIONABLE_RUNTIME_ERROR_HINTS.some((hint) => normalized.includes(hint));

	if (hasErrorWord && hasActionableHint) return cleaned;
	if (hasFailureWord && hasActionableHint) return cleaned;
	if (normalized.includes("429") && (normalized.includes("requests") || normalized.includes("rate limit"))) {
		return cleaned;
	}

	return null;
}

/**
 * Lifecycle guard shared by explicit starts and reconnect attempts.
 *
 * Exported as a pure helper so the stop/reconnect state transition can be
 * covered without constructing a Tauri-backed bridge.
 */
export function isRpcSupervisorEpochActive(
	currentEpoch: number,
	operationEpoch: number,
	supervisorEnabled: boolean,
): boolean {
	return supervisorEnabled && currentEpoch === operationEpoch;
}

/** Pure gate primitive used by every ordinary outbound RPC command. */
export async function waitForRpcSessionTransition<T>(
	transition: Promise<void>,
	operation: () => Promise<T>,
): Promise<T> {
	await transition;
	return operation();
}

class RpcLifecycleCancelledError extends Error {
	constructor() {
		super("RPC lifecycle operation cancelled");
		this.name = "RpcLifecycleCancelledError";
	}
}

export class RpcBridge {
	private readonly instanceId: string;
	private requestId = 0;
	private pendingRequests = new Map<
		string,
		PendingRequestEntry
	>();
	private eventListeners: RpcEventCallback[] = [];
	private unlistenEvent: UnlistenFn | null = null;
	private unlistenClosed: UnlistenFn | null = null;
	private unlistenStderr: UnlistenFn | null = null;
	private listenersReady = false;
	private listenersReadyPromise: Promise<void> | null = null;
	private _isConnected = false;
	private currentGeneration: number | null = null;
	private pendingGeneration: number | null = null;
	private lastStartOptions: RpcStartOptions | null = null;
	private lastDiscoveryInfo: string | null = null;
	private preferredPiPath: string | null = null;
	private parseFailureCount = 0;
	/** get_available_models 按 runtime（bridge 实例）缓存：切会话回来不再重复拉取。
	 * start/stop 时失效；auth 变更路径由调用方显式 clearAvailableModelsCache()。 */
	private availableModelsCache: { models: Array<Record<string, unknown>>; at: number } | null = null;
	private static readonly AVAILABLE_MODELS_CACHE_TTL_MS = 5 * 60_000;
	// ---- RUNTIME-05 断线 supervisor：进程异常关闭后指数退避自动重启 ----
	/** 显式 stop()/stopAll() 期间禁止自动重连；start() 重新开启。 */
	private supervisorEnabled = true;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectInFlight: Promise<void> | null = null;
	private reconnectFailureNotified = false;
	/**
	 * Monotonic lifecycle token. Explicit stop invalidates every pending start
	 * and reconnect continuation; each await boundary verifies this token before
	 * mutating bridge state or emitting connection events.
	 */
	private supervisorEpoch = 0;
	/** All rpc_start calls that may still land after an explicit stop. */
	private startInFlights = new Set<Promise<string>>();
	/** Serializes a new explicit start behind the previous explicit stop. */
	private stopInFlight: Promise<void> | null = null;
	/** 断线前附着的会话文件，重连成功后自动 switch_session 恢复。 */
	private lastAttachedSessionPath: string | null = null;
	/** Serializes session-changing commands through their authoritative lease claim. */
	private sessionTransition: Promise<void> = Promise.resolve();
	/** 重连恢复期间推迟 rpc_connected 派发：等 switch_session 恢复完成后再广播，
	 * 保证监听方拿到事件时会话已可用；失败路径直接丢弃。 */
	private deferConnectedEvent = false;
	private deferredConnectedDiscovery: string | null = null;
	/** 恢复期间入队的用户消息（prompt/steer/follow_up），重连成功后按序补发。 */
	private offlineMessageQueue: Array<{
		command: Record<string, unknown>;
		resolve: () => void;
		reject: (err: Error) => void;
	}> = [];
	/** 队列触顶后只广播一次 rpc_offline_queue_full，队列排空后重置。 */
	private offlineQueueFullNotified = false;
	private static readonly RECONNECT_MAX_ATTEMPTS = 5;
	private static readonly RECONNECT_BASE_DELAY_MS = 1_000;
	private static readonly RECONNECT_MAX_DELAY_MS = 30_000;
	private static readonly OFFLINE_QUEUE_MAX = 100;

	constructor(instanceId = "default") {
		this.instanceId = normalizeInstanceId(instanceId);
	}

	getInstanceId(): string {
		return this.instanceId;
	}

	get isConnected(): boolean {
		return this._isConnected;
	}

	get discoveryInfo(): string | null {
		return this.lastDiscoveryInfo;
	}

	setPreferredPiPath(path: string | null): void {
		this.preferredPiPath = this.normalizePathOverride(path);
	}

	getPreferredPiPath(): string | null {
		return this.preferredPiPath;
	}

	private normalizePathOverride(value: string | null | undefined): string | null {
		const trimmed = typeof value === "string" ? value.trim() : "";
		return trimmed.length > 0 ? trimmed : null;
	}

	async start(options: RpcStartOptions): Promise<string> {
		// Reserve the newest lifecycle intent before awaiting anything. A stop or
		// a newer start issued while this call is draining old work invalidates
		// this epoch, so it cannot revive the process afterwards.
		const epoch = ++this.supervisorEpoch;
		this.supervisorEnabled = false;
		this.cancelReconnectTimer();
		const pendingStop = this.stopInFlight;
		const reconnectFlight = this.reconnectInFlight;
		const pendingStarts = [...this.startInFlights];
		const blockers: Promise<unknown>[] = [...pendingStarts];
		if (pendingStop) blockers.push(pendingStop);
		if (reconnectFlight) blockers.push(reconnectFlight);
		if (blockers.length > 0) {
			await Promise.allSettled(blockers);
		}
		if (this.supervisorEpoch !== epoch) {
			throw new RpcLifecycleCancelledError();
		}
		this.supervisorEnabled = true;
		return this.trackStartFlight(this.startForEpoch(options, epoch));
	}

	private trackStartFlight(flight: Promise<string>): Promise<string> {
		this.startInFlights.add(flight);
		void flight
			.finally(() => {
				this.startInFlights.delete(flight);
			})
			.catch(() => {
				// The caller observes the original promise. This branch only
				// prevents the bookkeeping promise from becoming unhandled.
			});
		return flight;
	}

	private isEpochActive(epoch: number): boolean {
		return isRpcSupervisorEpochActive(this.supervisorEpoch, epoch, this.supervisorEnabled);
	}

	private assertEpochActive(epoch: number): void {
		if (!this.isEpochActive(epoch)) {
			throw new RpcLifecycleCancelledError();
		}
	}

	private async startForEpoch(
		options: RpcStartOptions,
		epoch: number,
		startupOptions: {
			sessionTransitionOwned?: boolean;
			expectedSessionPath?: string;
		} = {},
	): Promise<string> {
		await this.ensureListeners();
		this.assertEpochActive(epoch);
		this.pendingGeneration = (this.currentGeneration ?? 0) + 1;

		const effectiveCliPath = this.normalizePathOverride(options.cliPath);
		const effectivePiPath = this.normalizePathOverride(options.piPath) ?? this.preferredPiPath;
		const startOptions: RpcStartOptions = {
			...options,
			cliPath: effectiveCliPath,
			piPath: effectivePiPath,
		};

		try {
			traceBridge(`start instance=${this.instanceId} cwd=${startOptions.cwd}`);
			const result = await invoke<RpcStartResult>("rpc_start", {
				options: {
					cli_path: startOptions.cliPath ?? null,
					pi_path: startOptions.piPath ?? null,
					cwd: startOptions.cwd,
					provider: startOptions.provider || null,
					model: startOptions.model || null,
					session_path: startOptions.sessionPath || null,
					env: startOptions.env || null,
				},
				instanceId: this.instanceId,
			});

			if (!this.isEpochActive(epoch)) {
				this.pendingGeneration = null;
				traceBridge(`start-cancelled-after-spawn instance=${this.instanceId} epoch=${epoch}`);
				// rpc_start may have landed after its lifecycle was superseded.
				// New starts drain old start flights before spawning, so this
				// idempotent stop cannot kill a newer process.
				await invoke("rpc_stop", { instanceId: this.instanceId }).catch(() => {
					// Explicit stop performs a final idempotent rpc_stop as well.
				});
				throw new RpcLifecycleCancelledError();
			}
			this._isConnected = true;
			this.currentGeneration = typeof result.generation === "number" && Number.isFinite(result.generation)
				? result.generation
				: this.pendingGeneration;
			this.pendingGeneration = null;
			const claimStartupSession = () =>
				this.getStateAndClaimLeaseOrStop(
					startupOptions.expectedSessionPath
						? () => this.stopRuntimeAfterStartupClaimFailureRetainingLease(startupOptions.expectedSessionPath!)
						: () => this.stopRuntimeAfterStartupClaimFailure(),
					startupOptions.expectedSessionPath,
				);
			if (startupOptions.sessionTransitionOwned) {
				await claimStartupSession();
			} else {
				await this.runSessionTransition(claimStartupSession);
			}
			this.assertEpochActive(epoch);
			// `sessionPath` is a one-shot attach target. Reconnects resume via
			// lastAttachedSessionPath, so retaining it here could briefly attach
			// an obsolete session after the user switches elsewhere.
			this.lastStartOptions = { ...startOptions, sessionPath: undefined };
			this.lastDiscoveryInfo = result.discovery;
			// 新进程：旧进程的模型列表缓存一并作废。
			this.availableModelsCache = null;
			this.reconnectAttempts = 0;
			this.reconnectFailureNotified = false;
			traceBridge(`started instance=${this.instanceId} generation=${this.currentGeneration ?? -1} discovery=${result.discovery}`);
			this.emitConnected(result.discovery);
			return result.discovery;
		} catch (err) {
			this.pendingGeneration = null;
			traceBridge(`start-failed instance=${this.instanceId}: ${err instanceof Error ? err.message : String(err)}`);
			throw err;
		}
	}

	stop(): Promise<void> {
		return this.beginExplicitStop(false);
	}

	stopAll(): Promise<void> {
		return this.beginExplicitStop(true);
	}

	private beginExplicitStop(stopAll: boolean): Promise<void> {
		// 显式停止：禁止 supervisor 自动重连，恢复期间入队的消息直接失败。
		const stopEpoch = ++this.supervisorEpoch;
		this.supervisorEnabled = false;
		this.cancelReconnectTimer();
		this.discardDeferredConnectedEvent();
		this.rejectOfflineMessageQueue(new Error("RPC stopped"));
		traceBridge(`stop instance=${this.instanceId}`);
		this._isConnected = false;
		this.availableModelsCache = null;
		this.pendingGeneration = null;
		this.rejectAllPending("RPC stopped");
		const existing = this.stopInFlight;
		// Even when an earlier stop already owns the physical stop flight, the
		// epoch bump above cancels a start that was waiting for that flight.
		if (existing) return existing;
		const reconnectFlight = this.reconnectInFlight;
		const pendingStarts = [...this.startInFlights];
		const task = this.finishExplicitStop(stopAll, stopEpoch, reconnectFlight, pendingStarts);
		const tracked = task.finally(() => {
			if (this.stopInFlight === tracked) this.stopInFlight = null;
		});
		this.stopInFlight = tracked;
		return tracked;
	}

	private async finishExplicitStop(
		stopAll: boolean,
		stopEpoch: number,
		reconnectFlight: Promise<void> | null,
		pendingStarts: Promise<string>[],
	): Promise<void> {
		const invokeStop = (): Promise<unknown> =>
			stopAll ? invoke("rpc_stop_all") : invoke("rpc_stop", { instanceId: this.instanceId });

		// Stop the currently visible process first. Then wait for every start that
		// was already in flight; a late rpc_start self-cancels on its epoch check.
		// A final idempotent stop closes the landing window without calling stop()
		// recursively (which would deadlock on reconnectInFlight).
		let firstStopError: unknown = null;
		try {
			await invokeStop();
		} catch (err) {
			firstStopError = err;
		}
		const flights: Promise<unknown>[] = [...pendingStarts];
		if (reconnectFlight) flights.push(reconnectFlight);
		if (flights.length > 0) {
			await Promise.allSettled(flights);
		}
		try {
			await invokeStop();
		} catch (err) {
			throw err ?? firstStopError;
		}
		if (this.supervisorEpoch === stopEpoch) {
			this._isConnected = false;
			this.pendingGeneration = null;
		}
	}

	async refreshRunningState(): Promise<boolean> {
		const running = await invoke<boolean>("rpc_is_running", { instanceId: this.instanceId });
		this._isConnected = running;
		return running;
	}

	onEvent(callback: RpcEventCallback): () => void {
		void this.ensureListeners().catch((err) => {
			traceBridge(`listener-init-failed instance=${this.instanceId}: ${err instanceof Error ? err.message : String(err)}`);
		});
		this.eventListeners.push(callback);
		return () => {
			const idx = this.eventListeners.indexOf(callback);
			if (idx !== -1) this.eventListeners.splice(idx, 1);
		};
	}

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	async prompt(message: string, options: RpcPromptOptions = {}): Promise<void> {
		await this.sendUserCommand({ type: "prompt", message, images: options.images, streamingBehavior: options.streamingBehavior });
	}

	async steer(message: string, images?: RpcImageInput[]): Promise<void> {
		await this.sendUserCommand({ type: "steer", message, images });
	}

	async followUp(message: string, images?: RpcImageInput[]): Promise<void> {
		await this.sendUserCommand({ type: "follow_up", message, images });
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		return this.runSessionTransition(async () => {
			const response = await this.rawSend({ type: "new_session", parentSession });
			const data = this.getData<{ cancelled: boolean }>(response);
			if (!data.cancelled) {
				await this.getStateAndClaimLeaseOrStop();
			}
			return data;
		});
	}

	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	async setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	async cycleModel(): Promise<Record<string, unknown> | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	async getAvailableModels(): Promise<Array<Record<string, unknown>>> {
		const now = Date.now();
		if (this.availableModelsCache && now - this.availableModelsCache.at < RpcBridge.AVAILABLE_MODELS_CACHE_TTL_MS) {
			traceBridge(`models-cache hit instance=${this.instanceId} ageMs=${now - this.availableModelsCache.at}`);
			return this.availableModelsCache.models;
		}
		const startedAt = Date.now();
		const response = await this.send({ type: "get_available_models" });
		const data = this.getData<{ models: Array<Record<string, unknown>> }>(response);
		this.availableModelsCache = { models: data.models, at: Date.now() };
		traceBridge(`models-cache miss instance=${this.instanceId} count=${data.models.length} tookMs=${Date.now() - startedAt}`);
		return data.models;
	}

	clearAvailableModelsCache(): void {
		this.availableModelsCache = null;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	async compact(customInstructions?: string): Promise<Record<string, unknown>> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	async bash(command: string): Promise<Record<string, unknown>> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	async getMessages(): Promise<Array<Record<string, unknown>>> {
		const response = await this.send({ type: "get_messages" });
		const data = this.getData<{ messages: Array<Record<string, unknown>> }>(response);
		return data.messages;
	}

	async getSessionStats(): Promise<Record<string, unknown>> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	async getCommands(): Promise<Array<Record<string, unknown>>> {
		const response = await this.send({ type: "get_commands" });
		const data = this.getData<{ commands: Array<Record<string, unknown>> }>(response);
		return data.commands;
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.runSessionTransition(async () => {
			const response = await this.rawSend({ type: "switch_session", sessionPath });
			const data = this.getData<{ cancelled: boolean }>(response);
			if (!data.cancelled) {
				this.lastAttachedSessionPath = sessionPath;
			}
			return data;
		});
	}

	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Remove one persisted user message and everything after it while keeping
	 * the same session file. The backend owns the lease and atomic rewrite; the
	 * bridge restarts pi on that exact file before returning.
	 */
	async rewriteSessionBeforeUserEntry(entryId: string): Promise<SessionRewriteResult> {
		const normalizedEntryId = entryId.trim();
		if (!normalizedEntryId) {
			throw new Error("找不到该消息对应的历史记录");
		}

		return this.runSessionTransition(async () => {
			if (!this._isConnected || this.currentGeneration === null || !this.lastStartOptions) {
				throw new Error("当前会话尚未连接，不能编辑或撤回消息");
			}
			if (this.isReconnectInProgress() || this.offlineMessageQueue.length > 0) {
				throw new Error("连接正在恢复，不能编辑或撤回消息");
			}
			if (this.pendingRequests.size > 0) {
				throw new Error("当前还有请求正在处理中，不能编辑或撤回消息");
			}

			const response = await this.rawSend({ type: "get_state" });
			const state = this.getData<RpcSessionState>(response);
			if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) {
				throw new Error("当前会话仍在生成或有待处理消息，不能编辑或撤回消息");
			}
			const sessionPath = state.sessionFile?.trim() ?? "";
			if (!sessionPath) {
				throw new Error("当前会话没有可改写的历史文件");
			}

			const generation = this.currentGeneration;
			const restartOptions: RpcStartOptions = {
				...this.lastStartOptions,
				sessionPath,
			};

			// The rewrite intentionally stops the process. Suppress the ordinary
			// disconnect supervisor; this transition owns restart + lease claim.
			this.supervisorEpoch += 1;
			this.supervisorEnabled = false;
			this.cancelReconnectTimer();
			this.discardDeferredConnectedEvent();

			let result: SessionRewriteResult;
			try {
				result = await invoke<SessionRewriteResult>("rewrite_session_before_user_entry", {
					instanceId: this.instanceId,
					generation,
					sessionPath,
					entryId: normalizedEntryId,
				});
			} catch (rewriteError) {
				// Validation failures normally leave the process alive. If a
				// later disk error stopped it, restore the exact source session
				// before releasing the transition barrier.
				const running = await invoke<boolean>("rpc_is_running", { instanceId: this.instanceId }).catch(() => false);
				if (running) {
					this._isConnected = true;
					this.supervisorEnabled = true;
				} else {
					try {
						await this.startWithinSessionTransition(restartOptions);
					} catch (restartError) {
						const rewriteMessage = rewriteError instanceof Error ? rewriteError.message : String(rewriteError);
						const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
						throw new Error(`${rewriteMessage}；恢复会话也失败：${restartMessage}`);
					}
				}
				throw rewriteError;
			}

			this._isConnected = false;
			this.pendingGeneration = null;
			this.availableModelsCache = null;
			this.lastAttachedSessionPath = result.sessionPath;

			let firstRestartError: unknown = null;
			try {
				await this.startWithinSessionTransition(restartOptions);
			} catch (error) {
				firstRestartError = error;
				try {
					await this.startWithinSessionTransition(restartOptions);
				} catch (retryError) {
					const firstMessage = firstRestartError instanceof Error ? firstRestartError.message : String(firstRestartError);
					const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
					throw new SessionRewriteCommittedError(
						result,
						`会话历史已改写，但重新连接失败：${firstMessage}；重试仍失败：${retryMessage}`,
					);
				}
			}
			return result;
		});
	}

	private async startWithinSessionTransition(options: RpcStartOptions): Promise<string> {
		const epoch = ++this.supervisorEpoch;
		this.supervisorEnabled = true;
		this.cancelReconnectTimer();
		return this.trackStartFlight(
			this.startForEpoch(options, epoch, {
				sessionTransitionOwned: true,
				expectedSessionPath: options.sessionPath,
			}),
		);
	}

	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		const data = this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response);
		return data.messages;
	}

	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return this.runSessionTransition(async () => {
			const response = await this.rawSend({ type: "fork", entryId });
			const data = this.getData<{ text: string; cancelled: boolean }>(response);
			if (!data.cancelled) {
				await this.getStateAndClaimLeaseOrStop();
			}
			return data;
		});
	}

	async getEntries(since?: string): Promise<{ entries: Array<Record<string, unknown>>; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since: since ?? undefined });
		return this.getData(response);
	}

	async getTree(): Promise<{ tree: Array<Record<string, unknown>>; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData(response);
	}

	async clone(): Promise<{ cancelled: boolean }> {
		return this.runSessionTransition(async () => {
			const response = await this.rawSend({ type: "clone" });
			const data = this.getData<{ cancelled: boolean }>(response);
			if (!data.cancelled) {
				await this.getStateAndClaimLeaseOrStop();
			}
			return data;
		});
	}

	async getAvailableThinkingLevels(): Promise<string[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		const data = this.getData<{ levels: string[] }>(response);
		return data.levels;
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		const data = this.getData<{ text: string | null }>(response);
		return data.text;
	}

	async getSessionContent(sessionPath: string): Promise<string> {
		return invoke<string>("get_session_content", { sessionPath });
	}

	async getSessionPage(sessionPath: string, beforeEntryId?: string | null, limit?: number): Promise<SessionPageResult> {
		return invoke<SessionPageResult>("get_session_page", {
			sessionPath,
			beforeEntryId: beforeEntryId ?? null,
			limit: limit ?? null,
		});
	}

	async sendExtensionUiResponse(response: Record<string, unknown>): Promise<void> {
		await invoke("rpc_ui_response", {
			response: JSON.stringify(response),
			instanceId: this.instanceId,
		});
	}

	async runPiCliCommand(
		args: string[],
		options: { cwd?: string; env?: Record<string, string>; cliPath?: string | null; piPath?: string | null } = {},
	): Promise<PiCliCommandResult> {
		const cliPath = this.normalizePathOverride(
			typeof options.cliPath !== "undefined" ? options.cliPath : (this.lastStartOptions?.cliPath ?? null),
		);
		const piPath = this.normalizePathOverride(
			typeof options.piPath !== "undefined"
				? options.piPath
				: (this.preferredPiPath ?? this.lastStartOptions?.piPath ?? null),
		);

		return invoke<PiCliCommandResult>("run_pi_cli_command", {
			options: {
				args,
				cwd: options.cwd ?? null,
				env: options.env ?? null,
				cli_path: cliPath,
				pi_path: piPath,
			},
		});
	}

	async runGitCommand(args: string[], options: { cwd?: string } = {}): Promise<GitCommandResult> {
		return invoke<GitCommandResult>("run_git_command", {
			options: {
				args,
				cwd: options.cwd ?? null,
			},
		});
	}

	async gitReviewStatus(cwd: string): Promise<GitReviewStatusResult> {
		return invoke<GitReviewStatusResult>("git_review_status", { cwd });
	}

	async gitReviewDiff(options: {
		cwd: string;
		scope: ReviewDiffScope;
		path: string;
		oldPath?: string | null;
	}): Promise<GitReviewDiffResult> {
		return invoke<GitReviewDiffResult>("git_review_diff", {
			options: {
				cwd: options.cwd,
				scope: options.scope,
				path: options.path,
				old_path: options.oldPath ?? null,
			},
		});
	}

	async gitReviewStage(cwd: string, paths: string[]): Promise<void> {
		return invoke<void>("git_review_stage", { options: { cwd, paths } });
	}

	async gitReviewUnstage(cwd: string, paths: string[]): Promise<void> {
		return invoke<void>("git_review_unstage", { options: { cwd, paths } });
	}

	async createShareGist(htmlPath: string): Promise<ShareGistResult> {
		return invoke<ShareGistResult>("create_share_gist", {
			options: {
				html_path: htmlPath,
			},
		});
	}

	async getPiAuthStatus(): Promise<PiAuthStatus> {
		return invoke<PiAuthStatus>("get_pi_auth_status");
	}

	async clearPiProviderAuth(provider: string): Promise<PiProviderAuthClearResult> {
		return invoke<PiProviderAuthClearResult>("clear_pi_provider_auth", { provider });
	}

	async getPiOAuthProviders(): Promise<PiOAuthProviderInfo[]> {
		return invoke<PiOAuthProviderInfo[]>("get_pi_oauth_providers");
	}

	async getCliUpdateStatus(): Promise<CliUpdateStatus> {
		return invoke<CliUpdateStatus>("get_cli_update_status", {
			options: {
				cli_path: this.normalizePathOverride(this.lastStartOptions?.cliPath ?? null),
				pi_path: this.normalizePathOverride(this.preferredPiPath ?? this.lastStartOptions?.piPath ?? null),
				cwd: this.lastStartOptions?.cwd ?? null,
				env: this.lastStartOptions?.env ?? null,
			},
		});
	}

	async getPiChangelog(): Promise<PiChangelogResult> {
		return invoke<PiChangelogResult>("get_pi_changelog", {
			options: {
				cli_path: this.normalizePathOverride(this.lastStartOptions?.cliPath ?? null),
				pi_path: this.normalizePathOverride(this.preferredPiPath ?? this.lastStartOptions?.piPath ?? null),
				cwd: this.lastStartOptions?.cwd ?? null,
				env: this.lastStartOptions?.env ?? null,
			},
		});
	}

	async updateCliViaNpm(): Promise<NpmCommandResult> {
		return invoke<NpmCommandResult>("update_cli_via_npm");
	}

	async updateCliAndReport(): Promise<CliUpdateReport> {
		return invoke<CliUpdateReport>("update_cli_and_report", {
			options: {
				cli_path: this.normalizePathOverride(this.lastStartOptions?.cliPath ?? null),
				pi_path: this.normalizePathOverride(this.preferredPiPath ?? this.lastStartOptions?.piPath ?? null),
				cwd: this.lastStartOptions?.cwd ?? null,
				env: this.lastStartOptions?.env ?? null,
			},
		});
	}

	async checkRpcCompatibility(): Promise<RpcCompatibilityReport> {
		const checks: string[] = [];
		if (!this.isConnected) {
			return {
				ok: false,
				checks,
				error: "没有可用的 RPC 运行时。请先打开一个项目或会话，再运行兼容性检查。",
				checkedAt: Date.now(),
			};
		}
		try {
			await this.getState();
			checks.push("get_state");
			await this.getCommands();
			checks.push("get_commands");
			await this.getAvailableModels();
			checks.push("get_available_models");
			return {
				ok: true,
				checks,
				checkedAt: Date.now(),
			};
		} catch (err) {
			return {
				ok: false,
				checks,
				error: err instanceof Error ? err.message : String(err),
				checkedAt: Date.now(),
			};
		}
	}

	// -------------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------------

	private matchesPayloadGeneration(payload: RpcLineEventPayload | RpcClosedEventPayload): boolean {
		const generation = payloadGeneration(payload);
		if (generation === null) return true;
		if (this.pendingGeneration !== null) {
			return generation === this.pendingGeneration;
		}
		if (this.currentGeneration === null) return true;
		return generation === this.currentGeneration;
	}

	private emitToListeners(event: Record<string, unknown>): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch (err) {
				traceBridge(`listener-error instance=${this.instanceId}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private async ensureListeners(): Promise<void> {
		if (this.listenersReady) return;
		if (this.listenersReadyPromise) {
			await this.listenersReadyPromise;
			return;
		}

		this.listenersReadyPromise = (async () => {
			let unlistenEventLocal: UnlistenFn | null = null;
			let unlistenClosedLocal: UnlistenFn | null = null;
			let unlistenStderrLocal: UnlistenFn | null = null;
			try {
				unlistenEventLocal = await listen<RpcLineEventPayload>("rpc-event", (event) => {
					const payload = event.payload;
					if (payloadInstanceId(payload) !== this.instanceId) return;
					if (!this.matchesPayloadGeneration(payload)) return;
					const line = typeof payload.line === "string" ? payload.line : "";
					if (!line) return;
					this.handleLine(line);
				});

				unlistenClosedLocal = await listen<RpcClosedEventPayload>("rpc-closed", (event) => {
					const payload = event.payload;
					if (payloadInstanceId(payload) !== this.instanceId) return;
					if (!this.matchesPayloadGeneration(payload)) return;
					this._isConnected = false;
					const closeReason = typeof payload.reason === "string" ? payload.reason : "RPC process closed";
					traceBridge(`closed instance=${this.instanceId} generation=${payload.generation ?? -1} reason=${closeReason}`);
					this.failInFlightOnDisconnect(closeReason);
					this.emitToListeners({ type: "rpc_disconnected" });
					// RUNTIME-05：非显式 stop 的进程关闭由 supervisor 自动重启（指数退避）。
					this.scheduleReconnect();
				});

				unlistenStderrLocal = await listen<RpcLineEventPayload>("rpc-stderr", (event) => {
					const payload = event.payload;
					if (payloadInstanceId(payload) !== this.instanceId) return;
					if (!this.matchesPayloadGeneration(payload)) return;
					const line = typeof payload.line === "string" ? payload.line : "";
					if (!line) return;
					console.debug(`[pi stderr:${this.instanceId}]`, line);
					const runtimeError = extractRuntimeErrorFromTextLine(line);
					if (!runtimeError) return;
					traceBridge(`stderr-error instance=${this.instanceId} message=${runtimeError.slice(0, 180)}`);
					this.emitToListeners({
						type: "error",
						source: "stderr",
						errorMessage: runtimeError,
						rawLine: sanitizeRuntimeTextLine(line),
					});
				});

				this.unlistenEvent = unlistenEventLocal;
				this.unlistenClosed = unlistenClosedLocal;
				this.unlistenStderr = unlistenStderrLocal;
				this.listenersReady = true;
			} catch (err) {
				unlistenEventLocal?.();
				unlistenClosedLocal?.();
				unlistenStderrLocal?.();
				throw err;
			} finally {
				this.listenersReadyPromise = null;
			}
		})();

		await this.listenersReadyPromise;
	}

	private handleLine(line: string): void {
		const sanitized = sanitizeRpcLine(line);
		if (!sanitized) return;

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(sanitized);
		} catch {
			this.parseFailureCount += 1;
			if (this.parseFailureCount <= 5 || sanitized.includes("extension_ui_request") || sanitized.includes("notify")) {
				traceBridge(`parse-failed instance=${this.instanceId} sample=${sanitized.slice(0, 180)}`);
			}
			const runtimeError = extractRuntimeErrorFromTextLine(line);
			if (runtimeError) {
				traceBridge(`stdout-text-error instance=${this.instanceId} message=${runtimeError.slice(0, 180)}`);
				this.emitToListeners({
					type: "error",
					source: "stdout_text",
					errorMessage: runtimeError,
					rawLine: sanitizeRuntimeTextLine(line),
				});
			}
			return;
		}

		if (data.type === "response" && typeof data.id === "string" && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			traceBridge(`response instance=${this.instanceId} id=${data.id} command=${String(data.command ?? "-")} success=${data.success === false ? "no" : "yes"}`);
			pending.resolve(data);
			return;
		}

		this.emitToListeners(data);
	}

	private timeoutMsForCommand(command: Record<string, unknown>): number {
		const type = typeof command.type === "string" ? command.type.trim().toLowerCase() : "";
		switch (type) {
			case "compact":
				return 5 * 60_000;
			default:
				return 35_000;
		}
	}

	private async send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		return waitForRpcSessionTransition(this.sessionTransition, () => this.rawSend(command));
	}

	/** Bypass used only inside an operation that already owns sessionTransition. */
	private async rawSend(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.ensureListeners();
		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id };

		return new Promise((resolve, reject) => {
			const timeoutMs = this.timeoutMsForCommand(command);
			traceBridge(`send instance=${this.instanceId} id=${id} command=${String(command.type)} timeoutMs=${timeoutMs}`);
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				traceBridge(`timeout instance=${this.instanceId} id=${id} command=${String(command.type)} timeoutMs=${timeoutMs}`);
				reject(new Error(`等待响应超时：${String(command.type)}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				isUserMessage: command.type === "prompt" || command.type === "steer" || command.type === "follow_up",
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			invoke("rpc_send", {
				command: JSON.stringify(fullCommand),
				instanceId: this.instanceId,
			}).catch((err) => {
				clearTimeout(timeout);
				this.pendingRequests.delete(id);
				traceBridge(`send-failed instance=${this.instanceId} id=${id} command=${String(command.type)}: ${String(err)}`);
				reject(new Error(`发送 RPC 命令失败：${err}`));
			});
		});
	}

	private getData<T = Record<string, unknown>>(response: Record<string, unknown>): T {
		if (response.success === false) {
			throw new Error((response.error as string) || "未知的 RPC 错误");
		}
		return (response.data ?? response) as T;
	}

	private rejectAllPending(reason: string): void {
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error(reason));
		}
		this.pendingRequests.clear();
	}

	/**
	 * 断线瞬间的在途请求全部标记失败（不重发，避免重复执行副作用）；
	 * 其中用户消息（prompt/steer/follow_up）单独计数并广播 rpc_inflight_lost，
	 * 由 UI 提示该条消息可能未送达。
	 */
	private failInFlightOnDisconnect(reason: string): void {
		if (this.pendingRequests.size === 0) return;
		let lostUserMessages = 0;
		for (const [, pending] of this.pendingRequests) {
			if (pending.isUserMessage) lostUserMessages += 1;
			pending.reject(
				new Error(pending.isUserMessage ? "连接中断，该消息可能未送达，请确认后重新发送。" : reason),
			);
		}
		this.pendingRequests.clear();
		if (lostUserMessages > 0) {
			traceBridge(`inflight-lost instance=${this.instanceId} userMessages=${lostUserMessages}`);
			this.emitToListeners({ type: "rpc_inflight_lost", count: lostUserMessages });
		}
	}

	/** rpc_connected 派发入口：重连恢复期间推迟到会话恢复完成后再广播。 */
	private emitConnected(discovery: string): void {
		if (this.deferConnectedEvent) {
			this.deferredConnectedDiscovery = discovery;
			return;
		}
		this.emitToListeners({ type: "rpc_connected", discovery });
	}

	/** 会话恢复完成（或无需恢复）：派发被推迟的 rpc_connected。 */
	private flushDeferredConnectedEvent(): void {
		const discovery = this.deferredConnectedDiscovery;
		this.deferredConnectedDiscovery = null;
		this.deferConnectedEvent = false;
		if (discovery !== null) {
			this.emitToListeners({ type: "rpc_connected", discovery });
		}
	}

	/** 失败/显式停止路径：丢弃被推迟的 rpc_connected，不对外广播半成品连接。 */
	private discardDeferredConnectedEvent(): void {
		this.deferredConnectedDiscovery = null;
		this.deferConnectedEvent = false;
	}

	// -------------------------------------------------------------------------
	// RUNTIME-05 断线 supervisor：指数退避自动重启（1s/2s/4s…上限 30s，最多 5 次）
	// -------------------------------------------------------------------------

	private cancelReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private isReconnectInProgress(): boolean {
		return this.reconnectTimer !== null || this.reconnectInFlight !== null;
	}

	/** 用户消息入口：断线恢复期间入队（有上限），重连成功后补发；其余情况直接发送。 */
	private async sendUserCommand(command: Record<string, unknown>): Promise<void> {
		if (!this._isConnected && this.isReconnectInProgress()) {
			if (this.offlineMessageQueue.length >= RpcBridge.OFFLINE_QUEUE_MAX) {
				// 入队上限：拒绝新消息并中文提示，避免重连窗口内无限堆积。
				if (!this.offlineQueueFullNotified) {
					this.offlineQueueFullNotified = true;
					this.emitToListeners({ type: "rpc_offline_queue_full", max: RpcBridge.OFFLINE_QUEUE_MAX });
				}
				throw new Error(`连接尚未恢复，待发送的消息队列已满（${RpcBridge.OFFLINE_QUEUE_MAX} 条），请稍后再试。`);
			}
			traceBridge(`offline-queue instance=${this.instanceId} command=${String(command.type)} queued=${this.offlineMessageQueue.length + 1}`);
			return new Promise((resolve, reject) => {
				this.offlineMessageQueue.push({ command, resolve, reject });
			});
		}
		await this.send(command);
	}

	private runSessionTransition<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.sessionTransition.catch(() => undefined).then(operation);
		this.sessionTransition = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async getStateAndClaimLeaseOrStop(
		stopRuntime: () => Promise<void> = () => this.stop(),
		expectedSessionPath?: string,
	): Promise<RpcSessionState> {
		try {
			const generation = this.currentGeneration;
			if (generation === null || !Number.isFinite(generation)) {
				throw new Error("当前 RPC generation 不可用");
			}
			const response = await this.rawSend({ type: "get_state" });
			const state = this.getData<RpcSessionState>(response);
			const sessionPath = state.sessionFile?.trim();
			if (!sessionPath) {
				throw new Error("get_state 未返回 sessionFile");
			}
			await invoke("rpc_claim_session_lease", {
				sessionPath,
				expectedSessionPath: expectedSessionPath ?? null,
				generation,
				instanceId: this.instanceId,
			});
			this.lastAttachedSessionPath = sessionPath;
			return state;
		} catch (err) {
			const claimError = err instanceof Error ? err.message : String(err);
			try {
				await stopRuntime();
			} catch (stopErr) {
				const stopError = stopErr instanceof Error ? stopErr.message : String(stopErr);
				throw new Error(`会话租约确认失败：${claimError}；停止无租约 runtime 也失败：${stopError}`);
			}
			throw new Error(`会话租约确认失败：${claimError}；当前 runtime 已停止`);
		}
	}

	private async stopRuntimeAfterStartupClaimFailure(): Promise<void> {
		this.supervisorEnabled = false;
		this.cancelReconnectTimer();
		this._isConnected = false;
		this.pendingGeneration = null;
		this.availableModelsCache = null;
		this.rejectAllPending("RPC startup lease claim failed");
		await invoke("rpc_stop", { instanceId: this.instanceId });
	}

	private async stopRuntimeAfterStartupClaimFailureRetainingLease(sessionPath: string): Promise<void> {
		this.supervisorEnabled = false;
		this.cancelReconnectTimer();
		this._isConnected = false;
		this.pendingGeneration = null;
		this.availableModelsCache = null;
		this.rejectAllPending("RPC startup lease claim failed");
		const generation = this.currentGeneration;
		if (generation === null) {
			throw new Error("当前 RPC generation 不可用，无法保留租约停止进程");
		}
		await invoke("stop_rpc_process_retain_session_lease", {
			instanceId: this.instanceId,
			generation,
			sessionPath,
		});
	}

	private scheduleReconnect(): void {
		if (!this.supervisorEnabled) return;
		if (!this.lastStartOptions) return;
		if (this._isConnected) return;
		if (this.reconnectTimer !== null || this.reconnectInFlight !== null) return;
		if (this.reconnectAttempts >= RpcBridge.RECONNECT_MAX_ATTEMPTS) {
			this.finalizeReconnectFailure();
			return;
		}
		const nextAttempt = this.reconnectAttempts + 1;
		const delayMs = Math.min(
			RpcBridge.RECONNECT_BASE_DELAY_MS * 2 ** (nextAttempt - 1),
			RpcBridge.RECONNECT_MAX_DELAY_MS,
		);
		traceBridge(`reconnect-scheduled instance=${this.instanceId} attempt=${nextAttempt}/${RpcBridge.RECONNECT_MAX_ATTEMPTS} delayMs=${delayMs}`);
		this.emitToListeners({
			type: "rpc_reconnecting",
			attempt: nextAttempt,
			maxAttempts: RpcBridge.RECONNECT_MAX_ATTEMPTS,
			delayMs,
		});
		const epoch = this.supervisorEpoch;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.isEpochActive(epoch) || this._isConnected) return;
			const flight = this.attemptReconnectOnce(epoch);
			this.reconnectInFlight = flight;
			void flight
				.catch((err) => {
					traceBridge(`reconnect-attempt-error instance=${this.instanceId}: ${err instanceof Error ? err.message : String(err)}`);
				})
				.finally(() => {
					if (this.reconnectInFlight === flight) this.reconnectInFlight = null;
					// 本次尝试未恢复连接：继续排队下一次（次数已在尝试内自增）。
					if (this.isEpochActive(epoch) && !this._isConnected) {
						this.scheduleReconnect();
					}
				});
		}, delayMs);
	}

	private async attemptReconnectOnce(epoch: number): Promise<void> {
		this.assertEpochActive(epoch);
		const options = this.lastStartOptions;
		if (!options) return;
		this.reconnectAttempts += 1;
		const attempt = this.reconnectAttempts;
		const sessionPath = this.lastAttachedSessionPath;
		// 有会话要恢复时，rpc_connected 推迟到 switch_session 完成后派发，
		// 保证监听方拿到事件时会话已可用（无会话可恢复时除外，立即派发）。
		this.deferConnectedEvent = Boolean(sessionPath);
		try {
			try {
				await this.trackStartFlight(this.startForEpoch({ ...options }, epoch));
				this.assertEpochActive(epoch);
			} catch (err) {
				if (!this.isEpochActive(epoch)) throw err;
				traceBridge(`reconnect-failed instance=${this.instanceId} attempt=${attempt}/${RpcBridge.RECONNECT_MAX_ATTEMPTS}: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			// start() 成功会把退避计数清零；若下面的会话附着失败需要继续退避，先恢复本次计数。
			this.reconnectAttempts = attempt;
			if (sessionPath) {
				try {
					const switched = await this.switchSession(sessionPath);
					this.assertEpochActive(epoch);
					if (switched.cancelled) {
						throw new Error("switch_session cancelled");
					}
				} catch (err) {
					if (!this.isEpochActive(epoch)) throw err;
					traceBridge(`reconnect-reattach-failed instance=${this.instanceId} attempt=${attempt}/${RpcBridge.RECONNECT_MAX_ATTEMPTS} session=${sessionPath}: ${err instanceof Error ? err.message : String(err)}`);
					// 进程已起但会话附着失败：停掉半成品进程，按退避重试完整重启。
					await this.stopProcessQuietly(epoch);
					return;
				}
			}
			this.assertEpochActive(epoch);
			this.reconnectAttempts = 0;
			traceBridge(`reconnect-ok instance=${this.instanceId} attempt=${attempt} session=${sessionPath ?? "-"}`);
			// 会话恢复完成：现在才公布 rpc_connected，随后再补发离线期间入队的消息。
			this.flushDeferredConnectedEvent();
			this.emitToListeners({ type: "rpc_reconnected", attempt });
			this.flushOfflineMessageQueue();
		} finally {
			// 失败路径（start 失败/附着失败）不派发被推迟的 rpc_connected。
			this.discardDeferredConnectedEvent();
		}
	}

	/** 停进程但不走 stop()：保留 supervisor 开关与离线消息队列。 */
	private async stopProcessQuietly(epoch: number): Promise<void> {
		this._isConnected = false;
		try {
			await invoke("rpc_stop", { instanceId: this.instanceId });
		} catch {
			// ignore: the process may already be gone
		}
		this.assertEpochActive(epoch);
	}

	private finalizeReconnectFailure(): void {
		if (this.reconnectFailureNotified) return;
		this.reconnectFailureNotified = true;
		traceBridge(`reconnect-exhausted instance=${this.instanceId} attempts=${this.reconnectAttempts}`);
		const message = "与 pi 进程的连接已断开，自动重连多次仍失败。";
		this.rejectOfflineMessageQueue(new Error(message));
		this.emitToListeners({
			type: "rpc_reconnect_failed",
			attempts: this.reconnectAttempts,
			errorMessage: message,
		});
	}

	private flushOfflineMessageQueue(): void {
		if (this.offlineMessageQueue.length === 0) return;
		this.offlineQueueFullNotified = false;
		const queued = this.offlineMessageQueue.splice(0, this.offlineMessageQueue.length);
		traceBridge(`offline-flush instance=${this.instanceId} count=${queued.length}`);
		for (const entry of queued) {
			void this.send(entry.command).then(
				() => entry.resolve(),
				(err) => entry.reject(err instanceof Error ? err : new Error(String(err))),
			);
		}
	}

	private rejectOfflineMessageQueue(reason: Error): void {
		if (this.offlineMessageQueue.length === 0) return;
		this.offlineQueueFullNotified = false;
		const queued = this.offlineMessageQueue.splice(0, this.offlineMessageQueue.length);
		for (const entry of queued) {
			entry.reject(reason);
		}
	}

	async teardownListeners(): Promise<void> {
		this.cancelReconnectTimer();
		this.rejectOfflineMessageQueue(new Error("RPC listeners torn down"));
		if (this.listenersReadyPromise) {
			await this.listenersReadyPromise.catch(() => {
				// ignore listener initialization races during teardown
			});
		}
		this.unlistenEvent?.();
		this.unlistenClosed?.();
		this.unlistenStderr?.();
		this.unlistenEvent = null;
		this.unlistenClosed = null;
		this.unlistenStderr = null;
		this.listenersReady = false;
		this.listenersReadyPromise = null;
	}
}

class ActiveRpcBridgeProxy {
	private activeBridge: RpcBridge;
	private listenerUnsubscribers = new Map<RpcEventCallback, () => void>();

	constructor(initialBridge: RpcBridge) {
		this.activeBridge = initialBridge;
	}

	setActiveBridge(bridge: RpcBridge): void {
		if (this.activeBridge === bridge) return;
		const preferredPiPath = this.activeBridge.getPreferredPiPath();
		const listeners = [...this.listenerUnsubscribers.keys()];
		for (const unlisten of this.listenerUnsubscribers.values()) {
			unlisten();
		}
		this.listenerUnsubscribers.clear();
		this.activeBridge = bridge;
		this.activeBridge.setPreferredPiPath(preferredPiPath);
		for (const listener of listeners) {
			this.listenerUnsubscribers.set(listener, this.activeBridge.onEvent(listener));
		}
	}

	getActiveBridge(): RpcBridge {
		return this.activeBridge;
	}

	get isConnected(): boolean {
		return this.activeBridge.isConnected;
	}

	get discoveryInfo(): string | null {
		return this.activeBridge.discoveryInfo;
	}

	setPreferredPiPath(path: string | null): void {
		this.activeBridge.setPreferredPiPath(path);
	}

	getPreferredPiPath(): string | null {
		return this.activeBridge.getPreferredPiPath();
	}

	getInstanceId(): string {
		return this.activeBridge.getInstanceId();
	}

	onEvent(callback: RpcEventCallback): () => void {
		const existing = this.listenerUnsubscribers.get(callback);
		existing?.();
		this.listenerUnsubscribers.set(callback, this.activeBridge.onEvent(callback));
		return () => {
			const current = this.listenerUnsubscribers.get(callback);
			current?.();
			this.listenerUnsubscribers.delete(callback);
		};
	}

	async start(options: RpcStartOptions): Promise<string> {
		return this.activeBridge.start(options);
	}

	async stop(): Promise<void> {
		return this.activeBridge.stop();
	}

	async stopAll(): Promise<void> {
		return this.activeBridge.stopAll();
	}

	async refreshRunningState(): Promise<boolean> {
		return this.activeBridge.refreshRunningState();
	}

	async prompt(message: string, options: RpcPromptOptions = {}): Promise<void> {
		return this.activeBridge.prompt(message, options);
	}

	async steer(message: string, images?: RpcImageInput[]): Promise<void> {
		return this.activeBridge.steer(message, images);
	}

	async followUp(message: string, images?: RpcImageInput[]): Promise<void> {
		return this.activeBridge.followUp(message, images);
	}

	async abort(): Promise<void> {
		return this.activeBridge.abort();
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		return this.activeBridge.newSession(parentSession);
	}

	async getState(): Promise<RpcSessionState> {
		return this.activeBridge.getState();
	}

	async setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
		return this.activeBridge.setModel(provider, modelId);
	}

	async cycleModel(): Promise<Record<string, unknown> | null> {
		return this.activeBridge.cycleModel();
	}

	async getAvailableModels(): Promise<Array<Record<string, unknown>>> {
		return this.activeBridge.getAvailableModels();
	}

	clearAvailableModelsCache(): void {
		this.activeBridge.clearAvailableModelsCache();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.activeBridge.setThinkingLevel(level);
	}

	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		return this.activeBridge.cycleThinkingLevel();
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		return this.activeBridge.setSteeringMode(mode);
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		return this.activeBridge.setFollowUpMode(mode);
	}

	async compact(customInstructions?: string): Promise<Record<string, unknown>> {
		return this.activeBridge.compact(customInstructions);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		return this.activeBridge.setAutoCompaction(enabled);
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		return this.activeBridge.setAutoRetry(enabled);
	}

	async abortRetry(): Promise<void> {
		return this.activeBridge.abortRetry();
	}

	async bash(command: string): Promise<Record<string, unknown>> {
		return this.activeBridge.bash(command);
	}

	async abortBash(): Promise<void> {
		return this.activeBridge.abortBash();
	}

	async getMessages(): Promise<Array<Record<string, unknown>>> {
		return this.activeBridge.getMessages();
	}

	async getSessionStats(): Promise<Record<string, unknown>> {
		return this.activeBridge.getSessionStats();
	}

	async getCommands(): Promise<Array<Record<string, unknown>>> {
		return this.activeBridge.getCommands();
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.activeBridge.switchSession(sessionPath);
	}

	async setSessionName(name: string): Promise<void> {
		return this.activeBridge.setSessionName(name);
	}

	async rewriteSessionBeforeUserEntry(entryId: string): Promise<SessionRewriteResult> {
		return this.activeBridge.rewriteSessionBeforeUserEntry(entryId);
	}

	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		return this.activeBridge.exportHtml(outputPath);
	}

	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		return this.activeBridge.getForkMessages();
	}

	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return this.activeBridge.fork(entryId);
	}

	async getEntries(since?: string): Promise<{ entries: Array<Record<string, unknown>>; leafId: string | null }> {
		return this.activeBridge.getEntries(since);
	}

	async getTree(): Promise<{ tree: Array<Record<string, unknown>>; leafId: string | null }> {
		return this.activeBridge.getTree();
	}

	async clone(): Promise<{ cancelled: boolean }> {
		return this.activeBridge.clone();
	}

	async getAvailableThinkingLevels(): Promise<string[]> {
		return this.activeBridge.getAvailableThinkingLevels();
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.activeBridge.getLastAssistantText();
	}

	async getSessionContent(sessionPath: string): Promise<string> {
		return this.activeBridge.getSessionContent(sessionPath);
	}

	async getSessionPage(sessionPath: string, beforeEntryId?: string | null, limit?: number): Promise<SessionPageResult> {
		return this.activeBridge.getSessionPage(sessionPath, beforeEntryId, limit);
	}

	async sendExtensionUiResponse(response: Record<string, unknown>): Promise<void> {
		return this.activeBridge.sendExtensionUiResponse(response);
	}

	async runPiCliCommand(
		args: string[],
		options: { cwd?: string; env?: Record<string, string>; cliPath?: string | null; piPath?: string | null } = {},
	): Promise<PiCliCommandResult> {
		return this.activeBridge.runPiCliCommand(args, options);
	}

	async runGitCommand(args: string[], options: { cwd?: string } = {}): Promise<GitCommandResult> {
		return this.activeBridge.runGitCommand(args, options);
	}

	async gitReviewStatus(cwd: string): Promise<GitReviewStatusResult> {
		return this.activeBridge.gitReviewStatus(cwd);
	}

	async gitReviewDiff(options: {
		cwd: string;
		scope: ReviewDiffScope;
		path: string;
		oldPath?: string | null;
	}): Promise<GitReviewDiffResult> {
		return this.activeBridge.gitReviewDiff(options);
	}

	async gitReviewStage(cwd: string, paths: string[]): Promise<void> {
		return this.activeBridge.gitReviewStage(cwd, paths);
	}

	async gitReviewUnstage(cwd: string, paths: string[]): Promise<void> {
		return this.activeBridge.gitReviewUnstage(cwd, paths);
	}

	async createShareGist(htmlPath: string): Promise<ShareGistResult> {
		return this.activeBridge.createShareGist(htmlPath);
	}

	async getPiAuthStatus(): Promise<PiAuthStatus> {
		return this.activeBridge.getPiAuthStatus();
	}

	async clearPiProviderAuth(provider: string): Promise<PiProviderAuthClearResult> {
		return this.activeBridge.clearPiProviderAuth(provider);
	}

	async getPiOAuthProviders(): Promise<PiOAuthProviderInfo[]> {
		return this.activeBridge.getPiOAuthProviders();
	}

	async getCliUpdateStatus(): Promise<CliUpdateStatus> {
		return this.activeBridge.getCliUpdateStatus();
	}

	async getPiChangelog(): Promise<PiChangelogResult> {
		return this.activeBridge.getPiChangelog();
	}

	async updateCliViaNpm(): Promise<NpmCommandResult> {
		return this.activeBridge.updateCliViaNpm();
	}

	async updateCliAndReport(): Promise<CliUpdateReport> {
		return this.activeBridge.updateCliAndReport();
	}

	async checkRpcCompatibility(): Promise<RpcCompatibilityReport> {
		return this.activeBridge.checkRpcCompatibility();
	}
}

const defaultRpcBridge = new RpcBridge("default");

export const rpcBridge = new ActiveRpcBridgeProxy(defaultRpcBridge);

export function setActiveRpcBridge(bridge: RpcBridge | null): void {
	rpcBridge.setActiveBridge(bridge ?? defaultRpcBridge);
}
