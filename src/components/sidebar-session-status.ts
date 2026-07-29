export type SessionRunOutcome = "completed" | "failed";

export type SidebarSessionStatus = "running" | "suspended" | SessionRunOutcome | null;

/**
 * One stable status owns the sidebar slot. Active execution wins, followed by
 * the latest settled outcome; process suspension is only an idle fallback.
 */
export function resolveSidebarSessionStatus(
	running: boolean,
	suspended: boolean,
	outcome: SessionRunOutcome | null,
): SidebarSessionStatus {
	if (running) return "running";
	if (outcome) return outcome;
	if (suspended) return "suspended";
	return null;
}

export function normalizeSessionRunOutcome(value: unknown): SessionRunOutcome | null {
	return value === "completed" || value === "failed" ? value : null;
}
