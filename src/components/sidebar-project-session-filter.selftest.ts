import { sessionBelongsToProject } from "./sidebar.js";

const cases: Array<{ name: string; actual: boolean; expected: boolean }> = [
	{
		name: "exact cwd belongs to project",
		actual: sessionBelongsToProject("/tmp/Desktop", "/tmp/Desktop"),
		expected: true,
	},
	{
		name: "nested project does not belong to parent",
		actual: sessionBelongsToProject("/tmp/Desktop/PI-gui", "/tmp/Desktop"),
		expected: false,
	},
	{
		name: "missing cwd is not guessed from session path",
		actual: sessionBelongsToProject(null, "/tmp/Desktop"),
		expected: false,
	},
	{
		name: "project name substring does not match",
		actual: sessionBelongsToProject("/tmp/Elsewhere/Desktop-notes", "/tmp/Desktop"),
		expected: false,
	},
	{
		name: "case-distinct paths do not merge on case-sensitive filesystems",
		actual: sessionBelongsToProject("/tmp/Projects/Foo", "/tmp/Projects/foo"),
		expected: false,
	},
];

let failed = 0;
for (const testCase of cases) {
	if (testCase.actual !== testCase.expected) {
		failed += 1;
		console.error(`FAIL ${testCase.name}: expected ${testCase.expected}, got ${testCase.actual}`);
	} else {
		console.log(`PASS ${testCase.name}`);
	}
}

if (failed > 0) {
	throw new Error(`${failed} sidebar project/session filter tests failed`);
}

console.log(`${cases.length} passed, 0 failed`);
