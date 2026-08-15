/**
 * marked-guard 自测：重复 marked.use() 不得让全局扩展数组膨胀。
 * 复现的是 mini-lit MarkdownBlock 每次 render 都 marked.use() 同组
 * katex 扩展导致的解析成本线性上涨（长会话/久用后卡顿的根因）。
 */
import { marked } from "marked";
import "./marked-guard.js";

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

type MarkedExtensionBuckets = {
	inline: string[];
	block: string[];
	startInline: unknown[];
	startBlock: unknown[];
};

function extensionBuckets(): MarkedExtensionBuckets {
	return (marked as unknown as { defaults: { extensions: MarkedExtensionBuckets } }).defaults.extensions;
}

function makeKatexLikeExtension(name: string) {
	return {
		name,
		level: "inline" as const,
		start(src: string) {
			return src.indexOf("$");
		},
		tokenizer(src: string) {
			const match = /^\$([^$\n]+?)\$/.exec(src);
			return match ? { type: name, raw: match[0], text: match[1] } : undefined;
		},
		renderer(token: { text: string }) {
			return `<span>${token.text}</span>`;
		},
	};
}

{
	// 模拟 MarkdownBlock 每次 render 的 marked.use({extensions:[...]}) 调用。
	const RENDER_COUNT = 2_000;
	for (let index = 0; index < RENDER_COUNT; index += 1) {
		marked.use({
			extensions: [
				makeKatexLikeExtension("guardTestInlineA"),
				makeKatexLikeExtension("guardTestInlineB"),
				{ ...makeKatexLikeExtension("guardTestBlockC"), level: "block" as const },
			],
		});
	}
	const buckets = extensionBuckets();
	check(
		"duplicate marked.use registrations are deduped",
		buckets.inline.length === 2 && buckets.block.length === 1 && buckets.startInline.length === 2,
		buckets,
	);

	const parsed = marked.parse("plain $x+y$ text", { async: false }) as string;
	check(
		"deduped extensions still tokenize and render",
		parsed.includes("<span>x+y</span>"),
		parsed,
	);
}

{
	// 带其它配置的 use 调用必须原样放行（不被去重误伤）。
	marked.use({ gfm: true } as never);
	marked.use({ gfm: true } as never);
	check(
		"non-extension use() calls always pass through",
		(marked as unknown as { defaults: { gfm?: boolean } }).defaults.gfm === true,
	);

	// 部分新扩展名的调用也必须放行。
	marked.use({ extensions: [makeKatexLikeExtension("guardTestInlineA"), makeKatexLikeExtension("guardTestInlineD")] });
	const buckets = extensionBuckets();
	check(
		"partially-new extension sets still register",
		buckets.inline.length === 3 && buckets.startInline.length === 3,
		buckets,
	);
}

if (failed > 0) {
	throw new Error(`marked-guard selftest failed: ${failed} failed, ${passed} passed`);
}

console.log(`marked-guard selftest passed: ${passed}`);
