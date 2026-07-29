export type SessionRuntimeLifecyclePhase =
	| "idle"
	| "starting"
	| "switching_session"
	| "creating_session"
	| "ready"
	| "failed";

export interface SessionRuntimeLifecycleState {
	/** Whether the chat UI should currently present streaming/running feedback. */
	uiRunning: boolean;
	/**
	 * Whether the session-level run has started but has not reached its terminal
	 * `agent_settled` (or terminal failure) boundary yet.
	 */
	awaitingAgentSettled: boolean;
}

export type SessionRuntimeLifecycleSignal =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "streaming_state"; isStreaming: boolean }
	| { type: "agent_settled" }
	| { type: "terminal_failure" };

export const INITIAL_SESSION_RUNTIME_LIFECYCLE: Readonly<SessionRuntimeLifecycleState> = Object.freeze({
	uiRunning: false,
	awaitingAgentSettled: false,
});

/**
 * Reduces protocol and polling signals without conflating UI streaming with the
 * longer session-level run boundary.
 *
 * `agent_end` and `streaming_state: false` only stop the UI indicator. They do
 * not release the runtime until pi emits `agent_settled`, because retries,
 * compaction, or queued continuation may still use the originating extension
 * context in that interval.
 */
export function reduceSessionRuntimeLifecycle(
	state: Readonly<SessionRuntimeLifecycleState>,
	signal: SessionRuntimeLifecycleSignal,
): SessionRuntimeLifecycleState {
	switch (signal.type) {
		case "agent_start":
			return { uiRunning: true, awaitingAgentSettled: true };
		case "agent_end":
			return {
				uiRunning: false,
				awaitingAgentSettled: state.awaitingAgentSettled,
			};
		case "streaming_state":
			return {
				uiRunning: signal.isStreaming,
				awaitingAgentSettled: signal.isStreaming ? true : state.awaitingAgentSettled,
			};
		case "agent_settled":
		case "terminal_failure":
			return { uiRunning: false, awaitingAgentSettled: false };
	}
}

/**
 * Returns whether switching, suspending, reusing, or replacing this runtime can
 * invalidate an in-flight session/extension context.
 */
export function isSessionRuntimeLifecycleProtected(
	phase: SessionRuntimeLifecyclePhase,
	state: Readonly<SessionRuntimeLifecycleState>,
): boolean {
	return phase === "starting" ||
		phase === "switching_session" ||
		phase === "creating_session" ||
		state.uiRunning ||
		state.awaitingAgentSettled;
}

/** Keep late completion/extension events owned by the bridge that emitted them. */
export function resolveSessionRuntimeEventSource(
	eventRuntimeKey: string,
	activeRuntimeKey: string | null,
): "active" | "background" {
	return eventRuntimeKey === activeRuntimeKey ? "active" : "background";
}

/** Reject duplicate or delayed settlement work from an older task generation. */
export function isCurrentSessionRuntimeSettlement(
	currentRunEpoch: number,
	scheduledRunEpoch: number,
	awaitingAgentSettled: boolean,
): boolean {
	return awaitingAgentSettled && currentRunEpoch === scheduledRunEpoch;
}
