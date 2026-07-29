import { withExtensionCommandUsageHint } from "../extensions/extension-command-hints.js";

export interface BuiltinSlashCommandDefinition {
	name: string;
	description: string;
}

export type RuntimeSlashCommandSource = "extension" | "prompt" | "skill" | "other";

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function normalizeSlashCommandName(name: string): string {
	return normalizeText(name).replace(/^\/+/, "").toLowerCase();
}

export function withRuntimeCommandUsageHint(name: string, description: string): string {
	return withExtensionCommandUsageHint(name, normalizeText(description));
}

export function normalizeRuntimeSlashCommandSource(rawSource: string): RuntimeSlashCommandSource {
	const source = normalizeText(rawSource).toLowerCase();
	switch (source) {
		case "extension":
		case "prompt":
		case "skill":
			return source;
		default:
			return "other";
	}
}

export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommandDefinition[] = [
	{ name: "settings", description: "打开 Desktop 设置" },
	{ name: "model", description: "无参数打开模型选择器；精确参数直接切换模型，否则打开近似匹配的选择器" },
	{ name: "scoped-models", description: "打开设置里的 scoped-models 编辑器（Ctrl+P 模型循环范围）" },
	{ name: "export", description: "无参数打开保存对话框，/export <路径> 直接导出 HTML" },
	{ name: "import", description: "无参数打开文件选择器，/import <路径> 导入会话文件" },
	{ name: "share", description: "创建私密 gist 并生成指向 pi.dev 与 GitHub gist 的极简链接" },
	{ name: "copy", description: "复制最后一条助手消息" },
	{ name: "name", description: "无参数打开内联重命名，/name <文本> 直接设置名称" },
	{ name: "session", description: "追加详细会话信息与 token 统计" },
	{ name: "changelog", description: "在可折叠行中显示最新更新日志（/changelog all、/changelog refresh）" },
	{ name: "hotkeys", description: "打开键盘快捷键" },
	{ name: "terminal", description: "开关底部停靠终端" },
	{ name: "fork", description: "打开分叉流程，/fork <关键词> 预填消息搜索" },
	{ name: "tree", description: "打开跨分支完整会话树，/tree <关键词> 预填搜索" },
	{ name: "login", description: "无参数打开模型选择器的登录操作；/login <渠道> 打开该渠道的登录引导/配置" },
	{ name: "logout", description: "无参数打开模型选择器的登录操作；/logout <渠道> 清除 auth.json 凭据" },
	{ name: "new", description: "新建空白会话标签页" },
	{ name: "compact", description: "手动压缩上下文，/compact <指令> 可选" },
	{ name: "resume", description: "打开会话浏览器，/resume <关键词> 预填搜索" },
	{ name: "reload", description: "重载运行时（bridge 重启 + 状态/模型/命令刷新）" },
	{ name: "quit", description: "退出 Desktop 应用" },
];
