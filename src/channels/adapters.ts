/**
 * 拉取模型的协议适配器。
 *
 * 三家鉴权与返回结构都不同（PRD review 纠错：不是统一拼 /models）：
 * - openai-completions / openai-responses：GET {baseUrl}/models，Bearer；
 * - anthropic-messages：GET {baseUrl}/models，x-api-key + anthropic-version；
 * - google-generative-ai：GET {baseUrl}/models?key=...，nextPageToken 分页。
 *
 * 解析/组请求为纯函数；fetchModelsList 注入 fetch 便于测试。
 * 安全：redirect: "error" 禁跟随跨 origin 重定向（防 key 被重定向带走）。
 *
 * authHeader（与 pi 自定义 provider 的 authHeader: true 语义一致）：
 * 为 true 时在协议原有认证头之外追加 Authorization: Bearer <apiKey>
 * （openai 系协议本就只发 Bearer，结果相同）；不影响 redirect 安全边界。
 */
import { joinUrl } from "./ssrf.js";
import { filterChatModels } from "./filter.js";
import type { ApiProtocol, FetchedModel } from "./types.js";

export interface ModelsRequest {
	url: string;
	headers: Record<string, string>;
}

export interface ModelsPage {
	models: FetchedModel[];
	nextPageToken: string | null;
	/** 是否识别到该协议约定的模型数组。 */
	recognized: boolean;
	/** 远端模型数组的原始条目数（含无效/非聊天条目）。 */
	rawCount: number;
	/** 成功解析出模型 ID 的条目数（聊天模型过滤前）。 */
	parsedCount: number;
	/** 解析、去重并过滤非聊天模型后的条目数。 */
	filteredCount: number;
}

// ---------------------------------------------------------------------------
// 组请求（纯函数）
// ---------------------------------------------------------------------------

export function buildModelsRequest(
	protocol: ApiProtocol,
	baseUrl: string,
	apiKey: string,
	customHeaders?: Record<string, string>,
	pageToken?: string | null,
	authHeader?: boolean,
): ModelsRequest {
	const headers: Record<string, string> = { ...(customHeaders ?? {}) };
	// 认证头由当前协议统一注入。先大小写不敏感地删除用户自定义的保留头，
	// 避免同时发出 Authorization/authorization 或 x-api-key/X-Api-Key。
	for (const name of Object.keys(headers)) {
		const normalized = name.toLowerCase();
		if (normalized === "authorization" || normalized === "x-api-key") {
			delete headers[name];
		}
	}
	let url = joinUrl(baseUrl, "models");

	switch (protocol) {
		case "openai-completions":
		case "openai-responses":
			headers.Authorization = `Bearer ${apiKey}`;
			break;
		case "anthropic-messages":
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
			break;
		case "google-generative-ai": {
			const u = new URL(url);
			u.searchParams.set("key", apiKey);
			if (pageToken) u.searchParams.set("pageToken", pageToken);
			url = u.toString();
			break;
		}
	}
	// pi ProviderModelConfig.authHeader: true → 在协议原有认证头之外追加 Bearer。
	// openai 系协议上面已写同一 Bearer（幂等）；anthropic/google 保留各自原认证头。
	if (authHeader === true) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return { url, headers };
}

// ---------------------------------------------------------------------------
// 解析响应（纯函数，per-adapter）
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// 远端能力字段解析（纯函数）
//
// 只接受响应里明确给出的字段，兼容常见 camelCase/snake_case 命名；
// 未明确返回的一律 undefined（后续环节再按 preset/catalog 补全或保持未知），
// 绝不凭模型名或缺省值猜测。
// ---------------------------------------------------------------------------

/** 明确的正整数（接受数字或可解析的数字字符串），否则 undefined。 */
function pickPositiveInt(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		const num = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
		if (Number.isFinite(num) && num > 0) return Math.round(num);
	}
	return undefined;
}

/**
 * reasoning 只接受明确 boolean（含明确能力结构 capabilities.reasoning），
 * 不凭模型名（claude-/gpt-/o1 等）猜测。
 */
function pickExplicitReasoning(record: Record<string, unknown>): boolean | undefined {
	if (typeof record.reasoning === "boolean") return record.reasoning;
	const capabilities = asRecord(record.capabilities);
	if (capabilities && typeof capabilities.reasoning === "boolean") return capabilities.reasoning;
	return undefined;
}

/**
 * 输入模态规范化为 ["text"] 或 ["text","image"]：
 * 含 "image" 视为文本+图片（聊天模型必含文本）；仅 "text" 视为纯文本；
 * 其余/空值 = 未知（undefined）。
 */
export function normalizeInputModalities(value: unknown): ["text"] | ["text", "image"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tokens = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
	if (tokens.includes("image")) return ["text", "image"];
	if (tokens.includes("text")) return ["text"];
	return undefined;
}

function pickInputModalities(record: Record<string, unknown>): ["text"] | ["text", "image"] | undefined {
	for (const key of ["input", "modalities", "supported_input_modalities", "input_modalities"]) {
		const value = record[key];
		// OpenAI 风格 { modalities: { input: [...], output: [...] } } 结构取 input 数组
		const direct = normalizeInputModalities(value);
		if (direct) return direct;
		const nested = asRecord(value);
		if (nested) {
			const fromNested = normalizeInputModalities(nested.input);
			if (fromNested) return fromNested;
		}
	}
	return undefined;
}

/** 从单个远端模型对象提取明确返回的能力字段（全部可选）。 */
export function extractRemoteModelMeta(
	record: Record<string, unknown>,
): Pick<FetchedModel, "contextWindow" | "maxTokens" | "reasoning" | "input"> {
	return {
		contextWindow: pickPositiveInt(record, [
			"contextWindow",
			"context_length",
			"context_window",
			"inputTokenLimit",
			"input_token_limit",
		]),
		maxTokens: pickPositiveInt(record, [
			"maxTokens",
			"max_tokens",
			"max_output_tokens",
			"outputTokenLimit",
			"output_token_limit",
		]),
		reasoning: pickExplicitReasoning(record),
		input: pickInputModalities(record),
	};
}

function parsedPage(
	raw: readonly unknown[],
	parseEntry: (entry: unknown) => FetchedModel | null,
	nextPageToken: string | null = null,
): ModelsPage {
	const parsed: FetchedModel[] = [];
	for (const entry of raw) {
		const model = parseEntry(entry);
		if (model) parsed.push(model);
	}
	const models = filterChatModels(parsed);
	return {
		models,
		nextPageToken,
		recognized: true,
		rawCount: raw.length,
		parsedCount: parsed.length,
		filteredCount: models.length,
	};
}

function unrecognizedPage(): ModelsPage {
	return {
		models: [],
		nextPageToken: null,
		recognized: false,
		rawCount: 0,
		parsedCount: 0,
		filteredCount: 0,
	};
}

function parseOpenAiModels(payload: unknown): ModelsPage {
	const root = asRecord(payload);
	const data = Array.isArray(root?.data) ? root.data : Array.isArray(payload) ? payload : null;
	if (!data) return unrecognizedPage();
	return parsedPage(data, (entry) => {
		const record = asRecord(entry);
		if (!record) return null;
		const id = pickString(record, ["id", "model", "name"]);
		if (!id) return null;
		return { id, name: pickString(record, ["name", "display_name", "displayName"]), ...extractRemoteModelMeta(record) };
	});
}

function parseAnthropicModels(payload: unknown): ModelsPage {
	const root = asRecord(payload);
	if (!Array.isArray(root?.data)) return unrecognizedPage();
	return parsedPage(root.data, (entry) => {
		const record = asRecord(entry);
		if (!record) return null;
		const id = pickString(record, ["id"]);
		if (!id) return null;
		return { id, name: pickString(record, ["display_name", "displayName"]), ...extractRemoteModelMeta(record) };
	});
	// Anthropic 分页 has_more + last_id；中转站常残缺，这里保守不追页。
}

function parseGoogleModels(payload: unknown): ModelsPage {
	const root = asRecord(payload);
	if (!Array.isArray(root?.models)) return unrecognizedPage();
	const nextPageToken =
		typeof root.nextPageToken === "string" && root.nextPageToken.trim()
			? root.nextPageToken.trim()
			: null;
	return parsedPage(root.models, (entry) => {
		const record = asRecord(entry);
		if (!record) return null;
		// name 形如 "models/gemini-2.5-pro"，去掉 "models/" 前缀作为 id。
		const rawName = pickString(record, ["name", "model"]);
		if (!rawName) return null;
		const id = rawName.replace(/^models\//i, "");
		if (!id) return null;
		return { id, name: pickString(record, ["displayName", "display_name"]), ...extractRemoteModelMeta(record) };
	}, nextPageToken);
}

export function parseModelsResponse(protocol: ApiProtocol, payload: unknown): ModelsPage {
	switch (protocol) {
		case "openai-completions":
		case "openai-responses":
			return parseOpenAiModels(payload);
		case "anthropic-messages":
			return parseAnthropicModels(payload);
		case "google-generative-ai":
			return parseGoogleModels(payload);
	}
}

// ---------------------------------------------------------------------------
// 错误分类（纯函数）
// ---------------------------------------------------------------------------

export type FetchModelsErrorKind =
	| "unauthorized" // 401/403：key 无效或权限不足
	| "not_found" // 404：端点不存在（中转站该接口常残缺）
	| "timeout"
	| "redirect_blocked" // 跨 origin 重定向被拦截
	| "http" // 其它 HTTP 状态码
	| "network" // 连接失败/DNS/TLS
	| "bad_response" // 200 但结构无法解析
	| "empty"; // 200 且结构正常，但列表为空（中转站不提供清单）

export interface FetchModelsError {
	kind: FetchModelsErrorKind;
	status?: number;
	message: string;
}

export function classifyHttpStatus(status: number): FetchModelsErrorKind {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	return "http";
}

export function classifyFetchException(err: unknown): FetchModelsErrorKind {
	if (err instanceof DOMException && err.name === "AbortError") return "timeout";
	const message = err instanceof Error ? err.message : String(err);
	if (/redirect/i.test(message)) return "redirect_blocked";
	if (/timed?\s*out|abort/i.test(message)) return "timeout";
	return "network";
}

// ---------------------------------------------------------------------------
// 拉取编排（注入 fetch；redirect:"error" + 超时）
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Tauri 环境下经 Rust curl 发请求，绕开 WKWebView 的 CORS 限制。 */
async function tauriFetch(url: string, init?: RequestInit): Promise<Response> {
	const { invoke } = await import("@tauri-apps/api/core");
	const headers = Object.entries(init?.headers ?? {});
	const result = await invoke<{ status: number; body: string }>("http_get", { url, headers });
	return new Response(result.body, { status: result.status });
}

function defaultFetch(): FetchLike {
	if (typeof window !== "undefined" && "__TAURI__" in window) return tauriFetch;
	return globalThis.fetch.bind(globalThis);
}

export interface FetchModelsOptions {
	protocol: ApiProtocol;
	baseUrl: string;
	apiKey: string;
	customHeaders?: Record<string, string>;
	/** 当前 provider 的 authHeader: true 时追加 Authorization: Bearer（pi 语义）。 */
	authHeader?: boolean;
	timeoutMs?: number;
	fetchImpl?: FetchLike;
}

export type FetchModelsResult =
	| { ok: true; models: FetchedModel[]; rawCount: number; parsedCount: number; filteredCount: number }
	| { ok: false; error: FetchModelsError };

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;

export async function fetchModelsList(options: FetchModelsOptions): Promise<FetchModelsResult> {
	const fetchImpl = options.fetchImpl ?? defaultFetch();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const collected: FetchedModel[] = [];
	let rawCount = 0;
	let parsedCount = 0;

	let pageToken: string | null = null;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const request = buildModelsRequest(
			options.protocol,
			options.baseUrl,
			options.apiKey,
			options.customHeaders,
			pageToken,
			options.authHeader,
		);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response: Response;
		try {
			response = await fetchImpl(request.url, {
				method: "GET",
				headers: request.headers,
				redirect: "error", // 禁跟随重定向，防止 key 被带到其它 origin
				signal: controller.signal,
			});
		} catch (err) {
			clearTimeout(timer);
			return {
				ok: false,
				error: {
					kind: classifyFetchException(err),
					message: err instanceof Error ? err.message : String(err),
				},
			};
		}
		clearTimeout(timer);

		if (!response.ok) {
			return {
				ok: false,
				error: {
					kind: classifyHttpStatus(response.status),
					status: response.status,
					message: `HTTP ${response.status}`,
				},
			};
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (err) {
			return {
				ok: false,
				error: {
					kind: "bad_response",
					message: err instanceof Error ? err.message : String(err),
				},
			};
		}

		const parsed = parseModelsResponse(options.protocol, payload);
		if (!parsed.recognized) {
			return {
				ok: false,
				error: { kind: "bad_response", message: "missing or invalid model list" },
			};
		}
		if (parsed.rawCount > 0 && parsed.parsedCount === 0) {
			return {
				ok: false,
				error: { kind: "bad_response", message: "model list contains no valid model ids" },
			};
		}
		rawCount += parsed.rawCount;
		parsedCount += parsed.parsedCount;
		if (parsed.rawCount === 0 && page === 0) {
			return {
				ok: false,
				error: { kind: "empty", message: "empty model list" },
			};
		}
		collected.push(...parsed.models);

		// 仅 google 协议会产出 nextPageToken。
		if (!parsed.nextPageToken) break;
		pageToken = parsed.nextPageToken;
	}

	const models = filterChatModels(collected);
	return { ok: true, models, rawCount, parsedCount, filteredCount: models.length };
}
