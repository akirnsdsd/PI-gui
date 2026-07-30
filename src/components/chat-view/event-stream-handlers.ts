import { t } from "../../i18n/index.js";

type NoticeKind = "info" | "success" | "error";

/**
 * 进行中工具输出的保留上限。长时间运行的工具（子智能体、大部头命令）可能推出
 * 几十 MB 文本；完整保留在内存里并参与每帧 diff 既无意义也会拖死渲染。
 * 保尾不保头：流式过程中用户关心的是最新进展；收尾的完整结果仍由
 * tool_execution_end 的 result 接管。
 */
const STREAMING_TOOL_OUTPUT_MAX_CHARS = 200_000;

/** 压缩进度明细的条数上限（每条已限 220 字符，但条数原本无限）。 */
const COMPACTION_DETAIL_MAX_ENTRIES = 200;

function clampStreamingToolOutput(text: string): string {
	if (text.length <= STREAMING_TOOL_OUTPUT_MAX_CHARS) return text;
	const kept = text.slice(text.length - STREAMING_TOOL_OUTPUT_MAX_CHARS);
	return `${t("timeline.tool.streamingOutputTruncated")}\n${kept}`;
}

interface ToolCallLike {
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

interface MessageLike {
	role: string;
	text: string;
	toolCalls: ToolCallLike[];
	thinking?: string;
	isStreaming?: boolean;
	isThinkingStreaming?: boolean;
	errorText?: string;
	endedAt?: number;
}

interface EnsureStreamingAssistantMessageOptions {
	text?: string;
	errorText?: string;
}

interface HandleMessageStreamEventContext {
	promoteQueuedMessageFromUserEvent: (message: Record<string, unknown>) => void;
	getLastMessage: () => MessageLike | null;
	ensureStreamingAssistantMessage: (options?: EnsureStreamingAssistantMessageOptions) => MessageLike;
	extractText: (content: unknown) => string;
	extractAssistantMessageError: (message: Record<string, unknown> | null | undefined) => string;
	markAssistantTextObserved: () => void;
	markToolActivityObserved: () => void;
	extractToolOutput: (payload: unknown) => string;
	findToolCall: (id: string) => ToolCallLike | null;
	findMostRecentRunningToolByName: (name: string) => ToolCallLike | null;
	attachOrphanToolResult: (toolName: string, output: string, isError: boolean) => void;
	render: () => void;
	/**
	 * 高频流式事件专用的节流渲染（rAF 合帧 + 最小间隔）。
	 * 只用于 delta / tool 进度这类可以掉帧的更新；状态转折点（开始/结束/错误）
	 * 仍用 render() 立即落地，否则会看到滞后的终态。
	 */
	scheduleStreamRender: () => void;
	scrollToBottom: () => void;
	extractRuntimeErrorMessage: (event: Record<string, unknown> | null | undefined) => string;
	extractAssistantPartialContent: (assistantEvent: Record<string, unknown>, mode: "text" | "thinking") => string | null;
	mergeStreamingText: (current: string, partial: string | null, deltaCandidate: unknown) => string;
	scheduleStreamingUiReconcile: (delayMs?: number) => void;
	createId: (prefix?: string) => string;
}

interface CompactionCycleLike {
	id: string;
	status: "running" | "done" | "aborted" | "error";
	startedAt: number;
	endedAt: number | null;
	summary: string;
	errorMessage: string | null;
	details: string[];
	expanded: boolean;
}

interface HandleCompactionAndRetryEventContext {
	messagesLength: () => number;
	getCompactionCycle: () => CompactionCycleLike | null;
	setCompactionCycle: (cycle: CompactionCycleLike | null) => void;
	setCompactionInsertIndex: (index: number | null) => void;
	createId: (prefix?: string) => string;
	extractToolOutput: (payload: unknown) => string;
	extractRuntimeErrorMessage: (event: Record<string, unknown> | null | undefined) => string;
	truncate: (value: string, len: number) => string;
	pushNotice: (text: string, kind: NoticeKind) => void;
	pushRuntimeNotice: (text: string, kind?: NoticeKind, dedupeMs?: number) => void;
	markContextUsageUnknown: () => void;
	refreshAfterCompaction: () => void;
	setRetryStatus: (status: string) => void;
	appendSystemMessage: (text: string, options?: { idPrefix?: string }) => void;
	render: () => void;
	/** 同 HandleMessageStreamEventContext.scheduleStreamRender，供高频压缩进度使用。 */
	scheduleStreamRender: () => void;
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
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.length > 0) return trimmed;
		}
	}
	return null;
}

function pickNumber(source: Record<string, unknown>, paths: string[]): number | null {
	for (const path of paths) {
		const value = readPath(source, path);
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}

export function handleMessageStreamEvent(
	type: string,
	event: Record<string, unknown>,
	context: HandleMessageStreamEventContext,
): boolean {
	switch (type) {
		case "message_start": {
			const message = event.message as Record<string, unknown>;
			const role = typeof message.role === "string" ? message.role : "";
			if (role === "user") {
				context.promoteQueuedMessageFromUserEvent(message);
				return true;
			}
			if (role === "assistant") {
				const last = context.getLastMessage();
				if (last?.role === "assistant" && last.isStreaming) {
					return true;
				}
				const initialText = context.extractText(message.content);
				const assistantError = context.extractAssistantMessageError(message);
				if (initialText.trim().length === 0 && !assistantError) {
					return true;
				}
				context.ensureStreamingAssistantMessage({
					text: initialText,
					errorText: assistantError || undefined,
				});
				if (initialText.trim().length > 0) {
					context.markAssistantTextObserved();
				}
				context.render();
				context.scrollToBottom();
				return true;
			}

			if (role === "toolResult") {
				context.markToolActivityObserved();
				const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
				const output = context.extractToolOutput(message.content ?? message.result ?? message);
				const isError = Boolean(message.isError);
				const toolName = typeof message.toolName === "string" ? message.toolName : "";
				let tool = toolCallId ? context.findToolCall(toolCallId) : null;
				if (!tool && toolName) {
					tool = context.findMostRecentRunningToolByName(toolName);
				}
				if (tool) {
					tool.result = output || t("timeline.tools.noOutput");
					tool.isError = isError;
					tool.isRunning = false;
					tool.streamingOutput = undefined;
					tool.isExpanded = false;
					tool.endedAt = Date.now();
					if (!tool.startedAt) tool.startedAt = tool.endedAt;
				} else {
					context.attachOrphanToolResult(toolName, output, isError);
				}
				context.render();
				context.scrollToBottom();
				return true;
			}
			return true;
		}

		case "message_update": {
			const assistantEvent = event.assistantMessageEvent as Record<string, unknown>;
			if (!assistantEvent) return true;
			const subtype = typeof assistantEvent.type === "string" ? assistantEvent.type : "";

			if (subtype === "error") {
				const streamError = context.extractRuntimeErrorMessage(assistantEvent) || context.extractRuntimeErrorMessage(event);
				const assistant = context.ensureStreamingAssistantMessage(streamError ? { errorText: streamError } : undefined);
				assistant.isStreaming = false;
				assistant.isThinkingStreaming = false;
				if (streamError) {
					assistant.errorText = streamError;
				}
				context.render();
				return true;
			}

			if (subtype === "text_delta") {
				const assistant = context.ensureStreamingAssistantMessage();
				const partialText = context.extractAssistantPartialContent(assistantEvent, "text");
				assistant.text = context.mergeStreamingText(assistant.text, partialText, assistantEvent.delta);
				assistant.isThinkingStreaming = false;
				if (assistant.text.trim().length > 0) {
					context.markAssistantTextObserved();
				}
				context.scheduleStreamingUiReconcile(1800);
				context.scheduleStreamRender();
				context.scrollToBottom();
				return true;
			}

			if (subtype === "thinking_delta" || subtype === "reasoning_delta" || subtype.includes("thinking") || subtype.includes("reason")) {
				const assistant = context.ensureStreamingAssistantMessage();
				const partialThinking = context.extractAssistantPartialContent(assistantEvent, "thinking");
				const currentThinking = assistant.thinking || "";
				assistant.thinking = context.mergeStreamingText(currentThinking, partialThinking, assistantEvent.delta);
				assistant.isThinkingStreaming = true;
				context.scheduleStreamingUiReconcile(1800);
				// 旧写法是「length % 100 === 0 才渲染」：取模很容易永不命中（单次增量不是 1 字符时
				// 会跳过 100 的倍数），思考文本会整段不刷。改成时间维度的真节流。
				context.scheduleStreamRender();
				return true;
			}

			if (subtype === "toolcall_end") {
				context.markToolActivityObserved();
				const assistant = context.ensureStreamingAssistantMessage();
				assistant.isThinkingStreaming = false;
				const toolCall = assistantEvent.toolCall as Record<string, unknown>;
				if (toolCall) {
					const rawId = typeof toolCall.id === "string" ? toolCall.id.trim() : "";
					const id = rawId || context.createId("tc");
					const existing = assistant.toolCalls.find((entry) => entry.id === id);
					if (existing) {
						existing.name =
							typeof toolCall.name === "string" && toolCall.name.trim().length > 0 ? toolCall.name : existing.name;
						existing.args = ((toolCall.arguments ?? existing.args) as Record<string, unknown>) || existing.args;
						existing.isRunning = true;
						existing.isExpanded = false;
						existing.startedAt = existing.startedAt ?? Date.now();
						existing.endedAt = undefined;
					} else {
						assistant.toolCalls.push({
							id,
							name: (toolCall.name as string) || t("timeline.tools.fallbackName"),
							args: ((toolCall.arguments ?? {}) as Record<string, unknown>) || {},
							isRunning: true,
							isExpanded: false,
							startedAt: Date.now(),
						});
					}
					context.render();
				}
				return true;
			}

			return true;
		}

		case "turn_end": {
			const turnMessage = event.message as Record<string, unknown> | undefined;
			const turnRole = typeof turnMessage?.role === "string" ? turnMessage.role : "";
			if (turnRole === "assistant") {
				const last = context.getLastMessage();
				if (last?.role === "assistant") {
					last.isStreaming = false;
					last.isThinkingStreaming = false;
					last.endedAt = last.endedAt ?? Date.now();
					const turnError = context.extractAssistantMessageError(turnMessage);
					if (turnError) {
						last.errorText = turnError;
					}
				}
				context.render();
			}
			return true;
		}

		case "message_end": {
			const last = context.getLastMessage();
			if (last?.role === "assistant") {
				last.isStreaming = false;
				last.isThinkingStreaming = false;
				last.endedAt = last.endedAt ?? Date.now();
				const completed = event.message as Record<string, unknown> | undefined;
				const completedError = context.extractAssistantMessageError(completed);
				if (completedError) {
					last.errorText = completedError;
				}
			}
			context.scheduleStreamingUiReconcile(350);
			context.render();
			return true;
		}

		case "tool_execution_start": {
			const id = event.toolCallId as string | undefined;
			if (!id) return true;
			const tool = context.findToolCall(id);
			if (tool) {
				tool.isRunning = true;
				tool.isExpanded = false;
				tool.startedAt = tool.startedAt ?? Date.now();
				tool.endedAt = undefined;
				context.render();
			}
			return true;
		}

		case "tool_execution_update": {
			const toolCallId = event.toolCallId as string | undefined;
			const partialResult = event.partialResult as Record<string, unknown> | undefined;
			if (!toolCallId || !partialResult) return true;
			const tool = context.findToolCall(toolCallId);
			if (!tool) return true;
			const partialText = context.extractToolOutput(partialResult);
			if (partialText) {
				const currentOutput = tool.streamingOutput ?? tool.result ?? "";
				tool.streamingOutput = clampStreamingToolOutput(
					context.mergeStreamingText(currentOutput, partialText, partialResult.delta),
				);
			}
			tool.isRunning = true;
			// 进行中的工具输出用节流渲染：有些工具（典型如 subagent 扩展）每次 onUpdate
			// 发的是累积全量文本，直连 render() 会随输出长度退化成 O(n²) 并卡死窗口。
			context.scheduleStreamRender();
			context.scrollToBottom();
			return true;
		}

		case "tool_execution_end": {
			const toolCallId = event.toolCallId as string | undefined;
			if (!toolCallId) return true;
			const result = event.result as Record<string, unknown> | string | undefined;
			const isError = Boolean(event.isError);
			const tool = context.findToolCall(toolCallId);
			if (!tool) return true;
			tool.isRunning = false;
			tool.streamingOutput = undefined;
			tool.isError = isError;
			if (typeof result === "string") {
				tool.result = result;
			} else if (result && typeof result === "object") {
				const content = context.extractToolOutput(result);
				tool.result = content || t("timeline.tools.noOutput");
			} else {
				tool.result = tool.result || t("timeline.tools.noOutput");
			}
			tool.isExpanded = false;
			tool.endedAt = Date.now();
			if (!tool.startedAt) tool.startedAt = tool.endedAt;
			context.render();
			context.scrollToBottom();
			return true;
		}

		default:
			return false;
	}
}

export function handleCompactionAndRetryEvent(
	type: string,
	event: Record<string, unknown>,
	context: HandleCompactionAndRetryEventContext,
): boolean {
	switch (type) {
		// pi ≥0.81 emits `compaction_start`; older builds emitted `auto_compaction_start`.
		case "compaction_start":
		case "auto_compaction_start": {
			context.setCompactionInsertIndex(context.messagesLength());
			context.setCompactionCycle({
				id: context.createId("compaction"),
				status: "running",
				startedAt: Date.now(),
				endedAt: null,
				summary: t("timeline.compaction.running"),
				errorMessage: null,
				details: [t("timeline.compaction.started")],
				expanded: false,
			});
			context.render();
			return true;
		}

		case "auto_compaction_update":
		case "auto_compaction_progress": {
			const compactionCycle = context.getCompactionCycle();
			if (!compactionCycle) return true;
			const detail =
				pickString(event, ["message", "status", "phase", "step", "detail"]) ||
				context.extractToolOutput(event.detail ?? event.payload ?? event).trim();
			if (detail) {
				const cleaned = context.truncate(detail.replace(/\s+/g, " ").trim(), 220);
				if (cleaned && compactionCycle.details[compactionCycle.details.length - 1] !== cleaned) {
					compactionCycle.details.push(cleaned);
					// 列表上限：details 的每一条都来自外部事件，只限单条 220 字符不限条数
					// 等于没设上限。丢最早的：压缩进度里用户关心的是最新几步。
					if (compactionCycle.details.length > COMPACTION_DETAIL_MAX_ENTRIES) {
						compactionCycle.details.splice(0, compactionCycle.details.length - COMPACTION_DETAIL_MAX_ENTRIES);
					}
				}
			}
			// 压缩进度是高频且可丢帧的：同 tool_execution_update 一样走节流，
			// 压缩的开始/结束转折点仍用 render() 立即落地。
			context.scheduleStreamRender();
			return true;
		}

		// pi ≥0.81 emits `compaction_end`; older builds emitted `auto_compaction_end`.
		case "compaction_end":
		case "auto_compaction_end": {
			const aborted = Boolean(event.aborted);
			const errorMessage = context.extractRuntimeErrorMessage(event);
			let compactionCycle = context.getCompactionCycle();
			if (!compactionCycle) {
				context.setCompactionInsertIndex(context.messagesLength());
				compactionCycle = {
					id: context.createId("compaction"),
					status: "running",
					startedAt: Date.now(),
					endedAt: null,
					summary: t("timeline.compaction.running"),
					errorMessage: null,
					details: [],
					expanded: false,
				};
				context.setCompactionCycle(compactionCycle);
			}
			compactionCycle.endedAt = Date.now();
			if (aborted) {
				compactionCycle.status = "aborted";
				compactionCycle.summary = t("timeline.compaction.aborted");
				compactionCycle.details.push(t("timeline.compaction.abortedDetail"));
				context.pushNotice(t("timeline.compaction.abortedNotice"), "info");
			} else if (errorMessage) {
				compactionCycle.status = "error";
				compactionCycle.summary = t("timeline.compaction.failed");
				compactionCycle.errorMessage = context.truncate(errorMessage, 220);
				compactionCycle.details.push(t("timeline.compaction.failureDetail", { message: context.truncate(errorMessage, 220) }));
				context.pushRuntimeNotice(t("timeline.compaction.failedNotice", { message: context.truncate(errorMessage, 180) }), "error", 2600);
			} else {
				compactionCycle.status = "done";
				compactionCycle.summary = t("timeline.compaction.done");
				const tokensBefore = pickNumber(event, ["result.tokensBefore", "tokensBefore", "tokens_before"]);
				if (typeof tokensBefore === "number" && Number.isFinite(tokensBefore)) {
					compactionCycle.details.push(t("timeline.compaction.tokensBefore", { tokens: Math.round(tokensBefore).toLocaleString() }));
				}
				compactionCycle.details.push(t("timeline.compaction.doneDetail"));
				context.markContextUsageUnknown();
				context.pushNotice(t("timeline.compaction.doneNotice"), "success");
				context.refreshAfterCompaction();
			}
			context.render();
			return true;
		}

		case "auto_retry_start": {
			const attempt = typeof event.attempt === "number" ? event.attempt : 1;
			const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : 1;
			const delayMs = typeof event.delayMs === "number" ? event.delayMs : 0;
			const errorMessage = context.extractRuntimeErrorMessage(event);
			const waiting = t("timeline.retry.waiting", {
				seconds: (delayMs / 1000).toFixed(1),
				attempt,
				max: maxAttempts,
			});
			context.setRetryStatus(waiting);
			const retryLine = errorMessage ? `${waiting} · ${context.truncate(errorMessage, 150)}` : waiting;
			context.appendSystemMessage(retryLine, { idPrefix: "runtime" });
			context.render();
			return true;
		}

		case "auto_retry_end": {
			const success = Boolean(event.success);
			const attempt = typeof event.attempt === "number" ? event.attempt : null;
			context.setRetryStatus("");
			if (!success) {
				const finalError = context.extractRuntimeErrorMessage(event) || t("timeline.retry.unknownFailure");
				context.pushRuntimeNotice(t("timeline.retry.failed", { message: context.truncate(finalError, 180) }), "error", 2600);
			} else {
				context.appendSystemMessage(
					attempt ? t("timeline.retry.succeededAttempt", { attempt }) : t("timeline.retry.succeeded"),
					{ idPrefix: "runtime" },
				);
			}
			context.render();
			return true;
		}

		case "summarization_retry_scheduled":
		case "summarization_retry_attempt_start":
		case "summarization_retry_finished": {
			// pi ≥0.81 summarization retry telemetry: transient compaction/branch-summary
			// retries are handled inside pi; the desktop UI just logs them.
			console.debug(`[chat-view] ignoring ${type}`, event);
			return true;
		}

		default:
			return false;
	}
}
