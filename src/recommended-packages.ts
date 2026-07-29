export interface RecommendedPackageDefinition {
	id: string;
	name: string;
	description: string;
	installScopeHint: "global" | "project" | "either";
	source: string;
	sourceKind: "npm" | "git" | "url" | "local";
	publisher: "first-party" | "community";
	resourcesLabel: string;
	installSourceHint: string;
	aliases?: string[];
}

export const RECOMMENDED_PACKAGES: RecommendedPackageDefinition[] = [
	{
		id: "pi-desktop-themes",
		name: "Pi Desktop Themes",
		description: "Pi Desktop 默认浅色/深色主题，适用于桌面端和 TUI（Default、Notion、Catppuccin、GitHub、VSCode Plus）。",
		installScopeHint: "global",
		source: "local:pi-desktop-themes",
		sourceKind: "local",
		publisher: "first-party",
		resourcesLabel: "10 套主题",
		installSourceHint: "~/.pi/agent/themes/pi-desktop-*.json",
		aliases: ["pi-desktop-themes"],
	},
	{
		id: "pi-smart-voice-notify",
		name: "Pi Smart Voice Notify",
		description: "智能语音/声音/桌面通知，可通过 /voice-notify 交互式设置（ctx.ui.notify-capable）。",
		installScopeHint: "global",
		source: "npm:pi-smart-voice-notify",
		sourceKind: "npm",
		publisher: "community",
		resourcesLabel: "1 个扩展",
		installSourceHint: "npm:pi-smart-voice-notify",
		aliases: ["pi-smart-voice-notify", "pi-desktop-notify"],
	},
	{
		id: "pi-auto-rename",
		name: "Pi Auto Rename",
		description: "根据首条提问自动重命名 Pi 会话，模型、回退和前缀行为均可配置。",
		installScopeHint: "global",
		source: "npm:@byteowlz/pi-auto-rename",
		sourceKind: "npm",
		publisher: "community",
		resourcesLabel: "1 个扩展",
		installSourceHint: "npm:@byteowlz/pi-auto-rename",
		aliases: ["@byteowlz/pi-auto-rename", "pi-session-auto-rename"],
	},
	{
		id: "pi-cursor-provider",
		name: "Cursor Provider",
		description: "通过 Cursor 本地代理/provider 扩展，将 Pi 连接到 Cursor 已登录的模型。",
		installScopeHint: "global",
		source: "npm:pi-cursor-provider",
		sourceKind: "npm",
		publisher: "community",
		resourcesLabel: "1 个 provider 扩展",
		installSourceHint: "npm:pi-cursor-provider",
		aliases: ["pi-cursor-provider", "cursor-provider", "cursor"],
	},
	{
		id: "pi-kilocode",
		name: "Kilo Code Provider",
		description: "将 Kilo Code 添加为 Pi 的 provider，并对桌面端提供良好的能力集成。",
		installScopeHint: "global",
		source: "npm:pi-kilocode",
		sourceKind: "npm",
		publisher: "community",
		resourcesLabel: "1 个 provider 扩展",
		installSourceHint: "npm:pi-kilocode",
		aliases: ["pi-kilocode", "kilo", "kilocode"],
	},
];

function normalizeNpmSource(value: string): string {
	const spec = value.slice(4).trim().toLowerCase();
	if (!spec) return "npm:";
	if (spec.startsWith("@")) {
		const versionIndex = spec.indexOf("@", 1);
		return `npm:${versionIndex === -1 ? spec : spec.slice(0, versionIndex)}`;
	}
	const versionIndex = spec.indexOf("@");
	return `npm:${versionIndex === -1 ? spec : spec.slice(0, versionIndex)}`;
}

export function normalizeRecommendedSource(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
	const lower = normalized.toLowerCase();
	if (lower.startsWith("npm:")) return normalizeNpmSource(lower);
	return lower;
}
