import { t } from "../../i18n/index.js";
import type { GitBranchEntry } from "../../git/branches.js";
import { promptDialog } from "../app-dialog.js";

type NoticeKind = "info" | "success" | "error";

interface GitCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface GitActionContextBase {
	isSwitchingGitBranch: () => boolean;
	setSwitchingGitBranch: (next: boolean) => void;
	render: () => void;
	closeGitMenu: () => void;
	pushNotice: (text: string, kind: NoticeKind) => void;
	runGit: (args: string[]) => Promise<GitCommandResult>;
	hasGitHeadCommit: () => Promise<boolean>;
	switchUnbornHeadBranch: (branch: string) => Promise<{ ok: boolean; error: string }>;
	refreshGitSummary: (force?: boolean) => Promise<void>;
}

interface SwitchGitBranchActionParams extends GitActionContextBase {
	branch: string;
	currentBranch: string;
}

interface SwitchRemoteTrackingBranchActionParams extends GitActionContextBase {
	entry: GitBranchEntry;
	branches: string[];
	switchGitBranch: (branch: string) => Promise<void>;
}

interface FetchGitRemotesActionParams {
	isRepo: boolean;
	fetchingGitRemotes: boolean;
	isSwitchingGitBranch: () => boolean;
	setFetchingGitRemotes: (next: boolean) => void;
	render: () => void;
	pushNotice: (text: string, kind: NoticeKind) => void;
	runGit: (args: string[]) => Promise<GitCommandResult>;
	refreshGitSummary: (force?: boolean) => Promise<void>;
}

interface CreateAndCheckoutBranchActionParams extends GitActionContextBase {
	rawName?: string;
	gitBranchQuery: string;
	resolveGitBranchSelection: (query: string) => GitBranchEntry | null;
	switchGitBranchEntry: (entry: GitBranchEntry) => Promise<void>;
}

export async function switchGitBranchAction({
	branch,
	currentBranch,
	isSwitchingGitBranch,
	setSwitchingGitBranch,
	render,
	closeGitMenu,
	pushNotice,
	runGit,
	hasGitHeadCommit,
	switchUnbornHeadBranch,
	refreshGitSummary,
}: SwitchGitBranchActionParams): Promise<void> {
	if (!branch || isSwitchingGitBranch()) return;
	if (branch === currentBranch) {
		closeGitMenu();
		render();
		return;
	}

	setSwitchingGitBranch(true);
	render();
	try {
		const hasCommit = await hasGitHeadCommit();
		if (!hasCommit) {
			const switched = await switchUnbornHeadBranch(branch);
			if (!switched.ok) {
				pushNotice(switched.error || t("chatMisc.git.switchFailedNamed", { branch }), "error");
				return;
			}
			closeGitMenu();
			pushNotice(t("chatMisc.git.switchedTo", { branch }), "success");
			await refreshGitSummary(true);
			return;
		}

		let result = await runGit(["switch", branch]);
		if (result.exitCode !== 0) {
			result = await runGit(["checkout", branch]);
		}
		if (result.exitCode !== 0) {
			pushNotice(result.stderr.trim() || result.stdout.trim() || t("chatMisc.git.switchFailedNamed", { branch }), "error");
			return;
		}
		closeGitMenu();
		pushNotice(t("chatMisc.git.switchedTo", { branch }), "success");
		await refreshGitSummary(true);
	} catch (err) {
		console.error("Failed to switch branch:", err);
		pushNotice(t("chatMisc.git.switchFailed"), "error");
	} finally {
		setSwitchingGitBranch(false);
		render();
	}
}

export async function switchRemoteTrackingBranchAction({
	entry,
	branches,
	switchGitBranch,
	isSwitchingGitBranch,
	setSwitchingGitBranch,
	render,
	closeGitMenu,
	pushNotice,
	runGit,
	refreshGitSummary,
}: SwitchRemoteTrackingBranchActionParams): Promise<void> {
	if (isSwitchingGitBranch()) return;
	const localBranch = entry.name.trim();
	const remoteRef = entry.fullName.trim();
	if (!localBranch || !remoteRef) return;
	if (branches.includes(localBranch)) {
		await switchGitBranch(localBranch);
		return;
	}

	setSwitchingGitBranch(true);
	render();
	try {
		let result = await runGit(["switch", "--track", "-c", localBranch, remoteRef]);
		if (result.exitCode !== 0) {
			result = await runGit(["checkout", "--track", "-b", localBranch, remoteRef]);
		}
		if (result.exitCode !== 0) {
			const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
			if (message.includes("already exists")) {
				await switchGitBranch(localBranch);
				return;
			}
			let fallback = await runGit(["switch", "--track", remoteRef]);
			if (fallback.exitCode !== 0) {
				fallback = await runGit(["checkout", "--track", remoteRef]);
			}
			if (fallback.exitCode === 0) {
				closeGitMenu();
				pushNotice(t("chatMisc.git.switchedToTracking", { branch: localBranch, remote: remoteRef }), "success");
				await refreshGitSummary(true);
				return;
			}
			pushNotice(result.stderr.trim() || result.stdout.trim() || t("chatMisc.git.switchFailedNamed", { branch: remoteRef }), "error");
			return;
		}
		closeGitMenu();
		pushNotice(t("chatMisc.git.switchedToTracking", { branch: localBranch, remote: remoteRef }), "success");
		await refreshGitSummary(true);
	} catch (err) {
		console.error("Failed to switch remote branch:", err);
		pushNotice(t("chatMisc.git.switchRemoteFailed"), "error");
	} finally {
		setSwitchingGitBranch(false);
		render();
	}
}

export async function fetchGitRemotesAction({
	isRepo,
	fetchingGitRemotes,
	isSwitchingGitBranch,
	setFetchingGitRemotes,
	render,
	pushNotice,
	runGit,
	refreshGitSummary,
}: FetchGitRemotesActionParams): Promise<void> {
	if (!isRepo || fetchingGitRemotes || isSwitchingGitBranch()) return;
	setFetchingGitRemotes(true);
	render();
	try {
		const result = await runGit(["fetch", "--all", "--prune"]);
		if (result.exitCode !== 0) {
			pushNotice(result.stderr.trim() || result.stdout.trim() || t("chatMisc.git.fetchFailed"), "error");
			return;
		}
		pushNotice(t("chatMisc.git.fetched"), "success");
		await refreshGitSummary(true);
	} catch (err) {
		console.error("Failed to fetch remotes:", err);
		pushNotice(t("chatMisc.git.fetchFailed"), "error");
	} finally {
		setFetchingGitRemotes(false);
		render();
	}
}

export async function createAndCheckoutBranchAction({
	rawName = "",
	gitBranchQuery,
	resolveGitBranchSelection,
	switchGitBranchEntry,
	isSwitchingGitBranch,
	setSwitchingGitBranch,
	render,
	closeGitMenu,
	pushNotice,
	runGit,
	hasGitHeadCommit,
	switchUnbornHeadBranch,
	refreshGitSummary,
}: CreateAndCheckoutBranchActionParams): Promise<void> {
	if (isSwitchingGitBranch()) return;

	let proposed = rawName.trim();
	if (!proposed) {
		const prompted = (await promptDialog({ title: t("chatMisc.git.branchNamePrompt"), value: gitBranchQuery.trim() })) ?? "";
		proposed = prompted.trim();
	}
	if (!proposed) {
		pushNotice(t("chatMisc.git.enterBranchName"), "info");
		return;
	}
	const existingBranch = resolveGitBranchSelection(proposed);
	if (existingBranch) {
		await switchGitBranchEntry(existingBranch);
		return;
	}

	if (!/^[A-Za-z0-9._\/-]+$/.test(proposed)) {
		pushNotice(t("chatMisc.git.branchNameAllowedChars"), "error");
		return;
	}

	const refCheck = await runGit(["check-ref-format", "--branch", proposed]);
	if (refCheck.exitCode !== 0) {
		pushNotice(refCheck.stderr.trim() || refCheck.stdout.trim() || t("chatMisc.git.invalidBranchName"), "error");
		return;
	}

	setSwitchingGitBranch(true);
	render();
	try {
		const hasCommit = await hasGitHeadCommit();
		if (!hasCommit) {
			const switched = await switchUnbornHeadBranch(proposed);
			if (!switched.ok) {
				pushNotice(switched.error || t("chatMisc.git.createFailed"), "error");
				return;
			}
			closeGitMenu();
			pushNotice(t("chatMisc.git.createdAndSwitched", { branch: proposed }), "success");
			await refreshGitSummary(true);
			return;
		}

		let result = await runGit(["switch", "-c", proposed]);
		if (result.exitCode !== 0) {
			result = await runGit(["checkout", "-b", proposed]);
		}
		if (result.exitCode !== 0) {
			const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
			if (message.includes("already exists")) {
				let switchExisting = await runGit(["switch", proposed]);
				if (switchExisting.exitCode !== 0) {
					switchExisting = await runGit(["checkout", proposed]);
				}
				if (switchExisting.exitCode === 0) {
					closeGitMenu();
					pushNotice(t("chatMisc.git.switchedTo", { branch: proposed }), "success");
					await refreshGitSummary(true);
					return;
				}
			}

			const branchOnly = await runGit(["branch", proposed]);
			if (branchOnly.exitCode === 0) {
				let switchToCreated = await runGit(["switch", proposed]);
				if (switchToCreated.exitCode !== 0) {
					switchToCreated = await runGit(["checkout", proposed]);
				}
				if (switchToCreated.exitCode === 0) {
					closeGitMenu();
					pushNotice(t("chatMisc.git.createdAndSwitched", { branch: proposed }), "success");
					await refreshGitSummary(true);
					return;
				}
			}

			pushNotice(result.stderr.trim() || result.stdout.trim() || t("chatMisc.git.createFailed"), "error");
			return;
		}
		closeGitMenu();
		pushNotice(t("chatMisc.git.createdAndSwitched", { branch: proposed }), "success");
		await refreshGitSummary(true);
	} catch (err) {
		console.error("Failed to create branch:", err);
		pushNotice(t("chatMisc.git.createFailed"), "error");
	} finally {
		setSwitchingGitBranch(false);
		render();
	}
}
