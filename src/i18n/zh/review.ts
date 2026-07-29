/**
 * Review 面板（review-panel.ts）文案：git 变更审查抽屉。
 */
export default {
	toggle: "变更",
	title: "变更审查",
	close: "关闭面板",
	refresh: "刷新",
	refreshing: "刷新中…",
	resize: "拖拽调整面板宽度",
	scopes: {
		unstaged: "未暂存",
		staged: "已暂存",
	},
	scopeEmpty: {
		unstaged: "暂无未暂存变更。",
		staged: "暂无已暂存变更。",
	},
	sections: {
		conflicts: "合并冲突",
		untracked: "未跟踪文件",
	},
	fileCount: "{count} 个文件",
	actions: {
		stage: "暂存",
		unstage: "取消暂存",
		expand: "查看差异",
		collapse: "收起差异",
	},
	status: {
		added: "新增",
		modified: "修改",
		deleted: "删除",
		renamed: "重命名",
		typechange: "类型变更",
	},
	notRepo: "当前项目不是 git 仓库。",
	noProject: "打开一个项目后即可审查变更。",
	loading: "正在加载…",
	loadingDiff: "正在加载差异…",
	noDiff: "暂无可显示的差异。",
	binary: "二进制文件，无法显示差异。",
	truncated: "差异超过 {lines} 行，已截断显示",
	untrackedMore: "…另有 {count} 个未跟踪文件未显示",
	freshRepoHint: "该仓库刚初始化且有 {count} 个未跟踪文件，建议先配置 .gitignore 再使用变更审查。",
	conflictHint: "存在合并冲突，请在编辑器中解决后再暂存",
	error: "操作失败：{message}",
	dismissError: "关闭错误提示",
} as const;
