export function isImageName(name: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(name.toLowerCase());
}

export function mimeFromFileName(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".bmp")) return "image/bmp";
	if (lower.endsWith(".svg")) return "image/svg+xml";
	if (lower.endsWith(".avif")) return "image/avif";
	if (lower.endsWith(".heic")) return "image/heic";
	if (lower.endsWith(".heif")) return "image/heif";
	return "image/png";
}

export function toBase64Bytes(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

/** toBase64Bytes 的逆操作：分块解码，避免大字符串展开参数超限。 */
export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/** 从 data URL（data:<mime>;base64,<data>）中取出 base64 数据；非 data URL 返回 null。 */
export function base64FromDataUrl(src: string): string | null {
	const match = /^data:[^,]*;base64,(.*)$/is.exec(src.trim());
	return match && match[1] ? match[1] : null;
}

export function isImageFile(file: File): boolean {
	if (file.type.startsWith("image/")) return true;
	return isImageName(file.name || "");
}

export function fileNameFromPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").trim();
	const parts = normalized.split("/");
	return parts[parts.length - 1] || normalized;
}

export function createDropSignature(names: string[]): string {
	return names
		.map((name) => name.trim().toLowerCase())
		.filter(Boolean)
		.sort()
		.join("|");
}

export function extractFilePathsFromDropPayload(raw: string): string[] {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	const paths: string[] = [];
	for (const line of lines) {
		if (line.startsWith("file://")) {
			try {
				const url = new URL(line);
				let path = decodeURIComponent(url.pathname || "");
				if (/^\/[A-Za-z]:\//.test(path)) {
					path = path.slice(1);
				}
				if (path) paths.push(path);
				continue;
			} catch {
				// ignore invalid url
			}
		}
		if (line.startsWith("/") || /^[A-Za-z]:[\\/]/.test(line)) {
			paths.push(line);
		}
	}
	return paths;
}
