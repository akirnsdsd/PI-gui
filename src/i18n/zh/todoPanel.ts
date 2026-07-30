/**
 * Todo 面板文案（composer 上方的任务条）。
 *
 * 数据来自用户自装的 `todo` 扩展；没装扩展时面板永不出现。
 */
export default {
	title: "任务清单",
	expand: "展开全部任务",
	collapse: "收起已完成任务",
	dismiss: "隐藏任务清单",
	more: "还有 {count} 条",
	/** 进度条的无障碍名称（读屏用）。 */
	progressLabel: "任务完成进度",
	/** 单项状态的无障碍文本：✓/○ 是 aria-hidden 的装饰，状态得另给。 */
	itemDone: "已完成",
	itemPending: "未完成",
} as const;
