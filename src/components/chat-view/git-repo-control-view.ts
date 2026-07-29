import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import type { GitBranchEntry } from "../../git/branches.js";

interface GitSummaryLike {
	isRepo: boolean;
	branch: string | null;
	branchEntries: GitBranchEntry[];
	dirtyFiles: number;
	additions: number;
	deletions: number;
}

interface RenderGitRepoControlViewParams {
	summary: GitSummaryLike;
	creatingGitRepo: boolean;
	refreshingGitSummary: boolean;
	switchingGitBranch: boolean;
	fetchingGitRemotes: boolean;
	gitMenuOpen: boolean;
	gitBranchQuery: string;
	resolveGitBranchSelection: (query: string) => GitBranchEntry | null;
	gitIcon: () => TemplateResult;
	onCreateRepo: () => void | Promise<unknown>;
	onToggleMenu: () => void;
	onSetBranchQuery: (value: string) => void;
	onCreateAndCheckoutBranch: (value: string) => void | Promise<unknown>;
	onFetchRemotes: () => void | Promise<unknown>;
	onSwitchGitBranchEntry: (entry: GitBranchEntry) => void | Promise<unknown>;
}

export function renderGitRepoControlView({
	summary,
	creatingGitRepo,
	refreshingGitSummary,
	switchingGitBranch,
	fetchingGitRemotes,
	gitMenuOpen,
	gitBranchQuery,
	resolveGitBranchSelection,
	gitIcon,
	onCreateRepo,
	onToggleMenu,
	onSetBranchQuery,
	onCreateAndCheckoutBranch,
	onFetchRemotes,
	onSwitchGitBranchEntry,
}: RenderGitRepoControlViewParams): TemplateResult {
	if (!summary.isRepo) {
		return html`
			<button class="composer-repo-btn" ?disabled=${creatingGitRepo || refreshingGitSummary} @click=${() => void onCreateRepo()}>
				${gitIcon()}
				<span>${creatingGitRepo ? t("chatMisc.git.creatingRepo") : t("chatMisc.git.createRepo")}</span>
			</button>
		`;
	}

	const currentBranch = summary.branch || t("chatMisc.git.detached");
	const query = gitBranchQuery.trim().toLowerCase();
	const branchEntries = summary.branchEntries.filter((entry) => {
		if (!query) return true;
		const haystack = `${entry.name} ${entry.fullName} ${entry.remote ?? ""} ${entry.scope}`.toLowerCase();
		return haystack.includes(query);
	});
	const matchingEntry = gitBranchQuery.trim().length > 0 ? resolveGitBranchSelection(gitBranchQuery) : null;
	const branchActionLabel = matchingEntry
		? matchingEntry.scope === "remote"
			? t("chatMisc.git.checkout", { name: matchingEntry.fullName })
			: t("chatMisc.git.switchTo", { name: matchingEntry.name })
		: t("chatMisc.git.createAndCheckout");

	return html`
		<div class="git-branch-wrap">
			<button
				class="git-branch-pill ${gitMenuOpen ? "open" : ""}"
				title=${t("chatMisc.git.switchBranch")}
				?disabled=${switchingGitBranch || refreshingGitSummary || fetchingGitRemotes}
				@click=${(event: Event) => {
					event.stopPropagation();
					onToggleMenu();
				}}
			>
				${gitIcon()}
				<span class="git-branch-pill-name">${currentBranch}</span>
				<span class="git-branch-pill-caret">▾</span>
			</button>

			${gitMenuOpen
				? html`
					<div class="git-branch-menu" @click=${(event: Event) => event.stopPropagation()}>
						<label class="git-branch-search">
							<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2"></circle><path d="M10.2 10.2l3 3"></path></svg>
							<input
								type="text"
								placeholder=${t("chatMisc.git.searchBranches")}
								.value=${gitBranchQuery}
								@input=${(event: Event) => onSetBranchQuery((event.target as HTMLInputElement).value)}
								@keydown=${(event: KeyboardEvent) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void onCreateAndCheckoutBranch(gitBranchQuery);
									}
								}}
							/>
						</label>
						<div class="git-branch-menu-head">
							<div class="git-branch-menu-title">${t("chatMisc.git.branches")}</div>
							<button
								class="git-branch-fetch"
								?disabled=${fetchingGitRemotes || switchingGitBranch}
								@click=${() => void onFetchRemotes()}
							>
								${fetchingGitRemotes ? t("chatMisc.git.fetching") : t("chatMisc.git.fetch")}
							</button>
						</div>
						<div class="git-branch-list">
							${branchEntries.length === 0
								? html`<div class="git-branch-empty">${t("chatMisc.git.noBranches")}</div>`
								: branchEntries.map((entry) => {
										const active = entry.scope === "local" && entry.name === currentBranch;
										const disabled = active || switchingGitBranch || fetchingGitRemotes;
										const label = entry.scope === "remote" ? entry.fullName : entry.name;
										return html`
											<button
												class="git-branch-item ${active ? "active" : ""}"
												?disabled=${disabled}
												@click=${() => void onSwitchGitBranchEntry(entry)}
											>
												<div class="git-branch-item-top">
													<span class="git-branch-item-icon">${gitIcon()}</span>
													<span class="git-branch-item-name">${label}</span>
													<span class="git-branch-item-trailing">
														${entry.scope === "remote" ? html`<span class="git-branch-item-badge">${t("chatMisc.git.remote")}</span>` : nothing}
														${active ? html`<span class="git-branch-item-check">✓</span>` : nothing}
													</span>
												</div>
												${entry.scope === "remote"
													? html`<div class="git-branch-item-meta">${t("chatMisc.git.checkoutTrackingFrom", { name: entry.fullName })}</div>`
													: active && summary.dirtyFiles > 0
														? html`
															<div class="git-branch-item-meta">
																${t("chatMisc.git.uncommittedFiles", { count: summary.dirtyFiles.toLocaleString() })}
																<span class="git-delta plus">+${summary.additions.toLocaleString()}</span>
																<span class="git-delta minus">-${summary.deletions.toLocaleString()}</span>
															</div>
														`
														: nothing}
											</button>
										`;
								  })}
						</div>
						<button
							class="git-branch-create"
							?disabled=${switchingGitBranch || fetchingGitRemotes}
							@click=${() => void onCreateAndCheckoutBranch(gitBranchQuery)}
						>
							<span class="git-branch-create-plus">${matchingEntry ? "↩" : "＋"}</span>
							<span>${branchActionLabel}</span>
						</button>
					</div>
				`
				: nothing}
		</div>
	`;
}
