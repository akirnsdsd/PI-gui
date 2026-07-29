/**
 * 扩展状态文案中文化映射表。
 *
 * 第三方扩展（如 pi-mcp-adapter）通过 extension_ui 的 setStatus 注入英文状态文本，
 * 这里按 statusKey + 文本模式识别已知格式，映射为中文渲染模型（紧凑 chip +
 * hover 明细）；未命中的文本由调用方原样展示。
 *
 * 新增扩展支持时只需向 EXTENSION_STATUS_MAPPINGS 追加条目：
 * 限定 key（可选）+ 一个捕获动态参数的正则 + 生成中文文案的 format。
 */

import { t } from "../i18n/index.js";

export interface ExtensionStatusView {
	/** 完整中文明细，用于 hover tooltip。 */
	detail: string;
	/** chip 行内短文案；缺省时展示 detail。 */
	label?: string;
	/** chip 图标（emoji 或单字符）。 */
	icon?: string;
	/** 数字徽标（如已启用服务器数）。 */
	badge?: string;
}

interface ExtensionStatusMapping {
	/** 限定 statusKey（字符串精确匹配或正则）；缺省匹配任意 key。 */
	key?: string | RegExp;
	/** 匹配 sanitize 后的状态文本，捕获动态参数。 */
	pattern: RegExp;
	format: (match: RegExpMatchArray) => ExtensionStatusView;
}

const MCP_STATUS_ICON = "🔌";

// pi-mcp-adapter updateStatusBar："MCP: N server(s) enabled (C connected) (D disabled)"
const MCP_SNAPSHOT_PATTERN =
	/^(?:🔌\s*)?MCP:\s*(\d+)\s+servers?\s+enabled(?:\s*\((\d+)\s+connected\))?(?:\s*\((\d+)\s+disabled\))?$/i;
// pi-mcp-adapter 启动 / 重连："MCP: connecting to X..."（X 为服务器名或 "N servers"）
const MCP_CONNECTING_PATTERN = /^(?:🔌\s*)?MCP:\s*connecting to\s+(.+?)\s*\.\.\.$/i;

/** "3 servers" → "3 个服务器"；其余原样返回。 */
function localizeMcpTarget(raw: string): string {
	const countMatch = /^(\d+)\s+servers?$/i.exec(raw.trim());
	if (countMatch) return t("panels.extensionUi.status.mcpServerCount", { count: Number(countMatch[1]) });
	return raw;
}

const EXTENSION_STATUS_MAPPINGS: ExtensionStatusMapping[] = [
	{
		key: "mcp",
		pattern: MCP_SNAPSHOT_PATTERN,
		format: (match) => {
			const enabled = Number(match[1]);
			const connected = match[2] !== undefined ? Number(match[2]) : null;
			const disabled = match[3] !== undefined ? Number(match[3]) : null;
			const extras: string[] = [];
			if (connected !== null && connected > 0) {
				extras.push(t("panels.extensionUi.status.mcpConnected", { count: connected }));
			}
			if (disabled !== null && disabled > 0) {
				extras.push(t("panels.extensionUi.status.mcpDisabled", { count: disabled }));
			}
			const base = t("panels.extensionUi.status.mcpServersEnabled", { count: enabled });
			return {
				detail: extras.length > 0 ? `${base}（${extras.join("，")}）` : base,
				label: "MCP",
				icon: MCP_STATUS_ICON,
				badge: String(enabled),
			};
		},
	},
	// pi-mcp-adapter 启动 / 重连："MCP: connecting to X..."（X 为服务器名或 "N servers"）
	{
		key: "mcp",
		pattern: MCP_CONNECTING_PATTERN,
		format: (match) => ({
			detail: t("panels.extensionUi.status.mcpConnecting", { name: localizeMcpTarget(match[1]) }),
			icon: MCP_STATUS_ICON,
		}),
	},
	// pi-mcp-adapter /mcp-auth："Authenticating X..."
	{
		key: "mcp-auth",
		pattern: /^Authenticating\s+(.+?)\s*\.\.\.$/i,
		format: (match) => ({
			detail: t("panels.extensionUi.status.mcpAuthenticating", { name: match[1] }),
			icon: MCP_STATUS_ICON,
		}),
	},
];

/**
 * 命中映射返回中文渲染模型；未命中返回 null，调用方原样展示英文文本。
 */
export function mapExtensionStatusText(statusKey: string, text: string): ExtensionStatusView | null {
	for (const mapping of EXTENSION_STATUS_MAPPINGS) {
		if (mapping.key !== undefined) {
			const keyMatches = typeof mapping.key === "string" ? mapping.key === statusKey : mapping.key.test(statusKey);
			if (!keyMatches) continue;
		}
		const match = mapping.pattern.exec(text);
		if (match) return mapping.format(match);
	}
	return null;
}

/** MCP 连通性相位：绿色呼吸=已连接、黄色呼吸=连接中、灰色=未连接/禁用。 */
export type McpConnectionPhase = "connected" | "connecting" | "disconnected";

export interface McpConnectionState {
	phase: McpConnectionPhase;
	/** 快照里的已启用服务器数；connecting 文本无此信息时为 null。 */
	enabled: number | null;
	connected: number | null;
	disabled: number | null;
}

/**
 * 从 pi-mcp-adapter 的状态文本解析结构化连通性（chip 呼吸灯 + 弹层面板共用）。
 * 仅处理 statusKey === "mcp"；非 MCP 状态或未命中已知格式返回 null。
 */
export function parseMcpConnectionState(statusKey: string, text: string): McpConnectionState | null {
	if (statusKey !== "mcp") return null;
	const snapshot = MCP_SNAPSHOT_PATTERN.exec(text);
	if (snapshot) {
		const enabled = Number(snapshot[1]);
		const connected = snapshot[2] !== undefined ? Number(snapshot[2]) : null;
		const disabled = snapshot[3] !== undefined ? Number(snapshot[3]) : null;
		return {
			phase: connected !== null && connected > 0 ? "connected" : "disconnected",
			enabled,
			connected,
			disabled,
		};
	}
	if (MCP_CONNECTING_PATTERN.test(text)) {
		return { phase: "connecting", enabled: null, connected: null, disabled: null };
	}
	return null;
}
