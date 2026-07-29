/**
 * Shortcuts Panel
 */

import { html, nothing, render } from "lit";
import { t } from "../i18n/index.js";

interface Shortcut {
	keys: string[];
	description: string;
	category: string;
}

const SHORTCUTS: Shortcut[] = [
	{ keys: ["Ctrl/Cmd+N"], description: t("panels.shortcuts.descriptions.newSession"), category: "session" },
	{ keys: ["Ctrl/Cmd+Shift+R"], description: t("panels.shortcuts.descriptions.openSessionsBrowser"), category: "session" },
	{ keys: ["Ctrl/Cmd+Shift+H"], description: t("panels.shortcuts.descriptions.openSessionHistory"), category: "session" },
	{ keys: ["Ctrl/Cmd+K"], description: t("panels.shortcuts.descriptions.openCommandPalette"), category: "navigation" },
	{ keys: ["/"], description: t("panels.shortcuts.descriptions.openCommandPaletteQuick"), category: "navigation" },
	{ keys: ["Ctrl+`", "Cmd+Alt+T"], description: t("panels.shortcuts.descriptions.toggleTerminal"), category: "navigation" },
	{ keys: ["Ctrl/Cmd+L"], description: t("panels.shortcuts.descriptions.focusComposer"), category: "input" },
	{ keys: ["Enter"], description: t("panels.shortcuts.descriptions.sendMessage"), category: "input" },
	{ keys: ["Alt+Enter"], description: t("panels.shortcuts.descriptions.queueFollowUp"), category: "input" },
	{ keys: ["Shift+Enter"], description: t("panels.shortcuts.descriptions.insertNewline"), category: "input" },
	{ keys: ["Esc"], description: t("panels.shortcuts.descriptions.abortRun"), category: "agent" },
	{ keys: ["Ctrl/Cmd+M"], description: t("panels.shortcuts.descriptions.cycleModel"), category: "model" },
	{ keys: ["Shift+Tab"], description: t("panels.shortcuts.descriptions.cycleThinkingLevel"), category: "model" },
	{ keys: ["Ctrl/Cmd+T"], description: t("panels.shortcuts.descriptions.toggleThinkingBlocks"), category: "display" },
	{ keys: ["Ctrl/Cmd+Shift+C"], description: t("panels.shortcuts.descriptions.copyLastAssistant"), category: "utility" },
	{ keys: ["Ctrl/Cmd+E"], description: t("panels.shortcuts.descriptions.exportSessionHtml"), category: "utility" },
	{ keys: ["Ctrl/Cmd+Shift+E"], description: t("panels.shortcuts.descriptions.copyExportedHtml"), category: "utility" },
	{ keys: ["Ctrl/Cmd+,"], description: t("panels.shortcuts.descriptions.openSettings"), category: "navigation" },
	{ keys: ["Ctrl/Cmd+/"], description: t("panels.shortcuts.descriptions.openShortcutsPanel"), category: "navigation" },
	{ keys: ["Ctrl/Cmd+Shift+T"], description: t("panels.shortcuts.descriptions.toggleTheme"), category: "display" },
];

export class ShortcutsPanel {
	private container: HTMLElement;
	private isOpen = false;
	private onClose: (() => void) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
		this.render();
	}

	open(): void {
		this.isOpen = true;
		this.render();
	}

	close(): void {
		this.isOpen = false;
		this.render();
		this.onClose?.();
	}

	isVisible(): boolean {
		return this.isOpen;
	}

	setOnClose(callback: () => void): void {
		this.onClose = callback;
	}

	private getCategoryLabel(category: string): string {
		switch (category) {
			case "navigation":
				return t("panels.shortcuts.categories.navigation");
			case "session":
				return t("panels.shortcuts.categories.session");
			case "input":
				return t("panels.shortcuts.categories.input");
			case "model":
				return t("panels.shortcuts.categories.model");
			case "display":
				return t("panels.shortcuts.categories.display");
			case "utility":
				return t("panels.shortcuts.categories.utility");
			case "agent":
				return t("panels.shortcuts.categories.agent");
			default:
				return category;
		}
	}

	render(): void {
		if (!this.isOpen) {
			this.container.innerHTML = "";
			return;
		}

		const grouped = SHORTCUTS.reduce(
			(acc, shortcut) => {
				if (!acc[shortcut.category]) acc[shortcut.category] = [];
				acc[shortcut.category].push(shortcut);
				return acc;
			},
			{} as Record<string, Shortcut[]>,
		);

		const categories = ["navigation", "session", "input", "model", "display", "utility", "agent"];

		const template = html`
			<div class="overlay" @click=${(e: Event) => e.target === e.currentTarget && this.close()}>
				<div class="shortcuts-card">
					<div class="shortcuts-header">
						<h2>${t("panels.shortcuts.title")}</h2>
						<button @click=${() => this.close()}>✕</button>
					</div>
					<div class="shortcuts-body">
						${categories.map((category) => {
							const entries = grouped[category];
							if (!entries || entries.length === 0) return nothing;
							return html`
								<div class="shortcuts-group">
									<div class="shortcuts-group-title">${this.getCategoryLabel(category)}</div>
									${entries.map(
										(entry) => html`
											<div class="shortcut-row">
												<span>${entry.description}</span>
												<div class="shortcut-keys">
													${entry.keys.map((key) => html`<kbd>${key}</kbd>`) }
												</div>
											</div>
										`,
									)}
								</div>
							`;
						})}
					</div>
				</div>
			</div>
		`;

		render(template, this.container);
	}

	destroy(): void {
		this.container.innerHTML = "";
	}
}
