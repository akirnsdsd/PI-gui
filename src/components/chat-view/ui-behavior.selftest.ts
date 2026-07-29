import { mapBackendMessages } from "./backend-message-mapper.js";
import {
	collectAssistantWorkflow,
	resolveWorkflowDurationMs,
	resolveWorkflowExpansionState,
	type WorkflowToolCall,
} from "./workflow-utils.js";
import {
	resolveInlineTitleKeyAction,
	resolveSessionRefreshScrollAction,
	resolveViewportPopoverLeft,
	shouldRollbackSessionTitle,
	shouldRestoreInlineTitleRename,
	toggleCompactSidebarOverlay,
} from "../desktop-ui-behavior.js";
import { formatPendingFileDisplayName } from "./composer-fragments-view.js";
import {
	normalizeSessionRunOutcome,
	resolveSidebarSessionStatus,
} from "../sidebar-session-status.js";

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
	check(
		"sidebar running state replaces an older completion marker",
		resolveSidebarSessionStatus(true, false, "completed") === "running",
	);
	check(
		"sidebar completion marker remains visible after runtime suspension",
		resolveSidebarSessionStatus(false, true, "completed") === "completed",
	);
	check(
		"sidebar failure marker remains distinct",
		resolveSidebarSessionStatus(false, false, "failed") === "failed",
	);
	check(
		"sidebar suspension is only the idle fallback",
		resolveSidebarSessionStatus(false, true, null) === "suspended",
	);
	check(
		"unknown persisted sidebar outcomes are discarded",
		normalizeSessionRunOutcome("running") === null &&
			normalizeSessionRunOutcome("completed") === "completed" &&
			normalizeSessionRunOutcome("failed") === "failed",
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

if (failed > 0) {
	throw new Error(`UI behavior selftest failed: ${failed} failed, ${passed} passed`);
}

console.log(`UI behavior selftest passed: ${passed}`);
