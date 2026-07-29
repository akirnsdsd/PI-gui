/**
 * FileViewer - lightweight file surface (view + basic edit + draft create)
 */

import "@mariozechner/mini-lit/dist/CodeBlock.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { invoke } from "@tauri-apps/api/core";
import { html, nothing, render } from "lit";
import { t } from "../i18n/index.js";
import { alertDialog, confirmDialog } from "./app-dialog.js";

type FileViewMode = "rendered" | "raw";

export interface DraftFileCreatedEvent {
	draftId: string;
	filePath: string;
	projectPath: string;
}

const DEFAULT_DRAFT_NAME = t("app.tabs.newFile");
const AUTO_SAVE_DELAY_MS = 200;

function truncatePath(path: string, max = 140): string {
	if (path.length <= max) return path;
	return `…${path.slice(path.length - max + 1)}`;
}

function fileExtension(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const base = normalized.split("/").pop() || normalized;
	const idx = base.lastIndexOf(".");
	if (idx === -1) return "";
	return base.slice(idx + 1).toLowerCase();
}

function pathBaseName(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalized.split("/");
	return parts[parts.length - 1] || normalized;
}

function pathDirName(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const idx = normalized.lastIndexOf("/");
	if (idx === -1) return "";
	if (idx === 0) return "/";
	return normalized.slice(0, idx);
}

function isMarkdownPath(path: string | null): boolean {
	if (!path) return false;
	return ["md", "markdown", "mdown", "mkdn", "mdx"].includes(fileExtension(path));
}

function joinFsPath(base: string, name: string): string {
	const sep = base.includes("\\") ? "\\" : "/";
	const normalizedBase = base.replace(/[\\/]+$/, "");
	return `${normalizedBase}${sep}${name}`;
}

export class FileViewer {
	private container: HTMLElement;
	private filePath: string | null = null;
	private projectPath: string | null = null;
	/** 草稿首次打开时的落盘目录；外层先切项目时仍要把旧草稿保存回原项目。 */
	private draftProjectPath: string | null = null;
	private draftId: string | null = null;
	private draftName = DEFAULT_DRAFT_NAME;

	private content = "";
	private editorText = "";
	private loading = false;
	private saving = false;
	private dirty = false;
	private error = "";
	private viewMode: FileViewMode = "raw";
	private openingExternal = false;
	private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
	private inFlightSave: Promise<string | null> | null = null;
	private inFlightDraftSave: Promise<boolean> | null = null;
	private openGeneration = 0;
	private onDraftFileCreated: ((event: DraftFileCreatedEvent) => void) | null = null;
	private onClose: (() => void) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
		this.render();
	}

	setProjectPath(projectPath: string | null): void {
		if (this.projectPath === projectPath) return;
		this.projectPath = projectPath;
		if (this.draftId) {
			this.render();
		}
	}

	setOnDraftFileCreated(cb: (event: DraftFileCreatedEvent) => void): void {
		this.onDraftFileCreated = cb;
	}

	setOnClose(cb: () => void): void {
		this.onClose = cb;
	}

	async openFile(filePath: string): Promise<boolean> {
		if (this.filePath === filePath && !this.draftId && !this.loading) return true;
		// generation 绑定本次打开目标，异步返回后校验，避免较晚返回的旧请求覆盖新文件状态。
		const generation = ++this.openGeneration;
		this.clearAutoSaveTimer();
		if (!(await this.settlePendingSave(generation))) return false;
		this.filePath = filePath;
		this.draftProjectPath = null;
		this.draftId = null;
		this.draftName = pathBaseName(filePath);
		this.loading = true;
		this.saving = false;
		this.dirty = false;
		this.error = "";
		this.content = "";
		this.editorText = "";
		this.viewMode = isMarkdownPath(filePath) ? "rendered" : "raw";
		this.render();

		const isStale = () => generation !== this.openGeneration || this.filePath !== filePath;
		try {
			const { readTextFile } = await import("@tauri-apps/plugin-fs");
			const text = await readTextFile(filePath);
			if (isStale()) return false;
			if (text.includes("\u0000")) {
				this.error = t("panels.fileViewer.binaryUnsupported");
				this.content = "";
				this.editorText = "";
			} else {
				this.content = text;
				this.editorText = text;
			}
		} catch (err) {
			if (isStale()) return false;
			this.error = err instanceof Error ? err.message : String(err);
			this.content = "";
			this.editorText = "";
		} finally {
			if (!isStale()) {
				this.loading = false;
				this.render();
			}
		}
		return !isStale();
	}

	async openDraft(draftId: string, suggestedName = DEFAULT_DRAFT_NAME): Promise<boolean> {
		// applyWorkspacePane 可能重复打开当前草稿；不能把这种刷新误判为离开并反复弹保存提示。
		if (this.draftId === draftId && this.filePath === null && !this.loading) return true;
		const generation = ++this.openGeneration;
		this.clearAutoSaveTimer();
		// 与 openFile 一致：先等进行中的保存完成并落盘未保存编辑，失败则阻断切换。
		if (!(await this.settlePendingSave(generation))) return false;
		const firstOpen = this.draftId !== draftId || this.filePath !== null;
		this.filePath = null;
		this.loading = false;
		this.saving = false;
		this.error = "";
		this.openingExternal = false;
		this.draftId = draftId;
		this.draftProjectPath = this.projectPath;
		this.draftName = suggestedName.trim() || DEFAULT_DRAFT_NAME;

		if (firstOpen) {
			this.content = "";
			this.editorText = "";
			this.dirty = false;
		}

		if (!isMarkdownPath(this.draftName) && this.viewMode === "rendered") {
			this.viewMode = "raw";
		}

		this.render();
		return true;
	}

	async clear(): Promise<boolean> {
		const generation = ++this.openGeneration;
		this.clearAutoSaveTimer();
		if (!(await this.settlePendingSave(generation))) return false;
		this.resetViewerState();
		return true;
	}

	private resetViewerState(): void {
		this.filePath = null;
		this.draftProjectPath = null;
		this.draftId = null;
		this.draftName = DEFAULT_DRAFT_NAME;
		this.content = "";
		this.editorText = "";
		this.loading = false;
		this.saving = false;
		this.dirty = false;
		this.error = "";
		this.viewMode = "raw";
		this.openingExternal = false;
		this.render();
	}

	private setViewMode(mode: FileViewMode): void {
		if (this.viewMode === mode) return;
		this.viewMode = mode;
		this.render();
	}

	private clearAutoSaveTimer(): void {
		if (!this.autoSaveTimer) return;
		clearTimeout(this.autoSaveTimer);
		this.autoSaveTimer = null;
	}

	private scheduleAutoSave(): void {
		this.clearAutoSaveTimer();
		if (!this.filePath || !this.dirty || this.loading) return;
		this.autoSaveTimer = setTimeout(() => {
			this.autoSaveTimer = null;
			void this.persistOpenedFile({ silent: true });
		}, AUTO_SAVE_DELAY_MS);
	}

	/**
	 * 切换/关闭前收口未保存的编辑：先等待进行中的保存完成，
	 * 再把仍为 dirty 的内容（保存期间的新编辑）落盘。
	 * 返回 false 表示保存失败或被更新的打开操作打断，调用方应中止切换并保留当前编辑状态。
	 */
	private async settlePendingSave(generation: number): Promise<boolean> {
		while (this.inFlightSave) {
			await this.inFlightSave;
			if (generation !== this.openGeneration) return false;
		}
		while (this.inFlightDraftSave) {
			await this.inFlightDraftSave;
			if (generation !== this.openGeneration) return false;
		}
		if (!this.dirty) return true;

		if (this.filePath) {
			const saveError = await this.persistOpenedFile({ silent: true });
			if (generation !== this.openGeneration) return false;
			if (saveError !== null) {
				// 保存失败：阻断切换，保留当前编辑状态。
				await alertDialog(t("panels.fileViewer.saveFailedSwitchBlocked", { message: saveError }), { title: t("common.error") });
				return false;
			}
			return true;
		}

		if (!this.draftId) return true;
		const decision = await this.confirmDirtyDraftExit(generation);
		if (generation !== this.openGeneration || decision === "cancel") return false;
		if (decision === "discard") return true;

		const saved = await this.persistDraftFile();
		if (generation !== this.openGeneration || !saved) return false;
		// 创建文件期间仍允许编辑；若写入快照后又有新内容，再按已打开文件的保存路径收口。
		if (this.filePath && this.dirty) {
			return await this.settlePendingSave(generation);
		}
		return true;
	}

	/**
	 * app-dialog 当前是双按钮组件，因此用两步选择表达完整三态：
	 * 先选择“保存/其他操作”，再选择“放弃/取消”。
	 */
	private async confirmDirtyDraftExit(generation: number): Promise<"save" | "discard" | "cancel"> {
		const save = await confirmDialog({
			title: t("common.unsavedChanges"),
			desc: "要先保存这个新文件吗？",
			confirmLabel: t("common.save"),
			cancelLabel: "其他操作",
		});
		if (generation !== this.openGeneration) return "cancel";
		if (save) return "save";

		const discard = await confirmDialog({
			title: t("common.unsavedChanges"),
			desc: "不保存并放弃这个新文件的内容吗？",
			confirmLabel: "放弃",
			cancelLabel: t("common.cancel"),
			danger: true,
		});
		if (generation !== this.openGeneration) return "cancel";
		return discard ? "discard" : "cancel";
	}

	/** 保存当前打开的文件。返回 null 表示成功（或无需保存），否则返回错误信息。 */
	private async persistOpenedFile(options: { silent?: boolean } = {}): Promise<string | null> {
		if (!this.filePath || !this.dirty || this.loading) return null;
		// 已有保存进行中：等待它完成，而不是把本次调用误判为成功；
		// 保存期间产生的新编辑会让 dirty 保持为 true，随后会再执行一轮保存。
		while (this.inFlightSave) {
			await this.inFlightSave;
		}
		if (!this.filePath || !this.dirty || this.loading) return null;
		// 固定写入目标路径与内容，避免保存期间切换文件后写串。
		const targetPath = this.filePath;
		const textToSave = this.editorText;
		this.saving = true;
		this.render();
		const savePromise = this.writeFileSnapshot(targetPath, textToSave, options);
		this.inFlightSave = savePromise;
		try {
			return await savePromise;
		} finally {
			if (this.inFlightSave === savePromise) {
				this.inFlightSave = null;
			}
		}
	}

	/** 执行一次快照写入；内部捕获所有错误并以返回值上交，永不 reject。 */
	private async writeFileSnapshot(targetPath: string, textToSave: string, options: { silent?: boolean }): Promise<string | null> {
		try {
			const { writeTextFile } = await import("@tauri-apps/plugin-fs");
			await writeTextFile(targetPath, textToSave);
			// 写入完成后核对：只有当前仍打开同一文件时才更新基线内容。
			if (this.filePath === targetPath) {
				this.content = textToSave;
				this.dirty = this.editorText !== this.content;
			}
			return null;
		} catch (err) {
			console.error("Autosave failed:", err);
			const message = err instanceof Error ? err.message : String(err);
			if (!options.silent) {
				await alertDialog(message, { title: t("common.error") });
			}
			return message;
		} finally {
			this.saving = false;
			if (this.filePath && this.dirty) {
				this.scheduleAutoSave();
			}
			this.render();
		}
	}

	private updateEditorText(next: string): void {
		this.editorText = next;
		if (this.filePath) {
			this.dirty = this.editorText !== this.content;
			this.scheduleAutoSave();
		} else {
			this.dirty = this.editorText.length > 0;
		}
		this.render();
	}

	private updateDraftName(next: string): void {
		if (!this.draftId) return;
		this.draftName = next;
		if (!isMarkdownPath(this.draftName) && this.viewMode === "rendered") {
			this.viewMode = "raw";
		}
		this.render();
	}

	private async saveCurrentFile(): Promise<boolean> {
		if (this.loading) return false;

		if (this.filePath) {
			return (await this.persistOpenedFile({ silent: false })) === null;
		}

		return await this.persistDraftFile();
	}

	private async persistDraftFile(): Promise<boolean> {
		if (this.inFlightDraftSave) return await this.inFlightDraftSave;
		if (!this.draftId || this.loading) return false;
		const name = this.draftName.trim();
		if (!name) {
			await alertDialog(t("panels.fileViewer.enterNameFirst"));
			return false;
		}
		if (name.includes("/") || name.includes("\\")) {
			await alertDialog(t("panels.fileViewer.nameWithoutFolders"));
			return false;
		}
		const draftProjectPath = this.draftProjectPath ?? this.projectPath;
		if (!draftProjectPath) {
			await alertDialog(t("panels.fileViewer.selectProjectFirst"));
			return false;
		}

		const draftId = this.draftId;
		const nextPath = joinFsPath(draftProjectPath, name);
		const textToSave = this.editorText;
		this.saving = true;
		this.render();
		const savePromise = (async (): Promise<boolean> => {
			const { exists, writeTextFile } = await import("@tauri-apps/plugin-fs");
			if (await exists(nextPath)) {
				await alertDialog(t("panels.fileViewer.fileExists"));
				return false;
			}
			await writeTextFile(nextPath, textToSave);
			// 只有仍是发起保存的草稿时才提交状态，避免异步完成写串界面。
			if (this.draftId !== draftId || this.filePath !== null) return false;
			this.filePath = nextPath;
			this.draftProjectPath = null;
			this.draftId = null;
			this.content = textToSave;
			this.dirty = this.editorText !== textToSave;
			this.onDraftFileCreated?.({
				draftId,
				filePath: nextPath,
				projectPath: draftProjectPath,
			});
			return true;
		})().catch(async (err) => {
			await alertDialog(err instanceof Error ? err.message : String(err), { title: t("common.error") });
			return false;
		});
		this.inFlightDraftSave = savePromise;
		try {
			return await savePromise;
		} catch (err) {
			// savePromise 已将错误转换为 false；保留兜底防止未来实现意外 reject。
			await alertDialog(err instanceof Error ? err.message : String(err), { title: t("common.error") });
			return false;
		} finally {
			if (this.inFlightDraftSave === savePromise) {
				this.inFlightDraftSave = null;
			}
			this.saving = false;
			if (this.filePath && this.dirty) this.scheduleAutoSave();
			this.render();
		}
	}

	private async requestClose(): Promise<void> {
		const generation = ++this.openGeneration;
		this.clearAutoSaveTimer();
		if (!(await this.settlePendingSave(generation))) return;
		if (generation !== this.openGeneration) return;
		this.resetViewerState();
		this.onClose?.();
	}

	private async openInEditor(): Promise<void> {
		if (!this.filePath || this.openingExternal) return;
		this.openingExternal = true;
		this.render();
		try {
			await invoke("open_path_in_default_app", { path: this.filePath });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await alertDialog(message, { title: t("common.error") });
		} finally {
			this.openingExternal = false;
			this.render();
		}
	}

	render(): void {
		const isDraft = Boolean(this.draftId && !this.filePath);
		const activeNameOrPath = this.filePath ?? this.draftName;
		const markdown = isMarkdownPath(activeNameOrPath);
		const canCreateDraft = Boolean(this.draftId);
		const fileTitle = this.filePath ? pathBaseName(this.filePath) : this.draftName;
		const fileDirectory = this.filePath ? pathDirName(this.filePath) : null;
		const filePathLabel = this.filePath
			? truncatePath(fileDirectory || this.filePath)
			: t("panels.fileViewer.selectFromSidebar");

		const template = html`
			<div class="file-viewer-root">
				<div class="file-viewer-header minimal">
					${isDraft
						? html`
							<input
								class="file-viewer-draft-name"
								.value=${this.draftName}
								placeholder=${t("panels.fileViewer.draftNamePlaceholder")}
								@input=${(e: Event) => this.updateDraftName((e.target as HTMLInputElement).value)}
							/>
						`
						: html`
							<div class="file-viewer-meta">
								<div class="file-viewer-path" title=${fileDirectory || this.filePath || ""}>${filePathLabel}</div>
								<div class="file-viewer-title" title=${fileTitle}>${fileTitle}</div>
							</div>
						`}
					<div class="file-viewer-actions">
						${markdown
							? html`
								<div class="file-viewer-segment" role="tablist" aria-label=${t("panels.fileViewer.markdownViewMode")}>
									<button
										class="file-viewer-segment-btn ${this.viewMode === "rendered" ? "active" : ""}"
										@click=${() => this.setViewMode("rendered")}
									>
										${t("panels.fileViewer.rendered")}
									</button>
									<button
										class="file-viewer-segment-btn ${this.viewMode === "raw" ? "active" : ""}"
										@click=${() => this.setViewMode("raw")}
									>
										${t("panels.fileViewer.raw")}
									</button>
								</div>
							`
							: null}
						${isDraft
							? html`
								<button class="file-viewer-save-btn" ?disabled=${!canCreateDraft || this.saving || this.loading} @click=${() => void this.saveCurrentFile()}>
									${this.saving ? t("panels.fileViewer.creating") : t("panels.fileViewer.createFile")}
								</button>
							`
							: nothing}
						<button class="file-viewer-open-btn" ?disabled=${!this.filePath || this.loading || this.openingExternal} @click=${() => void this.openInEditor()}>
							<span>${t("panels.fileViewer.openInEditor")}</span>
							<svg class="file-viewer-open-icon" viewBox="0 0 16 16" aria-hidden="true">
								<path d="M6 3h7v7"></path>
								<path d="M13 3L4.8 11.2"></path>
							</svg>
						</button>
						<button class="file-viewer-close-btn" title=${t("panels.fileViewer.closePanel")} @click=${() => void this.requestClose()}>✕</button>
					</div>
				</div>
				<div class="file-viewer-body">
					${isDraft
						? html`<div class="file-viewer-draft-hint">${t("panels.fileViewer.draftHintPrefix")}<code>notes.md</code>${t("panels.fileViewer.draftHintOr")}<code>script.js</code>${t("panels.fileViewer.draftHintSuffix")}<strong>${t("panels.fileViewer.createFile")}</strong>${t("panels.fileViewer.draftHintEnd")}</div>`
						: null}
					${this.loading
						? html`
							<div class="ui-skeleton" role="status" aria-label=${t("panels.fileViewer.loading")}>
								<span class="skeleton-bar" style="width:88%"></span>
								<span class="skeleton-bar" style="width:64%"></span>
								<span class="skeleton-bar" style="width:76%"></span>
								<span class="skeleton-bar" style="width:52%"></span>
							</div>
						`
						: this.error
							? html`<div class="file-viewer-empty error">${this.error}</div>`
							: markdown && this.viewMode === "rendered"
								? html`
									<div class="file-viewer-markdown">
										<markdown-block .content=${this.editorText}></markdown-block>
									</div>
								`
								: html`
									<textarea
										class="file-viewer-editor"
										.value=${this.editorText}
										placeholder=${isDraft ? t("panels.fileViewer.contentPlaceholder") : ""}
										@input=${(e: Event) => this.updateEditorText((e.target as HTMLTextAreaElement).value)}
									></textarea>
								`}
					${this.filePath && this.saving
						? html`<div class="file-viewer-status-row"><span class="file-viewer-status-dirty">${t("panels.fileViewer.saving")}</span></div>`
						: nothing}
				</div>
			</div>
		`;
		render(template, this.container);
	}
}
