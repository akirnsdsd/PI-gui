/**
 * 图片大图查看器（lightbox）：composer 图片缩略图卡与时间线图片消息共用。
 *
 * 用法（app 级单例，重复打开会替换当前内容）：
 *   openImageLightbox(images, startIndex);
 *
 * 交互：Esc / 点击遮罩关闭；多图支持左右箭头按钮与 ←/→ 键切换；
 * 底部缩放控件（- 百分比 +，25%–400%，点击百分比复位 100%），滚轮缩放；
 * 顶部右侧「下载」走 Tauri 保存对话框写本地。样式见 app.css 的 .image-lightbox-*，
 * 遮罩体系对齐 .app-dialog-backdrop。
 */

import { html, nothing, render } from "lit";
import { t } from "../i18n/index.js";
import { base64FromDataUrl, base64ToBytes } from "./chat-view/image-file-utils.js";

export interface LightboxImageSource {
	/** 展示名（也作为下载默认文件名）。 */
	name: string;
	/** 预览地址，通常是 data URL。 */
	src: string;
	/** 原始文件路径（仅用于提示，可为空）。 */
	path?: string;
	mimeType?: string;
	/** base64 原图数据（下载用）；缺省时从 data URL 解析。 */
	data?: string;
}

const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
const ZOOM_STEP = 25;

interface ActiveLightbox {
	images: LightboxImageSource[];
	index: number;
	/** 缩放百分比，100 = 自适应铺满。 */
	zoom: number;
	restoreFocus: HTMLElement | null;
	toast: string | null;
	toastSeq: number;
}

let active: ActiveLightbox | null = null;
let portalHost: HTMLElement | null = null;
let keyListenerAttached = false;

function ensurePortalHost(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	if (portalHost && document.body.contains(portalHost)) return portalHost;
	const host = document.createElement("div");
	host.className = "image-lightbox-portal-host";
	document.body.appendChild(host);
	portalHost = host;
	return host;
}

function clampZoom(value: number): number {
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));
}

function imageExtension(image: LightboxImageSource): string {
	const match = /\.([a-z0-9]{1,5})$/i.exec(image.name.trim());
	if (match && match[1]) return match[1].toLowerCase();
	const mime = (image.mimeType || "").toLowerCase();
	const fromMime = /^image\/([a-z0-9+]+)$/.exec(mime);
	if (fromMime && fromMime[1]) {
		const sub = fromMime[1] === "jpeg" ? "jpg" : fromMime[1].replace("+xml", "");
		return sub || "png";
	}
	return "png";
}

function downloadFileName(image: LightboxImageSource): string {
	const base = image.name.trim() || t("lightbox.title");
	const ext = imageExtension(image);
	return new RegExp(`\\.${ext}$`, "i").test(base) ? base : `${base}.${ext}`;
}

function showToast(text: string): void {
	if (!active) return;
	const seq = ++active.toastSeq;
	active.toast = text;
	renderLightbox();
	setTimeout(() => {
		if (!active || active.toastSeq !== seq) return;
		active.toast = null;
		renderLightbox();
	}, 2600);
}

async function downloadActiveImage(): Promise<void> {
	if (!active) return;
	const image = active.images[active.index];
	if (!image) return;
	const base64 = image.data ?? base64FromDataUrl(image.src);
	if (!base64) {
		showToast(t("lightbox.saveFailed"));
		return;
	}
	try {
		const { save } = await import("@tauri-apps/plugin-dialog");
		const ext = imageExtension(image);
		const target = await save({
			title: t("lightbox.download"),
			defaultPath: downloadFileName(image),
			filters: [{ name: t("lightbox.imageFilter"), extensions: [ext] }],
		});
		if (!active) return;
		if (typeof target !== "string" || target.trim().length === 0) {
			showToast(t("lightbox.saveCancelled"));
			return;
		}
		const { writeFile } = await import("@tauri-apps/plugin-fs");
		await writeFile(target, base64ToBytes(base64));
		showToast(t("lightbox.savedTo", { path: target }));
	} catch (err) {
		console.error("Failed to save lightbox image:", err);
		if (active) showToast(t("lightbox.saveFailed"));
	}
}

function setIndex(next: number): void {
	if (!active || active.images.length === 0) return;
	const total = active.images.length;
	active.index = ((next % total) + total) % total;
	active.zoom = 100;
	renderLightbox();
}

function setZoom(next: number): void {
	if (!active) return;
	const clamped = clampZoom(next);
	if (clamped === active.zoom) return;
	active.zoom = clamped;
	renderLightbox();
}

function handleGlobalKeydown(event: KeyboardEvent): void {
	if (!active) return;
	// IME 组词中的按键不触发快捷操作（与 app-dialog 一致）。
	if (event.isComposing || event.keyCode === 229) return;
	switch (event.key) {
		case "Escape":
			event.preventDefault();
			event.stopPropagation();
			closeImageLightbox();
			return;
		case "ArrowLeft":
			if (active.images.length > 1) {
				event.preventDefault();
				event.stopPropagation();
				setIndex(active.index - 1);
			}
			return;
		case "ArrowRight":
			if (active.images.length > 1) {
				event.preventDefault();
				event.stopPropagation();
				setIndex(active.index + 1);
			}
			return;
		case "-":
			event.preventDefault();
			event.stopPropagation();
			setZoom(active.zoom - ZOOM_STEP);
			return;
		case "+":
		case "=":
			event.preventDefault();
			event.stopPropagation();
			setZoom(active.zoom + ZOOM_STEP);
			return;
		case "0":
			event.preventDefault();
			event.stopPropagation();
			setZoom(100);
			return;
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

function lightboxButtonIcon(name: "download" | "close" | "prev" | "next" | "minus" | "plus") {
	switch (name) {
		case "download":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.8v7"></path><path d="M5 7.2l3 3 3-3"></path><path d="M3.2 13.2h9.6"></path></svg>`;
		case "close":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8"></path><path d="M12 4l-8 8"></path></svg>`;
		case "prev":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.2L5.2 8 10 12.8"></path></svg>`;
		case "next":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.2L10.8 8 6 12.8"></path></svg>`;
		case "minus":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"></path></svg>`;
		case "plus":
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9"></path><path d="M3.5 8h9"></path></svg>`;
	}
}

function renderLightbox(): void {
	const host = ensurePortalHost();
	if (!host) return;
	if (!active) {
		render(nothing, host);
		return;
	}
	const state = active;
	const image = state.images[state.index];
	if (!image) {
		render(nothing, host);
		return;
	}
	const total = state.images.length;
	const stop = (event: Event) => event.stopPropagation();
	render(
		html`
			<div
				class="image-lightbox-backdrop"
				role="dialog"
				aria-modal="true"
				aria-label=${t("lightbox.title")}
				@click=${() => closeImageLightbox()}
				@wheel=${(event: WheelEvent) => {
					event.preventDefault();
					setZoom(state.zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
				}}
			>
				<div class="image-lightbox-topbar" @click=${stop}>
					<div class="image-lightbox-name" title=${image.path || image.name}>
						${image.name}${total > 1 ? html`<span class="image-lightbox-counter">${t("lightbox.counter", { index: state.index + 1, total })}</span>` : nothing}
					</div>
					<div class="image-lightbox-actions">
						<button type="button" class="image-lightbox-btn" @click=${() => void downloadActiveImage()}>
							${lightboxButtonIcon("download")}<span>${t("lightbox.download")}</span>
						</button>
						<button type="button" class="image-lightbox-btn icon" title=${t("lightbox.close")} @click=${() => closeImageLightbox()}>
							${lightboxButtonIcon("close")}
						</button>
					</div>
				</div>
				${total > 1
					? html`
						<button type="button" class="image-lightbox-nav prev" title=${t("lightbox.prev")} @click=${(event: Event) => { event.stopPropagation(); setIndex(state.index - 1); }}>
							${lightboxButtonIcon("prev")}
						</button>
						<button type="button" class="image-lightbox-nav next" title=${t("lightbox.next")} @click=${(event: Event) => { event.stopPropagation(); setIndex(state.index + 1); }}>
							${lightboxButtonIcon("next")}
						</button>
					`
					: nothing}
				<div class="image-lightbox-stage">
					<img
						class="image-lightbox-image"
						src=${image.src}
						alt=${image.name}
						draggable="false"
						style=${`transform: scale(${state.zoom / 100});`}
						@click=${stop}
					/>
				</div>
				<div class="image-lightbox-zoombar" @click=${stop}>
					<button
						type="button"
						class="image-lightbox-zoom-btn"
						title=${t("lightbox.zoomOut")}
						?disabled=${state.zoom <= ZOOM_MIN}
						@click=${() => setZoom(state.zoom - ZOOM_STEP)}
					>
						${lightboxButtonIcon("minus")}
					</button>
					<button type="button" class="image-lightbox-zoom-label" title=${t("lightbox.resetZoom")} @click=${() => setZoom(100)}>${state.zoom}%</button>
					<button
						type="button"
						class="image-lightbox-zoom-btn"
						title=${t("lightbox.zoomIn")}
						?disabled=${state.zoom >= ZOOM_MAX}
						@click=${() => setZoom(state.zoom + ZOOM_STEP)}
					>
						${lightboxButtonIcon("plus")}
					</button>
				</div>
				${state.toast ? html`<div class="image-lightbox-toast" role="status">${state.toast}</div>` : nothing}
			</div>
		`,
		host,
	);
}

/** 打开图片查看器；images 为空时无操作。重复调用会替换当前查看内容。 */
export function openImageLightbox(images: LightboxImageSource[], startIndex = 0): void {
	if (images.length === 0) return;
	attachKeyListener();
	const previousFocus = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
	active = {
		images,
		index: Math.min(Math.max(0, startIndex), images.length - 1),
		zoom: 100,
		restoreFocus: previousFocus,
		toast: null,
		toastSeq: 0,
	};
	renderLightbox();
}

/** 关闭图片查看器并还原焦点。 */
export function closeImageLightbox(): void {
	if (!active) return;
	const current = active;
	active = null;
	detachKeyListener();
	renderLightbox();
	current.restoreFocus?.focus?.();
}

export function isImageLightboxOpen(): boolean {
	return active !== null;
}
