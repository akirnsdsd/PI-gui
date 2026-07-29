/**
 * 模型渠道（模型渠道 tab）共享类型。
 *
 * 涉及四类文件：
 * - pi `auth.json`：{ [provider]: { type, key?, ... } }，含 API key / OAuth 凭据。
 * - pi `models.json`：{ providers: { [name]: { baseUrl, api, models, headers?, ... } } }。
 * - pi `settings.json`：defaultProvider / defaultModel / enabledModels。
 * - GUI 自有 `channels-meta.json`（app_data_dir）：备注/别名/图标/排序，绝不写进 pi 配置。
 */

/** pi 支持的 API 协议（models.json 里 provider.api 的取值）。 */
export type ApiProtocol =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export const API_PROTOCOLS: readonly ApiProtocol[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

export function isApiProtocol(value: unknown): value is ApiProtocol {
	return typeof value === "string" && (API_PROTOCOLS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// pi 文件 schema（宽松：未知字段一律保留，read-modify-write 不丢数据）
// ---------------------------------------------------------------------------

export interface PiAuthEntry {
	type?: string;
	key?: string;
	[key: string]: unknown;
}

export type PiAuthFile = Record<string, PiAuthEntry | unknown>;

export interface PiModelEntry {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	[key: string]: unknown;
}

export interface PiModelsProvider {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: PiModelEntry[];
	headers?: Record<string, string>;
	[key: string]: unknown;
}

export interface PiModelsFile {
	providers?: Record<string, PiModelsProvider>;
	[key: string]: unknown;
}

export type PiSettingsFile = Record<string, unknown>;

// ---------------------------------------------------------------------------
// GUI 自有元数据
// ---------------------------------------------------------------------------

export interface ChannelMeta {
	/** 显示别名（用户可改名称；provider id 本身不可变）。 */
	alias?: string;
	note?: string;
	icon?: string;
	/** 记录来自哪个预设（用于图标/编辑策略）。 */
	presetId?: string;
	/** 最近一次「拉取模型」远端发现的模型总数（卡片显示「已启用 N / 共发现 M」用）。 */
	modelsTotal?: number;
	createdAt?: string;
	updatedAt?: string;
}

export interface ChannelsMetaFile {
	version: 1;
	channels: Record<string, ChannelMeta>;
	/** 卡片排序（provider 名列表）。 */
	order?: string[];
}

export function emptyChannelsMeta(): ChannelsMetaFile {
	return { version: 1, channels: {} };
}

// ---------------------------------------------------------------------------
// 渠道卡片视图模型（由 auth.json + models.json + meta + settings 合并而来）
// ---------------------------------------------------------------------------

/**
 * 渠道 key 的引用形式。
 * "modelsJson" = auth.json 无条目，但 models.json 的 provider 直接写了明文 apiKey
 * （pi 合法配置，resolution order: auth.json > env > models.json.apiKey）；
 * 编辑保存时会迁移到 Keychain 并从 models.json 删除。
 */
export type KeyRefKind = "none" | "plain" | "env" | "command" | "keychain" | "oauth" | "modelsJson";

export interface ChannelRecord {
	/** pi provider 名（auth.json / models.json 的键）。 */
	provider: string;
	/** 展示名（meta.alias ?? provider）。 */
	displayName: string;
	/** 是否为 pi 内置 provider（编辑时只能改 key + 中转地址）。 */
	isBuiltin: boolean;
	/** 当前生效的 baseUrl（models.json 覆盖 ?? 预设默认）。 */
	baseUrl: string;
	protocol: ApiProtocol | null;
	/** auth.json 里的认证类型。 */
	authKind: "api_key" | "oauth" | "none";
	keyRefKind: KeyRefKind;
	/** models.json 里声明的模型数（内置 provider 无 models.json 条目时为 0）。 */
	modelCount: number;
	/** 最近一次拉取时远端发现的模型总数（meta.modelsTotal）；无记录为 null。 */
	modelsTotal: number | null;
	/** 运行时（get_available_models）该 provider 的模型数；无运行时数据为 null。 */
	runtimeModelCount: number | null;
	models: PiModelEntry[];
	note: string;
	icon: string;
	/** 是否为 settings.json 里的默认渠道。 */
	isDefault: boolean;
	/** settings.json 里的默认模型（仅当 isDefault）。 */
	defaultModel: string | null;
	/** 是否有 models.json 自定义条目（内置 provider 的中转覆盖也算）。 */
	hasModelsEntry: boolean;
}

// ---------------------------------------------------------------------------
// 拉取模型 / 元数据补全
// ---------------------------------------------------------------------------

/**
 * 适配器统一产出。
 * 能力字段仅在远端 /models 响应明确返回时才有值（camelCase/snake_case 命名
 * 由适配器归一）；未返回则缺省（undefined），绝不由适配器猜测。
 */
export interface FetchedModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	/** 已规范的输入模态；undefined = 远端未明确返回。 */
	input?: ["text"] | ["text", "image"];
}

/** pi 必需的模型元数据。 */
export interface ModelMeta {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

/**
 * 单个元数据字段的补全来源：
 * - "remote"：远端 /models 响应明确返回；
 * - "catalog"：pi 模型目录精确 ID 匹配（静态表 + 运行时目录）；
 * - "preset"：项目预设精确模型表（仍是待确认语义）。
 * 字段未记录来源（undefined）= 用户手填或 models.json 已保存值，视为已确认。
 */
export type ModelMetaFieldSource = "remote" | "catalog" | "preset";

export interface ModelMetaFieldSources {
	contextWindow?: ModelMetaFieldSource;
	maxTokens?: ModelMetaFieldSource;
	reasoning?: ModelMetaFieldSource;
	input?: ModelMetaFieldSource;
}

/**
 * 草稿行的临时来源（只在内存/ UI 使用，绝不写入 models.json）：
 * - "saved"：来自 models.json 已保存配置；
 * - "remote"：来自本次编辑会话里某次成功的 /models 响应；
 * - "manual"：用户在编辑页手动输入 ID 添加。
 * 「远端发现」的模型 ID 只允许来自成功拉取的 FetchedModel[]；
 * pi 静态/运行时目录与预设只能给相同 ID 补元数据，绝不新增行。
 */
export type ModelDraftOrigin = "saved" | "remote" | "manual";

/**
 * 勾选列表里的一行：fetch 结果 + 补全的元数据。
 * 元数据字段为 null 表示「未知」：缺省不写入 models.json（不写猜测值），
 * UI 对应位置显示「未知」；预设精确表/目录命中或用户手填后才有具体值。
 */
export interface ModelDraft {
	id: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean | null;
	/**
	 * 输入能力三态：
	 * - null = 未知，缺省不写入 models.json；
	 * - ["text"] = 用户/来源明确确认仅文本；
	 * - ["text","image"] = 用户/来源明确确认文本 + 图片。
	 */
	input: ModelInputCapability;
	selected: boolean;
	/**
	 * 四项元数据（含 input）都有明确值才为 true。
	 * 仅用于 UI 展示元数据完整度；pi 允许这些字段缺省并使用
	 * 128000/16384/false/["text"]，因此 false 不阻止选择或保存。
	 */
	metaConfirmed: boolean;
	/**
	 * 各元数据字段的补全来源（仅自动补全的字段有记录）。
	 * 用于 UI 区分「远端明确返回 / 精确目录匹配」与「预设推断 / 未知」；
	 * 不落盘（toModelEntry 只挑选确定的值字段）。
	 */
	metaSources?: ModelMetaFieldSources;
	/**
	 * 行的临时来源；undefined = 无来源信息（旧数据），按 saved 保守处理。
	 * 不落盘（toModelEntry 不读该字段）。
	 */
	origin?: ModelDraftOrigin;
	/**
	 * 本次编辑会话最近一次「成功」的 /models 拉取是否返回了该 ID。
	 * false = 未成功拉取过，或成功拉取但该 ID 本次未返回（旧 remote-only 行
	 * 此时已被 merge 删除，剩下的 unseen 行必为 saved/manual）。
	 */
	seenInFetch?: boolean;
	/**
	 * 已保存条目里除 id/name/四项元数据之外的其它字段（cost/compat/thinkingLevelMap 等）。
	 * 编辑页重新保存时原样写回，避免把用户手写配置静默吞掉；新建草稿无此字段。
	 */
	extraFields?: Record<string, unknown>;
}

export type ModelInputCapability = null | ["text"] | ["text", "image"];
