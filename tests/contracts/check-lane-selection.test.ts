import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { directImports, formatOpenapi, selectLaneTests } from "../../scripts/check-lane.mjs";

test("check:lane selects changed tests and direct importers, and flags an added test no gate lists", () => {
	const importsOf = new Map([
		[
			"tests/extended/context-map-freshness.test.ts",
			directImports(
				"tests/extended/context-map-freshness.test.ts",
				'import { x } from "../../src/core/workspace-files.js";',
			),
		],
		["tests/contracts/unrelated.test.ts", ["src/core/other.ts"]],
		["tests/contracts/new-thing.test.ts", []],
		["tests/contracts/listed.test.ts", []],
		["tests/extended/full-only.test.ts", []],
	]);
	const selection = selectLaneTests({
		changed: [
			"src/core/workspace-files.ts",
			"tests/contracts/new-thing.test.ts",
			"tests/contracts/listed.test.ts",
			"tests/extended/full-only.test.ts",
		],
		added: ["tests/contracts/new-thing.test.ts", "tests/contracts/listed.test.ts", "tests/extended/full-only.test.ts"],
		importsOf,
		lists: { coreTests: ["tests/contracts/listed.test.ts"], guiTests: [], packageTests: [] },
	});
	deepStrictEqual(selection, {
		affected: [
			"tests/contracts/listed.test.ts",
			"tests/contracts/new-thing.test.ts",
			"tests/extended/context-map-freshness.test.ts",
			"tests/extended/full-only.test.ts",
		],
		unlisted: ["tests/contracts/new-thing.test.ts"],
	});
});

test("check:lane formats a regenerated openapi contract the way the GUI package's openapi script does", () => {
	const formatted = formatOpenapi(`${JSON.stringify({ required: ["a", "b"] }, null, "\t")}\n`);
	strictEqual(formatted.status, 0, formatted.stderr);
	strictEqual(formatted.stdout, '{\n\t"required": ["a", "b"]\n}\n');
});
