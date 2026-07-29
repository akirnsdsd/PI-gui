import { t } from "../../i18n/index.js";

type NoticeKind = "info" | "success" | "error";

interface RuntimeMessageLike {
	role: string;
	errorText?: string;
	isStreaming?: boolean;
	isThinkingStreaming?: boolean;
	endedAt?: number;
}

interface HandleRuntimeStatusEventContext {
	projectPath: string | null;
	isLoadingModels: () => boolean;
	isRpcConnected: () => boolean;
	getLastMessage: () => RuntimeMessageLike | null;
	setConnected: (connected: boolean) => void;
	setBindingStatusText: (text: string | null) => void;
	clearDisconnectNoticeTimer: () => void;
	scheduleDisconnectNoticeTimer: (callback: () => void, delayMs: number) => void;
	setLoadingModels: (loading: boolean) => void;
	bumpModelLoadRequestSeq: () => void;
	cancelStreamingUiReconcile: () => void;
	scheduleStreamingUiReconcile: (delayMs?: number) => void;
	setPendingDeliveryMode: (mode: "prompt" | "steer") => void;
	setRunFlags: (flags: { hasAssistantText: boolean; sawToolActivity: boolean; keepWorkflowExpanded: boolean }) => void;
	clearCollapsedAutoWorkflowIds: () => void;
	setStateStreaming: (streaming: boolean) => void;
	setAutoFollowChat: (next: boolean) => void;
	onRunStateChange: (running: boolean) => void;
	setRetryStatus: (status: string) => void;
	pushRuntimeNotice: (text: string, kind?: NoticeKind, dedupeMs?: number) => void;
	pushNotice: (text: string, kind: NoticeKind) => void;
	extractRuntimeErrorMessage: (event: Record<string, unknown> | null | undefined) => string;
	truncate: (value: string, len: number) => string;
	extensionLabelFromPath: (pathValue: string | null | undefined) => string;
	maybePushExtensionCompatibilityHint: (event: Record<string, unknown>, errorMessage: string) => void;
	render: () => void;
	scrollToBottom: () => void;
	refreshFromBackend: () => Promise<void>;
	loadAvailableModels: () => Promise<void>;
	refreshStateAfterAgentEnd: () => void;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = source;
	for (const part of parts) {
		if (!current || typeof current !== "object") return null;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function pickString(source: Record<string, unknown>, paths: string[]): string | null {
	for (const path of paths) {
		const value = readPath(source, path);
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return null;
}

export function handleRuntimeStatusEvent(
	type: string,
	event: Record<string, unknown>,
	context: HandleRuntimeStatusEventContext,
): boolean {
	switch (type) {
		case "agent_start": {
			context.setPendingDeliveryMode("steer");
			context.setRunFlags({
				hasAssistantText: false,
				sawToolActivity: false,
				keepWorkflowExpanded: true,
			});
			context.clearCollapsedAutoWorkflowIds();
			context.setStateStreaming(true);
			context.setAutoFollowChat(true);
			context.onRunStateChange(true);
			context.scheduleStreamingUiReconcile(2400);
			context.render();
			context.scrollToBottom();
			return true;
		}

		case "agent_end":
		case "agent_settled": {
			// `agent_end` ends one low-level run (retries/compaction may follow);
			// `agent_settled` (pi ≥0.81) means the run is fully done. Both converge
			// on the same UI cleanup; the settled event makes the final state stick.
			if (type === "agent_end" && event.willRetry === true) {
				// A retry is already scheduled: keep the streaming UI alive and wait
				// for the follow-up activity instead of tearing the run down.
				context.scheduleStreamingUiReconcile(1200);
				context.render();
				return true;
			}
			context.cancelStreamingUiReconcile();
			context.setStateStreaming(false);
			const last = context.getLastMessage();
			if (last && last.role === "assistant") {
				last.isStreaming = false;
				last.isThinkingStreaming = false;
				last.endedAt = last.endedAt ?? Date.now();
			}
			context.setRetryStatus("");
			const runError = context.extractRuntimeErrorMessage(event);
			if (runError && !(last?.role === "assistant" && last.errorText)) {
				context.pushRuntimeNotice(t("timeline.runtime.runFailed", { message: context.truncate(runError, 180) }), "error", 2600);
			}
			context.setRunFlags({
				hasAssistantText: false,
				sawToolActivity: false,
				keepWorkflowExpanded: false,
			});
			context.onRunStateChange(false);
			context.refreshStateAfterAgentEnd();
			context.render();
			return true;
		}

		case "error": {
			const errorMessage = context.extractRuntimeErrorMessage(event) || t("timeline.runtime.unknownError");
			const source = pickString(event, ["source", "phase", "stage", "provider", "code"]);
			if (source === "stderr" || source === "stdout_text") {
				const line = /^error\b[:\s-]*/i.test(errorMessage)
					? errorMessage
					: t("timeline.errors.prefix", { message: errorMessage });
				context.pushRuntimeNotice(context.truncate(line, 220), "error", 2600);
			} else {
				context.pushRuntimeNotice(
					source
						? t("timeline.runtime.errorWithSource", { source, message: context.truncate(errorMessage, 180) })
						: t("timeline.runtime.error", { message: context.truncate(errorMessage, 180) }),
					"error",
					2600,
				);
			}
			return true;
		}

		case "extension_error": {
			const error = context.extractRuntimeErrorMessage(event) || t("timeline.runtime.unknownExtensionError");
			const extensionPath = pickString(event, ["extensionPath", "extension"]);
			const extensionLabel = context.extensionLabelFromPath(extensionPath);
			const source = pickString(event, ["event", "source", "callback", "method", "provider"]);
			context.pushRuntimeNotice(
				source
					? t("timeline.runtime.extensionErrorWithSource", {
							label: extensionLabel,
							source,
							message: context.truncate(error, 180),
						})
					: t("timeline.runtime.extensionError", { label: extensionLabel, message: context.truncate(error, 180) }),
				"error",
				2600,
			);
			context.maybePushExtensionCompatibilityHint(event, error);
			return true;
		}

		case "rpc_connected": {
			context.setConnected(true);
			context.setBindingStatusText(context.projectPath ? t("timeline.runtime.loadingSession") : null);
			context.clearDisconnectNoticeTimer();
			context.render();
			if (context.projectPath) {
				void context.refreshFromBackend();
				if (!context.isLoadingModels()) {
					void context.loadAvailableModels();
				}
			}
			return true;
		}

		case "rpc_disconnected": {
			context.setConnected(false);
			context.cancelStreamingUiReconcile();
			context.setBindingStatusText(context.projectPath ? t("timeline.runtime.reconnectingSession") : null);
			context.bumpModelLoadRequestSeq();
			context.setLoadingModels(false);
			context.clearDisconnectNoticeTimer();
			// bridge supervisor 会自动重连（退避最长约 30s+，最终失败由 main.ts 弹明确错误），
			// 这里的兜底提示窗口必须大于整个重连窗口，避免重连进行中误报「连接已断开」。
			context.scheduleDisconnectNoticeTimer(() => {
				if (!context.isRpcConnected()) {
					context.pushNotice(t("timeline.runtime.disconnected"), "error");
					context.render();
				}
			}, 60_000);
			return true;
		}

		case "rpc_reconnecting": {
			// 自动重连开始：取消兜底断线提示，保持「正在重连」状态文案
			context.clearDisconnectNoticeTimer();
			context.setBindingStatusText(context.projectPath ? t("timeline.runtime.reconnectingSession") : null);
			context.render();
			return true;
		}

		default:
			return false;
	}
}
