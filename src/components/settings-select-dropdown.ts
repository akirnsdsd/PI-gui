/**
 * 设置页自定义下拉：统一替换设置面板里的原生 <select>。
 *
 * - 触发器外观与原 .settings-select 一致（圆角矩形 + ▾ caret），
 *   通过 triggerClass 可切换大号变体（外观页主题选择）；
 * - 弹层卡片与 composer 弹层同款 chrome（radius 8、1px var(--border)、
 *   0 8px 24px rgba(0,0,0,.12) 阴影），选项行高 28px、hover 灰底、当前项带 ✓；
 * - 弹层 position: fixed —— 设置面板处于 overflow:auto（.settings-view-body）
 *   与 overflow:hidden（.appearance-profile-card 等）的容器里，absolute 会被
 *   裁剪；定位时优先向上弹（bottom 锚定触发器顶），上方空间不足改向下弹
 *   （top 锚定触发器底），两个方向都把 max-height clamp 进视口，
 *   水平方向同样 clamp；
 * - 外点击 / Esc / 面板滚动 / 窗口 resize 关闭；全局同时只开一个。
 *
 * 定位思路参考 chat-view.ts 的 clampUpwardPopover（向上 clamp 可用空间），
 * 这里因 fixed 定位 + 上/下双向，独立实现一份轻量版。
 */

import { html, nothing, type TemplateResult } from "lit";

export interface SettingsSelectOption {
	value: string;
	label: string;
	/** 禁用单个选项（对应原生 <option disabled>）。 */
	disabled?: boolean;
}

export interface SettingsSelectRenderOptions {
	options: SettingsSelectOption[];
	value: string;
	onSelect: (value: string) => void;
	disabled?: boolean;
	/** 弹层 aria-label，复用设置项标题即可。 */
	ariaLabel?: string;
	/** 触发器附加 class（如 "settings-select-trigger-lg" 大号变体）。 */
	triggerClass?: string;
	/** 弹层最小宽度兜底（默认取触发器宽度）。 */
	minPopoverWidth?: number;
}

const VIEWPORT_MARGIN = 8;
/** 弹层与触发器的间距。 */
const TRIGGER_GAP = 4;
const OPTION_ROW_HEIGHT = 28;
/** 弹层上下 padding 之和（4px * 2）。 */
const POPOVER_PADDING = 8;
/** 与 composer 模型弹层一致的偏好最大高度。 */
const MAX_POPOVER_HEIGHT = 244;

let nextInstanceId = 1;
const openInstances = new Set<SettingsSelectDropdown>();

/** 关闭所有设置下拉（panel 关闭/销毁时也可调用）。 */
export function closeAllSettingsSelects(except: SettingsSelectDropdown | null = null): void {
	for (const instance of [...openInstances]) {
		if (instance !== except) instance.close();
	}
}

function onGlobalPointerDown(event: Event): void {
	if (openInstances.size === 0) return;
	const target = event.target;
	if (target instanceof Element && target.closest(".settings-select-root")) return;
	closeAllSettingsSelects();
}

function onGlobalKeydown(event: KeyboardEvent): void {
	if (event.key !== "Escape" || openInstances.size === 0) return;
	event.preventDefault();
	closeAllSettingsSelects();
}

/** 设置面板滚动时收回弹层，避免 fixed 弹层停在错误位置；弹层内部滚动除外。 */
function onGlobalScroll(event: Event): void {
	if (openInstances.size === 0) return;
	const target = event.target;
	if (target instanceof Element && target.closest(".settings-select-root")) return;
	closeAllSettingsSelects();
}

/** 窗口尺寸变化时收回弹层（位置已失效）。 */
function onGlobalViewportChange(): void {
	if (openInstances.size === 0) return;
	closeAllSettingsSelects();
}

let globalListenersBound = false;
function bindGlobalListeners(): void {
	if (globalListenersBound || typeof document === "undefined") return;
	document.addEventListener("pointerdown", onGlobalPointerDown, true);
	document.addEventListener("mousedown", onGlobalPointerDown, true);
	document.addEventListener("keydown", onGlobalKeydown, true);
	// scroll 不冒泡，capture 阶段可以捕获设置面板内部滚动
	document.addEventListener("scroll", onGlobalScroll, true);
	window.addEventListener("resize", onGlobalViewportChange, true);
	globalListenersBound = true;
}

export class SettingsSelectDropdown {
	private readonly instanceId = nextInstanceId++;
	private readonly requestRender: () => void;
	private open = false;
	private optionCount = 0;
	private minPopoverWidth = 0;

	constructor(deps: { requestRender: () => void }) {
		this.requestRender = deps.requestRender;
	}

	isOpen(): boolean {
		return this.open;
	}

	close(): void {
		if (!this.open) return;
		this.open = false;
		openInstances.delete(this);
		this.requestRender();
	}

	private toggle(): void {
		if (this.open) {
			this.close();
			return;
		}
		closeAllSettingsSelects(this);
		this.open = true;
		openInstances.add(this);
		bindGlobalListeners();
		this.requestRender();
		this.clampPopover();
	}

	/**
	 * fixed 定位：量触发器 rect，优先向上（bottom 锚定触发器顶，不遮挡下方
	 * 设置行）；上方空间不足改向下（top 锚定触发器底）；两个方向都把
	 * max-height 压进可用空间，内容超高时弹层内部滚动；水平方向 clamp 在
	 * 视口内。触发器尚未排版（rect 全 0）时下一帧重试一次。
	 */
	private clampPopover(retried = false): void {
		requestAnimationFrame(() => {
			if (!this.open) return;
			const root = document.querySelector<HTMLElement>(`[data-settings-select-root="${this.instanceId}"]`);
			const trigger = root?.querySelector<HTMLElement>(".settings-select-trigger");
			const popover = root?.querySelector<HTMLElement>(".settings-select-popover");
			if (!root || !trigger || !popover) return;
			const rect = trigger.getBoundingClientRect();
			if (rect.top === 0 && rect.height === 0) {
				if (!retried) this.clampPopover(true);
				return;
			}
			const spaceAbove = Math.floor(rect.top - TRIGGER_GAP - VIEWPORT_MARGIN);
			const spaceBelow = Math.floor(window.innerHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN);
			const desired = Math.min(MAX_POPOVER_HEIGHT, this.optionCount * OPTION_ROW_HEIGHT + POPOVER_PADDING);
			// 优先向上；上方放不下完整高度但比下方宽敞时仍向上（靠 max-height 收缩）
			const openUp = spaceAbove >= desired || spaceAbove >= spaceBelow;
			const available = openUp ? spaceAbove : spaceBelow;
			const maxHeight = Math.min(desired, Math.max(available, 0));
			popover.style.maxHeight = `${maxHeight}px`;
			if (openUp) {
				popover.style.top = "auto";
				popover.style.bottom = `${Math.round(window.innerHeight - rect.top + TRIGGER_GAP)}px`;
			} else {
				popover.style.bottom = "auto";
				popover.style.top = `${Math.round(rect.bottom + TRIGGER_GAP)}px`;
			}
			popover.style.minWidth = `${Math.max(Math.floor(rect.width), this.minPopoverWidth)}px`;
			// 水平 clamp：先对齐触发器左缘，再按弹层实际宽度收回视口内
			popover.style.left = `${Math.round(rect.left)}px`;
			const popoverWidth = popover.offsetWidth;
			const clampedLeft = Math.max(
				VIEWPORT_MARGIN,
				Math.min(Math.round(rect.left), window.innerWidth - popoverWidth - VIEWPORT_MARGIN),
			);
			popover.style.left = `${clampedLeft}px`;
		});
	}

	render(options: SettingsSelectRenderOptions): TemplateResult {
		const current = options.options.find((option) => option.value === options.value) ?? null;
		this.optionCount = options.options.length;
		this.minPopoverWidth = options.minPopoverWidth ?? 0;
		const disabled = Boolean(options.disabled) || options.options.length === 0;
		return html`
			<div class="settings-select-root" data-settings-select-root=${this.instanceId}>
				<button
					type="button"
					class="settings-select-trigger ${options.triggerClass ?? ""} ${this.open ? "active" : ""}"
					aria-haspopup="listbox"
					aria-expanded=${this.open ? "true" : "false"}
					?disabled=${disabled}
					@click=${() => {
						if (disabled) return;
						this.toggle();
					}}
				>
					<span class="settings-select-trigger-label">${current?.label ?? options.value}</span>
					<span class="settings-select-caret">▾</span>
				</button>
				${this.open
					? html`
						<div class="settings-select-popover" role="listbox" aria-label=${options.ariaLabel ?? nothing}>
							${options.options.map(
								(option) => html`
									<button
										type="button"
										class="settings-select-option ${option.value === options.value ? "active" : ""}"
										role="option"
										aria-selected=${option.value === options.value ? "true" : "false"}
										?disabled=${Boolean(option.disabled)}
										@click=${() => {
											if (option.disabled) return;
											this.close();
											if (option.value !== options.value) options.onSelect(option.value);
										}}
									>
										<span class="settings-select-option-label">${option.label}</span>
										${option.value === options.value
											? html`<span class="settings-select-option-check">✓</span>`
											: nothing}
									</button>
								`,
							)}
						</div>
					`
					: nothing}
			</div>
		`;
	}
}
