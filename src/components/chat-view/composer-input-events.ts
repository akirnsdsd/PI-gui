import type { SlashPaletteItem } from "../../commands/slash-command-runtime.js";

/**
 * 输入框自动增高的高度上限（px）。
 *
 * **必须与 `app.css` 里 `.chat-input` 的 `max-height` 保持一致。**
 * 两边对不上时：JS 把 inline height 设到 220，而 CSS 只让它渲染到 160，
 * 于是中间这段区间里 JS 以为变高了、实际布局没变，而 `.chat-scroll` 的
 * `padding-bottom` 是按真实测量值算的——输入框会盖住最后一条消息。
 * 改这个值时记得同步改 CSS。
 */
export const COMPOSER_TEXTAREA_MAX_HEIGHT = 220;

type ComposerHistoryDirection = "up" | "down";
type ComposerSendMode = "prompt" | "steer" | "followUp";

interface HandleComposerInputEventParams {
	event: Event;
	interactionLocked: boolean;
	slashPaletteOpenBefore: boolean;
	onSetInputText: (text: string) => void;
	onResetComposerHistoryNavigation: () => void;
	onUpdateSlashPaletteStateFromInput: () => void;
	onIsSlashPaletteOpen: () => boolean;
	onRender: () => void;
	/** 输入框高度变化后重算 --composer-offset（不走整体 render）。 */
	onComposerHeightChange: () => void;
}

interface HandleComposerPasteEventParams {
	event: ClipboardEvent;
	interactionLocked: boolean;
	onPrepareImages: (files: File[]) => void | Promise<unknown>;
}

interface HandleComposerDragOverEventParams {
	event: DragEvent;
	interactionLocked: boolean;
}

interface HandleComposerDropEventParams {
	event: DragEvent;
	interactionLocked: boolean;
	onHandleDroppedDataTransfer: (dataTransfer: DataTransfer | null) => void;
}

interface HandleComposerFilePickerChangeEventParams {
	event: Event;
	interactionLocked: boolean;
	onPrepareFiles: (files: FileList | File[]) => void | Promise<unknown>;
}

interface HandleComposerKeyDownEventParams {
	event: KeyboardEvent;
	interactionLocked: boolean;
	isStreaming: boolean;
	modelPickerOpen: boolean;
	inputText: string;
	hasSelectedSkillDraft: boolean;
	slashPaletteOpen: boolean;
	composerHistoryIndex: number;
	onCloseModelPicker: () => void;
	onRemoveSelectedSkillDraft: () => void;
	onCycleThinkingLevel: (step: 1 | -1) => void | Promise<unknown>;
	shouldHandleComposerHistoryKey: (event: KeyboardEvent, textarea: HTMLTextAreaElement, direction: ComposerHistoryDirection) => boolean;
	onNavigateComposerHistory: (direction: ComposerHistoryDirection) => void;
	getSlashPaletteItems: () => SlashPaletteItem[];
	onSetSlashPaletteNavigationMode: (mode: "pointer" | "keyboard") => void;
	getSlashPaletteIndex: () => number;
	onSetSlashPaletteIndex: (index: number) => void;
	onPreviewSlashPaletteItem: (item: SlashPaletteItem) => void;
	onRender: () => void;
	onEnsureActiveSlashItemVisible: () => void;
	onCloseSlashPalette: () => void;
	slashQueryFromInput: () => string | null;
	onExecuteSlashCommandFromComposer: () => void | Promise<unknown>;
	onSendMessage: (mode: ComposerSendMode) => void | Promise<unknown>;
}

export function handleComposerInputEvent({
	event,
	interactionLocked,
	slashPaletteOpenBefore,
	onSetInputText,
	onResetComposerHistoryNavigation,
	onUpdateSlashPaletteStateFromInput,
	onIsSlashPaletteOpen,
	onRender,
	onComposerHeightChange,
}: HandleComposerInputEventParams): void {
	if (interactionLocked) return;
	const textarea = event.target as HTMLTextAreaElement;
	onSetInputText(textarea.value);
	onResetComposerHistoryNavigation();
	onUpdateSlashPaletteStateFromInput();
	// 先存旧值：下面要把 height 置为 auto 才能量到真实 scrollHeight，
	// 置 auto 之后再比就永远是「变了」。
	const previousHeight = textarea.style.height;
	textarea.style.height = "auto";
	const nextHeight = `${Math.min(textarea.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
	textarea.style.height = nextHeight;
	// 高度真变了就得重算 --composer-offset，否则 .chat-scroll 的底部预留停在旧值，
	// 输入框长高后会盖住最后一条消息。
	// 不走整体 render()：那会在每次敲键时重建整棵时间线。
	if (previousHeight !== nextHeight) {
		onComposerHeightChange();
	}
	if (onIsSlashPaletteOpen() || slashPaletteOpenBefore) {
		onRender();
	}
}

export function handleComposerPasteEvent({
	event,
	interactionLocked,
	onPrepareImages,
}: HandleComposerPasteEventParams): void {
	if (interactionLocked) {
		event.preventDefault();
		return;
	}
	const items = Array.from(event.clipboardData?.items || []);
	const files = items
		.filter((item) => item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((file): file is File => Boolean(file));
	if (files.length > 0) {
		event.preventDefault();
		void onPrepareImages(files);
	}
}

export function handleComposerDragOverEvent({ event, interactionLocked }: HandleComposerDragOverEventParams): void {
	event.preventDefault();
	event.stopPropagation();
	if (event.dataTransfer) event.dataTransfer.dropEffect = interactionLocked ? "none" : "copy";
}

export function handleComposerDropEvent({
	event,
	interactionLocked,
	onHandleDroppedDataTransfer,
}: HandleComposerDropEventParams): void {
	event.preventDefault();
	event.stopPropagation();
	if (interactionLocked) return;
	onHandleDroppedDataTransfer(event.dataTransfer ?? null);
}

export function handleComposerFilePickerChangeEvent({
	event,
	interactionLocked,
	onPrepareFiles,
}: HandleComposerFilePickerChangeEventParams): void {
	const input = event.target as HTMLInputElement;
	if (interactionLocked) {
		input.value = "";
		return;
	}
	const files = input.files;
	if (files?.length) void onPrepareFiles(files);
	input.value = "";
}

export function handleComposerKeyDownEvent({
	event,
	interactionLocked,
	isStreaming,
	modelPickerOpen,
	inputText,
	hasSelectedSkillDraft,
	slashPaletteOpen,
	composerHistoryIndex,
	onCloseModelPicker,
	onRemoveSelectedSkillDraft,
	onCycleThinkingLevel,
	shouldHandleComposerHistoryKey,
	onNavigateComposerHistory,
	getSlashPaletteItems,
	onSetSlashPaletteNavigationMode,
	getSlashPaletteIndex,
	onSetSlashPaletteIndex,
	onPreviewSlashPaletteItem,
	onRender,
	onEnsureActiveSlashItemVisible,
	onCloseSlashPalette,
	slashQueryFromInput,
	onExecuteSlashCommandFromComposer,
	onSendMessage,
}: HandleComposerKeyDownEventParams): void {
	if (interactionLocked) return;
	// WebKit may clear isComposing just before the IME confirmation keydown,
	// while still reporting the legacy IME keyCode. In either case the first
	// Enter belongs to the input method and must never submit the composer.
	if (event.isComposing || event.keyCode === 229) return;
	if (event.key === "Escape" && modelPickerOpen) {
		event.preventDefault();
		onCloseModelPicker();
		return;
	}
	if ((event.key === "Backspace" || event.key === "Delete") && inputText.length === 0 && hasSelectedSkillDraft) {
		event.preventDefault();
		onRemoveSelectedSkillDraft();
		return;
	}
	if (event.key === "Tab" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
		event.preventDefault();
		void onCycleThinkingLevel(1);
		return;
	}
	const textarea = event.currentTarget as HTMLTextAreaElement;
	const canHistoryUp = event.key === "ArrowUp" && shouldHandleComposerHistoryKey(event, textarea, "up");
	const canHistoryDown = event.key === "ArrowDown" && shouldHandleComposerHistoryKey(event, textarea, "down");
	const historyBrowsing = composerHistoryIndex >= 0;
	if (canHistoryUp && (historyBrowsing || !slashPaletteOpen)) {
		event.preventDefault();
		onNavigateComposerHistory("up");
		return;
	}
	if (canHistoryDown && historyBrowsing) {
		event.preventDefault();
		onNavigateComposerHistory("down");
		return;
	}
	const liveSlashItems = getSlashPaletteItems();
	if (slashPaletteOpen && liveSlashItems.length > 0) {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			onSetSlashPaletteNavigationMode("keyboard");
			const nextIndex = (getSlashPaletteIndex() + 1) % liveSlashItems.length;
			onSetSlashPaletteIndex(nextIndex);
			const item = liveSlashItems[nextIndex];
			if (item) onPreviewSlashPaletteItem(item);
			onRender();
			onEnsureActiveSlashItemVisible();
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			onSetSlashPaletteNavigationMode("keyboard");
			const nextIndex = (getSlashPaletteIndex() - 1 + liveSlashItems.length) % liveSlashItems.length;
			onSetSlashPaletteIndex(nextIndex);
			const item = liveSlashItems[nextIndex];
			if (item) onPreviewSlashPaletteItem(item);
			onRender();
			onEnsureActiveSlashItemVisible();
			return;
		}
	}
	if (slashPaletteOpen && event.key === "Escape") {
		event.preventDefault();
		onCloseSlashPalette();
		onRender();
		return;
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		if (!hasSelectedSkillDraft && slashQueryFromInput() !== null) {
			void onExecuteSlashCommandFromComposer();
			return;
		}
		if (event.altKey) {
			void onSendMessage("followUp");
		} else {
			const mode: ComposerSendMode = isStreaming ? "steer" : "prompt";
			void onSendMessage(mode);
		}
	}
}
