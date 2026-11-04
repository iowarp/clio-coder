import assert from "node:assert/strict";
import { it } from "node:test";
import { repairReadRoots } from "../../src/cli/wiki-generate.js";
import { DISPATCH_INTENT_PATH_LIST_CAP, declaredScopeIntent } from "../../src/domains/dispatch/index.js";

const page = ".clio-coder/wiki/tests.md";

it("names each source when the list fits the intent cap", () => {
	assert.deepEqual(repairReadRoots(page, ["src/a.ts", "src/a.ts", "tests/b.ts"]), [page, "src/a.ts", "tests/b.ts"]);
});

it("widens the deepest sources to directories when a broad page exceeds the cap", () => {
	const sources = Array.from({ length: 40 }, (_, index) => `tests/contracts/case-${index}.test.ts`);
	const roots = repairReadRoots(page, [...sources, "package.json"]);
	assert.deepEqual(roots, [page, "tests/contracts/", "package.json"]);
	assert.equal(declaredScopeIntent({ readRoots: roots, writeRoots: [page] }).ok, true);
});

it("stays within the cap and never reads the whole tree while a directory can hold the sources", () => {
	const sources = Array.from({ length: 200 }, (_, index) => `src/area-${index % 50}/deep/file-${index}.ts`);
	const roots = repairReadRoots(page, sources);
	assert.ok(roots.length <= DISPATCH_INTENT_PATH_LIST_CAP);
	assert.equal(roots.includes("."), false);
	assert.deepEqual(roots, [page, "src/"]);
});

it("falls back to the repository root only for more top-level sources than the cap", () => {
	const sources = Array.from({ length: DISPATCH_INTENT_PATH_LIST_CAP + 1 }, (_, index) => `file-${index}.md`);
	assert.deepEqual(repairReadRoots(page, sources), [page, "."]);
});
