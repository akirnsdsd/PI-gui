/**
 * ContentTabs - mixed tab strip (session + file + terminal)
 */

import { html, nothing, render } from "lit";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n/index.js";
import { promptDialog } from "./app-dialog.js";
import {
	resolveInlineTitleKeyAction,
	shouldRestoreInlineTitleRename,
} from "./desktop-ui-behavior.js";

export type ContentTabType = "session" | "file" | "terminal";

export interface MainContentTab {
	id: string;
	type: ContentTabType;
	title: string;
	path?: string;
	closable: boolean;
	needsAttention?: boolean;
	attentionLabel?: string;
	pinned?: boolean;
	/** fork 分支标签：tab 栏仅在活动标签所属 fork 家族（主线程 + fork 链）内存在
	 * fork 标签时显示，且只列该家族标签（见 main.ts）。 */
	isFork?: boolean;
}

const TAB_COLORS_STORAGE_KEY = "pi-desktop.content-tab-colors.v1";
const TAB_LAYOUT_STORAGE_KEY = "pi-desktop.content-tab-layout.v1";
const DRAG_START_THRESHOLD_PX = 6;

const COLOR_PRESETS = [
	{ id: "red", value: "#8b4a46" },
	{ id: "green", value: "#4f755f" },
	{ id: "yellow", value: "#846a3f" },
	{ id: "blue", value: "#4d6f95" },
	{ id: "purple", value: "#7a5891" },
	{ id: "teal", value: "#4f8b8b" },
] as const;

type TabLayoutState = {
	pins: Record<string, boolean>;
	order: string[];
};

export class ContentTabs {
	private container: HTMLElement;
	private tabs: MainContentTab[] = [];
	private activeId: string | null = null;
	private onSelect: ((id: string) => void) | null = null;
	private onClose: ((id: string) => void) | null = null;
	private onRename: ((id: string, title: string) => void) | null = null;
	private onTitleRename: ((title: string) => boolean | Promise<boolean>) | null = null;
	private onOpenTerminal: (() => void) | null = null;
	private onCreateTab: (() => void) | null = null;
	private terminalActive = false;
	private collapsed = false;
	private currentTaskTitle = "";
	private editingTaskTitle = false;
	private taskTitleDraft = "";
	private taskTitleComposing = false;
	private taskTitleRenameGeneration = 0;
	private alwaysOnTop = false;
	private alwaysOnTopPending = false;

	private globalDismissListenerActive = false;

	private tabColors: Record<string, string> = {};
	private tabPins: Record<string, boolean> = {};
	private tabOrder: string[] = [];
	private contextTabKey: string | null = null;
	private contextX = 0;
	private contextY = 0;
	private overflowMeasureFrame: number | null = null;
	private pendingDragTabKey: string | null = null;
	private pendingDragPointerId: number | null = null;
	private dragStartX = 0;
	private dragCurrentX = 0;
	private dragGrabOffsetX = 0;
	private draggingTabKey: string | null = null;
	private dragGhostWidth = 0;
	private previewTabs: MainContentTab[] | null = null;
	private suppressClickTabKey: string | null = null;
	private suppressClickUntil = 0;

	private readonly onWindowPointerDown = (event: PointerEvent) => {
		if (!this.contextTabKey) return;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest(".content-tab-context-menu")) return;
		this.closeContext();
	};

	private readonly onWindowPointerMove = (event: PointerEvent) => {
		if (event.pointerId !== this.pendingDragPointerId) return;
		if (!this.pendingDragTabKey) return;

		const deltaX = event.clientX - this.dragStartX;
		if (!this.draggingTabKey) {
			if (Math.abs(deltaX) < DRAG_START_THRESHOLD_PX) return;
			this.activateTabDrag(this.pendingDragTabKey);
		}

		this.dragCurrentX = event.clientX;
		this.updatePreviewOrderFromPointer();
		this.render();
	};

	private readonly onWindowPointerUp = (event: PointerEvent) => {
		if (event.pointerId !== this.pendingDragPointerId) return;
		this.finishTabPointerInteraction();
	};

	constructor(container: HTMLElement) {
		this.container = container;
		this.loadTabColors();
		this.loadTabLayout();
		this.render();
		void this.syncAlwaysOnTopState();
	}

	setTabs(tabs: MainContentTab[], activeId: string | null): void {
		this.tabs = this.applyStoredLayoutToTabs(tabs);
		this.activeId = activeId;

		if (this.contextTabKey && !this.tabs.some((tab) => this.tabKey(tab) === this.contextTabKey)) {
			this.contextTabKey = null;
		}

		if (this.draggingTabKey && !this.tabs.some((tab) => this.tabKey(tab) === this.draggingTabKey)) {
			this.clearDragState();
		}

		this.syncGlobalDismissListener();
		this.render();
	}

	setOnSelect(cb: (id: string) => void): void {
		this.onSelect = cb;
	}

	setOnClose(cb: (id: string) => void): void {
		this.onClose = cb;
	}

	setOnRename(cb: (id: string, title: string) => void): void {
		this.onRename = cb;
	}

	/** 当前任务标题的原地重命名回调；由 main.ts 负责持久化到会话。 */
	setOnTitleRename(cb: (title: string) => boolean | Promise<boolean>): void {
		this.onTitleRename = cb;
	}

	setOnOpenTerminal(cb: () => void): void {
		this.onOpenTerminal = cb;
	}

	setOnCreateTab(cb: () => void): void {
		this.onCreateTab = cb;
	}

	setTerminalActive(active: boolean): void {
		if (this.terminalActive === active) return;
		this.terminalActive = active;
		this.render();
	}

	setCurrentTaskTitle(title: string): void {
		const normalized = title.trim();
		if (this.currentTaskTitle === normalized) return;
		this.currentTaskTitle = normalized;
		if (!this.editingTaskTitle) {
			this.taskTitleDraft = normalized;
		}
		this.render();
	}

	/**
	 * 收起态：隐藏 fork 标签，只保留固定的当前任务标题。
	 * 标签数据照常维护，恢复显示时无需重建状态。
	 */
	setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) return;
		this.collapsed = collapsed;
		if (collapsed) {
			this.closeContext(false);
			this.clearDragState(false);
		}
		this.render();
	}

	private syncGlobalDismissListener(): void {
		const shouldListen = this.contextTabKey !== null;
		if (shouldListen && !this.globalDismissListenerActive) {
			window.addEventListener("pointerdown", this.onWindowPointerDown, true);
			this.globalDismissListenerActive = true;
			return;
		}
		if (!shouldListen && this.globalDismissListenerActive) {
			window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
			this.globalDismissListenerActive = false;
		}
	}

	private tabKey(tab: MainContentTab): string {
		return `${tab.type}:${tab.id}`;
	}

	private isTabPinned(tab: MainContentTab): boolean {
		const key = this.tabKey(tab);
		if (Object.prototype.hasOwnProperty.call(this.tabPins, key)) {
			return Boolean(this.tabPins[key]);
		}
		return Boolean(tab.pinned);
	}

	private applyStoredLayoutToTabs(tabs: MainContentTab[]): MainContentTab[] {
		const withPins = tabs.map((tab) => {
			const key = this.tabKey(tab);
			const storedPinned = Object.prototype.hasOwnProperty.call(this.tabPins, key)
				? Boolean(this.tabPins[key])
				: Boolean(tab.pinned);
			return { ...tab, pinned: storedPinned };
		});

		const sorted = this.sortTabsByPinnedOrder(withPins);
		const keys = sorted.map((tab) => this.tabKey(tab));
		const nextOrder = [
			...this.tabOrder.filter((key) => keys.includes(key)),
			...keys.filter((key) => !this.tabOrder.includes(key)),
		];

		if (nextOrder.join("|") !== this.tabOrder.join("|")) {
			this.tabOrder = nextOrder;
			this.persistTabLayout();
		}

		return sorted;
	}

	private sortTabsByPinnedOrder(tabs: MainContentTab[]): MainContentTab[] {
		const order = new Map<string, number>();
		this.tabOrder.forEach((key, index) => order.set(key, index));
		const ranked = tabs.map((tab, index) => ({ tab, index, key: this.tabKey(tab), pinned: this.isTabPinned(tab) }));
		const sorter = (a: typeof ranked[number], b: typeof ranked[number]) => {
			const aOrder = order.get(a.key);
			const bOrder = order.get(b.key);
			if (typeof aOrder === "number" && typeof bOrder === "number") return aOrder - bOrder;
			if (typeof aOrder === "number") return -1;
			if (typeof bOrder === "number") return 1;
			return a.index - b.index;
		};

		const pinned = ranked.filter((entry) => entry.pinned).sort(sorter).map((entry) => entry.tab);
		const unpinned = ranked.filter((entry) => !entry.pinned).sort(sorter).map((entry) => entry.tab);
		return [...pinned, ...unpinned];
	}

	private loadTabColors(): void {
		try {
			const raw = localStorage.getItem(TAB_COLORS_STORAGE_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw) as Record<string, string>;
			if (parsed && typeof parsed === "object") {
				this.tabColors = parsed;
			}
		} catch {
			this.tabColors = {};
		}
	}

	private persistTabColors(): void {
		try {
			localStorage.setItem(TAB_COLORS_STORAGE_KEY, JSON.stringify(this.tabColors));
		} catch {
			// ignore
		}
	}

	private loadTabLayout(): void {
		try {
			const raw = localStorage.getItem(TAB_LAYOUT_STORAGE_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw) as Partial<TabLayoutState>;
			if (parsed && typeof parsed === "object") {
				if (parsed.pins && typeof parsed.pins === "object") {
					this.tabPins = Object.fromEntries(
						Object.entries(parsed.pins).map(([key, value]) => [key, Boolean(value)]),
					);
				}
				if (Array.isArray(parsed.order)) {
					this.tabOrder = parsed.order.filter((value): value is string => typeof value === "string");
				}
			}
		} catch {
			this.tabPins = {};
			this.tabOrder = [];
		}
	}

	private persistTabLayout(): void {
		try {
			const payload: TabLayoutState = {
				pins: this.tabPins,
				order: this.tabOrder,
			};
			localStorage.setItem(TAB_LAYOUT_STORAGE_KEY, JSON.stringify(payload));
		} catch {
			// ignore
		}
	}

	private openContext(tab: MainContentTab, e: MouseEvent): void {
		e.preventDefault();
		this.contextTabKey = this.tabKey(tab);
		const menuWidth = 252;
		const menuHeight = 188;
		const pad = 10;
		this.contextX = Math.min(Math.max(pad, e.clientX + 6), Math.max(pad, window.innerWidth - menuWidth - pad));
		this.contextY = Math.min(Math.max(pad, e.clientY + 6), Math.max(pad, window.innerHeight - menuHeight - pad));
		this.syncGlobalDismissListener();
		this.render();
	}

	private closeContext(shouldRender = true): void {
		if (!this.contextTabKey) return;
		this.contextTabKey = null;
		this.syncGlobalDismissListener();
		if (shouldRender) this.render();
	}

	private getContextTab(): MainContentTab | null {
		if (!this.contextTabKey) return null;
		return this.tabs.find((tab) => this.tabKey(tab) === this.contextTabKey) ?? null;
	}

	private async renameContextTab(): Promise<void> {
		const tab = this.getContextTab();
		if (!tab) {
			this.closeContext();
			return;
		}
		const next = (await promptDialog({ title: t("panels.contentTabs.renamePrompt"), value: tab.title }))?.trim();
		if (!next || next === tab.title) {
			this.closeContext();
			return;
		}
		this.onRename?.(tab.id, next);
		this.closeContext();
	}

	private closeContextTab(): void {
		const tab = this.getContextTab();
		if (!tab) {
			this.closeContext();
			return;
		}
		if (tab.closable) {
			this.onClose?.(tab.id);
		}
		this.closeContext();
	}

	private toggleContextTabPinned(): void {
		const tab = this.getContextTab();
		if (!tab) {
			this.closeContext();
			return;
		}
		const key = this.tabKey(tab);
		const nextPinned = !this.isTabPinned(tab);
		if (nextPinned) {
			this.tabPins[key] = true;
		} else {
			delete this.tabPins[key];
		}

		this.tabs = this.applyStoredLayoutToTabs(
			this.tabs.map((entry) => this.tabKey(entry) === key ? { ...entry, pinned: nextPinned } : entry),
		);
		this.persistTabLayout();
		this.closeContext();
	}

	private setTabColor(tabKey: string, color: string | null): void {
		if (!color) {
			delete this.tabColors[tabKey];
		} else {
			this.tabColors[tabKey] = color;
		}
		this.persistTabColors();
		this.closeContext();
	}

	private getColorLabel(id: string): string {
		switch (id) {
			case "red":
				return t("panels.contentTabs.colors.red");
			case "green":
				return t("panels.contentTabs.colors.green");
			case "yellow":
				return t("panels.contentTabs.colors.yellow");
			case "blue":
				return t("panels.contentTabs.colors.blue");
			case "purple":
				return t("panels.contentTabs.colors.purple");
			case "teal":
				return t("panels.contentTabs.colors.teal");
			default:
				return id;
		}
	}

	private clearDragState(shouldRender = false): void {
		this.pendingDragTabKey = null;
		this.pendingDragPointerId = null;
		this.dragStartX = 0;
		this.dragCurrentX = 0;
		this.dragGrabOffsetX = 0;
		this.draggingTabKey = null;
		this.dragGhostWidth = 0;
		this.previewTabs = null;
		window.removeEventListener("pointermove", this.onWindowPointerMove, true);
		window.removeEventListener("pointerup", this.onWindowPointerUp, true);
		if (shouldRender) this.render();
	}

	private beginTabPointerInteraction(tab: MainContentTab, event: PointerEvent): void {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest(".content-tab-close")) return;
		if (target?.closest("input")) return;

		const key = this.tabKey(tab);
		const element = (event.currentTarget as HTMLElement | null) ?? this.container.querySelector<HTMLElement>(`.content-tab[data-tab-key="${key}"]`);
		const rect = element?.getBoundingClientRect();

		this.pendingDragTabKey = key;
		this.pendingDragPointerId = event.pointerId;
		this.dragStartX = event.clientX;
		this.dragCurrentX = event.clientX;
		this.dragGrabOffsetX = rect ? event.clientX - rect.left : 0;
		window.addEventListener("pointermove", this.onWindowPointerMove, true);
		window.addEventListener("pointerup", this.onWindowPointerUp, true);
	}

	private activateTabDrag(tabKey: string): void {
		const tab = this.tabs.find((entry) => this.tabKey(entry) === tabKey) ?? null;
		if (!tab) return;
		const element = this.container.querySelector<HTMLElement>(`.content-tab[data-tab-key="${tabKey}"]`);
		const rect = element?.getBoundingClientRect();
		this.draggingTabKey = tabKey;
		this.dragGhostWidth = rect?.width ?? 110;
		this.previewTabs = [...this.tabs];
		this.closeContext(false);
	}

	private updatePreviewOrderFromPointer(): void {
		const draggedKey = this.draggingTabKey;
		const previewTabs = this.previewTabs;
		if (!draggedKey || !previewTabs) return;

		const draggedTab = previewTabs.find((tab) => this.tabKey(tab) === draggedKey);
		if (!draggedTab) return;

		const draggedPinned = this.isTabPinned(draggedTab);
		const sameGroupTabs = previewTabs.filter((tab) => this.isTabPinned(tab) === draggedPinned);
		const otherTabs = sameGroupTabs.filter((tab) => this.tabKey(tab) !== draggedKey);

		let insertIndex = 0;
		for (const tab of otherTabs) {
			const key = this.tabKey(tab);
			const element = this.container.querySelector<HTMLElement>(`.content-tab[data-tab-key="${key}"]`);
			const rect = element?.getBoundingClientRect();
			if (!rect) continue;
			const centerX = rect.left + rect.width / 2;
			if (this.dragCurrentX > centerX) {
				insertIndex += 1;
			}
		}

		const reorderedGroup = [...otherTabs];
		reorderedGroup.splice(insertIndex, 0, draggedTab);
		const pinnedGroup = draggedPinned ? reorderedGroup : previewTabs.filter((tab) => this.isTabPinned(tab));
		const unpinnedGroup = draggedPinned ? previewTabs.filter((tab) => !this.isTabPinned(tab)) : reorderedGroup;
		const nextPreviewTabs = [...pinnedGroup, ...unpinnedGroup];

		const currentIds = previewTabs.map((tab) => this.tabKey(tab)).join("|");
		const nextIds = nextPreviewTabs.map((tab) => this.tabKey(tab)).join("|");
		if (currentIds !== nextIds) {
			this.previewTabs = nextPreviewTabs;
		}
	}

	private finishTabPointerInteraction(): void {
		const draggingKey = this.draggingTabKey;
		const previewTabs = this.previewTabs;
		const initialIds = this.tabs.map((tab) => this.tabKey(tab)).join("|");
		const finalIds = previewTabs?.map((tab) => this.tabKey(tab)).join("|") ?? initialIds;
		const orderChanged = Boolean(draggingKey && previewTabs && finalIds !== initialIds);

		this.clearDragState(false);
		if (draggingKey) {
			this.suppressClickTabKey = draggingKey;
			this.suppressClickUntil = Date.now() + 250;
		}

		if (orderChanged && previewTabs) {
			this.tabs = [...previewTabs];
			this.tabOrder = previewTabs.map((tab) => this.tabKey(tab));
			this.persistTabLayout();
		}

		this.render();
	}

	private shouldSuppressTabClick(tab: MainContentTab): boolean {
		const key = this.tabKey(tab);
		if (this.suppressClickTabKey !== key) return false;
		if (Date.now() > this.suppressClickUntil) {
			this.suppressClickTabKey = null;
			this.suppressClickUntil = 0;
			return false;
		}
		this.suppressClickTabKey = null;
		this.suppressClickUntil = 0;
		return true;
	}

	private getRenderedTabs(): MainContentTab[] {
		return this.previewTabs ?? this.tabs;
	}

	private getDragGhostLeft(): number {
		const scroll = this.container.querySelector<HTMLElement>(".content-tabs-scroll");
		if (!scroll) return 0;
		const rect = scroll.getBoundingClientRect();
		return this.dragCurrentX - this.dragGrabOffsetX - rect.left + scroll.scrollLeft;
	}

	private scheduleOverflowMeasurement(): void {
		if (this.overflowMeasureFrame !== null) {
			cancelAnimationFrame(this.overflowMeasureFrame);
		}
		this.overflowMeasureFrame = requestAnimationFrame(() => {
			this.overflowMeasureFrame = null;
			const titleEls = this.container.querySelectorAll<HTMLElement>(".content-tab-title");
			titleEls.forEach((titleEl) => {
				const overflowing = titleEl.scrollWidth > titleEl.clientWidth + 1;
				titleEl.classList.toggle("overflowing", overflowing);
			});
		});
	}

	private renderForkBadge(): ReturnType<typeof html> {
		return html`<span class="content-tab-fork-badge" title=${t("panels.contentTabs.forkTab")} aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.3"></circle><circle cx="12" cy="3.5" r="1.3"></circle><circle cx="8" cy="12.5" r="1.3"></circle><path d="M4 4.8v1.4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4.8"></path><path d="M8 8.2v3"></path></svg></span>`;
	}

	private async syncAlwaysOnTopState(): Promise<void> {
		try {
			this.alwaysOnTop = await getCurrentWindow().isAlwaysOnTop();
			this.render();
		} catch {
			// Browser preview and runtimes without window permission keep the toggle off.
		}
	}

	private async toggleAlwaysOnTop(): Promise<void> {
		if (this.alwaysOnTopPending) return;
		const next = !this.alwaysOnTop;
		this.alwaysOnTopPending = true;
		this.render();
		try {
			await getCurrentWindow().setAlwaysOnTop(next);
			this.alwaysOnTop = await getCurrentWindow().isAlwaysOnTop();
		} catch {
			this.alwaysOnTop = !next;
		} finally {
			this.alwaysOnTopPending = false;
			this.render();
		}
	}

	private startTaskTitleEditing(): void {
		if (!this.currentTaskTitle) return;
		this.taskTitleDraft = this.currentTaskTitle;
		this.editingTaskTitle = true;
		this.taskTitleComposing = false;
		this.render();
		requestAnimationFrame(() => {
			const input = this.container.querySelector<HTMLInputElement>(".content-task-title-input");
			input?.focus();
			input?.select();
		});
	}

	private commitTaskTitleEditing(): void {
		if (!this.editingTaskTitle) return;
		const nextTitle = this.taskTitleDraft.trim();
		const previousTitle = this.currentTaskTitle;
		this.editingTaskTitle = false;
		this.taskTitleComposing = false;
		this.taskTitleDraft = nextTitle || previousTitle;
		if (nextTitle && nextTitle !== previousTitle) {
			const generation = ++this.taskTitleRenameGeneration;
			this.currentTaskTitle = nextTitle;
			const persistRename = this.onTitleRename;
			if (persistRename) {
				void Promise.resolve(persistRename(nextTitle))
					.then((saved) => {
						if (!shouldRestoreInlineTitleRename(saved, generation, this.taskTitleRenameGeneration)) return;
						this.currentTaskTitle = previousTitle;
						this.taskTitleDraft = previousTitle;
						this.render();
					})
					.catch(() => {
						if (!shouldRestoreInlineTitleRename(false, generation, this.taskTitleRenameGeneration)) return;
						this.currentTaskTitle = previousTitle;
						this.taskTitleDraft = previousTitle;
						this.render();
					});
			}
		}
		this.render();
	}

	private cancelTaskTitleEditing(): void {
		if (!this.editingTaskTitle) return;
		this.editingTaskTitle = false;
		this.taskTitleComposing = false;
		this.taskTitleDraft = this.currentTaskTitle;
		this.render();
	}

	private renderTaskHeader(): ReturnType<typeof html> {
		return html`
			<div
				class="content-task-header ${this.editingTaskTitle ? "is-editing" : ""}"
				data-tauri-drag-region
				title=${this.editingTaskTitle ? nothing : t("panels.contentTabs.renameTaskHint")}
				@dblclick=${(event: MouseEvent) => {
					event.preventDefault();
					event.stopPropagation();
					this.startTaskTitleEditing();
				}}
			>
				<span class="content-task-icon" aria-hidden="true" data-tauri-drag-region>
					<svg viewBox="0 0 16 16">
						<path d="M2.5 4.4h4l1.2 1.4h5.8v6.7h-11z"></path>
						<path d="M2.5 5.8V3.5h3.7l1.2 1.3"></path>
					</svg>
				</span>
				${this.editingTaskTitle
					? html`
						<input
							class="content-task-title-input"
							.value=${this.taskTitleDraft}
							aria-label=${t("panels.contentTabs.renameTask")}
							@input=${(event: Event) => {
								this.taskTitleDraft = (event.currentTarget as HTMLInputElement).value;
							}}
							@compositionstart=${() => {
								this.taskTitleComposing = true;
							}}
							@compositionend=${() => {
								this.taskTitleComposing = false;
							}}
							@keydown=${(event: KeyboardEvent) => {
								const action = resolveInlineTitleKeyAction(
									event.key,
									event.isComposing,
									this.taskTitleComposing,
								);
								if (action === "cancel") {
									event.preventDefault();
									event.stopPropagation();
									this.cancelTaskTitleEditing();
									return;
								}
								if (action !== "commit") return;
								event.preventDefault();
								event.stopPropagation();
								this.commitTaskTitleEditing();
							}}
							@blur=${() => this.commitTaskTitleEditing()}
							@click=${(event: Event) => event.stopPropagation()}
							@dblclick=${(event: Event) => event.stopPropagation()}
						/>
					`
					: html`<span class="content-task-title" data-tauri-drag-region>${this.currentTaskTitle}</span>`}
			</div>
		`;
	}

	private renderTab(tab: MainContentTab, index: number, placeholder = false): ReturnType<typeof html> {
		const key = this.tabKey(tab);
		const color = this.tabColors[key] ?? "";
		const renderedTabs = this.getRenderedTabs();
		const nextTab = renderedTabs[index + 1] ?? null;
		const pinned = this.isTabPinned(tab);
		const pinnedBoundary = Boolean(pinned && (!nextTab || !this.isTabPinned(nextTab)));
		return html`
			<div
				class="content-tab ${this.activeId === tab.id ? "active" : ""} ${color ? "has-color" : ""} ${pinned ? "pinned" : ""} ${pinnedBoundary ? "pinned-boundary" : ""} ${tab.isFork ? "is-fork" : ""} ${placeholder ? "content-tab-placeholder" : ""}"
				style=${color ? `--content-tab-fill: ${color};` : ""}
				data-tab-key=${key}
				@contextmenu=${(e: MouseEvent) => this.openContext(tab, e)}
				@pointerdown=${(event: PointerEvent) => this.beginTabPointerInteraction(tab, event)}
			>
				${placeholder
					? html`<div class="content-tab-main content-tab-main-placeholder"></div>`
					: html`
						<button class="content-tab-main" @click=${() => {
							if (this.shouldSuppressTabClick(tab)) return;
							this.onSelect?.(tab.id);
						}} title=${tab.path || tab.title}>
							${tab.isFork ? this.renderForkBadge() : nothing}
							<span class="content-tab-title-wrap">
								<span class="content-tab-title ${tab.needsAttention ? "needs-attention" : ""}">${tab.title}</span>
							</span>
						</button>
						${tab.closable
							? html`<button class="content-tab-close" @click=${(event: Event) => {
								event.stopPropagation();
								this.onClose?.(tab.id);
							}} title=${t("panels.contentTabs.closeTab")}>✕</button>`
							: nothing}
					`}
			</div>
		`;
	}

	render(): void {
		const menuOpen = this.contextTabKey !== null;
		const contextTab = this.getContextTab();
		const renderedTabs = this.getRenderedTabs();
		const draggingTab = this.tabs.find((tab) => this.tabKey(tab) === this.draggingTabKey) ?? null;
		const dragGhostLeft = this.draggingTabKey ? this.getDragGhostLeft() : 0;

		const template = html`
			<div
				class="content-tabs-root ${this.collapsed ? "task-only" : ""} ${this.draggingTabKey ? "is-dragging" : ""}"
				data-tauri-drag-region
				@click=${(e: Event) => {
					if (!menuOpen) return;
					const target = e.target instanceof Element ? e.target : null;
					if (target?.closest(".content-tab-context-menu")) return;
					this.closeContext();
				}}
			>
				${this.renderTaskHeader()}
				${this.collapsed
					? nothing
					: html`
						<div class="content-tabs-scroll" data-tauri-drag-region>
							${renderedTabs.map((tab, index) => this.renderTab(tab, index, this.draggingTabKey === this.tabKey(tab)))}
							<button
								class="content-tabs-add-btn content-tab-add-inline"
								title=${t("panels.contentTabs.newTab")}
								@click=${(event: Event) => {
									event.stopPropagation();
									this.onCreateTab?.();
								}}
							>
								＋
							</button>
							${draggingTab
								? html`
									<div
										class="content-tab content-tab-drag-ghost ${draggingTab.pinned ? "pinned" : ""} ${draggingTab.needsAttention ? "needs-attention" : ""} ${draggingTab.isFork ? "is-fork" : ""} ${this.activeId === draggingTab.id ? "active" : ""}"
										style=${`left:${dragGhostLeft}px;width:${this.dragGhostWidth}px;${this.tabColors[this.tabKey(draggingTab)] ? `--content-tab-fill:${this.tabColors[this.tabKey(draggingTab)]};` : ""}`}
									>
										<div class="content-tab-main">
											${draggingTab.isFork ? this.renderForkBadge() : nothing}
											<span class="content-tab-title-wrap">
												<span class="content-tab-title ${draggingTab.needsAttention ? "needs-attention" : ""}">${draggingTab.title}</span>
											</span>
										</div>
									</div>
								`
								: nothing}
						</div>

					`}

				<div class="content-tabs-trailing ${this.collapsed ? "task-only" : ""}" data-tauri-drag-region>
					<button
						type="button"
						class="content-tabs-always-on-top-btn ${this.alwaysOnTop ? "active" : ""}"
						title=${this.alwaysOnTop
							? t("panels.contentTabs.alwaysOnTopDisable")
							: t("panels.contentTabs.alwaysOnTopEnable")}
						aria-label=${this.alwaysOnTop
							? t("panels.contentTabs.alwaysOnTopDisable")
							: t("panels.contentTabs.alwaysOnTopEnable")}
						aria-pressed=${this.alwaysOnTop ? "true" : "false"}
						?disabled=${this.alwaysOnTopPending}
						@click=${(event: Event) => {
							event.stopPropagation();
							void this.toggleAlwaysOnTop();
						}}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path d="M5 2.5h6"></path>
							<path d="M6 2.5v3L4.2 8.1h7.6L10 5.5v-3"></path>
							<path d="M8 8.1v5.4"></path>
						</svg>
					</button>
					${this.collapsed
						? nothing
						: html`
							<button
								type="button"
								class="content-tabs-terminal-btn ${this.terminalActive ? "active" : ""}"
								title=${t("panels.contentTabs.openTerminal")}
								@click=${(event: Event) => {
									event.stopPropagation();
									this.onOpenTerminal?.();
								}}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.2h10v9.6H3z"></path><path d="M5.1 6.2l1.9 1.8-1.9 1.8"></path><path d="M8.6 9.8h2.6"></path></svg>
							</button>
						`}
				</div>

				${!this.collapsed && this.contextTabKey
					? html`
						<div class="content-tab-context-menu" style=${`left:${this.contextX}px;top:${this.contextY}px`} @click=${(e: Event) => e.stopPropagation()}>
							<button class="content-tab-context-action" @click=${() => this.toggleContextTabPinned()}>
								${contextTab && this.isTabPinned(contextTab) ? t("panels.contentTabs.unpinTab") : t("panels.contentTabs.pinTab")}
							</button>
							<button class="content-tab-context-action" @click=${() => void this.renameContextTab()}>${t("panels.contentTabs.renameTab")}</button>
							<button class="content-tab-context-action" ?disabled=${!contextTab?.closable} @click=${() => this.closeContextTab()}>${t("panels.contentTabs.closeTab")}</button>
							<div class="content-tab-context-divider"></div>
							<div class="content-tab-context-title">${t("panels.contentTabs.tabColor")}</div>
							<div class="content-tab-context-colors">
								<button class="tab-color-swatch reset" title=${t("panels.contentTabs.colorDefault")} @click=${() => this.setTabColor(this.contextTabKey!, null)}>×</button>
								${COLOR_PRESETS.map(
									(color) => html`
										<button
											class="tab-color-swatch"
											style=${`--swatch:${color.value}`}
											title=${this.getColorLabel(color.id)}
											@click=${() => this.setTabColor(this.contextTabKey!, color.value)}
										></button>
										`,
									)}
								</div>
							</div>
						`
						: nothing}
			</div>
		`;

		render(template, this.container);
		this.scheduleOverflowMeasurement();
	}
}
