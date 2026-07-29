import type { DesktopThemeResolved } from "./theme-manager.js";

export type ThemeVariant = "light" | "dark";

export interface DesktopAppearanceProfile {
	themeName: string;
	accent: string;
	background: string;
	foreground: string;
	uiFont: string;
	codeFont: string;
	translucentSidebar: boolean;
	contrast: number;
}

export interface DesktopAppearanceProfiles {
	light: DesktopAppearanceProfile;
	dark: DesktopAppearanceProfile;
}

export const DESKTOP_APPEARANCE_PROFILES_STORAGE_KEY = "pi-desktop.appearance.profiles.v1";
export const DESKTOP_APPEARANCE_PROFILE_CHANGED_EVENT = "pi-desktop:appearance-profile-changed";

const DEFAULT_UI_FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "SF Pro Text", "Segoe UI", sans-serif';
// 旧默认字体栈：迁移到含 PingFang SC 的新默认（用户手改的字体不受影响）
const LEGACY_DEFAULT_UI_FONTS = new Set([
	'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
	'-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif',
]);
const DEFAULT_CODE_FONT = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export const DEFAULT_APPEARANCE_PROFILES: DesktopAppearanceProfiles = {
	light: {
		themeName: "pi-desktop-default-light",
		accent: "",
		background: "",
		foreground: "",
		uiFont: DEFAULT_UI_FONT,
		codeFont: DEFAULT_CODE_FONT,
		translucentSidebar: false,
		contrast: 45,
	},
	dark: {
		themeName: "pi-desktop-default-dark",
		accent: "",
		background: "",
		foreground: "",
		uiFont: DEFAULT_UI_FONT,
		codeFont: DEFAULT_CODE_FONT,
		translucentSidebar: false,
		contrast: 60,
	},
};

// Legacy default theme names → Codex-style monochrome defaults.
const LEGACY_DEFAULT_THEME_NAMES: Record<string, string> = {
	"pi-desktop-notion-light": "pi-desktop-default-light",
	"pi-desktop-notion-dark": "pi-desktop-default-dark",
};

function clampContrast(value: number): number {
	if (!Number.isFinite(value)) return 50;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function sanitizeFont(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed.length === 0) return fallback;
	return LEGACY_DEFAULT_UI_FONTS.has(trimmed) ? fallback : trimmed;
}

function sanitizeThemeName(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed || trimmed === "dark" || trimmed === "light" || trimmed === "system") return "";
	return trimmed;
}

function sanitizeProfile(value: unknown, fallback: DesktopAppearanceProfile): DesktopAppearanceProfile {
	const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const storedThemeName = sanitizeThemeName(input.themeName);
	const themeName = LEGACY_DEFAULT_THEME_NAMES[storedThemeName] ?? storedThemeName ?? "";
	return {
		themeName: themeName || fallback.themeName,
		// Color overrides are intentionally ephemeral in Settings and only persisted via "Create theme".
		accent: "",
		background: "",
		foreground: "",
		uiFont: sanitizeFont(input.uiFont, fallback.uiFont),
		codeFont: sanitizeFont(input.codeFont, fallback.codeFont),
		translucentSidebar: typeof input.translucentSidebar === "boolean" ? input.translucentSidebar : fallback.translucentSidebar,
		contrast: clampContrast(typeof input.contrast === "number" ? input.contrast : fallback.contrast),
	};
}

export function loadDesktopAppearanceProfiles(): DesktopAppearanceProfiles {
	try {
		const raw = localStorage.getItem(DESKTOP_APPEARANCE_PROFILES_STORAGE_KEY);
		if (!raw) {
			return {
				light: sanitizeProfile({}, DEFAULT_APPEARANCE_PROFILES.light),
				dark: sanitizeProfile({}, DEFAULT_APPEARANCE_PROFILES.dark),
			};
		}
		const parsed = JSON.parse(raw) as unknown;
		const input = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		return {
			light: sanitizeProfile(input.light, DEFAULT_APPEARANCE_PROFILES.light),
			dark: sanitizeProfile(input.dark, DEFAULT_APPEARANCE_PROFILES.dark),
		};
	} catch {
		return {
			light: sanitizeProfile({}, DEFAULT_APPEARANCE_PROFILES.light),
			dark: sanitizeProfile({}, DEFAULT_APPEARANCE_PROFILES.dark),
		};
	}
}

export function saveDesktopAppearanceProfiles(profiles: DesktopAppearanceProfiles): void {
	try {
		localStorage.setItem(DESKTOP_APPEARANCE_PROFILES_STORAGE_KEY, JSON.stringify(profiles));
	} catch {
		// ignore
	}
}

export function getAppearanceProfileForResolvedTheme(
	profiles: DesktopAppearanceProfiles,
	resolved: DesktopThemeResolved,
): DesktopAppearanceProfile {
	return resolved === "light" ? profiles.light : profiles.dark;
}

export function applyDesktopAppearanceProfileToRoot(
	resolved: DesktopThemeResolved,
	profiles: DesktopAppearanceProfiles,
): void {
	const profile = getAppearanceProfileForResolvedTheme(profiles, resolved);
	const root = document.documentElement;

	if (profile.accent) {
		root.style.setProperty("--color-accent-primary", profile.accent);
		root.style.setProperty("--color-accent-soft", `color-mix(in srgb, ${profile.accent} 20%, transparent)`);
	}

	if (profile.background) {
		// Codex-style neutral derivation: light themes shade toward black in
		// small steps (elevated lifts toward white); dark themes lift toward white.
		// Each entry is "backgroundPct, mixColor mixPct" and sums to 100%.
		const mixes = resolved === "dark"
			? { elevated: "96%, white 4%", muted: "94%, white 6%", soft: "90%, white 10%", sidebar: "96%, white 4%", chrome: "98%, white 2%", chromeSoft: "95%, white 5%" }
			: { elevated: "92%, white 8%", muted: "96%, black 4%", soft: "94%, black 6%", sidebar: "97.5%, black 2.5%", chrome: "98%, black 2%", chromeSoft: "94%, black 6%" };
		root.style.setProperty("--color-bg-app", profile.background);
		root.style.setProperty("--color-bg-elevated", `color-mix(in srgb, ${profile.background} ${mixes.elevated})`);
		root.style.setProperty("--color-bg-muted", `color-mix(in srgb, ${profile.background} ${mixes.muted})`);
		root.style.setProperty("--color-bg-soft", `color-mix(in srgb, ${profile.background} ${mixes.soft})`);
		root.style.setProperty("--color-bg-sidebar", `color-mix(in srgb, ${profile.background} ${mixes.sidebar})`);
		root.style.setProperty("--color-bg-workspace-chrome", `color-mix(in srgb, ${profile.background} ${mixes.chrome})`);
		root.style.setProperty("--color-bg-workspace-chrome-soft", `color-mix(in srgb, ${profile.background} ${mixes.chromeSoft})`);
	}

	if (profile.foreground) {
		const bgForMix = profile.background || "transparent";
		const secondaryMix = resolved === "dark" ? 60 : 68;
		const tertiaryMix = resolved === "dark" ? 39 : 33;
		const borderMixStrength = resolved === "dark" ? 10.5 : 11;
		root.style.setProperty("--color-text-primary", profile.foreground);
		root.style.setProperty("--color-text-secondary", `color-mix(in srgb, ${profile.foreground} ${secondaryMix}%, ${bgForMix} ${100 - secondaryMix}%)`);
		root.style.setProperty("--color-text-tertiary", `color-mix(in srgb, ${profile.foreground} ${tertiaryMix}%, ${bgForMix} ${100 - tertiaryMix}%)`);
		root.style.setProperty("--color-border-default", `color-mix(in srgb, ${profile.foreground} ${borderMixStrength}%, transparent)`);
	}

	root.style.setProperty("--font-family-sans", profile.uiFont);
	root.style.setProperty("--font-family-mono", profile.codeFont);
	root.style.setProperty("--desktop-sidebar-opacity", profile.translucentSidebar ? "88%" : "100%");
	root.style.setProperty("--desktop-sidebar-blur", profile.translucentSidebar ? "14px" : "0px");
	root.style.setProperty("--desktop-sidebar-tint-color", profile.foreground || "var(--color-text-primary)");
	root.style.setProperty("--desktop-sidebar-tint-strength", profile.translucentSidebar ? "8%" : "0%");
	root.style.setProperty("--desktop-chrome-opacity", profile.translucentSidebar ? "92%" : "100%");
	root.style.setProperty("--desktop-chrome-blur", profile.translucentSidebar ? "12px" : "0px");
	root.style.setProperty("--desktop-chrome-tint-strength", profile.translucentSidebar ? "5%" : "0%");
	root.style.setProperty("--desktop-contrast", String(profile.contrast));

	const borderMix = 40 + Math.round((profile.contrast / 100) * 60);
	root.style.setProperty("--border", `color-mix(in srgb, var(--color-border-default) ${borderMix}%, transparent)`);
	root.dataset.desktopContrast = String(profile.contrast);
}

export function notifyDesktopAppearanceProfileChanged(): void {
	window.dispatchEvent(new CustomEvent(DESKTOP_APPEARANCE_PROFILE_CHANGED_EVENT));
}
