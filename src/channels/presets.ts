/**
 * 渠道预设：选中后自动填 名称/baseUrl/协议/图标。
 *
 * baseUrl 与协议取各家公开文档的常用端点，用户一律可改；
 * builtinProvider 对应 pi 内置 provider 名（见 src-tauri get_pi_auth_status
 * 的 env var 映射），内置渠道编辑时只能改 key 和可选中转地址。
 *
 * models / modelPrefixes 是「预设声称知道」的元数据预填（数值为公开文档的
 * 常见规格，保存前用户可修改）；未命中的模型走默认值并标「信息不全待确认」。
 */
import type { ApiProtocol, ModelMeta } from "./types.js";

export interface ChannelPreset {
	id: string;
	/** 预设显示名（专有名词，不走 i18n）。 */
	label: string;
	/** pi 内置 provider 名；自定义渠道为 null。 */
	builtinProvider: string | null;
	baseUrl: string;
	protocol: ApiProtocol;
	icon: string;
	/** 精确模型 id → 元数据预填。 */
	models?: Record<string, ModelMeta>;
	/** id 前缀 → 元数据预填（精确表优先）。 */
	modelPrefixes?: Array<{ prefix: string; meta: ModelMeta }>;
}

export const CHANNEL_PRESETS: readonly ChannelPreset[] = [
	{
		id: "anthropic",
		label: "Anthropic",
		builtinProvider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		protocol: "anthropic-messages",
		icon: "🟧",
		models: {
			"claude-opus-4-1": { contextWindow: 200000, maxTokens: 32000, reasoning: true },
			"claude-sonnet-4-5": { contextWindow: 200000, maxTokens: 64000, reasoning: true },
			"claude-haiku-4-5": { contextWindow: 200000, maxTokens: 64000, reasoning: true },
			"claude-3-5-sonnet-latest": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
			"claude-3-5-haiku-latest": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
		},
		modelPrefixes: [{ prefix: "claude-", meta: { contextWindow: 200000, maxTokens: 8192, reasoning: false } }],
	},
	{
		id: "openai",
		label: "OpenAI",
		builtinProvider: "openai",
		baseUrl: "https://api.openai.com/v1",
		protocol: "openai-completions",
		icon: "🟩",
		models: {
			"gpt-4o": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
			"gpt-4o-mini": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
			"gpt-4.1": { contextWindow: 1047576, maxTokens: 32768, reasoning: false },
			"gpt-4.1-mini": { contextWindow: 1047576, maxTokens: 32768, reasoning: false },
			o3: { contextWindow: 200000, maxTokens: 100000, reasoning: true },
			"o4-mini": { contextWindow: 200000, maxTokens: 100000, reasoning: true },
		},
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		builtinProvider: null,
		baseUrl: "https://api.deepseek.com/v1",
		protocol: "openai-completions",
		icon: "🐳",
		models: {
			"deepseek-chat": { contextWindow: 128000, maxTokens: 8192, reasoning: false },
			"deepseek-reasoner": { contextWindow: 128000, maxTokens: 8192, reasoning: true },
		},
	},
	{
		id: "kimi-coding",
		label: "Kimi For Coding",
		builtinProvider: "kimi-coding",
		baseUrl: "https://api.kimi.com/coding",
		protocol: "anthropic-messages",
		icon: "🌙",
		models: {
			"kimi-k2": { contextWindow: 128000, maxTokens: 8192, reasoning: false },
			"kimi-k2-0905-preview": { contextWindow: 262144, maxTokens: 8192, reasoning: false },
		},
		modelPrefixes: [{ prefix: "kimi-", meta: { contextWindow: 128000, maxTokens: 8192, reasoning: false } }],
	},
	{
		id: "zai",
		label: "智谱 GLM",
		builtinProvider: "zai",
		baseUrl: "https://open.bigmodel.cn/api/anthropic",
		protocol: "anthropic-messages",
		icon: "🧠",
		models: {
			"glm-4.6": { contextWindow: 200000, maxTokens: 8192, reasoning: true },
			"glm-4.5": { contextWindow: 128000, maxTokens: 8192, reasoning: true },
			"glm-4.5-air": { contextWindow: 128000, maxTokens: 8192, reasoning: true },
		},
		modelPrefixes: [{ prefix: "glm-", meta: { contextWindow: 128000, maxTokens: 8192, reasoning: false } }],
	},
	{
		id: "minimax",
		label: "MiniMax",
		builtinProvider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
		protocol: "anthropic-messages",
		icon: "⚡",
		models: {
			"MiniMax-M2": { contextWindow: 204800, maxTokens: 8192, reasoning: true },
		},
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		builtinProvider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		protocol: "openai-completions",
		icon: "🌐",
	},
	{
		id: "custom-openai",
		label: "自定义（OpenAI 兼容）",
		builtinProvider: null,
		baseUrl: "",
		protocol: "openai-completions",
		icon: "🔧",
	},
	{
		id: "custom-anthropic",
		label: "自定义（Anthropic 兼容）",
		builtinProvider: null,
		baseUrl: "",
		protocol: "anthropic-messages",
		icon: "🛠️",
	},
];

export function findPreset(id: string | null | undefined): ChannelPreset | null {
	if (!id) return null;
	return CHANNEL_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 内置 provider 名 → 预设（用于卡片图标/编辑策略）。 */
export function findPresetByBuiltinProvider(provider: string): ChannelPreset | null {
	const normalized = provider.trim().toLowerCase();
	if (!normalized) return null;
	return (
		CHANNEL_PRESETS.find(
			(preset) => preset.builtinProvider !== null && preset.builtinProvider === normalized,
		) ?? null
	);
}
