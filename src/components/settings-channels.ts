/**
 * 设置页「模型渠道」tab（PRD 4.2，CC Switch 式）。
 *
 * 视图/状态/副作用层；纯逻辑全部在 ../channels/ 下。
 * 由 settings-panel.ts 嵌入渲染；读取走 safe_read_json，渠道变更统一走
 * save_channel_config 的锁内 patch + recovery journal 事务。
 */

import { html, nothing, type TemplateResult } from "lit";
import {
	fetchModelsList,
	type FetchModelsErrorKind,
} from "../channels/adapters.js";
import {
	applySetDefault,
	buildChannelSaveOps,
	buildDeleteTransactionPayload,
	buildDuplicateTransactionPayload,
	buildEnabledModelsTransactionPayload,
	buildKeychainRefCommand,
	buildSettingsTransactionPayload,
	buildUpsertTransactionPayload,
	deriveChannels,
	duplicateChannel,
	isSecretReference,
	isValidProviderId,
	KEYCHAIN_SERVICE,
	keychainAccountFor,
	literalApiKeyForRequest,
	mergeProviderModelScope,
	modelMatchesScopePattern,
	normalizeProviderId,
	parseChannelTransactionError,
	parseKeychainAccount,
	removeChannel,
	type ChannelTransactionPaths,
	type ChannelTransactionPayload,
	upsertChannel,
} from "../channels/config.js";
import {
	completeModelsMeta,
	draftFromManualId,
	loadPiStaticCatalog,
	mergeCatalogEntries,
	mergeFetchedModelDrafts,
	parseRuntimeCatalogEntry,
	resolveChannelEditAlias,
	type RuntimeCatalogEntry,
} from "../channels/metadata.js";
import { CHANNEL_PRESETS, findPreset, findPresetByBuiltinProvider } from "../channels/presets.js";
import { validateBaseUrl } from "../channels/ssrf.js";
import {
	API_PROTOCOLS,
	emptyChannelsMeta,
	isApiProtocol,
	type ApiProtocol,
	type ChannelRecord,
	type ChannelsMetaFile,
	type KeyRefKind,
	type ModelDraft,
	type PiAuthEntry,
	type PiAuthFile,
	type PiModelEntry,
	type PiModelsFile,
	type PiSettingsFile,
} from "../channels/types.js";
import { t } from "../i18n/index.js";
import { rpcBridge } from "../rpc/bridge.js";
import { SettingsSelectDropdown } from "./settings-select-dropdown.js";

interface ConfigPaths {
	agentDir: string;
	auth: string;
	models: string;
	settings: string;
	meta: string;
}

interface HeaderRow {
	key: string;
	value: string;
}

interface ScopedModelOption {
	fullId: string;
	provider: string;
	id: string;
	name: string;
}

interface LoginProviderChip {
	provider: string;
	kind: "oauth" | "api_key";
}

interface EditDraft {
	mode: "add" | "edit";
	/** 编辑时的原 provider；新增为 null。 */
	originalProvider: string | null;
	isBuiltin: boolean;
	/** OAuth 订阅渠道：只读编辑页，仅可勾选模型并保存模型范围（不动 auth.json）。 */
	oauthReadonly: boolean;
	presetId: string;
	/** provider id（自定义渠道新增时可编辑，其余情况只读）。 */
	provider: string;
	alias: string;
	/** 内置渠道：填的是中转覆盖地址，空 = 官方默认。 */
	baseUrl: string;
	protocol: ApiProtocol;
	/** 用户输入的新明文 key；空 = 不改动现有凭据。编辑态回填现有密钥供查看。 */
	apiKey: string;
	/** 编辑态只在用户实际改过输入框时写新 Key，自动回填不改变动态引用语义。 */
	apiKeyDirty: boolean;
	/** 正在把已保存的 `$ENV` / `!cmd` / Keychain 引用解析成真值。 */
	apiKeyResolving: boolean;
	/** API Key 是否明文显示（眼睛开关）。 */
	showKey: boolean;
	keyHint: KeyRefKind;
	note: string;
	icon: string;
	headers: HeaderRow[];
	allowInsecureHttp: boolean;
	/**
	 * 当前 provider 在 models.json 里的 authHeader: true（pi 语义）。
	 * 只读镜像：拉模型时追加 Authorization: Bearer；保存时经 upsertChannel
	 * 的 existingEntry 展开原样保留（本页不提供编辑开关）。
	 */
	authHeader: boolean;
	drafts: ModelDraft[] | null;
	fetching: boolean;
	fetchError: string;
	/**
	 * 本次编辑会话最近一次「成功」拉取的远端返回数量（保存时记入 meta.modelsTotal）。
	 * null = 本次会话尚未成功拉取过；0 = 成功但远端返回 0 个（与未拉取严格区分）。
	 */
	fetchedTotal: number | null;
	/** 最近一次成功拉取的结果类型；用于区分远端真空与全部被聊天模型过滤。 */
	fetchNotice: "none" | "empty" | "all_filtered";
	manualId: string;
	saving: boolean;
	error: string;
	/** true = 保存事务回滚未完成的严重错误（醒目样式展示，附 journal 路径）。 */
	errorSevere: boolean;
	warning: string;
}

const PROTOCOL_LABELS: Record<ApiProtocol, string> = {
	"openai-completions": "OpenAI Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Generative AI",
};

function joinFsPath(base: string, child: string): string {
	const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
	const c = child.replace(/\\/g, "/").replace(/^\/+/, "");
	return b ? `${b}/${c}` : c;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function headersRecordToRows(record: Record<string, string> | undefined): HeaderRow[] {
	return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

function rowsToHeadersRecord(rows: HeaderRow[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of rows) {
		const key = row.key.trim();
		if (!key) continue;
		out[key] = row.value;
	}
	return out;
}

/** 已保存条目里除 id/name/四项元数据之外的字段（cost/compat 等），重新保存时写回。 */
function pickModelExtraFields(entry: PiModelEntry): Record<string, unknown> | undefined {
	const known = new Set(["id", "name", "contextWindow", "maxTokens", "reasoning", "input"]);
	const entries = Object.entries(entry).filter(([key]) => !known.has(key));
	// Object.fromEntries 使用 DefineProperty 语义，能把 __proto__/constructor/prototype
	// 当作普通 own property 保留，不会触发对象字面量/赋值路径上的原型 setter。
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function modelEntryToDraft(entry: PiModelEntry): ModelDraft {
	// 已保存条目缺字段 = 未知（null），UI 显示「未知」，不再回填猜测默认值
	const contextWindow =
		typeof entry.contextWindow === "number" && entry.contextWindow > 0 ? entry.contextWindow : null;
	const maxTokens = typeof entry.maxTokens === "number" && entry.maxTokens > 0 ? entry.maxTokens : null;
	const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : null;
	// input 模态只认已保存的显式值；没有就是未知（null），不回填 ["text"]（MODEL-07）
	const input =
		Array.isArray(entry.input) && entry.input.includes("image")
			? (["text", "image"] as ["text", "image"])
			: Array.isArray(entry.input) && entry.input.includes("text")
				? (["text"] as ["text"])
				: null;
	return {
		id: entry.id,
		name: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
		contextWindow,
		maxTokens,
		reasoning,
		input,
		selected: true,
		metaConfirmed:
			contextWindow !== null && maxTokens !== null && reasoning !== null && input !== null,
		origin: "saved",
		seenInFetch: false,
		extraFields: pickModelExtraFields(entry),
	};
}

/** 四项元数据（含输入能力）都有值才算「已确认」。 */
function recomputeMetaConfirmed(target: ModelDraft): void {
	target.metaConfirmed =
		target.contextWindow !== null
		&& target.maxTokens !== null
		&& target.reasoning !== null
		&& target.input !== null;
}

/** 用户手动修改某字段后，该字段视为已确认（清除自动补全来源标记）。 */
function clearMetaSource(target: ModelDraft, field: "contextWindow" | "maxTokens" | "reasoning" | "input"): void {
	if (target.metaSources) delete target.metaSources[field];
}

interface ModelMetaBadge {
	warn: boolean;
	text: string;
}

/**
 * 模型行的元数据状态徽章：
 * - 任一字段未知 → 「信息不全待确认」（warn）；
 * - 四项齐全但含预设推断来源 → 「预设推断待确认」（muted），
 *   与「远端明确返回 / 精确目录匹配 / 用户或已保存值」的精确可靠补全区分开；
 * - 四项齐全且来源全部可靠 → 无徽章。
 * 注：i18n 文案文件不在本次改动范围内，新徽章文案内联（界面语言固定简体中文）。
 */
function modelMetaBadge(model: ModelDraft): ModelMetaBadge | null {
	if (!model.metaConfirmed) return { warn: false, text: t("channels.edit.metaDefaults") };
	const hasInferred = Object.values(model.metaSources ?? {}).some((source) => source === "preset");
	return hasInferred ? { warn: false, text: "预设推断待确认" } : null;
}

interface ChannelTransactionErrorDisplay {
	code: string;
	text: string;
	severe: boolean;
	/** 后端确认配置已经提交，只是提交后的收尾/报告失败。 */
	committed: boolean;
}

function channelTransactionErrorDisplay(
	err: unknown,
	fallback: (message: string) => string,
): ChannelTransactionErrorDisplay {
	const { code, message: detail, journalPath } = parseChannelTransactionError(err);

	switch (code) {
		case "transaction_locked":
			return {
				code,
				text: t("settings.channels.transactionLocked", { message: detail }),
				severe: false,
				committed: false,
			};
		case "commit_uncertain":
			return {
				code,
				text: t("settings.channels.commitUncertain", { message: detail, path: journalPath }),
				severe: true,
				committed: false,
			};
		case "committed_after_error":
			return {
				code,
				text: t("settings.channels.committedAfterError", { message: detail }),
				severe: false,
				committed: true,
			};
		case "rollback_incomplete":
		case "stale_journal":
			return {
				code,
				text: t("settings.channels.saveRollbackIncomplete", { message: detail, path: journalPath }),
				severe: true,
				committed: false,
			};
		case "rollback_complete":
			return {
				code,
				text: `${fallback(detail)} ${t("settings.channels.saveRolledBack")}`,
				severe: false,
				committed: false,
			};
		default:
			return { code, text: fallback(detail), severe: false, committed: false };
	}
}

export class ChannelsSettings {
	private requestRender: () => void;
	private onConfigChanged: (() => void) | null = null;
	private onRequestOAuthTerminal: (() => void) | null = null;
	private readonly protocolSelect = new SettingsSelectDropdown({
		requestRender: () => this.requestRender(),
	});

	private view: "list" | "edit" = "list";
	private loading = false;
	private loadError = "";
	private message = "";
	private paths: ConfigPaths | null = null;
	private auth: PiAuthFile = {};
	private models: PiModelsFile = {};
	private meta: ChannelsMetaFile = emptyChannelsMeta();
	private settings: PiSettingsFile = {};
	private expandedProvider: string | null = null;
	private confirmingDelete: string | null = null;
	private draft: EditDraft | null = null;
	/** 单调递增的模型拉取代次；任何会改变请求或编辑会话的动作都会使旧请求失效。 */
	private modelFetchGeneration = 0;
	/** get_available_models 的缓存（运行时模型计数、内置渠道设默认与 OAuth 清单用）。 */
	private runtimeModels: RuntimeCatalogEntry[] = [];
	/** 本次是否成功从运行时拿到模型清单（区分「未探测」与「探测过为 0」）。 */
	private runtimeModelsLoaded = false;
	/**
	 * 元数据补全目录：pi 静态模型表（@mariozechner/pi-ai，认证无关底座）
	 * + get_available_models 运行时目录按 provider+exact id 合并。
	 * 只配自定义中转时运行时目录看不到 pi 内置模型，补全一律走这个合并目录。
	 */
	private catalogModels: RuntimeCatalogEntry[] = [];
	/** 顶部「登录状态」区的只读 chips（优先 get_pi_auth_status，失败回退 auth.json）。 */
	private loginProviders: LoginProviderChip[] = [];
	// ---- 模型范围（Ctrl+P 循环）状态 ----
	private scopedModelsLoading = false;
	private scopedModelsSaving = false;
	private scopedModelsError = "";
	private scopedModelsValidation = "";
	private scopedModelsMessage = "";
	private scopedModelsSearch = "";
	private scopedModels: ScopedModelOption[] = [];
	private scopedModelsHasFilter = false;
	private scopedModelsEnabledIds: string[] = [];
	private scopedModelsSavedSnapshot = "";
	private scopedModelsSettingsPath: string | null = null;
	private scopedModelsUnknownPatterns: string[] = [];

	constructor(deps: { requestRender: () => void }) {
		this.requestRender = deps.requestRender;
	}

	setOnConfigChanged(callback: (() => void) | null): void {
		this.onConfigChanged = callback;
	}

	setOnRequestOAuthTerminal(callback: (() => void) | null): void {
		this.onRequestOAuthTerminal = callback;
	}

	// ------------------------------------------------------------------
	// 文件 IO
	// ------------------------------------------------------------------

	private async resolvePaths(): Promise<ConfigPaths> {
		if (this.paths) return this.paths;
		let agentDir = "";
		try {
			const status = await rpcBridge.getPiAuthStatus();
			agentDir = typeof status.agent_dir === "string" ? status.agent_dir.trim() : "";
		} catch {
			// fall back below
		}
		if (!agentDir) {
			const { homeDir } = await import("@tauri-apps/api/path");
			const home = (await homeDir()).replace(/\\/g, "/").replace(/\/+$/, "");
			agentDir = joinFsPath(joinFsPath(home, ".pi"), "agent");
		}
		const { appDataDir } = await import("@tauri-apps/api/path");
		const metaDir = (await appDataDir()).replace(/\\/g, "/").replace(/\/+$/, "");
		this.paths = {
			agentDir,
			auth: joinFsPath(agentDir, "auth.json"),
			models: joinFsPath(agentDir, "models.json"),
			settings: joinFsPath(agentDir, "settings.json"),
			meta: joinFsPath(metaDir, "channels-meta.json"),
		};
		return this.paths;
	}

	private async readJson(path: string): Promise<unknown> {
		const { invoke } = await import("@tauri-apps/api/core");
		return invoke("safe_read_json", { path });
	}

	private async keychainGet(account: string): Promise<string | null> {
		const { invoke } = await import("@tauri-apps/api/core");
		return (await invoke("keychain_get", { service: KEYCHAIN_SERVICE, account })) as string | null;
	}

	private transactionPaths(paths: ConfigPaths): ChannelTransactionPaths {
		return {
			authPath: paths.auth,
			modelsPath: paths.models,
			metaPath: paths.meta,
			settingsPath: paths.settings,
		};
	}

	private async saveChannelTransaction(payload: ChannelTransactionPayload): Promise<void> {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("save_channel_config", { payload });
	}

	/** 重新从磁盘读取四份配置（auth/models/settings/meta）。 */
	async refresh(): Promise<void> {
		this.loading = true;
		this.loadError = "";
		this.requestRender();
		try {
			const paths = await this.resolvePaths();
			const [authRaw, modelsRaw, settingsRaw, metaRaw] = await Promise.all([
				this.readJson(paths.auth),
				this.readJson(paths.models),
				this.readJson(paths.settings),
				this.readJson(paths.meta),
			]);
			this.auth = asObject(authRaw) as PiAuthFile;
			this.models = asObject(modelsRaw) as PiModelsFile;
			this.settings = asObject(settingsRaw) as PiSettingsFile;
			const metaObj = asObject(metaRaw);
			this.meta = {
				version: 1,
				channels: asObject(metaObj.channels) as ChannelsMetaFile["channels"],
				order: Array.isArray(metaObj.order)
					? metaObj.order.filter((v): v is string => typeof v === "string")
					: undefined,
			};
			// 静态目录（pi-ai 内置模型表，无认证过滤）无论 RPC 是否连接都尝试加载，
			// 失败安全降级为空目录；RPC 已连接时再合并 get_available_models 运行时目录。
			// 元数据补全走合并目录（catalogModels）；运行时计数/模型列表仍只看 runtimeModels。
			const staticCatalog = await loadPiStaticCatalog();
			let runtimeEntries: RuntimeCatalogEntry[] = [];
			if (rpcBridge.isConnected) {
				try {
					const raw = await rpcBridge.getAvailableModels();
					runtimeEntries = (Array.isArray(raw) ? raw : [])
						.map(parseRuntimeCatalogEntry)
						.filter((entry): entry is RuntimeCatalogEntry => entry !== null);
					this.runtimeModelsLoaded = true;
				} catch {
					this.runtimeModelsLoaded = false;
				}
			} else {
				this.runtimeModelsLoaded = false;
			}
			this.runtimeModels = runtimeEntries;
			this.catalogModels = mergeCatalogEntries(staticCatalog, runtimeEntries);
			this.loginProviders = await this.fetchLoginProviders();
		} catch (err) {
			this.loadError = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private channels(): ChannelRecord[] {
		// 运行时模型数（卡片「已启用 N」用）；已加载模型范围时按范围过滤计数。
		// 未成功探测过运行时清单时传 undefined（runtimeModelCount = null = 「未探测」，
		// 与「探测过但为 0」区分开）。
		const counts: Record<string, number> = {};
		for (const m of this.runtimeModels) {
			if (this.scopedModels.length > 0 && !this.isScopedModelEnabled(`${m.provider}/${m.id}`)) continue;
			counts[m.provider] = (counts[m.provider] ?? 0) + 1;
		}
		return deriveChannels(this.auth, this.models, this.meta, this.settings, this.runtimeModelsLoaded ? counts : undefined);
	}

	/**
	 * 已登录 Provider 列表（登录状态区用）。
	 * 优先走 get_pi_auth_status（Tauri 命令，能识别环境变量来源，
	 * 不需要运行中的 runtime）；失败时回退到刚读出的 auth.json。
	 */
	private async fetchLoginProviders(): Promise<LoginProviderChip[]> {
		try {
			const raw = await rpcBridge.getPiAuthStatus();
			const entries = Array.isArray(raw?.configured_providers) ? raw.configured_providers : [];
			const byProvider = new Map<string, "oauth" | "api_key">();
			for (const entry of entries) {
				if (!entry || typeof entry !== "object") continue;
				const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
				if (!provider || byProvider.has(provider)) continue;
				byProvider.set(provider, entry.kind === "oauth" ? "oauth" : "api_key");
			}
			return [...byProvider.entries()]
				.map(([provider, kind]) => ({ provider, kind }))
				.sort((a, b) => a.provider.localeCompare(b.provider));
		} catch {
			return Object.entries(this.auth)
				.filter(([, entry]) => {
					const type = (entry as PiAuthEntry | undefined)?.type;
					return type === "oauth" || type === "api_key";
				})
				.map(([provider, entry]) => ({
					provider,
					kind: ((entry as PiAuthEntry).type === "oauth" ? "oauth" : "api_key") as "oauth" | "api_key",
				}))
				.sort((a, b) => a.provider.localeCompare(b.provider));
		}
	}

	// ------------------------------------------------------------------
	// 模型范围（Ctrl+P 循环）：读写 pi settings.json 的 enabledModels
	// ------------------------------------------------------------------

	private readStringPath(source: Record<string, unknown>, path: string): string | null {
		const parts = path.split(".");
		let current: unknown = source;
		for (const part of parts) {
			if (!current || typeof current !== "object") return null;
			current = (current as Record<string, unknown>)[part];
		}
		if (typeof current !== "string") return null;
		const value = current.trim();
		return value.length > 0 ? value : null;
	}

	private pickStringPath(source: Record<string, unknown>, paths: string[]): string | null {
		for (const path of paths) {
			const value = this.readStringPath(source, path);
			if (value !== null) return value;
		}
		return null;
	}

	private parseScopedModelOptions(rawModels: Array<Record<string, unknown>>): ScopedModelOption[] {
		const byId = new Map<string, ScopedModelOption>();
		for (const raw of rawModels) {
			const provider = this.pickStringPath(raw, ["provider", "target.provider", "model.provider"]);
			const id = this.pickStringPath(raw, ["id", "modelId", "model_id", "model", "target.id", "target.modelId"]);
			if (!provider || !id) continue;
			const fullId = `${provider}/${id}`;
			const key = fullId.toLowerCase();
			if (byId.has(key)) continue;
			const name = this.pickStringPath(raw, ["name", "label", "target.name"]) ?? id;
			byId.set(key, {
				fullId,
				provider,
				id,
				name,
			});
		}
		return [...byId.values()].sort((a, b) => {
			const providerCmp = a.provider.localeCompare(b.provider);
			if (providerCmp !== 0) return providerCmp;
			return a.id.localeCompare(b.id);
		});
	}

	private async resolvePiSettingsPath(): Promise<string> {
		let agentDir = "";
		try {
			const status = await rpcBridge.getPiAuthStatus();
			agentDir = typeof status.agent_dir === "string" ? status.agent_dir.trim() : "";
		} catch {
			// ignore and fallback to default path
		}
		if (!agentDir) {
			const { homeDir } = await import("@tauri-apps/api/path");
			const home = (await homeDir()).replace(/\\/g, "/").replace(/\/+$/, "");
			agentDir = joinFsPath(joinFsPath(home, ".pi"), "agent");
		}
		return joinFsPath(agentDir, "settings.json");
	}

	private async readPiGlobalSettingsDoc(): Promise<{ path: string; doc: Record<string, unknown> }> {
		const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
		const path = await this.resolvePiSettingsPath();
		this.scopedModelsSettingsPath = path;
		if (!(await exists(path))) {
			return { path, doc: {} };
		}
		const content = await readTextFile(path);
		if (!content.trim()) return { path, doc: {} };
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(t("settings.errors.parseFailed", { path, message }));
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(t("settings.errors.expectedObject", { path, type: Array.isArray(parsed) ? "array" : typeof parsed }));
		}
		return { path, doc: parsed as Record<string, unknown> };
	}

	private resolveScopedModelIdsFromPatterns(
		patterns: string[] | undefined,
		models: ScopedModelOption[],
	): { hasFilter: boolean; enabledIds: string[]; unknownPatterns: string[] } {
		const allIds = models.map((model) => model.fullId);
		if (!patterns || patterns.length === 0) {
			return { hasFilter: false, enabledIds: [...allIds], unknownPatterns: [] };
		}

		const refs = models.map((model) => ({ provider: model.provider, id: model.id }));
		const enabledIds: string[] = [];
		const seen = new Set<string>();
		const unknownPatterns: string[] = [];

		for (const rawPattern of patterns) {
			const pattern = rawPattern.trim();
			if (!pattern) continue;
			const matched = models.filter((model) =>
				modelMatchesScopePattern(
					pattern,
					{ provider: model.provider, id: model.id },
					refs,
				),
			);
			for (const model of matched) {
				if (!seen.has(model.fullId)) {
					seen.add(model.fullId);
					enabledIds.push(model.fullId);
				}
			}
			if (matched.length === 0) unknownPatterns.push(pattern);
		}

		if (enabledIds.length >= allIds.length) {
			return { hasFilter: false, enabledIds: [...allIds], unknownPatterns };
		}
		return { hasFilter: true, enabledIds, unknownPatterns };
	}

	private setScopedModelsSelection(hasFilter: boolean, enabledIds: string[]): void {
		const allIds = this.scopedModels.map((model) => model.fullId);
		const allowed = new Set(allIds);
		const deduped: string[] = [];
		for (const id of enabledIds) {
			if (!allowed.has(id)) continue;
			if (deduped.includes(id)) continue;
			deduped.push(id);
		}

		if (!hasFilter || deduped.length >= allIds.length) {
			this.scopedModelsHasFilter = false;
			this.scopedModelsEnabledIds = [...allIds];
			return;
		}

		this.scopedModelsHasFilter = true;
		this.scopedModelsEnabledIds = deduped;
	}

	private scopedModelsSnapshot(): string {
		if (!this.scopedModelsHasFilter) return "all:*";
		return `filtered:${this.scopedModelsEnabledIds.join("|")}`;
	}

	private scopedModelsDirty(): boolean {
		return this.scopedModelsSnapshot() !== this.scopedModelsSavedSnapshot;
	}

	private isScopedModelEnabled(fullId: string): boolean {
		return !this.scopedModelsHasFilter || this.scopedModelsEnabledIds.includes(fullId);
	}

	private scopedModelsSelectionIsEmpty(): boolean {
		return this.scopedModelsHasFilter
			&& this.scopedModels.length > 0
			&& this.scopedModelsEnabledIds.length === 0;
	}

	private updateScopedSelectionFeedback(): void {
		this.scopedModelsError = "";
		this.scopedModelsValidation = this.scopedModelsSelectionIsEmpty()
			? t("settings.scopedModels.atLeastOne")
			: "";
		this.scopedModelsMessage = "";
	}

	private allScopedModelIds(): string[] {
		return this.scopedModels.map((model) => model.fullId);
	}

	private toggleScopedModel(fullId: string): void {
		const allIds = this.allScopedModelIds();
		if (allIds.length === 0) return;
		const currentlyEnabled = this.isScopedModelEnabled(fullId);
		if (!this.scopedModelsHasFilter) {
			if (!currentlyEnabled) return;
			const nextEnabled = allIds.filter((id) => id !== fullId);
			this.setScopedModelsSelection(true, nextEnabled);
		} else if (currentlyEnabled) {
			this.setScopedModelsSelection(
				true,
				this.scopedModelsEnabledIds.filter((id) => id !== fullId),
			);
		} else {
			this.setScopedModelsSelection(true, [...this.scopedModelsEnabledIds, fullId]);
		}
		this.updateScopedSelectionFeedback();
		this.requestRender();
	}

	private enableAllScopedModels(): void {
		this.setScopedModelsSelection(false, this.allScopedModelIds());
		this.scopedModelsError = "";
		this.scopedModelsValidation = "";
		this.scopedModelsMessage = "";
		this.requestRender();
	}

	private clearAllScopedModels(): void {
		this.setScopedModelsSelection(true, []);
		this.updateScopedSelectionFeedback();
		this.requestRender();
	}

	private toggleScopedProvider(provider: string): void {
		const providerIds = this.scopedModels
			.filter((model) => model.provider === provider)
			.map((model) => model.fullId);
		if (providerIds.length === 0) return;
		const allIds = this.allScopedModelIds();
		const providerFullyEnabled = providerIds.every((id) => this.isScopedModelEnabled(id));
		if (!this.scopedModelsHasFilter) {
			if (providerFullyEnabled) {
				const nextEnabled = allIds.filter((id) => !providerIds.includes(id));
				this.setScopedModelsSelection(true, nextEnabled);
			}
		} else if (providerFullyEnabled) {
			this.setScopedModelsSelection(
				true,
				this.scopedModelsEnabledIds.filter((id) => !providerIds.includes(id)),
			);
		} else {
			const next = [...this.scopedModelsEnabledIds];
			for (const id of providerIds) {
				if (!next.includes(id)) next.push(id);
			}
			this.setScopedModelsSelection(true, next);
		}
		this.updateScopedSelectionFeedback();
		this.requestRender();
	}

	/** 由 settings-panel 在打开设置时调用；运行时不就绪时给出提示、不清已保存规则。 */
	async refreshScopedModels(): Promise<void> {
		this.scopedModelsLoading = true;
		this.scopedModelsError = "";
		this.scopedModelsValidation = "";
		this.scopedModelsMessage = "";
		this.scopedModelsUnknownPatterns = [];
		this.requestRender();
		try {
			const running = await rpcBridge.refreshRunningState().catch(() => false);
			if (!running) {
				this.scopedModels = [];
				this.scopedModelsHasFilter = false;
				this.scopedModelsEnabledIds = [];
				this.scopedModelsSavedSnapshot = "";
				this.scopedModelsMessage = t("settings.scopedModels.needsRuntime");
				return;
			}
			const raw = await rpcBridge.getAvailableModels();
			const modelRecords = Array.isArray(raw)
				? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
				: [];
			this.scopedModels = this.parseScopedModelOptions(modelRecords);

			const { path, doc } = await this.readPiGlobalSettingsDoc();
			this.scopedModelsSettingsPath = path;
			const patterns = Array.isArray(doc.enabledModels)
				? doc.enabledModels
					.filter((value): value is string => typeof value === "string")
					.map((value) => value.trim())
					.filter(Boolean)
				: undefined;
			const resolved = this.resolveScopedModelIdsFromPatterns(patterns, this.scopedModels);
			this.scopedModelsUnknownPatterns = resolved.unknownPatterns;
			this.setScopedModelsSelection(resolved.hasFilter, resolved.enabledIds);
			this.scopedModelsSavedSnapshot = this.scopedModelsSnapshot();
			if (resolved.unknownPatterns.length > 0) {
				this.scopedModelsMessage = t("settings.scopedModels.unknownPatternsSkipped");
			}
		} catch (err) {
			this.scopedModels = [];
			this.scopedModelsHasFilter = false;
			this.scopedModelsEnabledIds = [];
			this.scopedModelsSavedSnapshot = "";
			this.scopedModelsError = err instanceof Error ? err.message : String(err);
		} finally {
			this.scopedModelsLoading = false;
			this.requestRender();
		}
	}

	private async saveScopedModels(): Promise<void> {
		if (this.scopedModelsSaving) return;
		if (this.scopedModelsSelectionIsEmpty()) {
			this.scopedModelsValidation = t("settings.scopedModels.atLeastOne");
			this.scopedModelsMessage = "";
			this.requestRender();
			return;
		}
		this.scopedModelsSaving = true;
		this.scopedModelsError = "";
		this.scopedModelsValidation = "";
		this.scopedModelsMessage = t("settings.scopedModels.saving");
		this.requestRender();
		try {
			const { path, doc } = await this.readPiGlobalSettingsDoc();
			const nextDoc: Record<string, unknown> = { ...doc };
			const allIds = this.allScopedModelIds();
			const enabledIds = this.scopedModelsHasFilter ? this.scopedModelsEnabledIds : allIds;
			const deduped = enabledIds.filter((id, index) => enabledIds.indexOf(id) === index && allIds.includes(id));
			const shouldClearFilter = !this.scopedModelsHasFilter || deduped.length >= allIds.length;
			if (shouldClearFilter) {
				delete nextDoc.enabledModels;
				this.setScopedModelsSelection(false, allIds);
			} else {
				nextDoc.enabledModels = deduped;
				this.setScopedModelsSelection(true, deduped);
			}

			const paths = await this.resolvePaths();
			await this.saveChannelTransaction(
				buildEnabledModelsTransactionPayload(
					{ ...this.transactionPaths(paths), settingsPath: path },
					"global-model-scope",
					shouldClearFilter ? undefined : deduped,
				),
			);
			this.settings = nextDoc;
			this.scopedModelsSettingsPath = path;
			this.scopedModelsSavedSnapshot = this.scopedModelsSnapshot();
			this.scopedModelsMessage = t("settings.scopedModels.saved");
		} catch (err) {
			const display = channelTransactionErrorDisplay(err, (message) => message);
			this.scopedModelsError = display.text;
			this.scopedModelsMessage = "";
			if (display.committed) {
				this.scopedModelsSavedSnapshot = "";
			}
		} finally {
			this.scopedModelsSaving = false;
			this.requestRender();
		}
	}

	// ------------------------------------------------------------------
	// 编辑视图
	// ------------------------------------------------------------------

	private openAdd(): void {
		this.invalidateModelFetch();
		this.view = "edit";
		this.message = "";
		this.draft = {
			mode: "add",
			originalProvider: null,
			isBuiltin: false,
			oauthReadonly: false,
			presetId: "",
			provider: "",
			alias: "",
			baseUrl: "",
			protocol: "openai-completions",
			apiKey: "",
			apiKeyDirty: false,
			apiKeyResolving: false,
			showKey: false,
			keyHint: "none",
			note: "",
			icon: "",
			headers: [],
			allowInsecureHttp: false,
			authHeader: false,
			drafts: null,
			fetching: false,
			fetchError: "",
			fetchedTotal: null,
			fetchNotice: "none",
			manualId: "",
			saving: false,
			error: "",
			errorSevere: false,
			warning: "",
		};
		this.requestRender();
	}

	private openEdit(record: ChannelRecord): void {
		this.invalidateModelFetch();
		this.view = "edit";
		this.message = "";
		const preset = findPresetByBuiltinProvider(record.provider);
		const metaEntry = this.meta.channels[record.provider];
		const modelsEntry = this.models.providers?.[record.provider];
		const isOauth = record.authKind === "oauth";
		this.draft = {
			mode: "edit",
			originalProvider: record.provider,
			isBuiltin: record.isBuiltin,
			oauthReadonly: isOauth,
			presetId: metaEntry?.presetId ?? preset?.id ?? "",
			provider: record.provider,
			// 名称回填：非空 meta alias → record.displayName → record.provider（不动 provider key）
			alias: resolveChannelEditAlias(metaEntry?.alias, record.displayName, record.provider),
			baseUrl: record.isBuiltin
				? typeof modelsEntry?.baseUrl === "string"
					? modelsEntry.baseUrl
					: ""
				: record.baseUrl,
			protocol: record.protocol ?? preset?.protocol ?? "openai-completions",
			apiKey: "",
			apiKeyDirty: false,
			apiKeyResolving: !isOauth && record.keyRefKind !== "none",
			showKey: false,
			keyHint: record.keyRefKind,
			note: record.note,
			icon: record.icon,
			headers: headersRecordToRows(modelsEntry?.headers),
			allowInsecureHttp: record.baseUrl.startsWith("http://"),
			authHeader: modelsEntry?.authHeader === true,
			drafts: isOauth
				? this.buildOAuthModelDrafts(record)
				: record.models.length > 0
					? record.models.map(modelEntryToDraft)
					: null,
			fetching: false,
			fetchError: "",
			fetchedTotal: null,
			fetchNotice: "none",
			manualId: "",
			saving: false,
			error: "",
			errorSevere: false,
			warning: "",
		};
		this.requestRender();
		if (isOauth) return; // OAuth 只读：不回填密钥，凭据区域显示只读说明
		// 回填现有密钥供查看（眼睛开关控制明暗）
		const editDraft = this.draft;
		void this.resolveExistingApiKey(record)
			.then((value) => {
				if (
					this.draft === editDraft
					&& !editDraft.fetching
					&& !editDraft.apiKeyDirty
					&& !editDraft.apiKey
					&& value
				) {
					this.invalidateModelFetch(editDraft);
					editDraft.apiKey = value;
				}
			})
			.catch((err) => {
				if (this.draft !== editDraft) return;
				editDraft.error = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				if (this.draft !== editDraft) return;
				editDraft.apiKeyResolving = false;
				this.requestRender();
			});
	}

	/**
	 * OAuth 只读编辑页的模型清单：models.json 显式条目 + 运行时发现的模型。
	 * 勾选初始状态反映 settings.json enabledModels 的实际过滤（无过滤 = 全选，
	 * 等价于 pi 内置行为）；enabledModels 只认精确 fullId / glob 匹配结果。
	 */
	private buildOAuthModelDrafts(record: ChannelRecord): ModelDraft[] {
		const saved = record.models.map(modelEntryToDraft);
		const savedIds = new Set(saved.map((m) => m.id.toLowerCase()));
		const runtimeOnly = this.runtimeModels
			.filter((m) => m.provider === record.provider && !savedIds.has(m.id.toLowerCase()))
			.map(
				(m): ModelDraft => ({
					id: m.id,
					name: m.name || m.id,
					contextWindow: null,
					maxTokens: null,
					reasoning: null,
					input: null,
					selected: true,
					metaConfirmed: false,
				}),
			);
		const drafts = [...saved, ...runtimeOnly];

		// 以 enabledModels 的实际过滤为准回显勾选（模型范围的唯一权威来源）
		const patterns = Array.isArray(this.settings.enabledModels)
			? this.settings.enabledModels
				.filter((v): v is string => typeof v === "string")
				.map((v) => v.trim())
				.filter(Boolean)
			: undefined;
		const options: ScopedModelOption[] = drafts.map((m) => ({
			fullId: `${record.provider}/${m.id}`,
			provider: record.provider,
			id: m.id,
			name: m.name,
		}));
		const resolved = this.resolveScopedModelIdsFromPatterns(patterns, options);
		for (const m of drafts) {
			m.selected = !resolved.hasFilter || resolved.enabledIds.includes(`${record.provider}/${m.id}`);
		}
		return drafts;
	}

	/**
	 * 编辑框只显示可直接使用的真 Key；引用原文保留在配置里，用户未改输入框时
	 * 保存不会把动态引用冻结成静态密钥。
	 */
	private async resolveExistingApiKey(
		record: ChannelRecord,
	): Promise<string> {
		let raw = "";
		if (record.keyRefKind === "modelsJson") {
			const key = this.models.providers?.[record.provider]?.apiKey;
			raw = typeof key === "string" ? key.trim() : "";
		} else {
			const entry = this.auth[record.provider] as PiAuthEntry | undefined;
			const key = entry && typeof entry.key === "string" ? entry.key.trim() : "";
			if (record.keyRefKind === "keychain") {
				const account = parseKeychainAccount(key);
				if (!account) return "";
				raw = (await this.keychainGet(account))?.trim() ?? "";
			} else {
				raw = key;
			}
		}
		if (!raw) return "";
		// Keychain 的返回值永远按 literal secret 处理。不能仅凭内容以 `$`/`!`
		// 开头就执行，否则合法 Key 也可能被误当成引用。
		if (record.keyRefKind === "keychain") return raw;
		return isSecretReference(raw) ? this.resolveSecretRefValue(raw) : raw;
	}

	private cancelEdit(): void {
		if (this.draft?.saving) return;
		this.invalidateModelFetch();
		this.view = "list";
		this.draft = null;
		this.requestRender();
	}

	private selectPreset(presetId: string): void {
		const draft = this.draft;
		const preset = findPreset(presetId);
		if (!draft || !preset) return;
		this.invalidateModelFetch(draft);
		draft.presetId = preset.id;
		draft.isBuiltin = preset.builtinProvider !== null;
		draft.protocol = preset.protocol;
		draft.icon = preset.icon;
		if (preset.builtinProvider) {
			draft.provider = preset.builtinProvider;
			draft.alias = preset.label;
			draft.baseUrl = ""; // 内置：留空 = 官方默认
		} else {
			if (preset.id.startsWith("custom-")) {
				draft.alias = "";
				draft.baseUrl = "";
				draft.provider = "";
			} else {
				draft.alias = preset.label;
				draft.baseUrl = preset.baseUrl;
				draft.provider = normalizeProviderId(preset.label) || preset.id;
			}
		}
		draft.authHeader = false; // 新增渠道无既有 models.json 条目；编辑态不走 selectPreset
		draft.drafts = null;
		draft.fetchError = "";
		draft.fetchedTotal = null;
		draft.fetchNotice = "none";
		draft.error = "";
		this.requestRender();
	}

	private invalidateModelFetch(draft: EditDraft | null = this.draft): void {
		this.modelFetchGeneration += 1;
		if (draft?.fetching) draft.fetching = false;
	}

	/** 仅包含会定义模型清单请求的字段；返回值在请求启动时作为不可变快照保存。 */
	private modelFetchFingerprint(draft: EditDraft): string {
		return JSON.stringify([
			draft.mode,
			draft.originalProvider,
			draft.presetId,
			draft.provider,
			draft.isBuiltin,
			draft.baseUrl,
			draft.protocol,
			draft.apiKey,
			draft.allowInsecureHttp,
			draft.authHeader,
			draft.headers.map(({ key, value }) => [key, value]),
		]);
	}

	private isCurrentModelFetch(draft: EditDraft, generation: number, fingerprint: string): boolean {
		return (
			this.modelFetchGeneration === generation
			&& this.draft === draft
			&& this.modelFetchFingerprint(draft) === fingerprint
		);
	}

	private updateDraft(mutate: (draft: EditDraft) => void): void {
		if (!this.draft) return;
		// 任何新的草稿变更都重置「严重错误」标记；只有 saveDraft 的失败路径
		// 会在本次 mutate 里重新置位（回滚未完成的醒目展示）。
		this.draft.errorSevere = false;
		mutate(this.draft);
		this.requestRender();
	}

	private updateRequestDraft(mutate: (draft: EditDraft) => void): void {
		if (!this.draft || this.draft.saving) return;
		this.invalidateModelFetch(this.draft);
		this.updateDraft(mutate);
	}

	/**
	 * 拉取模型用的 key：输入框非空时永远按可直接发送的真 Key 处理。
	 * 只有编辑态输入框为空时，才按已保存的 keyHint 回读 Keychain 或解析
	 * `$ENV_VAR` / `!cmd ...` 原引用。解析失败抛中文错误，由调用方展示。
	 */
	private async resolveFetchApiKey(draft: EditDraft): Promise<string | null> {
		const direct = literalApiKeyForRequest(draft.apiKey);
		if (direct) return direct;
		if (draft.mode === "edit" && draft.keyHint === "keychain") {
			const entry = this.auth[draft.provider] as PiAuthEntry | undefined;
			const account =
				(entry && typeof entry.key === "string" ? parseKeychainAccount(entry.key) : null) ??
				keychainAccountFor(draft.provider);
			try {
				return await this.keychainGet(account);
			} catch {
				return null;
			}
		}
		if (draft.mode === "edit" && (draft.keyHint === "env" || draft.keyHint === "command")) {
			// 输入框被清空（或回填尚未完成）时，回退到 auth.json 里已保存的引用解析
			const entry = this.auth[draft.provider] as PiAuthEntry | undefined;
			const ref = entry && typeof entry.key === "string" ? entry.key.trim() : "";
			if (ref) return this.resolveSecretRefValue(ref);
		}
		return null;
	}

	/** 调用 Rust resolve_secret_ref 解析 `$ENV_VAR` / `!cmd` 引用；失败抛中文错误。 */
	private async resolveSecretRefValue(ref: string): Promise<string> {
		let value: string;
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			value = await invoke<string>("resolve_secret_ref", { ref });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(t("settings.channels.secretRefResolveFailed", { ref, message }));
		}
		const trimmed = typeof value === "string" ? value.trim() : "";
		if (!trimmed) {
			throw new Error(t("settings.channels.secretRefResolveFailed", { ref, message: "empty" }));
		}
		return trimmed;
	}

	private fetchErrorText(kind: FetchModelsErrorKind, status?: number, message?: string): string {
		const params = { status: status ?? 0, message: message ?? "" };
		switch (kind) {
			case "unauthorized":
				return t("channels.fetchError.unauthorized", params);
			case "not_found":
				return t("channels.fetchError.not_found");
			case "timeout":
				return t("channels.fetchError.timeout");
			case "redirect_blocked":
				return t("channels.fetchError.redirect_blocked");
			case "bad_response":
				return t("channels.fetchError.bad_response");
			case "empty":
				return t("channels.fetchError.empty");
			case "http":
				return t("channels.fetchError.http", params);
			case "network":
			default:
				return t("channels.fetchError.network", params);
		}
	}

	private async fetchModelsAction(): Promise<void> {
		const draft = this.draft;
		if (!draft || draft.saving || draft.fetching || draft.apiKeyResolving) return;

		// 先过 SSRF 校验（与保存同一套规则）
		const effectiveBaseUrl = this.effectiveDraftBaseUrl(draft);
		const check = validateBaseUrl(effectiveBaseUrl, draft.allowInsecureHttp);
		if (!check.ok) {
			this.updateDraft((d) => {
				d.error = this.baseUrlErrorText(check.errorCode);
				d.fetchError = "";
			});
			return;
		}

		const generation = ++this.modelFetchGeneration;
		const fingerprint = this.modelFetchFingerprint(draft);
		draft.fetching = true;
		draft.fetchError = "";
		draft.error = "";
		this.requestRender();

		let apiKey: string | null = null;
		try {
			apiKey = await this.resolveFetchApiKey(draft);
		} catch (err) {
			if (!this.isCurrentModelFetch(draft, generation, fingerprint)) return;
			// $ENV_VAR / !cmd 引用解析失败：中文错误，不发请求
			const message = err instanceof Error ? err.message : String(err);
			draft.fetching = false;
			draft.error = message;
			draft.fetchError = "";
			this.requestRender();
			return;
		}
		if (!this.isCurrentModelFetch(draft, generation, fingerprint)) return;
		if (!apiKey) {
			draft.fetching = false;
			draft.error = t("channels.errors.keyRequired");
			draft.fetchError = "";
			this.requestRender();
			return;
		}

		const result = await fetchModelsList({
			protocol: draft.protocol,
			baseUrl: check.normalized ?? effectiveBaseUrl,
			apiKey,
			customHeaders: rowsToHeadersRecord(draft.headers),
			authHeader: draft.authHeader,
		});

		if (!this.isCurrentModelFetch(draft, generation, fingerprint)) return;
		if (!result.ok) {
			// 200 但 0 个模型 = 成功的空响应：清掉所有旧 remote-only 行（它们不再能
			// 伪装成远端可用），只保留 saved/manual；fetchedTotal 记 0，UI 显示明确提示。
			if (result.error.kind === "empty") {
				draft.fetching = false;
				draft.drafts = mergeFetchedModelDrafts([], draft.drafts);
				draft.fetchError = "";
				draft.fetchedTotal = 0;
				draft.fetchNotice = "empty";
				this.requestRender();
				return;
			}
			// 拉取失败：保留现有草稿不动，但错误区必须明确「无法确认远端模型」，
			// 旧清单不得看起来像本次成功结果（fetchError 与 fetchedTotal 分离）。
			draft.fetching = false;
			draft.fetchError = this.fetchErrorText(result.error.kind, result.error.status, result.error.message);
			this.requestRender();
			return;
		}

		const catalog = { provider: draft.provider, entries: this.catalogModels };
		const fetchedDrafts = completeModelsMeta(result.models, draft.presetId || null, catalog);
		draft.fetching = false;
		// 与既有草稿合并（来源真实语义）：同 ID 的已保存/手动模型保留勾选与已确认
		// 字段并标记本次远端已发现；新发现默认不勾选；上次远端出现、这次未出现的
		// remote-only 行删除；saved/manual 漏项保留但标记本次远端未发现。
		draft.drafts = mergeFetchedModelDrafts(fetchedDrafts, draft.drafts);
		draft.fetchError = "";
		draft.fetchedTotal = result.filteredCount;
		draft.fetchNotice =
			result.parsedCount > 0 && result.filteredCount === 0 ? "all_filtered" : "none";
		this.requestRender();
	}

	private addManualModel(): void {
		const draft = this.draft;
		if (!draft) return;
		const created = draftFromManualId(draft.manualId, draft.presetId || null, {
			provider: draft.provider,
			entries: this.catalogModels,
		});
		if (!created) return;
		const exists = (draft.drafts ?? []).some((m) => m.id.toLowerCase() === created.id.toLowerCase());
		this.updateDraft((d) => {
			if (!exists) d.drafts = [...(d.drafts ?? []), created];
			d.manualId = "";
			d.error = "";
		});
	}

	private effectiveDraftBaseUrl(draft: EditDraft): string {
		if (draft.isBuiltin) {
			const preset = findPreset(draft.presetId) ?? findPresetByBuiltinProvider(draft.provider);
			return draft.baseUrl.trim() || preset?.baseUrl || "";
		}
		return draft.baseUrl.trim();
	}

	private baseUrlErrorText(code: string | undefined): string {
		switch (code) {
			case "empty":
				return t("channels.errors.baseUrlRequired");
			case "http_not_localhost":
				return t("channels.errors.httpNotLocalhost");
			case "insecure_http":
				return t("channels.errors.insecureNeedsAck");
			case "invalid":
			default:
				return t("channels.errors.baseUrlInvalid");
		}
	}

	// ------------------------------------------------------------------
	// 保存（D7）
	// ------------------------------------------------------------------

	private validateDraft(draft: EditDraft): string {
		if (draft.isBuiltin) {
			if (!draft.provider) return t("channels.errors.providerRequired");
			if (draft.mode === "add" && (this.auth[draft.provider] || this.models.providers?.[draft.provider])) {
				return t("channels.errors.providerReserved", { provider: draft.provider });
			}
		} else {
			if (!draft.alias.trim()) return t("channels.errors.nameRequired");
			const provider = normalizeProviderId(
				draft.mode === "add" ? draft.provider || draft.alias : draft.provider,
			);
			if (!isValidProviderId(provider)) return t("channels.errors.providerRequired");
			if (draft.mode === "add" && (this.auth[provider] || this.models.providers?.[provider])) {
				return t("channels.errors.providerExists", { provider });
			}
			draft.provider = provider;
		}
		if (draft.mode === "add" && !draft.apiKey.trim()) return t("channels.errors.keyRequired");
		if (draft.mode === "edit" && draft.keyHint === "none" && !draft.apiKey.trim()) {
			return t("channels.errors.keyRequired");
		}

		const effectiveBaseUrl = this.effectiveDraftBaseUrl(draft);
		const check = validateBaseUrl(effectiveBaseUrl, draft.allowInsecureHttp);
		if (!check.ok) return this.baseUrlErrorText(check.errorCode);
		draft.baseUrl = draft.isBuiltin && !draft.baseUrl.trim() ? "" : (check.normalized ?? effectiveBaseUrl);
		draft.warning =
			check.warning === "private_network"
				? t("channels.errors.warnPrivateNetwork")
				: check.warning === "metadata_endpoint"
					? t("channels.errors.warnMetadata")
					: "";

		if (!draft.isBuiltin) {
			const selected = (draft.drafts ?? []).filter((m) => m.selected);
			if (selected.length === 0) return t("channels.errors.needModels");
		}
		return "";
	}

	private async saveDraft(): Promise<void> {
		const draft = this.draft;
		if (!draft || draft.saving || draft.fetching || draft.apiKeyResolving) return;
		this.invalidateModelFetch(draft);
		if (draft.oauthReadonly) {
			await this.saveOAuthModelScope(draft);
			return;
		}
		const error = this.validateDraft(draft);
		if (error) {
			this.updateDraft((d) => {
				d.error = error;
			});
			return;
		}

		this.updateDraft((d) => {
			d.saving = true;
			d.error = "";
		});

		try {
			const preset = findPreset(draft.presetId) ?? findPresetByBuiltinProvider(draft.provider);
			const selectedModels = draft.isBuiltin
				? undefined
				: (draft.drafts ?? []).filter((m) => m.selected);

			// ---- 先备好全部新状态（纯计算，不触碰磁盘与 this.*）----
			const result = upsertChannel(this.auth, this.models, {
				provider: draft.provider,
				isBuiltin: draft.isBuiltin,
				baseUrl: draft.isBuiltin && !draft.baseUrl ? (preset?.baseUrl ?? "") : draft.baseUrl,
				presetDefaultBaseUrl: preset?.baseUrl,
				protocol: draft.isBuiltin ? null : draft.protocol,
				newApiKey:
					draft.mode === "add" || draft.apiKeyDirty
						? draft.apiKey.trim() || null
						: null,
				headers: rowsToHeadersRecord(draft.headers),
				models: selectedModels,
			});

			// GUI 元数据：别名/备注/图标/预设/排序/远端发现总数（不可变构造）
			const metaEntry = {
				...(this.meta.channels[draft.provider] ?? {}),
				alias: draft.alias.trim() || undefined,
				note: draft.note.trim() || undefined,
				icon: draft.icon || preset?.icon || undefined,
				presetId: draft.presetId || undefined,
				updatedAt: new Date().toISOString(),
				createdAt: this.meta.channels[draft.provider]?.createdAt ?? new Date().toISOString(),
			};
			if (!draft.isBuiltin && draft.fetchedTotal !== null) {
				metaEntry.modelsTotal = draft.fetchedTotal;
			}
			const nextMeta: ChannelsMetaFile = {
				version: 1,
				channels: { ...this.meta.channels, [draft.provider]: metaEntry },
				order: [...(this.meta.order ?? [])],
			};
			if (!nextMeta.order!.includes(draft.provider)) nextMeta.order!.push(draft.provider);

			const paths = await this.resolvePaths();

			// ---- 单次领域命令：Rust 侧带 recovery journal 的真事务 ----
			// entry 级 patch（锁内重读-合并，不覆盖其他 provider/字段）+
			// 失败逆序回滚 + 启动恢复；前端不再编排多步写与补偿回滚。
			const ops = buildChannelSaveOps(this.auth, this.models, draft.provider, result);
			await this.saveChannelTransaction(
				buildUpsertTransactionPayload(
					this.transactionPaths(paths),
					draft.provider,
					ops,
					metaEntry,
					result.keychainWrite,
				),
			);

			// 全部落盘成功后才提交内存状态
			this.auth = result.auth;
			this.models = result.models;
			this.meta = nextMeta;

			const displayName = draft.alias.trim() || draft.provider;
			this.view = "list";
			this.draft = null;
			this.message = result.migratedApiKey
				? `${t("channels.msg.savedAndReloading", { name: displayName })} ${t("channels.msg.keyMigrated")}`
				: t("channels.msg.savedAndReloading", { name: displayName });
			this.requestRender();

			// D7：复用 main.ts 的 auth 重载链路（streaming 时推迟到 idle）
			this.onConfigChanged?.();
			void this.verifyModelsAppear(draft.provider);
		} catch (err) {
			const display = channelTransactionErrorDisplay(
				err,
				(message) => t("channels.errors.saveFailed", { message }),
			);
			this.updateDraft((d) => {
				d.saving = false;
				d.errorSevere = display.severe;
				d.error = display.text;
			});
			if (display.committed) this.onConfigChanged?.();
		}
	}

	/**
	 * OAuth 只读编辑页保存：只写 settings.json 的 enabledModels（Ctrl+P 循环范围），
	 * 不动 auth.json / Keychain / meta / models.json。
	 *
	 * 为什么不写 models.json 的 models 数组：pi 对内置 provider 是 merge-by-id
	 * （内置模型保留、自定义按 id upsert），勾选子集无法禁用未勾选的内置模型；
	 * enabledModels（格式同 --models flag，支持精确 `provider/id` 与 glob）才是
	 * 唯一能限制内置模型循环范围的通道。
	 *
	 * 语义：全选 = 移除本渠道覆盖（无其它遗留 pattern 时删除 enabledModels，恢复默认全量）；
	 * 子集 = 写子集（其它渠道的既有 pattern 保留；当前无过滤时先把其它渠道物化为 provider/*）。
	 */
	private async saveOAuthModelScope(draft: EditDraft): Promise<void> {
		const all = draft.drafts ?? [];
		const selected = all.filter((m) => m.selected);
		if (all.length === 0 || selected.length === 0) {
			this.updateDraft((d) => {
				d.error = t("channels.errors.needModels");
			});
			return;
		}

		this.updateDraft((d) => {
			d.saving = true;
			d.error = "";
		});

		try {
			// 全部已知模型：运行时 + models.json 显式条目 + 编辑页清单（并集，去重）
			const known = new Map<string, { provider: string; id: string }>();
			const addKnown = (provider: string, id: string) => {
				const key = `${provider}/${id}`.toLowerCase();
				if (!known.has(key)) known.set(key, { provider, id });
			};
			for (const m of this.runtimeModels) addKnown(m.provider, m.id);
			for (const [provider, entry] of Object.entries(this.models.providers ?? {})) {
				for (const m of entry?.models ?? []) {
					if (typeof m?.id === "string" && m.id) addKnown(provider, m.id);
				}
			}
			for (const m of all) addKnown(draft.provider, m.id);
			const allKnownProviders = new Set<string>([
				...Object.keys(this.auth),
				...Object.keys(this.models.providers ?? {}),
				...Object.keys(this.meta.channels),
				...this.runtimeModels.map((m) => m.provider),
			]);
			allKnownProviders.add(draft.provider);

			const providerModelIds = [
				...new Set([
					...all.map((m) => m.id),
					...this.runtimeModels.filter((m) => m.provider === draft.provider).map((m) => m.id),
				]),
			];

			// RMW：读磁盘最新 settings.json 合并，不覆盖其它字段
			const { doc } = await this.readPiGlobalSettingsDoc();
			const existingPatterns = Array.isArray(doc.enabledModels)
				? doc.enabledModels.filter((v): v is string => typeof v === "string")
				: undefined;
			const merged = mergeProviderModelScope({
				provider: draft.provider,
				providerModelIds,
				selectedIds: selected.map((m) => m.id),
				allKnownModels: [...known.values()],
				allKnownProviders: [...allKnownProviders],
				existingPatterns,
			});

			const nextDoc: Record<string, unknown> = { ...doc };
			if (merged.patterns === undefined) {
				delete nextDoc.enabledModels;
			} else {
				nextDoc.enabledModels = merged.patterns;
			}

			const paths = await this.resolvePaths();
			await this.saveChannelTransaction(
				buildEnabledModelsTransactionPayload(
					this.transactionPaths(paths),
					draft.provider,
					merged.patterns,
				),
			);
			this.settings = nextDoc;

			// 同步「模型范围」区的内存状态（已加载时），避免之后保存用旧快照覆盖
			if (this.scopedModels.length > 0) {
				const resolved = this.resolveScopedModelIdsFromPatterns(merged.patterns, this.scopedModels);
				this.scopedModelsUnknownPatterns = resolved.unknownPatterns;
				this.setScopedModelsSelection(resolved.hasFilter, resolved.enabledIds);
				this.scopedModelsSavedSnapshot = this.scopedModelsSnapshot();
			}

			const displayName = draft.alias.trim() || draft.provider;
			const clearedAll = merged.patterns === undefined;
			this.view = "list";
			this.draft = null;
			this.message = clearedAll
				? t("settings.channels.oauthScopeCleared", { name: displayName })
				: t("settings.channels.oauthScopeSaved", { name: displayName });
			this.requestRender();
			this.onConfigChanged?.();
		} catch (err) {
			const display = channelTransactionErrorDisplay(
				err,
				(message) => t("channels.errors.saveFailed", { message }),
			);
			this.updateDraft((d) => {
				d.saving = false;
				d.errorSevere = display.severe;
				d.error = display.text;
			});
			if (display.committed) this.onConfigChanged?.();
		}
	}

	/** best-effort 验证：重载后新模型应出现在 get_available_models。 */
	private async verifyModelsAppear(provider: string): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		if (!rpcBridge.isConnected) {
			this.message = t("channels.msg.verifyLater");
			this.requestRender();
			return;
		}
		try {
			const raw = await rpcBridge.getAvailableModels();
			const found = (Array.isArray(raw) ? raw : []).some(
				(entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).provider === provider,
			);
			this.message = found ? t("channels.msg.verified") : t("channels.msg.verifyLater");
		} catch {
			this.message = t("channels.msg.verifyLater");
		}
		this.requestRender();
	}

	// ------------------------------------------------------------------
	// 删除 / 复制 / 设为默认
	// ------------------------------------------------------------------

	private async deleteChannel(record: ChannelRecord): Promise<void> {
		if (record.authKind === "oauth") return;
		if (this.confirmingDelete !== record.provider) {
			this.confirmingDelete = record.provider;
			this.requestRender();
			return;
		}
		this.confirmingDelete = null;
		try {
			const result = removeChannel(this.auth, this.models, record.provider);
			const paths = await this.resolvePaths();
			await this.saveChannelTransaction(
				buildDeleteTransactionPayload(
					this.transactionPaths(paths),
					record.provider,
					result.keychainAccountToDelete,
				),
			);
			delete this.meta.channels[record.provider];
			if (this.meta.order) this.meta.order = this.meta.order.filter((p) => p !== record.provider);
			this.auth = result.auth;
			this.models = result.models;
			this.message = t("channels.msg.deleted", { name: record.displayName });
			this.requestRender();
			this.onConfigChanged?.();
		} catch (err) {
			const display = channelTransactionErrorDisplay(
				err,
				(message) => t("channels.errors.deleteFailed", { message }),
			);
			this.message = display.text;
			this.requestRender();
			if (display.committed) this.onConfigChanged?.();
		}
	}

	private nextCopyProviderId(base: string): string {
		let candidate = `${base}-copy`;
		let index = 2;
		while (this.auth[candidate] || this.models.providers?.[candidate]) {
			candidate = `${base}-copy-${index}`;
			index += 1;
		}
		return candidate;
	}

	private async duplicateChannelAction(record: ChannelRecord): Promise<void> {
		if (record.authKind === "oauth") return;
		try {
			const newProvider = this.nextCopyProviderId(record.provider);
			const result = duplicateChannel(this.auth, this.models, this.meta, record.provider, newProvider);
			if (!result.canDuplicate) return;

			let copiedKey = false;
			let keychainWrite: { account: string; secret: string } | null = null;
			if (result.sourceKeyRefKind === "keychain" && result.sourceKeychainAccount) {
				const secret = await this.keychainGet(result.sourceKeychainAccount).catch(() => null);
				if (secret) {
					const newAccount = keychainAccountFor(newProvider);
					const entry = result.auth[newProvider] as PiAuthEntry | undefined;
					if (entry) entry.key = buildKeychainRefCommand(newAccount);
					keychainWrite = { account: newAccount, secret };
					copiedKey = true;
				}
			}

			const paths = await this.resolvePaths();
			const metaEntry = {
				...(result.meta.channels[newProvider] ?? {}),
				alias: `${record.displayName} 副本`,
				createdAt: new Date().toISOString(),
			};
			await this.saveChannelTransaction(
				buildDuplicateTransactionPayload(
					this.transactionPaths(paths),
					newProvider,
					result.auth[newProvider] as PiAuthEntry | undefined,
					result.models.providers?.[newProvider],
					metaEntry,
					keychainWrite,
				),
			);
			this.meta = result.meta;
			this.meta.channels[newProvider] = metaEntry;
			this.auth = result.auth;
			this.models = result.models;
			this.message =
				result.sourceKeyRefKind === "keychain"
					? copiedKey
						? `${t("channels.msg.duplicated", { name: newProvider })} ${t("channels.msg.keychainCopied")}`
						: `${t("channels.msg.duplicated", { name: newProvider })} ${t("channels.msg.keychainCopyFailed")}`
					: t("channels.msg.duplicated", { name: newProvider });
			this.requestRender();
			this.onConfigChanged?.();
		} catch (err) {
			const display = channelTransactionErrorDisplay(
				err,
				(message) => t("channels.errors.duplicateFailed", { message }),
			);
			this.message = display.text;
			this.requestRender();
			if (display.committed) this.onConfigChanged?.();
		}
	}

	private async setDefaultModel(provider: string, modelId: string): Promise<void> {
		try {
			const next = applySetDefault(this.settings, provider, modelId);
			const paths = await this.resolvePaths();
			await this.saveChannelTransaction(
				buildSettingsTransactionPayload(
					this.transactionPaths(paths),
					provider,
					{ set: { defaultProvider: provider, defaultModel: modelId } },
				),
			);
			this.settings = next;
			// 当前活跃线程立即生效（不阻断）
			if (rpcBridge.isConnected) {
				await rpcBridge.setModel(provider, modelId).catch(() => undefined);
			}
			this.expandedProvider = null;
			this.message = t("channels.msg.defaultSet", { provider, model: modelId });
			this.requestRender();
			this.onConfigChanged?.();
		} catch (err) {
			const display = channelTransactionErrorDisplay(
				err,
				(message) => t("channels.errors.defaultFailed", { message }),
			);
			this.message = display.text;
			this.requestRender();
			if (display.committed) this.onConfigChanged?.();
		}
	}

	private modelsForDefault(record: ChannelRecord): Array<{ id: string; name: string }> {
		if (record.models.length > 0) {
			return record.models.map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id }));
		}
		return this.runtimeModels
			.filter((m) => m.provider === record.provider)
			.map((m) => ({ id: m.id, name: m.name || m.id }));
	}

	private async openExternalUrl(url: string): Promise<void> {
		try {
			const { open } = await import("@tauri-apps/plugin-shell");
			await open(url);
		} catch {
			// 打开失败不阻塞
		}
	}

	// ------------------------------------------------------------------
	// 渲染
	// ------------------------------------------------------------------

	private keyRefBadge(record: ChannelRecord): TemplateResult | typeof nothing {
		const label = (() => {
			switch (record.keyRefKind) {
				case "env":
					return t("channels.card.keyRefEnv");
				case "keychain":
					return t("channels.card.keyRefKeychain");
				case "command":
					return t("channels.card.keyRefCommand");
				case "plain":
					return t("channels.card.keyRefPlain");
				case "modelsJson":
					return t("channels.card.keyRefModelsJson");
				case "none":
					return record.authKind === "none" ? t("channels.card.keyRefNone") : "";
				default:
					return "";
			}
		})();
		if (!label) return nothing;
		return html`<span class="channel-badge channel-badge-muted">${label}</span>`;
	}

	private renderCard(record: ChannelRecord): TemplateResult {
		const isOauth = record.authKind === "oauth";
		const expanded = this.expandedProvider === record.provider;
		const confirming = this.confirmingDelete === record.provider;
		const defaultCandidates = expanded ? this.modelsForDefault(record) : [];
		const officialUrl = record.baseUrl ? `https://${record.baseUrl.replace(/^https?:\/\//, "").split("/")[0]}` : "";

		// URL 行内容：baseUrl（models.json 覆盖或预设默认）+ 模型数 + 默认模型。
		// 预设表反查不到默认地址的内置/OAuth 渠道没有 baseUrl，整行无内容时隐藏，不显示「—」。
		const linkPart = record.baseUrl
			? html`<a
					class="channel-link"
					href=${officialUrl}
					title=${t("channels.openLink")}
					@click=${(e: Event) => {
						e.preventDefault();
						void this.openExternalUrl(officialUrl);
					}}
				>${record.baseUrl}</a>`
			: null;
		// 模型数按来源区分（MODEL-04）：
		// - 内置渠道（pi 内置模型）：「模型由 pi 内置提供 · 已启用 N」（N 来自运行时）；
		// - 有远端发现记录的：「已启用 N / 共发现 M」；
		// - 手工配置：实际条数「N 个模型」；
		// - 未探测过（无运行时数据且无拉取记录）：「未拉取模型清单」，不显示成 0。
		const modelsPart = (() => {
			if (record.isBuiltin && record.modelCount === 0) {
				if (record.runtimeModelCount === null) return t("settings.channels.cardModelsNotFetched");
				return record.runtimeModelCount > 0
					? t("settings.channels.cardBuiltinModels", { count: record.runtimeModelCount })
					: t("channels.card.models", { count: 0 }); // 探测过但确实 0 个
			}
			if (record.modelCount > 0) {
				return record.modelsTotal !== null && record.modelsTotal > record.modelCount
					? t("settings.channels.cardEnabledOfDiscovered", {
							enabled: record.modelCount,
							total: record.modelsTotal,
						})
					: t("channels.card.models", { count: record.modelCount });
			}
			// 自定义渠道且 models.json 无模型条目：拉取过显示「已启用 0 / 共发现 M」，未拉取过显示引导
			return record.modelsTotal !== null
				? t("settings.channels.cardEnabledOfDiscovered", { enabled: 0, total: record.modelsTotal })
				: t("settings.channels.cardModelsNotFetched");
		})();
		const defaultPart = record.isDefault && record.defaultModel ? record.defaultModel : null;
		const metaParts = [linkPart, modelsPart, defaultPart].filter(
			(part): part is NonNullable<typeof part> => part !== null,
		);

		return html`
			<div class="channel-card ${record.isDefault ? "channel-card-default" : ""}">
				<div class="channel-card-main">
					<span class="channel-icon">${record.icon}</span>
					<div class="channel-card-meta">
						<div class="channel-card-title-row">
							<span class="settings-label">${record.displayName}</span>
							${record.isBuiltin ? html`<span class="channel-badge channel-badge-muted">${t("channels.card.builtin")}</span>` : nothing}
							${isOauth ? html`<span class="channel-badge channel-badge-oauth">${t("channels.card.oauthBadge")}</span>` : this.keyRefBadge(record)}
							${record.isDefault ? html`<span class="channel-badge channel-badge-active">${t("channels.card.inUse")}</span>` : nothing}
						</div>
						${metaParts.length > 0
							? html`<div class="settings-desc">${metaParts.map((part, index) => html`${index > 0 ? " · " : nothing}${part}`)}</div>`
							: nothing}
						${record.note ? html`<div class="settings-desc">${record.note}</div>` : nothing}
						${isOauth ? html`<div class="settings-desc">${t("channels.card.oauthReadonly")}</div>` : nothing}
					</div>
				</div>
				<div class="channel-card-actions">
					<button class="ghost-btn" @click=${() => this.openEdit(record)}>${t("channels.card.edit")}</button>
					${!isOauth
						? html`
							<button class="ghost-btn" @click=${() => void this.duplicateChannelAction(record)}>${t("channels.card.duplicate")}</button>
							<button
								class="ghost-btn ${confirming ? "danger" : ""}"
								title=${confirming ? t("channels.card.deleteHint") : ""}
								@click=${() => void this.deleteChannel(record)}
							>${confirming ? t("channels.card.confirmDelete") : t("channels.card.delete")}</button>
						`
						: nothing}
					<button
						class="ghost-btn"
						title=${record.isDefault ? t("channels.card.alreadyDefault") : ""}
						?disabled=${record.isDefault}
						@click=${() => {
							if (record.isDefault) return;
							this.expandedProvider = expanded ? null : record.provider;
							this.requestRender();
						}}
					>${t("channels.card.setDefault")}</button>
				</div>
				${expanded
					? html`
						<div class="channel-default-picker">
							<div class="settings-desc">${t("channels.card.chooseDefault")}</div>
							${defaultCandidates.length === 0
								? html`<div class="settings-desc">${record.isBuiltin ? t("channels.card.needRuntimeForDefault") : t("channels.card.noModelsForDefault")}</div>`
								: defaultCandidates.map(
										(model) => html`
											<div class="channel-default-model-row">
												<span class="channel-model-id">${model.id}</span>
												<button class="ghost-btn" @click=${() => void this.setDefaultModel(record.provider, model.id)}>
													${t("channels.card.setDefault")}
												</button>
											</div>
										`,
									)}
						</div>
					`
					: nothing}
			</div>
		`;
	}

	private renderPresetChips(draft: EditDraft): TemplateResult | typeof nothing {
		if (draft.mode !== "add") return nothing;
		return html`
			<div class="settings-label" style="margin-top:14px;">${t("channels.edit.presetLabel")}</div>
			<div class="channel-preset-grid">
				${CHANNEL_PRESETS.map(
					(preset) => html`
						<button
							class="channel-preset-chip ${draft.presetId === preset.id ? "active" : ""}"
							?disabled=${draft.fetching}
							@click=${() => this.selectPreset(preset.id)}
						>
							<span class="channel-icon">${preset.icon}</span>
							<span>${preset.label}</span>
						</button>
					`,
				)}
			</div>
		`;
	}

	/** 模型行的元数据状态徽章（区分精确可靠补全 / 预设推断 / 信息不全）。 */
	private renderModelMetaBadge(model: ModelDraft): TemplateResult | typeof nothing {
		const badge = modelMetaBadge(model);
		if (!badge) return nothing;
		return html`<span class="channel-badge ${badge.warn ? "channel-badge-warn" : "channel-badge-muted"}">${badge.text}</span>`;
	}

	/**
	 * 模型行的元数据输入（contextWindow/maxTokens/reasoning/图片输入）。
	 * OAuth 只读页不写 models.json，这些输入无落盘通道，整体不渲染（只留勾选）。
	 */
	private renderModelMetaFields(draft: EditDraft, index: number): TemplateResult | typeof nothing {
		if (draft.oauthReadonly) return nothing;
		const model = draft.drafts?.[index];
		if (!model) return nothing;
		return html`
			<label class="channel-model-field">
				<span>${t("channels.edit.contextWindow")}</span>
				<input
					type="number"
					min="1"
					placeholder=${t("settings.channels.metaUnknown")}
					.value=${model.contextWindow === null ? "" : String(model.contextWindow)}
					@change=${(e: Event) =>
						this.updateDraft((d) => {
							const target = d.drafts?.[index];
							if (!target) return;
							const raw = (e.target as HTMLInputElement).value.trim();
							const value = Number(raw);
							target.contextWindow = raw && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
							clearMetaSource(target, "contextWindow");
							recomputeMetaConfirmed(target);
						})}
				/>
			</label>
			<label class="channel-model-field">
				<span>${t("channels.edit.maxTokens")}</span>
				<input
					type="number"
					min="1"
					placeholder=${t("settings.channels.metaUnknown")}
					.value=${model.maxTokens === null ? "" : String(model.maxTokens)}
					@change=${(e: Event) =>
						this.updateDraft((d) => {
							const target = d.drafts?.[index];
							if (!target) return;
							const raw = (e.target as HTMLInputElement).value.trim();
							const value = Number(raw);
							target.maxTokens = raw && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
							clearMetaSource(target, "maxTokens");
							recomputeMetaConfirmed(target);
						})}
				/>
			</label>
			<label class="channel-model-field">
				<span>${t("channels.edit.reasoning")}</span>
				<select
					class="settings-path-input"
					.value=${model.reasoning === null ? "unknown" : model.reasoning ? "yes" : "no"}
					@change=${(e: Event) =>
						this.updateDraft((d) => {
							const target = d.drafts?.[index];
							if (!target) return;
							const value = (e.target as HTMLSelectElement).value;
							target.reasoning = value === "yes" ? true : value === "no" ? false : null;
							clearMetaSource(target, "reasoning");
							recomputeMetaConfirmed(target);
						})}
				>
					<option value="unknown">${t("channels.edit.reasoningUnknown")}</option>
					<option value="yes">${t("channels.edit.reasoningYes")}</option>
					<option value="no">${t("channels.edit.reasoningNo")}</option>
				</select>
			</label>
			<label class="channel-model-field">
				<span>${t("settings.channels.inputCapability")}</span>
				<select
					class="settings-path-input"
					.value=${model.input === null ? "unknown" : model.input.length > 1 ? "text-image" : "text"}
					@change=${(e: Event) =>
						this.updateDraft((d) => {
							const target = d.drafts?.[index];
							if (!target) return;
							const value = (e.target as HTMLSelectElement).value;
							target.input =
								value === "text-image"
									? ["text", "image"]
									: value === "text"
										? ["text"]
										: null;
							clearMetaSource(target, "input");
							recomputeMetaConfirmed(target);
						})}
				>
					<option value="unknown">${t("settings.channels.inputUnknown")}</option>
					<option value="text">${t("settings.channels.inputTextOnly")}</option>
					<option value="text-image">${t("settings.channels.inputTextImage")}</option>
				</select>
			</label>
		`;
	}

	/**
	 * 模型行的来源徽章（不落盘的临时状态）：
	 * - 本次远端返回：remote →「远端发现」；saved/manual 命中 →「已保存/手动添加 · 远端已发现」；
	 * - 已成功拉取过但本行未命中 →「本次远端未发现」（警示色，不计入远端发现）；
	 * - 尚未成功拉取过：只标 saved/manual 自身来源，不做远端判断。
	 */
	private renderModelSourceBadge(model: ModelDraft, fetchDone: boolean): TemplateResult | typeof nothing {
		if (model.seenInFetch === true) {
			const key =
				model.origin === "saved"
					? "channels.edit.sourceSavedRemote"
					: model.origin === "manual"
						? "channels.edit.sourceManualRemote"
						: "channels.edit.sourceRemote";
			return html`<span class="channel-badge channel-badge-muted">${t(key)}</span>`;
		}
		if (fetchDone) {
			return html`<span class="channel-badge channel-badge-warn">${t("channels.edit.sourceNotSeen")}</span>`;
		}
		if (model.origin === "saved") {
			return html`<span class="channel-badge channel-badge-muted">${t("channels.edit.sourceSaved")}</span>`;
		}
		if (model.origin === "manual") {
			return html`<span class="channel-badge channel-badge-muted">${t("channels.edit.sourceManual")}</span>`;
		}
		return nothing;
	}

	/** 信息不全行的行内说明（按来源区分措辞；不猜参数是硬约束）。 */
	private modelUnknownNotice(model: ModelDraft): string {
		if (model.origin === "saved") return t("channels.edit.rowUnknownSaved");
		if (model.origin === "manual") return t("channels.edit.rowUnknownManual");
		return t("channels.edit.rowUnknownRemote");
	}

	/** 自定义渠道模型行：来源徽章 + 元数据状态 + 未知行的弱化覆盖入口。 */
	private renderModelRow(draft: EditDraft, model: ModelDraft, index: number, fetchDone: boolean): TemplateResult {
		const hasExplicitMeta = model.metaConfirmed;
		return html`
			<div class="channel-model-row ${model.selected ? "" : "channel-model-row-off"} ${hasExplicitMeta ? "" : "channel-model-row-incomplete"}">
				<input
					type="checkbox"
					.checked=${model.selected}
					@change=${(e: Event) =>
						this.updateDraft((d) => {
							const target = d.drafts?.[index];
							if (!target) return;
							target.selected = (e.target as HTMLInputElement).checked;
						})}
				/>
				<div class="channel-model-main">
					<div class="channel-model-id">
						${model.id}
						${this.renderModelSourceBadge(model, fetchDone)}
						${this.renderModelMetaBadge(model)}
					</div>
					${model.name !== model.id ? html`<div class="settings-desc">${model.name}</div>` : nothing}
					${!hasExplicitMeta
						? html`
							<div class="channel-model-notice">${this.modelUnknownNotice(model)}</div>
							<details class="channel-model-override">
								<summary>${t("channels.edit.advancedOverride")}</summary>
								<div class="channel-model-override-hint">${t("channels.edit.advancedOverrideHint")}</div>
								<div class="channel-model-override-fields">${this.renderModelMetaFields(draft, index)}</div>
							</details>
						`
						: nothing}
				</div>
				${hasExplicitMeta ? this.renderModelMetaFields(draft, index) : nothing}
			</div>
		`;
	}

	/**
	 * OAuth 只读页的模型清单：勾选语义是 settings.json enabledModels 的循环范围
	 * （不写 models.json），因此不适用「信息不全不可勾选/来源分组」规则，
	 * 保持简单平铺 + 全部可选。
	 */
	private renderOAuthModelDrafts(draft: EditDraft): TemplateResult {
		const drafts = draft.drafts ?? [];
		const selectedCount = drafts.filter((m) => m.selected).length;
		return html`
			<div class="settings-label" style="margin-top:14px;">${t("settings.channels.oauthModelsPick")}</div>
			<div class="settings-actions" style="margin-top:8px;">
				${drafts.length > 0
					? html`
						<button class="ghost-btn" @click=${() => this.updateDraft((d) => d.drafts?.forEach((m) => (m.selected = true)))}>${t("channels.edit.selectAll")}</button>
						<button class="ghost-btn" @click=${() => this.updateDraft((d) => d.drafts?.forEach((m) => (m.selected = false)))}>${t("channels.edit.clearAll")}</button>
						<span class="settings-desc">${t("channels.edit.summarySelected", { count: selectedCount })} / ${t("channels.edit.summaryTotal", { count: drafts.length })}</span>
					`
					: nothing}
			</div>
			${drafts.length > 0 && selectedCount === 0
				? html`<div class="channel-error">${t("channels.errors.needModels")}</div>`
				: nothing}
			${drafts.length > 0
				? html`
					<div class="channel-models-list">
						${drafts.map(
							(model, index) => html`
								<div class="channel-model-row ${model.selected ? "" : "channel-model-row-off"}">
									<input
										type="checkbox"
										.checked=${model.selected}
										@change=${(e: Event) =>
											this.updateDraft((d) => {
												const target = d.drafts?.[index];
												if (target) target.selected = (e.target as HTMLInputElement).checked;
											})}
									/>
									<div class="channel-model-main">
										<div class="channel-model-id">${model.id}</div>
										${model.name !== model.id ? html`<div class="settings-desc">${model.name}</div>` : nothing}
									</div>
								</div>
							`,
						)}
					</div>
				`
				: html`<div class="settings-desc" style="margin-top:8px;">${t("settings.channels.oauthNoModels")}</div>`}
		`;
	}

	private renderModelDrafts(draft: EditDraft): TemplateResult | typeof nothing {
		if (draft.isBuiltin && !draft.oauthReadonly) return nothing;
		if (draft.oauthReadonly) return this.renderOAuthModelDrafts(draft);

		const drafts = draft.drafts ?? [];
		const selectedCount = drafts.filter((m) => m.selected).length;
		// 本次会话是否已成功拉取过（含成功但 0 个）；拉取失败不改变该状态
		const fetchDone = draft.fetchedTotal !== null;
		const rows = drafts.map((model, index) => ({ model, index }));
		// 分组：本次远端返回（seenInFetch）vs 已保存/手动但本次未发现；
		// 未拉取过时不做远端判断，全部为本地行
		const remoteRows = fetchDone ? rows.filter((row) => row.model.seenInFetch === true) : [];
		const localRows = fetchDone ? rows.filter((row) => row.model.seenInFetch !== true) : rows;

		const summaryParts: string[] = [];
		if (fetchDone) summaryParts.push(t("channels.edit.summaryRemote", { count: remoteRows.length }));
		summaryParts.push(t("channels.edit.summaryLocal", { count: localRows.length }));
		summaryParts.push(t("channels.edit.summarySelected", { count: selectedCount }));

		return html`
			<div class="settings-label" style="margin-top:14px;">${t("channels.edit.modelsPick")}</div>
			<div class="settings-desc" style="margin-top:4px;">${t("channels.edit.modelsPickDesc")}</div>
			<div class="settings-actions" style="margin-top:8px;">
				<button class="ghost-btn" ?disabled=${draft.saving || draft.fetching || draft.apiKeyResolving} @click=${() => void this.fetchModelsAction()}>
					${draft.fetching ? t("channels.edit.fetching") : drafts.length > 0 || fetchDone ? t("channels.edit.refetch") : t("channels.edit.fetchModels")}
				</button>
				${drafts.length > 0
					? html`
						<button
							class="ghost-btn"
							title=${t("channels.edit.selectAllHint")}
							@click=${() => this.updateDraft((d) => d.drafts?.forEach((m) => (m.selected = true)))}
						>${t("channels.edit.selectAll")}</button>
						<button class="ghost-btn" @click=${() => this.updateDraft((d) => d.drafts?.forEach((m) => (m.selected = false)))}>${t("channels.edit.clearAll")}</button>
						<span class="settings-desc">${summaryParts.join(" · ")}</span>
					`
					: nothing}
			</div>
			${drafts.length > 0 && selectedCount === 0
				? html`<div class="channel-error">${t("channels.errors.needModels")}</div>`
				: nothing}
			${draft.fetchError ? html`<div class="channel-error">${draft.fetchError}</div>` : nothing}
			${draft.fetchError && drafts.length > 0
				? html`<div class="channel-warning">${t("channels.edit.fetchUnconfirmedNotice")}</div>`
				: nothing}
			${draft.fetchNotice === "empty" && !draft.fetchError
				? html`<div class="channel-warning">${t("channels.edit.emptyRemoteNotice")}</div>`
				: nothing}
			${draft.fetchNotice === "all_filtered" && !draft.fetchError
				? html`<div class="channel-warning">${t("channels.edit.allFilteredNotice")}</div>`
				: nothing}
			${remoteRows.length > 0
				? html`
					<div class="channel-models-group-title">${t("channels.edit.groupRemote", { count: remoteRows.length })}</div>
					<div class="channel-models-list">
						${remoteRows.map((row) => this.renderModelRow(draft, row.model, row.index, fetchDone))}
					</div>
				`
				: nothing}
			${localRows.length > 0
				? html`
					${fetchDone
						? html`<div class="channel-models-group-title">${t("channels.edit.groupLocal", { count: localRows.length })}<span class="channel-models-group-note">${t("channels.edit.groupLocalNote")}</span></div>`
						: nothing}
					<div class="channel-models-list">
						${localRows.map((row) => this.renderModelRow(draft, row.model, row.index, fetchDone))}
					</div>
				`
				: nothing}
			<div class="channel-manual-add">
				<input
					class="settings-path-input"
					type="text"
					placeholder=${t("channels.edit.manualModelPlaceholder")}
					.value=${draft.manualId}
					@input=${(e: Event) => this.updateDraft((d) => (d.manualId = (e.target as HTMLInputElement).value))}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === "Enter") {
							e.preventDefault();
							this.addManualModel();
						}
					}}
				/>
				<button class="ghost-btn" ?disabled=${!draft.manualId.trim()} @click=${() => this.addManualModel()}>${t("channels.edit.addModel")}</button>
			</div>
		`;
	}

	private renderEditView(): TemplateResult {
		const draft = this.draft;
		if (!draft) return html``;
		const preset = findPreset(draft.presetId);
		const providerEditable = draft.mode === "add" && !draft.isBuiltin;
		const showForm = draft.mode === "edit" || Boolean(draft.presetId);
		const modelsApiKey =
			draft.mode === "edit"
				? this.models.providers?.[draft.originalProvider ?? draft.provider]?.apiKey
				: undefined;
		const keyUsesReference =
			draft.keyHint === "env"
			|| draft.keyHint === "command"
			|| (draft.keyHint === "modelsJson"
				&& typeof modelsApiKey === "string"
				&& isSecretReference(modelsApiKey));

		return html`
			<div class="settings-section" ?inert=${draft.saving} aria-busy=${draft.saving ? "true" : "false"}>
				<div class="settings-section-title">${draft.mode === "add" ? t("channels.edit.titleAdd") : t("channels.edit.titleEdit")}</div>
				${draft.mode === "add" ? this.renderPresetChips(draft) : nothing}
				${showForm
					? html`
						${draft.isBuiltin && !draft.oauthReadonly ? html`<div class="settings-desc" style="margin-top:10px;">${t("channels.edit.builtinOnlyKey")}</div>` : nothing}
						${draft.oauthReadonly ? html`<div class="settings-desc" style="margin-top:10px;">${t("settings.channels.oauthEditHint")}</div>` : nothing}
						<div class="settings-row settings-row-top" style="margin-top:12px;">
							<div>
								<div class="settings-label">${t("channels.edit.name")}</div>
							</div>
						</div>
						<input
							class="settings-path-input"
							type="text"
							placeholder=${t("channels.edit.namePlaceholder")}
							.value=${draft.alias}
							?disabled=${draft.oauthReadonly || (providerEditable && draft.fetching)}
							@input=${(e: Event) => {
								const mutate = (d: EditDraft): void => {
									d.alias = (e.target as HTMLInputElement).value;
									if (providerEditable) d.provider = normalizeProviderId(d.alias);
								};
								if (providerEditable) this.updateRequestDraft(mutate);
								else this.updateDraft(mutate);
							}}
						/>
						${providerEditable && draft.provider
							? html`<div class="settings-desc"><code>${draft.provider}</code></div>`
							: nothing}

						<div class="settings-row settings-row-top" style="margin-top:12px;">
							<div>
								<div class="settings-label">${t("channels.edit.apiKey")}</div>
								${draft.mode === "edit" && !draft.oauthReadonly
									? html`<div class="settings-desc">${draft.keyHint === "plain"
										? t("channels.edit.apiKeyPlainWarning")
										: keyUsesReference
											? t("channels.edit.apiKeyReferenceHint")
										: draft.keyHint === "modelsJson"
											? t("channels.edit.apiKeyModelsJsonHint")
											: t("channels.edit.apiKeyKeepHint")}</div>`
									: nothing}
							</div>
						</div>
						${draft.oauthReadonly
							? html`<div class="settings-desc">${t("channels.card.oauthReadonly")}</div>`
							: html`
								<div class="channel-apikey-row">
									<input
										class="settings-path-input"
										type=${draft.showKey ? "text" : "password"}
										autocomplete="off"
										placeholder=${draft.mode === "edit" ? t("channels.edit.apiKeyPlaceholderSaved") : t("channels.edit.apiKeyPlaceholder")}
										.value=${draft.apiKey}
										?disabled=${draft.saving || draft.fetching || draft.apiKeyResolving}
										@input=${(e: Event) =>
											this.updateRequestDraft((d) => {
												d.apiKey = (e.target as HTMLInputElement).value;
												d.apiKeyDirty = true;
											})}
									/>
									<button
										class="ghost-btn channel-apikey-eye"
										title=${draft.showKey ? t("channels.edit.hideKey") : t("channels.edit.showKey")}
										?disabled=${draft.saving || draft.fetching || draft.apiKeyResolving}
										@click=${() => this.updateDraft((d) => (d.showKey = !d.showKey))}
									>
										${draft.showKey ? "🙈" : "👁"}
									</button>
								</div>
							`}

						<div class="settings-row settings-row-top" style="margin-top:12px;">
							<div>
								<div class="settings-label">${t("channels.edit.baseUrl")}</div>
								${draft.isBuiltin
									? html`<div class="settings-desc">${t("channels.edit.baseUrlBuiltinHint")}${preset?.baseUrl ? `（${preset.baseUrl}）` : ""}</div>`
									: nothing}
							</div>
						</div>
						<input
							class="settings-path-input"
							type="text"
							placeholder=${draft.isBuiltin ? (preset?.baseUrl ?? t("channels.edit.baseUrlPlaceholder")) : t("channels.edit.baseUrlPlaceholder")}
							.value=${draft.baseUrl}
							?disabled=${draft.oauthReadonly || draft.fetching}
							@input=${(e: Event) => this.updateRequestDraft((d) => (d.baseUrl = (e.target as HTMLInputElement).value))}
						/>
						${draft.baseUrl.trim().startsWith("http://")
							? html`
								<label class="channel-insecure-ack">
									<input
										type="checkbox"
										.checked=${draft.allowInsecureHttp}
										?disabled=${draft.fetching}
										@change=${(e: Event) => this.updateRequestDraft((d) => (d.allowInsecureHttp = (e.target as HTMLInputElement).checked))}
									/>
									<span>${t("channels.edit.insecureAck")}</span>
								</label>
							`
							: nothing}

						<div class="settings-row settings-row-top" style="margin-top:12px;">
							<div>
								<div class="settings-label">${t("channels.edit.note")}</div>
							</div>
						</div>
						<input
							class="settings-path-input"
							type="text"
							placeholder=${t("channels.edit.notePlaceholder")}
							.value=${draft.note}
							?disabled=${draft.oauthReadonly}
							@input=${(e: Event) => this.updateDraft((d) => (d.note = (e.target as HTMLInputElement).value))}
						/>

						${!draft.isBuiltin && !draft.oauthReadonly
							? html`
								<details class="settings-advanced">
									<summary>${t("channels.edit.advanced")}</summary>
									<div class="settings-row">
										<div>
											<div class="settings-label">${t("channels.edit.protocol")}</div>
										</div>
										${this.protocolSelect.render({
											ariaLabel: t("channels.edit.protocol"),
											value: draft.protocol,
											disabled: draft.fetching,
											options: API_PROTOCOLS.map((protocol) => ({ value: protocol, label: PROTOCOL_LABELS[protocol] })),
											onSelect: (value) =>
												this.updateRequestDraft((d) => {
													if (isApiProtocol(value)) d.protocol = value;
												}),
										})}
									</div>
									<div class="settings-label" style="margin-bottom:6px;">${t("channels.edit.headers")}</div>
									${draft.headers.map(
										(row, index) => html`
											<div class="channel-header-row">
												<input
													class="settings-path-input"
													type="text"
													placeholder=${t("channels.edit.headerKey")}
													.value=${row.key}
													?disabled=${draft.fetching}
													@input=${(e: Event) =>
														this.updateRequestDraft((d) => {
															const target = d.headers[index];
															if (target) target.key = (e.target as HTMLInputElement).value;
														})}
												/>
												<input
													class="settings-path-input"
													type="text"
													placeholder=${t("channels.edit.headerValue")}
													.value=${row.value}
													?disabled=${draft.fetching}
													@input=${(e: Event) =>
														this.updateRequestDraft((d) => {
															const target = d.headers[index];
															if (target) target.value = (e.target as HTMLInputElement).value;
														})}
												/>
												<button class="ghost-btn" ?disabled=${draft.fetching} @click=${() => this.updateRequestDraft((d) => d.headers.splice(index, 1))}>${t("channels.edit.removeHeader")}</button>
											</div>
										`,
									)}
									<div class="settings-actions" style="margin-top:6px;">
										<button class="ghost-btn" ?disabled=${draft.fetching} @click=${() => this.updateRequestDraft((d) => d.headers.push({ key: "", value: "" }))}>${t("channels.edit.addHeader")}</button>
									</div>
								</details>
							`
							: nothing}

						${this.renderModelDrafts(draft)}

						${draft.warning ? html`<div class="channel-warning">${draft.warning}</div>` : nothing}
						${draft.error
							? html`<div
									class="channel-error"
									style=${draft.errorSevere
										? "border:1px solid var(--danger); background: color-mix(in srgb, var(--danger) 18%, transparent); font-weight:600;"
										: ""}
								>${draft.error}</div>`
							: nothing}
						<div class="settings-actions" style="margin-top:14px;">
							${(() => {
								const modelDrafts = draft.drafts ?? [];
								const emptyModelSelection =
									modelDrafts.length > 0
									&& modelDrafts.every((model) => !model.selected);
								return html`
							<button class="ghost-btn" ?disabled=${draft.saving} @click=${() => this.cancelEdit()}>${t("channels.edit.cancel")}</button>
							<button
								class="ghost-btn channel-save-btn"
								?disabled=${draft.saving || draft.fetching || draft.apiKeyResolving || (draft.oauthReadonly && modelDrafts.length === 0) || emptyModelSelection}
								@click=${() => void this.saveDraft()}
							>
								${draft.saving
									? t("channels.edit.saving")
									: draft.oauthReadonly
										? t("settings.scopedModels.save")
										: t("channels.edit.save")}
							</button>
								`;
							})()}
						</div>
					`
					: nothing}
			</div>
		`;
	}

	private renderLoginStatusSection(): TemplateResult {
		return html`
			<div class="settings-section">
				<div class="settings-section-title">${t("channels.login.title")}</div>
				<div class="settings-desc">${t("channels.login.desc")}</div>
				${this.loginProviders.length > 0
					? html`
						<div class="account-chips" style="margin-top:8px;">
							${this.loginProviders.map(
								(entry) => html`<span class="account-chip">${entry.provider} · ${entry.kind === "oauth" ? "OAuth" : "API Key"}</span>`,
							)}
						</div>
					`
					: html`<div class="settings-desc" style="margin-top:6px;">${t("channels.login.none")}</div>`}
				<div class="settings-actions" style="margin-top:8px;">
					<button class="ghost-btn" @click=${() => this.onRequestOAuthTerminal?.()}>${t("channels.login.manage")}</button>
				</div>
			</div>
		`;
	}

	private renderScopedModelsSection(): TemplateResult {
		const totalModels = this.scopedModels.length;
		const enabledCount = this.scopedModelsHasFilter ? this.scopedModelsEnabledIds.length : totalModels;
		const query = this.scopedModelsSearch.trim().toLowerCase();
		const visibleModels = query
			? this.scopedModels.filter((model) => `${model.id} ${model.provider} ${model.name}`.toLowerCase().includes(query))
			: this.scopedModels;
		const grouped = new Map<string, ScopedModelOption[]>();
		for (const model of visibleModels) {
			const bucket = grouped.get(model.provider) ?? [];
			bucket.push(model);
			grouped.set(model.provider, bucket);
		}
		const providers = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		const dirty = this.scopedModelsDirty();
		const emptySelection = this.scopedModelsSelectionIsEmpty();

		return html`
			<div class="settings-section" style="margin-top:18px;">
				<div class="settings-section-title">${t("settings.scopedModels.title")}</div>
				<div class="settings-desc">${t("settings.scopedModels.descPrefix")}<code>/scoped-models</code>${t("settings.scopedModels.descSuffix")}</div>
				<div class="settings-row scoped-models-toolbar-row">
					<div class="scoped-models-summary">${t("settings.scopedModels.enabled")} <strong>${enabledCount}</strong> / ${totalModels || "0"}${dirty ? html` <span class="scoped-models-unsaved">${t("settings.scopedModels.unsaved")}</span>` : nothing}</div>
					<input
						class="appearance-font-input scoped-models-search"
						type="text"
						placeholder=${t("settings.scopedModels.searchPlaceholder")}
						.value=${this.scopedModelsSearch}
						@input=${(e: Event) => {
							this.scopedModelsSearch = (e.target as HTMLInputElement).value;
							this.requestRender();
						}}
					/>
				</div>
				<div class="settings-actions scoped-models-actions">
					<button class="ghost-btn" ?disabled=${this.scopedModelsLoading || totalModels === 0} @click=${() => this.enableAllScopedModels()}>${t("settings.scopedModels.enableAll")}</button>
					<button class="ghost-btn" ?disabled=${this.scopedModelsLoading || totalModels === 0} @click=${() => this.clearAllScopedModels()}>${t("settings.scopedModels.clearAll")}</button>
					<button class="ghost-btn" ?disabled=${this.scopedModelsLoading || !dirty || this.scopedModelsSaving || emptySelection} @click=${() => this.saveScopedModels()}>
						${this.scopedModelsSaving ? t("settings.saving") : t("settings.scopedModels.save")}
					</button>
					<button class="ghost-btn" ?disabled=${this.scopedModelsLoading} @click=${() => this.refreshScopedModels()}>${t("settings.scopedModels.refresh")}</button>
				</div>
				${this.scopedModelsLoading ? html`<div class="ui-loading compact" role="status" aria-label=${t("settings.scopedModels.loading")}><span class="ui-loading-spinner"></span></div>` : nothing}
				${this.scopedModelsError ? html`<div class="settings-desc scoped-models-error">${this.scopedModelsError}</div>` : nothing}
				${this.scopedModelsValidation ? html`<div class="settings-desc scoped-models-error">${this.scopedModelsValidation}</div>` : nothing}
				${this.scopedModelsUnknownPatterns.length > 0
					? html`<div class="settings-desc">${t("settings.scopedModels.unresolvedPatterns")} <code>${this.scopedModelsUnknownPatterns.join(", ")}</code></div>`
					: nothing}
				${this.scopedModelsMessage ? html`<div class="settings-desc">${this.scopedModelsMessage}</div>` : nothing}
				${this.scopedModelsSettingsPath ? html`<div class="settings-desc">${t("settings.scopedModels.settingsFile")} <code>${this.scopedModelsSettingsPath}</code></div>` : nothing}
				${!this.scopedModelsLoading && !this.scopedModelsError
					? providers.length === 0
						? html`<div class="settings-empty">${t("settings.scopedModels.empty")}</div>`
						: html`
							<div class="scoped-models-list">
								${providers.map(([provider, models]) => {
									const providerEnabledCount = models.filter((model) => this.isScopedModelEnabled(model.fullId)).length;
									const providerAllEnabled = providerEnabledCount === models.length;
									return html`
										<div class="scoped-models-provider-header">
											<div class="scoped-models-provider-meta">
												<span class="settings-label">${provider}</span>
												<span class="settings-desc">${providerEnabledCount}/${models.length} ${t("settings.scopedModels.enabledSuffix")}</span>
											</div>
											<button class="ghost-btn" @click=${() => this.toggleScopedProvider(provider)}>${providerAllEnabled ? t("settings.scopedModels.disableProvider") : t("settings.scopedModels.enableProvider")}</button>
										</div>
										${models.map((model) => {
											const enabled = this.isScopedModelEnabled(model.fullId);
											return html`
												<div class="settings-row scoped-model-row">
													<div class="scoped-model-row-main">
														<div class="settings-label">${model.id}</div>
														<div class="settings-desc">${model.provider}${model.name && model.name !== model.id ? ` · ${model.name}` : ""}</div>
													</div>
													<button class="toggle ${enabled ? "on" : "off"}" @click=${() => this.toggleScopedModel(model.fullId)}><span></span></button>
												</div>
											`;
										})}
									`;
								})}
							</div>
						`
					: nothing}
			</div>
		`;
	}

	render(): TemplateResult {
		if (this.view === "edit") return this.renderEditView();

		const records = this.channels();
		return html`
			${this.renderLoginStatusSection()}
			<div class="settings-section" style="margin-top:18px;">
				<div class="ext-view-head">
					<div class="settings-section-title">${t("channels.list.title")}</div>
					<div class="ext-view-head-actions">
						<button class="ghost-btn" ?disabled=${this.loading} @click=${() => void this.refresh()}>${t("channels.refresh")}</button>
						<button class="ghost-btn channel-save-btn" @click=${() => this.openAdd()}>${t("channels.addChannel")}</button>
					</div>
				</div>
				<div class="settings-desc">${t("channels.list.desc")}</div>
				${this.message ? html`<div class="channel-message">${this.message}</div>` : nothing}
				${this.loadError ? html`<div class="channel-error">${this.loadError}</div>` : nothing}
				${this.loading
					? html`<div class="ui-loading compact" style="margin-top:10px;" role="status" aria-label=${t("channels.loading")}><span class="ui-loading-spinner"></span></div>`
					: records.length === 0
						? html`<div class="settings-empty" style="margin-top:10px;">${t("channels.empty")}</div>`
						: html`<div class="channel-list">${records.map((record) => this.renderCard(record))}</div>`}
			</div>
			${this.renderScopedModelsSection()}
		`;
	}
}
