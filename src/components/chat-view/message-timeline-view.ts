import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import type { AssistantWorkflow, AssistantWorkflowCandidate, WorkflowRole } from "./workflow-utils.js";

interface TimelineMessage {
	id: string;
	role: WorkflowRole;
	text: string;
	label?: string;
	errorText?: string;
	renderAsMarkdown?: boolean;
	collapsibleTitle?: string;
	collapsibleExpanded?: boolean;
}

interface CompactionCycleViewModel {
	id: string;
	status: "running" | "done" | "aborted" | "error";
	startedAt: number;
	endedAt: number | null;
	summary: string;
	errorMessage: string | null;
	details: string[];
	expanded: boolean;
}

function getCompactionTitle(status: CompactionCycleViewModel["status"]): string {
	switch (status) {
		case "running":
			return t("timeline.compaction.running");
		case "done":
			return t("timeline.compaction.done");
		case "error":
			return t("timeline.compaction.failed");
		default:
			return t("timeline.compaction.aborted");
	}
}

interface RenderAssistantMessageRowParams<Message extends TimelineMessage> {
	message: Message;
	renderThinking: (message: Message) => TemplateResult | typeof nothing;
	isStandaloneCodeBlockMarkdown: (value: string) => boolean;
	copyIcon: TemplateResult;
	onCopyMessage: (message: Message) => void;
}

interface RenderSystemMessageRowParams<Message extends TimelineMessage> {
	message: Message;
}

interface RenderChangelogMessageRowParams<Message extends TimelineMessage> {
	message: Message;
	onToggleExpanded: (message: Message, nextExpanded: boolean) => void;
}

interface RenderCompactionCycleRowParams {
	cycle: CompactionCycleViewModel | null;
	piGlyphIcon: () => TemplateResult;
	onToggleExpanded: (nextExpanded: boolean) => void;
}

interface RenderMessageTimelineRowsParams<Message extends TimelineMessage> {
	messages: Message[];
	compactionCycle: CompactionCycleViewModel | null;
	compactionInsertIndex: number | null;
	collectAssistantWorkflow: (index: number) => AssistantWorkflowCandidate | null;
	renderAssistantWorkflow: (workflow: AssistantWorkflow) => TemplateResult;
	renderUserMessage: (message: Message) => TemplateResult;
	hasRenderableAssistantContent: (message: Message) => boolean;
	renderAssistantMessage: (message: Message) => TemplateResult;
	renderChangelogMessage: (message: Message) => TemplateResult;
	renderSystemMessage: (message: Message) => TemplateResult;
	renderCompactionCycle: () => TemplateResult | typeof nothing;
}

export function renderAssistantMessageRow<Message extends TimelineMessage>({
	message,
	renderThinking,
	isStandaloneCodeBlockMarkdown,
	copyIcon,
	onCopyMessage,
}: RenderAssistantMessageRowParams<Message>): TemplateResult {
	const trimmedText = message.text.trim();
	const errorLine = (message.errorText ?? "").trim();
	const standaloneCodeBlock = isStandaloneCodeBlockMarkdown(trimmedText);
	const canCopy = Boolean(errorLine.length > 0 || (trimmedText.length > 0 && !standaloneCodeBlock));
	const formattedErrorLine = errorLine
		? (/^error\b[:\s-]*/i.test(errorLine) ? errorLine : t("timeline.errors.prefix", { message: errorLine }))
		: "";

	return html`
		<div class="chat-row assistant-row" data-message-id=${message.id}>
			<div class="message-shell assistant-message-shell">
				<div class="assistant-block">
					${renderThinking(message)}
					${message.text
						? html`
							<div class="assistant-content">
								<markdown-block .content=${message.text}></markdown-block>
							</div>
						`
						: nothing}
					${formattedErrorLine ? html`<div class="assistant-error-line">${formattedErrorLine}</div>` : nothing}
				</div>
				<div class="message-actions">
						${canCopy
							? html`<button class="message-action-btn icon" title=${t("timeline.copyMessage")} @click=${() => onCopyMessage(message)}>${copyIcon}</button>`
							: nothing}
				</div>
			</div>
		</div>
	`;
}

interface RenderUserMessageEditRowParams<Message extends TimelineMessage> {
	message: Message;
	draft: string;
	canSend: boolean;
	onEditInput: (event: Event) => void;
	onEditKeyDown: (event: KeyboardEvent) => void;
	onEditCancel: () => void;
	onEditSend: () => void;
}

/**
 * 「编辑并重发」的就地编辑行：用户消息气泡就地变成编辑器（预填原文），
 * 全程不占用底部 composer。Cmd/Ctrl+Enter 发送，Esc 取消。
 */
export function renderUserMessageEditRow<Message extends TimelineMessage>({
	message,
	draft,
	canSend,
	onEditInput,
	onEditKeyDown,
	onEditCancel,
	onEditSend,
}: RenderUserMessageEditRowParams<Message>): TemplateResult {
	return html`
		<div class="chat-row user-row user-row-editing" data-message-id=${message.id}>
			<div class="message-shell user-message-shell">
				<div class="bubble user-bubble user-bubble-editing">
					<textarea
						class="user-edit-input"
						rows="1"
						aria-label=${t("chatView.message.editResend")}
						.value=${draft}
						@input=${onEditInput}
						@keydown=${onEditKeyDown}
					></textarea>
					<div class="user-edit-actions">
						<button
							type="button"
							class="user-edit-cancel"
							title=${t("chatView.message.editCancelTitle")}
							@click=${onEditCancel}
						>
							${t("common.cancel")}
						</button>
						<button
							type="button"
							class="user-edit-send"
							title=${t("chatView.message.editSendTitle")}
							?disabled=${!canSend}
							@click=${onEditSend}
						>
							${t("chatView.message.editSend")}
						</button>
					</div>
				</div>
			</div>
		</div>
	`;
}

export function renderSystemMessageRow<Message extends TimelineMessage>({ message }: RenderSystemMessageRowParams<Message>): TemplateResult {
	const isInline = message.label === "share" || message.label === "auth" || message.label === "models";
	return html`
		<div class="chat-row system-row ${isInline ? "system-row-inline" : ""}" data-message-id=${message.id}>
			<div class="system-message ${isInline ? "system-message-inline" : ""}">
				${message.label ? html`<div class="system-label ${isInline ? "system-label-inline" : ""}">${message.label}</div>` : nothing}
				<div class="system-text ${isInline ? "system-text-inline" : ""}">
					${message.renderAsMarkdown ? html`<markdown-block .content=${message.text}></markdown-block>` : message.text}
				</div>
			</div>
		</div>
	`;
}

export function renderChangelogMessageRow<Message extends TimelineMessage>({
	message,
	onToggleExpanded,
}: RenderChangelogMessageRowParams<Message>): TemplateResult {
	const expanded = Boolean(message.collapsibleExpanded);
	const title = message.collapsibleTitle?.trim() || t("timeline.changelog.defaultTitle");
	return html`
		<div class="chat-row assistant-row assistant-workflow-row changelog-row" data-message-id=${message.id}>
			<div class="message-shell assistant-message-shell">
				<div class="assistant-block">
					<div class="changelog-inline">
						<button
							type="button"
							class="tool-workflow-line changelog-inline-toggle"
							aria-expanded=${expanded ? "true" : "false"}
							@click=${() => {
								onToggleExpanded(message, !expanded);
							}}
						>
							<span class="tool-workflow-line-text">${title}</span>
							<span class="tool-workflow-count">${expanded ? t("timeline.changelog.hide") : t("timeline.changelog.show")}</span>
						</button>
						${expanded
							? html`
								<div class="tool-workflow-details changelog-inline-details">
									<div class="tool-workflow-output changelog-inline-output">
										<markdown-block .content=${message.text}></markdown-block>
									</div>
								</div>
							`
							: nothing}
					</div>
				</div>
			</div>
		</div>
	`;
}

export function renderCompactionCycleRow({
	cycle,
	piGlyphIcon,
	onToggleExpanded,
}: RenderCompactionCycleRowParams): TemplateResult | typeof nothing {
	if (!cycle) return nothing;
	const completed = cycle.endedAt ?? Date.now();
	const elapsedSeconds = Math.max(1, Math.round((completed - cycle.startedAt) / 1000));
	const elapsed = `${elapsedSeconds}s`;
	const title = getCompactionTitle(cycle.status);
	const normalizedSummary = cycle.summary.trim().toLowerCase();
	// 英文条目用于兼容并行迁移期间可能仍为英文的 summary 取值。
	const duplicateSummaries = [
		t("timeline.compaction.running"),
		t("timeline.compaction.done"),
		t("timeline.compaction.failed"),
		t("timeline.compaction.aborted"),
		"compaction complete",
		"compaction failed",
		"compaction aborted",
		"compacting context…",
		"compacting context",
	].map((value) => value.toLowerCase());
	const showSummaryLine =
		cycle.status !== "running" && Boolean(cycle.summary.trim()) && !duplicateSummaries.includes(normalizedSummary);
	return html`
		<div class="chat-row assistant-row assistant-workflow-row compaction-row" data-message-id=${cycle.id}>
			<div class="message-shell assistant-message-shell">
				<div class="assistant-block">
					<div class="compaction-inline">
						<button
							type="button"
							class="tool-workflow-line compaction-inline-toggle"
							aria-expanded=${cycle.expanded ? "true" : "false"}
							@click=${() => {
								onToggleExpanded(!cycle.expanded);
							}}
						>
							${cycle.status === "running" ? html`<span class="tool-workflow-inline-pi" aria-hidden="true">${piGlyphIcon()}</span>` : nothing}
							<span class="tool-workflow-line-text ${cycle.status === "running" ? "running" : ""}">${title}</span>
							<span class="tool-workflow-count">${elapsed}</span>
						</button>
						${cycle.expanded
							? html`
								<div class="tool-workflow-details compaction-inline-details">
									${showSummaryLine ? html`<div class="tool-workflow-output compaction-inline-summary">${cycle.summary}</div>` : nothing}
									${cycle.errorMessage ? html`<div class="tool-workflow-output compaction-inline-error">${cycle.errorMessage}</div>` : nothing}
									${cycle.details.map((line) => html`<div class="tool-workflow-output compaction-inline-line">${line}</div>`)}
								</div>
							`
							: nothing}
					</div>
				</div>
			</div>
		</div>
	`;
}

export function renderMessageTimelineRows<Message extends TimelineMessage>({
	messages,
	compactionCycle,
	compactionInsertIndex,
	collectAssistantWorkflow,
	renderAssistantWorkflow,
	renderUserMessage,
	hasRenderableAssistantContent,
	renderAssistantMessage,
	renderChangelogMessage,
	renderSystemMessage,
	renderCompactionCycle,
}: RenderMessageTimelineRowsParams<Message>): TemplateResult[] {
	const rows: TemplateResult[] = [];
	const compactionInsertAt = compactionCycle
		? Math.max(0, Math.min(compactionInsertIndex ?? messages.length, messages.length))
		: null;
	let compactionInserted = false;
	const maybeInsertCompaction = (position: number): void => {
		if (compactionInserted) return;
		if (compactionInsertAt === null) return;
		if (position !== compactionInsertAt) return;
		const row = renderCompactionCycle();
		if (row !== nothing) {
			rows.push(row as TemplateResult);
		}
		compactionInserted = true;
	};

	for (let index = 0; index < messages.length; index += 1) {
		maybeInsertCompaction(index);
		const message = messages[index];
		if (!message) continue;
		if (message.role === "assistant") {
			const workflowCandidate = collectAssistantWorkflow(index);
			if (workflowCandidate) {
				rows.push(renderAssistantWorkflow(workflowCandidate.workflow));
				index = workflowCandidate.nextIndex - 1;
				continue;
			}
		}
		if (message.role === "user") {
			rows.push(renderUserMessage(message));
			continue;
		}
		if (message.role === "assistant") {
			if (!hasRenderableAssistantContent(message)) {
				continue;
			}
			rows.push(renderAssistantMessage(message));
			continue;
		}
		if (message.label === "changelog" || Boolean(message.collapsibleTitle)) {
			rows.push(renderChangelogMessage(message));
			continue;
		}
		rows.push(renderSystemMessage(message));
	}
	maybeInsertCompaction(messages.length);
	return rows;
}
