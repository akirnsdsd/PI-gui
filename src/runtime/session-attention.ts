export interface MutableSessionAttention {
	needsAttention: boolean;
	attentionMessage: string | null;
}

/** Apply one unread/read transition and report whether persisted state changed. */
export function setSessionAttention(
	target: MutableSessionAttention,
	needsAttention: boolean,
	message: string | null = null,
): boolean {
	const nextMessage = needsAttention ? message : null;
	if (target.needsAttention === needsAttention && target.attentionMessage === nextMessage) return false;
	target.needsAttention = needsAttention;
	target.attentionMessage = nextMessage;
	return true;
}

/** Clear unread state only for entries owned by the requested project. */
export function clearMatchingSessionAttention<T extends MutableSessionAttention>(
	entries: readonly T[],
	matches: (entry: T) => boolean,
): boolean {
	let changed = false;
	for (const entry of entries) {
		if (!matches(entry)) continue;
		changed = setSessionAttention(entry, false) || changed;
	}
	return changed;
}
