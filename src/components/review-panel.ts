/**
 * W2 Review 面板：git diff 审查抽屉（P0）。
 *
 * 结构：`ReviewPanelStore` 持有全部状态并通过 rpcBridge 调 Rust 侧
 * git_review_* commands；`renderReviewPanelView` 是纯视图函数，
 * 由 ChatView 的主模板内联渲染（与 git-repo-control-view 同一惯例）。
 *
 * P0 范围：两档范围（未暂存/已暂存）、文件级 stage/unstage、
 * untracked 单列、冲突标注、unified diff 内联渲染（>2000 行截断由后端完成）。
 * 列表截断：后端 untracked 最多返回 500 条、其余各区 2000 条，
 * 真实总数走 *_total 字段；刚 git init 且未跟踪文件过多时顶部显示
 * .gitignore 引导提示卡（防止枚举几万个文件把面板卡死）。
 */

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.js";
import {
	rpcBridge,
	type GitReviewStatusResult,
	type ReviewDiffScope,
	type ReviewFileEntry,
} from "../rpc/bridge.js";

const DIFF_MAX_LINES = 2000;
const PANEL_MIN_WIDTH = 320;
const PANEL_DEFAULT_WIDTH = 440;
/** 空仓库（无提交）未跟踪文件超过该数时，顶部显示 .gitignore 引导提示卡。 */
const FRESH_REPO_UNTRACKED_HINT_THRESHOLD = 1000;

interface ReviewDiffViewState {
	key: string;
	loading: boolean;
	patch: string;
	truncated: boolean;
	isBinary: boolean;
	error: string;
}

export class ReviewPanelStore {
	isOpen = false;
	width = PANEL_DEFAULT_WIDTH;
	scope: ReviewDiffScope = "unstaged";
	loading = false;
	error = "";
	/** stage/unstage 失败原因：refresh 不会清除，仅在下一次同类操作成功或用户手动关闭时清除。 */
	actionError = "";
	status: GitReviewStatusResult | null = null;
	diff: ReviewDiffViewState | null = null;
	/** stage/unstage 进行中的路径，用于禁用对应按钮。 */
	busyPaths = new Set<string>();

	private cwd: string | null = null;
	private readonly onChange: () => void;
	private statusSeq = 0;
	private diffSeq = 0;

	constructor(onChange: () => void) {
		this.onChange = onChange;
	}

	setCwd(cwd: string | null): void {
		const next = cwd?.trim() || null;
		if (next === this.cwd) return;
		this.cwd = next;
		this.status = null;
		this.error = "";
		this.actionError = "";
		this.diff = null;
		this.busyPaths.clear();
		// 项目被移除后面板没有可展示的对象，直接关掉。
		if (!next) this.isOpen = false;
		if (this.isOpen) void this.refresh();
	}

	toggle(): void {
		this.isOpen = !this.isOpen;
		if (this.isOpen) void this.refresh();
		this.onChange();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.onChange();
	}

	setScope(scope: ReviewDiffScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.diff = null;
		this.onChange();
	}

	async refresh(): Promise<void> {
		if (!this.cwd) return;
		const seq = ++this.statusSeq;
		this.loading = true;
		this.onChange();
		try {
			const status = await rpcBridge.gitReviewStatus(this.cwd);
			if (seq !== this.statusSeq) return;
			this.status = status;
			this.error = "";
			// 展开中的 diff 在刷新后必然过期，直接收起。
			this.diff = null;
		} catch (err) {
			if (seq !== this.statusSeq) return;
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			if (seq === this.statusSeq) {
				this.loading = false;
				this.onChange();
			}
		}
	}

	refreshIfOpen(): void {
		if (this.isOpen) void this.refresh();
	}

	toggleFile(scope: ReviewDiffScope, entry: ReviewFileEntry): void {
		const key = `${scope}:${entry.path}`;
		if (this.diff?.key === key) {
			this.diff = null;
			this.onChange();
			return;
		}
		void this.loadDiff(key, scope, entry);
	}

	private async loadDiff(key: string, scope: ReviewDiffScope, entry: ReviewFileEntry): Promise<void> {
		if (!this.cwd) return;
		const seq = ++this.diffSeq;
		this.diff = { key, loading: true, patch: "", truncated: false, isBinary: false, error: "" };
		this.onChange();
		try {
			const result = await rpcBridge.gitReviewDiff({
				cwd: this.cwd,
				scope,
				path: entry.path,
				oldPath: entry.old_path,
			});
			if (seq !== this.diffSeq) return;
			this.diff = {
				key,
				loading: false,
				patch: result.patch,
				truncated: result.truncated,
				isBinary: result.is_binary,
				error: "",
			};
		} catch (err) {
			if (seq !== this.diffSeq) return;
			this.diff = {
				key,
				loading: false,
				patch: "",
				truncated: false,
				isBinary: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
		this.onChange();
	}

	async stagePaths(paths: string[]): Promise<void> {
		if (!this.cwd || paths.length === 0) return;
		this.setBusy(paths, true);
		try {
			await rpcBridge.gitReviewStage(this.cwd, paths);
			this.actionError = "";
		} catch (err) {
			this.actionError = err instanceof Error ? err.message : String(err);
		} finally {
			this.setBusy(paths, false);
		}
		await this.refresh();
	}

	async unstagePaths(paths: string[]): Promise<void> {
		if (!this.cwd || paths.length === 0) return;
		this.setBusy(paths, true);
		try {
			await rpcBridge.gitReviewUnstage(this.cwd, paths);
			this.actionError = "";
		} catch (err) {
			this.actionError = err instanceof Error ? err.message : String(err);
		} finally {
			this.setBusy(paths, false);
		}
		await this.refresh();
	}

	/** 手动关闭 stage/unstage 错误提示。 */
	dismissActionError(): void {
		if (!this.actionError) return;
		this.actionError = "";
		this.onChange();
	}

	startResize(event: PointerEvent): void {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = this.width;
		const onMove = (move: PointerEvent) => {
			const maxWidth = Math.max(PANEL_MIN_WIDTH, Math.round(window.innerWidth * 0.7));
			const next = startWidth + (startX - move.clientX);
			this.width = Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, next));
			this.onChange();
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	private setBusy(paths: string[], busy: boolean): void {
		for (const path of paths) {
			if (busy) this.busyPaths.add(path);
			else this.busyPaths.delete(path);
		}
		this.onChange();
	}
}

/* ---------------------------------------------------------------- 视图 */

function statusChipLetter(entry: ReviewFileEntry): string {
	switch (entry.status) {
		case "added":
			return "A";
		case "modified":
			return "M";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		case "typechange":
			return "T";
	}
}

function diffLineClass(line: string): string {
	if (line.startsWith("@@")) return "review-diff-line hunk";
	if (line.startsWith("+")) return "review-diff-line add";
	if (line.startsWith("-")) return "review-diff-line del";
	if (
		line.startsWith("diff --git") ||
		line.startsWith("index ") ||
		line.startsWith("new file") ||
		line.startsWith("deleted file") ||
		line.startsWith("old mode") ||
		line.startsWith("new mode") ||
		line.startsWith("similarity") ||
		line.startsWith("dissimilarity") ||
		line.startsWith("rename ") ||
		line.startsWith("copy ") ||
		line.startsWith("Binary ")
	) {
		return "review-diff-line meta";
	}
	if (line.startsWith("\\")) return "review-diff-line meta";
	return "review-diff-line ctx";
}

function renderDiffLines(patch: string): TemplateResult {
	const lines = patch.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return html`
		<div class="review-diff-body" role="log">
			${lines.map((line) => {
				// CRLF 文件的行尾 \r 去掉再展示，避免等宽对齐被顶歪。
				const display = line.endsWith("\r") ? line.slice(0, -1) : line;
				return html`<div class=${diffLineClass(line)}>${display || " "}</div>`;
			})}
		</div>
	`;
}

function renderDiffView(store: ReviewPanelStore, key: string): TemplateResult | typeof nothing {
	const diff = store.diff;
	if (!diff || diff.key !== key) return nothing;
	if (diff.loading) {
		return html`<div class="review-diff"><div class="review-diff-note ui-loading-host" role="status" aria-label=${t("review.loadingDiff")}><span class="ui-loading-spinner small"></span></div></div>`;
	}
	if (diff.error) {
		return html`<div class="review-diff"><div class="review-diff-note error">${t("review.error", { message: diff.error })}</div></div>`;
	}
	if (diff.isBinary) {
		return html`<div class="review-diff"><div class="review-diff-note">${t("review.binary")}</div></div>`;
	}
	if (!diff.patch.trim()) {
		return html`<div class="review-diff"><div class="review-diff-note">${t("review.noDiff")}</div></div>`;
	}
	return html`
		<div class="review-diff">
			${renderDiffLines(diff.patch)}
			${diff.truncated
				? html`<div class="review-diff-note truncated">${t("review.truncated", { lines: DIFF_MAX_LINES.toLocaleString() })}</div>`
				: nothing}
		</div>
	`;
}

function renderFileRow(
	store: ReviewPanelStore,
	scope: ReviewDiffScope,
	entry: ReviewFileEntry,
): TemplateResult {
	const key = `${scope}:${entry.path}`;
	const expanded = store.diff?.key === key;
	const busy = store.busyPaths.has(entry.path);
	const actionLabel = scope === "staged" ? t("review.actions.unstage") : t("review.actions.stage");
	const onAction =
		scope === "staged" ? () => void store.unstagePaths([entry.path]) : () => void store.stagePaths([entry.path]);
	return html`
		<div class="review-file ${expanded ? "expanded" : ""}">
			<button
				class="review-file-main"
				title=${expanded ? t("review.actions.collapse") : t("review.actions.expand")}
				@click=${() => store.toggleFile(scope, entry)}
			>
				<span class="review-file-chip chip-${entry.status}" title=${t(`review.status.${entry.status}`)}>${statusChipLetter(entry)}</span>
				<span class="review-file-path">
					${entry.status === "renamed" && entry.old_path
						? html`<span class="review-file-old">${entry.old_path}</span><span class="review-file-arrow">→</span>${entry.path}`
						: entry.path}
				</span>
				<span class="review-file-caret">${expanded ? "▾" : "▸"}</span>
			</button>
			<button class="review-file-action" ?disabled=${busy} @click=${onAction}>${actionLabel}</button>
		</div>
		${renderDiffView(store, key)}
	`;
}

function renderUntrackedRow(store: ReviewPanelStore, path: string): TemplateResult {
	const busy = store.busyPaths.has(path);
	return html`
		<div class="review-file">
			<div class="review-file-main static">
				<span class="review-file-chip chip-untracked" title=${t("review.sections.untracked")}>U</span>
				<span class="review-file-path">${path}</span>
			</div>
			<button class="review-file-action" ?disabled=${busy} @click=${() => void store.stagePaths([path])}>
				${t("review.actions.stage")}
			</button>
		</div>
	`;
}

export function renderReviewPanelView(store: ReviewPanelStore): TemplateResult | typeof nothing {
	if (!store.isOpen) return nothing;

	const status = store.status;
	const scopeEntries = status ? (store.scope === "staged" ? status.staged : status.unstaged) : [];
	const stagedCount = status?.staged_total ?? 0;
	const unstagedCount = status?.unstaged_total ?? 0;
	const untrackedHidden =
		status && status.untracked_total > status.untracked.length
			? status.untracked_total - status.untracked.length
			: 0;
	const showFreshRepoHint =
		status?.is_repo && !status.has_head && status.untracked_total > FRESH_REPO_UNTRACKED_HINT_THRESHOLD;

	return html`
		<aside class="review-panel" style="width: ${store.width}px" aria-label=${t("review.title")}>
			<div
				class="review-panel-resize"
				title=${t("review.resize")}
				@pointerdown=${(event: PointerEvent) => store.startResize(event)}
			></div>
			<div class="review-head">
				<span class="review-title">${t("review.title")}</span>
				<div class="review-head-actions">
					<button
						class="review-icon-btn"
						title=${t("review.refresh")}
						?disabled=${store.loading}
						@click=${() => void store.refresh()}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.7 8a4.7 4.7 0 1 1-1.4-3.4"></path><path d="M12.7 4.2v2.4h-2.4"></path></svg>
					</button>
					<button class="review-icon-btn" title=${t("review.close")} @click=${() => store.close()}>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7"></path><path d="M11.5 4.5l-7 7"></path></svg>
					</button>
				</div>
			</div>

			${!status || status.is_repo
				? html`
					<div class="review-scopes">
						<button
							class="review-scope-tab ${store.scope === "unstaged" ? "active" : ""}"
							@click=${() => store.setScope("unstaged")}
						>
							${t("review.scopes.unstaged")}
							${unstagedCount > 0 ? html`<span class="review-scope-count">${unstagedCount}</span>` : nothing}
						</button>
						<button
							class="review-scope-tab ${store.scope === "staged" ? "active" : ""}"
							@click=${() => store.setScope("staged")}
						>
							${t("review.scopes.staged")}
							${stagedCount > 0 ? html`<span class="review-scope-count">${stagedCount}</span>` : nothing}
						</button>
					</div>
				`
				: nothing}

			<div class="review-body">
				${store.actionError
					? html`<div class="review-error">
						<span>${t("review.error", { message: store.actionError })}</span>
						<button class="review-icon-btn" title=${t("review.dismissError")} @click=${() => store.dismissActionError()}>
							<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7"></path><path d="M11.5 4.5l-7 7"></path></svg>
						</button>
					</div>`
					: nothing}
				${store.error ? html`<div class="review-error">${t("review.error", { message: store.error })}</div>` : nothing}
				${!status
					? html`
						<div class="ui-skeleton" role="status" aria-label=${store.loading ? t("review.refreshing") : t("review.loading")}>
							<span class="skeleton-bar" style="width:62%"></span>
							<span class="skeleton-bar" style="width:84%"></span>
							<span class="skeleton-bar" style="width:48%"></span>
							<span class="skeleton-bar" style="width:71%"></span>
						</div>
					`
					: !status.is_repo
						? html`<div class="review-empty">${t("review.notRepo")}</div>`
						: html`
							${showFreshRepoHint
								? html`<div class="review-hint-card">${t("review.freshRepoHint", { count: status.untracked_total })}</div>`
								: nothing}
							${status.conflicted.length > 0
								? html`
									<div class="review-section">
										<div class="review-section-head">
											<span>${t("review.sections.conflicts")}</span>
											<span class="review-section-count conflict">${status.conflicted_total}</span>
										</div>
										${status.conflicted.map(
											(path) => html`
												<div class="review-file conflict">
													<div class="review-file-main static">
														<span class="review-file-chip chip-conflict" title=${t("review.sections.conflicts")}>!</span>
														<span class="review-file-path">${path}</span>
													</div>
												</div>
												<div class="review-conflict-hint">${t("review.conflictHint")}</div>
											`,
										)}
									</div>
								`
								: nothing}

							<div class="review-section">
								${scopeEntries.length === 0
									? html`<div class="review-empty small">${t(`review.scopeEmpty.${store.scope}`)}</div>`
									: scopeEntries.map((entry) => renderFileRow(store, store.scope, entry))}
							</div>

							${status.untracked.length > 0
								? html`
									<div class="review-section">
										<div class="review-section-head">
											<span>${t("review.sections.untracked")}</span>
											<span class="review-section-count">${status.untracked_total}</span>
										</div>
										${status.untracked.map((path) => renderUntrackedRow(store, path))}
										${untrackedHidden > 0
											? html`<div class="review-more-row">${t("review.untrackedMore", { count: untrackedHidden })}</div>`
											: nothing}
									</div>
								`
								: nothing}
						`}
			</div>
		</aside>
	`;
}
