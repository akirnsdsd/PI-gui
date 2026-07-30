/**
 * Todo 胶囊文案（composer 上方居中的窄胶囊 + hover 浮层）。
 *
 * 形态对标 Codex 桌面版：胶囊常驻显示「第 N/M 步」，hover 浮出完整清单。
 * 数据来自用户自装的 `todo` 扩展；没装扩展时胶囊永不出现。
 */
export default {
	title: "任务清单",
	/** 胶囊上的进行中文案，对齐 Codex 的 `Step N / M`。 */
	chipStep: "第 {step}/{total} 步",
	/** 全部完成时的胶囊文案。 */
	chipDone: "{total} 步已完成",
	chipTitle: "点击固定展开，移开鼠标自动收起",
	/** 浮层头部的完成计数。 */
	countLabel: "{done}/{total} 已完成",
	dismiss: "隐藏任务清单",
	/** ✓/○ 是 aria-hidden 的装饰，状态得另给读屏。 */
	itemDone: "已完成",
	itemPending: "未完成",
} as const;
