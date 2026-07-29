import { t } from "../i18n/index.js";
import type { ModelPickerProviderGroup } from "./model-picker-provider-groups.js";

export interface ModelPickerProviderAuthActionState {
	action: "login" | "logout";
	label: "Login" | "Logout" | "Env";
	title: string;
	disabled: boolean;
	isBusy: boolean;
}

interface ResolveModelPickerProviderAuthActionStateParams {
	group: ModelPickerProviderGroup;
	authKey: string;
	runningProviderAuthActionKey: string | null;
	interactionLocked: boolean;
	settingModel: boolean;
}

export function resolveModelPickerProviderAuthActionState({
	group,
	authKey,
	runningProviderAuthActionKey,
	interactionLocked,
	settingModel,
}: ResolveModelPickerProviderAuthActionStateParams): ModelPickerProviderAuthActionState {
	const isBusy = runningProviderAuthActionKey === authKey;
	const canLogout = group.authConfigured && group.authSource !== "environment";
	const action: "login" | "logout" = canLogout ? "logout" : "login";
	const label: "Login" | "Logout" | "Env" = group.authConfigured
		? group.authSource === "environment"
			? "Env"
			: "Logout"
		: "Login";
	const disabled = interactionLocked || settingModel || isBusy || (group.authConfigured && group.authSource === "environment");
	const title = group.authConfigured
		? group.authSource === "environment"
			? t("models.auth.envConfigured")
			: t("models.auth.logoutFrom", { provider: group.providerLabel })
		: group.isDefaultOAuthProvider
			? t("models.auth.openTerminalLogin", { provider: group.providerLabel })
			: t("models.auth.setupProvider", { provider: group.providerLabel });
	return {
		action,
		label,
		title,
		disabled,
		isBusy,
	};
}

export function resolveModelPickerAuthHint(
	group: Pick<ModelPickerProviderGroup, "authConfigured" | "isDefaultOAuthProvider">,
	hasModels: boolean,
): string {
	if (group.authConfigured) {
		if (hasModels) return "";
		return group.isDefaultOAuthProvider
			? t("models.auth.connectedNoModelsOauth")
			: t("models.auth.connectedNoModels");
	}
	return group.isDefaultOAuthProvider
		? t("models.auth.notConnectedOauth")
		: t("models.auth.notConnected");
}
