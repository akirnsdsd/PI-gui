/**
 * Todo 面板：把 `todo` 扩展的清单渲染在 composer 上方（对标 Codex 桌面 App 的任务条）。
 *
 * ## 数据来源
 *
 * **结构化数据，不解析文本。** `todo` 扩展（`~/.pi/agent/extensions/todo.ts`）在每次
 * 工具调用的 `result.details` 里带完整状态：`{ action, todos: [{id,text,done}], nextId }`。
 * 已实测该字段既走 `tool_execution_end` 事件，也落盘进 session JSONL，所以：
 * - 运行中：从 `tool_execution_end` 增量更新；
 * - 切会话/重载：从 `get_messages` 的 toolResult 回放重建。
 *
 * 扩展同时会调 `ctx.ui.setWidget` 推一份纯文本给 TUI，但 GUI **不用**它——文本是给
 * 终端看的（`── Todos 0/1 ──` 这种），解析它既脆弱又拿不到 done 状态。
 *
 * ## 为什么不复用 extension-ui-handler 的 widget 容器
 *
 * 那两个容器是 `fixed bottom-[132px] left-[278px]`，硬编码猜侧边栏宽度和 composer
 * 高度，侧边栏折叠或 composer 长高就会错位。本面板改为在 DOM 上真正位于 composer
 * 上方，由 flex 布局定位，不猜像素。
 */

import { html, nothing, render, type TemplateResult } from "lit";
import { t } from "../i18n/index.js";

export interface TodoItem {
	id: number;
	text: string;
	done: boolean;
}

/** 与扩展侧 TodoDetails 对应（`~/.pi/agent/extensions/todo.ts`）。 */
interface TodoDetailsLike {
	action?: unknown;
	todos?: unknown;
	nextId?: unknown;
}

/** 上限：清单来自外部扩展，不能假设它有节制。 */
const MAX_TODO_ITEMS = 200;
const MAX_TEXT_CHARS = 300;

/**
 * 从工具结果的 details 里解析出清单。
 *
 * 宽容解析：字段缺失或类型不对时返回 null 而不是抛错——扩展是用户可改的，
 * 它换个格式不该让 GUI 崩。
 */
export function parseTodoDetails(details: unknown): TodoItem[] | null {
	if (!details || typeof details !== "object") return null;
	const raw = (details as TodoDetailsLike).todos;
	if (!Array.isArray(raw)) return null;

	const items: TodoItem[] = [];
	for (const entry of raw.slice(0, MAX_TODO_ITEMS)) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const id = typeof record.id === "number" && Number.isFinite(record.id) ? record.id : null;
		const text = typeof record.text === "string" ? record.text : null;
		if (id === null || text === null) continue;
		items.push({
			id,
			text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text,
			done: record.done === true,
		});
	}
	return items;
}

export class TodoPanel {
	private container: HTMLElement;
	private todos: TodoItem[] = [];
	/** 折叠态：任务多时默认只显前几条，不把聊天区挤死。 */
	private expanded = false;
	/** 用户手动关闭后不再自动弹回，直到清单内容变化。 */
	private dismissed = false;
	private lastSignature = "";

	constructor(container: HTMLElement, onViewStateChange?: (state: { expanded: boolean; dismissed: boolean }) => void) {
		this.container = container;
		this.onViewStateChange = onViewStateChange;
	}

	/** 用户改了展开/关闭时通知宿主，使面板重建后能恢复。 */
	private onViewStateChange?: (state: { expanded: boolean; dismissed: boolean }) => void;

	private notifyViewState(): void {
		this.onViewStateChange?.(this.exportViewState());
	}

	/** 清单是否有内容（供外部判断要不要给它留位）。 */
	hasContent(): boolean {
		return this.todos.length > 0 && !this.dismissed;
	}

	/**
	 * 写入新清单。内容真变了才重置 dismissed——否则用户关掉后，
	 * 任何一次无关渲染都会把它弹回来。
	 */
	setTodos(next: TodoItem[]): boolean {
		const signature = next.map((item) => `${item.id}:${item.done ? 1 : 0}:${item.text}`).join("\u0000");
		const changed = signature !== this.lastSignature;
		if (!changed) return false;
		this.lastSignature = signature;
		this.todos = next;
		this.dismissed = false;
		this.render();
		return true;
	}

	/** 切会话时清空：清单是会话级状态，绝不能串到另一个会话去。 */
	/**
	 * 导出/恢复视图态。
	 *
	 * `expanded` 和 `dismissed` 是实例字段，而 lit 重渲染可能把插槽节点换掉
	 * （例如 welcome ↔ 聊天布局切换会重建整个 composer 子树），届时面板会被
	 * 重建。不带上这两个标志的话，用户刚折叠或刚关掉的面板会自己弹回。
	 */
	exportViewState(): { expanded: boolean; dismissed: boolean } {
		return { expanded: this.expanded, dismissed: this.dismissed };
	}

	restoreViewState(state: { expanded: boolean; dismissed: boolean }): void {
		this.expanded = state.expanded;
		this.dismissed = state.dismissed;
	}

	reset(): void {
		this.todos = [];
		this.lastSignature = "";
		this.expanded = false;
		this.dismissed = false;
		this.render();
	}

	render(): void {
		if (!this.hasContent()) {
			this.container.classList.add("todo-slot-empty");
			render(nothing, this.container);
			return;
		}
		this.container.classList.remove("todo-slot-empty");
		render(this.renderPanel(), this.container);
	}

	/**
	 * 胶囊 + hover 浮层。
	 *
	 * 形态对标 Codex 桌面版（已核实截图）：composer 上方居中一个窄胶囊，常驻显示
	 * `第 N/M 步`；hover 胶囊浮出完整清单，浮层**绝对定位、不占布局**，所以不会
	 * 挤压对话区——这也是窗口缩小时不再遮挡会话的根因修法。
	 *
	 * 关键取舍：整个 wrapper 用 :hover 触发浮层，而不是给胶囊绑 mouseenter/leave。
	 * 浮层在 wrapper 内、紧贴胶囊上方，指针从胶囊移到浮层不会离开 wrapper，
	 * 因此不会「刚展开就收回」。
	 */
	private renderPanel(): TemplateResult {
		const done = this.todos.filter((item) => item.done).length;
		const total = this.todos.length;
		const allDone = done === total;
		// 进行中项：Codex 在胶囊上显示当前步序号，取第一条未完成的。
		const currentIndex = this.todos.findIndex((item) => !item.done);
		const stepNumber = currentIndex === -1 ? total : currentIndex + 1;

		return html`
			<div class="todo-chip-wrap ${this.expanded ? "is-pinned" : ""}">
				<button
					type="button"
					class="todo-chip ${allDone ? "is-complete" : ""}"
					aria-expanded=${this.expanded ? "true" : "false"}
					title=${t("todoPanel.chipTitle")}
					@click=${() => {
						// 点击固定展开（hover 移开也不收），再点取消固定。
						this.expanded = !this.expanded;
						this.notifyViewState();
						this.render();
					}}
				>
					${allDone
						? html`<span class="todo-chip-mark is-done" aria-hidden="true">✓</span>`
						: html`<span class="todo-chip-spinner" aria-hidden="true"></span>`}
					<span class="todo-chip-label"
						>${allDone
							? t("todoPanel.chipDone", { total: String(total) })
							: t("todoPanel.chipStep", { step: String(stepNumber), total: String(total) })}</span
					>
				</button>

				<div class="todo-chip-popover" role="group" aria-label=${t("todoPanel.title")}>
					<div class="todo-chip-popover-head">
						<span class="todo-chip-popover-title">${t("todoPanel.title")}</span>
						<span class="todo-chip-popover-count"
							>${t("todoPanel.countLabel", { done: String(done), total: String(total) })}</span
						>
					</div>
					<ul class="todo-chip-list">
						${this.todos.map(
							(item, index) => html`
								<li
									class="todo-chip-item ${item.done ? "is-done" : ""} ${!item.done && index === currentIndex
										? "is-current"
										: ""}"
								>
									<span class="todo-chip-item-mark" aria-hidden="true">${item.done ? "✓" : "○"}</span>
									<span class="sr-only-text"
										>${item.done ? t("todoPanel.itemDone") : t("todoPanel.itemPending")}</span
									>
									<span class="todo-chip-item-text">${item.text}</span>
								</li>
							`,
						)}
					</ul>
				</div>
			</div>
		`;
	}
}
