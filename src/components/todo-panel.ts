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

/** 面板默认折叠时展示的条数。 */
const COLLAPSED_VISIBLE = 3;

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
			this.container.classList.add("hidden-pane");
			render(nothing, this.container);
			return;
		}
		this.container.classList.remove("hidden-pane");
		render(this.renderPanel(), this.container);
	}

	private renderPanel(): TemplateResult {
		const done = this.todos.filter((item) => item.done).length;
		const total = this.todos.length;
		const allDone = done === total;
		// 折叠时优先展示未完成项：用户关心的是「还剩什么」。
		// 全部完成时退回按原序取前几条，否则面板会突然变空。
		const pending = this.todos.filter((item) => !item.done);
		const source = allDone ? this.todos : pending;
		const visible = this.expanded ? this.todos : source.slice(0, COLLAPSED_VISIBLE);
		const hiddenCount = this.expanded ? 0 : Math.max(0, total - visible.length);
		const progressPercent = total === 0 ? 0 : Math.round((done / total) * 100);

		return html`
			<div class="todo-panel ${allDone ? "is-complete" : ""}">
				<div class="todo-panel-head">
					<button
						type="button"
						class="todo-panel-toggle"
						aria-expanded=${this.expanded ? "true" : "false"}
						title=${this.expanded ? t("todoPanel.collapse") : t("todoPanel.expand")}
						@click=${() => {
							this.expanded = !this.expanded;
							this.notifyViewState();
							this.render();
						}}
					>
						<span class="todo-panel-caret ${this.expanded ? "is-open" : ""}" aria-hidden="true">▸</span>
						<span class="todo-panel-title">${t("todoPanel.title")}</span>
						<span class="todo-panel-count">${done}/${total}</span>
					</button>
					<div
						class="todo-panel-progress"
						role="progressbar"
						aria-label=${t("todoPanel.progressLabel")}
						aria-valuemin="0"
						aria-valuemax="100"
						aria-valuenow=${progressPercent}
					>
						<div class="todo-panel-progress-fill" style="width:${progressPercent}%"></div>
					</div>
					<button
						type="button"
						class="todo-panel-dismiss"
						title=${t("todoPanel.dismiss")}
						aria-label=${t("todoPanel.dismiss")}
						@click=${() => {
							this.dismissed = true;
							this.notifyViewState();
							this.render();
						}}
					>
						×
					</button>
				</div>

				<ul class="todo-panel-list">
					${visible.map(
						(item) => html`
							<li class="todo-panel-item ${item.done ? "is-done" : ""}">
								<span class="todo-panel-mark" aria-hidden="true">${item.done ? "✓" : "○"}</span>
								<span class="sr-only-text"
									>${item.done ? t("todoPanel.itemDone") : t("todoPanel.itemPending")}</span
								>
								<span class="todo-panel-text">${item.text}</span>
							</li>
						`,
					)}
				</ul>

				${hiddenCount > 0
					? html`<button
							type="button"
							class="todo-panel-more"
							@click=${() => {
								this.expanded = true;
								this.notifyViewState();
								this.render();
							}}
					  >
							${t("todoPanel.more", { count: String(hiddenCount) })}
					  </button>`
					: nothing}
			</div>
		`;
	}
}

