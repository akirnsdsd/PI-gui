/**
 * 设置页「子智能体」tab。
 *
 * 子智能体能力由用户自装的 pi 扩展提供（`~/.pi/agent/extensions/subagent/`），
 * 定义文件在 `<pi agent dir>/agents/*.md`。本面板做两件事：
 * 定义的增删改查，以及后台运行记录（`subagent-bg-runs/`）的查看与清理。
 *
 * 已核实的机制（详见 src-tauri/src/subagents.rs 头注释与 design/subagent-panel-plan.md）：
 * - **保存后无需重启 runtime**：扩展在每次工具 execute 时都调 discoverAgents
 *   （subagent/index.ts:813、subagent-bg.ts:163），下次调用即读到新定义。
 *   所以这里**不接 queueAuthConfigDrivenReload**。
 * - **frontmatter 的 name 才是标准名**，文件名可以不一致。
 * - **只做 user 作用域**。项目作用域 `.pi/agents/` 不在 pi 的信任白名单里
 *   （extensions.rs 的 TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES 七项不含
 *   agents），展示它需要先定安全承诺，故本版不做。
 * - **后台状态只区分「可证明已结束」和「未知」**：exit_code 由脱离父会话的
 *   shell 写，result.json 由父进程回调写且失败被静默吞，所以「无 result.json」
 *   推不出异常；日志 mtime 也代表不了进程存活。不猜。
 */

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.js";
import { confirmDialog } from "./app-dialog.js";

// ---------------------------------------------------------------------------
// 类型（与 src-tauri/src/subagents.rs 的 Serialize 结构对应）
// ---------------------------------------------------------------------------

interface SubagentFrontmatter {
	name: string;
	display_name: string | null;
	description: string;
	model: string | null;
	tools: string[];
	extra: Array<[string, string]>;
}

interface SubagentEntry {
	file_path: string;
	file_name: string;
	frontmatter: SubagentFrontmatter | null;
	error: string | null;
	body_chars: number;
	size_bytes: number;
	round_trip_safe: boolean;
}

interface SubagentListResult {
	dir: string;
	extension_present: boolean;
	entries: SubagentEntry[];
	total: number;
	truncated: boolean;
}

interface SubagentDetail {
	file_name: string;
	file_path: string;
	content: string;
	mtime_ms: number;
}

type SubagentRunStatus = "succeeded" | "failed" | "running" | "unknown";

interface SubagentRunEntry {
	run_id: string;
	dir: string;
	status: SubagentRunStatus;
	exit_code: number | null;
	agent: string | null;
	cwd: string | null;
	task_preview: string | null;
	duration_ms: number | null;
	has_result: boolean;
	events_bytes: number;
	stderr_bytes: number;
	total_bytes: number;
	mtime_ms: number;
}

interface SubagentRunMessage {
	role: string;
	text: string;
	truncated: boolean;
	model: string | null;
}

interface SubagentRunDetail {
	runId: string;
	dir: string;
	finalText: string | null;
	finalTextTruncated: boolean;
	messages: SubagentRunMessage[];
	/** 只读了日志尾部，更早的消息可能没带出来。 */
	tailOnly: boolean;
	stderrPreview: string | null;
	eventsBytes: number;
}

interface SubagentRunListResult {
	dir: string;
	entries: SubagentRunEntry[];
	total: number;
	truncated: boolean;
	returned_bytes: number;
}

interface EditorState {
	fileName: string;
	isNew: boolean;
	name: string;
	displayName: string;
	description: string;
	model: string;
	tools: string;
	body: string;
	extra: Array<[string, string]>;
	/**
	 * 原文模式：结构化编辑器无法安全回写这个文件时为 true（比如 frontmatter
	 * 用了多行标量、列表语法、带引号冒号的值、注释）。此时只能整文编辑，
	 * 否则会默默改坏用户手写的配置。判定在 Rust 侧 is_round_trip_safe。
	 */
	rawMode: boolean;
	/** 原文模式下的完整文件内容。 */
	rawContent: string;
	/** 乐观锁：保存时回传，盘上变了就拒绝。 */
	mtimeMs: number;
	saving: boolean;
	error: string;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export class SubagentsSettings {
	private requestRender: () => void;
	private activeTab: "definitions" | "runs" = "definitions";

	private list: SubagentListResult | null = null;
	private listLoading = false;
	private listError = "";

	private runs: SubagentRunListResult | null = null;
	private runsLoading = false;
	/** 运行中任务的轮询定时器（仅 runs tab 打开时存在）。 */
	private runsPollTimer: number | null = null;
	/** 展开中的 run 详情（一次只看一条）。 */
	private runDetail: SubagentRunDetail | null = null;
	private runDetailLoading = "";
	private runDetailError = "";
	private runsError = "";

	private editor: EditorState | null = null;
	private notice = "";

	constructor(options: { requestRender: () => void }) {
		this.requestRender = options.requestRender;
	}

	private async invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		const { invoke } = await import("@tauri-apps/api/core");
		return invoke<T>(cmd, args);
	}

	/**
	 * 面板每次打开时调。
	 *
	 * **不预加载 runs**：它最坏要解析 100 个每个 512KB 上限的 result.json，
	 * 而用户大多数时候只看定义 tab。改成切到 runs tab 时惰加载。
	 */
	async refresh(): Promise<void> {
		await this.loadDefinitions();
		if (this.activeTab === "runs") await this.loadRuns();
	}

	private async loadDefinitions(): Promise<void> {
		this.listLoading = true;
		this.listError = "";
		this.requestRender();
		try {
			this.list = await this.invokeCmd<SubagentListResult>("list_subagents");
		} catch (err) {
			this.listError = t("subagents.errors.loadFailed", { message: String(err) });
		} finally {
			this.listLoading = false;
			this.requestRender();
		}
	}

	private async loadRuns(): Promise<void> {
		this.runsLoading = true;
		this.runsError = "";
		this.requestRender();
		try {
			this.runs = await this.invokeCmd<SubagentRunListResult>("list_subagent_runs");
			this.syncRunsAutoRefresh();
		} catch (err) {
			this.runsError = t("subagents.errors.runsFailed", { message: String(err) });
		} finally {
			this.runsLoading = false;
			this.requestRender();
		}
	}

	/**
	 * 有运行中任务时定时刷新，全部结束就停。
	 *
	 * 静态列表会一直显示「运行中」，用户无法知道任务何时完成。5 秒够用：
	 * 状态源是文件 mtime 与日志尾部，读取很轻（只取末尾 8KB，不整读 events.jsonl）。
	 * 只在 runs tab 打开时才拉——切走后停掉，不在后台空转。
	 */
	private syncRunsAutoRefresh(): void {
		const hasRunning = (this.runs?.entries ?? []).some((run) => run.status === "running");
		const shouldPoll = hasRunning && this.activeTab === "runs";
		if (shouldPoll === Boolean(this.runsPollTimer)) return;
		if (!shouldPoll) {
			if (this.runsPollTimer) window.clearInterval(this.runsPollTimer);
			this.runsPollTimer = null;
			return;
		}
		this.runsPollTimer = window.setInterval(() => {
			// 正在加载或已切走就跳过这一轮，不叠加请求。
			if (this.runsLoading || this.activeTab !== "runs") return;
			void this.loadRuns();
		}, 5000);
	}

	/** 面板关闭/切走时必须停表，否则会在后台一直读磁盘。 */
	stopRunsAutoRefresh(): void {
		if (this.runsPollTimer) window.clearInterval(this.runsPollTimer);
		this.runsPollTimer = null;
	}

	private openNewEditor(): void {
		this.editor = {
			fileName: "",
			isNew: true,
			name: "",
			displayName: "",
			description: "",
			model: "",
			tools: "",
			body: "",
			extra: [],
			rawMode: false,
			rawContent: "",
			mtimeMs: 0,
			saving: false,
			error: "",
		};
		this.requestRender();
	}

	private async openEditor(entry: SubagentEntry): Promise<void> {
		try {
			const detail = await this.invokeCmd<SubagentDetail>("read_subagent", {
				fileName: entry.file_name,
			});
			const fm = entry.frontmatter;
			// 解析失败、或结构化回写不安全的文件，一律走原文编辑。
			const rawMode = !fm || !entry.round_trip_safe;
			this.editor = {
				fileName: entry.file_name,
				isNew: false,
				name: fm?.name ?? "",
				displayName: fm?.display_name ?? "",
				description: fm?.description ?? "",
				model: fm?.model ?? "",
				tools: (fm?.tools ?? []).join(","),
				body: rawMode ? "" : this.extractBody(detail.content),
				extra: fm?.extra ?? [],
				rawMode,
				rawContent: detail.content,
				mtimeMs: detail.mtime_ms,
				saving: false,
				error: entry.error ?? "",
			};
			this.requestRender();
		} catch (err) {
			this.listError = t("subagents.errors.loadFailed", { message: String(err) });
			this.requestRender();
		}
	}

	/** 与 Rust 侧 split_frontmatter 一致：第一个 `\n---` 结束，正文 trim。 */
	private extractBody(content: string): string {
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (!normalized.startsWith("---")) return normalized;
		const end = normalized.indexOf("\n---", 3);
		if (end === -1) return normalized;
		return normalized.slice(end + 4).trim();
	}

	private closeEditor(): void {
		this.editor = null;
		this.requestRender();
	}

	private buildContent(state: EditorState): string {
		const lines = ["---", `name: ${state.name.trim()}`];
		if (state.displayName.trim()) lines.push(`display_name: ${state.displayName.trim()}`);
		lines.push(`description: ${state.description.trim()}`);
		if (state.model.trim()) lines.push(`model: ${state.model.trim()}`);
		const tools = state.tools
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
		if (tools.length > 0) lines.push(`tools: ${tools.join(",")}`);
		// 保留未知字段（read-modify-write 约定）
		for (const [key, value] of state.extra) lines.push(`${key}: ${value}`);
		lines.push("---", "", state.body.trim(), "");
		return lines.join("\n");
	}

	private async saveEditor(): Promise<void> {
		const state = this.editor;
		// 重入保护：按钮虽然 disabled，但连点/回车仍可能进两次。
		if (!state || state.saving) return;

		// 原文模式下不改文件名，内容原封不动交给后端。
		let fileName: string;
		let content: string;
		if (state.rawMode) {
			fileName = state.fileName;
			content = state.rawContent;
		} else {
			const name = state.name.trim();
			if (!/^[A-Za-z0-9_-]+$/.test(name)) {
				state.error = t("subagents.editor.nameHint");
				this.requestRender();
				return;
			}
			// 新建时文件名缺省跟名称走；文件名与名称同规则校验（文案已这么写）。
			const stem = (state.isNew ? state.fileName.trim() || name : state.fileName).replace(/\.md$/, "");
			if (!/^[A-Za-z0-9_-]+$/.test(stem)) {
				state.error = t("subagents.editor.fileNameHint");
				this.requestRender();
				return;
			}
			fileName = `${stem}.md`;
			content = this.buildContent(state);
		}

		state.saving = true;
		state.error = "";
		this.requestRender();
		try {
			await this.invokeCmd<SubagentDetail>("save_subagent", {
				fileName,
				content,
				createNew: state.isNew,
				expectedMtimeMs: state.isNew ? null : state.mtimeMs,
			});
			this.notice = t("subagents.editor.saved", { name: state.name.trim() || fileName });
			this.editor = null;
			await this.loadDefinitions();
		} catch (err) {
			state.saving = false;
			state.error = t("subagents.errors.saveFailed", { message: String(err) });
			this.requestRender();
		}
	}

	private async deleteEntry(entry: SubagentEntry): Promise<void> {
		const label = entry.frontmatter?.name ?? entry.file_name;
		const ok = await confirmDialog({
			title: t("subagents.deleteConfirm.title"),
			desc: t("subagents.deleteConfirm.body", { name: label }),
			confirmLabel: t("subagents.deleteConfirm.confirm"),
			danger: true,
		});
		if (!ok) return;
		try {
			await this.invokeCmd<string>("move_path_to_trash", {
				path: entry.file_path,
				projectPath: null,
			});
			this.notice = t("subagents.deleted", { name: label });
			await this.loadDefinitions();
		} catch (err) {
			this.listError = t("subagents.errors.deleteFailed", { message: String(err) });
			this.requestRender();
		}
	}

	private async deleteRun(run: SubagentRunEntry): Promise<void> {
		// 没有退出码时进程可能仍在写这个目录，删了会把运行记录拆成两半。
		// running 更明确——日志正在追加，绝不能删。
		if (run.status === "unknown" || run.status === "running") {
			this.runsError = t("subagents.runs.unknownHint");
			this.requestRender();
			return;
		}
		const ok = await confirmDialog({
			title: t("subagents.runs.deleteConfirmTitle"),
			desc: t("subagents.runs.deleteConfirmBody", {
				name: run.run_id,
				size: formatBytes(run.total_bytes),
			}),
			confirmLabel: t("subagents.deleteConfirm.confirm"),
			danger: true,
		});
		if (!ok) return;
		try {
			await this.invokeCmd<string>("move_path_to_trash", { path: run.dir, projectPath: null });
			await this.loadRuns();
		} catch (err) {
			this.runsError = t("subagents.errors.deleteFailed", { message: String(err) });
			this.requestRender();
		}
	}

	/**
	 * 展开/收起单条 run 的详情。
	 *
	 * 详情从 events.jsonl **尾部**解析（Rust 侧限 2MB 窗口、40 条消息、单条 4000 字），
	 * 实测该文件可达 55MB，绝不整读。
	 */
	private async toggleRunDetail(run: SubagentRunEntry): Promise<void> {
		if (this.runDetail?.runId === run.run_id) {
			this.runDetail = null;
			this.runDetailError = "";
			this.requestRender();
			return;
		}
		this.runDetailLoading = run.run_id;
		this.runDetailError = "";
		this.requestRender();
		try {
			this.runDetail = await this.invokeCmd<SubagentRunDetail>("read_subagent_run", {
				runId: run.run_id,
			});
		} catch (err) {
			this.runDetail = null;
			this.runDetailError = t("subagents.errors.runDetailFailed", { message: String(err) });
		} finally {
			this.runDetailLoading = "";
			this.requestRender();
		}
	}

	private renderRunDetail(): TemplateResult {
		const detail = this.runDetail;
		if (!detail) return html``;
		return html`
			<div class="subagent-run-detail">
				${detail.tailOnly
					? html`<div class="settings-desc">${t("subagents.runs.tailOnly")}</div>`
					: nothing}
				${detail.finalText
					? html`
						<div class="subagent-run-detail-block">
							<div class="subagent-run-detail-label">${t("subagents.runs.finalText")}</div>
							<pre class="subagent-run-detail-body">${detail.finalText}</pre>
							${detail.finalTextTruncated
								? html`<div class="settings-desc">${t("subagents.runs.truncatedHint")}</div>`
								: nothing}
						</div>
					`
					: nothing}
				${detail.messages.length > 0
					? html`
						<div class="subagent-run-detail-block">
							<div class="subagent-run-detail-label">
								${t("subagents.runs.messages", { count: String(detail.messages.length) })}
							</div>
							${detail.messages.map(
								(message) => html`
									<div class="subagent-run-msg role-${message.role}">
										<div class="subagent-run-msg-head">
											<span>${message.role}</span>
											${message.model ? html`<code>${message.model}</code>` : nothing}
										</div>
										<pre class="subagent-run-detail-body">${message.text}</pre>
										${message.truncated
											? html`<div class="settings-desc">${t("subagents.runs.truncatedHint")}</div>`
											: nothing}
									</div>
								`,
							)}
						</div>
					`
					: nothing}
				${detail.stderrPreview
					? html`
						<div class="subagent-run-detail-block">
							<div class="subagent-run-detail-label">${t("subagents.runs.stderr")}</div>
							<pre class="subagent-run-detail-body is-stderr">${detail.stderrPreview}</pre>
						</div>
					`
					: nothing}
				${!detail.finalText && detail.messages.length === 0 && !detail.stderrPreview
					? html`<div class="settings-desc">${t("subagents.runs.detailEmpty")}</div>`
					: nothing}
			</div>
		`;
	}

	private async revealPath(path: string): Promise<void> {
		try {
			await this.invokeCmd<void>("open_path_in_default_app", { path });
		} catch {
			/* 打不开不影响主流程 */
		}
	}

	render(): TemplateResult {
		return html`
			<div class="ext-view">
				<div class="ext-view-head">
					<h3>${t("subagents.title")}</h3>
					<p>${t("subagents.description")}</p>
					${this.list ? html`<p class="settings-desc"><code>${this.list.dir}</code></p>` : nothing}
				</div>

				${this.list && !this.list.extension_present
					? html`<div class="settings-desc ext-error">
							<strong>${t("subagents.extensionMissing.title")}</strong>
							${t("subagents.extensionMissing.body")}
					  </div>`
					: nothing}

				<div class="subagent-tabs" role="tablist">
					${this.renderTabButton("definitions", t("subagents.tabs.definitions"))}
					${this.renderTabButton("runs", t("subagents.tabs.runs"))}
				</div>

				${this.notice ? html`<div class="settings-desc">${this.notice}</div>` : nothing}
				${this.activeTab === "definitions" ? this.renderDefinitions() : this.renderRuns()}
			</div>
		`;
	}

	private renderTabButton(id: "definitions" | "runs", label: string): TemplateResult {
		const active = this.activeTab === id;
		return html`
			<button
				type="button"
				role="tab"
				aria-selected=${active ? "true" : "false"}
				class="subagent-tab ${active ? "is-active" : ""}"
				@click=${() => {
					this.activeTab = id;
					this.notice = "";
					this.requestRender();
					// 惰加载：首次切到 runs 才读目录。
					if (id === "runs" && !this.runs && !this.runsLoading) void this.loadRuns();
					// 切走时停轮询，切回时按当前状态重建。
					this.syncRunsAutoRefresh();
				}}
			>
				${label}
			</button>
		`;
	}

	private renderDefinitions(): TemplateResult {
		if (this.editor) return this.renderEditor(this.editor);

		const list = this.list;
		return html`
			<div class="settings-actions">
				<button type="button" class="ghost-btn" @click=${() => this.openNewEditor()}>
					${t("subagents.actions.create")}
				</button>
				<button type="button" class="ghost-btn" @click=${() => void this.loadDefinitions()}>
					${t("subagents.actions.refresh")}
				</button>
				${list
					? html`<span class="settings-desc"
							>${t("subagents.list.countLabel", { count: String(list.total) })}</span
					  >`
					: nothing}
			</div>

			${this.listError ? html`<div class="settings-desc ext-error">${this.listError}</div>` : nothing}
			${this.listLoading && !list
				? html`<div class="settings-desc">${t("subagents.list.loading")}</div>`
				: nothing}
			${list && list.entries.length === 0 && !this.listLoading
				? html`<div class="settings-desc">${t("subagents.list.empty")}</div>`
				: nothing}
			${list ? html`<div class="ext-card-grid">${list.entries.map((e) => this.renderEntry(e))}</div>` : nothing}
			${list?.truncated
				? html`<div class="settings-desc">
						${t("subagents.list.truncated", {
							shown: String(list.entries.length),
							total: String(list.total),
						})}
				  </div>`
				: nothing}
		`;
	}

	private renderEntry(entry: SubagentEntry): TemplateResult {
		const fm = entry.frontmatter;
		const title = fm?.display_name || fm?.name || entry.file_name;
		return html`
			<div class="ext-card ${fm ? "" : "subagent-invalid"}">
				<div class="ext-card-main">
					<div class="ext-card-title">
						<span class="ext-name">${title}</span>
						${fm && fm.display_name && fm.name !== fm.display_name
							? html`<code class="subagent-code">${fm.name}</code>`
							: nothing}
						${fm ? nothing : html`<span class="subagent-badge-invalid">${t("subagents.list.invalidBadge")}</span>`}
					</div>
					${fm
						? html`<div class="ext-card-desc">${fm.description}</div>`
						: html`<div class="ext-card-desc ext-error">${entry.error}</div>`}
					<div class="subagent-card-meta">
						<code>${entry.file_name}</code>
						<span>${fm?.model || t("subagents.list.defaultModel")}</span>
						<span
							>${fm && fm.tools.length > 0
								? t("subagents.list.toolsLabel", { list: fm.tools.join(", ") })
								: t("subagents.list.toolsAll")}</span
						>
						${fm
							? html`<span>${t("subagents.list.bodyChars", { count: String(entry.body_chars) })}</span>`
							: nothing}
					</div>
				</div>
				<div class="ext-view-head-actions">
					<button type="button" class="ghost-btn" @click=${() => void this.openEditor(entry)}>
						${t("subagents.actions.edit")}
					</button>
					<button type="button" class="ghost-btn" @click=${() => void this.revealPath(entry.file_path)}>
						${t("subagents.actions.revealInFinder")}
					</button>
					<button type="button" class="ghost-btn danger" @click=${() => void this.deleteEntry(entry)}>
						${t("subagents.actions.delete")}
					</button>
				</div>
			</div>
		`;
	}

	private renderStructuredEditorBody(
		state: EditorState,
		field: (
			label: string,
			hint: string,
			value: string,
			onInput: (v: string) => void,
			options?: { mono?: boolean; disabled?: boolean },
		) => TemplateResult,
	): TemplateResult {
		return html`
				${state.isNew
					? field(
							t("subagents.editor.fileName"),
							t("subagents.editor.fileNameHint"),
							state.fileName,
							(v) => {
								state.fileName = v;
							},
							{ mono: true },
						)
					: field(
							t("subagents.editor.fileName"),
							t("subagents.editor.fileNameHint"),
							state.fileName,
							() => {},
							{ mono: true, disabled: true },
						)}
				${field(t("subagents.editor.name"), t("subagents.editor.nameHint"), state.name, (v) => {
					state.name = v;
				}, { mono: true })}
				${field(
					t("subagents.editor.displayName"),
					t("subagents.editor.displayNameHint"),
					state.displayName,
					(v) => {
						state.displayName = v;
					},
				)}
				${field(
					t("subagents.editor.descriptionField"),
					t("subagents.editor.descriptionHint"),
					state.description,
					(v) => {
						state.description = v;
					},
				)}
				${field(t("subagents.editor.model"), t("subagents.list.defaultModel"), state.model, (v) => {
					state.model = v;
				}, { mono: true })}
				${field(t("subagents.editor.tools"), t("subagents.editor.toolsHint"), state.tools, (v) => {
					state.tools = v;
				}, { mono: true })}

				<label class="ext-inline-form">
					<span class="settings-label">${t("subagents.editor.systemPrompt")}</span>
					<textarea
						class="settings-path-input subagent-prompt-input"
						rows="14"
						.value=${state.body}
						@input=${(e: Event) => {
							state.body = (e.target as HTMLTextAreaElement).value;
						}}
					></textarea>
					<span class="settings-desc">${t("subagents.editor.systemPromptHint")}</span>
				</label>

		`;
	}

	/**
	 * 原文编辑：结构化编辑器无法安全回写时的唯一选择。
	 * 内容会逐字节交给后端，不经任何重序列化。
	 */
	private renderRawEditorBody(state: EditorState): TemplateResult {
		return html`
			<div class="settings-desc">${t("subagents.editor.rawModeHint")}</div>
			<label class="ext-inline-form">
				<span class="settings-label">${t("subagents.editor.rawContent")}</span>
				<textarea
					class="settings-path-input subagent-prompt-input"
					rows="22"
					.value=${state.rawContent}
					@input=${(e: Event) => {
						state.rawContent = (e.target as HTMLTextAreaElement).value;
					}}
				></textarea>
			</label>
		`;
	}

	private renderEditor(state: EditorState): TemplateResult {
		const field = (
			label: string,
			hint: string,
			value: string,
			onInput: (v: string) => void,
			options: { mono?: boolean; disabled?: boolean } = {},
		) => html`
			<label class="ext-inline-form">
				<span class="settings-label">${label}</span>
				<input
					type="text"
					class="settings-path-input"
					.value=${value}
					?disabled=${options.disabled ?? false}
					@input=${(e: Event) => {
						onInput((e.target as HTMLInputElement).value);
					}}
				/>
				<span class="settings-desc">${hint}</span>
			</label>
		`;

		return html`
			<div class="subagent-editor">
				<div class="subagent-editor-head">
					${state.isNew
						? t("subagents.editor.newTitle")
						: t("subagents.editor.editTitle", { name: state.name || state.fileName })}
				</div>

				${state.error ? html`<div class="settings-desc ext-error">${state.error}</div>` : nothing}

				${state.rawMode ? this.renderRawEditorBody(state) : this.renderStructuredEditorBody(state, field)}

				<div class="settings-actions">
					<button
						type="button"
						class="ghost-btn"
						?disabled=${state.saving}
						@click=${() => void this.saveEditor()}
					>
						${state.saving ? t("subagents.editor.saving") : t("subagents.editor.save")}
					</button>
					<button type="button" class="ghost-btn" @click=${() => this.closeEditor()}>
						${t("subagents.editor.cancel")}
					</button>
				</div>
			</div>
		`;
	}

	private renderRuns(): TemplateResult {
		const runs = this.runs;
		return html`
			<div class="settings-actions">
				<button type="button" class="ghost-btn" @click=${() => void this.loadRuns()}>
					${t("subagents.actions.refresh")}
				</button>
				${runs
					? html`<span class="settings-desc">
							${t("subagents.runs.countLabel", { count: String(runs.total) })} ·
							${t("subagents.runs.totalSize", { size: formatBytes(runs.returned_bytes) })}
					  </span>`
					: nothing}
			</div>

			${this.runsError ? html`<div class="settings-desc ext-error">${this.runsError}</div>` : nothing}
			${this.runsLoading && !runs
				? html`<div class="settings-desc">${t("subagents.runs.loading")}</div>`
				: nothing}
			${runs && runs.entries.length === 0 && !this.runsLoading
				? html`<div class="settings-desc">${t("subagents.runs.empty")}</div>`
				: nothing}
			${runs ? html`<div class="ext-card-grid">${runs.entries.map((r) => this.renderRun(r))}</div>` : nothing}
			${runs?.truncated
				? html`<div class="settings-desc">
						${t("subagents.runs.truncated", {
							shown: String(runs.entries.length),
							total: String(runs.total),
						})}
				  </div>`
				: nothing}
		`;
	}

	private renderRun(run: SubagentRunEntry): TemplateResult {
		const statusLabel =
			run.status === "succeeded"
				? t("subagents.runs.status.succeeded")
				: run.status === "failed"
					? t("subagents.runs.status.failed", { code: String(run.exit_code ?? "?") })
					: run.status === "running"
						? t("subagents.runs.status.running")
						: t("subagents.runs.status.unknown");
		return html`
			<div class="ext-card subagent-run-card status-${run.status}">
				<div class="ext-card-main">
					<div class="ext-card-title">
						<span class="ext-name">${run.agent ?? run.run_id}</span>
						<span class="subagent-run-status">${statusLabel}</span>
					</div>
					${run.task_preview
						? html`<div class="ext-card-desc">${run.task_preview}</div>`
						: nothing}
					<div class="subagent-card-meta">
						<code>${run.run_id}</code>
						${run.duration_ms !== null
							? html`<span>${t("subagents.runs.duration", { value: formatDuration(run.duration_ms) })}</span>`
							: nothing}
						<span>${t("subagents.runs.eventsSize", { size: formatBytes(run.events_bytes) })}</span>
					</div>
					${run.cwd
						? html`<div class="subagent-card-meta">${t("subagents.runs.cwd", { path: run.cwd })}</div>`
						: nothing}
					${run.status === "unknown"
						? html`<div class="settings-desc">${t("subagents.runs.unknownHint")}</div>`
						: nothing}
					${run.status === "running"
						? html`<div class="settings-desc">${t("subagents.runs.runningHint")}</div>`
						: nothing}
					${!run.has_result && run.status !== "unknown" && run.status !== "running"
						? html`<div class="settings-desc">${t("subagents.runs.noResultHint")}</div>`
						: nothing}
				</div>
				<div class="ext-view-head-actions">
					<button
						type="button"
						class="ghost-btn"
						?disabled=${this.runDetailLoading === run.run_id}
						@click=${() => void this.toggleRunDetail(run)}
					>
						${this.runDetailLoading === run.run_id
							? t("subagents.runs.loadingDetail")
							: this.runDetail?.runId === run.run_id
								? t("subagents.runs.hideDetail")
								: t("subagents.runs.viewDetail")}
					</button>
					<button type="button" class="ghost-btn" @click=${() => void this.revealPath(run.dir)}>
						${t("subagents.runs.openDir")}
					</button>
					<button
						type="button"
						class="ghost-btn danger"
						?disabled=${run.status === "unknown" || run.status === "running"}
						@click=${() => void this.deleteRun(run)}
					>
						${t("subagents.runs.deleteRun")}
					</button>
				</div>
			</div>
			${this.runDetail?.runId === run.run_id ? this.renderRunDetail() : nothing}
			${this.runDetailError && this.runDetailLoading === "" && this.runDetail === null
				? html`<div class="settings-desc ext-error">${this.runDetailError}</div>`
				: nothing}
		`;
	}
}
