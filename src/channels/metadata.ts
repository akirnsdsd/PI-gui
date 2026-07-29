/**
 * 模型元数据补全，按可靠性从高到低逐级填补仍为空的字段：
 *
 * 1. remote：远端 /models 响应明确返回的字段（适配器已归一命名）；
 * 2. preset exact：项目当前选中预设的精确模型表（相同模型 ID 的显式条目）；
 * 3. catalog：pi 模型目录的「精确 ID」匹配（@mariozechner/pi-ai 静态目录为认证无关底座，
 *    合并 get_available_models 运行时目录；provider+id 优先；跨 provider 仅在 exact id 唯一
 *    或多个匹配能力完全一致时复用；pi 对未知模型套的缺省值 128000/16384/false/["text"]
 *    不算权威，永不回填）；
 * 4. 以上都缺失则保持 null（未知）：缺省不写入 models.json（不落猜测值），
 *    UI 显示「未知」，由用户手动确认。成本一律不填（未知）。
 *
 * 硬约束（渠道来源真实性）：
 * - 「远端发现」的模型 ID 只能来自成功的 /models 响应（FetchedModel[]）；
 *   预设与 pi 目录只能给相同 ID 补元数据，绝不向渠道列表新增模型 ID；
 * - 不按模型名字、厂商前缀或未来版本号猜参数（预设 modelPrefixes 前缀规则
 *   因此不再参与补全；未知就保持未知，不为让行可勾选而伪造四项参数）。
 */
import { normalizeInputModalities } from "./adapters.js";
import { findPreset, type ChannelPreset } from "./presets.js";
import type {
	FetchedModel,
	ModelDraft,
	ModelInputCapability,
	ModelMeta,
	ModelMetaFieldSource,
	ModelMetaFieldSources,
} from "./types.js";

// ---------------------------------------------------------------------------
// 预设查找（exact 优先于 prefix；两者可靠性分层不同）
// ---------------------------------------------------------------------------

export interface PresetMetaHit {
	meta: ModelMeta;
	/**
	 * true = 精确模型表命中（补全pipeline 只使用这一档）；
	 * false = 前缀规则命中（按名字前缀的推断；补全 pipeline 不再使用——
	 * 不得按模型名字/厂商前缀猜参数，保留本分支仅为查询完整性）。
	 */
	exact: boolean;
}

export function lookupPresetMetaDetailed(
	preset: ChannelPreset | null,
	modelId: string,
): PresetMetaHit | null {
	if (!preset) return null;
	const exact = preset.models?.[modelId];
	if (exact) return { meta: exact, exact: true };
	const lower = modelId.toLowerCase();
	for (const rule of preset.modelPrefixes ?? []) {
		if (lower.startsWith(rule.prefix.toLowerCase())) return { meta: rule.meta, exact: false };
	}
	return null;
}

export function lookupPresetMeta(
	preset: ChannelPreset | null,
	modelId: string,
): ModelMeta | null {
	return lookupPresetMetaDetailed(preset, modelId)?.meta ?? null;
}

// ---------------------------------------------------------------------------
// pi 运行时模型目录（get_available_models）精确 ID 补全
// ---------------------------------------------------------------------------

/** pi 运行时模型目录里的一条记录（能力字段缺失为 null）。 */
export interface RuntimeCatalogEntry {
	provider: string;
	id: string;
	name?: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean | null;
	input: ModelInputCapability;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function pickCatalogPositiveInt(record: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = record[key];
		const num = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
		if (Number.isFinite(num) && num > 0) return Math.round(num);
	}
	return null;
}

/**
 * 解析目录单条记录；缺 provider/id 的条目丢弃。
 * get_available_models 运行时条目与 pi-ai 静态模型表（getModels）同构，共用此防御解析。
 */
export function parseRuntimeCatalogEntry(raw: unknown): RuntimeCatalogEntry | null {
	const record = asRecord(raw);
	if (!record) return null;
	const provider = typeof record.provider === "string" ? record.provider.trim() : "";
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!provider || !id) return null;
	return {
		provider,
		id,
		name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined,
		contextWindow: pickCatalogPositiveInt(record, ["contextWindow", "context_window"]),
		maxTokens: pickCatalogPositiveInt(record, ["maxTokens", "max_tokens"]),
		reasoning: typeof record.reasoning === "boolean" ? record.reasoning : null,
		input: normalizeInputModalities(record.input) ?? null,
	};
}

/**
 * pi 对未知（未声明元数据）模型套的缺省四元组。
 * 该组合不含任何超出 pi 缺省行为的信息：既不能当权威元数据回填（会把
 * 缺省值伪装成已确认能力），不落盘时 pi 运行时也会套同样的缺省值。
 */
const PI_DEFAULT_CONTEXT_WINDOW = 128000;
const PI_DEFAULT_MAX_TOKENS = 16384;

function isPiDefaultTuple(entry: RuntimeCatalogEntry): boolean {
	return (
		entry.contextWindow === PI_DEFAULT_CONTEXT_WINDOW
		&& entry.maxTokens === PI_DEFAULT_MAX_TOKENS
		&& entry.reasoning === false
		&& entry.input !== null
		&& entry.input.length === 1
		&& entry.input[0] === "text"
	);
}

/** 目录匹配上下文：当前渠道 provider + 目录条目（静态目录与运行时目录的合并结果）。 */
export interface CatalogLookup {
	provider: string;
	entries: readonly RuntimeCatalogEntry[];
}

function capabilityTuple(entry: RuntimeCatalogEntry): string {
	return JSON.stringify([entry.contextWindow, entry.maxTokens, entry.reasoning, entry.input]);
}

/**
 * 运行时目录精确 ID 查找：
 * - 仅接受 exact model id（不用模糊别名/包含关系/名称前缀猜测）；
 * - 先排除 pi 缺省四元组条目（含当前自定义 provider 自身的缺省条目）；
 * - provider + exact id 命中优先；
 * - 跨 provider 复用仅当剩余匹配的能力四元组完全一致（含唯一匹配）。
 */
export function lookupRuntimeCatalogMeta(
	catalog: CatalogLookup | null | undefined,
	modelId: string,
): RuntimeCatalogEntry | null {
	if (!catalog || !catalog.provider || !modelId) return null;
	const candidates = catalog.entries.filter(
		(entry) => entry.id === modelId && !isPiDefaultTuple(entry),
	);
	if (candidates.length === 0) return null;
	const sameProvider = candidates.filter((entry) => entry.provider === catalog.provider);
	if (sameProvider.length > 0) return sameProvider[0] ?? null;
	const tuple = capabilityTuple(candidates[0]!);
	for (const entry of candidates) {
		if (capabilityTuple(entry) !== tuple) return null; // 不唯一且能力冲突：不补全
	}
	return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// pi 静态模型目录（@mariozechner/pi-ai 内置模型表，无认证门槛）+ 目录合并
// ---------------------------------------------------------------------------

/** pi-ai 静态模型表的最小结构（动态 import 后运行时防御校验）。 */
interface PiAiModelsModule {
	getProviders?: () => readonly string[];
	getModels?: (provider: string) => readonly unknown[];
}

/**
 * 从已安装的 @mariozechner/pi-ai 读取内置静态模型目录（getProviders/getModels）。
 * pi 运行时的 ModelRegistry.getAvailable() 只返回 hasConfiguredAuth() 为真的模型：
 * 只配置了自定义中转（如 cc-kiro-cache）时，pi 内置 provider 的权威能力全被认证过滤，
 * 运行时目录看不到 anthropic 等内置模型；静态表直接来自包内 MODELS，无此门槛。
 * 动态 import 让目录不进首屏主 chunk；加载失败安全降级为空目录，不阻断设置页。
 */
export async function loadPiStaticCatalog(
	importImpl: () => Promise<PiAiModelsModule> = async () =>
		(await import("@mariozechner/pi-ai")) as unknown as PiAiModelsModule,
): Promise<RuntimeCatalogEntry[]> {
	try {
		const mod = await importImpl();
		if (typeof mod.getProviders !== "function" || typeof mod.getModels !== "function") return [];
		const entries: RuntimeCatalogEntry[] = [];
		for (const provider of mod.getProviders()) {
			if (typeof provider !== "string" || !provider) continue;
			let models: readonly unknown[];
			try {
				models = mod.getModels(provider);
			} catch {
				continue; // 单个 provider 读取失败不影响其它 provider
			}
			if (!Array.isArray(models)) continue;
			for (const model of models) {
				const parsed = parseRuntimeCatalogEntry(model);
				if (parsed) entries.push(parsed);
			}
		}
		return entries;
	} catch {
		return []; // 包缺失/导入失败：安全降级为空目录
	}
}

/**
 * 合并静态目录与运行时目录，按 provider + exact id 去重：
 * - 静态目录提供认证无关的底座（pi 内置 provider 的权威能力）；
 * - 运行时条目若只是 pi 缺省四元组，不得覆盖静态目录里同 provider+id 的权威能力
 *   （缺省值不含任何已确认信息）；
 * - 运行时条目包含明确非缺省能力/用户 override 时覆盖对应静态条目，
 *   其 null 字段保留静态值（不丢已确认字段）；
 * - 自定义 provider 的运行时条目照常加入目录，显式配置的能力可被同 provider 精确匹配。
 */
export function mergeCatalogEntries(
	staticEntries: readonly RuntimeCatalogEntry[],
	runtimeEntries: readonly RuntimeCatalogEntry[],
): RuntimeCatalogEntry[] {
	const byKey = new Map<string, RuntimeCatalogEntry>();
	const keyOf = (entry: RuntimeCatalogEntry): string => `${entry.provider}\u0000${entry.id}`;
	for (const entry of staticEntries) {
		const key = keyOf(entry);
		if (!byKey.has(key)) byKey.set(key, entry);
	}
	for (const entry of runtimeEntries) {
		const key = keyOf(entry);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, entry); // 静态目录没有该 provider+id（如自定义 provider）：直接加入
			continue;
		}
		if (isPiDefaultTuple(entry)) continue; // 缺省四元组不覆盖静态权威能力
		byKey.set(key, {
			provider: entry.provider,
			id: entry.id,
			name: entry.name ?? existing.name,
			contextWindow: entry.contextWindow ?? existing.contextWindow,
			maxTokens: entry.maxTokens ?? existing.maxTokens,
			reasoning: entry.reasoning ?? existing.reasoning,
			input: entry.input ?? existing.input,
		});
	}
	return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// 补全主流程
// ---------------------------------------------------------------------------

function setField<K extends "contextWindow" | "maxTokens" | "reasoning" | "input">(
	draft: ModelDraft,
	sources: ModelMetaFieldSources,
	field: K,
	value: ModelDraft[K] | undefined,
	source: ModelMetaFieldSource,
): void {
	if (draft[field] !== null || value === undefined || value === null) return;
	draft[field] = value;
	sources[field] = source;
}

function recomputeConfirmed(draft: ModelDraft): void {
	draft.metaConfirmed =
		draft.contextWindow !== null
		&& draft.maxTokens !== null
		&& draft.reasoning !== null
		&& draft.input !== null;
}

/**
 * 单个模型的元数据补全（输入是一次成功拉取的 FetchedModel）。
 * selected 默认 false：拉取发现的模型一律由用户勾选后才写入 models.json；
 * 手填添加（draftFromManualId）与既有草稿合并（mergeFetchedModelDrafts）各自覆盖。
 * 来源标记 origin:"remote" + seenInFetch:true；手填路径会覆盖为 manual。
 */
export function completeModelMeta(
	fetched: FetchedModel,
	preset: ChannelPreset | null,
	catalog?: CatalogLookup | null,
): ModelDraft {
	const draft: ModelDraft = {
		id: fetched.id,
		name: fetched.name?.trim() || fetched.id,
		contextWindow: null,
		maxTokens: null,
		reasoning: null,
		input: null,
		selected: false,
		metaConfirmed: false,
		origin: "remote",
		seenInFetch: true,
	};
	const sources: ModelMetaFieldSources = {};

	// 1) 远端明确返回的字段（最高优先级）
	setField(draft, sources, "contextWindow", fetched.contextWindow, "remote");
	setField(draft, sources, "maxTokens", fetched.maxTokens, "remote");
	setField(draft, sources, "reasoning", fetched.reasoning, "remote");
	setField(draft, sources, "input", fetched.input, "remote");

	// 2) 预设精确表（仅相同模型 ID 的显式条目；前缀规则不按名字猜参数，见模块头硬约束）
	const presetHit = lookupPresetMetaDetailed(preset, fetched.id);
	if (presetHit?.exact) {
		setField(draft, sources, "contextWindow", presetHit.meta.contextWindow, "preset");
		setField(draft, sources, "maxTokens", presetHit.meta.maxTokens, "preset");
		setField(draft, sources, "reasoning", presetHit.meta.reasoning, "preset");
	}

	// 3) pi 模型目录精确 ID
	const catalogHit = lookupRuntimeCatalogMeta(catalog, fetched.id);
	if (catalogHit) {
		setField(draft, sources, "contextWindow", catalogHit.contextWindow ?? undefined, "catalog");
		setField(draft, sources, "maxTokens", catalogHit.maxTokens ?? undefined, "catalog");
		setField(draft, sources, "reasoning", catalogHit.reasoning ?? undefined, "catalog");
		setField(draft, sources, "input", catalogHit.input ?? undefined, "catalog");
	}

	if (Object.keys(sources).length > 0) draft.metaSources = sources;
	recomputeConfirmed(draft);
	return draft;
}

/** 批量补全；presetId 允许直接给预设 id；catalog 为可选的运行时目录上下文。 */
export function completeModelsMeta(
	fetched: readonly FetchedModel[],
	presetId: string | null,
	catalog?: CatalogLookup | null,
): ModelDraft[] {
	const preset = findPreset(presetId);
	return fetched.map((model) => completeModelMeta(model, preset, catalog));
}

/**
 * 手填模型 ID 时同样走补全（预设精确表/目录可能命中）。
 * 手填本身就是明确添加意图，因此无论元数据是否齐全都默认勾选；
 * 未知字段保存时省略，由 pi 使用其 128000/16384/false/["text"] 缺省值。
 */
export function draftFromManualId(
	modelId: string,
	presetId: string | null,
	catalog?: CatalogLookup | null,
): ModelDraft | null {
	const id = modelId.trim();
	if (!id) return null;
	const draft = completeModelMeta({ id }, findPreset(presetId), catalog);
	draft.origin = "manual";
	draft.seenInFetch = false;
	draft.selected = true;
	return draft;
}

// ---------------------------------------------------------------------------
// 拉取结果与既有草稿的合并（重新拉取的来源真实语义）
// ---------------------------------------------------------------------------

/**
 * 合并本轮「成功」拉取补全的草稿与编辑页既有草稿（拉取失败不应调用本函数）：
 * - 远端仍返回的既有 ID：保留当前勾选状态与来源（saved/manual 不改成 remote），
 *   标记 seenInFetch；已有非空元数据（用户手改/已保存）不被覆盖，
 *   仍为空的字段用本轮补全值填补；
 * - 本次新发现的 ID：默认不勾选（completeModelMeta 的缺省），来源 remote；
 * - 上一次远端出现、这一次未出现的 remote-only 行：删除（不再伪装可用）；
 * - saved/manual 行本次未返回：保留（选择/元数据不动），标记 seenInFetch=false，
 *   由 UI 分组标注「本次远端未发现」，不计入「远端发现」；
 * - 成功但 0 个模型时调用方传空 fetched：效果即清掉全部旧 remote-only 行，
 *   只留 saved/manual。
 */
export function mergeFetchedModelDrafts(
	fetched: readonly ModelDraft[],
	existing: readonly ModelDraft[] | null,
): ModelDraft[] {
	// 以合并边界为准重置本轮来源标记（completeModelMeta 已设置，这里幂等重申）
	const fetchedMarked = fetched.map((draft) => ({
		...draft,
		origin: draft.origin ?? "remote",
		seenInFetch: true,
	}));
	if (!existing || existing.length === 0) return fetchedMarked;

	const existingById = new Map<string, ModelDraft>();
	for (const draft of existing) {
		const key = draft.id.toLowerCase();
		if (!existingById.has(key)) existingById.set(key, draft);
	}

	const merged: ModelDraft[] = [];
	const matchedExisting = new Set<string>();

	for (const fresh of fetchedMarked) {
		const key = fresh.id.toLowerCase();
		const prev = existingById.get(key);
		if (!prev) {
			merged.push(fresh);
			continue;
		}
		matchedExisting.add(key);
		const sources: ModelMetaFieldSources = { ...(fresh.metaSources ?? {}) };
		const next: ModelDraft = {
			...fresh,
			id: prev.id, // 既有条目的 id 大小写对 pi 已有约束力，不随远端抖动
			name: prev.name && prev.name !== prev.id ? prev.name : fresh.name,
			selected: prev.selected,
			origin: prev.origin ?? "saved", // 同 ID 命中不降级 saved/manual 的来源
			seenInFetch: true,
			extraFields: prev.extraFields ?? fresh.extraFields,
			metaSources: undefined,
		};
		// 既有非空值优先（用户手改/已保存）；其来源随既有草稿保留（无记录 = 已确认），
		// 仍为空的字段保留本轮补全值与其来源。
		if (prev.contextWindow !== null) {
			next.contextWindow = prev.contextWindow;
			if (prev.metaSources?.contextWindow) sources.contextWindow = prev.metaSources.contextWindow;
			else delete sources.contextWindow;
		}
		if (prev.maxTokens !== null) {
			next.maxTokens = prev.maxTokens;
			if (prev.metaSources?.maxTokens) sources.maxTokens = prev.metaSources.maxTokens;
			else delete sources.maxTokens;
		}
		if (prev.reasoning !== null) {
			next.reasoning = prev.reasoning;
			if (prev.metaSources?.reasoning) sources.reasoning = prev.metaSources.reasoning;
			else delete sources.reasoning;
		}
		if (prev.input !== null) {
			next.input = prev.input;
			if (prev.metaSources?.input) sources.input = prev.metaSources.input;
			else delete sources.input;
		}
		if (Object.keys(sources).length > 0) next.metaSources = sources;
		recomputeConfirmed(next);
		merged.push(next);
	}

	// 本次未返回的既有行：remote-only 删除；saved/manual 保留并标记本次未发现
	// （无来源信息的旧草稿按 saved 保守保留）。
	for (const draft of existing) {
		if (matchedExisting.has(draft.id.toLowerCase())) continue;
		if (draft.origin === "remote") continue;
		merged.push({ ...draft, origin: draft.origin ?? "saved", seenInFetch: false });
	}
	return merged;
}

// ---------------------------------------------------------------------------
// 勾选/保存辅助（元数据字段在当前 pi 中均为可选）
// ---------------------------------------------------------------------------

/**
 * 「全选」语义：勾选所有草稿。未知元数据字段不会落盘，pi 会使用缺省值。
 */
export function withAllAddableSelected(drafts: readonly ModelDraft[]): ModelDraft[] {
	return drafts.map((draft) => ({ ...draft, selected: true }));
}

/**
 * 兼容旧调用方的保存校验入口。当前 pi 允许四项元数据缺省，因此不会阻止保存。
 */
export function findIncompleteSelectedDraft(
	_drafts: readonly ModelDraft[],
): ModelDraft | null {
	return null;
}

// ---------------------------------------------------------------------------
// 编辑草稿的名称回填（编辑旧/自定义渠道时名称不为空）
// ---------------------------------------------------------------------------

/**
 * 编辑页名称回填：非空 meta alias → 当前 record.displayName → record.provider。
 * 只影响显示名草稿，绝不改动实际 provider key；新建渠道不走这里（仍由用户填写）。
 */
export function resolveChannelEditAlias(
	metaAlias: string | undefined,
	displayName: string,
	provider: string,
): string {
	const alias = (metaAlias ?? "").trim();
	if (alias) return alias;
	const display = displayName.trim();
	if (display) return display;
	return provider;
}
