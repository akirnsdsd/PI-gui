/**
 * 消息时间线（chat-view 时间线组）文案：消息行、工作流摘要、工具调用预览、
 * 上下文压缩（compaction）、自动重试与运行时状态通知。
 */
export default {
	copyMessage: "复制消息",
	errors: {
		prefix: "错误：{message}",
	},
	changelog: {
		defaultTitle: "更新日志",
		show: "展开",
		hide: "收起",
	},
	compaction: {
		running: "正在压缩上下文…",
		done: "上下文压缩完成",
		failed: "上下文压缩失败",
		aborted: "上下文压缩已中止",
		started: "已开始压缩上下文",
		abortedDetail: "压缩在完成前被中止。",
		failureDetail: "失败原因：{message}",
		failedNotice: "自动压缩失败：{message}",
		abortedNotice: "自动压缩已中止",
		doneDetail: "上下文压缩成功完成。",
		doneNotice: "自动压缩完成",
		tokensBefore: "压缩前上下文：{tokens} tokens",
	},
	workflow: {
		thinking: "思考中…",
		noOutput: "暂无输出。",
		agent: "助手",
		status: {
			running: "运行中",
			failed: "失败",
			success: "成功",
		},
		summary: {
			complete: "{count} 项完成",
			failed: "{count} 项失败",
			running: "{count} 项运行中",
		},
	},
	tools: {
		fallbackName: "工具",
		noOutput: "（无输出）",
		resultHeading: "工具结果：",
		resultHeadingError: "工具结果（错误）：",
		ranCommand: "运行 {command}",
		read: "读取 {path}",
		wrote: "写入 {path}",
		edited: "编辑 {path}",
		searched: "搜索 {query}",
		listed: "浏览 {path}",
		ranTool: "运行 {name}",
	},
	labels: {
		branchSummary: "分支摘要",
		compactionSummary: "上下文压缩摘要",
		toolResult: "工具结果",
		image: "图片",
	},
	history: {
		loadEarlier: "加载更早消息",
		loadingEarlier: "正在加载更早消息…",
		loadEarlierFailed: "加载更早消息失败",
		truncatedMarker: "…（已截断 {kb} KB）",
	},
	retry: {
		waiting: "{seconds}s 后重试（第 {attempt}/{max} 次）",
		unknownFailure: "未知重试错误",
		failed: "重试失败：{message}",
		succeededAttempt: "第 {attempt} 次重试成功",
		succeeded: "重试成功",
	},
	runtime: {
		runFailed: "运行失败：{message}",
		unknownError: "未知运行时错误",
		error: "运行时错误：{message}",
		errorWithSource: "运行时错误（{source}）：{message}",
		unknownExtensionError: "未知扩展错误",
		extensionError: "扩展错误（{label}）：{message}",
		extensionErrorWithSource: "扩展错误（{label}:{source}）：{message}",
		loadingSession: "正在加载会话…",
		reconnectingSession: "正在重新连接会话…",
		disconnected: "与 pi 进程的连接已断开",
	},
} as const;
