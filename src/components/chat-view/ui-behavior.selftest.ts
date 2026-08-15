import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { html } from "lit";
import { mapBackendMessages } from "./backend-message-mapper.js";
import { renderMessageTimelineRows } from "./message-timeline-view.js";
import {
	collectAssistantWorkflow,
	resolveWorkflowDurationMs,
	resolveWorkflowExpansionState,
	type WorkflowToolCall,
} from "./workflow-utils.js";
import {
	resolveInlineTitleKeyAction,
	resolveModelPickerSubmenuPlacement,
	resolveSessionRefreshScrollAction,
	resolveThinkingLevelOptions,
	resolveViewportPopoverLeft,
	subtractBlockedThinkingLevels,
	shouldRollbackSessionTitle,
	shouldRestoreInlineTitleRename,
	toggleCompactSidebarOverlay,
} from "../desktop-ui-behavior.js";
import { formatPendingFileDisplayName } from "./composer-fragments-view.js";
import { parseTodoDetails } from "../todo-panel.js";
import { resolveSidebarSessionStatus } from "../sidebar-session-status.js";
import {
	INITIAL_SESSION_RUNTIME_LIFECYCLE,
	isCurrentSessionRuntimeSettlement,
	isSessionRuntimeAgentRunFenced,
	isSessionRuntimeLifecycleProtected,
	shouldRefuseSessionRuntimeReattach,
	reduceSessionRuntimeLifecycle,
	resolveSessionRuntimeEventSource,
} from "../../runtime/session-runtime-lifecycle.js";
import {
	clearMatchingSessionAttention,
	setSessionAttention,
} from "../../runtime/session-attention.js";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		passed += 1;
		return;
	}
	failed += 1;
	console.error(`FAIL: ${name}`, detail);
}

const runningTool: WorkflowToolCall = {
	id: "tool-1",
	name: "read",
	args: { path: "README.md" },
	isRunning: true,
	isExpanded: false,
	startedAt: 1000,
};

{
	const collapsed = resolveWorkflowExpansionState({
		workflowId: "workflow-1",
		toolCalls: [runningTool],
		isTerminal: true,
		keepWorkflowExpandedUntilAssistantText: true,
		runSawToolActivity: true,
		expandedWorkflowIds: new Set(),
		collapsedAutoWorkflowIds: new Set(),
	});
	check("running workflow defaults collapsed", collapsed.expanded === false && collapsed.autoExpanded === false, collapsed);

	const expanded = resolveWorkflowExpansionState({
		workflowId: "workflow-1",
		toolCalls: [runningTool],
		isTerminal: true,
		keepWorkflowExpandedUntilAssistantText: true,
		runSawToolActivity: true,
		expandedWorkflowIds: new Set(["workflow-1"]),
		collapsedAutoWorkflowIds: new Set(),
	});
	check("workflow expands only after explicit disclosure", expanded.expanded === true, expanded);
}

{
	const messages = mapBackendMessages({
		backendMessages: [{ id: "entry-1", role: "compactionSummary", summary: "hidden context summary" }],
		allThinkingExpanded: false,
		createId: (prefix = "id") => `${prefix}-generated`,
		extractText: () => "",
		extractImages: () => [],
		extractToolOutput: () => "",
	});
	const compaction = messages[0];
	check(
		"historical compaction summary is collapsed by default",
		Boolean(compaction?.collapsibleTitle) && compaction?.collapsibleExpanded === false,
		compaction,
	);
}

{
	check("inline title commits on Enter", resolveInlineTitleKeyAction("Enter", false, false) === "commit");
	check("inline title cancels on Escape", resolveInlineTitleKeyAction("Escape", false, false) === "cancel");
	check("inline title ignores IME Enter", resolveInlineTitleKeyAction("Enter", true, true) === null);
	check("failed current title rename restores previous title", shouldRestoreInlineTitleRename(false, 2, 2));
	check("stale title rename cannot restore over a newer edit", !shouldRestoreInlineTitleRename(false, 2, 3));
	check("title persistence failure rolls back optimistic UI", shouldRollbackSessionTitle(false, true, true));
	check("post-save refresh failure never rolls back persisted title", !shouldRollbackSessionTitle(true, true, true));
}

{
	check("running elapsed time advances", resolveWorkflowDurationMs(1_000, 0, true, 4_250) === 3_250);
	check("completed elapsed time freezes", resolveWorkflowDurationMs(1_000, 2_500, false, 9_000) === 1_500);
	check("elapsed time never becomes negative", resolveWorkflowDurationMs(2_000, 0, true, 1_000) === 0);

	const provisional = collectAssistantWorkflow({
		messages: [{
			id: "thinking-1",
			role: "assistant",
			text: "",
			thinking: "working",
			toolCalls: [],
			isStreaming: true,
		}],
		startIndex: 0,
		currentIsStreaming: true,
		runHasAssistantText: false,
		fallbackStartedAt: 1_000,
		truncateText: (value) => value,
	});
	check(
		"thinking-only workflow uses run start time",
		provisional?.workflow.startedAt === 1_000 && provisional.workflow.isStreaming,
		provisional,
	);

	const completed = collectAssistantWorkflow({
		messages: [{
			id: "thinking-2",
			role: "assistant",
			text: "",
			thinking: "done thinking",
			toolCalls: [],
			startedAt: 1_000,
			endedAt: 3_000,
			isStreaming: false,
		}],
		startIndex: 0,
		currentIsStreaming: false,
		runHasAssistantText: false,
		fallbackStartedAt: 0,
		truncateText: (value) => value,
	});
	check(
		"completed thinking-only workflow remains a collapsed trace row",
		completed?.workflow.startedAt === 1_000 &&
			completed.workflow.endedAt === 3_000 &&
			!completed.workflow.isStreaming,
		completed,
	);

	const completedWithFinalText = collectAssistantWorkflow({
		messages: [{
			id: "thinking-with-answer",
			role: "assistant",
			text: "final answer",
			thinking: "reasoning trace",
			toolCalls: [],
			startedAt: 1_000,
			endedAt: 4_000,
			isStreaming: false,
		}],
		startIndex: 0,
		currentIsStreaming: false,
		runHasAssistantText: true,
		fallbackStartedAt: 0,
		truncateText: (value) => value,
	});
	check(
		"completed thinking plus final text stays in the workflow trace",
		completedWithFinalText?.workflow.thinkingText === "reasoning trace" &&
			completedWithFinalText.workflow.finalText === "final answer" &&
			completedWithFinalText.workflow.endedAt === 4_000 &&
			completedWithFinalText.nextIndex === 1,
		completedWithFinalText,
	);

	// 回归：模型同一轮「先说话再调工具」产生 text+toolCalls 混合消息时，
	// 这段正文必须留在 finalText 里（此前被 toolCalls 过滤整段吞掉）。
	const mixedTextAndTools = collectAssistantWorkflow({
		messages: [
			{
				id: "mixed-1",
				role: "assistant",
				text: "先说一下结论",
				toolCalls: [{
					id: "tool-1",
					name: "bash",
					args: { command: "ls" },
					result: "ok",
					isRunning: false,
					isExpanded: false,
					startedAt: 1_100,
					endedAt: 2_000,
				}],
				startedAt: 1_000,
				endedAt: 2_500,
				isStreaming: false,
			},
			{
				id: "mixed-final",
				role: "assistant",
				text: "最终回答",
				toolCalls: [],
				startedAt: 2_600,
				endedAt: 3_000,
				isStreaming: false,
			},
		],
		startIndex: 0,
		currentIsStreaming: false,
		runHasAssistantText: true,
		fallbackStartedAt: 0,
		truncateText: (value) => value,
	});
	check(
		"text on a tool-calling message is preserved in finalText",
		mixedTextAndTools?.workflow.finalText === "先说一下结论\n\n最终回答" &&
			mixedTextAndTools.workflow.toolCalls.length === 1 &&
			mixedTextAndTools.nextIndex === 2,
		mixedTextAndTools,
	);
}

{
	// keyed repeat 契约：同一批消息对象 prepend 历史后 key 不变、顺序正确，
	// lit repeat() 据此移动 DOM 而不是全量重建（markdown 不重 parse）。
	const timelineMessages = [
		{ id: "u1", role: "user" as const, text: "问题一", toolCalls: [] },
		{ id: "a1", role: "assistant" as const, text: "回答一", toolCalls: [] },
		{ id: "u2", role: "user" as const, text: "问题二", toolCalls: [] },
	];
	const timelineParams = {
		compactionCycle: null,
		compactionInsertIndex: null,
		collectAssistantWorkflow: () => null,
		renderAssistantWorkflow: () => html``,
		renderUserMessage: () => html``,
		hasRenderableAssistantContent: () => true,
		renderAssistantMessage: () => html``,
		renderChangelogMessage: () => html``,
		renderSystemMessage: () => html``,
		renderCompactionCycle: () => html``,
	};
	const tailKeys = renderMessageTimelineRows({ messages: timelineMessages.slice(1), ...timelineParams }).map((row) => row.key);
	const fullKeys = renderMessageTimelineRows({ messages: timelineMessages, ...timelineParams }).map((row) => row.key);
	check(
		"timeline row keys stay stable across history prepend",
		tailKeys.join(",") === "assistant-a1,user-u2" &&
			fullKeys.join(",") === "user-u1,assistant-a1,user-u2",
		{ tailKeys, fullKeys },
	);
}

{
	check(
		"preview-settled session preserves user scroll on authoritative refresh",
		resolveSessionRefreshScrollAction(null, 3, false) === "preserve-user-position",
	);
	check(
		"session without preview schedules one forced bottom scroll",
		resolveSessionRefreshScrollAction(4, null, true) === "schedule-latest",
	);
	check(
		"ordinary streaming follows only while auto-follow is enabled",
		resolveSessionRefreshScrollAction(null, null, true) === "follow-stream" &&
			resolveSessionRefreshScrollAction(null, null, false) === "preserve-user-position",
	);
}

{
	check("compact sidebar click opens overlay", toggleCompactSidebarOverlay(true, false) === true);
	check("compact sidebar second click closes overlay", toggleCompactSidebarOverlay(true, true) === false);
	check("wide sidebar click does not create overlay state", toggleCompactSidebarOverlay(false, true) === false);
	check("compact model picker stays inside left viewport edge", resolveViewportPopoverLeft(318, 404, 420) === 8);
	check("wide model picker preserves right anchoring", resolveViewportPopoverLeft(900, 470, 1100) === 430);
}

{
	const aligned = resolveModelPickerSubmenuPlacement({
		preferredPopoverLeft: 400,
		popoverWidth: 204,
		popoverTop: 200,
		anchorTop: 270,
		submenuWidth: 204,
		submenuHeight: 180,
		contentLeft: 8,
		contentRight: 1192,
		contentBottom: 900,
		gap: 3,
	});
	check(
		"model submenu aligns with the hovered provider row",
		aligned.top === 70 &&
			aligned.side === "right" &&
			aligned.popoverLeft === 400 &&
			aligned.submenuLeft === 607,
		aligned,
	);

	const moved = resolveModelPickerSubmenuPlacement({
		preferredPopoverLeft: 400,
		popoverWidth: 204,
		popoverTop: 200,
		anchorTop: 302,
		submenuWidth: 204,
		submenuHeight: 180,
		contentLeft: 8,
		contentRight: 1192,
		contentBottom: 900,
		gap: 3,
	});
	check("hovering another provider moves the submenu to that row", moved.top === 102, moved);

	const flipped = resolveModelPickerSubmenuPlacement({
		preferredPopoverLeft: 550,
		popoverWidth: 204,
		popoverTop: 200,
		anchorTop: 228,
		submenuWidth: 204,
		submenuHeight: 180,
		contentLeft: 8,
		contentRight: 760,
		contentBottom: 900,
		gap: 3,
	});
	check(
		"model submenu flips left when the right side does not fit",
		flipped.side === "left" &&
			flipped.popoverLeft === 550 &&
			flipped.submenuLeft === 343 &&
			flipped.top === 28,
		flipped,
	);

	const exactRight = resolveModelPickerSubmenuPlacement({
		preferredPopoverLeft: 345,
		popoverWidth: 204,
		popoverTop: 100,
		anchorTop: 100,
		submenuWidth: 204,
		submenuHeight: 180,
		contentLeft: 8,
		contentRight: 756,
		contentBottom: 900,
		gap: 3,
	});
	check(
		"model submenu keeps the preferred right side at the exact boundary",
		exactRight.side === "right" &&
			exactRight.popoverLeft === 345 &&
			exactRight.submenuLeft === 552,
		exactRight,
	);

	const narrow = resolveModelPickerSubmenuPlacement({
		preferredPopoverLeft: 180,
		popoverWidth: 168,
		popoverTop: 140,
		anchorTop: 196,
		submenuWidth: 176,
		submenuHeight: 180,
		contentLeft: 8,
		contentRight: 412,
		contentBottom: 400,
		gap: 2,
	});
	check(
		"narrow model menus shift together without overlap",
		narrow.popoverLeft >= 8 &&
			narrow.submenuLeft >= narrow.popoverLeft + 168 + 2 &&
			narrow.submenuLeft + narrow.submenuWidth <= 412 &&
			narrow.top === 56,
		narrow,
	);

	const visibleChatBounds = resolveModelPickerSubmenuPlacement({
		preferredPopoverLeft: 350,
		popoverWidth: 204,
		popoverTop: 180,
		anchorTop: 276,
		submenuWidth: 204,
		submenuHeight: 180,
		contentLeft: 330,
		contentRight: 900,
		contentBottom: 720,
		gap: 3,
	});
	check(
		"model menu pair stays inside the current chat content bounds",
		visibleChatBounds.popoverLeft >= 330 &&
			visibleChatBounds.submenuLeft === visibleChatBounds.popoverLeft + 207 &&
			visibleChatBounds.submenuLeft + visibleChatBounds.submenuWidth <= 900 &&
			visibleChatBounds.top === 96,
		visibleChatBounds,
	);

	const lowerRow = resolveModelPickerSubmenuPlacement({
		preferredPopoverLeft: 400,
		popoverWidth: 204,
		popoverTop: 600,
		anchorTop: 790,
		submenuWidth: 204,
		submenuHeight: 244,
		contentLeft: 8,
		contentRight: 1192,
		contentBottom: 850,
		gap: 3,
	});
	check(
		"lower provider row keeps alignment and limits submenu height",
		lowerRow.top === 190 && lowerRow.submenuMaxHeight === 60,
		lowerRow,
	);

	const nearlyBlockedByComposer = resolveModelPickerSubmenuPlacement({
		preferredPopoverLeft: 400,
		popoverWidth: 204,
		popoverTop: 620,
		anchorTop: 810,
		submenuWidth: 204,
		submenuHeight: 244,
		contentLeft: 8,
		contentRight: 1192,
		contentBottom: 820,
		gap: 3,
	});
	check(
		"model submenu never exceeds the space above the composer",
		nearlyBlockedByComposer.submenuMaxHeight === 10,
		nearlyBlockedByComposer,
	);
}

{
	check(
		"sidebar running state replaces unread attention",
		resolveSidebarSessionStatus(true, false, true) === "running",
	);
	check(
		"sidebar unread attention remains visible after runtime suspension",
		resolveSidebarSessionStatus(false, true, true) === "unread",
	);
	check(
		"read settled session has no permanent completion marker",
		resolveSidebarSessionStatus(false, false, false) === null,
	);
	check(
		"sidebar suspension is only the idle fallback",
		resolveSidebarSessionStatus(false, true, false) === "suspended",
	);
}

{
	const tabs = [
		{ id: "a", projectId: "project-a", needsAttention: false, attentionMessage: null as string | null },
		{ id: "b", projectId: "project-b", needsAttention: false, attentionMessage: null as string | null },
	];
	setSessionAttention(tabs[0]!, true, "任务已完成");
	check(
		"background session completion marks only the originating session unread",
		tabs[0]?.needsAttention === true &&
			tabs[0]?.attentionMessage === "任务已完成" &&
			tabs[1]?.needsAttention === false,
		tabs,
	);
	setSessionAttention(tabs[0]!, false);
	check(
		"opening the completed session clears its unread marker",
		tabs.every((tab) => !tab.needsAttention && tab.attentionMessage === null),
		tabs,
	);
	setSessionAttention(tabs[0]!, true, "A");
	setSessionAttention(tabs[1]!, true, "B");
	const projectCleared = clearMatchingSessionAttention(
		tabs,
		(tab) => tab.projectId === "project-a",
	);
	check(
		"marking one project read preserves unread sessions in other projects",
		projectCleared &&
			tabs[0]?.needsAttention === false &&
			tabs[1]?.needsAttention === true &&
			tabs[1]?.attentionMessage === "B",
		tabs,
	);
}

{
	const started = reduceSessionRuntimeLifecycle(INITIAL_SESSION_RUNTIME_LIFECYCLE, { type: "agent_start" });
	check(
		"agent start enables UI running and protects the session runtime",
		started.uiRunning &&
			started.awaitingAgentSettled &&
			isSessionRuntimeLifecycleProtected("ready", started),
		started,
	);

	const ended = reduceSessionRuntimeLifecycle(started, { type: "agent_end" });
	check(
		"agent end stops UI running but keeps the runtime protected until settled",
		!ended.uiRunning &&
			ended.awaitingAgentSettled &&
			isSessionRuntimeLifecycleProtected("ready", ended),
		ended,
	);

	const pollStarted = reduceSessionRuntimeLifecycle(INITIAL_SESSION_RUNTIME_LIFECYCLE, {
		type: "streaming_state",
		isStreaming: true,
	});
	const pollStopped = reduceSessionRuntimeLifecycle(pollStarted, {
		type: "streaming_state",
		isStreaming: false,
	});
	check(
		"polling streaming false stops UI running but does not release protection",
		!pollStopped.uiRunning &&
			pollStopped.awaitingAgentSettled &&
			isSessionRuntimeLifecycleProtected("ready", pollStopped),
		pollStopped,
	);

	const settled = reduceSessionRuntimeLifecycle(ended, { type: "agent_settled" });
	check(
		"agent settled releases the runtime for reuse",
		!settled.uiRunning &&
			!settled.awaitingAgentSettled &&
			!isSessionRuntimeLifecycleProtected("ready", settled),
		settled,
	);

	const failed = reduceSessionRuntimeLifecycle(started, { type: "terminal_failure" });
	check(
		"terminal failure releases the runtime protection",
		!failed.uiRunning &&
			!failed.awaitingAgentSettled &&
			!isSessionRuntimeLifecycleProtected("failed", failed),
		failed,
	);

	check(
		"session replacement phases stay protected without an active run",
		isSessionRuntimeLifecycleProtected("starting", INITIAL_SESSION_RUNTIME_LIFECYCLE) &&
			isSessionRuntimeLifecycleProtected("switching_session", INITIAL_SESSION_RUNTIME_LIFECYCLE) &&
			isSessionRuntimeLifecycleProtected("creating_session", INITIAL_SESSION_RUNTIME_LIFECYCLE),
	);
	// 回归：冷启动/收养热备时 ensureRuntimeForSessionTab 会先把 phase 设成 starting，
	// 随后的「不能切换所附着会话」守卫若读 phase 就会自我阻断（切会话必报
	// 「仍在后台运行」）。运行围栏只看真实运行状态，不受中间态污染。
	check(
		"agent run fence ignores transition phases and tracks only real runs",
		!isSessionRuntimeAgentRunFenced(INITIAL_SESSION_RUNTIME_LIFECYCLE) &&
			isSessionRuntimeAgentRunFenced(started) &&
			isSessionRuntimeAgentRunFenced(ended) &&
			!isSessionRuntimeAgentRunFenced(failed),
	);
	// 回归钉子（commit 9407085）：重新附着会话/项目的拒绝判定绝不能读 phase。
	// ensureRuntimeForSessionTab 在冷启动和收养热备时会先把 phase 设成 starting，
	// 若守卫读 phase，切会话会自我阻断并必报「仍在后台运行」。
	// 这条断言盯的是「守卫选了哪个判定」：把它改回
	// isSessionRuntimeLifecycleProtected 会立即变红。
	check(
		"session reattach refusal never reads transition phases",
		!["idle", "starting", "switching_session", "creating_session", "ready", "failed"].some((phase) =>
			shouldRefuseSessionRuntimeReattach(phase as Parameters<typeof shouldRefuseSessionRuntimeReattach>[0], INITIAL_SESSION_RUNTIME_LIFECYCLE),
		) &&
			shouldRefuseSessionRuntimeReattach("starting", started) &&
			shouldRefuseSessionRuntimeReattach("ready", ended) &&
			!shouldRefuseSessionRuntimeReattach("failed", failed),
	);
	check(
		"settled event remains owned by its original runtime after switching threads",
		resolveSessionRuntimeEventSource("runtime-a", "runtime-b") === "background" &&
			resolveSessionRuntimeEventSource("runtime-b", "runtime-b") === "active",
	);

	const scheduledEpoch = 4;
	check(
		"current run settlement is accepted exactly while its fence is active",
		isCurrentSessionRuntimeSettlement(4, scheduledEpoch, true),
	);
	check(
		"duplicate settlement is rejected after the fence has already released",
		!isCurrentSessionRuntimeSettlement(4, scheduledEpoch, false),
	);
	check(
		"delayed settlement from an older run cannot release the next run",
		!isCurrentSessionRuntimeSettlement(5, scheduledEpoch, true),
	);

	const fakeScheduledSettlements: Array<() => boolean> = [];
	let fakeEpoch = 8;
	let fakeLifecycle = ended;
	const queueSettlement = (): void => {
		const queuedEpoch = fakeEpoch;
		fakeScheduledSettlements.push(() =>
			isCurrentSessionRuntimeSettlement(fakeEpoch, queuedEpoch, fakeLifecycle.awaitingAgentSettled)
		);
	};
	queueSettlement();
	// A new prompt starts before the old zero-delay settlement callback runs.
	fakeEpoch += 1;
	fakeLifecycle = reduceSessionRuntimeLifecycle(fakeLifecycle, { type: "agent_start" });
	check(
		"fake scheduler keeps the new run protected when the old settled callback drains",
		fakeScheduledSettlements.shift()?.() === false &&
			isSessionRuntimeLifecycleProtected("ready", fakeLifecycle),
	);

	const disconnected = reduceSessionRuntimeLifecycle(ended, { type: "terminal_failure" });
	check(
		"disconnect terminalizes the original run instead of leaving a permanent fence",
		!isSessionRuntimeLifecycleProtected("ready", disconnected) &&
			resolveSessionRuntimeEventSource("runtime-a", "runtime-b") === "background",
		disconnected,
	);
}

{
	check(
		"attachment tray shows a compact filename instead of its path token",
		formatPendingFileDisplayName(
			"research-notes-final.md",
			(value, length) => value.slice(0, length),
		) === "research-notes-final.md",
	);
}

{
	// 源码契约检查（commit 9407085 回归防护的第二道阁）。
	//
	// 上面的纯函数断言只能保证判定本身不读 phase，抵不住真正的回归形式：
	// 有人直接把调用点改回 isSessionRuntimeProtected。那种改动类型兼容、tsc 不报错，
	// 但会让冷启动/收养热备时切会话确定性误报「仍在后台运行」。
	//
	// 因为没有前端测试框架（ensureRuntimeForSessionTab 是带真实进程启停的 async
	// 函数，无法在 node 里跑），这里退一步直接断言源码：两处报「仍在后台运行」
	// 的 throw 之前，守卫必须调 isSessionRuntimeAgentRunning。
	// bundle 输出在 node_modules/.cache，不能用 import.meta.url 推源码位置；
	// npm run test:ui 从 app/ 目录执行，从 cwd 解析。
	const mainSource = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf-8");
	const guardedThrows = [
		"当前线程仍在后台运行，不能把它的 runtime 切换到另一个项目",
		"当前线程仍在后台运行，不能切换它所附着的会话",
	];
	const guardResults = guardedThrows.map((message) => {
		const throwIndex = mainSource.indexOf(message);
		if (throwIndex < 0) return { message, found: false, guarded: false };
		// 只看 throw 之前的一小段，避免误匹配到别处的调用。
		const preceding = mainSource.slice(Math.max(0, throwIndex - 240), throwIndex);
		return {
			message,
			found: true,
			guarded: preceding.includes("isSessionRuntimeAgentRunning(runtime)") &&
				!preceding.includes("isSessionRuntimeProtected(runtime)"),
		};
	});
	check(
		"background-run refusals in main.ts are guarded by the agent run fence, not phase protection",
		guardResults.every((result) => result.found && result.guarded),
		guardResults,
	);
}

{
	// 思考程度档位的三态解析。pi 的可用档位由模型的 reasoning / thinkingLevelMap 决定
	// （xhigh 与 max 必须显式声明），所以「未知」绝不能退化成「全部可用」——
	// 那会在 reasoning:false 或基础档被 null 禁用的模型上给出整片假选项。
	check(
		"thinking options: 未知时只给当前档，不猜模型能力",
		JSON.stringify(resolveThinkingLevelOptions(null, "max")) === JSON.stringify(["max"]),
		resolveThinkingLevelOptions(null, "max"),
	);
	check(
		"thinking options: 权威空列表仍保留当前档以免菜单空白",
		JSON.stringify(resolveThinkingLevelOptions([], "off")) === JSON.stringify(["off"]),
		resolveThinkingLevelOptions([], "off"),
	);
	check(
		"thinking options: 权威列表原样透出",
		JSON.stringify(resolveThinkingLevelOptions(["off", "high", "max"], "high")) ===
			JSON.stringify(["off", "high", "max"]),
	);
	check(
		"thinking options: 当前档不在权威列表时补进去（刚切模型/列表陈旧）",
		JSON.stringify(resolveThinkingLevelOptions(["max", "xhigh"], "medium")) ===
			JSON.stringify(["max", "xhigh", "medium"]),
	);

	// 权威列表与反应式 blocked 的合并：前者可能陈旧（配置重启后模型能力会变），
	// 后者是从真实夹取结果学到的。
	check(
		"thinking blocked: 未知态原样透传，保持三态不塌成两态",
		subtractBlockedThinkingLevels(null, new Set(["high"])) === null,
	);
	check(
		"thinking blocked: 减去已知被夹取的档",
		JSON.stringify(subtractBlockedThinkingLevels(["off", "high", "max"], new Set(["max"]))) ===
			JSON.stringify(["off", "high"]),
	);
	check(
		"thinking blocked: 无 blocked 时返回副本而非原引用",
		(() => {
			const source: string[] = ["off", "high"];
			const result = subtractBlockedThinkingLevels(source, undefined);
			return result !== source && JSON.stringify(result) === JSON.stringify(source);
		})(),
	);
}

{
	// todo 面板的数据来自用户可改的扩展（~/.pi/agent/extensions/todo.ts），
	// 所以解析必须宽容：字段缺失/类型不对时返回 null，绝不抛错崩掉整个 composer。
	const ok = parseTodoDetails({ action: "add", todos: [{ id: 1, text: "a", done: false }, { id: 2, text: "b", done: true }] });
	check(
		"todo details: 正常结构解析出 id/text/done",
		ok !== null && ok.length === 2 && ok[1].done === true && ok[0].text === "a",
		ok,
	);
	check("todo details: 非对象返回 null", parseTodoDetails(null) === null && parseTodoDetails("x") === null);
	check("todo details: todos 不是数组返回 null", parseTodoDetails({ todos: "nope" }) === null);
	check(
		"todo details: 跳过缺 id 或 text 的坏条目而不是整体失败",
		(() => {
			const r = parseTodoDetails({ todos: [{ id: 1, text: "keep" }, { text: "no id" }, { id: 3 }, null] });
			return r !== null && r.length === 1 && r[0].text === "keep";
		})(),
	);
	check(
		"todo details: done 只认真正的 true（防 truthy 字符串误判为已完成）",
		(() => {
			const r = parseTodoDetails({ todos: [{ id: 1, text: "a", done: "yes" }] });
			return r !== null && r[0].done === false;
		})(),
	);
	check(
		"todo details: 条目数与文本长度都有上限（外部数据不可信）",
		(() => {
			const many = Array.from({ length: 500 }, (_, i) => ({ id: i, text: "x".repeat(1000) }));
			const r = parseTodoDetails({ todos: many });
			return r !== null && r.length === 200 && r[0].text.length <= 301;
		})(),
	);
}

if (failed > 0) {
	throw new Error(`UI behavior selftest failed: ${failed} failed, ${passed} passed`);
}

console.log(`UI behavior selftest passed: ${passed}`);
