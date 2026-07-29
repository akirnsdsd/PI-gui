import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";

export interface QueuedComposerMessageView {
	text: string;
	imageCount: number;
}

export interface PendingComposerImageView {
	id: string;
	name: string;
	path?: string;
	size: number;
	previewUrl: string;
}

export interface PendingComposerFileView {
	id: string;
	name: string;
	path: string;
	token: string;
}

export interface ComposerSkillDraftView {
	name: string;
}

export function renderQueuedComposerMessagesView(
	messages: QueuedComposerMessageView[],
	truncateText: (value: string, len: number) => string,
): TemplateResult | typeof nothing {
	if (messages.length === 0) return nothing;
	const recent = messages.slice(-2);
	return html`
		<div class="composer-queued-row" aria-live="polite">
			${recent.map(
				(entry) => html`
					<div class="composer-queued-pill" title=${entry.text}>
						<span class="composer-queued-label">${t("composer.fragments.queued")}</span>
						<span class="composer-queued-text">${truncateText(entry.text.replace(/\s+/g, " "), 72)}</span>
						${entry.imageCount > 0 ? html`<span class="composer-queued-meta">${t("composer.fragments.queuedImages", { count: entry.imageCount })}</span>` : nothing}
					</div>
				`,
			)}
		</div>
	`;
}

export function renderPendingImagesView(
	images: PendingComposerImageView[],
	onRemoveImage: (id: string) => void,
	onPreviewImage: (id: string) => void,
): TemplateResult | typeof nothing {
	if (images.length === 0) return nothing;
	return html`
		<div class="composer-image-cards composer-attachment-strip" aria-label=${t("composer.fragments.imageAttachments")}>
			${images.map(
				(img) => html`
					<div
						class="composer-image-card"
						role="button"
						tabindex="0"
						title=${img.path || img.name}
						aria-label=${img.name}
						@click=${() => onPreviewImage(img.id)}
						@keydown=${(event: KeyboardEvent) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							onPreviewImage(img.id);
						}}
					>
						<img class="composer-image-card-thumb" src=${img.previewUrl} alt=${img.name} draggable="false" />
						<button
							type="button"
							class="composer-image-card-remove"
							title=${t("composer.fragments.removeImage")}
							@click=${(event: Event) => {
								event.stopPropagation();
								onRemoveImage(img.id);
							}}
						>✕</button>
					</div>
				`,
			)}
		</div>
	`;
}

function fileBadgeLabel(name: string): string {
	const match = name.toLowerCase().match(/\.([a-z0-9]{1,5})$/i);
	if (!match || !match[1]) return t("composer.fragments.fileBadge");
	return match[1].toUpperCase();
}

export function formatPendingFileDisplayName(
	name: string,
	truncateText: (value: string, len: number) => string,
): string {
	return truncateText(name, 24);
}

export function renderPendingFileReferencesView(
	files: PendingComposerFileView[],
	truncateText: (value: string, len: number) => string,
	onRemoveFile: (id: string) => void,
): TemplateResult | typeof nothing {
	if (files.length === 0) return nothing;
	return html`
		<div class="composer-attachments composer-attachment-strip file" aria-label=${t("composer.fragments.fileReferences")}>
			${files.map(
				(file) => html`
						<div class="composer-attachment" title=${file.path}>
							<span class="composer-attachment-thumb file" aria-hidden="true">${fileBadgeLabel(file.name)}</span>
							<span class="composer-attachment-name">${formatPendingFileDisplayName(file.name, truncateText)}</span>
						<button type="button" class="composer-attachment-remove" title=${t("composer.fragments.removeFileReference")} @click=${() => onRemoveFile(file.id)}>✕</button>
					</div>
				`,
			)}
		</div>
	`;
}

export function renderComposerSkillDraftPillView(
	draft: ComposerSkillDraftView | null,
	skillIcon: TemplateResult,
	onRemoveDraft: () => void,
): TemplateResult | typeof nothing {
	if (!draft) return nothing;
	return html`
		<div class="composer-skill-draft-pill inline">
			<span class="composer-skill-draft-icon" aria-hidden="true">${skillIcon}</span>
			<span class="composer-skill-draft-name">${draft.name}</span>
			<button type="button" class="composer-skill-draft-remove" title=${t("composer.fragments.removeSkill")} @click=${onRemoveDraft}>✕</button>
		</div>
	`;
}
