/**
 * SSRF 防护：自定义 baseUrl 校验。
 *
 * 规则（PRD 4.2.5）：
 * - 默认仅允许 HTTPS；
 * - HTTP 仅限 localhost / 127.0.0.1 / [::1]，且需用户显式勾选「我了解风险」；
 * - 指向内网段 / 云 metadata 地址的 URL 给出警告（不拦截，用户自行判断）。
 */

export type BaseUrlErrorCode =
	| "empty"
	| "invalid"
	| "insecure_http"
	| "http_not_localhost";

export interface BaseUrlCheck {
	ok: boolean;
	/** 归一化后的 URL（去掉末尾多余斜杠）。 */
	normalized?: string;
	errorCode?: BaseUrlErrorCode;
	/** 命中内网 / metadata 地址时的警告（https 也会给）。 */
	warning?: "private_network" | "metadata_endpoint";
}

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isPrivateIpv4(hostname: string): boolean {
	const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 等保留段
	return false;
}

function isPrivateIpv6(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "::1") return false; // localhost 单独处理
	return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80"); // ULA / link-local
}

function isMetadataHost(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "169.254.169.254") return true; // AWS/GCP/Azure metadata
	if (h === "metadata.google.internal") return true;
	if (h.startsWith("169.254.")) return true; // link-local 整段
	return false;
}

/**
 * 校验并归一化 baseUrl。
 * @param allowInsecureHttp 用户已勾选「我了解风险」时才放行 http+localhost。
 */
export function validateBaseUrl(raw: string, allowInsecureHttp: boolean): BaseUrlCheck {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, errorCode: "empty" };

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, errorCode: "invalid" };
	}

	const hostname = url.hostname.toLowerCase();
	const isLocalhost = LOCALHOST_NAMES.has(hostname) || LOCALHOST_NAMES.has(url.host.toLowerCase());

	if (url.protocol === "http:") {
		if (!isLocalhost) return { ok: false, errorCode: "http_not_localhost" };
		if (!allowInsecureHttp) return { ok: false, errorCode: "insecure_http" };
	} else if (url.protocol !== "https:") {
		return { ok: false, errorCode: "invalid" };
	}

	let warning: BaseUrlCheck["warning"];
	if (isMetadataHost(hostname)) {
		warning = "metadata_endpoint";
	} else if (!isLocalhost && (isPrivateIpv4(hostname) || isPrivateIpv6(hostname))) {
		warning = "private_network";
	}

	// 归一化：协议://host[:port]/path（去掉末尾斜杠），丢弃 query/hash。
	const path = url.pathname.replace(/\/+$/, "");
	const normalized = `${url.protocol}//${url.host}${path}`;
	return { ok: true, normalized, warning };
}

/** baseUrl + 子路径拼接（"/models"），双斜杠去重。 */
export function joinUrl(baseUrl: string, suffix: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	const tail = suffix.replace(/^\/+/, "");
	return `${base}/${tail}`;
}
