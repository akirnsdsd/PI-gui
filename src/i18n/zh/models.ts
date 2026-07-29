/**
 * 模型选择器（composer 弹层）与 src/models/ 相关文案。
 */
export default {
	auth: {
		envConfigured: "已通过环境变量配置",
		logoutFrom: "退出登录 {provider}",
		openTerminalLogin: "打开终端登录 {provider}（自动开始 /login）",
		setupProvider: "配置 {provider}",
		connectedNoModelsOauth: "已连接，但当前没有可用模型。登录状态变化后请尝试 /reload。",
		connectedNoModels: "已连接，但该渠道还没有加载模型。请在「扩展包」中安装/启用对应扩展包，然后运行 /reload。",
		notConnectedOauth: "尚未连接。点击「登录」打开终端并自动开始 /login。",
		notConnected: "尚未配置密钥。前往 设置 → 模型渠道 添加，或点击「登录」按引导完成配置。",
	},
} as const;
