import { type ModelOption } from "../../models/model-options.js";
import { rpcBridge, type RpcSessionState } from "../../rpc/bridge.js";
import { t } from "../../i18n/index.js";

type NoticeKind = "info" | "success" | "error";

interface SessionStatsSummaryLike {
	tokens: number | null;
	lifetimeTokens: number | null;
	costUsd: number | null;
	messageCount: number;
	pendingCount: number;
	contextWindow: number | null;
	usageRatio: number | null;
}

interface SessionInfoMessageLike {
	role: string;
	toolCalls: Array<{ result?: string }>;
}

interface AppendSystemMessageOptions {
	label?: string;
	markdown?: boolean;
	collapsibleTitle?: string;
	collapsedByDefault?: boolean;
}

interface OpenHistoryViewerForForkOptions {
	loading: boolean;
	sessionName: string | null;
	query?: string;
}

export interface ExecuteBuiltinSlashCommandParams {
	commandName: string;
	args: string;
	availableModelsCount: number;
	onOpenSettings: ((sectionId?: string) => void) | null;
	pushNotice: (text: string, kind: NoticeKind) => void;
	truncate: (value: string, len: number) => string;
	openModelPicker: (options?: { preferredProvider?: string }) => void;
	loadAvailableModels: () => Promise<void>;
	resolveModelCandidateFromArg: (rawArg: string) => ModelOption | null;
	resolveProviderHintFromModelArg: (rawArg: string) => string | null;
	setModel: (provider: string, modelId: string) => Promise<unknown>;
	unwrapQuotedArg: (value: string) => string;
	pickSessionExportPathFromDialog: () => Promise<string | null>;
	pickSessionImportPathFromDialog: () => Promise<string | null>;
	refreshFromBackend: () => Promise<void>;
	shareAsGist: () => Promise<unknown>;
	copyLastMessage: () => Promise<unknown>;
	onBeginRenameCurrentSession: (() => boolean | Promise<boolean>) | null;
	renameSession: () => Promise<unknown>;
	renameSessionTo: (name: string) => Promise<unknown>;
	refreshSessionStats: (force?: boolean) => Promise<void>;
	buildSessionInfoBlock: () => string;
	appendSystemMessage: (text: string, options?: AppendSystemMessageOptions) => void;
	loadPiAgentChangelogMarkdown: (forceRefresh: boolean) => Promise<string>;
	extractLatestChangelogSections: (markdown: string, maxSections: number) => string;
	onOpenShortcuts: (() => void) | null;
	onOpenTerminal: ((command?: string) => void | Promise<void>) | null;
	sessionName: string | null;
	openHistoryViewerForFork: (options: OpenHistoryViewerForForkOptions) => void;
	openHistoryViewer: (options: { query?: string }) => void;
	normalizedAuthProviderArg: (value: string) => string | null;
	handleProviderAuthAction: (provider: string, action: "login" | "logout") => Promise<void>;
	onCreateFreshSession: (() => boolean | Promise<boolean>) | null;
	newSession: () => Promise<unknown>;
	compactNow: (mode?: string) => Promise<unknown>;
	onOpenSessionBrowser: ((query?: string) => void) | null;
	onReloadRuntime: (() => boolean | Promise<boolean>) | null;
	ensureSlashCommandsLoaded: (force?: boolean) => Promise<void>;
	loadProviderAuthStatus: (force?: boolean) => Promise<void>;
	loadOAuthProviderCatalog: (force?: boolean) => Promise<void>;
	loadModelCatalog: (force?: boolean) => Promise<void>;
	onQuitApp: (() => void) | null;
}

function normalizeText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

function formatUsd(value: number): string {
	if (value < 0.01) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function getSessionMessageBreakdown(messages: SessionInfoMessageLike[]): {
	user: number;
	assistant: number;
	toolCalls: number;
	toolResults: number;
} {
	let user = 0;
	let assistant = 0;
	let toolCalls = 0;
	let toolResults = 0;
	for (const message of messages) {
		if (message.role === "user") {
			user += 1;
			continue;
		}
		if (message.role !== "assistant") continue;
		assistant += 1;
		toolCalls += message.toolCalls.length;
		toolResults += message.toolCalls.filter((call) => typeof call.result === "string" && call.result.trim().length > 0).length;
	}
	return { user, assistant, toolCalls, toolResults };
}

export function formatSessionInfoBlock(params: {
	state: RpcSessionState | null;
	sessionStats: SessionStatsSummaryLike;
	messages: SessionInfoMessageLike[];
}): string {
	const { state, sessionStats, messages } = params;
	const lines: string[] = [];
	const sessionName = normalizeText(state?.sessionName);
	const sessionFile = normalizeText(state?.sessionFile);
	const sessionId = normalizeText(state?.sessionId);
	const modelProvider = normalizeText(state?.model?.provider);
	const modelId = normalizeText(state?.model?.id);
	const modelLabel = modelProvider && modelId ? `${modelProvider}/${modelId}` : "—";
	const { user, assistant, toolCalls, toolResults } = getSessionMessageBreakdown(messages);
	const totalMessages = state?.messageCount ?? sessionStats.messageCount;
	const pendingMessages = state?.pendingMessageCount ?? sessionStats.pendingCount;

	lines.push(t("composer.sessionInfo.title"));
	lines.push("");
	lines.push(t("composer.sessionInfo.name", { value: sessionName || t("composer.sessionInfo.unnamed") }));
	lines.push(t("composer.sessionInfo.file", { value: sessionFile || t("composer.sessionInfo.inMemory") }));
	lines.push(t("composer.sessionInfo.id", { value: sessionId || "—" }));
	lines.push(t("composer.sessionInfo.model", { value: modelLabel }));
	lines.push(t("composer.sessionInfo.thinking", { value: state?.thinkingLevel ?? "—" }));
	lines.push("");
	lines.push(t("composer.sessionInfo.messagesTitle"));
	lines.push(t("composer.sessionInfo.user", { count: user }));
	lines.push(t("composer.sessionInfo.assistant", { count: assistant }));
	lines.push(t("composer.sessionInfo.toolCalls", { count: toolCalls }));
	lines.push(t("composer.sessionInfo.toolResults", { count: toolResults }));
	lines.push(t("composer.sessionInfo.total", { count: Math.max(0, totalMessages) }));
	lines.push(t("composer.sessionInfo.pending", { count: Math.max(0, pendingMessages) }));
	lines.push("");
	lines.push(t("composer.sessionInfo.tokensTitle"));
	lines.push(
		t("composer.sessionInfo.context", { value: sessionStats.tokens !== null ? Math.round(sessionStats.tokens).toLocaleString() : "—" }),
	);
	lines.push(
		t("composer.sessionInfo.contextWindow", {
			value: sessionStats.contextWindow !== null ? Math.round(sessionStats.contextWindow).toLocaleString() : "—",
		}),
	);
	lines.push(
		t("composer.sessionInfo.usage", { value: sessionStats.usageRatio !== null ? `${(sessionStats.usageRatio * 100).toFixed(1)}%` : "—" }),
	);
	lines.push(
		t("composer.sessionInfo.sessionTokensTotal", {
			value: sessionStats.lifetimeTokens !== null ? Math.round(sessionStats.lifetimeTokens).toLocaleString() : "—",
		}),
	);
	lines.push(t("composer.sessionInfo.cost", { value: sessionStats.costUsd !== null ? formatUsd(sessionStats.costUsd) : "—" }));
	return lines.join("\n");
}

export async function executeBuiltinSlashCommand({
	commandName,
	args,
	availableModelsCount,
	onOpenSettings,
	pushNotice,
	truncate,
	openModelPicker,
	loadAvailableModels,
	resolveModelCandidateFromArg,
	resolveProviderHintFromModelArg,
	setModel,
	unwrapQuotedArg,
	pickSessionExportPathFromDialog,
	pickSessionImportPathFromDialog,
	refreshFromBackend,
	shareAsGist,
	copyLastMessage,
	onBeginRenameCurrentSession,
	renameSession,
	renameSessionTo,
	refreshSessionStats,
	buildSessionInfoBlock,
	appendSystemMessage,
	loadPiAgentChangelogMarkdown,
	extractLatestChangelogSections,
	onOpenShortcuts,
	onOpenTerminal,
	sessionName,
	openHistoryViewerForFork,
	openHistoryViewer,
	normalizedAuthProviderArg,
	handleProviderAuthAction,
	onCreateFreshSession,
	newSession,
	compactNow,
	onOpenSessionBrowser,
	onReloadRuntime,
	ensureSlashCommandsLoaded,
	loadProviderAuthStatus,
	loadOAuthProviderCatalog,
	loadModelCatalog,
	onQuitApp,
}: ExecuteBuiltinSlashCommandParams): Promise<void> {
	switch (commandName) {
		case "settings": {
			if (!onOpenSettings) {
				pushNotice(t("composer.commands.settingsUnavailable"), "error");
				return;
			}
			onOpenSettings();
			return;
		}
		case "model": {
			const rawArg = args.trim();
			if (!rawArg) {
				openModelPicker();
				return;
			}
			if (availableModelsCount === 0) {
				await loadAvailableModels();
			}
			const candidate = resolveModelCandidateFromArg(rawArg);
			if (!candidate) {
				const providerHint = resolveProviderHintFromModelArg(rawArg) ?? undefined;
				openModelPicker({ preferredProvider: providerHint });
				return;
			}
			await setModel(candidate.provider, candidate.id);
			return;
		}
		case "scoped-models": {
			if (onOpenSettings) {
				onOpenSettings("general");
			} else {
				pushNotice(t("composer.commands.settingsUnavailable"), "error");
			}
			return;
		}
		case "export": {
			let outputPath = unwrapQuotedArg(args);
			if (!outputPath) {
				outputPath = (await pickSessionExportPathFromDialog()) || "";
			}
			if (!outputPath) {
				pushNotice(t("composer.commands.exportCancelled"), "info");
				return;
			}
			const result = await rpcBridge.exportHtml(outputPath);
			pushNotice(t("composer.commands.exported", { path: truncate(result.path, 70) }), "success");
			return;
		}
		case "import": {
			let target = unwrapQuotedArg(args);
			if (!target) {
				target = (await pickSessionImportPathFromDialog()) || "";
			}
			if (!target) {
				pushNotice(t("composer.commands.importCancelled"), "info");
				return;
			}
			const result = await rpcBridge.switchSession(target);
			if (!result.cancelled) {
				await refreshFromBackend();
				pushNotice(t("composer.commands.imported", { path: truncate(target, 56) }), "success");
			} else {
				pushNotice(t("composer.commands.importCancelled"), "info");
			}
			return;
		}
		case "share": {
			await shareAsGist();
			return;
		}
		case "copy": {
			await copyLastMessage();
			return;
		}
		case "name": {
			const nextName = args.trim();
			if (!nextName) {
				if (onBeginRenameCurrentSession) {
					const handled = await onBeginRenameCurrentSession();
					if (handled) return;
				}
				await renameSession();
				return;
			}
			await renameSessionTo(nextName);
			return;
		}
		case "session": {
			await refreshSessionStats(true);
			appendSystemMessage(buildSessionInfoBlock(), { label: "session" });
			return;
		}
		case "changelog": {
			const tokens = args
				.split(/\s+/)
				.map((token) => token.trim().toLowerCase())
				.filter(Boolean);
			const forceRefresh = tokens.includes("refresh");
			const showAll = tokens.includes("all") || tokens.includes("full");
			const markdownFull = await loadPiAgentChangelogMarkdown(forceRefresh);
			const markdown = showAll ? markdownFull : extractLatestChangelogSections(markdownFull, 2);
			appendSystemMessage(markdown, {
				label: "changelog",
				markdown: true,
				collapsibleTitle: showAll ? t("composer.commands.changelogAll") : t("composer.commands.changelogLatest"),
				collapsedByDefault: true,
			});
			return;
		}
		case "hotkeys": {
			if (onOpenShortcuts) {
				onOpenShortcuts();
			} else {
				pushNotice(t("composer.commands.hotkeysUnavailable"), "info");
			}
			return;
		}
		case "terminal": {
			if (onOpenTerminal) {
				await onOpenTerminal();
			} else {
				pushNotice(t("composer.commands.terminalUnavailable"), "info");
			}
			return;
		}
		case "fork": {
			openHistoryViewerForFork({
				loading: false,
				sessionName,
				query: args.trim() || undefined,
			});
			return;
		}
		case "tree": {
			openHistoryViewer({ query: args.trim() || undefined });
			return;
		}
		case "login": {
			const provider = normalizedAuthProviderArg(args);
			if (!provider) {
				openModelPicker();
				return;
			}
			await handleProviderAuthAction(provider, "login");
			return;
		}
		case "logout": {
			const provider = normalizedAuthProviderArg(args);
			if (!provider) {
				openModelPicker();
				return;
			}
			await handleProviderAuthAction(provider, "logout");
			return;
		}
		case "new": {
			if (onCreateFreshSession) {
				const handled = await onCreateFreshSession();
				if (handled) return;
			}
			await newSession();
			return;
		}
		case "compact": {
			await compactNow(args.trim() || undefined);
			return;
		}
		case "resume": {
			if (onOpenSessionBrowser) {
				onOpenSessionBrowser(args.trim() || undefined);
			} else {
				pushNotice(t("composer.commands.sessionBrowserUnavailable"), "info");
			}
			return;
		}
		case "reload": {
			if (onReloadRuntime) {
				const handled = await onReloadRuntime();
				if (handled) {
					await ensureSlashCommandsLoaded(true);
					await Promise.all([loadProviderAuthStatus(true), loadOAuthProviderCatalog(true), loadModelCatalog(true)]);
					pushNotice(t("composer.commands.reloaded"), "success");
					return;
				}
			}
			await ensureSlashCommandsLoaded(true);
			await refreshFromBackend();
			await Promise.all([
				loadAvailableModels(),
				loadProviderAuthStatus(true),
				loadOAuthProviderCatalog(true),
				loadModelCatalog(true),
			]);
			pushNotice(t("composer.commands.reloaded"), "success");
			return;
		}
		case "quit": {
			if (onQuitApp) {
				onQuitApp();
			} else {
				pushNotice(t("composer.commands.quitUnavailable"), "info");
			}
			return;
		}
		default: {
			pushNotice(t("composer.commands.unknownCommand", { name: commandName }), "error");
			return;
		}
	}
}
