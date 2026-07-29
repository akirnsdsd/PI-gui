const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function safelyDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function normalizeSlashPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function normalizeAbsolutePath(value: string): string | null {
	const normalized = normalizeSlashPath(value.trim());
	const drive = normalized.match(/^([A-Za-z]:)(\/.*)?$/);
	const prefix = drive ? `${drive[1]}/` : normalized.startsWith("/") ? "/" : "";
	if (!prefix) return null;
	const body = drive ? (drive[2] ?? "/").slice(1) : normalized.slice(1);
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `${prefix}${parts.join("/")}`.replace(/\/$/, "") || prefix;
}

function stripLineHint(value: string): string {
	return value
		.replace(/#L\d+(?:-L?\d+)?$/i, "")
		.replace(/:(\d+)(?::\d+)?$/, "");
}

export function extractLocalFileReferenceFromClick(event: Event): string | null {
	const path = typeof event.composedPath === "function" ? event.composedPath() : [];
	const element = path.find((entry): entry is HTMLElement => entry instanceof HTMLElement);
	if (!element) return null;
	const anchor = element.closest("a");
	if (anchor) {
		const href = anchor.getAttribute("href")?.trim() ?? "";
		if (!href || href.startsWith("#") || href.startsWith("//") || EXTERNAL_SCHEME_RE.test(href)) return null;
		return safelyDecode(href);
	}
	const code = element.closest("code");
	if (!code || code.closest("pre")) return null;
	const candidate = code.textContent?.trim() ?? "";
	if (!candidate || candidate.includes("\n") || candidate.includes("\0")) return null;
	if (!candidate.includes("/") && !candidate.includes("\\") && !/\.[A-Za-z0-9]{1,12}(?::\d+)?$/.test(candidate)) return null;
	return candidate;
}

export function resolveProjectFileReference(projectRoot: string, reference: string): string | null {
	const root = normalizeAbsolutePath(projectRoot);
	if (!root) return null;
	let raw = safelyDecode(stripLineHint(reference.trim()));
	if (!raw || raw.includes("\0") || raw.startsWith("#") || raw.startsWith("//")) return null;
	if (/^file:/i.test(raw)) {
		raw = safelyDecode(raw.replace(/^file:\/\//i, ""));
	} else if (EXTERNAL_SCHEME_RE.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
		return null;
	}
	const absoluteCandidate = normalizeAbsolutePath(raw);
	const candidate = absoluteCandidate ?? normalizeAbsolutePath(`${root}/${raw}`);
	if (!candidate) return null;
	const rootKey = root.toLowerCase();
	const candidateKey = candidate.toLowerCase();
	if (candidateKey !== rootKey && !candidateKey.startsWith(`${rootKey}/`)) return null;
	return candidate;
}
