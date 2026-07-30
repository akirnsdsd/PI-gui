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

/**
 * 「agent 运行围栏」：只判断这个 runtime 上是否真的有 agent 工作在进行中，
 * 不看 phase 里的启动/切换等中间态。
 *
 * 与 isSessionRuntimeLifecycleProtected 的分工：
 * - 后者是广义生命周期保护，用于挂起、空闲回收、标签复用、重启编排等场景——
 *   这些场景下 starting/switching_session/creating_session 也必须被拦住，
 *   否则会在切换过程中把 runtime 抽走。
 * - 本函数用于「因为后台还在跑，所以拒绝这次操作」这类语义。这种判断绝不能读
 *   phase，因为 phase 可能正是本次操作自己刚设进去的中间态（例如
 *   ensureRuntimeForSessionTab 冷启动时先设 starting，随后又拿它做守卫），
 *   那样会变成自我阻断。
 *
 * awaitingAgentSettled 必须一并计入：agent_end 之后 UI 的 streaming 已停，但扩展
 * 回调、自动重试、continuation 可能仍未真正结束，此时切走会话依然会丢上下文。
 */
export function isSessionRuntimeAgentRunFenced(state: Readonly<SessionRuntimeLifecycleState>): boolean {
	return state.uiRunning || state.awaitingAgentSettled;
}

/**
 * 「能不能把这个 runtime 重新附着到另一个会话 / 另一个项目」的完整判定。
 *
 * 抽成纯函数的理由：调用它的 ensureRuntimeForSessionTab 是一个两百多行、带真实
 * 进程启停的 async 函数，无法在无浏览器的 selftest 里跑。而这个判定本身出过真
 * bug（commit 9407085）：冷启动/收养热备时先把 phase 设成 starting，随后又拿 phase
 * 做守卫，导致切会话必报「仍在后台运行」。只断言底层的 run fence 抵不住这个回归
 * ——把调用点改回 isSessionRuntimeLifecycleProtected 它照样过。所以把「该用哪个判定」
 * 这个决策本身制成纯函数，让测试能直接钉住它。
 *
 * 入参故意包含 phase：不是因为要用它做判断，而是为了能断言「传任何中间态
 * 都不影响结果」。
 */
export function shouldRefuseSessionRuntimeReattach(
	_phase: SessionRuntimeLifecyclePhase,
	state: Readonly<SessionRuntimeLifecycleState>,
): boolean {
	return isSessionRuntimeAgentRunFenced(state);
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
