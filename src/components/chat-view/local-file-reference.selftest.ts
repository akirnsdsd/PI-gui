/**
 * local-file-reference 纯函数回归测试。
 *
 * 运行：
 * npx esbuild src/components/chat-view/local-file-reference.selftest.ts \
 *   --bundle --platform=node --format=esm \
 *   --outfile=node_modules/.cache/local-file-reference-selftest.mjs
 * node node_modules/.cache/local-file-reference-selftest.mjs
 */
import { resolveProjectFileReference } from "./local-file-reference.js";

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
	if (actual === expected) {
		passed += 1;
		return;
	}
	failed += 1;
	console.error(`FAIL: ${name}`, { actual, expected });
}

const projectRoot = "/Users/demo/Projects/PI-gui";

eq(
	"解析中文项目相对路径",
	resolveProjectFileReference(projectRoot, "docs/示例知识图谱.html"),
	"/Users/demo/Projects/PI-gui/docs/示例知识图谱.html",
);

eq(
	"接受项目目录内的绝对路径",
	resolveProjectFileReference(projectRoot, "/Users/demo/Projects/PI-gui/src/main.ts"),
	"/Users/demo/Projects/PI-gui/src/main.ts",
);

eq(
	"拒绝通过 ../ 越出项目目录",
	resolveProjectFileReference(projectRoot, "../secret.txt"),
	null,
);

eq(
	"拒绝外部 URL scheme",
	resolveProjectFileReference(projectRoot, "https://example.com/file.html"),
	null,
);

eq(
	"移除 Markdown #L 行号提示后解析文件",
	resolveProjectFileReference(projectRoot, "src/main.ts#L42-L51"),
	"/Users/demo/Projects/PI-gui/src/main.ts",
);

eq(
	"移除冒号行列提示后解析文件",
	resolveProjectFileReference(projectRoot, "src/main.ts:42:7"),
	"/Users/demo/Projects/PI-gui/src/main.ts",
);

if (failed > 0) {
	console.error(`local-file-reference selftest: ${passed} passed, ${failed} failed`);
	throw new Error(`${failed} assertion(s) failed`);
} else {
	console.log(`local-file-reference selftest: ${passed} passed, 0 failed`);
}
