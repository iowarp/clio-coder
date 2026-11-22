import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
	mainToolCalls,
	replayTask,
	scoreHandbook,
	scoreReplay,
	unsafeEnvironment,
} from "../../scripts/handbook-bench.mjs";

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

it("counts duplicate pairs, invalid citations and tree contradictions in a handbook and refuses the real home", async () => {
	const tree = mkdtempSync(join(process.env.TMPDIR ?? "", "bench-"));
	mkdirSync(join(tree, "src", "widgets"), { recursive: true });
	writeFileSync(join(tree, "src", "widgets", "render.ts"), "export {};\n");
	writeFileSync(join(tree, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	writeFileSync(join(tree, "pnpm-lock.yaml"), "");
	const handbook = [
		"1. Exported names from `src/widgets/render.ts` stay stable between minor releases.",
		"2. Exported names from `src/widgets/render.ts` must stay stable across minor releases.",
		"3. Widget styles live in `src/widgets/styles.ts`.",
		"4. Retired themes must not return: no `src/themes/` directory.",
		"5. Lint with `yarn lint` before a commit.",
		"",
	].join("\n");
	const result = await scoreHandbook({ handbook, tree });
	strictEqual(result.duplicates.length, 1);
	deepStrictEqual(
		result.invalid.map((entry: { paths: string[] }) => entry.paths),
		[["src/widgets/styles.ts"]],
	);
	deepStrictEqual(
		result.contradicted.map((entry: { facts: string[] }) => entry.facts),
		[["package manager is pnpm, not yarn", "no package script lint"]],
	);
	ok(unsafeEnvironment({ TMPDIR: tree, CLIO_CODER_HOME: "/h/.config/clio-coder" }, "/h"));
	strictEqual(unsafeEnvironment({ TMPDIR: tree }, "/h"), null);
	ok(unsafeEnvironment({}, "/h"));
});

it("counts a v2 main stream's tool calls as the harness does: chains by their steps, cut-off calls as none", () => {
	strictEqual(
		mainToolCalls([
			{ type: "session", schemaVersion: 3, id: "s" },
			{ type: "tool_execution_end", toolCallId: "a" },
			{ type: "tool_execution_end", toolCallId: "chain" },
			{ type: "tool_execution_end", toolCallId: "chain:1", parentToolCallId: "chain" },
			{ type: "tool_execution_end", toolCallId: "chain:2", parentToolCallId: "chain" },
			{ type: "tool_execution_end", toolCallId: "cut", notRun: "output_limit" },
			{ type: "run_end", schemaVersion: 3, result: { text: "done", artifacts: [] } },
		]),
		3,
	);
});
