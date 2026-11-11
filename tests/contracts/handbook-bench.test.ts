import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { replayTask, scoreHandbook, scoreReplay, unsafeEnvironment } from "../../scripts/handbook-bench.mjs";

it("keys a replay task by the commit's files and scores a matching and a straying diff", () => {
	const task = replayTask(
		"abc123456789",
		"feat(tools): add a retry budget to the fetch tool\n\nThe budget lives in `src/tools/fetch.ts`.\n\nFixes: #12\n",
		["src/tools/fetch.ts", "tests/contracts/fetch.test.ts"],
	);
	ok(task);
	strictEqual(task.at, "abc123456789^");
	ok(!task.prompt.includes("src/tools/fetch.ts"), task.prompt);
	ok(!task.prompt.includes("Fixes:"), task.prompt);
	deepStrictEqual(task.key, ["src/tools/fetch.ts", "tests/contracts/fetch.test.ts"]);
	strictEqual(scoreReplay(task.key, ["tests/contracts/fetch.test.ts", "src/tools/fetch.ts"]), 1);
	strictEqual(scoreReplay(task.key, ["src/tools/fetch.ts", "CHANGELOG.md"]), 0.4);
	strictEqual(replayTask("abc", "chore: `a/b.ts` `c/d.ts` `e/f.ts`", ["a/b.ts"]), null);
});

it("counts duplicate pairs and invalid citations in a handbook and refuses the real home", () => {
	const tree = mkdtempSync(join(process.env.TMPDIR ?? "", "bench-"));
	mkdirSync(join(tree, "src", "widgets"), { recursive: true });
	writeFileSync(join(tree, "src", "widgets", "render.ts"), "export {};\n");
	const handbook = [
		"1. Exported names from `src/widgets/render.ts` stay stable between minor releases.",
		"2. Exported names from `src/widgets/render.ts` must stay stable across minor releases.",
		"3. Widget styles live in `src/widgets/styles.ts`.",
		"",
	].join("\n");
	const result = scoreHandbook({ handbook, tree });
	strictEqual(result.duplicates.length, 1);
	deepStrictEqual(
		result.invalid.map((entry: { paths: string[] }) => entry.paths),
		[["src/widgets/styles.ts"]],
	);
	ok(unsafeEnvironment({ TMPDIR: tree, CLIO_CODER_HOME: "/h/.config/clio-coder" }, "/h"));
	strictEqual(unsafeEnvironment({ TMPDIR: tree }, "/h"), null);
	ok(unsafeEnvironment({}, "/h"));
});
