/**
 * marked 全局扩展去重保护。
 *
 * 背景：@mariozechner/mini-lit 的 MarkdownBlock 在每次 render() 里都调用
 * marked.use() 注册同一组 4 个 katex 扩展；marked 自身不去重，全局扩展
 * 数组随渲染次数无限增长，每次 parse 都要跑 N 份 start/tokenizer 钩子，
 * 解析成本随 App 存活时间线性上涨（实测约 2000 次渲染后单篇解析从亚毫秒
 * 涨到 50ms 级），表现为「某个 markdown 很多的线程打开特别卡、越用越卡」。
 *
 * 这里给 marked.use 加幂等保护：扩展按名去重（重复的条目不注册），
 * 全部重复时整次调用跳过；带其它配置的调用原样放行，不影响 marked 语义。
 *
 * 必须在任何 markdown-block 渲染前生效——main.ts 把它放在第一个 import。
 */
import { marked } from "marked";

type MarkedExtensionEntry = { name?: unknown };
type MarkedUseOptions = { extensions?: MarkedExtensionEntry[] } & Record<string, unknown>;

const registeredExtensionNames = new Set<string>();
const originalUse = marked.use.bind(marked) as (...args: MarkedUseOptions[]) => unknown;

(marked as { use: (...args: MarkedUseOptions[]) => unknown }).use = (...args: MarkedUseOptions[]) => {
	const freshArgs: MarkedUseOptions[] = [];
	for (const options of args) {
		const extensions = Array.isArray(options?.extensions) ? options.extensions : [];
		const names = extensions.map((ext) => (typeof ext?.name === "string" ? ext.name : null));
		const nonExtensionKeys = Object.keys(options ?? {}).filter((key) => key !== "extensions");
		if (extensions.length === 0 || nonExtensionKeys.length > 0) {
			// 非纯扩展注册：不碰语义，原样放行（扩展名仍记录，供后续去重）。
			for (const name of names) if (name) registeredExtensionNames.add(name);
			freshArgs.push(options);
			continue;
		}
		const freshExtensions = extensions.filter((ext, index) => {
			const name = names[index];
			if (name && registeredExtensionNames.has(name)) return false;
			if (name) registeredExtensionNames.add(name);
			return true;
		});
		if (freshExtensions.length === 0) continue;
		freshArgs.push(freshExtensions.length === extensions.length ? options : { ...options, extensions: freshExtensions });
	}
	if (freshArgs.length === 0) return marked;
	return originalUse(...freshArgs);
};
