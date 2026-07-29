export type InlineTitleKeyAction = "commit" | "cancel" | null;

export function resolveInlineTitleKeyAction(
	key: string,
	eventIsComposing: boolean,
	compositionActive: boolean,
): InlineTitleKeyAction {
	if (key === "Escape") return "cancel";
	if (key === "Enter" && !eventIsComposing && !compositionActive) return "commit";
	return null;
}

export type SessionRefreshScrollAction = "schedule-latest" | "preserve-user-position" | "follow-stream";

export function resolveSessionRefreshScrollAction(
	pendingGeneration: number | null,
	previewSettledGeneration: number | null,
	autoFollow: boolean,
): SessionRefreshScrollAction {
	if (pendingGeneration !== null) return "schedule-latest";
	if (previewSettledGeneration !== null || !autoFollow) return "preserve-user-position";
	return "follow-stream";
}

export function toggleCompactSidebarOverlay(isCompact: boolean, currentlyOpen: boolean): boolean {
	return isCompact ? !currentlyOpen : false;
}

export function shouldRestoreInlineTitleRename(
	saved: boolean,
	requestGeneration: number,
	currentGeneration: number,
): boolean {
	return !saved && requestGeneration === currentGeneration;
}

export function shouldRollbackSessionTitle(
	persisted: boolean,
	failed: boolean,
	currentTitleStillMatches: boolean,
): boolean {
	return !persisted && failed && currentTitleStillMatches;
}

export function resolveViewportPopoverLeft(
	anchorRight: number,
	popoverWidth: number,
	viewportWidth: number,
	padding = 8,
): number {
	const safePadding = Math.max(0, padding);
	const maxLeft = Math.max(safePadding, viewportWidth - popoverWidth - safePadding);
	const preferredLeft = anchorRight - popoverWidth;
	return Math.min(maxLeft, Math.max(safePadding, preferredLeft));
}
