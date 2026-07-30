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

export interface ModelPickerSubmenuPlacementInput {
	preferredPopoverLeft: number;
	popoverWidth: number;
	popoverTop: number;
	anchorTop: number;
	submenuWidth: number;
	submenuHeight: number;
	contentLeft: number;
	contentRight: number;
	contentBottom: number;
	gap: number;
}

export interface ModelPickerSubmenuPlacement {
	side: "left" | "right";
	popoverLeft: number;
	submenuLeft: number;
	submenuWidth: number;
	submenuMaxHeight: number;
	top: number;
}

/**
 * 模型二级菜单以当前渠道行为纵向锚点，并优先向右展开。
 * 若右侧空间不足则翻到左侧；极窄窗口两侧都放不下时，选择溢出更少的一侧，
 * 再把最终位置夹在聊天内容区内，避免菜单钻进侧栏或跑出窗口。
 */
export function resolveModelPickerSubmenuPlacement({
	preferredPopoverLeft,
	popoverWidth,
	popoverTop,
	anchorTop,
	submenuWidth,
	submenuHeight,
	contentLeft,
	contentRight,
	contentBottom,
	gap,
}: ModelPickerSubmenuPlacementInput): ModelPickerSubmenuPlacement {
	const safeGap = Math.max(0, gap);
	const minLeft = Math.min(contentLeft, contentRight);
	const maxRight = Math.max(contentLeft, contentRight);
	const contentWidth = Math.max(0, maxRight - minLeft);
	const safePopoverWidth = Math.min(Math.max(0, popoverWidth), contentWidth);
	const maximumSubmenuWidth = Math.max(0, contentWidth - safePopoverWidth - safeGap);
	const safeSubmenuWidth = Math.min(Math.max(0, submenuWidth), maximumSubmenuWidth);
	const maximumPopoverLeft = Math.max(minLeft, maxRight - safePopoverWidth);
	let resolvedPopoverLeft = Math.min(maximumPopoverLeft, Math.max(minLeft, preferredPopoverLeft));
	const preferredRightLeft = resolvedPopoverLeft + safePopoverWidth + safeGap;
	const preferredLeftLeft = resolvedPopoverLeft - safeGap - safeSubmenuWidth;
	const rightFits = preferredRightLeft + safeSubmenuWidth <= maxRight;
	const leftFits = preferredLeftLeft >= minLeft;
	let side: "left" | "right";
	let submenuLeft: number;

	if (rightFits) {
		side = "right";
		submenuLeft = preferredRightLeft;
	} else if (leftFits) {
		side = "left";
		submenuLeft = preferredLeftLeft;
	} else {
		// 两边在原锚点都放不下时，保持默认向右，并把一、二级菜单作为整体平移。
		side = "right";
		const pairWidth = safePopoverWidth + safeGap + safeSubmenuWidth;
		resolvedPopoverLeft = Math.min(
			Math.max(minLeft, maxRight - pairWidth),
			Math.max(minLeft, preferredPopoverLeft),
		);
		submenuLeft = resolvedPopoverLeft + safePopoverWidth + safeGap;
	}

	const availableHeight = Math.max(0, contentBottom - anchorTop);
	const submenuMaxHeight = Math.min(
		Math.max(0, submenuHeight),
		availableHeight,
	);
	return {
		side,
		popoverLeft: resolvedPopoverLeft,
		submenuLeft,
		submenuWidth: safeSubmenuWidth,
		submenuMaxHeight,
		top: Math.max(0, anchorTop - popoverTop),
	};
}

/**
 * 思考程度档位的三态解析。
 *
 * pi 的可用档位由 `getSupportedThinkingLevels(model)` 决定（pi-ai models.js）：
 * `reasoning: false` 的模型只有 `off`；`thinkingLevelMap[level] = null` 的档被禁用；
 * `xhigh` / `max` 必须在 map 里显式出现才可用。所以 GUI 绝不能凭空假设档位集合。
 *
 * 三态语义：
 * - `authoritative === null`：尚未拿到权威列表（未拉取/在途/失败）。**不猜**，
 *   只给当前已生效的那一档——它是唯一确定可用的（pi 已经接受了它）。
 * - `authoritative === []`：pi 明确说一档也不可用。仍保留当前档以免菜单空白。
 * - 非空：权威列表；若当前档不在其中（刚切模型、列表陈旧），补进去以免下拉
 *   显示不出正在生效的值。
 */
export function resolveThinkingLevelOptions<T extends string>(
	authoritative: readonly T[] | null,
	current: T,
): T[] {
	if (authoritative === null || authoritative.length === 0) return [current];
	return authoritative.includes(current) ? [...authoritative] : [...authoritative, current];
}

/**
 * 权威列表减去本地已知被夹取过的档。
 *
 * 权威缓存可能陈旧（配置受控重启后模型能力可能变），而 `blocked` 是从真实夹取
 * 结果学到的，两者要合并。`null` 表示未知，直接原样透传保持三态。
 */
export function subtractBlockedThinkingLevels<T extends string>(
	authoritative: readonly T[] | null,
	blocked: ReadonlySet<T> | null | undefined,
): T[] | null {
	if (authoritative === null) return null;
	if (!blocked || blocked.size === 0) return [...authoritative];
	return authoritative.filter((level) => !blocked.has(level));
}
