/**
 * TerminalPanel - docked terminal experience (xterm surface + local shell execution)
 */

import { Command, type Child } from "@tauri-apps/plugin-shell";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { html, render } from "lit";
import { t } from "../i18n/index.js";

type ShellKind = "posix" | "powershell" | "cmd";

interface ShellProfile {
	name: string;
	label: string;
	kind: ShellKind;
}

interface TerminalExecResult {
	code: number | null;
	signal: number | null;
	stdout: string;
	stderr: string;
}

interface TerminalCommandResolution {
	shellCommand: string;
	infoText: string | null;
	interactive: boolean;
	initialInput: string[];
	initialInputStartDelayMs: number;
	initialInputInterChunkDelayMs: number;
}

interface TerminalCommandCompleteEvent {
	command: string;
	interactive: boolean;
	result: TerminalExecResult | null;
}

/** 排队命令：入队时固定当时的工作目录，避免跨项目/跨目录误执行。 */
interface QueuedTerminalCommand {
	command: string;
	cwd: string | null;
	projectGeneration: number;
}

interface TerminalExecutionToken {
	id: number;
	cwd: string;
	projectGeneration: number;
}

function normalizeText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function toUint8Array(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
		return Uint8Array.from(value);
	}
	if (value && typeof value === "object") {
		const candidate = (value as { data?: unknown }).data;
		if (Array.isArray(candidate) && candidate.every((item) => typeof item === "number")) {
			return Uint8Array.from(candidate);
		}
	}
	return null;
}

function shellProfilesForPlatform(): ShellProfile[] {
	const platform = navigator.platform.toLowerCase();
	if (platform.includes("win")) {
		return [
			{ name: "terminal-pwsh-exe", label: "pwsh", kind: "powershell" },
			{ name: "terminal-pwsh", label: "pwsh", kind: "powershell" },
			{ name: "terminal-cmd-exe", label: "cmd", kind: "cmd" },
			{ name: "terminal-cmd", label: "cmd", kind: "cmd" },
		];
	}
	if (platform.includes("mac")) {
		return [
			{ name: "terminal-zsh-path", label: "zsh", kind: "posix" },
			{ name: "terminal-zsh", label: "zsh", kind: "posix" },
			{ name: "terminal-bash-path", label: "bash", kind: "posix" },
			{ name: "terminal-bash", label: "bash", kind: "posix" },
			{ name: "terminal-sh-path", label: "sh", kind: "posix" },
			{ name: "terminal-sh", label: "sh", kind: "posix" },
		];
	}
	return [
		{ name: "terminal-bash-path", label: "bash", kind: "posix" },
		{ name: "terminal-bash", label: "bash", kind: "posix" },
		{ name: "terminal-sh-path", label: "sh", kind: "posix" },
		{ name: "terminal-sh", label: "sh", kind: "posix" },
	];
}

function compactPath(path: string | null): string {
	if (!path) return "~";
	const normalized = path.replace(/\\/g, "/");
	const globalHome = (globalThis as { __PI_HOME__?: string }).__PI_HOME__;
	const home = (typeof globalHome === "string" ? globalHome : "").replace(/\\/g, "/").replace(/\/+$/, "");
	if (home && normalized.startsWith(home)) {
		const suffix = normalized.slice(home.length).replace(/^\//, "");
		return suffix ? `~/${suffix}` : "~";
	}
	return normalized;
}

function isPrintableKey(event: KeyboardEvent, key: string): boolean {
	if (event.ctrlKey || event.metaKey || event.altKey) return false;
	return key.length === 1;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class TerminalPanel {
	private container: HTMLElement;
	/** 外层当前项目根目录；与用户通过 cd 改变的 cwd 分离。 */
	private projectPath: string | null = null;
	private cwd: string | null = null;
	private running = false;
	private onRequestClose: (() => void) | null = null;
	private onCommandComplete: ((event: TerminalCommandCompleteEvent) => void | Promise<void>) | null = null;

	private xterm: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private resizeObserver: ResizeObserver | null = null;

	private inputBuffer = "";
	private commandHistory: string[] = [];
	private commandHistoryIndex = -1;
	private commandHistoryDraft = "";

	private shellProfile: ShellProfile | null = null;
	private resolvingShellProfile: Promise<ShellProfile> | null = null;
	private runningChild: Child | null = null;
	private runningInteractive = false;
	/** 项目切换的单调代际；即使 A→B→A 回到相同路径，旧执行仍会因代际不同而失效。 */
	private projectGeneration = 0;
	private executionGeneration = 0;
	private activeExecution: TerminalExecutionToken | null = null;
	private suppressPromptOnce = false;
	private queuedCommands: QueuedTerminalCommand[] = [];
	private clipboardEventHandlersInstalled = false;

	constructor(container: HTMLElement) {
		this.container = container;
		this.render();
	}

	setOnRequestClose(cb: () => void): void {
		this.onRequestClose = cb;
	}

	setOnCommandComplete(cb: (event: TerminalCommandCompleteEvent) => void | Promise<void>): void {
		this.onCommandComplete = cb;
	}

	setProjectPath(path: string | null): void {
		const next = path && path.trim().length > 0 ? path : null;
		if (this.projectPath === next) return;
		// 切换项目时取消旧项目的排队命令，避免在新项目目录误执行。
		const cancelledCount = this.queuedCommands.length;
		this.queuedCommands = [];
		// 执行中命令同样作废：代际变化后其结果与输出会被丢弃（见 executeCommand 的 token 判定）。
		const hadRunningCommand = this.running;
		this.projectGeneration += 1;
		this.projectPath = next;
		this.cwd = next;
		if (cancelledCount > 0) {
			this.writeInfo(t("panels.terminal.queueCancelledOnProjectSwitch", { count: cancelledCount }));
		}
		if (hadRunningCommand) {
			this.writeInfo(t("panels.terminal.runningDiscardedOnProjectSwitch"));
		}
		this.render();
	}

	focusInput(): void {
		this.xterm?.focus();
	}

	async runCommand(commandText: string): Promise<void> {
		const command = commandText.trim();
		if (!command) return;
		this.ensureTerminal();
		this.focusInput();
		if (this.running) {
			this.queuedCommands.push({
				command,
				cwd: this.cwd,
				projectGeneration: this.projectGeneration,
			});
			this.writeInfo(t("panels.terminal.queued", { command }));
			return;
		}
		this.xterm?.write(`${command}\r\n`);
		const cwd = this.cwd;
		await this.executeCommand(command, {
			command,
			cwd,
			projectGeneration: this.projectGeneration,
		});
	}

	private applyTheme(): void {
		if (!this.xterm) return;
		const styles = getComputedStyle(document.documentElement);
		const panelRoot = this.container.querySelector<HTMLElement>(".terminal-panel-root");
		const panelStyles = panelRoot ? getComputedStyle(panelRoot) : styles;
		const background = panelStyles.getPropertyValue("--terminal-panel-bg").trim() || styles.getPropertyValue("--bg").trim() || "#0f1115";
		const foreground = styles.getPropertyValue("--text").trim() || "#d7dce2";
		const muted = styles.getPropertyValue("--muted").trim() || "#95a1b2";
		const accent = styles.getPropertyValue("--accent").trim() || foreground;
		this.xterm.options.theme = {
			background,
			foreground,
			cursor: accent,
			cursorAccent: background,
			selectionBackground: muted,
		};
	}

	private ensureTerminal(): void {
		const viewport = this.container.querySelector<HTMLElement>("#terminal-viewport");
		if (!viewport) return;

		if (!this.xterm) {
			this.fitAddon = new FitAddon();
			this.xterm = new Terminal({
				cursorBlink: true,
				cursorStyle: "bar",
				cursorWidth: 2,
				convertEol: true,
				scrollback: 6000,
				fontSize: 12,
				lineHeight: 1.35,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
			});
			this.xterm.loadAddon(this.fitAddon);
			this.applyTheme();
			this.xterm.open(viewport);
			this.fitAddon.fit();
			this.installKeyboardBindings();
			this.installClipboardEventHandlers(this.container);
			this.printPrompt();
		}

		if (!this.resizeObserver) {
			this.resizeObserver = new ResizeObserver(() => {
				this.fitAddon?.fit();
			});
			this.resizeObserver.observe(viewport);
		}
	}

	private isMacPlatform(): boolean {
		return navigator.platform.toLowerCase().includes("mac");
	}

	private isCopyShortcut(event: KeyboardEvent): boolean {
		const key = event.key.toLowerCase();
		if (this.isMacPlatform()) {
			return event.metaKey && !event.ctrlKey && !event.altKey && key === "c";
		}
		return event.ctrlKey && event.shiftKey && !event.metaKey && key === "c";
	}

	private isPasteShortcut(event: KeyboardEvent): boolean {
		const key = event.key.toLowerCase();
		if (this.isMacPlatform()) {
			return event.metaKey && !event.ctrlKey && !event.altKey && key === "v";
		}
		if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "v") return true;
		return event.shiftKey && key === "insert";
	}

	private isSelectAllShortcut(event: KeyboardEvent): boolean {
		const key = event.key.toLowerCase();
		if (this.isMacPlatform()) {
			return event.metaKey && !event.ctrlKey && !event.altKey && key === "a";
		}
		return event.ctrlKey && event.shiftKey && !event.metaKey && key === "a";
	}

	private async copySelectionToClipboard(): Promise<void> {
		const selection = this.xterm?.getSelection() ?? "";
		if (!selection) return;
		try {
			await navigator.clipboard.writeText(selection);
		} catch {
			// Ignore clipboard failures in restricted environments.
		}
	}

	private handlePastedText(rawText: string): void {
		if (!rawText) return;
		const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (!normalized) return;

		if (this.running) {
			if (this.runningInteractive && this.runningChild) {
				this.writeToRunningChild(normalized.replace(/\n/g, "\r"));
			}
			return;
		}

		const inline = normalized.replace(/\n+/g, " ");
		if (!inline) return;
		this.inputBuffer += inline;
		this.xterm?.write(inline);
		this.scrollTerminalToBottom();
	}

	private async pasteFromClipboard(): Promise<void> {
		try {
			const text = await navigator.clipboard.readText();
			this.handlePastedText(text);
		} catch {
			// Ignore clipboard failures in restricted environments.
		}
	}

	private installClipboardEventHandlers(target: HTMLElement): void {
		if (this.clipboardEventHandlersInstalled) return;
		target.addEventListener("paste", (event: ClipboardEvent) => {
			const text = event.clipboardData?.getData("text") ?? "";
			if (!text) return;
			event.preventDefault();
			this.handlePastedText(text);
		});
		target.addEventListener("copy", (event: ClipboardEvent) => {
			const selection = this.xterm?.getSelection() ?? "";
			if (!selection) return;
			event.clipboardData?.setData("text/plain", selection);
			event.preventDefault();
		});
		this.clipboardEventHandlersInstalled = true;
	}

	private installKeyboardBindings(): void {
		if (!this.xterm) return;
		this.xterm.onKey(({ key, domEvent }) => {
			if (this.isCopyShortcut(domEvent)) {
				domEvent.preventDefault();
				void this.copySelectionToClipboard();
				return;
			}

			if (this.isPasteShortcut(domEvent)) {
				if (this.isMacPlatform() && domEvent.metaKey) {
					void this.pasteFromClipboard();
					return;
				}
				domEvent.preventDefault();
				void this.pasteFromClipboard();
				return;
			}

			if (this.isSelectAllShortcut(domEvent)) {
				domEvent.preventDefault();
				this.xterm?.selectAll();
				return;
			}

			if (domEvent.ctrlKey && !domEvent.metaKey && domEvent.key.toLowerCase() === "c") {
				domEvent.preventDefault();
				if (this.running) {
					void this.abortRunningCommand();
				} else {
					this.clearCurrentInput();
					this.xterm?.write("^C\r\n");
					this.printPrompt();
				}
				return;
			}

			if (this.running) {
				domEvent.preventDefault();
				if (this.runningInteractive && this.runningChild) {
					if (domEvent.key === "Enter") {
						this.writeToRunningChild("\r");
						return;
					}
					if (domEvent.key === "Backspace") {
						this.writeToRunningChild("\x7f");
						return;
					}
					if (domEvent.key === "ArrowUp") {
						this.writeToRunningChild("\x1b[A");
						return;
					}
					if (domEvent.key === "ArrowDown") {
						this.writeToRunningChild("\x1b[B");
						return;
					}
					if (domEvent.key === "ArrowLeft") {
						this.writeToRunningChild("\x1b[D");
						return;
					}
					if (domEvent.key === "ArrowRight") {
						this.writeToRunningChild("\x1b[C");
						return;
					}
					if (domEvent.key === "Tab") {
						this.writeToRunningChild("\t");
						return;
					}
					if (isPrintableKey(domEvent, key)) {
						this.writeToRunningChild(key);
					}
				}
				return;
			}

			if (domEvent.key === "Enter") {
				domEvent.preventDefault();
				const command = this.inputBuffer;
				this.inputBuffer = "";
				this.xterm?.write("\r\n");
				void this.executeCommand(command);
				return;
			}

			if (domEvent.key === "Backspace") {
				domEvent.preventDefault();
				if (this.inputBuffer.length === 0) return;
				this.inputBuffer = this.inputBuffer.slice(0, -1);
				this.xterm?.write("\b \b");
				return;
			}

			if (domEvent.key === "ArrowUp") {
				domEvent.preventDefault();
				this.navigateHistory("up");
				return;
			}

			if (domEvent.key === "ArrowDown") {
				domEvent.preventDefault();
				this.navigateHistory("down");
				return;
			}

			if (domEvent.ctrlKey && !domEvent.metaKey && domEvent.key.toLowerCase() === "l") {
				domEvent.preventDefault();
				this.clearScreen();
				return;
			}

			if (!isPrintableKey(domEvent, key)) return;
			this.inputBuffer += key;
			this.xterm?.write(key);
		});
	}

	private replaceCurrentInput(value: string): void {
		if (!this.xterm) return;
		for (let i = 0; i < this.inputBuffer.length; i += 1) {
			this.xterm.write("\b \b");
		}
		this.inputBuffer = value;
		if (value) this.xterm.write(value);
	}

	private navigateHistory(direction: "up" | "down"): void {
		if (this.commandHistory.length === 0) return;
		if (direction === "up") {
			if (this.commandHistoryIndex < 0) {
				this.commandHistoryDraft = this.inputBuffer;
				this.commandHistoryIndex = this.commandHistory.length - 1;
			} else if (this.commandHistoryIndex > 0) {
				this.commandHistoryIndex -= 1;
			}
			const next = this.commandHistory[this.commandHistoryIndex] ?? "";
			this.replaceCurrentInput(next);
			return;
		}

		if (this.commandHistoryIndex < 0) return;
		if (this.commandHistoryIndex < this.commandHistory.length - 1) {
			this.commandHistoryIndex += 1;
			const next = this.commandHistory[this.commandHistoryIndex] ?? "";
			this.replaceCurrentInput(next);
			return;
		}

		this.commandHistoryIndex = -1;
		this.replaceCurrentInput(this.commandHistoryDraft);
	}

	private rememberHistory(command: string): void {
		const trimmed = command.trim();
		if (!trimmed) return;
		const last = this.commandHistory[this.commandHistory.length - 1] ?? "";
		if (last !== trimmed) {
			this.commandHistory.push(trimmed);
			if (this.commandHistory.length > 150) {
				this.commandHistory.splice(0, this.commandHistory.length - 150);
			}
		}
		this.commandHistoryIndex = -1;
		this.commandHistoryDraft = "";
	}

	private clearCurrentInput(): void {
		this.replaceCurrentInput("");
	}

	private writeToRunningChild(value: string): void {
		const child = this.runningChild;
		if (!child || !value) return;
		void child.write(value).catch(() => {
			// Ignore transient stdin write failures while process is exiting.
		});
	}

	private scrollTerminalToBottom(): void {
		requestAnimationFrame(() => {
			this.xterm?.scrollToBottom();
		});
	}

	private printPrompt(): void {
		if (!this.xterm) return;
		this.commandHistoryIndex = -1;
		this.commandHistoryDraft = "";
		this.xterm.write("\x1b[34m$\x1b[0m ");
		this.scrollTerminalToBottom();
	}

	private writeInfo(text: string): void {
		if (!this.xterm) return;
		this.xterm.writeln(`\x1b[90m${text}\x1b[0m`);
		this.scrollTerminalToBottom();
	}

	private writeStdErr(text: string): void {
		if (!this.xterm) return;
		const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		for (const line of lines) {
			if (!line) continue;
			this.xterm.writeln(`\x1b[31m${line}\x1b[0m`);
		}
		this.scrollTerminalToBottom();
	}

	private writeRawOutput(text: string): void {
		if (!this.xterm || !text) return;
		this.xterm.write(text);
		this.scrollTerminalToBottom();
	}

	private decodeOutputChunk(payload: unknown, decoder: TextDecoder | null): string {
		if (typeof payload === "string") return payload;
		const bytes = toUint8Array(payload);
		if (bytes) {
			if (!decoder) {
				return new TextDecoder().decode(bytes);
			}
			return decoder.decode(bytes, { stream: true });
		}
		return normalizeText(payload);
	}

	private writeStdOut(text: string): void {
		if (!this.xterm) return;
		if (!text) return;
		const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
		this.xterm.write(normalized);
		this.scrollTerminalToBottom();
	}

	private isCdCommand(command: string): boolean {
		return /^cd(?:\s+.*)?$/i.test(command.trim());
	}

	private withPosixPathPrelude(command: string): string {
		const prelude = [
			"if [ -n \"$HOME\" ]; then",
			"if [ -d \"$HOME/.nvm/versions/node/current/bin\" ]; then PATH=\"$HOME/.nvm/versions/node/current/bin:$PATH\"; fi",
			"for d in \"$HOME\"/.nvm/versions/node/*/bin; do if [ -d \"$d\" ]; then PATH=\"$d:$PATH\"; fi; done",
			"if [ -d \"$HOME/.volta/bin\" ]; then PATH=\"$HOME/.volta/bin:$PATH\"; fi",
			"if [ -d \"$HOME/.local/bin\" ]; then PATH=\"$HOME/.local/bin:$PATH\"; fi",
			"fi",
			"PATH=\"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH\"",
			"export PATH",
		].join("; ");
		return `${prelude}; ${command}`;
	}

	private buildShellArgs(profile: ShellProfile, command: string): string[] {
		switch (profile.kind) {
			case "powershell":
				return ["-NoLogo", "-NoProfile", "-Command", command];
			case "cmd":
				return ["/C", command];
			default:
				return ["-lc", this.withPosixPathPrelude(command)];
		}
	}

	private buildShellProbeArgs(profile: ShellProfile): string[] {
		switch (profile.kind) {
			case "powershell":
				return ["-NoLogo", "-NoProfile", "-Command", "Write-Output __PI_SHELL_OK__"];
			case "cmd":
				return ["/C", "echo __PI_SHELL_OK__"];
			default:
				return ["-lc", this.withPosixPathPrelude("printf __PI_SHELL_OK__")];
		}
	}

	private buildCdProbeCommand(profile: ShellProfile, cdCommand: string): string {
		switch (profile.kind) {
			case "powershell":
				return `${cdCommand}; (Get-Location).Path`;
			case "cmd":
				return `${cdCommand} && cd`;
			default:
				return `${cdCommand}\npwd`;
		}
	}

	private getCurrentTerminalDimensions(): { cols: number; rows: number } {
		const cols = Math.max(60, Math.floor(this.xterm?.cols ?? 120));
		const rows = Math.max(18, Math.floor(this.xterm?.rows ?? 36));
		return { cols, rows };
	}

	private buildPiInteractiveBridgeCommand(dimensions?: { cols: number; rows: number }): string | null {
		const platform = navigator.platform.toLowerCase();
		if (platform.includes("win")) return null;
		const cols = Math.max(60, Math.floor(dimensions?.cols ?? 120));
		const rows = Math.max(18, Math.floor(dimensions?.rows ?? 36));
		const boot = `stty cols ${cols} rows ${rows} 2>/dev/null; exec pi`;
		if (platform.includes("mac")) {
			return `script -q /dev/null /bin/sh -lc ${shellSingleQuote(boot)}`;
		}
		return `script -q -c ${shellSingleQuote(boot)} /dev/null`;
	}

	private resolveSpecialShellCommand(command: string): TerminalCommandResolution {
		const trimmed = command.trim();
		const piCommand = this.buildPiInteractiveBridgeCommand(this.getCurrentTerminalDimensions());
		if (piCommand) {
			if (/^pi$/i.test(trimmed)) {
				return {
					shellCommand: piCommand,
					infoText: t("panels.terminal.piInteractive"),
					interactive: true,
					initialInput: [],
					initialInputStartDelayMs: 0,
					initialInputInterChunkDelayMs: 0,
				};
			}
			const loginMatch = trimmed.match(/^pi\s+login(?:\s+([a-z0-9._-]+))?$/i);
			if (loginMatch) {
				const requestedProvider = (loginMatch[1] ?? "").trim().toLowerCase();
				const infoText = requestedProvider
					? t("panels.terminal.piLoginProvider", { provider: requestedProvider })
					: t("panels.terminal.piLogin");
				return {
					shellCommand: piCommand,
					infoText,
					interactive: true,
					initialInput: ["/login\r"],
					initialInputStartDelayMs: 1000,
					initialInputInterChunkDelayMs: 0,
				};
			}

			const logoutMatch = trimmed.match(/^pi\s+logout(?:\s+([a-z0-9._-]+))?$/i);
			if (logoutMatch) {
				const requestedProvider = (logoutMatch[1] ?? "").trim().toLowerCase();
				const infoText = requestedProvider
					? t("panels.terminal.piLogoutProvider", { provider: requestedProvider })
					: t("panels.terminal.piLogout");
				return {
					shellCommand: piCommand,
					infoText,
					interactive: true,
					initialInput: [],
					initialInputStartDelayMs: 0,
					initialInputInterChunkDelayMs: 0,
				};
			}
		}
		return {
			shellCommand: command,
			infoText: null,
			interactive: false,
			initialInput: [],
			initialInputStartDelayMs: 0,
			initialInputInterChunkDelayMs: 0,
		};
	}

	private async ensureShellProfile(cwd: string): Promise<ShellProfile> {
		if (this.shellProfile) return this.shellProfile;
		if (this.resolvingShellProfile) return this.resolvingShellProfile;
		this.resolvingShellProfile = (async () => {
			const profiles = shellProfilesForPlatform();
			const failures: string[] = [];
			for (const profile of profiles) {
				try {
					const probe = await Command.create(profile.name, this.buildShellProbeArgs(profile), {
						cwd,
					}).execute();
					if ((probe.code ?? 1) === 0) {
						this.shellProfile = profile;
						return profile;
					}
					failures.push(`${profile.name}: probe exit ${probe.code ?? -1}`);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					failures.push(`${profile.name}: ${message}`);
				}
			}
			const preview = failures.slice(0, 2).join(" | ");
			throw new Error(
				`${t("panels.terminal.noShell")}${preview ? ` (${preview})` : ""}`,
			);
		})();
		try {
			return await this.resolvingShellProfile;
		} finally {
			this.resolvingShellProfile = null;
		}
	}

	private isSpawnScopeError(error: unknown): boolean {
		const message = normalizeText(error).toLowerCase();
		return message.includes("allow-spawn") || message.includes("configured shell scope") || message.includes("program not allowed");
	}

	private async executeShellViaExecute(
		profile: ShellProfile,
		command: string,
		cwd: string,
		streamOutput: boolean,
		outputAllowed: () => boolean = () => true,
	): Promise<TerminalExecResult> {
		const output = await Command.create(profile.name, this.buildShellArgs(profile, command), {
			cwd,
		}).execute();
		const stdout = normalizeText(output.stdout);
		const stderr = normalizeText(output.stderr);
		if (streamOutput && outputAllowed()) {
			if (stdout) this.writeStdOut(stdout);
			if (stderr) this.writeStdErr(stderr);
		}
		return {
			code: output.code,
			signal: output.signal,
			stdout,
			stderr,
		};
	}

	private async executeShell(
		command: string,
		options: {
			cwd: string;
			streamOutput?: boolean;
			initialInput?: string[];
			initialInputStartDelayMs?: number;
			initialInputInterChunkDelayMs?: number;
			rawOutput?: boolean;
			allowExecuteFallback?: boolean;
			/** 返回 false 时丢弃输出写回（如项目已切换，执行中命令已作废）。 */
			outputAllowed?: () => boolean;
		},
	): Promise<TerminalExecResult> {
		// cwd 必须由调用方在命令开始时捕获；不能在 profile 探测 await 之后读取实时 this.cwd。
		const executionCwd = options.cwd;
		const profile = await this.ensureShellProfile(executionCwd);
		const outputAllowed = options.outputAllowed ?? (() => true);
		if (!outputAllowed()) {
			throw new Error("Terminal execution became stale before spawn.");
		}
		const streamOutput = options.streamOutput !== false;
		const initialInput = Array.isArray(options.initialInput) ? options.initialInput : [];
		const outputRaw = options.rawOutput === true;
		const allowExecuteFallback = options.allowExecuteFallback ?? !outputRaw;
		const initialInputStartDelayMs = Math.max(0, Number(options.initialInputStartDelayMs ?? 0));
		const initialInputInterChunkDelayMs = Math.max(0, Number(options.initialInputInterChunkDelayMs ?? 140));
		const shellArgs = this.buildShellArgs(profile, command);
		const shellCommand = outputRaw
			? Command.create(profile.name, shellArgs, {
					cwd: executionCwd,
					encoding: "raw",
				})
			: Command.create(profile.name, shellArgs, {
					cwd: executionCwd,
				});

		return await new Promise<TerminalExecResult>((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let spawnedChild: Child | null = null;
			let fallbackStarted = false;

			const cleanup = () => {
				shellCommand.stdout.off("data", onStdout);
				shellCommand.stderr.off("data", onStderr);
				shellCommand.off("close", onClose);
				shellCommand.off("error", onError);
				if (this.runningChild && spawnedChild && this.runningChild.pid === spawnedChild.pid) {
					this.runningChild = null;
				}
			};

			const settleWithResult = (result: TerminalExecResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};

			const settleWithError = (error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error instanceof Error ? error : new Error(normalizeText(error)));
			};

			const attemptExecuteFallback = () => {
				if (fallbackStarted) return;
				fallbackStarted = true;
				if (!outputAllowed()) {
					settleWithError(new Error("Terminal execution became stale before fallback."));
					return;
				}
				if (!allowExecuteFallback) {
					settleWithError(new Error(t("panels.terminal.spawnUnavailable")));
					return;
				}
				if (outputAllowed()) this.writeInfo(t("panels.terminal.spawnFallback"));
				void this.executeShellViaExecute(profile, command, executionCwd, streamOutput, outputAllowed).then(settleWithResult).catch(settleWithError);
			};

			const sendInitialInput = async (child: Child): Promise<void> => {
				if (initialInput.length === 0) return;
				if (initialInputStartDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, initialInputStartDelayMs));
				}
				for (let i = 0; i < initialInput.length; i += 1) {
					if (!outputAllowed()) return;
					const chunk = initialInput[i] ?? "";
					if (!chunk) continue;
					try {
						await child.write(chunk);
					} catch (err) {
						if (outputAllowed()) this.writeStdErr(err instanceof Error ? err.message : String(err));
						return;
					}
					if (i < initialInput.length - 1 && initialInputInterChunkDelayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, initialInputInterChunkDelayMs));
					}
				}
			};

			const stdoutDecoder = outputRaw ? new TextDecoder() : null;
			const stderrDecoder = outputRaw ? new TextDecoder() : null;

			const onStdout = (payload: unknown) => {
				const text = outputRaw ? this.decodeOutputChunk(payload, stdoutDecoder) : normalizeText(payload);
				if (!text) return;
				stdout += text;
				if (streamOutput && outputAllowed()) {
					if (outputRaw) this.writeRawOutput(text);
					else this.writeStdOut(text);
				}
			};
			const onStderr = (payload: unknown) => {
				const text = outputRaw ? this.decodeOutputChunk(payload, stderrDecoder) : normalizeText(payload);
				if (!text) return;
				stderr += text;
				if (streamOutput && outputAllowed()) {
					if (outputRaw) this.writeRawOutput(text);
					else this.writeStdErr(text);
				}
			};
			const onClose = (payload: { code: number | null; signal: number | null }) => {
				if (outputRaw) {
					const flushStdout = stdoutDecoder?.decode() ?? "";
					if (flushStdout) {
						stdout += flushStdout;
						if (streamOutput && outputAllowed()) this.writeRawOutput(flushStdout);
					}
					const flushStderr = stderrDecoder?.decode() ?? "";
					if (flushStderr) {
						stderr += flushStderr;
						if (streamOutput && outputAllowed()) this.writeRawOutput(flushStderr);
					}
				}
				settleWithResult({
					code: payload.code,
					signal: payload.signal,
					stdout,
					stderr,
				});
			};
			const onError = (message: string) => {
				if (!spawnedChild && this.isSpawnScopeError(message)) {
					attemptExecuteFallback();
					return;
				}
				settleWithError(new Error(message || t("panels.terminal.shellFailed")));
			};

			shellCommand.stdout.on("data", onStdout);
			shellCommand.stderr.on("data", onStderr);
			shellCommand.on("close", onClose);
			shellCommand.on("error", onError);

			shellCommand
				.spawn()
				.then((child) => {
					spawnedChild = child;
					this.runningChild = child;
					void sendInitialInput(child);
				})
				.catch((error) => {
					if (this.isSpawnScopeError(error)) {
						attemptExecuteFallback();
						return;
					}
					settleWithError(error);
				});
		});
	}

	private isExecutionCurrent(token: TerminalExecutionToken): boolean {
		return this.activeExecution?.id === token.id && this.projectGeneration === token.projectGeneration;
	}

	private async executeCdCommand(command: string, token: TerminalExecutionToken): Promise<void> {
		const profile = await this.ensureShellProfile(token.cwd);
		if (!this.isExecutionCurrent(token)) return;
		const probeCommand = this.buildCdProbeCommand(profile, command);
		const result = await this.executeShell(probeCommand, {
			cwd: token.cwd,
			streamOutput: false,
			outputAllowed: () => this.isExecutionCurrent(token),
		});
		// 探测期间项目已切换（含 A→B→A）：丢弃本次 cd 结果，避免写回错误目录。
		if (!this.isExecutionCurrent(token)) return;
		if (result.stderr.trim()) {
			this.writeStdErr(result.stderr.trimEnd());
		}

		const normalizedStdout = result.stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const lines = normalizedStdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		if ((result.code ?? 1) === 0) {
			const nextCwd = lines.length > 0 ? lines[lines.length - 1] : "";
			if (nextCwd) {
				this.cwd = nextCwd;
				this.render();
			}
			const extraStdout = lines.slice(0, -1).join("\n");
			if (extraStdout) this.writeStdOut(`${extraStdout}\n`);
		} else if (lines.length > 0) {
			this.writeStdOut(`${lines.join("\n")}\n`);
		}
	}

	/**
	 * 取出下一条与当前工作目录一致的排队命令。
	 * 目录已变化的命令（如项目已切换或 cd 之后）直接丢弃并提示。
	 */
	private shiftQueuedCommandForCurrentCwd(): QueuedTerminalCommand | null {
		let cancelled = 0;
		let command: QueuedTerminalCommand | null = null;
		const kept: QueuedTerminalCommand[] = [];
		for (const item of this.queuedCommands) {
			if (item.cwd !== this.cwd || item.projectGeneration !== this.projectGeneration) {
				cancelled += 1;
				continue;
			}
			if (command === null) {
				command = item;
			} else {
				kept.push(item);
			}
		}
		this.queuedCommands = kept;
		if (cancelled > 0) {
			this.writeInfo(t("panels.terminal.queueCancelledCwdMismatch", { count: cancelled }));
		}
		return command;
	}

	private async executeCommand(rawCommand: string, queuedContext?: QueuedTerminalCommand): Promise<void> {
		const command = rawCommand.trim();
		if (!command) {
			this.printPrompt();
			return;
		}
		const startCwd = queuedContext?.cwd ?? this.cwd;
		const startProjectGeneration = queuedContext?.projectGeneration ?? this.projectGeneration;
		if (command === "clear" || command === "cls") {
			if (
				queuedContext &&
				(queuedContext.cwd !== this.cwd || queuedContext.projectGeneration !== this.projectGeneration)
			) {
				this.writeInfo(t("panels.terminal.queueCancelledCwdMismatch", { count: 1 }));
				this.printPrompt();
				return;
			}
			this.rememberHistory(command);
			this.clearScreen();
			return;
		}
		if (!startCwd) {
			this.writeInfo(t("panels.terminal.openProjectFirst"));
			this.printPrompt();
			return;
		}
		if (startCwd !== this.cwd || startProjectGeneration !== this.projectGeneration) {
			this.writeInfo(t("panels.terminal.queueCancelledCwdMismatch", { count: 1 }));
			this.printPrompt();
			return;
		}
		this.rememberHistory(command);

		this.fitAddon?.fit();
		const resolved = this.resolveSpecialShellCommand(command);
		if (resolved.infoText) {
			this.writeInfo(resolved.infoText);
		}

		this.running = true;
		this.runningInteractive = resolved.interactive;
		const token: TerminalExecutionToken = {
			id: ++this.executionGeneration,
			cwd: startCwd,
			projectGeneration: startProjectGeneration,
		};
		this.activeExecution = token;
		this.render();
		const isStale = () => !this.isExecutionCurrent(token);
		let completedResult: TerminalExecResult | null = null;
		try {
			if (this.isCdCommand(command)) {
				await this.executeCdCommand(command, token);
			} else {
				const result = await this.executeShell(resolved.shellCommand, {
					cwd: token.cwd,
					streamOutput: true,
					initialInput: resolved.initialInput,
					initialInputStartDelayMs: resolved.initialInputStartDelayMs,
					initialInputInterChunkDelayMs: resolved.initialInputInterChunkDelayMs,
					rawOutput: resolved.interactive,
					allowExecuteFallback: !resolved.interactive,
					outputAllowed: () => !isStale(),
				});
				completedResult = result;
				if (!isStale() && typeof result.code === "number" && result.code !== 0 && !result.stderr.trim()) {
					this.writeStdErr(`exit ${result.code}`);
				}
			}
		} catch (err) {
			if (!isStale()) {
				this.writeStdErr(err instanceof Error ? err.message : String(err));
			}
		} finally {
			const stale = isStale();
			if (this.activeExecution?.id === token.id) {
				this.activeExecution = null;
				this.running = false;
				this.runningInteractive = false;
			}
			this.render();
			const suppressPrompt = this.suppressPromptOnce;
			this.suppressPromptOnce = false;
			if (!suppressPrompt) {
				this.printPrompt();
			}
			if (stale) {
				// 项目在执行期间已切换：丢弃结果，不回调 onCommandComplete（其上下文属于旧项目）。
				this.writeInfo(t("panels.terminal.resultDroppedOnProjectSwitch", { command }));
			} else if (!this.isCdCommand(command) && this.onCommandComplete) {
				void Promise.resolve(
					this.onCommandComplete({
						command,
						interactive: resolved.interactive,
						result: completedResult,
					}),
				).catch(() => {
					// Ignore command completion callback failures.
				});
			}
			const next = this.shiftQueuedCommandForCurrentCwd();
			if (next) {
				this.xterm?.write(`${next.command}\r\n`);
				void this.executeCommand(next.command, next);
			}
		}
	}

	private async abortRunningCommand(): Promise<void> {
		if (!this.running) return;
		const child = this.runningChild;
		if (!child) {
			this.writeInfo(t("panels.terminal.noChildToAbort"));
			return;
		}
		try {
			await child.kill();
		} catch (err) {
			this.writeStdErr(err instanceof Error ? err.message : String(err));
		}
	}

	private async handleClearAction(): Promise<void> {
		if (this.running) {
			this.suppressPromptOnce = true;
			await this.abortRunningCommand();
		}
		this.clearScreen();
	}

	private clearScreen(): void {
		this.inputBuffer = "";
		this.queuedCommands = [];
		this.xterm?.write("\x1b[2J\x1b[3J\x1b[H");
		this.printPrompt();
		this.scrollTerminalToBottom();
	}

	render(): void {
		const shellLabel = this.shellProfile?.label ?? shellProfilesForPlatform()[0]?.label ?? "shell";
		const headerTitle = this.running
			? t("panels.terminal.titleRunning", { shell: shellLabel })
			: t("panels.terminal.title", { shell: shellLabel });
		const cwdLabel = this.cwd ? compactPath(this.cwd) : t("panels.terminal.noProject");
		const template = html`
			<div
				class="terminal-panel-root"
				@mousedown=${(event: MouseEvent) => {
					const target = event.target instanceof Element ? event.target : null;
					if (target?.closest(".terminal-resize-handle")) return;
					this.xterm?.focus();
				}}
			>
				<div class="terminal-resize-handle" title=${t("panels.terminal.resize")} aria-hidden="true"></div>
				<div class="terminal-panel-header">
					<div class="terminal-panel-title">${headerTitle}</div>
					<div class="terminal-panel-cwd" title=${this.cwd || ""}>${cwdLabel}</div>
					<div class="terminal-panel-actions">
						<button class="ghost-btn" title=${t("panels.terminal.clearTitle")} @click=${() => void this.handleClearAction()}>${t("panels.terminal.clear")}</button>
						<button class="ghost-btn terminal-close-btn" title=${t("panels.terminal.closeTitle")} @click=${() => this.onRequestClose?.()}>✕</button>
					</div>
				</div>
				<div id="terminal-viewport" class="terminal-panel-viewport"></div>
			</div>
		`;

		render(template, this.container);
		this.ensureTerminal();
		this.applyTheme();
		this.fitAddon?.fit();
	}
}
