/**
 * 非聊天模型启发式过滤（按模型 id，PRD 4.2.2d）。
 * embedding / image / audio / moderation / whisper / tts 等不进勾选列表。
 */

const NON_CHAT_PATTERNS: readonly RegExp[] = [
	/(^|[-_/])embed(ding)?s?([-_/]|$)/i, // embedding / embed / embeddings
	/\btext-embedding\b/i,
	/\bbge[-_/]/i, // BGE 系列向量模型
	/\bdall[-_]?e\b/i,
	/\b(whisper|tts|speech|audio|transcrib)/i,
	/\bmoderation\b/i,
	/\b(imagen|veo|lyria|chirp)\b/i, // Google 图像/视频/音乐/语音
	/\bstable[-_]?diffusion\b/i,
	/\bflux[-_.]/i,
	/\b(sora|runway|pika)\b/i,
	/\brerank(er)?\b/i,
	/\bocr\b/i,
	/\bclip[-_/]/i,
	/^models\/(embedding|gecko)/i, // Google "models/embedding-001" 等
	/\bcode[-_]?search\b/i,
];

/**
 * 判断模型 id 是否像聊天模型。
 * 只在 id 明确命中非聊天模式时排除；拿不准的一律保留（宁多勿漏，用户可取消勾选）。
 */
export function isChatModel(id: string): boolean {
	const normalized = id.trim();
	if (!normalized) return false;
	return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 过滤 + 按 id 去重（保留首次出现），保持返回顺序稳定。 */
export function filterChatModels<T extends { id: string }>(models: readonly T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const model of models) {
		const key = model.id.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		if (!isChatModel(model.id)) continue;
		out.push(model);
	}
	return out;
}
