import { html, nothing, type TemplateResult } from "lit";
import { formatModelDisplayName, formatProviderDisplayName } from "../../models/model-options.js";
import { resolveModelPickerAuthHint, resolveModelPickerProviderAuthActionState, type ModelPickerProviderAuthActionState } from "../../models/model-picker-auth-ui.js";
import type { ModelPickerProviderGroup } from "../../models/model-picker-provider-groups.js";
import { normalizeProviderKey } from "../../auth/provider-auth.js";
import type { ThinkingLevel } from "../../rpc/bridge.js";
import { t } from "../../i18n/index.js";

interface CloseModelPickerOptions {
	focusComposer?: boolean;
}

/** 「+」菜单里列出的技能条目（来自 slash runtime 的 skill 命令）。 */
export interface AddMenuSkillItem {
	name: string;
	description: string;
}

function getAuthActionLabel(label: ModelPickerProviderAuthActionState["label"]): string {
	switch (label) {
		case "Login":
			return t("composer.controls.authLogin");
		case "Logout":
			return t("composer.controls.authLogout");
		case "Env":
			return t("composer.controls.authEnv");
	}
}

const THINKING_LEVEL_OPTIONS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function getThinkingLevelLabel(level: ThinkingLevel): string {
	switch (level) {
		case "off":
			return t("composer.controls.thinking.off");
		case "minimal":
			return t("composer.controls.thinking.minimal");
		case "low":
			return t("composer.controls.thinking.low");
		case "medium":
			return t("composer.controls.thinking.medium");
		case "high":
			return t("composer.controls.thinking.high");
		case "xhigh":
			return t("composer.controls.thinking.xhigh");
	}
}

interface RenderComposerControlsViewParams {
	canSend: boolean;
	isStreaming: boolean;
	interactionLocked: boolean;
	sendingPrompt: boolean;
	settingModel: boolean;
	settingThinking: boolean;
	thinkingValue: ThinkingLevel;
	thinkingLabel: string;
	thinkingMenuOpen: boolean;
	currentProvider: string;
	currentModelId: string;
	currentModelValue: string;
	currentModelTitle: string;
	currentModelDisplay: string;
	currentProviderDisplay: string;
	modelPickerOpen: boolean;
	loadingModels: boolean;
	loadingModelCatalog: boolean;
	providerGroups: ModelPickerProviderGroup[];
	activeProviderGroup: ModelPickerProviderGroup | null;
	resolvedActiveProvider: string;
	runningProviderAuthActionProvider: string | null;
	plusIcon: TemplateResult;
	stopIcon: TemplateResult;
	spinnerIcon: TemplateResult;
	sendIcon: TemplateResult;
	addMenuOpen: boolean;
	addMenuSkills: AddMenuSkillItem[];
	addMenuSkillsLoading: boolean;
	onToggleAddMenu: () => void;
	onCloseAddMenu: (options?: CloseModelPickerOptions) => void;
	onAttachFile: () => void;
	onSelectSkill: (name: string) => void;
	onCloseModelPicker: (options?: CloseModelPickerOptions) => void;
	onToggleModelPicker: (preferredProvider: string) => void;
	onSetModelPickerActiveProvider: (provider: string) => void;
	onProviderAuthAction: (provider: string, action: "login" | "logout") => void | Promise<unknown>;
	onSelectModel: (provider: string, modelId: string) => void | Promise<unknown>;
	onSetThinkingLevel: (value: ThinkingLevel) => void | Promise<unknown>;
	onToggleThinkingMenu: () => void;
	onCloseThinkingMenu: (options?: CloseModelPickerOptions) => void;
	onAbort: () => void | Promise<unknown>;
	onSend: () => void | Promise<unknown>;
	onManageChannels: () => void;
}

export function renderComposerControlsView({
	canSend,
	isStreaming,
	interactionLocked,
	sendingPrompt,
	settingModel,
	settingThinking,
	thinkingValue,
	thinkingLabel,
	thinkingMenuOpen,
	currentProvider,
	currentModelId,
	currentModelValue,
	currentModelTitle,
	currentModelDisplay,
	currentProviderDisplay,
	modelPickerOpen,
	loadingModels,
	loadingModelCatalog,
	providerGroups,
	activeProviderGroup,
	resolvedActiveProvider,
	runningProviderAuthActionProvider,
	plusIcon,
	stopIcon,
	spinnerIcon,
	sendIcon,
	addMenuOpen,
	addMenuSkills,
	addMenuSkillsLoading,
	onToggleAddMenu,
	onCloseAddMenu,
	onAttachFile,
	onSelectSkill,
	onCloseModelPicker,
	onToggleModelPicker,
	onSetModelPickerActiveProvider,
	onProviderAuthAction,
	onSelectModel,
	onSetThinkingLevel,
	onToggleThinkingMenu,
	onCloseThinkingMenu,
	onAbort,
	onSend,
	onManageChannels,
}: RenderComposerControlsViewParams): TemplateResult {
	// 右栏提示气泡预先算好：空列表时给空态标题 + 原因说明；未配置但有模型时给配置引导。
	const activeGroupEmptyHint =
		activeProviderGroup && activeProviderGroup.models.length === 0
			? resolveModelPickerAuthHint(activeProviderGroup, false)
			: "";
	const activeGroupUnauthHint =
		activeProviderGroup && activeProviderGroup.models.length > 0 && !activeProviderGroup.authConfigured
			? resolveModelPickerAuthHint(activeProviderGroup, true)
			: "";
	return html`
		<div class="composer-controls">
			<div class="control-group">
				<div
					class="add-menu-root"
					@keydown=${(event: KeyboardEvent) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						onCloseAddMenu({ focusComposer: true });
					}}
					@focusout=${(event: FocusEvent) => {
						const next = event.relatedTarget as Node | null;
						const root = event.currentTarget as HTMLElement;
						if (next && root.contains(next)) return;
						onCloseAddMenu();
					}}
				>
					<button
						type="button"
						class="composer-icon-btn add-menu-trigger ${addMenuOpen ? "active" : ""}"
						title=${t("composer.controls.addMenu.trigger")}
						?disabled=${interactionLocked}
						@click=${() => {
							if (interactionLocked) return;
							onToggleAddMenu();
						}}
					>
						${plusIcon}
					</button>

					${addMenuOpen
						? html`
							<div class="add-menu-popover composer-popover-card" role="menu" aria-label=${t("composer.controls.addMenu.trigger")}>
								<button
									type="button"
									class="add-menu-item"
									role="menuitem"
									@click=${() => {
										onCloseAddMenu();
										onAttachFile();
									}}
								>
									${t("composer.controls.addMenu.files")}
								</button>
								<div class="add-menu-separator"></div>
								<div class="add-menu-section">${t("composer.controls.addMenu.skillsSection")}</div>
								${addMenuSkills.length === 0
									? addMenuSkillsLoading
										? html`<div class="add-menu-empty ui-loading-host" role="status" aria-label=${t("composer.controls.addMenu.loadingSkills")}><span class="ui-loading-spinner small"></span></div>`
										: html`<div class="add-menu-empty">${t("composer.controls.addMenu.noSkills")}</div>`
									: addMenuSkills.map(
											(skill) => html`
												<button
													type="button"
													class="add-menu-item add-menu-skill-item"
													role="menuitem"
													title=${skill.description || skill.name}
													@click=${() => onSelectSkill(skill.name)}
												>
													<span class="add-menu-skill-name">${skill.name}</span>
													${skill.description ? html`<span class="add-menu-skill-desc">${skill.description}</span>` : nothing}
												</button>
											`,
										)}
							</div>
						`
						: nothing}
				</div>
			</div>

			<div class="control-group right">
				<div
					class="model-picker-root"
					@keydown=${(event: KeyboardEvent) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						onCloseModelPicker({ focusComposer: true });
					}}
					@focusout=${(event: FocusEvent) => {
						const next = event.relatedTarget as Node | null;
						const root = event.currentTarget as HTMLElement;
						if (next && root.contains(next)) return;
						onCloseModelPicker();
					}}
				>
					<button
						type="button"
						class="model-picker-trigger"
						title=${currentModelTitle}
						?disabled=${interactionLocked || settingModel}
						@click=${() => {
							if (interactionLocked || settingModel) return;
							onToggleModelPicker(resolvedActiveProvider);
						}}
					>
						<span class="model-picker-trigger-label">${currentProviderDisplay ? `${currentModelDisplay} · ${currentProviderDisplay}` : currentModelDisplay}</span>
						<span class="composer-select-caret">▾</span>
					</button>

					${modelPickerOpen
						? html`
							<div class="model-picker-popover composer-popover-card" role="listbox" aria-label=${t("composer.controls.availableModels")}>
								${providerGroups.length === 0
									? loadingModels || loadingModelCatalog
										? html`<div class="model-picker-empty ui-loading-host" role="status" aria-label=${t("composer.controls.loadingModels")}><span class="ui-loading-spinner small"></span></div>`
										: html`<div class="model-picker-empty">${t("composer.controls.noConfiguredProviders")}</div>`
									: html`
										<div class="model-picker-providers">
											${providerGroups.map((group) => {
												const authKey = normalizeProviderKey(group.providerKey);
												const actionState = resolveModelPickerProviderAuthActionState({
													group,
													authKey,
													runningProviderAuthActionKey: runningProviderAuthActionProvider,
													interactionLocked,
													settingModel,
												});
												return html`
													<div class="model-picker-provider-row ${group.providerKey === resolvedActiveProvider ? "active" : ""} ${group.authConfigured ? "" : "unauth"}">
														<button
															type="button"
															class="model-picker-provider ${group.providerKey === resolvedActiveProvider ? "active" : ""} ${group.authConfigured ? "" : "unauth has-sub"}"
															title=${group.authConfigured ? t("composer.controls.providerConnected", { provider: group.providerLabel }) : t("composer.controls.providerNeedsSetup", { provider: group.providerLabel })}
															@mouseenter=${() => onSetModelPickerActiveProvider(group.providerKey)}
															@focus=${() => onSetModelPickerActiveProvider(group.providerKey)}
															@click=${() => onSetModelPickerActiveProvider(group.providerKey)}
														>
															<span class="model-picker-provider-label">${group.providerLabel}</span>
															${group.authConfigured ? nothing : html`<span class="model-picker-provider-sub">${t("composer.controls.providerSetupHint")}</span>`}
														</button>
														<button
															type="button"
															class="model-picker-provider-auth ${group.authConfigured ? "connected" : ""} ${actionState.isBusy ? "busy" : ""}"
															title=${actionState.title}
															?disabled=${actionState.disabled}
															@click=${(event: MouseEvent) => {
																event.preventDefault();
																event.stopPropagation();
																if (actionState.disabled) return;
																void onProviderAuthAction(group.providerKey, actionState.action);
															}}
														>
															${actionState.isBusy ? "…" : getAuthActionLabel(actionState.label)}
														</button>
													</div>
												`;
											})}
										</div>
										<div class="model-picker-models">
											${activeProviderGroup
												? html`
													${activeProviderGroup.models.length === 0
														? html`
															<div class="model-picker-empty">${t("composer.controls.providerNoModels")}</div>
															${activeGroupEmptyHint
																? html`<div class="model-picker-auth-hint">${activeGroupEmptyHint}</div>`
																: nothing}
														`
														: html`
															${activeGroupUnauthHint
																? html`<div class="model-picker-auth-hint">${activeGroupUnauthHint}</div>`
																: nothing}
															${activeProviderGroup.models.map((model) => {
																const nextValue = `${model.provider}::${model.id}`;
																const isActive = model.provider === currentProvider && model.id === currentModelId;
																const isDisabled = !model.selectable || !activeProviderGroup.authConfigured;
																return html`
																	<button
																		type="button"
																		class="model-picker-model ${isActive ? "active" : ""} ${isDisabled ? "disabled" : ""}"
																		title=${isDisabled
																			? t("composer.controls.modelSetupRequired", { provider: formatProviderDisplayName(model.provider), model: model.id })
																			: `${formatProviderDisplayName(model.provider)} / ${model.id}`}
																		?disabled=${interactionLocked || settingModel || isDisabled}
																		@click=${() => {
																			if (isDisabled) return;
																			onCloseModelPicker();
																			if (nextValue === currentModelValue) return;
																			void onSelectModel(model.provider, model.id);
																		}}
																	>
																		<span>${formatModelDisplayName(model.id)}</span>
																	</button>
																`;
															})}
														`}
												`
												: html`<div class="model-picker-empty">${t("composer.controls.noModels")}</div>`}
										</div>
									`}
									<div class="model-picker-footer">
										<button
											type="button"
											class="model-picker-manage-btn"
											title=${t("composer.controls.manageChannelsTitle")}
											@click=${() => onManageChannels()}
										>
											${t("composer.controls.manageChannels")}
										</button>
									</div>
							</div>
						`
						: nothing}
				</div>

				<div
					class="thinking-select-root"
					@keydown=${(event: KeyboardEvent) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						onCloseThinkingMenu({ focusComposer: true });
					}}
					@focusout=${(event: FocusEvent) => {
						const next = event.relatedTarget as Node | null;
						const root = event.currentTarget as HTMLElement;
						if (next && root.contains(next)) return;
						onCloseThinkingMenu();
					}}
				>
					<button
						type="button"
						class="thinking-select-trigger ${thinkingMenuOpen ? "active" : ""}"
						title=${t("composer.controls.thinkingTitle")}
						?disabled=${interactionLocked || settingThinking}
						@click=${() => {
							if (interactionLocked || settingThinking) return;
							onToggleThinkingMenu();
						}}
					>
						<span class="thinking-select-label">${thinkingLabel}</span>
						<span class="thinking-select-caret">▾</span>
					</button>

					${thinkingMenuOpen
						? html`
							<div class="thinking-menu-popover composer-popover-card" role="listbox" aria-label=${t("composer.controls.thinkingTitle")}>
								${THINKING_LEVEL_OPTIONS.map(
									(level) => html`
										<button
											type="button"
											class="add-menu-item thinking-menu-item ${level === thinkingValue ? "active" : ""}"
											role="option"
											aria-selected=${level === thinkingValue ? "true" : "false"}
											@click=${() => {
												onCloseThinkingMenu({ focusComposer: true });
												if (level === thinkingValue) return;
												void onSetThinkingLevel(level);
											}}
										>
											<span class="thinking-menu-item-label">${getThinkingLevelLabel(level)}</span>
											${level === thinkingValue ? html`<span class="thinking-menu-item-check">✓</span>` : nothing}
										</button>
									`,
								)}
							</div>
						`
						: nothing}
				</div>

					${isStreaming
						? html`
							<button
								class="send-btn stop-btn"
								title=${t("composer.controls.stopGeneration")}
								aria-label=${t("composer.controls.stopGeneration")}
								?disabled=${interactionLocked}
								@click=${() => {
									if (interactionLocked) return;
									void onAbort();
								}}
								>
									${stopIcon}
								</button>
						`
						: sendingPrompt
							? html`
								<button
									class="send-btn pending-send"
									title=${t("composer.controls.sending")}
									aria-label=${t("composer.controls.sending")}
									disabled
								>
									${spinnerIcon}
								</button>
							`
							: html`
								<button
									class="send-btn primary-send"
									?disabled=${interactionLocked || !canSend}
									title=${t("composer.controls.send")}
									aria-label=${t("composer.controls.send")}
									@click=${() => {
										if (interactionLocked) return;
										void onSend();
									}}
									>
										${sendIcon}
									</button>
						`}
			</div>
		</div>
	`;
}
