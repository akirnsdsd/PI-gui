/**
 * App 级通用对话框：替代 window.confirm / window.alert / window.prompt
 * （Tauri WebView 不支持这些原生弹窗，且样式无法统一）。
 *
 * 用法（Promise 化，均为 app 级单例，新对话框会取消上一个）：
 *   const ok = await confirmDialog({ title, desc, danger: true });
 *   const name = await promptDialog({ title, value: "old-name" });
 *   await alertDialog(t("..."));
 *
 * 交互：Esc / 点击遮罩取消，Enter 确认；样式见 app.css 的 .app-dialog-*。
 */

import { html, nothing, render } from "lit";
import { t } from "../i18n/index.js";

export interface ConfirmDialogOptions {
	title: string;
	desc?: string;
	/** 确认按钮文案，默认「确认」。 */
	confirmLabel?: string;
	/** 取消按钮文案，默认「取消」。 */
	cancelLabel?: string;
	/** 危险操作：确认按钮红字白底/黑底。 */
	danger?: boolean;
}

export interface PromptDialogOptions extends ConfirmDialogOptions {
	/** 输入框初始值。 */
	value?: string;
	placeholder?: string;
	/** 只读输入（如剪贴板失败后的手动复制），此时只有确认按钮且默认文案为「关闭」。 */
	readonly?: boolean;
}

export interface AlertDialogOptions {
	title?: string;
	danger?: boolean;
	confirmLabel?: string;
}

type DialogResult = boolean | string | null | void;

interface ActiveDialog {
	kind: "confirm" | "prompt" | "alert";
	options: PromptDialogOptions;
	resolve: (value: DialogResult) => void;
	cancelValue: DialogResult;
	inputValue: string;
	restoreFocus: HTMLElement | null;
}

let active: ActiveDialog | null = null;
let portalHost: HTMLElement | null = null;
let keyListenerAttached = false;

function ensurePortalHost(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	if (portalHost && document.body.contains(portalHost)) return portalHost;
	const host = document.createElement("div");
	host.className = "app-dialog-portal-host";
	document.body.appendChild(host);
	portalHost = host;
	return host;
}

function handleGlobalKeydown(event: KeyboardEvent): void {
	if (!active) return;
	// IME 组词中（中文输入选词）的 Enter/Esc 不触发确认/取消。
	if (event.isComposing || event.keyCode === 229) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		settle(active.cancelValue);
		return;
	}
	if (event.key === "Enter") {
		// 焦点在按钮上时走按钮原生点击（取消/确认各自处理）。
		if (event.target instanceof HTMLButtonElement) return;
		event.preventDefault();
		event.stopPropagation();
		settle(active.kind === "prompt" ? active.inputValue : true);
	}
}

function attachKeyListener(): void {
	if (keyListenerAttached || typeof document === "undefined") return;
	document.addEventListener("keydown", handleGlobalKeydown, true);
	keyListenerAttached = true;
}

function detachKeyListener(): void {
	if (!keyListenerAttached || typeof document === "undefined") return;
	document.removeEventListener("keydown", handleGlobalKeydown, true);
	keyListenerAttached = false;
}

function renderActiveDialog(): void {
	const host = ensurePortalHost();
	if (!host) return;
	if (!active) {
		render(nothing, host);
		return;
	}
	const { kind, options } = active;
	const isReadonlyPrompt = kind === "prompt" && options.readonly === true;
	const confirmLabel = options.confirmLabel ?? (isReadonlyPrompt ? t("common.close") : t("common.confirm"));
	render(
		html`
			<div class="app-dialog-backdrop" role="presentation" @click=${() => settle(active?.cancelValue)}>
				<div
					class="app-dialog-card"
					role="dialog"
					aria-modal="true"
					aria-label=${options.title}
					@click=${(event: Event) => event.stopPropagation()}
				>
					<div class="app-dialog-title">${options.title}</div>
					${options.desc ? html`<div class="app-dialog-desc">${options.desc}</div>` : nothing}
					${kind === "prompt"
						? html`
							<input
								class="app-dialog-input"
								type="text"
								.value=${active.inputValue}
								placeholder=${options.placeholder ?? ""}
								?readonly=${isReadonlyPrompt}
								@input=${(event: Event) => {
									if (active) active.inputValue = (event.target as HTMLInputElement).value;
								}}
							/>
						`
						: nothing}
					<div class="app-dialog-actions">
						${kind !== "alert" && !isReadonlyPrompt
							? html`
								<button type="button" class="ghost-btn" @click=${() => settle(active?.cancelValue)}>
									${options.cancelLabel ?? t("common.cancel")}
								</button>
							`
							: nothing}
						<button
							type="button"
							class="app-dialog-confirm ${options.danger ? "danger" : ""}"
							@click=${() => settle(active?.kind === "prompt" ? active.inputValue : true)}
						>
							${confirmLabel}
						</button>
					</div>
				</div>
			</div>
		`,
		host,
	);
	// 初始焦点：prompt 聚焦并选中输入框，其余聚焦确认按钮（Enter 即确认）。
	const input = host.querySelector<HTMLInputElement>(".app-dialog-input");
	if (input) {
		input.focus();
		input.select();
	} else {
		host.querySelector<HTMLButtonElement>(".app-dialog-confirm")?.focus();
	}
}

function settle(value: DialogResult): void {
	const current = active;
	if (!current) return;
	active = null;
	detachKeyListener();
	renderActiveDialog();
	current.restoreFocus?.focus?.();
	current.resolve(value);
}

function openDialog(
	kind: ActiveDialog["kind"],
	options: PromptDialogOptions,
	cancelValue: DialogResult,
): Promise<DialogResult> {
	// 单例：已有对话框时先按取消结算，避免 Promise 悬挂。
	if (active) settle(active.cancelValue);
	attachKeyListener();
	return new Promise<DialogResult>((resolve) => {
		const previousFocus = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
		active = {
			kind,
			options,
			resolve,
			cancelValue,
			inputValue: options.value ?? "",
			restoreFocus: previousFocus,
		};
		renderActiveDialog();
	});
}

/** 确认对话框：确认 resolve true，取消/Esc/点遮罩 resolve false。 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
	return openDialog("confirm", options, false) as Promise<boolean>;
}

/** 输入对话框：确认 resolve 输入值（未 trim），取消 resolve null。 */
export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
	return openDialog("prompt", options, null) as Promise<string | null>;
}

/** 提示对话框：仅一个确认按钮，替代 window.alert。 */
export function alertDialog(message: string, options: AlertDialogOptions = {}): Promise<void> {
	return openDialog(
		"alert",
		{
			title: options.title ?? t("common.notice"),
			desc: message,
			danger: options.danger,
			confirmLabel: options.confirmLabel ?? t("common.ok"),
		},
		undefined,
	) as Promise<void>;
}
