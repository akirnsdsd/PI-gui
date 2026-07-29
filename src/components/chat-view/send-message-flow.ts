import { t } from "../../i18n/index.js";
import { rpcBridge, type RpcImageInput, type RpcSessionState } from "../../rpc/bridge.js";

type NoticeKind = "info" | "success" | "error";

type DeliveryMode = "prompt" | "steer" | "followUp";

interface SendMessageFlowParams<ImageItem> {
	mode: DeliveryMode;
	bindingStatusText: string | null;
	isComposerInteractionLocked: () => boolean;
	/** 会话仍在连接/绑定中（runtime 未就绪）：消息应本地排队而非直接发送。 */
	connectionPending: boolean;
	inputText: string;
	selectedSkillCommandText: string;
	pendingImages: ImageItem[];
	slashQueryFromInput: () => string | null;
	executeSlashCommandFromComposer: () => Promise<void>;
	rememberComposerHistoryEntry: (text: string) => void;
	currentIsStreaming: () => boolean;
	applyBackendState: (state: RpcSessionState) => void;
	clearStreamingUiState: () => void;
	render: () => void;
	enqueueComposerQueueMessage: (text: string, images: ImageItem[]) => string;
	enqueueOfflineQueueMessage: (text: string, images: ImageItem[]) => void;
	pushNotice: (text: string, kind: NoticeKind) => void;
	pushUserEcho: (text: string, mode: DeliveryMode, images: ImageItem[]) => string;
	removeUserEcho: (id: string) => void;
	clearComposer: () => void;
	setSendingPrompt: (value: boolean) => void;
	toRpcImages: (images: ImageItem[]) => RpcImageInput[];
	removeComposerQueueMessage: (id: string) => void;
	onSendFailure?: (text: string, images: ImageItem[]) => void;
	onPromptSubmitted?: () => void;
}

export async function sendMessageFlow<ImageItem>({
	mode,
	bindingStatusText,
	isComposerInteractionLocked,
	connectionPending,
	inputText,
	selectedSkillCommandText,
	pendingImages,
	slashQueryFromInput,
	executeSlashCommandFromComposer,
	rememberComposerHistoryEntry,
	currentIsStreaming,
	applyBackendState,
	clearStreamingUiState,
	render,
	enqueueComposerQueueMessage,
	enqueueOfflineQueueMessage,
	pushNotice,
	pushUserEcho,
	removeUserEcho,
	clearComposer,
	setSendingPrompt,
	toRpcImages,
	removeComposerQueueMessage,
	onSendFailure,
	onPromptSubmitted,
}: SendMessageFlowParams<ImageItem>): Promise<void> {
	if (isComposerInteractionLocked()) {
		pushNotice(bindingStatusText || t("chatMisc.composer.sessionLoading"), "info");
		return;
	}
	const promptText = inputText.trim();
	const selectedSkillCommand = selectedSkillCommandText.trim();
	const text = selectedSkillCommand ? (promptText ? `${selectedSkillCommand}\n\n${promptText}` : selectedSkillCommand) : promptText;
	const images = [...pendingImages];
	if (!selectedSkillCommand && images.length === 0 && slashQueryFromInput() !== null) {
		await executeSlashCommandFromComposer();
		return;
	}
	if (!text && images.length === 0) return;
	if (text) rememberComposerHistoryEntry(text);

	// 连接中（runtime 启动/会话切换/重连窗口）：composer 不锁，消息本地排队，
	// 等 refreshFromBackend 就绪后由 flushOfflineComposerQueue 自动发出（Codex 同款）。
	if (connectionPending) {
		enqueueOfflineQueueMessage(text, images);
		clearComposer();
		pushNotice(t("chatMisc.composer.queuedUntilReady"), "info");
		render();
		return;
	}

	let streaming = currentIsStreaming();
	if (streaming) {
		try {
			const backendState = await rpcBridge.getState();
			const backendStreaming = Boolean(backendState.isStreaming);
			applyBackendState(backendState);
			if (!backendStreaming) {
				streaming = false;
				clearStreamingUiState();
				render();
			}
		} catch {
			// ignore pre-flight run-state check failures
		}
	}

	let actualMode: DeliveryMode = mode;
	if (!streaming) {
		actualMode = "prompt";
	}

	let queuedMessageId: string | null = null;
	let userEchoId: string | null = null;
	if (actualMode === "followUp") {
		queuedMessageId = enqueueComposerQueueMessage(text, images);
		pushNotice(t("chatMisc.composer.queued"), "info");
	} else {
		userEchoId = pushUserEcho(text, actualMode, images);
	}
	clearComposer();
	setSendingPrompt(true);
	render();

	try {
		const rpcImages = toRpcImages(images);
		if (actualMode === "prompt") {
			await rpcBridge.prompt(text, { images: rpcImages });
		} else if (actualMode === "steer") {
			await rpcBridge.steer(text, rpcImages);
		} else {
			await rpcBridge.followUp(text, rpcImages);
			void rpcBridge
				.getState()
				.then((state) => {
					applyBackendState(state);
					render();
				})
				.catch(() => {
					/* ignore */
				});
		}
		onPromptSubmitted?.();
	} catch (err) {
		if (queuedMessageId) {
			removeComposerQueueMessage(queuedMessageId);
		}
		if (userEchoId) {
			removeUserEcho(userEchoId);
		}
		console.error("Failed to send message:", err);
		onSendFailure?.(text, images);
		pushNotice(err instanceof Error ? err.message : t("chatMisc.composer.sendFailed"), "error");
	} finally {
		setSendingPrompt(false);
		render();
	}
}
