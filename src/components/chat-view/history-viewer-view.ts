import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import type { SettingsSelectDropdown } from "../settings-select-dropdown.js";
import type { ForkOption, HistoryTreeRow, HistoryViewerMessage, HistoryViewerRole } from "./history-viewer-types.js";

function historyRoleLabel(role: HistoryViewerRole | "all"): string {
	switch (role) {
		case "all":
			return t("chatMisc.history.roles.all");
		case "user":
			return t("chatMisc.history.roles.user");
		case "assistant":
			return t("chatMisc.history.roles.assistant");
		case "system":
			return t("chatMisc.history.roles.system");
		case "custom":
			return t("chatMisc.history.roles.custom");
	}
}

interface RenderHistoryViewerViewParams<Message extends HistoryViewerMessage> {
	historyViewerOpen: boolean;
	historyViewerMode: "browse" | "fork";
	historyViewerLoading: boolean;
	historyViewerSessionLabel: string;
	historyQuery: string;
	historyRoleFilter: HistoryViewerRole | "all";
	/** 角色筛选下拉实例（由 chat-view 持有，保证重渲染间状态连续）。 */
	roleFilterSelect: SettingsSelectDropdown;
	messages: Message[];
	historyTreeRows: HistoryTreeRow[];
	forkOptions: ForkOption[];
	messagePreview: (message: Message) => string;
	resolveForkEntryId: (messages: Message[], index: number) => string | null;
	onClose: () => void;
	onQueryChange: (value: string) => void;
	onRoleFilterChange: (role: HistoryViewerRole | "all") => void;
	onJumpToMessage: (messageId: string) => void;
	onForkFromEntry: (entryId: string) => unknown;
	compactTreeLinePrefix: (prefix: string, depth: number) => string;
	truncateText: (value: string, maxLength: number) => string;
}

export function renderHistoryViewerView<Message extends HistoryViewerMessage>({
	historyViewerOpen,
	historyViewerMode,
	historyViewerLoading,
	historyViewerSessionLabel,
	historyQuery,
	historyRoleFilter,
	roleFilterSelect,
	messages,
	historyTreeRows,
	forkOptions,
	messagePreview,
	resolveForkEntryId,
	onClose,
	onQueryChange,
	onRoleFilterChange,
	onJumpToMessage,
	onForkFromEntry,
	compactTreeLinePrefix,
	truncateText,
}: RenderHistoryViewerViewParams<Message>): TemplateResult | typeof nothing {
	if (!historyViewerOpen) return nothing;

	const forkMode = historyViewerMode === "fork";
	const query = historyQuery.trim().toLowerCase();
	const sourceMessages: Message[] = messages;
	const sessionMessageIdByEntryId = new Map<string, string>();
	for (const message of messages) {
		if (!message.sessionEntryId) continue;
		if (sessionMessageIdByEntryId.has(message.sessionEntryId)) continue;
		sessionMessageIdByEntryId.set(message.sessionEntryId, message.id);
	}

	const filteredForkOptions: ForkOption[] = forkMode
		? forkOptions.filter((option) => {
			if (!query) return true;
			return option.text.toLowerCase().includes(query);
		})
		: [];

	const useTreeRows = !forkMode && historyTreeRows.length > 0;
	const filteredTreeRows: HistoryTreeRow[] = forkMode
		? []
		: historyTreeRows.filter((row) => {
			if (historyRoleFilter !== "all" && row.role !== historyRoleFilter) return false;
			if (!query) return true;
			const haystack = `${row.role} ${row.entryLabel} ${row.preview} ${row.displayText} ${row.entryId}`.toLowerCase();
			return haystack.includes(query);
		});

	const filteredBrowseRows: Array<{ msg: Message; sourceIndex: number }> = forkMode || useTreeRows
		? []
		: sourceMessages
			.map((msg, sourceIndex) => ({ msg, sourceIndex }))
			.filter(({ msg }) => {
				if (historyRoleFilter !== "all" && msg.role !== historyRoleFilter) return false;
				if (!query) return true;
				const haystack = `${msg.role} ${msg.label || ""} ${messagePreview(msg)}`.toLowerCase();
				return haystack.includes(query);
			});

	const hasNoRows = forkMode
		? filteredForkOptions.length === 0
		: useTreeRows
			? filteredTreeRows.length === 0
			: filteredBrowseRows.length === 0;

	return html`
		<div class="overlay" @click=${(event: Event) => event.target === event.currentTarget && onClose()}>
			<div class="overlay-card history-card ${forkMode ? "fork-mode" : ""}">
				<div class="overlay-header">
					<div>
						<div>${forkMode ? t("chatMisc.history.forkFromMessage") : t("chatMisc.history.sessionTree")}</div>
						${forkMode
							? html`<div class="history-subtitle">${historyViewerSessionLabel || t("chatMisc.history.currentSession")}</div>`
							: nothing}
					</div>
					<button @click=${onClose}>✕</button>
				</div>
				<div class="history-controls ${forkMode ? "fork" : ""}">
					<input
						type="text"
						placeholder=${forkMode ? t("chatMisc.history.searchUserMessages") : t("chatMisc.history.searchTreeEntries")}
						.value=${historyQuery}
						@input=${(event: Event) => {
							onQueryChange((event.target as HTMLInputElement).value);
						}}
					/>
					${forkMode
						? nothing
						: roleFilterSelect.render({
							ariaLabel: t("chatMisc.history.roleFilter"),
							triggerClass: "settings-select-trigger-field",
							value: historyRoleFilter,
							options: (["all", "user", "assistant", "system", "custom"] as const).map((role) => ({
								value: role,
								label: historyRoleLabel(role),
							})),
							onSelect: (value) => onRoleFilterChange(value as HistoryViewerRole | "all"),
						})}
				</div>
				<div class="overlay-body history-list ${forkMode ? "fork-history-list" : ""}">
					${historyViewerLoading
						? html`
							<div class="ui-skeleton" role="status" aria-label=${t("chatMisc.history.loading")}>
								<span class="skeleton-bar" style="width:90%"></span>
								<span class="skeleton-bar" style="width:68%"></span>
								<span class="skeleton-bar" style="width:79%"></span>
							</div>
						`
						: hasNoRows
							? html`<div class="overlay-empty">${forkMode ? t("chatMisc.history.noForkMessages") : t("chatMisc.history.noMatchingEntries")}</div>`
							: forkMode
								? filteredForkOptions.map((option, idx) => {
										const preview = truncateText(option.text.replace(/\s+/g, " ").trim(), 240);
										return html`
											<div class="history-item fork-user-row">
												<div class="history-item-main">
													<button class="history-jump" @click=${() => void onForkFromEntry(option.entryId)} title=${t("chatMisc.history.forkFromUser")}>
														<div class="history-meta">
															<span class="history-role role-user">${historyRoleLabel("user")}</span>
															<span>#${idx + 1}</span>
														</div>
														<div class="history-preview">${preview}</div>
													</button>
													<button class="history-fork-btn" @click=${() => void onForkFromEntry(option.entryId)} title=${t("chatMisc.history.forkFromUser")}>${t("chatMisc.history.fork")}</button>
												</div>
											</div>
										`;
								  })
								: useTreeRows
									? filteredTreeRows.map((row, idx) => {
											const visibleMessageId = sessionMessageIdByEntryId.get(row.entryId) ?? null;
											const canJump = Boolean(visibleMessageId);
											const title = canJump ? t("chatMisc.history.jumpToEntry") : t("chatMisc.history.entryOutsideBranch");
											const compactPrefix = compactTreeLinePrefix(row.linePrefix, row.depth);
											const rowText = row.displayText.trim() || row.preview || t("chatMisc.history.entryFallback");
											const lineText = `${compactPrefix}${row.onActivePath ? "• " : "  "}${truncateText(rowText, 320)}`;
											const lineBody = html`<span class="history-tree-line-mono role-${row.role}">${lineText}</span>`;
											return html`
												<div class="history-tree-line-row ${row.onActivePath ? "on-path" : "off-path"}">
													${canJump && visibleMessageId
														? html`<button class="history-tree-line ${row.onActivePath ? "on-path" : ""}" @click=${() => onJumpToMessage(visibleMessageId)} title=${title}>${lineBody}</button>`
														: html`<div class="history-tree-line static" title=${title}>${lineBody}</div>`}
													<div class="history-tree-line-actions">
														<span class="history-tree-index">#${idx + 1}</span>
														${row.canFork
															? html`<button class="history-fork-btn" @click=${() => void onForkFromEntry(row.entryId)} title=${t("chatMisc.history.forkFromUser")}>${t("chatMisc.history.fork")}</button>`
															: nothing}
													</div>
												</div>
											`;
									  })
									: filteredBrowseRows.map(({ msg, sourceIndex }, idx) => {
											const forkEntryId = resolveForkEntryId(sourceMessages, sourceIndex);
											const canFork = Boolean(forkEntryId) && (msg.role === "user" || msg.role === "assistant");
											return html`
												<div class="history-item">
													<div class="history-item-main">
														<button class="history-jump" @click=${() => onJumpToMessage(msg.id)}>
															<div class="history-meta">
																<span class="history-role role-${msg.role}">${historyRoleLabel(msg.role)}</span>
																<span>#${idx + 1}</span>
															</div>
															<div class="history-preview">${truncateText(messagePreview(msg).replace(/\s+/g, " "), 200)}</div>
														</button>
														${canFork && forkEntryId
															? html`<button class="history-fork-btn" @click=${() => void onForkFromEntry(forkEntryId)} title=${msg.role === "assistant" ? t("chatMisc.history.forkFromPreceding") : t("chatMisc.history.forkFromUser")}>${t("chatMisc.history.fork")}</button>`
															: nothing}
													</div>
												</div>
											`;
					  })}
				</div>
			</div>
		</div>
	`;
}
