export type SidebarSessionStatus = "running" | "unread" | "suspended" | null;

/**
 * One stable status owns the sidebar slot. Active execution wins; once it
 * settles, the blue dot is driven by unread/attention state rather than a
 * permanent completed outcome. Process suspension is only an idle fallback.
 */
export function resolveSidebarSessionStatus(
	running: boolean,
	suspended: boolean,
	unread: boolean,
): SidebarSessionStatus {
	if (running) return "running";
	if (unread) return "unread";
	if (suspended) return "suspended";
	return null;
}
