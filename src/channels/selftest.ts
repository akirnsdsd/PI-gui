/**
 * src/channels 纯函数自证。
 *
 * 运行：npm run test:channels（esbuild 打包后 node 执行）。
 * 不依赖 DOM/Tauri；fetchModelsList 用注入的 mock fetch 验证。
 */
import {
	buildModelsRequest,
	classifyFetchException,
	classifyHttpStatus,
	fetchModelsList,
	parseModelsResponse,
} from "./adapters.js";
import {
	applySetDefault,
	buildChannelSaveOps,
	buildDeleteTransactionPayload,
	buildDuplicateTransactionPayload,
	buildEnabledModelsTransactionPayload,
	buildKeychainRefCommand,
	buildSettingsTransactionPayload,
	buildUpsertTransactionPayload,
	classifyKeyRef,
	deriveChannels,
	duplicateChannel,
	isSecretReference,
	isValidProviderId,
	literalApiKeyForRequest,
	mergeProviderModelScope,
	modelMatchesScopePattern,
	normalizeProviderId,
	parseChannelTransactionError,
	parseKeychainAccount,
	removeChannel,
	toModelEntry,
	upsertChannel,
} from "./config.js";
import { filterChatModels, isChatModel } from "./filter.js";
import {
	completeModelMeta,
	completeModelsMeta,
	draftFromManualId,
	findIncompleteSelectedDraft,
	loadPiStaticCatalog,
	lookupRuntimeCatalogMeta,
	mergeCatalogEntries,
	mergeFetchedModelDrafts,
	parseRuntimeCatalogEntry,
	resolveChannelEditAlias,
	withAllAddableSelected,
	type RuntimeCatalogEntry,
} from "./metadata.js";
import { findPreset, findPresetByBuiltinProvider } from "./presets.js";
import { joinUrl, validateBaseUrl } from "./ssrf.js";
import { emptyChannelsMeta, type ModelDraft, type PiAuthFile, type PiModelsFile } from "./types.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
	if (cond) {
		passed += 1;
		return;
	}
	failed += 1;
	console.error(`FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
}

function eq(name: string, actual: unknown, expected: unknown): void {
	check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

{
	const https = validateBaseUrl("https://api.deepseek.com/v1/", false);
	eq("ssrf: https ok + 归一化去尾斜杠", https, { ok: true, normalized: "https://api.deepseek.com/v1", warning: undefined });

	eq("ssrf: 空串", validateBaseUrl("  ", false).errorCode, "empty");
	eq("ssrf: 非 URL", validateBaseUrl("not a url", false).errorCode, "invalid");
	eq("ssrf: ftp 协议", validateBaseUrl("ftp://x.com", false).errorCode, "invalid");

	const httpLan = validateBaseUrl("http://192.168.1.10:8080/v1", true);
	eq("ssrf: http 内网即使勾选也拒绝", httpLan.errorCode, "http_not_localhost");

	const httpLocalNoAck = validateBaseUrl("http://localhost:11434/v1", false);
	eq("ssrf: http localhost 未勾选拒绝", httpLocalNoAck.errorCode, "insecure_http");

	const httpLocalAck = validateBaseUrl("http://127.0.0.1:11434/v1", true);
	eq("ssrf: http localhost 勾选放行", httpLocalAck.ok, true);

	const httpsPrivate = validateBaseUrl("https://10.0.0.5/v1", false);
	eq("ssrf: https 内网放行但警告", httpsPrivate, {
		ok: true,
		normalized: "https://10.0.0.5/v1",
		warning: "private_network",
	});

	const metadata = validateBaseUrl("https://169.254.169.254/latest", false);
	eq("ssrf: metadata 地址警告", metadata.warning, "metadata_endpoint");

	const metadataHttp = validateBaseUrl("http://169.254.169.254/latest", true);
	eq("ssrf: http metadata 直接拒绝", metadataHttp.errorCode, "http_not_localhost");

	eq("ssrf: query/hash 丢弃", validateBaseUrl("https://a.com/v1?x=1#y", false).normalized, "https://a.com/v1");
	eq("joinUrl 去双斜杠", joinUrl("https://a.com/v1/", "/models"), "https://a.com/v1/models");
}

// ---------------------------------------------------------------------------
// 适配器：组请求
// ---------------------------------------------------------------------------

{
	const openai = buildModelsRequest("openai-completions", "https://api.openai.com/v1", "sk-test");
	eq("adapter: openai url", openai.url, "https://api.openai.com/v1/models");
	eq("adapter: openai bearer", openai.headers.Authorization, "Bearer sk-test");

	const anthropic = buildModelsRequest("anthropic-messages", "https://api.anthropic.com", "sk-ant");
	eq("adapter: anthropic headers", anthropic.headers, {
		"x-api-key": "sk-ant",
		"anthropic-version": "2023-06-01",
	});

	const google = buildModelsRequest("google-generative-ai", "https://generativelanguage.googleapis.com/v1beta", "gkey", undefined, "tok2");
	check("adapter: google key+pageToken 在 query", google.url.includes("key=gkey") && google.url.includes("pageToken=tok2"), google.url);

	const custom = buildModelsRequest("openai-responses", "https://x.com/v1", "k", { "X-Team": "a" });
	eq("adapter: 自定义请求头保留", custom.headers["X-Team"], "a");
	const conflictingOpenAi = buildModelsRequest("openai-completions", "https://x.com/v1", "real-key", {
		authorization: "Bearer attacker-controlled",
		"X-API-Key": "attacker-controlled",
		"X-Team": "keep",
	});
	eq("adapter: 大小写冲突认证头先删除再注入协议认证", conflictingOpenAi.headers, {
		"X-Team": "keep",
		Authorization: "Bearer real-key",
	});
	const conflictingAnthropic = buildModelsRequest("anthropic-messages", "https://x.com", "real-key", {
		AUTHORIZATION: "Bearer stale",
		"X-Api-Key": "stale",
	});
	eq("adapter: anthropic 保留头大小写冲突不会重复发送", conflictingAnthropic.headers, {
		"x-api-key": "real-key",
		"anthropic-version": "2023-06-01",
	});

	// authHeader（pi ProviderModelConfig.authHeader: true 语义）：
	// 在协议原有认证头之外追加 Authorization: Bearer
	const anthropicBearer = buildModelsRequest("anthropic-messages", "https://k.example.com/api/claude_code/kiro", "sk-test", undefined, undefined, true);
	eq("adapter: authHeader 追加 Bearer 且保留协议原认证头", anthropicBearer.headers, {
		"x-api-key": "sk-test",
		"anthropic-version": "2023-06-01",
		Authorization: "Bearer sk-test",
	});
	const anthropicNoBearer = buildModelsRequest("anthropic-messages", "https://k.example.com", "sk-test");
	eq("adapter: 未开 authHeader 不加 Bearer", "Authorization" in anthropicNoBearer.headers, false);
	const openaiBearer = buildModelsRequest("openai-completions", "https://x.com/v1", "sk-test", undefined, undefined, true);
	eq("adapter: openai 系本就 Bearer（幂等）", openaiBearer.headers.Authorization, "Bearer sk-test");
	const googleBearer = buildModelsRequest("google-generative-ai", "https://g.com/v1beta", "gkey", undefined, undefined, true);
	check("adapter: google 保留 query key 且追加 Bearer", googleBearer.url.includes("key=gkey") && googleBearer.headers.Authorization === "Bearer gkey", googleBearer);
}

// ---------------------------------------------------------------------------
// 适配器：解析
// ---------------------------------------------------------------------------

{
	const openai = parseModelsResponse("openai-completions", {
		object: "list",
		data: [
			{ id: "gpt-4o", object: "model" },
			{ id: "gpt-4o-mini" },
			{ nope: true },
			"garbage",
		],
	});
	eq("adapter: openai 解析", openai.models, [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }]);

	const anthropic = parseModelsResponse("anthropic-messages", {
		data: [
			{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", type: "model" },
			{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
		],
		has_more: true,
	});
	eq("adapter: anthropic 解析带 display_name", anthropic.models, [
		{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
		{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
	]);

	const google = parseModelsResponse("google-generative-ai", {
		models: [
			{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
			{ name: "models/embedding-001" },
		],
		nextPageToken: "next-1",
	});
	eq("adapter: google 解析去 models/ 前缀", google.models, [
		{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
	]);
	eq("adapter: google 分页 token", google.nextPageToken, "next-1");
	eq("adapter: google 识别数组并区分原始/有效/过滤计数", [
		google.recognized, google.rawCount, google.parsedCount, google.filteredCount,
	], [true, 2, 2, 1]);

	// 部分中转站直接返回数组
	const arr = parseModelsResponse("openai-completions", [{ id: "m1" }]);
	eq("adapter: 兼容裸数组", arr.models, [{ id: "m1" }]);
	eq("adapter: 缺 expected array 不伪装空清单", parseModelsResponse("openai-completions", {
		object: "list",
	}).recognized, false);
	eq("adapter: wrong expected array shape 不伪装空清单", parseModelsResponse("anthropic-messages", {
		data: { id: "m1" },
	}).recognized, false);
	const allFiltered = parseModelsResponse("openai-completions", {
		data: [{ id: "text-embedding-3-large" }, { nope: true }, "garbage"],
	});
	eq("adapter: 原始非空但全部过滤仍保留有效计数", [
		allFiltered.recognized, allFiltered.rawCount, allFiltered.parsedCount, allFiltered.filteredCount, allFiltered.models,
	], [true, 3, 1, 0, []]);
}

// ---------------------------------------------------------------------------
// fetchModelsList（mock fetch）
// ---------------------------------------------------------------------------

function mockResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}

{
	// 成功路径 + redirect:"error" 透传
	let seenInit: RequestInit | undefined;
	const okResult = await fetchModelsList({
		protocol: "openai-completions",
		baseUrl: "https://x.com/v1",
		apiKey: "k",
		fetchImpl: async (_url, init) => {
			seenInit = init;
			return mockResponse(200, { data: [{ id: "m1" }, { id: "m2" }] });
		},
	});
	eq("fetch: 成功聚合", okResult, {
		ok: true,
		models: [{ id: "m1" }, { id: "m2" }],
		rawCount: 2,
		parsedCount: 2,
		filteredCount: 2,
	});
	eq("fetch: redirect:error", seenInit?.redirect, "error");

	// 401
	const unauthorized = await fetchModelsList({
		protocol: "openai-completions",
		baseUrl: "https://x.com/v1",
		apiKey: "bad",
		fetchImpl: async () => mockResponse(401, { error: "nope" }),
	});
	eq("fetch: 401 分类", unauthorized, { ok: false, error: { kind: "unauthorized", status: 401, message: "HTTP 401" } });

	// 404
	const notFound = await fetchModelsList({
		protocol: "anthropic-messages",
		baseUrl: "https://x.com",
		apiKey: "k",
		fetchImpl: async () => mockResponse(404, {}),
	});
	eq("fetch: 404 分类", notFound.ok === false && notFound.error.kind, "not_found");

	// 超时（AbortError）
	const timeout = await fetchModelsList({
		protocol: "openai-completions",
		baseUrl: "https://x.com/v1",
		apiKey: "k",
		timeoutMs: 5,
		fetchImpl: async (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("The operation was aborted", "AbortError")),
				);
			}),
	});
	eq("fetch: 超时分类", timeout.ok === false && timeout.error.kind, "timeout");

	// google 分页聚合
	let page = 0;
	const google = await fetchModelsList({
		protocol: "google-generative-ai",
		baseUrl: "https://g.com/v1beta",
		apiKey: "k",
		fetchImpl: async (url) => {
			page += 1;
			if (page === 1) {
				check("fetch: google 第一页无 pageToken", !url.includes("pageToken="), url);
				return mockResponse(200, { models: [{ name: "models/a" }], nextPageToken: "t2" });
			}
			check("fetch: google 第二页带 pageToken", url.includes("pageToken=t2"), url);
			return mockResponse(200, { models: [{ name: "models/b" }] });
		},
	});
	eq("fetch: google 分页聚合", google, {
		ok: true,
		models: [{ id: "a" }, { id: "b" }],
		rawCount: 2,
		parsedCount: 2,
		filteredCount: 2,
	});

	const malformedShape = await fetchModelsList({
		protocol: "openai-completions",
		baseUrl: "https://x.com/v1",
		apiKey: "k",
		fetchImpl: async () => mockResponse(200, { object: "list" }),
	});
	eq("fetch: missing expected array => bad_response",
		malformedShape.ok === false && malformedShape.error.kind, "bad_response");
	const invalidEntries = await fetchModelsList({
		protocol: "openai-completions",
		baseUrl: "https://x.com/v1",
		apiKey: "k",
		fetchImpl: async () => mockResponse(200, { data: [{}, "garbage", null] }),
	});
	eq("fetch: 容器存在但没有有效模型 ID => bad_response",
		invalidEntries.ok === false && invalidEntries.error.kind, "bad_response");
	const invalidGoogleEntries = await fetchModelsList({
		protocol: "google-generative-ai",
		baseUrl: "https://g.com/v1beta",
		apiKey: "k",
		fetchImpl: async () => mockResponse(200, { models: [null, {}, "garbage"] }),
	});
	eq("fetch: google 容器纯无效条目 => bad_response",
		invalidGoogleEntries.ok === false && invalidGoogleEntries.error.kind, "bad_response");

	const realEmpty = await fetchModelsList({
		protocol: "anthropic-messages",
		baseUrl: "https://x.com",
		apiKey: "k",
		fetchImpl: async () => mockResponse(200, { data: [] }),
	});
	eq("fetch: recognized [] => empty", realEmpty.ok === false && realEmpty.error.kind, "empty");

	const nonemptyAllFiltered = await fetchModelsList({
		protocol: "openai-completions",
		baseUrl: "https://x.com/v1",
		apiKey: "k",
		fetchImpl: async () => mockResponse(200, {
			data: [{ id: "text-embedding-3-large" }, { id: "whisper-1" }],
		}),
	});
	eq("fetch: raw nonempty all filtered => successful distinct zero", nonemptyAllFiltered, {
		ok: true,
		models: [],
		rawCount: 2,
		parsedCount: 2,
		filteredCount: 0,
	});

	// authHeader 透传：anthropic 协议 + authHeader:true → 请求同时带 x-api-key 与 Bearer
	let seenHeaders: Record<string, string> | undefined;
	await fetchModelsList({
		protocol: "anthropic-messages",
		baseUrl: "https://k.example.com",
		apiKey: "sk-test",
		authHeader: true,
		fetchImpl: async (_url, init) => {
			seenHeaders = (init?.headers ?? {}) as Record<string, string>;
			return mockResponse(200, { data: [{ id: "m1" }] });
		},
	});
	eq("fetch: authHeader 透传（Bearer + 协议原认证头）", seenHeaders, {
		"x-api-key": "sk-test",
		"anthropic-version": "2023-06-01",
		Authorization: "Bearer sk-test",
	});

	eq("http 状态分类", [classifyHttpStatus(401), classifyHttpStatus(403), classifyHttpStatus(404), classifyHttpStatus(500)], [
		"unauthorized",
		"unauthorized",
		"not_found",
		"http",
	]);
	eq("异常分类: redirect", classifyFetchException(new TypeError("Failed to redirect")), "redirect_blocked");
	eq("异常分类: network", classifyFetchException(new TypeError("fetch failed")), "network");
}

// ---------------------------------------------------------------------------
// 非聊天过滤
// ---------------------------------------------------------------------------

{
	const keep = ["gpt-4o", "claude-sonnet-4-5", "deepseek-chat", "gemini-2.5-pro", "glm-4.6", "MiniMax-M2", "kimi-k2", "qwen3-coder"];
	const drop = [
		"text-embedding-3-large",
		"text-embedding-ada-002",
		"dall-e-3",
		"whisper-1",
		"tts-1-hd",
		"omni-moderation-latest",
		"embedding-001",
		"models/embedding-001",
		"imagen-3.0-generate-002",
		"veo-2.0-generate-001",
		"bge-m3",
		"rerank-v2",
		"stable-diffusion-xl",
	];
	for (const id of keep) check(`filter: 保留 ${id}`, isChatModel(id));
	for (const id of drop) check(`filter: 排除 ${id}`, !isChatModel(id));

	const deduped = filterChatModels([
		{ id: "gpt-4o" },
		{ id: "GPT-4o" },
		{ id: "whisper-1" },
		{ id: "deepseek-chat" },
	]);
	eq("filter: 去重+过滤", deduped, [{ id: "gpt-4o" }, { id: "deepseek-chat" }]);
}

// ---------------------------------------------------------------------------
// 元数据补全
// ---------------------------------------------------------------------------

{
	const hit = completeModelMeta({ id: "deepseek-chat" }, findPreset("deepseek"));
	// 拉取发现的模型默认不勾选（用户勾选后才写入 models.json）
	eq("meta: 预设精确命中", [hit.contextWindow, hit.maxTokens, hit.reasoning, hit.input, hit.selected, hit.metaConfirmed], [
		128000, 8192, false, null, false, false,
	]);
	eq("meta: 预设命中来源标记为 preset（待确认）", [
		hit.metaSources?.contextWindow, hit.metaSources?.maxTokens, hit.metaSources?.reasoning,
	], ["preset", "preset", "preset"]);

	// 前缀规则不再参与补全：不得按模型名字/厂商前缀猜参数（未知就保持未知）
	const prefixHit = completeModelMeta({ id: "claude-foo-9" }, findPreset("anthropic"));
	eq("meta: 前缀不再猜参数（四项全未知）", [
		prefixHit.contextWindow, prefixHit.maxTokens, prefixHit.reasoning, prefixHit.input, prefixHit.metaConfirmed, prefixHit.metaSources,
	], [null, null, null, null, false, undefined]);

	const miss = completeModelMeta({ id: "some-unknown-model" }, findPreset("openai"));
	eq("meta: 未命中字段未知（null）不落猜测值", [
		miss.contextWindow, miss.maxTokens, miss.reasoning, miss.input, miss.selected, miss.metaConfirmed, miss.metaSources,
	], [null, null, null, null, false, false, undefined]);

	const batch = completeModelsMeta([{ id: "glm-4.6" }, { id: "x" }], "zai");
	eq("meta: 批量 input 未知均不算完整", batch.map((d) => d.metaConfirmed), [false, false]);

	const manual = draftFromManualId("  kimi-k2 ", "kimi-coding");
	eq("meta: 手填 trim + 元数据未知仍默认勾选", manual ? [manual.id, manual.metaConfirmed, manual.selected] : null, ["kimi-k2", false, true]);
	eq("meta: 手填来源标记 manual 且非远端发现", manual ? [manual.origin, manual.seenInFetch] : null, ["manual", false]);
	eq("meta: 手填空串", draftFromManualId("   ", "kimi-coding"), null);
}

// ---------------------------------------------------------------------------
// 适配器：远端能力字段解析（issue 3）
// ---------------------------------------------------------------------------

{
	const openai = parseModelsResponse("openai-completions", {
		object: "list",
		data: [
			{ id: "m-camel", contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
			{ id: "m-snake", context_length: 128000, max_output_tokens: 8192 },
			{ id: "m-alt", context_window: 64000, max_tokens: 4096 },
			{ id: "m-limits", inputTokenLimit: 100000, outputTokenLimit: 5000 },
			{ id: "m-mod", modalities: ["text", "image"] },
			{ id: "m-mod-obj", modalities: { input: ["text", "image"], output: ["text"] } },
			{ id: "m-sim", supported_input_modalities: ["text"] },
			{ id: "m-cap", capabilities: { reasoning: true } },
			{ id: "m-bad", reasoning: "yes", contextWindow: "100k" },
			{ id: "m-numstr", context_length: "128000" },
		],
	});
	const byId = new Map(openai.models.map((m) => [m.id, m]));
	eq("adapter meta: camelCase 全字段", [
		byId.get("m-camel")?.contextWindow, byId.get("m-camel")?.maxTokens,
		byId.get("m-camel")?.reasoning, byId.get("m-camel")?.input,
	], [200000, 64000, true, ["text", "image"]]);
	eq("adapter meta: snake_case context_length/max_output_tokens", [
		byId.get("m-snake")?.contextWindow, byId.get("m-snake")?.maxTokens,
	], [128000, 8192]);
	eq("adapter meta: context_window/max_tokens", [
		byId.get("m-alt")?.contextWindow, byId.get("m-alt")?.maxTokens,
	], [64000, 4096]);
	eq("adapter meta: inputTokenLimit/outputTokenLimit", [
		byId.get("m-limits")?.contextWindow, byId.get("m-limits")?.maxTokens,
	], [100000, 5000]);
	eq("adapter meta: modalities 数组规范化", byId.get("m-mod")?.input, ["text", "image"]);
	eq("adapter meta: modalities.input 对象结构规范化", byId.get("m-mod-obj")?.input, ["text", "image"]);
	eq("adapter meta: supported_input_modalities 仅文本", byId.get("m-sim")?.input, ["text"]);
	eq("adapter meta: capabilities.reasoning 明确结构", byId.get("m-cap")?.reasoning, true);
	eq("adapter meta: 非 boolean reasoning 与不可解析数值均视为未返回", [
		byId.get("m-bad")?.reasoning, byId.get("m-bad")?.contextWindow,
	], [undefined, undefined]);
	eq("adapter meta: 数字字符串可解析", byId.get("m-numstr")?.contextWindow, 128000);

	const google = parseModelsResponse("google-generative-ai", {
		models: [
			{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1048576, outputTokenLimit: 65536 },
		],
	});
	eq("adapter meta: google inputTokenLimit/outputTokenLimit", [
		google.models[0]?.id, google.models[0]?.contextWindow, google.models[0]?.maxTokens,
	], ["gemini-2.5-pro", 1048576, 65536]);
}

// ---------------------------------------------------------------------------
// 元数据补全优先级：remote → preset exact → catalog exact ID → preset prefix（issue 3）
// ---------------------------------------------------------------------------

function catalogEntry(
	provider: string,
	id: string,
	contextWindow: number | null,
	maxTokens: number | null,
	reasoning: boolean | null,
	input: RuntimeCatalogEntry["input"],
): RuntimeCatalogEntry {
	return { provider, id, contextWindow, maxTokens, reasoning, input };
}

{
	// 运行时目录条目解析
	eq("catalog: 解析运行时条目", parseRuntimeCatalogEntry({
		provider: "anthropic", id: "claude-x", name: "Claude X",
		contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"],
	}), {
		provider: "anthropic", id: "claude-x", name: "Claude X",
		contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"],
	});
	eq("catalog: 缺 provider/id 丢弃", [
		parseRuntimeCatalogEntry({ id: "x" }), parseRuntimeCatalogEntry({ provider: "p" }),
	], [null, null]);
	eq("catalog: input 大小写规范化", parseRuntimeCatalogEntry({ provider: "p", id: "x", input: ["TEXT", "Image"] })?.input, ["text", "image"]);
	eq("catalog: 缺能力字段为 null", parseRuntimeCatalogEntry({ provider: "p", id: "x" }), {
		provider: "p", id: "x", name: undefined, contextWindow: null, maxTokens: null, reasoning: null, input: null,
	});

	// 远端字段优先于 preset exact
	const remoteFirst = completeModelMeta(
		{ id: "deepseek-chat", contextWindow: 999000, reasoning: true },
		findPreset("deepseek"),
	);
	eq("meta: 远端字段优先于 preset", [remoteFirst.contextWindow, remoteFirst.reasoning, remoteFirst.maxTokens], [999000, true, 8192]);
	eq("meta: 远端/preset 来源标记", [
		remoteFirst.metaSources?.contextWindow, remoteFirst.metaSources?.reasoning, remoteFirst.metaSources?.maxTokens,
	], ["remote", "remote", "preset"]);

	// preset exact 优先于 catalog；preset 没有的 input 仍由 catalog 填补
	const presetOverCatalog = completeModelMeta({ id: "deepseek-chat" }, findPreset("deepseek"), {
		provider: "deepseek",
		entries: [catalogEntry("deepseek", "deepseek-chat", 111, 222, true, ["text", "image"])],
	});
	eq("meta: preset exact 优先于 catalog", [
		presetOverCatalog.contextWindow, presetOverCatalog.maxTokens, presetOverCatalog.reasoning,
	], [128000, 8192, false]);
	eq("meta: catalog 填补 preset 缺失的 input（四项齐全=完整）", [
		presetOverCatalog.input, presetOverCatalog.metaConfirmed, presetOverCatalog.metaSources?.input,
	], [["text", "image"], true, "catalog"]);

	// catalog 精确 ID 命中的字段保留；其余字段不再由 preset 前缀兜底（保持未知）
	const catalogOverPrefix = completeModelMeta({ id: "claude-foo-9" }, findPreset("anthropic"), {
		provider: "my-relay",
		entries: [catalogEntry("anthropic", "claude-foo-9", 333000, null, null, null)],
	});
	eq("meta: catalog 精确 ID 命中保留", [
		catalogOverPrefix.contextWindow, catalogOverPrefix.metaSources?.contextWindow,
	], [333000, "catalog"]);
	eq("meta: catalog 缺失字段保持未知（前缀不猜）", [
		catalogOverPrefix.maxTokens, catalogOverPrefix.reasoning, catalogOverPrefix.input, catalogOverPrefix.metaConfirmed,
	], [null, null, null, false]);

	// catalog 跨 provider：exact id 唯一 → 补全
	const crossUnique = completeModelMeta({ id: "claude-sonnet-4-5" }, null, {
		provider: "my-relay",
		entries: [catalogEntry("anthropic", "claude-sonnet-4-5", 200000, 64000, true, ["text", "image"])],
	});
	eq("meta: catalog 跨 provider 唯一精确补全", [
		crossUnique.contextWindow, crossUnique.maxTokens, crossUnique.reasoning, crossUnique.input, crossUnique.metaConfirmed,
	], [200000, 64000, true, ["text", "image"], true]);
	eq("meta: catalog 来源标记", crossUnique.metaSources?.contextWindow, "catalog");

	// catalog：provider + exact id 命中优先于跨 provider
	const sameProvider = completeModelMeta({ id: "m1" }, null, {
		provider: "p1",
		entries: [
			catalogEntry("p2", "m1", 111, 10, false, ["text"]),
			catalogEntry("p1", "m1", 222, 20, true, ["text", "image"]),
		],
	});
	eq("meta: catalog 同 provider+id 优先", [sameProvider.contextWindow, sameProvider.maxTokens], [222, 20]);

	// catalog：不唯一但能力完全一致 → 可复用
	const agree = completeModelMeta({ id: "m-same" }, null, {
		provider: "relay",
		entries: [
			catalogEntry("a", "m-same", 100, 10, false, ["text"]),
			catalogEntry("b", "m-same", 100, 10, false, ["text"]),
		],
	});
	eq("meta: catalog 多匹配能力一致则补全", [agree.contextWindow, agree.maxTokens, agree.input, agree.metaConfirmed], [100, 10, ["text"], true]);

	// catalog：不唯一且能力冲突 → 不补全
	const conflict = completeModelMeta({ id: "m-conf" }, null, {
		provider: "relay",
		entries: [
			catalogEntry("a", "m-conf", 100, 10, false, ["text"]),
			catalogEntry("b", "m-conf", 200, 10, false, ["text"]),
		],
	});
	eq("meta: catalog 冲突不补全", [
		conflict.contextWindow, conflict.maxTokens, conflict.reasoning, conflict.input, conflict.metaSources,
	], [null, null, null, null, undefined]);

	// catalog：pi 缺省四元组（当前自定义 provider 或其它 provider）都不算权威
	const defaultsSelf = completeModelMeta({ id: "m-def" }, null, {
		provider: "relay",
		entries: [catalogEntry("relay", "m-def", 128000, 16384, false, ["text"])],
	});
	eq("meta: 当前 provider 的 pi 缺省值不回填", [
		defaultsSelf.contextWindow, defaultsSelf.maxTokens, defaultsSelf.reasoning, defaultsSelf.input,
	], [null, null, null, null]);
	const defaultsOther = completeModelMeta({ id: "m-def2" }, null, {
		provider: "relay",
		entries: [catalogEntry("other", "m-def2", 128000, 16384, false, ["text"])],
	});
	eq("meta: 其它 provider 的 pi 缺省值同样排除", defaultsOther.contextWindow, null);

	// 无 preset 无 catalog 命中 → 全部保持未知
	const unknown = completeModelMeta({ id: "zzz-unknown" }, null, { provider: "relay", entries: [] });
	eq("meta: 无可靠来源保持未知不伪造", [
		unknown.contextWindow, unknown.maxTokens, unknown.reasoning, unknown.input, unknown.metaConfirmed, unknown.metaSources,
	], [null, null, null, null, false, undefined]);
}

// ---------------------------------------------------------------------------
// pi 静态模型目录（@mariozechner/pi-ai，认证无关）+ 静态/运行时目录合并
// ---------------------------------------------------------------------------

{
	// 加载失败/结构不符一律安全降级为空目录（不阻断设置页）
	eq(
		"static: 导入失败降级为空目录",
		await loadPiStaticCatalog(() => Promise.reject(new Error("package missing"))),
		[],
	);
	eq("static: 缺 API 降级为空目录", await loadPiStaticCatalog(() => Promise.resolve({})), []);
	eq(
		"static: 单个 provider 读取异常不影响其它 provider",
		await loadPiStaticCatalog(() =>
			Promise.resolve({
				getProviders: () => ["bad", "good"],
				getModels: (provider: string) => {
					if (provider === "bad") throw new Error("broken provider");
					return [{ provider: "good", id: "m1", contextWindow: 1000, maxTokens: 100, reasoning: false, input: ["text"] }];
				},
			}),
		),
		[catalogEntry("good", "m1", 1000, 100, false, ["text"])],
	);

	// 已安装 pi-ai 静态表可直接读取（不走 pi 运行时 hasConfiguredAuth 过滤）
	const staticCatalog = await loadPiStaticCatalog();
	check("static: 已安装 pi-ai 静态表非空", staticCatalog.length > 0, staticCatalog.length);

	// 截图 6 个 Claude ID：只配 cc-kiro-cache 自定义中转（无 anthropic/opencode 认证）时
	// 运行时目录拿不到 pi 内置 anthropic 模型，静态表仍能给出权威能力四元组
	const screenshotClaude = [
		["claude-haiku-4-5", 200000, 64000],
		["claude-haiku-4-5-20251001", 200000, 64000],
		["claude-opus-4-1", 200000, 32000],
		["claude-opus-4-1-20250805", 200000, 32000],
		["claude-opus-4-5", 200000, 64000],
		["claude-opus-4-5-20251101", 200000, 64000],
	] as const;
	for (const [id, contextWindow, maxTokens] of screenshotClaude) {
		const entry = staticCatalog.find((e) => e.provider === "anthropic" && e.id === id);
		eq(`static: ${id} 取自已安装 pi 静态表的权威能力`, entry ? [
			entry.contextWindow, entry.maxTokens, entry.reasoning, entry.input,
		] : null, [contextWindow, maxTokens, true, ["text", "image"]]);
	}

	// 合并语义 1：运行时 pi 缺省四元组不覆盖静态目录里同 provider+id 的权威能力
	const keepStatic = mergeCatalogEntries(
		[catalogEntry("anthropic", "m-x", 200000, 64000, true, ["text", "image"])],
		[catalogEntry("anthropic", "m-x", 128000, 16384, false, ["text"])],
	);
	eq("merge: 缺省四元组不覆盖静态权威能力", keepStatic, [
		catalogEntry("anthropic", "m-x", 200000, 64000, true, ["text", "image"]),
	]);

	// 合并语义 2：运行时条目含明确非缺省能力/用户 override 时覆盖对应静态条目
	const overridden = mergeCatalogEntries(
		[catalogEntry("anthropic", "m-y", 200000, 64000, true, ["text", "image"])],
		[catalogEntry("anthropic", "m-y", 999000, 32000, false, ["text"])],
	);
	eq("merge: 非缺省运行时条目覆盖静态", overridden, [
		catalogEntry("anthropic", "m-y", 999000, 32000, false, ["text"]),
	]);

	// 合并语义 3：运行时条目的 null 字段保留静态值（不丢已确认字段）
	const partialRuntime = mergeCatalogEntries(
		[catalogEntry("anthropic", "m-z", 200000, 64000, true, ["text", "image"])],
		[catalogEntry("anthropic", "m-z", 150000, null, null, null)],
	);
	eq("merge: 运行时 null 字段由静态补齐", partialRuntime, [
		catalogEntry("anthropic", "m-z", 150000, 64000, true, ["text", "image"]),
	]);

	// 合并语义 4：自定义 provider 运行时条目（含缺省四元组）加入目录；
	// 显式配置的能力可被同 provider 精确匹配（优先于静态目录的跨 provider 复用）
	const customMerged = mergeCatalogEntries(
		[catalogEntry("anthropic", "m-c", 200000, 64000, true, ["text", "image"])],
		[
			catalogEntry("my-relay", "m-c", 100000, 8192, false, ["text"]),
			catalogEntry("my-relay", "m-default", 128000, 16384, false, ["text"]),
		],
	);
	eq(
		"merge: 自定义 provider 运行时条目加入目录",
		customMerged.filter((e) => e.provider === "my-relay").map((e) => e.id).sort(),
		["m-c", "m-default"],
	);
	const sameProviderHit = lookupRuntimeCatalogMeta({ provider: "my-relay", entries: customMerged }, "m-c");
	eq(
		"merge: 自定义 provider 显式能力同 provider 精确命中",
		sameProviderHit ? [sameProviderHit.provider, sameProviderHit.contextWindow, sameProviderHit.maxTokens] : null,
		["my-relay", 100000, 8192],
	);

	// 合并语义 5：RPC 断开时静态目录独立可用（运行时目录为空 = 纯静态底座）
	const offlineMerged = mergeCatalogEntries(staticCatalog, []);
	eq("merge: 无运行时目录时等于静态底座", offlineMerged.length, staticCatalog.length);

	// 真实场景端到端：cc-kiro-cache 运行时目录只有本 provider 的 pi 缺省条目；
	// 合并静态目录后 6 个截图 ID 全部经目录补全完整
	// （claude-opus-4-5/4-1/haiku-4-5 为跨 provider：anthropic 与 opencode 能力完全一致；
	// 三个带日期后缀的 ID 为 anthropic 唯一匹配）
	const relayMerged = mergeCatalogEntries(staticCatalog, [
		catalogEntry("cc-kiro-cache", "claude-opus-4-5", 128000, 16384, false, ["text"]),
	]);
	for (const [id] of screenshotClaude) {
		const hit = completeModelMeta({ id }, null, { provider: "cc-kiro-cache", entries: relayMerged });
		check(
			`merge: ${id} 经合并目录补全完整`,
			hit.contextWindow !== null
				&& hit.maxTokens !== null
				&& hit.reasoning === true
				&& hit.input !== null
				&& hit.metaConfirmed
				&& hit.metaSources?.contextWindow === "catalog"
				&& hit.metaSources?.input === "catalog",
			[hit.contextWindow, hit.maxTokens, hit.reasoning, hit.input, hit.metaConfirmed],
		);
	}

	// 对照：不合并静态目录时，同样的运行时目录补不出（缺省四元组被排除 → 保持未知）
	const runtimeOnly = completeModelMeta({ id: "claude-opus-4-5" }, null, {
		provider: "cc-kiro-cache",
		entries: [catalogEntry("cc-kiro-cache", "claude-opus-4-5", 128000, 16384, false, ["text"])],
	});
	eq("merge: 对照组无静态目录仍保持未知", [
		runtimeOnly.contextWindow, runtimeOnly.maxTokens, runtimeOnly.reasoning, runtimeOnly.input, runtimeOnly.metaConfirmed,
	], [null, null, null, null, false]);
}

// ---------------------------------------------------------------------------
// 拉取结果与既有草稿合并（来源真实语义：选择保留 / 新增默认不勾选 /
// saved/manual 漏项保留标未发现 / 旧 remote-only 漏项删除）
// ---------------------------------------------------------------------------

function savedDraft(
	id: string,
	fields: Partial<ModelDraft> = {},
): ModelDraft {
	return {
		id,
		name: id,
		contextWindow: null,
		maxTokens: null,
		reasoning: null,
		input: null,
		selected: true,
		metaConfirmed: false,
		origin: "saved",
		seenInFetch: false,
		...fields,
	};
}

{
	// 首次拉取：existing=null → 全部默认不勾选，来源 remote + 本次已发现
	const first = mergeFetchedModelDrafts(completeModelsMeta([{ id: "a" }, { id: "b" }], null), null);
	eq("merge: 首次拉取默认不勾选", first.map((m) => m.selected), [false, false]);
	eq("merge: 首次拉取来源标记 remote/seen", first.map((m) => [m.origin, m.seenInFetch]), [
		["remote", true], ["remote", true],
	]);

	const existing: ModelDraft[] = [
		savedDraft("a", { contextWindow: 111 }),
		savedDraft("b", { selected: false }),
		savedDraft("c", { contextWindow: 333, maxTokens: 333, reasoning: false, input: ["text"], metaConfirmed: true }),
	];
	const refetched = completeModelsMeta(
		[{ id: "a", contextWindow: 999, maxTokens: 888 }, { id: "b" }, { id: "d" }],
		null,
	);
	const merged = mergeFetchedModelDrafts(refetched, existing);

	eq("merge: 保留既有勾选/新发现默认不勾选/saved 漏项保留", merged.map((m) => [m.id, m.selected]), [
		["a", true], ["b", false], ["d", false], ["c", true],
	]);

	const a = merged.find((m) => m.id === "a");
	eq("merge: 已确认字段不被远端覆盖", a?.contextWindow, 111);
	eq("merge: 仍空字段用本轮补全填补并标来源", [a?.maxTokens, a?.metaSources?.maxTokens], [888, "remote"]);
	eq("merge: 既有用户值不挂自动补全来源", a?.metaSources?.contextWindow, undefined);
	eq("merge: 同 ID 已保存行命中远端 → 来源不降级 + 标记已发现", [a?.origin, a?.seenInFetch], ["saved", true]);

	const c = merged.find((m) => m.id === "c");
	eq("merge: saved 漏项保留原选择/元数据", [c?.selected, c?.contextWindow, c?.metaConfirmed], [true, 333, true]);
	eq("merge: saved 漏项标记本次远端未发现", [c?.origin, c?.seenInFetch], ["saved", false]);

	const d = merged.find((m) => m.id === "d");
	eq("merge: 新发现行来源 remote/seen", [d?.origin, d?.seenInFetch], ["remote", true]);

	// 既有 id 大小写不随远端抖动
	const caseMerged = mergeFetchedModelDrafts(
		completeModelsMeta([{ id: "GPT-4o" }], null),
		[savedDraft("gpt-4o")],
	);
	eq("merge: id 匹配忽略大小写且保留既有写法", [caseMerged.length, caseMerged[0]?.id, caseMerged[0]?.selected], [1, "gpt-4o", true]);
}

// ---------------------------------------------------------------------------
// 渠道来源真实性回归（cc-kiro-cache 误导清单修复）
// ---------------------------------------------------------------------------

{
	// 1) catalog/预设只能给相同 ID 补元数据，绝不向渠道列表新增模型 ID
	const withCatalog = completeModelsMeta([{ id: "a" }], null, {
		provider: "relay",
		entries: [
			catalogEntry("relay", "a", 100, 10, false, ["text"]),
			catalogEntry("relay", "b", 200, 20, true, ["text", "image"]),
			catalogEntry("other", "c", 300, 30, false, ["text"]),
		],
	});
	eq("provenance: catalog 不产生额外模型 ID", withCatalog.map((m) => m.id), ["a"]);
	eq("provenance: catalog 同 ID 元数据照常补全", [
		withCatalog[0]?.contextWindow, withCatalog[0]?.metaConfirmed,
	], [100, true]);
	const withPreset = completeModelsMeta([{ id: "x" }], "deepseek"); // deepseek 预设表含 deepseek-chat 等条目
	eq("provenance: 预设精确表不产生额外模型 ID", withPreset.map((m) => m.id), ["x"]);

	// 2) 成功但 0 个模型：清掉全部旧 remote-only 行，只留 saved/manual
	const afterEmpty = mergeFetchedModelDrafts([], [
		savedDraft("s1", { contextWindow: 100, maxTokens: 10, reasoning: false, input: ["text"], metaConfirmed: true }),
		{ ...savedDraft("r1", { selected: false }), origin: "remote" as const, seenInFetch: true },
		{ ...savedDraft("m1", { selected: false }), origin: "manual" as const },
	]);
	eq("provenance: 空远端结果清除 remote-only 行", afterEmpty.map((m) => m.id), ["s1", "m1"]);
	eq("provenance: 空远端结果后 saved/manual 标记未发现", afterEmpty.map((m) => [m.origin, m.seenInFetch]), [
		["saved", false], ["manual", false],
	]);

	// 3) 第二次拉取缺少上次 remote-only ID → 该行被删除（不再伪装可用）
	const refetchGone = mergeFetchedModelDrafts(
		completeModelsMeta([{ id: "s1" }], null),
		[
			savedDraft("s1", { contextWindow: 100, maxTokens: 10, reasoning: false, input: ["text"], metaConfirmed: true }),
			{ ...savedDraft("old-remote", { selected: true }), origin: "remote" as const, seenInFetch: true },
		],
	);
	eq("provenance: 上次 remote-only 本次未返回即删除", refetchGone.map((m) => m.id), ["s1"]);

	// 4) saved/manual 未命中远端：保留且标未发现；manual 行不被删除
	const refetchMiss = mergeFetchedModelDrafts(
		completeModelsMeta([{ id: "new-1" }], null),
		[
			savedDraft("s1"),
			{ ...savedDraft("m1", { selected: false }), origin: "manual" as const },
		],
	);
	eq("provenance: saved/manual 漏项保留 + 新发现追加", refetchMiss.map((m) => [m.id, m.origin, m.seenInFetch]), [
		["new-1", "remote", true], ["s1", "saved", false], ["m1", "manual", false],
	]);

	// 5) 未知元数据仍可选择/保存（pi 会使用可选字段缺省值）
	const unknown = completeModelMeta({ id: "never-seen-9" }, null);
	eq("guard: 远端新发现且信息不全 → 不默认勾选", [unknown.metaConfirmed, unknown.selected], [false, false]);
	const manualUnknown = draftFromManualId("never-seen-9", null);
	eq("guard: 手填信息不全仍默认勾选", manualUnknown?.selected, true);
	const selectAllResult = withAllAddableSelected([
		savedDraft("u1", { selected: false }), // 信息不全
		savedDraft("ok1", { selected: false, contextWindow: 1, maxTokens: 1, reasoning: false, input: ["text"], metaConfirmed: true }),
	]);
	eq("guard: 全选包含信息不全行", selectAllResult.map((m) => [m.id, m.selected]), [
		["u1", true], ["ok1", true],
	]);
	eq("guard: 保存校验不再拒绝勾选信息不全行", findIncompleteSelectedDraft([
		savedDraft("ok1", { contextWindow: 1, maxTokens: 1, reasoning: false, input: ["text"], metaConfirmed: true }),
		savedDraft("bad1"), // selected:true（saved 缺省）且信息不全
	]), null);
	eq("guard: 全部齐全时校验通过", findIncompleteSelectedDraft([
		savedDraft("ok1", { contextWindow: 1, maxTokens: 1, reasoning: false, input: ["text"], metaConfirmed: true }),
	]), null);

	// 7) 完整已保存模型与远端同 ID 合并：仍可选、字段不丢、extraFields 不丢
	const completeSaved = savedDraft("claude-opus-4-8", {
		name: "Claude Opus 4.8 · Kiro 满血缓存",
		contextWindow: 1000000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		metaConfirmed: true,
		extraFields: { cost: { input: 5, output: 25 }, compat: { supportsTemperature: false } },
	});
	const mergedComplete = mergeFetchedModelDrafts(
		completeModelsMeta([{ id: "claude-opus-4-8", contextWindow: 200000, maxTokens: 64000, reasoning: false }], null),
		[completeSaved],
	);
	const mc = mergedComplete[0];
	eq("guard: 完整 saved 与远端同 ID 合并仍可选", [mc?.selected, mc?.metaConfirmed, mc?.origin, mc?.seenInFetch], [true, true, "saved", true]);
	eq("guard: 已确认四项不被远端覆盖", [mc?.contextWindow, mc?.maxTokens, mc?.reasoning, mc?.input], [1000000, 128000, true, ["text", "image"]]);
	eq("guard: extraFields 合并后保留", mc?.extraFields, { cost: { input: 5, output: 25 }, compat: { supportsTemperature: false } });

	// 来源/临时字段绝不落盘；extraFields 原样写回
	const entry = toModelEntry(mc!);
	check("persist: 来源字段不写入 models.json", !("origin" in entry) && !("seenInFetch" in entry), entry);
	check("persist: extraFields 写回 models.json", "cost" in entry && "compat" in entry, entry);
	eq("persist: 已知字段照常写入", [entry.id, entry.contextWindow, entry.input], ["claude-opus-4-8", 1000000, ["text", "image"]]);
}

// ---------------------------------------------------------------------------
// 编辑页名称回填（issue 1）
// ---------------------------------------------------------------------------

{
	eq("alias: 非空 meta alias 优先", resolveChannelEditAlias("我的渠道", "显示名", "provider-x"), "我的渠道");
	eq("alias: alias 去空白", resolveChannelEditAlias("  名  ", "显示名", "provider-x"), "名");
	eq("alias: alias 空白回退 displayName", resolveChannelEditAlias("   ", "显示名", "provider-x"), "显示名");
	eq("alias: 无 alias 回退 displayName", resolveChannelEditAlias(undefined, "显示名", "provider-x"), "显示名");
	eq("alias: displayName 空回退 provider", resolveChannelEditAlias(undefined, "  ", "provider-x"), "provider-x");
}

// ---------------------------------------------------------------------------
// 配置读写纯逻辑
// ---------------------------------------------------------------------------

{
	eq("providerId: 规范化", normalizeProviderId("  My Relay 01! "), "my-relay-01");
	check("providerId: 合法", isValidProviderId("deepseek-v2"));
	check("providerId: 空非法", !isValidProviderId(""));
	check("providerId: 开头符号非法", !isValidProviderId("-abc"));

	const account = "deepseek";
	const cmd = buildKeychainRefCommand(account);
	eq("keychain: 引用格式", cmd, "!security find-generic-password -s pi-gui.channels -a deepseek -w");
	eq("keychain: 反解", parseKeychainAccount(cmd), "deepseek");
	eq("keychain: 别的 service 不认", parseKeychainAccount("!security find-generic-password -s other -a x -w"), null);

	eq("classify: env", classifyKeyRef({ type: "api_key", key: "$DEEPSEEK_API_KEY" }), "env");
	eq("classify: keychain", classifyKeyRef({ type: "api_key", key: cmd }), "keychain");
	eq("classify: 其它 cmd", classifyKeyRef({ type: "api_key", key: "!pass show api" }), "command");
	eq("classify: 明文", classifyKeyRef({ type: "api_key", key: "sk-xxx" }), "plain");
	eq("classify: oauth", classifyKeyRef({ type: "oauth", access: "x" }), "oauth");
	eq("classify: 空", classifyKeyRef(undefined), "none");
	eq("secret ref: 命令", isSecretReference(" !echo key "), true);
	eq("secret ref: 环境变量", isSecretReference("$API_KEY"), true);
	eq("secret ref: 普通 key", isSecretReference("deadbeef"), false);
	eq("request key: ! 开头仍是 literal", literalApiKeyForRequest(" !literal-key "), "!literal-key");
	eq("request key: $ 开头仍是 literal", literalApiKeyForRequest("$literal-key"), "$literal-key");
	eq("request key: 空白为空", literalApiKeyForRequest("   "), null);
}

{
	// upsert: 新自定义渠道，保留未知字段
	const auth: PiAuthFile = {
		anthropic: { type: "oauth", access: "tok", refresh: "r", customField: 1 },
	};
	const models: PiModelsFile = {
		providers: {
			old: { baseUrl: "https://old.com/v1", api: "openai-completions", apiKey: "leak", models: [{ id: "a" }], futureField: "keep" },
		},
		topLevelFuture: "keep-me",
	};

	const result = upsertChannel(auth, models, {
		provider: "DeepSeek",
		isBuiltin: false,
		baseUrl: "https://api.deepseek.com/v1",
		protocol: "openai-completions",
		newApiKey: "sk-real",
		models: [
			{ id: "deepseek-chat", name: "deepseek-chat", contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text", "image"], selected: true, metaConfirmed: true } satisfies ModelDraft,
		],
	});

	eq("upsert: keychain 待写", result.keychainWrite, { account: "deepseek", secret: "sk-real" });
	eq("upsert: auth 新条目为引用", result.auth.deepseek, {
		type: "api_key",
		key: "!security find-generic-password -s pi-gui.channels -a deepseek -w",
	});
	eq("upsert: oauth 条目原样", result.auth.anthropic, auth.anthropic);
	const ds = result.models.providers?.deepseek;
	eq("upsert: models 条目（input 模态确认时才落盘）", ds, {
		baseUrl: "https://api.deepseek.com/v1",
		api: "openai-completions",
		models: [{ id: "deepseek-chat", name: "deepseek-chat", contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text", "image"] }],
	});
	check("upsert: 不写 apiKey", ds !== undefined && !("apiKey" in ds));
	eq("upsert: 其它 provider 未知字段保留", result.models.providers?.old?.futureField, "keep");
	eq("upsert: 顶层未知字段保留", result.models.topLevelFuture, "keep-me");

	// upsert: 未知元数据字段缺省不写入（MODEL-07：不落 128000/8192 与 input:["text"] 猜测值）
	const unknownMeta = upsertChannel({}, {}, {
		provider: "relay-x",
		isBuiltin: false,
		baseUrl: "https://r.example.com/v1",
		protocol: "openai-completions",
		newApiKey: null,
		models: [
			{ id: "m-unknown", name: "m-unknown", contextWindow: null, maxTokens: null, reasoning: null, input: null, selected: true, metaConfirmed: false } satisfies ModelDraft,
		],
	});
	eq("upsert: 未知元数据不落盘（含 input 缺省）", unknownMeta.models.providers?.["relay-x"]?.models, [
		{ id: "m-unknown", name: "m-unknown" },
	]);
	const unknownWithExtras = toModelEntry({
		id: "m-extra",
		name: "m-extra",
		contextWindow: null,
		maxTokens: null,
		reasoning: null,
		input: null,
		selected: true,
		metaConfirmed: false,
		extraFields: { cost: { input: 1 }, compat: { supportsTools: true } },
	});
	eq("persist: 未知元数据省略且 extraFields 保留", unknownWithExtras, {
		cost: { input: 1 },
		compat: { supportsTools: true },
		id: "m-extra",
		name: "m-extra",
	});
	const specialExtraFields = Object.fromEntries([
		["__proto__", { safe: "proto" }],
		["constructor", { safe: "constructor" }],
		["prototype", { safe: "prototype" }],
	]) as Record<string, unknown>;
	const specialExtrasEntry = toModelEntry({
		id: "m-special-extras",
		name: "m-special-extras",
		contextWindow: null,
		maxTokens: null,
		reasoning: null,
		input: null,
		selected: true,
		metaConfirmed: false,
		extraFields: specialExtraFields,
	});
	eq("persist: 特殊 extraFields 均作为 own property 往返", [
		Object.prototype.hasOwnProperty.call(specialExtrasEntry, "__proto__"),
		Object.prototype.hasOwnProperty.call(specialExtrasEntry, "constructor"),
		Object.prototype.hasOwnProperty.call(specialExtrasEntry, "prototype"),
		specialExtrasEntry.__proto__,
		specialExtrasEntry.constructor,
		specialExtrasEntry.prototype,
		Object.getPrototypeOf(specialExtrasEntry),
	], [
		true,
		true,
		true,
		{ safe: "proto" },
		{ safe: "constructor" },
		{ safe: "prototype" },
		Object.prototype,
	]);

	const textOnly = upsertChannel({}, {}, {
		provider: "relay-text",
		isBuiltin: false,
		baseUrl: "https://text.example.com/v1",
		protocol: "openai-completions",
		newApiKey: null,
		models: [
			{ id: "text-only", name: "text-only", contextWindow: 1, maxTokens: 1, reasoning: false, input: ["text"], selected: true, metaConfirmed: true } satisfies ModelDraft,
		],
	});
	eq("upsert: 明确仅文本写 input:[text]", textOnly.models.providers?.["relay-text"]?.models?.[0]?.input, ["text"]);
	eq("upsert: 明确图文写 input:[text,image]", ds?.models?.[0]?.input, ["text", "image"]);

	// upsert: 编辑时不给新 key → auth 不动（$ENV 保留）
	const envAuth: PiAuthFile = { deepseek: { type: "api_key", key: "$DEEPSEEK_API_KEY" } };
	const editKeep = upsertChannel(envAuth, {}, {
		provider: "deepseek",
		isBuiltin: false,
		baseUrl: "https://relay.internal/v1",
		protocol: "openai-completions",
		newApiKey: null,
	});
	eq("upsert: 无新 key 时 $ENV 原样", editKeep.auth.deepseek, envAuth.deepseek);
	eq("upsert: 无新 key 不写 keychain", editKeep.keychainWrite, null);

	// upsert: 内置渠道改中转 → 只写 baseUrl，不写 models/api
	const builtin = upsertChannel({}, {}, {
		provider: "anthropic",
		isBuiltin: true,
		baseUrl: "https://relay.example.com",
		presetDefaultBaseUrl: "https://api.anthropic.com",
		protocol: null,
		newApiKey: "sk-ant-new",
	});
	eq("upsert: 内置中转条目", builtin.models.providers?.anthropic, { baseUrl: "https://relay.example.com" });
	eq("upsert: 内置 auth 引用", (builtin.auth.anthropic as { key?: string }).key, buildKeychainRefCommand("anthropic"));

	// upsert: 内置渠道 baseUrl 与默认一致 → 不产生覆盖条目
	const builtinNoop = upsertChannel({}, {}, {
		provider: "anthropic",
		isBuiltin: true,
		baseUrl: "https://api.anthropic.com/",
		presetDefaultBaseUrl: "https://api.anthropic.com",
		protocol: null,
		newApiKey: null,
	});
	eq("upsert: 内置无覆盖", builtinNoop.models.providers, {});
}

{
	// upsert: models.json 遗留明文 apiKey → 迁移到 Keychain + auth.json !security 引用，
	// models.json 删除 apiKey，authHeader 等其它字段原样保留
	const migrated = upsertChannel({}, {
		providers: {
			"cc-pro-max": { baseUrl: "https://relay.example.com/v1", api: "anthropic-messages", apiKey: "sk-legacy", authHeader: true, models: [{ id: "m1" }] },
		},
	}, {
		provider: "cc-pro-max",
		isBuiltin: false,
		baseUrl: "https://relay.example.com/v1",
		protocol: "anthropic-messages",
		newApiKey: null,
	});
	eq("upsert: 迁移 keychain 待写", migrated.keychainWrite, { account: "cc-pro-max", secret: "sk-legacy" });
	eq("upsert: 迁移标记", migrated.migratedApiKey, true);
	eq("upsert: 迁移后 auth 为引用", migrated.auth["cc-pro-max"], {
		type: "api_key",
		key: buildKeychainRefCommand("cc-pro-max"),
	});
	const migratedEntry = migrated.models.providers?.["cc-pro-max"];
	check("upsert: 迁移后 models.json 不含 apiKey", migratedEntry !== undefined && !("apiKey" in migratedEntry));
	eq("upsert: 迁移保留 authHeader", migratedEntry?.authHeader, true);
	eq("upsert: 迁移保留 models", migratedEntry?.models, [{ id: "m1" }]);

	// models.json 里的动态引用不是 secret：迁到 auth.json 时必须保留引用，
	// 不能把命令文本原样塞进 Keychain（含中文时会被 security 十六进制化）。
	const commandRef = "!sqlite3 db \"SELECT 密钥\"";
	const migratedCommand = upsertChannel({}, {
		providers: {
			"cc-kiro-cache": {
				baseUrl: "https://k.example.com/v1",
				api: "anthropic-messages",
				apiKey: commandRef,
			},
		},
	}, {
		provider: "cc-kiro-cache",
		isBuiltin: false,
		baseUrl: "https://k.example.com/v1",
		protocol: "anthropic-messages",
		newApiKey: null,
	});
	eq("upsert: 命令引用不写 keychain", migratedCommand.keychainWrite, null);
	eq("upsert: 命令引用不冒充 keychain 迁移", migratedCommand.migratedApiKey, false);
	eq("upsert: 命令引用迁到 auth 原样保留", migratedCommand.auth["cc-kiro-cache"], {
		type: "api_key",
		key: commandRef,
	});
	check(
		"upsert: 命令引用从 models.json 删除",
		!("apiKey" in (migratedCommand.models.providers?.["cc-kiro-cache"] ?? {})),
	);

	const migratedEnv = upsertChannel({}, {
		providers: {
			deepseek: { baseUrl: "https://d.example.com/v1", apiKey: "$DEEPSEEK_API_KEY" },
		},
	}, {
		provider: "deepseek",
		isBuiltin: false,
		baseUrl: "https://d.example.com/v1",
		protocol: "openai-completions",
		newApiKey: null,
	});
	eq("upsert: 环境变量引用不写 keychain", migratedEnv.keychainWrite, null);
	eq("upsert: 环境变量引用不冒充 keychain 迁移", migratedEnv.migratedApiKey, false);
	eq("upsert: 环境变量引用迁到 auth 原样保留", migratedEnv.auth.deepseek, {
		type: "api_key",
		key: "$DEEPSEEK_API_KEY",
	});

	// upsert: 编辑保存（带勾选 models）时 authHeader 等既有字段原样保留，不静默删除
	const editedKeep = upsertChannel({}, {
		providers: {
			"cc-kiro-cache": { baseUrl: "https://k.example.com/api/claude_code/kiro", api: "anthropic-messages", authHeader: true, models: [{ id: "old" }] },
		},
	}, {
		provider: "cc-kiro-cache",
		isBuiltin: false,
		baseUrl: "https://k.example.com/api/claude_code/kiro",
		protocol: "anthropic-messages",
		newApiKey: null,
		models: [
			{ id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"], selected: true, metaConfirmed: true, origin: "saved", seenInFetch: false, extraFields: { cost: { input: 5 } } } satisfies ModelDraft,
		],
	});
	const editedEntry = editedKeep.models.providers?.["cc-kiro-cache"];
	eq("upsert: 保存保留 authHeader", editedEntry?.authHeader, true);
	eq("upsert: 保存写回 extraFields 且不写来源字段", editedEntry?.models, [
		{ cost: { input: 5 }, id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
	]);

	// upsert: auth.json 已有可用 key 时不迁移（不改变生效 key），仅清掉 models.json 的 apiKey
	const envFirst = upsertChannel({ "cc-kiro-cache": { type: "api_key", key: "$CC_KIRO_KEY" } }, {
		providers: { "cc-kiro-cache": { baseUrl: "https://k.example.com/v1", apiKey: "sk-shadow" } },
	}, {
		provider: "cc-kiro-cache",
		isBuiltin: false,
		baseUrl: "https://k.example.com/v1",
		protocol: "openai-completions",
		newApiKey: null,
	});
	eq("upsert: 已有 auth key 不写 keychain", envFirst.keychainWrite, null);
	eq("upsert: 已有 auth key 不迁移", envFirst.migratedApiKey, false);
	eq("upsert: 已有 auth key 原样", envFirst.auth["cc-kiro-cache"], { type: "api_key", key: "$CC_KIRO_KEY" });
	check("upsert: 已有 auth key 也清掉 models.json apiKey", !("apiKey" in (envFirst.models.providers?.["cc-kiro-cache"] ?? {})));

	// upsert: 用户输入新 key 时以新 key 为准，models.json 旧 apiKey 一并清掉
	const newKeyWins = upsertChannel({}, {
		providers: { "cc-pro-max": { baseUrl: "https://r.example.com/v1", apiKey: "sk-old" } },
	}, {
		provider: "cc-pro-max",
		isBuiltin: false,
		baseUrl: "https://r.example.com/v1",
		protocol: "openai-completions",
		newApiKey: "sk-new",
	});
	eq("upsert: 新 key 优先", newKeyWins.keychainWrite, { account: "cc-pro-max", secret: "sk-new" });
	eq("upsert: 新 key 不算迁移", newKeyWins.migratedApiKey, false);
	check("upsert: 新 key 时旧 apiKey 删除", !("apiKey" in (newKeyWins.models.providers?.["cc-pro-max"] ?? {})));

	// upsert: 内置渠道 models.json 遗留 apiKey 同样迁移并删除
	const builtinLegacy = upsertChannel({}, {
		providers: { anthropic: { baseUrl: "https://relay.example.com", apiKey: "sk-ant-legacy" } },
	}, {
		provider: "anthropic",
		isBuiltin: true,
		baseUrl: "https://relay.example.com",
		presetDefaultBaseUrl: "https://api.anthropic.com",
		protocol: null,
		newApiKey: null,
	});
	eq("upsert: 内置迁移 keychain", builtinLegacy.keychainWrite, { account: "anthropic", secret: "sk-ant-legacy" });
	eq("upsert: 内置迁移标记", builtinLegacy.migratedApiKey, true);
	eq("upsert: 内置迁移后条目只剩 baseUrl", builtinLegacy.models.providers?.anthropic, { baseUrl: "https://relay.example.com" });

	// upsert: 内置条目仅含 apiKey 时，迁移后整个 models.json 条目删除
	const builtinOnlyKey = upsertChannel({}, {
		providers: { anthropic: { apiKey: "sk-ant-only" } },
	}, {
		provider: "anthropic",
		isBuiltin: true,
		baseUrl: "",
		presetDefaultBaseUrl: "https://api.anthropic.com",
		protocol: null,
		newApiKey: null,
	});
	eq("upsert: 内置仅 apiKey 条目迁移后整体删除", builtinOnlyKey.models.providers, {});
	eq("upsert: 内置仅 apiKey 迁移 keychain", builtinOnlyKey.keychainWrite, { account: "anthropic", secret: "sk-ant-only" });
}

{
	// buildChannelSaveOps：upsert 全量结果 → entry 级 patch 操作（save_channel_config 事务契约）
	const prevAuth: PiAuthFile = { deepseek: { type: "api_key", key: "$DS" } };
	const prevModels: PiModelsFile = { providers: { deepseek: { baseUrl: "https://old/v1" } } };

	// 编辑 + 新 key：auth set（!security 引用）/ models set
	const edited = upsertChannel(prevAuth, prevModels, {
		provider: "deepseek",
		isBuiltin: false,
		baseUrl: "https://new/v1",
		protocol: "openai-completions",
		newApiKey: "sk-new",
	});
	const opsEdit = buildChannelSaveOps(prevAuth, prevModels, "deepseek", edited);
	eq("saveOps: 编辑 auth set", opsEdit.authEntry, {
		kind: "set",
		entry: { type: "api_key", key: buildKeychainRefCommand("deepseek") },
	});
	eq("saveOps: 编辑 models set", opsEdit.modelsEntry.kind, "set");

	// 内置渠道 baseUrl 与默认一致（无覆盖条目）：旧条目在 → delete；不在 → none
	const builtinNoop = upsertChannel({}, {}, {
		provider: "anthropic",
		isBuiltin: true,
		baseUrl: "https://api.anthropic.com/",
		presetDefaultBaseUrl: "https://api.anthropic.com",
		protocol: null,
		newApiKey: null,
	});
	const prevWithBuiltin: PiModelsFile = { providers: { anthropic: { baseUrl: "https://relay.example.com" } } };
	eq(
		"saveOps: 内置撤掉既有覆盖 → models delete",
		buildChannelSaveOps({}, prevWithBuiltin, "anthropic", builtinNoop).modelsEntry,
		{ kind: "delete" },
	);
	eq(
		"saveOps: 内置本就无覆盖 → models none",
		buildChannelSaveOps({}, {}, "anthropic", builtinNoop).modelsEntry,
		{ kind: "none" },
	);
	eq(
		"saveOps: 无 auth 改动 → auth none",
		buildChannelSaveOps({}, {}, "anthropic", builtinNoop).authEntry,
		{ kind: "none" },
	);

	// 防御路径：结果缺失而旧状态有 → delete（upsert 目前不产生 auth 删除，契约保留）
	const fakeResult = { auth: {}, models: { providers: {} }, keychainWrite: null, migratedApiKey: false };
	const opsDelete = buildChannelSaveOps(prevAuth, prevModels, "deepseek", fakeResult);
	eq("saveOps: auth delete", opsDelete.authEntry, { kind: "delete" });
	eq("saveOps: models delete", opsDelete.modelsEntry, { kind: "delete" });
}

{
	// remove
	const auth: PiAuthFile = {
		deepseek: { type: "api_key", key: buildKeychainRefCommand("deepseek") },
		anthropic: { type: "oauth", access: "tok" },
	};
	const models: PiModelsFile = { providers: { deepseek: { baseUrl: "https://x/v1" }, other: { baseUrl: "https://y/v1" } } };
	const removed = removeChannel(auth, models, "deepseek");
	eq("remove: auth 删除", Object.keys(removed.auth), ["anthropic"]);
	eq("remove: models 删除", Object.keys(removed.models.providers ?? {}), ["other"]);
	eq("remove: keychain 待删", removed.keychainAccountToDelete, "deepseek");
}

{
	// duplicate
	const auth: PiAuthFile = {
		deepseek: { type: "api_key", key: buildKeychainRefCommand("deepseek") },
		anthropic: { type: "oauth", access: "tok" },
	};
	const models: PiModelsFile = { providers: { deepseek: { baseUrl: "https://x/v1", models: [{ id: "m" }] } } };
	const meta = emptyChannelsMeta();
	meta.channels.deepseek = { note: "n", icon: "🐳", alias: "DS" };

	const dup = duplicateChannel(auth, models, meta, "deepseek", "DeepSeek Copy");
	check("duplicate: 允许", dup.canDuplicate);
	check("duplicate: 源是 keychain", dup.sourceKeyRefKind === "keychain" && dup.sourceKeychainAccount === "deepseek");
	eq("duplicate: models 深拷贝", dup.models.providers?.["deepseek-copy"], models.providers?.deepseek);
	eq("duplicate: meta 复制且清 alias", dup.meta.channels["deepseek-copy"], { note: "n", icon: "🐳", alias: undefined });

	const dupOauth = duplicateChannel(auth, models, meta, "anthropic", "x");
	eq("duplicate: oauth 拒绝", dupOauth.canDuplicate, false);
}

{
	// deriveChannels 合并视图
	const auth: PiAuthFile = {
		anthropic: { type: "api_key", key: buildKeychainRefCommand("anthropic") },
		deepseek: { type: "api_key", key: "$DS" },
		openai: { type: "oauth", access: "tok" },
	};
	const models: PiModelsFile = {
		providers: {
			anthropic: { baseUrl: "https://relay.example.com" },
			deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", models: [{ id: "deepseek-chat" }] },
		},
	};
	const meta = emptyChannelsMeta();
	meta.channels.deepseek = { alias: "深度求索", note: "主力", icon: "🐳", modelsTotal: 5 };
	const settings = { defaultProvider: "deepseek", defaultModel: "deepseek-chat", otherSetting: true };

	const list = deriveChannels(auth, models, meta, settings);
	const byProvider = new Map(list.map((c) => [c.provider, c]));

	const anthropic = byProvider.get("anthropic");
	eq("derive: 内置标记", anthropic?.isBuiltin, true);
	eq("derive: 中转覆盖生效", anthropic?.baseUrl, "https://relay.example.com");
	eq("derive: 内置协议来自预设", anthropic?.protocol, "anthropic-messages");
	eq("derive: keychain 标记", anthropic?.keyRefKind, "keychain");
	eq("derive: 无运行时数据时 runtimeModelCount 为 null", anthropic?.runtimeModelCount, null);
	eq("derive: 无发现记录时 modelsTotal 为 null", anthropic?.modelsTotal, null);

	const deepseek = byProvider.get("deepseek");
	eq("derive: 别名", deepseek?.displayName, "深度求索");
	eq("derive: 使用中标记", [deepseek?.isDefault, deepseek?.defaultModel], [true, "deepseek-chat"]);
	eq("derive: 模型数", deepseek?.modelCount, 1);
	eq("derive: 远端发现总数", deepseek?.modelsTotal, 5);
	eq("derive: env 标记", deepseek?.keyRefKind, "env");

	meta.channels.openai = { modelsTotal: 0 };
	const zeroTotal = deriveChannels(auth, models, meta, settings).find((c) => c.provider === "openai");
	eq("derive: 拉取到 0 个与未拉取(null)严格区分", zeroTotal?.modelsTotal, 0);

	// MODEL-04：运行时模型数透传（卡片「已启用 N」数据源）
	const withRuntime = deriveChannels(auth, models, meta, settings, { anthropic: 33 });
	eq("derive: 运行时模型数透传", withRuntime.find((c) => c.provider === "anthropic")?.runtimeModelCount, 33);
	eq("derive: 未统计 provider 运行时数为 0", withRuntime.find((c) => c.provider === "deepseek")?.runtimeModelCount, 0);

	const openai = byProvider.get("openai");
	eq("derive: oauth 类型", [openai?.authKind, openai?.keyRefKind], ["oauth", "oauth"]);
	eq("derive: 内置默认 baseUrl", openai?.baseUrl, "https://api.openai.com/v1");

	// models.json 直接带 apiKey（auth.json 无条目）视为已配置密钥
	const legacyList = deriveChannels({}, {
		providers: {
			"cc-pro-max": { baseUrl: "https://relay.example.com/v1", api: "anthropic-messages", apiKey: "sk-legacy", models: [{ id: "m1" }] },
			"cc-blank-key": { baseUrl: "https://x.example.com/v1", apiKey: "   " },
		},
	}, emptyChannelsMeta(), {});
	const legacyByProvider = new Map(legacyList.map((c) => [c.provider, c]));
	eq("derive: models.json apiKey 视为已配置", legacyByProvider.get("cc-pro-max")?.keyRefKind, "modelsJson");
	eq("derive: 空白 apiKey 不算已配置", legacyByProvider.get("cc-blank-key")?.keyRefKind, "none");

	// applySetDefault 保留其它设置
	const next = applySetDefault(settings, "anthropic", "claude-sonnet-4-5");
	eq("setDefault: 写入", [next.defaultProvider, next.defaultModel], ["anthropic", "claude-sonnet-4-5"]);
	eq("setDefault: 保留其它键", next.otherSetting, true);

	eq("preset: builtin 反查", findPresetByBuiltinProvider("kimi-coding")?.label, "Kimi For Coding");
	eq("preset: 非内置", findPresetByBuiltinProvider("deepseek"), null);
}

// ---------------------------------------------------------------------------
// 内置/OAuth 渠道模型范围 → enabledModels（mergeProviderModelScope）
// ---------------------------------------------------------------------------

{
	// pi 对内置 provider 的 models 数组是 merge-by-id（内置模型无法被勾选子集禁用），
	// 模型范围只能走 settings.json 的 enabledModels（格式同 --models flag）。
	const known = [
		{ provider: "anthropic", id: "claude-opus-4-6" },
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "openai", id: "gpt-5.4" },
		{ provider: "openai", id: "gpt-4o" },
	];

	// 当前无过滤 + 子集：其它渠道物化为 provider/*（保持默认全量），本渠道写精确子集
	const subset = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-sonnet-4-5"],
		allKnownModels: known,
		existingPatterns: undefined,
	});
	eq("scope: 无过滤写子集并物化其它渠道", subset, { patterns: ["openai/*", "anthropic/claude-sonnet-4-5"] });

	const subsetWithUndiscoveredProvider = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-sonnet-4-5"],
		allKnownModels: known,
		allKnownProviders: ["anthropic", "openai", "zai"],
		existingPatterns: undefined,
	});
	eq("scope: 未发现模型但已配置的 provider 仍物化", subsetWithUndiscoveredProvider, {
		patterns: ["openai/*", "zai/*", "anthropic/claude-sonnet-4-5"],
	});

	// 当前无过滤 + 全选：无需写入（本来就无覆盖）
	const fullNoFilter = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		allKnownModels: known,
		existingPatterns: undefined,
	});
	eq("scope: 无过滤全选不写入", fullNoFilter, {});

	// 有覆盖 + 子集：移除本 provider 旧条目，保留其它渠道，追加新子集
	const subsetExisting = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-opus-4-6"],
		allKnownModels: known,
		existingPatterns: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
	});
	eq("scope: 子集替换本渠道旧条目", subsetExisting, {
		patterns: ["openai/gpt-4o", "anthropic/claude-opus-4-6"],
	});

	// 有覆盖 + 全选：移除本渠道覆盖；没有遗留 pattern 时删除 enabledModels（恢复默认全量）
	const cleared = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		allKnownModels: known,
		existingPatterns: ["anthropic/claude-opus-4-6"],
	});
	eq("scope: 全选且无遗留则删除覆盖", cleared, {});
	const clearedKeepOthers = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		allKnownModels: known,
		existingPatterns: ["anthropic/claude-opus-4-6", "openai/*"],
	});
	eq("scope: 全选保留其它渠道 pattern", clearedKeepOthers, { patterns: ["openai/*"] });

	// glob：命中本 provider 的展开剔除；不命中的原样保留；未知手写精确条目不吞
	const globs = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-sonnet-4-5"],
		allKnownModels: known,
		existingPatterns: ["anthropic/claude-*", "gpt-*", "anthropic/future-model"],
	});
	eq("scope: glob 命中展开/未命中保留/未知保留", globs, {
		patterns: ["gpt-*", "anthropic/future-model", "anthropic/claude-sonnet-4-5"],
	});

	// 跨 provider glob：展开为其它渠道命中项的精确条目（既不吞其它渠道，也不继续覆盖本渠道）
	const crossGlob = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-sonnet-4-5"],
		selectedIds: [],
		allKnownModels: [...known, { provider: "bedrock", id: "us.claude-sonnet-4" }],
		existingPatterns: ["*sonnet*"],
	});
	eq("scope: 跨 provider glob 展开", crossGlob, { patterns: ["bedrock/us.claude-sonnet-4"] });

	check(
		"scope: minimatch 字符类 + thinking suffix",
		modelMatchesScopePattern(
			"anthropic/claude-[os]*:high",
			{ provider: "anthropic", id: "claude-opus-4-6" },
			known,
		),
	);
	const thinkingGlob = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-sonnet-4-5"],
		allKnownModels: known,
		existingPatterns: ["*:high"],
	});
	eq("scope: glob 展开保留 thinking suffix 且不残留启用目标 provider", thinkingGlob, {
		patterns: ["openai/gpt-5.4:high", "openai/gpt-4o:high", "anthropic/claude-sonnet-4-5"],
	});
	const exactThinking = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-sonnet-4-5"],
		allKnownModels: known,
		existingPatterns: ["anthropic/claude-opus-4-6:high", "openai/gpt-4o:low"],
	});
	eq("scope: 精确 thinking suffix 旧规则被目标子集替换", exactThinking, {
		patterns: ["openai/gpt-4o:low", "anthropic/claude-sonnet-4-5"],
	});

	// `max` 是 pi 的合法档位（VALID_THINKING_LEVELS 共 7 项）。漏了它的话
	// `*:max` 里的 `:max` 不会被识别为 suffix，glob 就匹配不到任何模型，
	// 于是该规则被原封保留而不展开——与 pi 的 parseModelPattern 行为不一致。
	const maxThinkingGlob = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
		selectedIds: ["claude-sonnet-4-5"],
		allKnownModels: known,
		existingPatterns: ["*:max"],
	});
	eq("scope: max 后缀的 glob 与 xhigh 同样展开", maxThinkingGlob, {
		patterns: ["openai/gpt-5.4:max", "openai/gpt-4o:max", "anthropic/claude-sonnet-4-5"],
	});

	// 裸 id：唯一归属本 provider 时移除，归属其它 provider 时保留
	const bare = mergeProviderModelScope({
		provider: "anthropic",
		providerModelIds: ["claude-opus-4-6"],
		selectedIds: ["claude-opus-4-6"],
		allKnownModels: known,
		existingPatterns: ["claude-opus-4-6", "gpt-4o"],
	});
	eq("scope: 裸 id 归属判定", bare, { patterns: ["gpt-4o"] });
}

// ---------------------------------------------------------------------------
// 渠道领域命令 payload：新增/编辑、删除、复制、OAuth scope、默认模型
// ---------------------------------------------------------------------------

{
	const paths = {
		authPath: "/tmp/auth.json",
		modelsPath: "/tmp/models.json",
		metaPath: "/tmp/channels-meta.json",
		settingsPath: "/tmp/settings.json",
	};
	const upsertPayload = buildUpsertTransactionPayload(
		paths,
		"deepseek",
		{
			authEntry: { kind: "set", entry: { type: "api_key", key: "$DS" } },
			modelsEntry: { kind: "set", entry: { baseUrl: "https://api.deepseek.com/v1" } },
		},
		{ alias: "DeepSeek" },
		null,
	);
	eq("payload: 新增/编辑仍走 save_channel_config 全事务", [
		upsertPayload.authEntry.kind,
		upsertPayload.modelsEntry.kind,
		upsertPayload.meta.kind,
		upsertPayload.keychain.kind,
	], ["set", "set", "set", "none"]);

	const deletePayload = buildDeleteTransactionPayload(paths, "deepseek", "deepseek");
	eq("payload: 删除一次提交四个目标", [
		deletePayload.authEntry.kind,
		deletePayload.modelsEntry.kind,
		deletePayload.meta.kind,
		deletePayload.keychain.kind,
	], ["delete", "delete", "delete", "delete"]);

	const duplicatePayload = buildDuplicateTransactionPayload(
		paths,
		"deepseek-copy",
		{ type: "api_key", key: buildKeychainRefCommand("deepseek-copy") },
		{ baseUrl: "https://api.deepseek.com/v1" },
		{ alias: "DeepSeek 副本" },
		{ account: "deepseek-copy", secret: "sk-copy" },
	);
	eq("payload: 复制一次提交且密钥最后由后端写", [
		duplicatePayload.authEntry.kind,
		duplicatePayload.modelsEntry.kind,
		duplicatePayload.meta.kind,
		duplicatePayload.keychain.kind,
	], ["set", "set", "set", "write"]);

	const oauthPayload = buildSettingsTransactionPayload(paths, "anthropic", {
		set: { enabledModels: ["openai/*", "anthropic/claude-sonnet-4-5"] },
	});
	eq("payload: OAuth scope 只提交 settings patch", oauthPayload.settings, {
		set: { enabledModels: ["openai/*", "anthropic/claude-sonnet-4-5"] },
	});
	eq("payload: OAuth scope 不碰渠道其它目标", [
		oauthPayload.authEntry.kind,
		oauthPayload.modelsEntry.kind,
		oauthPayload.meta.kind,
		oauthPayload.keychain.kind,
	], ["none", "none", "none", "none"]);

	let rejectedEmptyScope = false;
	try {
		buildEnabledModelsTransactionPayload(paths, "global-model-scope", []);
	} catch {
		rejectedEmptyScope = true;
	}
	check("payload: 空模型范围不可保存且不会下发 enabledModels:[]", rejectedEmptyScope);
	const globalScopeClearPayload = buildEnabledModelsTransactionPayload(
		paths,
		"global-model-scope",
		undefined,
	);
	eq("payload: 全局模型范围全选时只 delete enabledModels", globalScopeClearPayload.settings, {
		delete: ["enabledModels"],
	});

	const defaultPayload = buildSettingsTransactionPayload(paths, "anthropic", {
		set: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-6" },
	});
	eq("payload: 默认模型只提交两个 settings 根键", defaultPayload.settings, {
		set: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-6" },
	});

	eq(
		"transaction error: commit_uncertain JSON 保留 code/message/journal",
		parseChannelTransactionError(
			'{"code":"commit_uncertain","message":"fsync failed","journalPath":"/tmp/journal.json"}',
		),
		{ code: "commit_uncertain", message: "fsync failed", journalPath: "/tmp/journal.json" },
	);
	eq(
		"transaction error: committed_after_error JSON",
		parseChannelTransactionError('{"code":"committed_after_error","message":"cleanup failed"}'),
		{ code: "committed_after_error", message: "cleanup failed", journalPath: "" },
	);
	eq(
		"transaction error: transaction_locked JSON",
		parseChannelTransactionError('{"code":"transaction_locked","message":"busy"}'),
		{ code: "transaction_locked", message: "busy", journalPath: "" },
	);
	eq(
		"transaction error: 非 JSON 原文回退",
		parseChannelTransactionError(new Error("invoke failed")),
		{ code: "", message: "invoke failed", journalPath: "" },
	);
}

// ---------------------------------------------------------------------------

console.log(`channels selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
