/**
 * i18n 文案层：界面语言固定为简体中文，无运行时语言切换。
 *
 * 用法：
 *   import { t } from "../i18n/index.js";
 *   t("common.ok")
 *   t("common.deleteConfirm", { name: "foo" })
 *
 * 新增模块：在 zh/ 下建 <module>.ts，default export 一个嵌套对象，
 * 然后在下面 import 并挂到 messages 上，key 即为 "<module>.<path>"。
 */
import common from "./zh/common.js";
import commandPalette from "./zh/commandPalette.js";
import composer from "./zh/composer.js";
import panels from "./zh/panels.js";
import timeline from "./zh/timeline.js";
import chatMisc from "./zh/chatMisc.js";
import sidebar from "./zh/sidebar.js";
import settings from "./zh/settings.js";
import app from "./zh/app.js";
import chatView from "./zh/chatView.js";
import packages from "./zh/packages.js";
import review from "./zh/review.js";
import channels from "./zh/channels.js";
import extensions from "./zh/extensions.js";
import models from "./zh/models.js";
import lightbox from "./zh/lightbox.js";
import subagents from "./zh/subagents.js";
import todoPanel from "./zh/todoPanel.js";

const messages = { common, commandPalette, composer, panels, timeline, chatMisc, sidebar, settings, app, chatView, packages, review, channels, extensions, models, lightbox, subagents, todoPanel } as const;

/** 递归展开嵌套对象为点路径 key，如 "commandPalette.hints.run"。 */
type DotPaths<T> = {
	[K in keyof T & string]: T[K] extends string ? K : `${K}.${DotPaths<T[K]>}`;
}[keyof T & string];

type MessageTree = typeof messages;

export type MessageKey = {
	[M in keyof MessageTree & string]: `${M}.${DotPaths<MessageTree[M]>}`;
}[keyof MessageTree & string];

export type MessageParams = Record<string, string | number>;

const warnedKeys = new Set<string>();

function warnMissing(key: string): void {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	console.warn(`[i18n] missing key: ${key}`);
}

/**
 * 按点路径取文案，纯函数、同步、无状态。
 * - 找不到 key：console.warn 一次并原样返回 key，方便排查。
 * - 插值：文案里的 `{name}` 由 params 替换；缺少的参数保留原样。
 */
export function t(key: MessageKey, params?: MessageParams): string {
	let node: unknown = messages;
	for (const part of key.split(".")) {
		if (typeof node !== "object" || node === null || !(part in node)) {
			warnMissing(key);
			return key;
		}
		node = (node as Record<string, unknown>)[part];
	}
	if (typeof node !== "string") {
		warnMissing(key);
		return key;
	}
	if (!params) return node;
	return node.replace(/\{(\w+)\}/g, (raw, name: string) =>
		name in params ? String(params[name]) : raw,
	);
}
