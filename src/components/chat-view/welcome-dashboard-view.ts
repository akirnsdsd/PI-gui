import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";

interface WelcomeDashboardSnapshotViewModel {
	loading: boolean;
	skills: string[];
	extensions: string[];
	themes: string[];
	error: string | null;
}

interface WelcomeProjectViewModel {
	id: string;
	name: string;
}

type WelcomeSuggestionKind = "explore" | "build" | "review" | "fix";

const WELCOME_SUGGESTION_KINDS: WelcomeSuggestionKind[] = ["explore", "build", "review", "fix"];

/** 建议卡片图标：16px 简单线条，单色 currentColor（样式见 .welcome-suggestion-icon svg）。 */
function welcomeSuggestionIcon(kind: WelcomeSuggestionKind): TemplateResult {
	switch (kind) {
		case "explore":
			// 指南针
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4"></circle><path d="M10.3 5.7l-1.1 3.5-3.5 1.1 1.1-3.5z"></path></svg>`;
		case "build":
			// 锤子和扳手（交叉）
			return html`
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M4.4 3.5l3.2 3.2-1.2 1.2-3.2-3.2z"></path>
					<path d="M7 7l4.5 4.5"></path>
					<path d="M10.6 3.6a1.85 1.85 0 1 0 2.6 2.6l-1.1-.8-.7-1.1z"></path>
					<path d="M11.6 6.6l-7 5.7"></path>
				</svg>
			`;
		case "review":
			// 循环箭头
			return html`
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M12.7 8a4.7 4.7 0 0 0-8-3.4"></path>
					<path d="M4.7 2.2v2.4h2.4"></path>
					<path d="M3.3 8a4.7 4.7 0 0 0 8 3.4"></path>
					<path d="M11.3 13.8v-2.4H8.9"></path>
				</svg>
			`;
		case "fix":
			// 甲虫
			return html`
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<circle cx="8" cy="9.3" r="3.3"></circle>
					<path d="M5.6 6a2.4 2.4 0 0 1 4.8 0"></path>
					<path d="M6.6 4.1L5.9 2.9"></path>
					<path d="M9.4 4.1l.7-1.2"></path>
					<path d="M8 6.4v5.9"></path>
					<path d="M5.3 7.8L3.4 6.6"></path>
					<path d="M4.7 9.3H3"></path>
					<path d="M5.3 10.8l-1.9 1.2"></path>
					<path d="M10.7 7.8l1.9-1.2"></path>
					<path d="M11.3 9.3H13"></path>
					<path d="M10.7 10.8l1.9 1.2"></path>
				</svg>
			`;
	}
}

function welcomeFolderIcon(): TemplateResult {
	return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 4.4a1 1 0 0 1 1-1h2.4l1.3 1.5h4.7a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1z"></path></svg>`;
}

interface RenderCenteredWelcomeViewParams {
	brandIconUrl: string;
	projectLabel: string;
	hasProject: boolean;
	projectMenuOpen: boolean;
	projects: WelcomeProjectViewModel[];
	activeProjectId: string | null;
	snapshot: WelcomeDashboardSnapshotViewModel;
	composer: TemplateResult;
	onSuggestionClick: (promptText: string) => void;
	onToggleProjectMenu: () => void;
	onSelectProject: (projectId: string) => void;
	onAddProject: () => void;
	onOpenPackages: () => void;
	onOpenSettings: () => void;
}

export function renderCenteredWelcomeView({
	brandIconUrl,
	projectLabel,
	hasProject,
	projectMenuOpen,
	projects,
	activeProjectId,
	snapshot,
	composer,
	onSuggestionClick,
	onToggleProjectMenu,
	onSelectProject,
	onAddProject,
	onOpenPackages,
	onOpenSettings,
}: RenderCenteredWelcomeViewParams): TemplateResult {
	return html`
		<div class="welcome-dashboard">
			<img class="welcome-logo" src=${brandIconUrl} alt="" />
			<h1 class="welcome-headline">${t("chatView.welcome.headline")}</h1>
			<div class="welcome-suggestions">
				${WELCOME_SUGGESTION_KINDS.map(
					(kind) => html`
						<button
							type="button"
							class="welcome-suggestion-card"
							@click=${() => onSuggestionClick(t(`chatView.welcome.suggestions.${kind}.prompt`))}
						>
							<span class="welcome-suggestion-icon">${welcomeSuggestionIcon(kind)}</span>
							<span class="welcome-suggestion-text">${t(`chatView.welcome.suggestions.${kind}.title`)}</span>
						</button>
					`,
				)}
			</div>
			<div class="welcome-project-wrap">
				<button type="button" class="welcome-project-bar ${hasProject ? "active" : ""}" @click=${onToggleProjectMenu}>
					<span class="welcome-project-bar-icon">${welcomeFolderIcon()}</span>
					<span class="welcome-project-bar-label">${t("chatView.welcome.chooseProject")}</span>
					<span class="welcome-project-bar-name">${projectLabel}</span>
					<span class="welcome-project-caret ${projectMenuOpen ? "open" : ""}">⌄</span>
				</button>
				${projectMenuOpen
					? html`
						<div class="welcome-project-menu">
							${projects.map((project) => {
								const isCurrent = project.id === activeProjectId;
								return html`
									<button class="welcome-project-item ${isCurrent ? "current" : ""}" @click=${() => onSelectProject(project.id)}>
										<span>${project.name}</span>
										<span>${isCurrent ? "✓" : ""}</span>
									</button>
								`;
							})}
							${projects.length > 0 ? html`<div class="welcome-project-sep"></div>` : nothing}
							<button class="welcome-project-item" @click=${onAddProject}>${t("chatMisc.welcome.addProject")}</button>
							<div class="welcome-project-sep"></div>
							<button class="welcome-project-item" @click=${onOpenPackages}>${t("chatMisc.welcome.packages")}</button>
							<button class="welcome-project-item" @click=${onOpenSettings}>${t("chatMisc.welcome.settings")}</button>
						</div>
					`
					: nothing}
			</div>
			<div class="welcome-composer">${composer}</div>
			<div class="welcome-meta-line muted ${projectMenuOpen ? "hidden" : ""}">
				${snapshot.loading
					? t("chatMisc.welcome.refreshing")
					: t("chatMisc.welcome.inventory", {
						skills: snapshot.skills.length,
						extensions: snapshot.extensions.length,
						themes: snapshot.themes.length,
					})}
			</div>
			${snapshot.error ? html`<div class="welcome-error">${snapshot.error}</div>` : nothing}
		</div>
	`;
}
