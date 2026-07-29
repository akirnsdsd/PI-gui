/**
 * pi 配置文件的 read-modify-write 纯逻辑。
 *
 * 原则：
 * - 保留未知字段（pi 版本演进、手写配置不被吞掉）；
 * - 编辑已有配置时，用户没输入新 key 就不触碰 auth.json 里的 key 字段
 *   （$ENV_VAR / !cmd / OAuth 引用原样保留）；
 * - 自定义 provider 的敏感 key 只写 auth.json（!security 引用），
 *   models.json 永不写 apiKey 字段（resolution order: auth.json > env > models.json.apiKey）；
 * - OAuth 条目只读，不在此修改。
 */
import { minimatch } from "minimatch";
import { findPreset, findPresetByBuiltinProvider } from "./presets.js";
import {
	isApiProtocol,
	type ChannelRecord,
	type ChannelsMetaFile,
	type KeyRefKind,
	type ModelDraft,
	type PiAuthEntry,
	type PiAuthFile,
	type PiModelEntry,
	type PiModelsFile,
	type PiModelsProvider,
	type PiSettingsFile,
} from "./types.js";

export const KEYCHAIN_SERVICE = "pi-gui.channels";

/** Keychain account 直接用 provider 名（全局唯一）。 */
export function keychainAccountFor(provider: string): string {
	return provider.trim().toLowerCase();
}

/** auth.json 里存的 key 引用：pi 原生支持 !cmd 取值。 */
export function buildKeychainRefCommand(account: string): string {
	return `!security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w`;
}

/** 从 !cmd 引用中反解 keychain account（仅认我们自己 service 的引用）。 */
export function parseKeychainAccount(key: string): string | null {
	const m = key.match(/^!security\s+find-generic-password\s+-s\s+(\S+)\s+-a\s+(\S+)\s+-w\s*$/);
	if (!m || m[1] !== KEYCHAIN_SERVICE) return null;
	return m[2] ?? null;
}

export function classifyKeyRef(entry: PiAuthEntry | null | undefined): KeyRefKind {
	if (!entry || typeof entry !== "object") return "none";
	if (entry.type === "oauth") return "oauth";
	const key = typeof entry.key === "string" ? entry.key.trim() : "";
	if (!key) return "none";
	if (key.startsWith("$")) return "env";
	if (parseKeychainAccount(key) !== null) return "keychain";
	if (key.startsWith("!")) return "command";
	return "plain";
}

export function isSecretReference(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.startsWith("$") || trimmed.startsWith("!");
}

/** 编辑框中的值已经是可直接发送的真 Key，不再按 `$` / `!` 前缀二次猜测。 */
export function literalApiKeyForRequest(value: string): string | null {
	const trimmed = value.trim();
	return trimmed || null;
}

// ---------------------------------------------------------------------------
// provider id 规范化
// ---------------------------------------------------------------------------

export function normalizeProviderId(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.replace(/-+/g, "-")
		.replace(/[._-]+$/, "");
}

export function isValidProviderId(id: string): boolean {
	return /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

// ---------------------------------------------------------------------------
// 合并视图：auth.json + models.json + meta + settings → 卡片列表
// ---------------------------------------------------------------------------

export function deriveChannels(
	auth: PiAuthFile,
	models: PiModelsFile,
	meta: ChannelsMetaFile,
	settings: PiSettingsFile,
	/** 运行时各 provider 的模型数（get_available_models 统计）；不传表示无运行时数据。 */
	runtimeCounts?: Readonly<Record<string, number>>,
): ChannelRecord[] {
	const providers = new Set<string>();
	for (const key of Object.keys(auth ?? {})) providers.add(key);
	for (const key of Object.keys(models?.providers ?? {})) providers.add(key);

	const defaultProvider =
		typeof settings?.defaultProvider === "string" ? settings.defaultProvider : null;
	const defaultModel = typeof settings?.defaultModel === "string" ? settings.defaultModel : null;

	const records: ChannelRecord[] = [];
	for (const provider of providers) {
		const authEntry = (auth?.[provider] ?? null) as PiAuthEntry | null;
		const modelsEntry = models?.providers?.[provider] ?? null;
		const preset = findPresetByBuiltinProvider(provider);
		const metaEntry = meta?.channels?.[provider] ?? {};
		const metaPreset = findPreset(metaEntry.presetId);
		const effectivePreset = preset ?? metaPreset;

		const authType = typeof authEntry?.type === "string" ? authEntry.type : "";
		const authKind = authType === "oauth" ? "oauth" : authType === "api_key" ? "api_key" : "none";
		const entryModels = Array.isArray(modelsEntry?.models)
			? modelsEntry.models.filter((m): m is PiModelEntry => Boolean(m) && typeof m?.id === "string")
			: [];

		// models.json 直接带明文 apiKey 也是合法配置（resolution order 兜底），
		// auth.json 没有可用 key 时视为「已配置密钥」，而不是「未配置密钥」。
		let keyRefKind = classifyKeyRef(authEntry);
		if (keyRefKind === "none") {
			const modelsApiKey = typeof modelsEntry?.apiKey === "string" ? modelsEntry.apiKey.trim() : "";
			if (modelsApiKey) keyRefKind = "modelsJson";
		}

		records.push({
			provider,
			displayName: metaEntry.alias?.trim() || provider,
			isBuiltin: preset !== null,
			baseUrl: modelsEntry?.baseUrl ?? effectivePreset?.baseUrl ?? "",
			protocol: isApiProtocol(modelsEntry?.api)
				? modelsEntry.api
				: (effectivePreset?.protocol ?? null),
			authKind,
			keyRefKind,
			modelCount: entryModels.length,
			modelsTotal:
				typeof metaEntry.modelsTotal === "number" && metaEntry.modelsTotal >= 0
					? metaEntry.modelsTotal
					: null,
			runtimeModelCount: runtimeCounts ? (runtimeCounts[provider] ?? 0) : null,
			models: entryModels,
			note: metaEntry.note ?? "",
			icon: metaEntry.icon ?? effectivePreset?.icon ?? "🔌",
			isDefault: defaultProvider === provider,
			defaultModel: defaultProvider === provider ? defaultModel : null,
			hasModelsEntry: modelsEntry !== null,
		});
	}

	const order = Array.isArray(meta?.order) ? meta.order : [];
	const orderIndex = new Map(order.map((name, index) => [name, index]));
	records.sort((a, b) => {
		const ai = orderIndex.get(a.provider);
		const bi = orderIndex.get(b.provider);
		if (ai !== undefined || bi !== undefined) {
			return (ai ?? Number.MAX_SAFE_INTEGER) - (bi ?? Number.MAX_SAFE_INTEGER);
		}
		if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
		return a.displayName.localeCompare(b.displayName);
	});
	return records;
}

// ---------------------------------------------------------------------------
// 保存（新增/编辑）
// ---------------------------------------------------------------------------

export interface SaveChannelInput {
	provider: string;
	isBuiltin: boolean;
	/**
	 * 归一化后的 baseUrl。内置渠道传预设默认值（或空）表示不覆盖；
	 * 与预设默认不同才写 models.json 覆盖条目（中转）。
	 */
	baseUrl: string;
	presetDefaultBaseUrl?: string;
	/** 自定义渠道必填；内置渠道可为 null（协议由 pi 内置定义）。 */
	protocol: string | null;
	/** 用户输入的新明文 key；null = 不触碰已有 auth 条目。 */
	newApiKey: string | null;
	headers?: Record<string, string>;
	/** 自定义渠道：勾选后的模型草稿。 */
	models?: ModelDraft[];
}

export interface UpsertResult {
	auth: PiAuthFile;
	models: PiModelsFile;
	/** 需要写入 Keychain 的（account, secret）；null 表示无需动 Keychain。 */
	keychainWrite: { account: string; secret: string } | null;
	/** true = 本次保存把 models.json 里的明文 apiKey 迁移到了 Keychain。 */
	migratedApiKey: boolean;
}

// ---------------------------------------------------------------------------
// 保存事务 payload（Rust save_channel_config 命令的 entry 级 patch 语义）
// ---------------------------------------------------------------------------

/**
 * 单文件 provider 条目操作：set = 锁内重读-合并写入该条目；
 * delete = 删除该条目；none = 不动。Rust 侧按此做 entry 级 patch，
 * 绝不全量覆盖文件其他字段 / 其他 provider。
 */
export type ChannelSaveEntryOp =
	| { kind: "set"; entry: Record<string, unknown> }
	| { kind: "delete" }
	| { kind: "none" };

export interface ChannelSaveOps {
	authEntry: ChannelSaveEntryOp;
	modelsEntry: ChannelSaveEntryOp;
}

export type ChannelSaveKeychainOp =
	| { kind: "write"; account: string; secret: string }
	| { kind: "delete"; account: string }
	| { kind: "none" };

export type ChannelSaveMetaOp =
	| { kind: "set"; entry: Record<string, unknown> }
	| { kind: "delete" }
	| { kind: "none" };

export interface ChannelSettingsPatch {
	set?: Record<string, unknown>;
	delete?: string[];
}

export interface ChannelTransactionPaths {
	authPath: string;
	modelsPath: string;
	metaPath: string;
	settingsPath?: string;
}

export interface ChannelTransactionPayload {
	provider: string;
	authPath: string;
	modelsPath: string;
	metaPath: string;
	settingsPath?: string;
	keychain: ChannelSaveKeychainOp;
	authEntry: ChannelSaveEntryOp;
	modelsEntry: ChannelSaveEntryOp;
	meta: ChannelSaveMetaOp;
	settings?: ChannelSettingsPatch;
}

export interface ParsedChannelTransactionError {
	code: string;
	message: string;
	journalPath: string;
}

/** Tauri 可能把 Rust 的结构化错误作为 JSON 字符串返回；非 JSON 保留原文。 */
export function parseChannelTransactionError(err: unknown): ParsedChannelTransactionError {
	const raw = err instanceof Error ? err.message : String(err);
	try {
		const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; journalPath?: unknown };
		if (parsed && typeof parsed.message === "string") {
			return {
				code: typeof parsed.code === "string" ? parsed.code : "",
				message: parsed.message,
				journalPath: typeof parsed.journalPath === "string" ? parsed.journalPath : "",
			};
		}
	} catch {
		// fall through
	}
	return { code: "", message: raw, journalPath: "" };
}

function baseTransactionPayload(
	paths: ChannelTransactionPaths,
	provider: string,
): ChannelTransactionPayload {
	return {
		provider,
		authPath: paths.authPath,
		modelsPath: paths.modelsPath,
		metaPath: paths.metaPath,
		...(paths.settingsPath ? { settingsPath: paths.settingsPath } : {}),
		keychain: { kind: "none" },
		authEntry: { kind: "none" },
		modelsEntry: { kind: "none" },
		meta: { kind: "none" },
	};
}

export function buildUpsertTransactionPayload(
	paths: ChannelTransactionPaths,
	provider: string,
	ops: ChannelSaveOps,
	metaEntry: Record<string, unknown>,
	keychainWrite: UpsertResult["keychainWrite"],
): ChannelTransactionPayload {
	return {
		...baseTransactionPayload(paths, provider),
		keychain: keychainWrite
			? { kind: "write", account: keychainWrite.account, secret: keychainWrite.secret }
			: { kind: "none" },
		authEntry: ops.authEntry,
		modelsEntry: ops.modelsEntry,
		meta: { kind: "set", entry: metaEntry },
	};
}

export function buildDeleteTransactionPayload(
	paths: ChannelTransactionPaths,
	provider: string,
	keychainAccount: string | null,
): ChannelTransactionPayload {
	return {
		...baseTransactionPayload(paths, provider),
		keychain: keychainAccount
			? { kind: "delete", account: keychainAccount }
			: { kind: "none" },
		authEntry: { kind: "delete" },
		modelsEntry: { kind: "delete" },
		meta: { kind: "delete" },
	};
}

export function buildDuplicateTransactionPayload(
	paths: ChannelTransactionPaths,
	provider: string,
	authEntry: PiAuthEntry | undefined,
	modelsEntry: PiModelsProvider | undefined,
	metaEntry: Record<string, unknown>,
	keychainWrite: { account: string; secret: string } | null,
): ChannelTransactionPayload {
	return {
		...baseTransactionPayload(paths, provider),
		keychain: keychainWrite
			? { kind: "write", account: keychainWrite.account, secret: keychainWrite.secret }
			: { kind: "none" },
		authEntry: authEntry
			? { kind: "set", entry: authEntry }
			: { kind: "none" },
		modelsEntry: modelsEntry
			? { kind: "set", entry: modelsEntry }
			: { kind: "none" },
		meta: { kind: "set", entry: metaEntry },
	};
}

export function buildSettingsTransactionPayload(
	paths: ChannelTransactionPaths,
	provider: string,
	settings: ChannelSettingsPatch,
): ChannelTransactionPayload {
	if (!paths.settingsPath) {
		throw new Error("settingsPath is required for settings patch");
	}
	return {
		...baseTransactionPayload(paths, provider),
		settings,
	};
}

/**
 * enabledModels 的唯一写入 payload：undefined = 删除过滤键；非空数组 = 显式范围。
 * pi 将 [] 解释为“无过滤/全量”，因此空数组必须在前端边界拒绝，不能伪装成禁用全部。
 */
export function buildEnabledModelsTransactionPayload(
	paths: ChannelTransactionPaths,
	provider: string,
	patterns: readonly string[] | undefined,
): ChannelTransactionPayload {
	if (patterns !== undefined && patterns.length === 0) {
		throw new Error("enabledModels requires at least one model pattern");
	}
	return buildSettingsTransactionPayload(
		paths,
		provider,
		patterns === undefined
			? { delete: ["enabledModels"] }
			: { set: { enabledModels: [...patterns] } },
	);
}

/**
 * 从 upsertChannel 的全量计算结果提取 entry 级操作（纯函数）。
 * 对比旧状态：结果里条目存在 → set；旧的有而结果没有 → delete；两边都没有 → none。
 */
export function buildChannelSaveOps(
	prevAuth: PiAuthFile,
	prevModels: PiModelsFile,
	provider: string,
	result: UpsertResult,
): ChannelSaveOps {
	const nextAuthEntry = result.auth[provider];
	const authEntry: ChannelSaveEntryOp =
		nextAuthEntry !== undefined
			? { kind: "set", entry: nextAuthEntry as Record<string, unknown> }
			: prevAuth[provider] !== undefined
				? { kind: "delete" }
				: { kind: "none" };

	const nextModelsEntry = result.models.providers?.[provider];
	const prevModelsEntry = prevModels.providers?.[provider];
	const modelsEntry: ChannelSaveEntryOp =
		nextModelsEntry !== undefined
			? { kind: "set", entry: nextModelsEntry as Record<string, unknown> }
			: prevModelsEntry !== undefined
				? { kind: "delete" }
				: { kind: "none" };

	return { authEntry, modelsEntry };
}

/**
 * 草稿 → models.json 条目。未知（null）的元数据字段缺省不写入，
 * 避免把 128000/16384 之类的 pi 缺省值伪装成已确认能力落盘；
 * input 模态同理：来源未确认时不写 input 字段（缺省由 pi/远端决定，
 * 不给视觉模型落盘 ["text"] 导致丢图片能力）。
 * extraFields（已保存条目的 cost/compat/thinkingLevelMap 等）原样写回，
 * 不静默吞掉用户手写配置；origin/seenInFetch 等临时来源字段绝不落盘。
 */
export function toModelEntry(draft: ModelDraft): PiModelEntry {
	return {
		...(draft.extraFields ?? {}),
		id: draft.id,
		name: draft.name,
		...(draft.contextWindow !== null ? { contextWindow: draft.contextWindow } : {}),
		...(draft.maxTokens !== null ? { maxTokens: draft.maxTokens } : {}),
		...(draft.reasoning !== null ? { reasoning: draft.reasoning } : {}),
		...(draft.input !== null && draft.input.length > 0 ? { input: [...draft.input] } : {}),
	};
}

/**
 * 计算新 auth.json / models.json（纯函数，不落盘）。
 * 未知字段原样保留；OAuth 条目不允许经此函数修改（调用方守卫）。
 */
export function upsertChannel(
	auth: PiAuthFile,
	models: PiModelsFile,
	input: SaveChannelInput,
): UpsertResult {
	const provider = normalizeProviderId(input.provider);
	const nextAuth: PiAuthFile = { ...(auth ?? {}) };
	const nextModels: PiModelsFile = { ...(models ?? {}) };
	const nextProviders: Record<string, PiModelsProvider> = {
		...(models?.providers ?? {}),
	};
	nextModels.providers = nextProviders;

	let keychainWrite: UpsertResult["keychainWrite"] = null;
	let migratedApiKey = false;
	const existingEntry = nextProviders[provider] ?? {};

	// --- auth.json ---
	if (input.newApiKey && input.newApiKey.trim()) {
		const account = keychainAccountFor(provider);
		const existing = (nextAuth[provider] ?? {}) as PiAuthEntry;
		nextAuth[provider] = {
			...existing,
			type: "api_key",
			key: buildKeychainRefCommand(account),
		};
		keychainWrite = { account, secret: input.newApiKey.trim() };
	} else {
		// models.json 里遗留的明文 apiKey：迁移到 Keychain + auth.json 存 !security 引用。
		// 仅当 auth.json 没有该 provider 的可用 key 才迁移（resolution order:
		// auth.json > env > models.json.apiKey；已有 auth 引用时该 apiKey 本就不生效，
		// 只从 models.json 清掉，不改变生效的 key）。
		const legacyApiKey =
			typeof existingEntry.apiKey === "string" ? existingEntry.apiKey.trim() : "";
		if (legacyApiKey && classifyKeyRef(nextAuth[provider] as PiAuthEntry | null) === "none") {
			const existing = (nextAuth[provider] ?? {}) as PiAuthEntry;
			if (isSecretReference(legacyApiKey)) {
				// `$ENV` / `!cmd` 本身不是密钥，直接迁到 auth.json 并保留动态语义。
				// 绝不能把引用文本当 secret 写进 Keychain，否则含非 ASCII 字符的
				// 命令会被 security 读成十六进制文本并最终作为错误 API Key 发出。
				nextAuth[provider] = {
					...existing,
					type: "api_key",
					key: legacyApiKey,
				};
			} else {
				const account = keychainAccountFor(provider);
				nextAuth[provider] = {
					...existing,
					type: "api_key",
					key: buildKeychainRefCommand(account),
				};
				keychainWrite = { account, secret: legacyApiKey };
				migratedApiKey = true;
			}
		}
	}

	// --- models.json ---
	if (input.isBuiltin) {
		// 内置渠道：只写 baseUrl 中转覆盖；models 数组省略（保留 pi 内置模型）。
		// 已有的 entry 其它字段（含手写的 models 数组）原样保留。
		const presetDefault = (input.presetDefaultBaseUrl ?? "").replace(/\/+$/, "");
		const override = input.baseUrl.replace(/\/+$/, "");
		const entry: PiModelsProvider = { ...existingEntry };
		delete entry.apiKey; // 敏感 key 只走 auth.json，不落 models.json
		if (override && override !== presetDefault) {
			entry.baseUrl = override;
		} else {
			delete entry.baseUrl;
		}
		if (Object.keys(entry).length > 0) {
			nextProviders[provider] = entry;
		} else {
			delete nextProviders[provider];
		}
	} else {
		const entry: PiModelsProvider = {
			...existingEntry,
			baseUrl: input.baseUrl,
		};
		if (input.protocol) entry.api = input.protocol;
		delete entry.apiKey; // 敏感 key 只走 auth.json，不落 models.json
		if (input.headers && Object.keys(input.headers).length > 0) {
			entry.headers = { ...input.headers };
		} else {
			delete entry.headers;
		}
		if (input.models) {
			entry.models = input.models.map(toModelEntry);
		}
		nextProviders[provider] = entry;
	}

	return { auth: nextAuth, models: nextModels, keychainWrite, migratedApiKey };
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

export interface RemoveResult {
	auth: PiAuthFile;
	models: PiModelsFile;
	/** 被删 auth 条目的 keychain account（仅当它是我们管的引用）。 */
	keychainAccountToDelete: string | null;
}

export function removeChannel(
	auth: PiAuthFile,
	models: PiModelsFile,
	provider: string,
): RemoveResult {
	const nextAuth: PiAuthFile = { ...(auth ?? {}) };
	const entry = nextAuth[provider] as PiAuthEntry | undefined;
	let keychainAccountToDelete: string | null = null;
	if (entry && typeof entry === "object" && typeof entry.key === "string") {
		keychainAccountToDelete = parseKeychainAccount(entry.key);
	}
	delete nextAuth[provider];

	const nextModels: PiModelsFile = { ...(models ?? {}) };
	const nextProviders = { ...(models?.providers ?? {}) };
	delete nextProviders[provider];
	nextModels.providers = nextProviders;

	return { auth: nextAuth, models: nextModels, keychainAccountToDelete };
}

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------

export interface DuplicateResult {
	auth: PiAuthFile;
	models: PiModelsFile;
	meta: ChannelsMetaFile;
	/** 源 key 的引用形式；为 "keychain" 时调用方需复制 Keychain 条目。 */
	sourceKeyRefKind: KeyRefKind;
	sourceKeychainAccount: string | null;
	/** 源为 OAuth 时不允许复制。 */
	canDuplicate: boolean;
}

export function duplicateChannel(
	auth: PiAuthFile,
	models: PiModelsFile,
	meta: ChannelsMetaFile,
	sourceProvider: string,
	newProviderRaw: string,
): DuplicateResult {
	const newProvider = normalizeProviderId(newProviderRaw);
	const sourceAuth = auth?.[sourceProvider] as PiAuthEntry | undefined;
	const sourceKind = classifyKeyRef(sourceAuth);
	const sourceAccount =
		sourceAuth && typeof sourceAuth.key === "string"
			? parseKeychainAccount(sourceAuth.key)
			: null;

	const base: DuplicateResult = {
		auth: { ...(auth ?? {}) },
		models: { ...(models ?? {}) },
		meta: {
			version: 1,
			channels: { ...(meta?.channels ?? {}) },
			order: Array.isArray(meta?.order) ? [...meta.order] : undefined,
		},
		sourceKeyRefKind: sourceKind,
		sourceKeychainAccount: sourceAccount,
		canDuplicate: sourceKind !== "oauth" && isValidProviderId(newProvider),
	};
	if (!base.canDuplicate) return base;

	// auth：keychain 引用先指向同一 account，调用方复制 Keychain 后应改写为新引用；
	// env / command / plain 引用原样复制。
	if (sourceAuth && typeof sourceAuth === "object") {
		base.auth[newProvider] = { ...sourceAuth };
	}

	const providers = { ...(models?.providers ?? {}) };
	if (providers[sourceProvider]) {
		providers[newProvider] = JSON.parse(
			JSON.stringify(providers[sourceProvider]),
		) as PiModelsProvider;
	}
	base.models = { ...(models ?? {}), providers };

	const sourceMeta = meta?.channels?.[sourceProvider];
	if (sourceMeta) {
		base.meta.channels[newProvider] = { ...sourceMeta, alias: undefined };
	}
	if (base.meta.order && !base.meta.order.includes(newProvider)) {
		base.meta.order.push(newProvider);
	}
	return base;
}

// ---------------------------------------------------------------------------
// 设为默认（settings.json）
// ---------------------------------------------------------------------------

export function applySetDefault(
	settings: PiSettingsFile,
	provider: string,
	modelId: string,
): PiSettingsFile {
	return {
		...(settings ?? {}),
		defaultProvider: provider,
		defaultModel: modelId,
	};
}

// ---------------------------------------------------------------------------
// 内置/OAuth 渠道模型范围 → settings.json enabledModels
// ---------------------------------------------------------------------------

export interface ModelRef {
	provider: string;
	id: string;
	name?: string;
}

export interface MergeProviderModelScopeInput {
	/** 目标 provider（内置/OAuth 渠道）。 */
	provider: string;
	/** 该 provider 全部已知模型 id（编辑页清单与运行时的并集）。 */
	providerModelIds: readonly string[];
	/** 用户勾选启用的模型 id。 */
	selectedIds: readonly string[];
	/**
	 * 全部 provider 的已知模型（运行时 + models.json + 编辑页清单并集）：
	 * 用于「当前无过滤」时物化其它渠道的默认全量，以及 glob 展开。
	 */
	allKnownModels: readonly ModelRef[];
	/**
	 * 已配置 provider 全集；用于无过滤切为子集时物化其它 provider。
	 * 必须覆盖 auth/models/meta/runtime，不能只依赖已经发现模型的 provider。
	 */
	allKnownProviders?: readonly string[];
	/** settings.json 现有 enabledModels；缺省/空 = 当前无过滤（全部启用）。 */
	existingPatterns?: readonly string[];
}

export interface MergeProviderModelScopeResult {
	/** 新的 enabledModels；undefined = 删除该键（恢复 pi 默认全量）。 */
	patterns?: string[];
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** enabledModels pattern 是否含 glob 字符（与 pi resolveModelScope 的判定一致）。 */
function isGlobPattern(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

/**
 * pi 对 glob 会剥离合法 thinking suffix，再用 minimatch(nocase) 同时匹配
 * provider/id 与裸 id。返回 suffix 是为了把跨 provider 展开后的语义保留下来。
 */
function splitThinkingSuffix(pattern: string): { modelPattern: string; suffix: string } {
	const colon = pattern.lastIndexOf(":");
	if (colon < 0) return { modelPattern: pattern, suffix: "" };
	const suffix = pattern.slice(colon + 1);
	return THINKING_LEVELS.has(suffix)
		? { modelPattern: pattern.slice(0, colon), suffix: `:${suffix}` }
		: { modelPattern: pattern, suffix: "" };
}

function globMatchesModel(pattern: string, model: ModelRef): boolean {
	const { modelPattern } = splitThinkingSuffix(pattern);
	return minimatch(`${model.provider}/${model.id}`, modelPattern, { nocase: true })
		|| minimatch(model.id, modelPattern, { nocase: true });
}

function sameModelRef(a: ModelRef, b: ModelRef): boolean {
	return a.provider.toLowerCase() === b.provider.toLowerCase()
		&& a.id.toLowerCase() === b.id.toLowerCase();
}

function findExactModelRef(pattern: string, models: readonly ModelRef[]): ModelRef | null {
	const normalized = pattern.trim().toLowerCase();
	if (!normalized) return null;
	const canonical = models.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
	);
	if (canonical.length === 1) return canonical[0]!;
	if (canonical.length > 1) return null;
	const bare = models.filter((model) => model.id.toLowerCase() === normalized);
	return bare.length === 1 ? bare[0]! : null;
}

function isAliasModelId(id: string): boolean {
	return id.endsWith("-latest") || !/-\d{8}$/.test(id);
}

/** 对齐 pi parseModelPattern：精确 → id/name 部分匹配 → 递归剥最后一个冒号后缀。 */
function resolveExactScopePattern(pattern: string, models: readonly ModelRef[]): ModelRef | null {
	const exact = findExactModelRef(pattern, models);
	if (exact) return exact;
	const lower = pattern.toLowerCase();
	const partial = models.filter(
		(model) =>
			model.id.toLowerCase().includes(lower)
			|| (typeof model.name === "string" && model.name.toLowerCase().includes(lower)),
	);
	if (partial.length > 0) {
		const aliases = partial.filter((model) => isAliasModelId(model.id));
		const candidates = aliases.length > 0 ? aliases : partial;
		return [...candidates].sort((a, b) => b.id.localeCompare(a.id))[0] ?? null;
	}
	const colon = pattern.lastIndexOf(":");
	return colon < 0 ? null : resolveExactScopePattern(pattern.slice(0, colon), models);
}

/** 与 pi enabledModels 的 glob + thinking suffix 核心匹配语义一致。 */
export function modelMatchesScopePattern(
	pattern: string,
	model: ModelRef,
	allKnownModels: readonly ModelRef[],
): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	return isGlobPattern(trimmed)
		? globMatchesModel(trimmed, model)
		: (() => {
				const resolved = resolveExactScopePattern(trimmed, allKnownModels);
				return resolved !== null && sameModelRef(resolved, model);
			})();
}

/** 保序去重（大小写不敏感，pi 侧匹配是 nocase）。 */
function dedupePatterns(patterns: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of patterns) {
		const pattern = raw.trim();
		if (!pattern) continue;
		const key = pattern.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(pattern);
	}
	return out;
}

/**
 * 从 patterns 中剔除「覆盖目标 provider 模型」的条目：
 * - 精确 `provider/id`：provider 前缀命中且 id 是本 provider 的已知模型 → 移除；
 *   id 未知（手写的前瞻规则）→ 保留，不吞无法确认的配置；
 * - 裸 id：仅在全部已知模型里唯一命中本 provider 时移除（跨 provider 歧义/未知则保留）；
 * - glob：不匹配本 provider 任何已知模型 → 原样保留；匹配 → 展开为匹配到的
 *   其它 provider 模型的精确条目（既不吞其它渠道，也不让 glob 继续覆盖本 provider 未勾选项）。
 */
function stripProviderPatterns(
	patterns: readonly string[],
	provider: string,
	providerIdsLower: ReadonlySet<string>,
	allKnownModels: readonly ModelRef[],
): string[] {
	const kept: string[] = [];
	for (const pattern of patterns) {
		if (!isGlobPattern(pattern)) {
			const matched = allKnownModels.filter((model) =>
				modelMatchesScopePattern(pattern, model, allKnownModels),
			);
			if (matched.some((model) => model.provider.toLowerCase() === provider.toLowerCase())) {
				continue;
			}
			// 保留未知/前瞻规则；目标 provider 的已知 full id 即使 allKnownModels
			// 调用方漏传，也仍能被识别并替换。
			const { modelPattern } = splitThinkingSuffix(pattern);
			const slash = modelPattern.indexOf("/");
			if (slash > 0) {
				const patternProvider = modelPattern.slice(0, slash).trim();
				const modelId = modelPattern.slice(slash + 1).trim();
				if (
					patternProvider.toLowerCase() === provider.toLowerCase()
					&& providerIdsLower.has(modelId.toLowerCase())
				) {
					continue;
				}
			}
			kept.push(pattern);
			continue;
		}
		const matched = allKnownModels.filter((m) => globMatchesModel(pattern, m));
		const hitsProvider = matched.some((m) => m.provider.toLowerCase() === provider.toLowerCase());
		if (!hitsProvider) {
			kept.push(pattern); // 不碰其它渠道的 glob
			continue;
		}
		// 命中本 provider：展开为其它 provider 命中项的精确条目，替代原 glob
		const { suffix } = splitThinkingSuffix(pattern);
		for (const m of matched) {
			if (m.provider.toLowerCase() !== provider.toLowerCase()) {
				kept.push(`${m.provider}/${m.id}${suffix}`);
			}
		}
	}
	return dedupePatterns(kept);
}

/**
 * 计算内置/OAuth 渠道勾选保存后的 enabledModels（纯函数，不落盘）。
 *
 * 语义（与 pi 的 --models / Ctrl+P 循环范围一致）：
 * - 勾选 = 本 provider 全部已知模型 → 移除本 provider 的覆盖；没有其它 pattern 遗留时
 *   返回 undefined（调用方删除 enabledModels，恢复默认全量）；
 * - 勾选为子集 → 其它渠道的既有 pattern 原样保留，本 provider 写精确 `provider/id` 子集；
 * - 当前无过滤（无 enabledModels）时写子集：先把其它渠道物化为 `provider/*`
 *   （保持它们默认全量），再追加本 provider 子集——否则启用过滤后其它渠道会从循环里消失。
 */
export function mergeProviderModelScope(input: MergeProviderModelScopeInput): MergeProviderModelScopeResult {
	const provider = input.provider.trim();
	const providerIds = dedupePatterns(input.providerModelIds);
	const providerIdsLower = new Set(providerIds.map((id) => id.toLowerCase()));
	const selected = dedupePatterns(input.selectedIds).filter((id) => providerIdsLower.has(id.toLowerCase()));
	const existing = dedupePatterns(input.existingPatterns ?? []);

	const allSelected = providerIds.length > 0 && selected.length >= providerIds.length;

	if (allSelected) {
		if (existing.length === 0) return {}; // 本来就无过滤，无需写入
		const kept = stripProviderPatterns(existing, provider, providerIdsLower, input.allKnownModels);
		return kept.length > 0 ? { patterns: kept } : {};
	}

	const selectedFullIds = selected.map((id) => `${provider}/${id}`);
	if (existing.length === 0) {
		// 当前无过滤：其它渠道物化为 provider/*（保持默认全量），再写本 provider 子集
		const otherProviders = dedupePatterns(
			(input.allKnownProviders ?? input.allKnownModels.map((m) => m.provider))
				.filter((p) => p.toLowerCase() !== provider.toLowerCase()),
		);
		return {
			patterns: dedupePatterns([...otherProviders.map((p) => `${p}/*`), ...selectedFullIds]),
		};
	}

	const kept = stripProviderPatterns(existing, provider, providerIdsLower, input.allKnownModels);
	return { patterns: dedupePatterns([...kept, ...selectedFullIds]) };
}
