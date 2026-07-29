/**
 * 设置页「扩展」tab（PRD 4.3，W4）：Skills / 散放扩展 / MCP 三合一 +
 * 已信任项目。包管理（pi list/install/remove/update）不重复造，顶部放
 * 入口跳转现有 Packages 视图。
 *
 * 数据通道：
 * - 目录枚举 / SKILL.md 解析 / 废纸篓 / 项目信任 / MCP 合并与导入映射走
 *   src-tauri/src/extensions.rs 的 Tauri commands；
 * - settings.json / mcp.json 的读写走 safe_config 的 safe_read_json /
 *   safe_write_json（锁 + 备份 + 原子写）；
 * - adapter 检测与安装走现有 run_pi_cli_command（pi list / pi install）。
 *
 * 已核实的 pi 0.81.1 机制（详见 extensions.rs 头注释）：
 * - 单个散放 skill / 扩展可通过 settings.json 的 skills/extensions 数组里
 *   `-<相对路径>` 精确覆盖条目禁用（isEnabledByOverrides），重载后生效；
 * - 项目信任存 ~/.pi/agent/trust.json；RPC 模式无提示，无保存决定即不加载
 *   项目资源；
 * - MCP 配置按 pi-mcp-adapter 的六层层叠合并，disabled 仅字面 true 生效。
 */

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.js";
import { rpcBridge } from "../rpc/bridge.js";
import { confirmDialog } from "./app-dialog.js";
import { SettingsSelectDropdown } from "./settings-select-dropdown.js";

// ---------------------------------------------------------------------------
// 类型（与 src-tauri/src/extensions.rs 的 Serialize 结构对应）
// ---------------------------------------------------------------------------

interface SkillEntry {
	name: string;
	description: string;
	loadable: boolean;
	file_path: string;
	skill_dir: string;
	root_path: string;
	origin: string;
	settings_scope: string;
	disable_pattern: string;
	enabled: boolean;
}

interface SkillListResult {
	skills: SkillEntry[];
	global_settings_path: string;
	project_settings_path: string | null;
	project_trusted: boolean | null;
}

interface LooseExtensionEntry {
	name: string;
	file_path: string;
	root_path: string;
	origin: string;
	settings_scope: string;
	disable_pattern: string;
	enabled: boolean;
}

interface LooseExtensionListResult {
	extensions: LooseExtensionEntry[];
	global_settings_path: string;
	project_settings_path: string | null;
}

interface McpServerEntry {
	name: string;
	source_file: string;
	layer: string;
	layer_label: string;
	disabled: boolean;
	transport: string;
	summary: string;
	config: Record<string, unknown>;
	overridden_files: string[];
}

interface McpConfigFileInfo {
	path: string;
	layer: string;
	layer_label: string;
	exists: boolean;
	server_count: number;
	error: string | null;
}

interface McpListResult {
	servers: McpServerEntry[];
	files: McpConfigFileInfo[];
}

interface McpImportCandidate {
	name: string;
	transport: string;
	summary: string;
	config: Record<string, unknown>;
	source_tool: string;
	source_file: string;
	already_configured: boolean;
}

interface TrustedProjectEntry {
	path: string;
	trusted: boolean;
	exists: boolean;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function joinFsPath(base: string, child: string): string {
	const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
	const c = child.replace(/\\/g, "/").replace(/^\/+/, "");
	return b ? `${b}/${c}` : c;
}

function dirOf(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const idx = normalized.lastIndexOf("/");
	return idx > 0 ? normalized.slice(0, idx) : normalized;
}

/** 解析「每行 KEY=VALUE」文本；返回错误串或记录对象。 */
function parseKeyValueLines(text: string): Record<string, string> | string {
	const out: Record<string, string> = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) return line;
		out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

function keyValueRecordToText(value: unknown): string {
	const obj = asObject(value);
	return Object.entries(obj)
		.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join("\n");
}

type McpFormType = "stdio" | "http";
type McpWriteTarget = "project" | "global";
export type ExtensionsViewId = "skills" | "extensions" | "mcp";

// ---------------------------------------------------------------------------
// Codex 风卡片图标：按名称 hash 取一组柔和配色（浅色底 + 深色字，浅/深主题均可读）
// ---------------------------------------------------------------------------

const ICON_PALETTE: Array<{ bg: string; fg: string }> = [
	{ bg: "#e3edfb", fg: "#2b62c4" },
	{ bg: "#e6f4ea", fg: "#2e7d46" },
	{ bg: "#fdeee3", fg: "#c2621b" },
	{ bg: "#f3e8fd", fg: "#7d3cc4" },
	{ bg: "#fde8ec", fg: "#c42b5e" },
	{ bg: "#e0f2f1", fg: "#00796b" },
	{ bg: "#fff4d6", fg: "#9c6d00" },
	{ bg: "#e8eaf6", fg: "#3f51b5" },
];

function iconColorFor(name: string): { bg: string; fg: string } {
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
	return ICON_PALETTE[hash % ICON_PALETTE.length];
}

function nameInitial(name: string): string {
	const trimmed = name.trim();
	return trimmed ? (Array.from(trimmed)[0] ?? "?").toUpperCase() : "?";
}

// 16×16 线性图标，描边随 currentColor（与 sidebar 等处的 svg 约定一致）
function iconFolder(): TemplateResult {
	return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.7a1 1 0 0 1 1-1h2.9l1.1 1.3h5a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>`;
}

function iconTrash(): TemplateResult {
	return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10"/><path d="M6.4 4.5V3.5a.7.7 0 0 1 .7-.7h1.8a.7.7 0 0 1 .7.7v1"/><path d="M4.6 4.5l.5 7.9a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.5-7.9"/><path d="M6.8 7v3.6M9.2 7v3.6"/></svg>`;
}

function iconEdit(): TemplateResult {
	return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.9 3.3l2.8 2.8-7.3 7.3H2.6v-2.8z"/><path d="M8.9 4.3l2.8 2.8"/></svg>`;
}

export class ExtensionsSettings {
	private requestRender: () => void;
	private onConfigChanged: (() => void) | null = null;
	private onOpenPackages: (() => void) | null = null;

	private projectPath: string | null = null;
	private loading = false;
	private loadError = "";
	private message = "";
	private error = "";

	private skillsResult: SkillListResult | null = null;
	private looseResult: LooseExtensionListResult | null = null;
	private mcpResult: McpListResult | null = null;
	private trustedProjects: TrustedProjectEntry[] = [];

	private adapterInstalled: boolean | null = null;
	private adapterChecking = false;
	private adapterInstalling = false;
	private adapterInstallLog = "";

	private busyKey = "";

	private skillAddOpen = false;
	private skillAddPath = "";

	private mcpFormOpen = false;
	private mcpFormMode: "add" | "edit" = "add";
	private mcpFormSourceFile = "";
	private mcpFormBase: Record<string, unknown> = {};
	private mcpFormName = "";
	private mcpFormType: McpFormType = "stdio";
	private mcpFormCommand = "";
	private mcpFormArgs = "";
	private mcpFormEnvText = "";
	private mcpFormUrl = "";
	private mcpFormHeadersText = "";
	private mcpFormError = "";
	private mcpAddTarget: McpWriteTarget = "project";

	private importOpen = false;
	private importLoading = false;
	private importApplying = false;
	private importCandidates: McpImportCandidate[] = [];
	private importChecked = new Set<string>();
	private importTarget: McpWriteTarget = "project";
	private importError = "";

	private readonly mcpFormTypeSelect = new SettingsSelectDropdown({
		requestRender: () => this.requestRender(),
	});
	private readonly mcpAddTargetSelect = new SettingsSelectDropdown({
		requestRender: () => this.requestRender(),
	});
	private readonly importTargetSelect = new SettingsSelectDropdown({
		requestRender: () => this.requestRender(),
	});

	// 展示层状态：当前子视图 + 搜索词（仅过滤渲染，不影响数据）
	private activeView: ExtensionsViewId = "skills";
	private searchQuery = "";

	constructor(options: { requestRender: () => void }) {
		this.requestRender = options.requestRender;
	}

	setOnConfigChanged(callback: (() => void) | null): void {
		this.onConfigChanged = callback;
	}

	setOnOpenPackages(callback: (() => void) | null): void {
		this.onOpenPackages = callback;
	}

	/** 外部定位子视图（如 MCP chip 弹层「管理 MCP…」直达 MCP tab）。 */
	setActiveView(view: ExtensionsViewId): void {
		if (this.activeView === view) return;
		this.activeView = view;
		this.requestRender();
	}

	setProjectPath(projectPath: string | null): void {
		const normalized = projectPath && projectPath.trim().length > 0 ? projectPath : null;
		if (normalized === this.projectPath) return;
		this.projectPath = normalized;
		this.skillsResult = null;
		this.looseResult = null;
		this.mcpResult = null;
	}

	private emitConfigChanged(): void {
		this.message = t("extensions.common.reloadNeeded");
		this.onConfigChanged?.();
	}

	// ------------------------------------------------------------------
	// IO
	// ------------------------------------------------------------------

	private async invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		const { invoke } = await import("@tauri-apps/api/core");
		return invoke<T>(cmd, args);
	}

	private async readJson(path: string): Promise<unknown> {
		return this.invokeCmd("safe_read_json", { path });
	}

	private async writeJson(path: string, value: unknown): Promise<void> {
		await this.invokeCmd("safe_write_json", { path, value, mode: null });
	}

	async refresh(): Promise<void> {
		this.loading = true;
		this.loadError = "";
		this.requestRender();
		try {
			const [skills, loose, mcp, trusted] = await Promise.all([
				this.invokeCmd<SkillListResult>("list_skill_resources", { projectPath: this.projectPath }),
				this.invokeCmd<LooseExtensionListResult>("list_loose_extensions", { projectPath: this.projectPath }),
				this.invokeCmd<McpListResult>("list_mcp_servers", { projectPath: this.projectPath }),
				this.invokeCmd<TrustedProjectEntry[]>("list_trusted_projects"),
			]);
			this.skillsResult = skills;
			this.looseResult = loose;
			this.mcpResult = mcp;
			this.trustedProjects = trusted;
		} catch (err) {
			this.loadError = errText(err);
		} finally {
			this.loading = false;
			this.requestRender();
		}
		if (this.adapterInstalled === null && !this.adapterChecking) {
			void this.checkAdapter();
		}
	}

	private async checkAdapter(): Promise<void> {
		this.adapterChecking = true;
		this.requestRender();
		try {
			const result = await rpcBridge.runPiCliCommand(["list"], { cwd: this.projectPath ?? "/" });
			const text = `${result.stdout}\n${result.stderr}`;
			this.adapterInstalled = text.includes("pi-mcp-adapter");
		} catch {
			this.adapterInstalled = null;
		} finally {
			this.adapterChecking = false;
			this.requestRender();
		}
	}

	private async installAdapter(): Promise<void> {
		this.adapterInstalling = true;
		this.adapterInstallLog = "";
		this.error = "";
		this.requestRender();
		try {
			const result = await rpcBridge.runPiCliCommand(["install", "npm:pi-mcp-adapter"], {
				cwd: this.projectPath ?? "/",
			});
			const log = [result.stdout, result.stderr].filter((s) => s.trim().length > 0).join("\n");
			this.adapterInstallLog = log;
			if (result.exit_code === 0) {
				this.adapterInstalled = true;
				this.emitConfigChanged();
			} else {
				this.error = t("extensions.mcp.installFailed", { code: result.exit_code });
			}
		} catch (err) {
			this.error = errText(err);
		} finally {
			this.adapterInstalling = false;
			this.requestRender();
		}
	}

	// ------------------------------------------------------------------
	// Skills 操作
	// ------------------------------------------------------------------

	private settingsPathForScope(scope: string): string | null {
		if (scope === "global") {
			return this.skillsResult?.global_settings_path ?? this.looseResult?.global_settings_path ?? null;
		}
		return this.skillsResult?.project_settings_path ?? this.looseResult?.project_settings_path ?? null;
	}

	private async writeOverrideMarker(scope: string, arrayKey: "skills" | "extensions", pattern: string, enabled: boolean): Promise<void> {
		const settingsPath = this.settingsPathForScope(scope);
		if (!settingsPath) throw new Error(t("extensions.mcp.noSettingsPath"));
		const obj = asObject(await this.readJson(settingsPath));
		const current = Array.isArray(obj[arrayKey])
			? (obj[arrayKey] as unknown[]).filter((e): e is string => typeof e === "string")
			: [];
		const marker = `-${pattern}`;
		const next = enabled
			? current.filter((e) => e !== marker)
			: [...new Set([...current, marker])];
		obj[arrayKey] = next;
		await this.writeJson(settingsPath, obj);
	}

	private async setSkillEnabled(skill: SkillEntry, enabled: boolean): Promise<void> {
		this.busyKey = `skill:${skill.file_path}`;
		this.error = "";
		this.requestRender();
		try {
			await this.writeOverrideMarker(skill.settings_scope, "skills", skill.disable_pattern, enabled);
			this.emitConfigChanged();
			await this.refresh();
		} catch (err) {
			this.error = `${t("extensions.mcp.toggleFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.busyKey = "";
		}
	}

	private async trashSkill(skill: SkillEntry): Promise<void> {
		const confirmed = await confirmDialog({
			title: t("extensions.skills.trashTitle"),
			desc: t("extensions.skills.trashConfirm", { name: skill.name }),
			confirmLabel: t("extensions.skills.trashTitle"),
		});
		if (!confirmed) return;
		this.busyKey = `skill:${skill.file_path}`;
		this.error = "";
		this.requestRender();
		try {
			const target = skill.file_path.endsWith("/SKILL.md") ? skill.skill_dir : skill.file_path;
			const newPath = await this.invokeCmd<string>("move_path_to_trash", {
				path: target,
				projectPath: this.projectPath,
			});
			this.message = t("extensions.skills.trashMoved", { path: newPath });
			this.onConfigChanged?.();
			await this.refresh();
		} catch (err) {
			this.error = `${t("extensions.skills.trashFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.busyKey = "";
		}
	}

	private async installSkillFromPath(): Promise<void> {
		const path = this.skillAddPath.trim();
		if (!path) return;
		this.busyKey = "skill:add";
		this.error = "";
		this.requestRender();
		try {
			const dest = await this.invokeCmd<string>("install_skill_from_path", { sourcePath: path });
			this.message = t("extensions.skills.addSuccess", { path: dest });
			this.skillAddPath = "";
			this.skillAddOpen = false;
			this.onConfigChanged?.();
			await this.refresh();
		} catch (err) {
			this.error = `${t("extensions.skills.addFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.busyKey = "";
		}
	}

	private async openPath(path: string): Promise<void> {
		try {
			await this.invokeCmd("open_path_in_default_app", { path });
		} catch (err) {
			this.error = errText(err);
			this.requestRender();
		}
	}

	// ------------------------------------------------------------------
	// 散放扩展操作
	// ------------------------------------------------------------------

	private async setLooseEnabled(entry: LooseExtensionEntry, enabled: boolean): Promise<void> {
		this.busyKey = `ext:${entry.file_path}`;
		this.error = "";
		this.requestRender();
		try {
			await this.writeOverrideMarker(entry.settings_scope, "extensions", entry.disable_pattern, enabled);
			this.emitConfigChanged();
			await this.refresh();
		} catch (err) {
			this.error = `${t("extensions.mcp.toggleFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.busyKey = "";
		}
	}

	// ------------------------------------------------------------------
	// MCP 操作
	// ------------------------------------------------------------------

	private mcpTargetPath(target: McpWriteTarget): Promise<string> {
		if (target === "project" && this.projectPath) {
			return Promise.resolve(joinFsPath(this.projectPath, ".mcp.json"));
		}
		return (async () => {
			const { homeDir } = await import("@tauri-apps/api/path");
			const home = (await homeDir()).replace(/\\/g, "/").replace(/\/+$/, "");
			return joinFsPath(joinFsPath(joinFsPath(home, ".config"), "mcp"), "mcp.json");
		})();
	}

	private async mutateMcpServer(
		sourceFile: string,
		name: string,
		mutate: (current: Record<string, unknown> | null) => Record<string, unknown> | null,
	): Promise<void> {
		const root = asObject(await this.readJson(sourceFile));
		const servers = asObject(root.mcpServers);
		const next = mutate(servers[name] ? asObject(servers[name]) : null);
		if (next === null) {
			delete servers[name];
		} else {
			servers[name] = next;
		}
		root.mcpServers = servers;
		await this.writeJson(sourceFile, root);
	}

	private async toggleMcpServer(entry: McpServerEntry): Promise<void> {
		this.busyKey = `mcp:${entry.name}`;
		this.error = "";
		this.requestRender();
		try {
			await this.mutateMcpServer(entry.source_file, entry.name, (current) => {
				const config = { ...(current ?? {}) };
				if (config.disabled === true) {
					delete config.disabled;
				} else {
					config.disabled = true;
				}
				return config;
			});
			this.emitConfigChanged();
			await this.refresh();
		} catch (err) {
			this.error = `${t("extensions.mcp.toggleFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.busyKey = "";
		}
	}

	private async deleteMcpServer(entry: McpServerEntry): Promise<void> {
		const lowerNote = entry.overridden_files.length > 0
			? `\n${t("extensions.mcp.deleteLowerNote", { files: entry.overridden_files.join(", ") })}`
			: "";
		const confirmed = await confirmDialog({
			title: t("extensions.mcp.deleteTitle"),
			desc: `${t("extensions.mcp.deleteConfirm", { name: entry.name, path: entry.source_file })}${lowerNote}`,
			confirmLabel: t("common.delete"),
			danger: true,
		});
		if (!confirmed) return;
		this.busyKey = `mcp:${entry.name}`;
		this.error = "";
		this.requestRender();
		try {
			await this.mutateMcpServer(entry.source_file, entry.name, () => null);
			this.emitConfigChanged();
			await this.refresh();
		} catch (err) {
			this.error = `${t("extensions.mcp.deleteFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.busyKey = "";
		}
	}

	private openMcpAddForm(): void {
		this.mcpFormMode = "add";
		this.mcpFormOpen = true;
		this.mcpFormSourceFile = "";
		this.mcpFormBase = {};
		this.mcpFormName = "";
		this.mcpFormType = "stdio";
		this.mcpFormCommand = "";
		this.mcpFormArgs = "";
		this.mcpFormEnvText = "";
		this.mcpFormUrl = "";
		this.mcpFormHeadersText = "";
		this.mcpFormError = "";
		this.mcpAddTarget = this.projectPath ? "project" : "global";
		this.requestRender();
	}

	private openMcpEditForm(entry: McpServerEntry): void {
		this.mcpFormMode = "edit";
		this.mcpFormOpen = true;
		this.mcpFormSourceFile = entry.source_file;
		this.mcpFormBase = { ...entry.config };
		this.mcpFormName = entry.name;
		this.mcpFormType = entry.transport === "http" ? "http" : "stdio";
		this.mcpFormCommand = typeof entry.config.command === "string" ? entry.config.command : "";
		this.mcpFormArgs = Array.isArray(entry.config.args)
			? (entry.config.args as unknown[]).filter((a): a is string => typeof a === "string").join(" ")
			: "";
		this.mcpFormEnvText = keyValueRecordToText(entry.config.env);
		this.mcpFormUrl = typeof entry.config.url === "string" ? entry.config.url : "";
		this.mcpFormHeadersText = keyValueRecordToText(entry.config.headers);
		this.mcpFormError = "";
		this.requestRender();
	}

	private buildMcpFormConfig(): Record<string, unknown> | null {
		const name = this.mcpFormName.trim();
		if (!name) {
			this.mcpFormError = t("extensions.mcp.nameRequired");
			return null;
		}
		if (!/^[A-Za-z0-9._-]+$/.test(name)) {
			this.mcpFormError = t("extensions.mcp.nameInvalid");
			return null;
		}
		if (this.mcpFormMode === "add" && (this.mcpResult?.servers ?? []).some((s) => s.name === name)) {
			this.mcpFormError = t("extensions.mcp.nameExists");
			return null;
		}

		// 编辑时以原配置为底，保留 adapter 私有字段（directTools/lifecycle 等）。
		const config: Record<string, unknown> = this.mcpFormMode === "edit" ? { ...this.mcpFormBase } : {};
		if (this.mcpFormType === "stdio") {
			const command = this.mcpFormCommand.trim();
			if (!command) {
				this.mcpFormError = t("extensions.mcp.commandRequired");
				return null;
			}
			delete config.url;
			delete config.headers;
			delete config.socket;
			config.command = command;
			const args = this.mcpFormArgs.trim().split(/\s+/).filter((a) => a.length > 0);
			if (args.length > 0) config.args = args;
			else delete config.args;
			const env = parseKeyValueLines(this.mcpFormEnvText);
			if (typeof env === "string") {
				this.mcpFormError = t("extensions.mcp.envInvalid", { line: env });
				return null;
			}
			if (Object.keys(env).length > 0) config.env = env;
			else delete config.env;
		} else {
			const url = this.mcpFormUrl.trim();
			if (!url) {
				this.mcpFormError = t("extensions.mcp.urlRequired");
				return null;
			}
			delete config.command;
			delete config.args;
			delete config.env;
			delete config.cwd;
			delete config.socket;
			config.url = url;
			const headers = parseKeyValueLines(this.mcpFormHeadersText);
			if (typeof headers === "string") {
				this.mcpFormError = t("extensions.mcp.envInvalid", { line: headers });
				return null;
			}
			if (Object.keys(headers).length > 0) config.headers = headers;
			else delete config.headers;
		}
		return config;
	}

	private async saveMcpForm(): Promise<void> {
		const config = this.buildMcpFormConfig();
		if (!config) {
			this.requestRender();
			return;
		}
		this.busyKey = "mcp:form";
		this.mcpFormError = "";
		this.requestRender();
		try {
			const targetFile = this.mcpFormMode === "edit"
				? this.mcpFormSourceFile
				: await this.mcpTargetPath(this.mcpAddTarget);
			await this.mutateMcpServer(targetFile, this.mcpFormName.trim(), () => config);
			this.mcpFormOpen = false;
			this.emitConfigChanged();
			await this.refresh();
		} catch (err) {
			this.mcpFormError = `${t("extensions.mcp.saveFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.busyKey = "";
		}
	}

	// ------------------------------------------------------------------
	// MCP 导入
	// ------------------------------------------------------------------

	private importKey(candidate: McpImportCandidate): string {
		return `${candidate.source_file}::${candidate.name}`;
	}

	private async openImport(): Promise<void> {
		this.importOpen = true;
		this.importLoading = true;
		this.importError = "";
		this.importTarget = this.projectPath ? "project" : "global";
		this.requestRender();
		try {
			const existing = (this.mcpResult?.servers ?? []).map((s) => s.name);
			const candidates = await this.invokeCmd<McpImportCandidate[]>("scan_mcp_import_sources", {
				existingNames: existing,
			});
			this.importCandidates = candidates;
			this.importChecked = new Set(
				candidates.filter((c) => !c.already_configured).map((c) => this.importKey(c)),
			);
		} catch (err) {
			this.importError = errText(err);
		} finally {
			this.importLoading = false;
			this.requestRender();
		}
	}

	private async applyImport(): Promise<void> {
		const selected = this.importCandidates.filter((c) => this.importChecked.has(this.importKey(c)));
		if (selected.length === 0) return;
		this.importApplying = true;
		this.importError = "";
		this.requestRender();
		try {
			const targetFile = await this.mcpTargetPath(this.importTarget);
			const root = asObject(await this.readJson(targetFile));
			const servers = asObject(root.mcpServers);
			for (const candidate of selected) {
				servers[candidate.name] = candidate.config;
			}
			root.mcpServers = servers;
			await this.writeJson(targetFile, root);
			this.message = t("extensions.mcp.importDone", { count: selected.length, path: targetFile });
			this.importOpen = false;
			this.onConfigChanged?.();
			await this.refresh();
		} catch (err) {
			this.importError = `${t("extensions.mcp.importFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.importApplying = false;
		}
	}

	// ------------------------------------------------------------------
	// 已信任项目
	// ------------------------------------------------------------------

	private async removeTrustedProject(entry: TrustedProjectEntry): Promise<void> {
		this.busyKey = `trust:${entry.path}`;
		this.error = "";
		this.requestRender();
		try {
			await this.invokeCmd("set_project_trust", { projectPath: entry.path, trusted: null });
			await this.refresh();
		} catch (err) {
			this.error = `${t("extensions.trust.removeFailed")}${errText(err)}`;
			this.requestRender();
		} finally {
			this.busyKey = "";
		}
	}

	// ------------------------------------------------------------------
	// 渲染
	// ------------------------------------------------------------------

	private renderBadge(label: string, kind: "" | "project" | "warn" = ""): TemplateResult {
		return html`<span class="ext-badge ${kind}">${label}</span>`;
	}

	private renderToggleButton(checked: boolean, disabled: boolean, onClick: () => void): TemplateResult {
		return html`
			<button class="toggle ${checked ? "on" : "off"}" ?disabled=${disabled} @click=${onClick}><span></span></button>
		`;
	}

	private renderMessages(): TemplateResult | typeof nothing {
		if (!this.message && !this.error && !this.loadError) return nothing;
		return html`
			<div class="ext-messages">
				${this.loadError ? html`<div class="settings-desc ext-error">${t("extensions.common.loadFailed")}${this.loadError}</div>` : nothing}
				${this.error ? html`<div class="settings-desc ext-error">${this.error}</div>` : nothing}
				${this.message ? html`<div class="settings-desc ext-ok">${this.message}</div>` : nothing}
			</div>
		`;
	}

	private matchesSearch(fields: Array<string | null | undefined>): boolean {
		const query = this.searchQuery.trim().toLowerCase();
		if (!query) return true;
		return fields.some((field) => (field ?? "").toLowerCase().includes(query));
	}

	private renderViewTab(id: ExtensionsViewId, label: string): TemplateResult {
		const active = this.activeView === id;
		return html`
			<button
				class="ext-tab ${active ? "active" : ""}"
				role="tab"
				aria-selected=${active ? "true" : "false"}
				@click=${() => {
					if (this.activeView !== id) {
						this.activeView = id;
						this.requestRender();
					}
				}}
			>${label}</button>
		`;
	}

	private skillOriginLabel(origin: string): string {
		switch (origin) {
			case "global-pi": return t("extensions.skills.originGlobalPi");
			case "global-agents": return t("extensions.skills.originGlobalAgents");
			case "project-pi": return t("extensions.skills.originProjectPi");
			default: return t("extensions.skills.originProjectAgents");
		}
	}

	private renderSkillCard(skill: SkillEntry): TemplateResult {
		const busy = this.busyKey === `skill:${skill.file_path}` || this.busyKey === "skill:add";
		const color = iconColorFor(skill.name);
		return html`
			<div class="ext-card" title="${this.skillOriginLabel(skill.origin)} · ${skill.file_path}">
				<div class="ext-card-icon" style="background:${color.bg};color:${color.fg};">${nameInitial(skill.name)}</div>
				<div class="ext-card-main">
					<div class="ext-card-title">
						<span class="ext-name">${skill.name}</span>
						${skill.enabled ? nothing : this.renderBadge(t("extensions.common.disabled"), "warn")}
						${skill.loadable ? nothing : this.renderBadge(t("extensions.skills.noDescription"), "warn")}
					</div>
					<div class="ext-card-desc">${skill.description || skill.file_path}</div>
				</div>
				<div class="ext-card-hover">
					<button class="ext-icon-btn" title=${t("extensions.common.openDir")} ?disabled=${busy} @click=${() => void this.openPath(skill.skill_dir)}>${iconFolder()}</button>
					<button class="ext-icon-btn danger" title=${t("extensions.common.moveToTrash")} ?disabled=${busy} @click=${() => void this.trashSkill(skill)}>${iconTrash()}</button>
				</div>
				${this.renderToggleButton(skill.enabled, busy, () => void this.setSkillEnabled(skill, !skill.enabled))}
			</div>
		`;
	}

	private renderSkillsView(): TemplateResult {
		const result = this.skillsResult;
		const all = result?.skills ?? [];
		const filtered = all.filter((s) => this.matchesSearch([s.name, s.description, s.file_path, s.skill_dir]));
		const globalSkills = filtered.filter((s) => s.settings_scope === "global");
		const projectSkills = filtered.filter((s) => s.settings_scope === "project");
		const projectUntrusted = result?.project_trusted === false;
		return html`
			<div class="ext-view">
				<div class="ext-view-head">
					<div class="settings-desc">${t("extensions.skills.desc")}</div>
					<div class="ext-view-head-actions">
						<button class="ghost-btn" @click=${() => { this.skillAddOpen = !this.skillAddOpen; this.requestRender(); }}>
							${t("extensions.skills.addFromPath")}
						</button>
					</div>
				</div>
				${this.skillAddOpen
					? html`
						<div class="ext-inline-form">
							<input
								type="text"
								class="settings-path-input"
								placeholder=${t("extensions.skills.addPlaceholder")}
								.value=${this.skillAddPath}
								@input=${(e: Event) => { this.skillAddPath = (e.target as HTMLInputElement).value; }}
							/>
							<div class="settings-actions">
								<button class="ghost-btn" ?disabled=${this.busyKey === "skill:add" || !this.skillAddPath.trim()} @click=${() => void this.installSkillFromPath()}>
									${this.busyKey === "skill:add" ? t("extensions.skills.adding") : t("extensions.skills.addConfirm")}
								</button>
							</div>
						</div>
					`
					: nothing}
				${this.loading && !result
					? html`<div class="ui-loading compact" role="status" aria-label=${t("extensions.common.loading")}><span class="ui-loading-spinner"></span></div>`
					: all.length === 0
						? html`<div class="settings-empty">${t("extensions.skills.empty")}</div>`
						: filtered.length === 0
							? html`<div class="settings-empty">${t("extensions.page.noMatch")}</div>`
							: html`
								${globalSkills.length > 0
									? html`
										<div class="ext-group-title">${t("extensions.skills.groupGlobal")}</div>
										<div class="ext-card-grid">${globalSkills.map((s) => this.renderSkillCard(s))}</div>
									`
									: nothing}
								${projectSkills.length > 0
									? html`
										<div class="ext-group-title">${t("extensions.skills.groupProject")}</div>
										${projectUntrusted ? html`<div class="settings-desc ext-warn">${t("extensions.skills.untrustedHint")}</div>` : nothing}
										<div class="ext-card-grid">${projectSkills.map((s) => this.renderSkillCard(s))}</div>
									`
									: nothing}
							`}
			</div>
		`;
	}

	private renderLooseCard(entry: LooseExtensionEntry): TemplateResult {
		const busy = this.busyKey === `ext:${entry.file_path}`;
		const color = iconColorFor(entry.name);
		return html`
			<div class="ext-card" title=${entry.file_path}>
				<div class="ext-card-icon mono" style="background:${color.bg};color:${color.fg};">&lt;/&gt;</div>
				<div class="ext-card-main">
					<div class="ext-card-title">
						<span class="ext-name">${entry.name}</span>
						${this.renderBadge(
							entry.origin === "project" ? t("extensions.common.projectBadge") : t("extensions.common.globalBadge"),
							entry.origin === "project" ? "project" : "",
						)}
						${entry.enabled ? nothing : this.renderBadge(t("extensions.common.disabled"), "warn")}
					</div>
					<div class="ext-card-desc">${entry.file_path}</div>
				</div>
				<div class="ext-card-hover">
					<button class="ext-icon-btn" title=${t("extensions.common.openDir")} ?disabled=${busy} @click=${() => void this.openPath(dirOf(entry.file_path))}>${iconFolder()}</button>
				</div>
				${this.renderToggleButton(entry.enabled, busy, () => void this.setLooseEnabled(entry, !entry.enabled))}
			</div>
		`;
	}

	private renderTrustedCard(entry: TrustedProjectEntry): TemplateResult {
		return html`
			<div class="ext-slim-card">
				<div class="ext-card-main">
					<div class="ext-card-title">
						${this.renderBadge(entry.trusted ? t("extensions.trust.trustedLabel") : t("extensions.trust.distrustedLabel"), entry.trusted ? "" : "warn")}
						${entry.exists ? nothing : this.renderBadge(t("extensions.trust.missingDir"), "warn")}
					</div>
					<div class="ext-card-desc"><code>${entry.path}</code></div>
				</div>
				<button class="ghost-btn danger" ?disabled=${this.busyKey === `trust:${entry.path}`} @click=${() => void this.removeTrustedProject(entry)}>
					${t("extensions.trust.remove")}
				</button>
			</div>
		`;
	}

	private renderExtensionsView(): TemplateResult {
		const result = this.looseResult;
		const allLoose = result?.extensions ?? [];
		const loose = allLoose.filter((e) => this.matchesSearch([e.name, e.file_path]));
		const allTrusted = this.trustedProjects;
		const trusted = allTrusted.filter((e) => this.matchesSearch([e.path]));
		return html`
			<div class="ext-view">
				<div class="ext-view-head">
					<div class="settings-desc">${t("extensions.loose.desc")}</div>
				</div>
				${this.loading && !result
					? html`<div class="ui-loading compact" role="status" aria-label=${t("extensions.common.loading")}><span class="ui-loading-spinner"></span></div>`
					: allLoose.length === 0
						? html`<div class="settings-empty">${t("extensions.loose.empty")}</div>`
						: loose.length === 0
							? html`<div class="settings-empty">${t("extensions.page.noMatch")}</div>`
							: html`<div class="ext-card-grid">${loose.map((entry) => this.renderLooseCard(entry))}</div>`}
				<div class="ext-slim-card">
					<div class="ext-card-main">
						<div class="ext-card-title">${t("extensions.packagesEntry.title")}</div>
						<div class="ext-card-desc">${t("extensions.packagesEntry.desc")}</div>
					</div>
					<button class="ghost-btn" @click=${() => this.onOpenPackages?.()}>${t("extensions.packagesEntry.open")}</button>
				</div>
				<div class="ext-group-title">${t("extensions.trust.title")}</div>
				<div class="settings-desc">${t("extensions.trust.desc")}</div>
				${this.loading && allTrusted.length === 0
					? html`<div class="ui-loading compact" role="status" aria-label=${t("extensions.common.loading")}><span class="ui-loading-spinner"></span></div>`
					: allTrusted.length === 0
						? html`<div class="settings-empty">${t("extensions.trust.empty")}</div>`
						: trusted.length === 0
							? html`<div class="settings-empty">${t("extensions.page.noMatch")}</div>`
							: trusted.map((entry) => this.renderTrustedCard(entry))}
			</div>
		`;
	}

	private renderMcpServerCard(entry: McpServerEntry): TemplateResult {
		const busy = this.busyKey === `mcp:${entry.name}`;
		const color = iconColorFor(entry.name);
		return html`
			<div class="ext-card" title=${entry.source_file}>
				<div class="ext-card-icon" style="background:${color.bg};color:${color.fg};">${nameInitial(entry.name)}</div>
				<div class="ext-card-main">
					<div class="ext-card-title">
						<span class="ext-name">${entry.name}</span>
						${this.renderBadge(entry.transport)}
						${this.renderBadge(entry.layer_label, entry.layer.startsWith("project") || entry.layer.startsWith("pi-project") ? "project" : "")}
						${entry.disabled ? this.renderBadge(t("extensions.mcp.disabledBadge"), "warn") : nothing}
					</div>
					<div class="ext-card-desc">${entry.summary || entry.source_file}</div>
					${entry.overridden_files.length > 0
						? html`<div class="ext-card-note">${t("extensions.mcp.overriddenNote", { files: entry.overridden_files.join(", ") })}</div>`
						: nothing}
				</div>
				<div class="ext-card-hover">
					<button class="ext-icon-btn" title=${t("extensions.common.edit")} ?disabled=${busy} @click=${() => this.openMcpEditForm(entry)}>${iconEdit()}</button>
					<button class="ext-icon-btn danger" title=${t("extensions.common.delete")} ?disabled=${busy} @click=${() => void this.deleteMcpServer(entry)}>${iconTrash()}</button>
				</div>
				${this.renderToggleButton(!entry.disabled, busy, () => void this.toggleMcpServer(entry))}
			</div>
		`;
	}

	private renderMcpForm(): TemplateResult {
		const servers = this.mcpResult?.servers ?? [];
		void servers;
		return html`
			<div class="ext-inline-form">
				<div class="settings-label">${this.mcpFormMode === "add" ? t("extensions.mcp.formTitleAdd") : t("extensions.mcp.formTitleEdit")}</div>
				<div class="ext-form-grid">
					<label>${t("extensions.mcp.fieldName")}</label>
					<input
						type="text"
						class="settings-path-input"
						.value=${this.mcpFormName}
						?disabled=${this.mcpFormMode === "edit"}
						@input=${(e: Event) => { this.mcpFormName = (e.target as HTMLInputElement).value; }}
					/>
					<label>${t("extensions.mcp.fieldType")}</label>
					${this.mcpFormTypeSelect.render({
						ariaLabel: t("extensions.mcp.fieldType"),
						value: this.mcpFormType,
						options: [
							{ value: "stdio", label: t("extensions.mcp.typeStdio") },
							{ value: "http", label: t("extensions.mcp.typeHttp") },
						],
						onSelect: (value) => { this.mcpFormType = value === "http" ? "http" : "stdio"; },
					})}
					${this.mcpFormType === "stdio"
						? html`
							<label>${t("extensions.mcp.fieldCommand")}</label>
							<input type="text" class="settings-path-input" placeholder="npx" .value=${this.mcpFormCommand} @input=${(e: Event) => { this.mcpFormCommand = (e.target as HTMLInputElement).value; }} />
							<label>${t("extensions.mcp.fieldArgs")}</label>
							<input type="text" class="settings-path-input" placeholder="-y some-mcp-server" .value=${this.mcpFormArgs} @input=${(e: Event) => { this.mcpFormArgs = (e.target as HTMLInputElement).value; }} />
							<label>${t("extensions.mcp.fieldEnv")}</label>
							<textarea class="ext-kv-textarea" rows="3" placeholder="API_KEY=xxx" .value=${this.mcpFormEnvText} @input=${(e: Event) => { this.mcpFormEnvText = (e.target as HTMLTextAreaElement).value; }}></textarea>
						`
						: html`
							<label>${t("extensions.mcp.fieldUrl")}</label>
							<input type="text" class="settings-path-input" placeholder="https://mcp.example.com/mcp" .value=${this.mcpFormUrl} @input=${(e: Event) => { this.mcpFormUrl = (e.target as HTMLInputElement).value; }} />
							<label>${t("extensions.mcp.fieldHeaders")}</label>
							<textarea class="ext-kv-textarea" rows="3" placeholder="Authorization=Bearer xxx" .value=${this.mcpFormHeadersText} @input=${(e: Event) => { this.mcpFormHeadersText = (e.target as HTMLTextAreaElement).value; }}></textarea>
						`}
					${this.mcpFormMode === "add"
						? html`
							<label>${t("extensions.mcp.fieldTarget")}</label>
							${this.mcpAddTargetSelect.render({
								ariaLabel: t("extensions.mcp.fieldTarget"),
								value: this.mcpAddTarget,
								options: [
									...(this.projectPath ? [{ value: "project", label: t("extensions.mcp.targetProject") }] : []),
									{ value: "global", label: t("extensions.mcp.targetGlobal") },
								],
								onSelect: (value) => { this.mcpAddTarget = value === "project" ? "project" : "global"; },
							})}
						`
						: nothing}
				</div>
				${this.mcpFormMode === "edit" ? html`<div class="settings-desc">${t("extensions.mcp.adapterPrivateNote")}</div>` : nothing}
				${this.mcpFormError ? html`<div class="settings-desc ext-error">${this.mcpFormError}</div>` : nothing}
				<div class="settings-actions">
					<button class="ghost-btn" ?disabled=${this.busyKey === "mcp:form"} @click=${() => void this.saveMcpForm()}>
						${this.busyKey === "mcp:form" ? t("extensions.common.saving") : t("extensions.common.save")}
					</button>
					<button class="ghost-btn" @click=${() => { this.mcpFormOpen = false; this.requestRender(); }}>${t("extensions.common.cancel")}</button>
				</div>
			</div>
		`;
	}

	private renderImportPanel(): TemplateResult {
		const candidates = this.importCandidates;
		return html`
			<div class="ext-inline-form">
				<div class="settings-label">${t("extensions.mcp.importTitle")}</div>
				<div class="settings-desc">${t("extensions.mcp.importDesc")}</div>
				${this.importLoading
					? html`<div class="ui-loading compact" role="status" aria-label=${t("extensions.common.loading")}><span class="ui-loading-spinner"></span></div>`
					: candidates.length === 0
						? html`<div class="settings-empty">${t("extensions.mcp.importEmpty")}</div>`
						: html`
							${candidates.map((candidate) => {
								const key = this.importKey(candidate);
								return html`
									<label class="ext-import-row">
										<input
											type="checkbox"
											.checked=${this.importChecked.has(key)}
											@change=${(e: Event) => {
												if ((e.target as HTMLInputElement).checked) this.importChecked.add(key);
												else this.importChecked.delete(key);
												this.requestRender();
											}}
										/>
										<span class="ext-name">${candidate.name}</span>
										${this.renderBadge(candidate.source_tool)}
										${this.renderBadge(candidate.transport)}
										${candidate.already_configured ? this.renderBadge(t("extensions.mcp.alreadyConfigured"), "warn") : nothing}
										<code class="ext-import-summary">${candidate.summary}</code>
									</label>
								`;
							})}
							<div class="ext-form-grid">
								<label>${t("extensions.mcp.importTarget")}</label>
								${this.importTargetSelect.render({
									ariaLabel: t("extensions.mcp.importTarget"),
									value: this.importTarget,
									options: [
										...(this.projectPath ? [{ value: "project", label: t("extensions.mcp.targetProject") }] : []),
										{ value: "global", label: t("extensions.mcp.targetGlobal") },
									],
									onSelect: (value) => { this.importTarget = value === "project" ? "project" : "global"; },
								})}
							</div>
						`}
				${this.importError ? html`<div class="settings-desc ext-error">${this.importError}</div>` : nothing}
				<div class="settings-actions">
					<button class="ghost-btn" ?disabled=${this.importApplying || this.importChecked.size === 0} @click=${() => void this.applyImport()}>
						${t("extensions.mcp.importConfirm", { count: this.importChecked.size })}
					</button>
					<button class="ghost-btn" @click=${() => { this.importOpen = false; this.requestRender(); }}>${t("extensions.common.cancel")}</button>
				</div>
			</div>
		`;
	}

	private renderMcpView(): TemplateResult {
		const result = this.mcpResult;
		const allServers = result?.servers ?? [];
		const servers = allServers.filter((s) => this.matchesSearch([s.name, s.summary, s.source_file, s.transport, s.layer_label]));
		const files = result?.files ?? [];
		return html`
			<div class="ext-view">
				<div class="ext-view-head">
					<div class="settings-desc">${t("extensions.mcp.desc")}</div>
					<div class="ext-view-head-actions">
						<button class="ghost-btn" @click=${() => this.openMcpAddForm()}>${t("extensions.mcp.addServer")}</button>
						<button class="ghost-btn" @click=${() => void this.openImport()}>${t("extensions.mcp.importFromTools")}</button>
					</div>
				</div>
				${this.adapterInstalled === null
					? this.adapterChecking
						? html`<div class="ui-loading compact" role="status" aria-label=${t("extensions.mcp.checkingAdapter")}><span class="ui-loading-spinner"></span></div>`
						: nothing
					: this.adapterInstalled === false
						? html`
							<div class="ext-guide">
								<div class="settings-label">${t("extensions.mcp.adapterMissingTitle")}</div>
								<div class="settings-desc">${t("extensions.mcp.adapterMissingDesc")}</div>
								<div class="settings-actions">
									<button class="ghost-btn" ?disabled=${this.adapterInstalling} @click=${() => void this.installAdapter()}>
										${this.adapterInstalling ? t("extensions.mcp.installing") : t("extensions.mcp.installAdapter")}
									</button>
								</div>
								${this.adapterInstallLog ? html`<pre class="ext-log">${this.adapterInstallLog}</pre>` : nothing}
							</div>
						`
						: nothing}
				${this.mcpFormOpen ? this.renderMcpForm() : nothing}
				${this.importOpen ? this.renderImportPanel() : nothing}
				${this.loading && !result
					? html`<div class="ui-loading compact" role="status" aria-label=${t("extensions.common.loading")}><span class="ui-loading-spinner"></span></div>`
					: allServers.length === 0
						? html`<div class="settings-empty">${t("extensions.mcp.empty")}</div>`
						: servers.length === 0
							? html`<div class="settings-empty">${t("extensions.page.noMatch")}</div>`
							: html`<div class="ext-card-grid">${servers.map((entry) => this.renderMcpServerCard(entry))}</div>`}
				${files.length > 0
					? html`
						<details class="settings-advanced">
							<summary>${t("extensions.mcp.filesTitle")}</summary>
							${files.map((file) => html`
								<div class="ext-row-path">
									${this.renderBadge(file.layer_label)}
									<code>${file.path}</code>
									${file.error
										? html`<span class="ext-error"> ${t("extensions.mcp.fileError")}: ${file.error}</span>`
										: file.exists
											? html`<span class="settings-desc"> · ${t("extensions.mcp.serverCount", { count: file.server_count })}</span>`
											: html`<span class="settings-desc"> · ${t("extensions.mcp.fileMissing")}</span>`}
								</div>
							`)}
						</details>
					`
					: nothing}
			</div>
		`;
	}

	render(): TemplateResult {
		return html`
			<div class="ext-page">
				${this.renderMessages()}
				<div class="ext-page-subtitle">${t("extensions.page.subtitle")}</div>
				<input
					class="ext-search-input"
					type="search"
					spellcheck="false"
					placeholder=${t("extensions.page.searchPlaceholder")}
					.value=${this.searchQuery}
					@input=${(e: Event) => {
						this.searchQuery = (e.target as HTMLInputElement).value;
						this.requestRender();
					}}
				/>
				<div class="ext-tabs-row">
					<div class="ext-tabs" role="tablist">
						${this.renderViewTab("skills", t("extensions.page.tabSkills"))}
						${this.renderViewTab("extensions", t("extensions.page.tabExtensions"))}
						${this.renderViewTab("mcp", t("extensions.page.tabMcp"))}
					</div>
					<button class="ghost-btn" ?disabled=${this.loading} @click=${() => void this.refresh()}>${t("extensions.common.refresh")}</button>
				</div>
				${this.activeView === "skills"
					? this.renderSkillsView()
					: this.activeView === "extensions"
						? this.renderExtensionsView()
						: this.renderMcpView()}
			</div>
		`;
	}
}
