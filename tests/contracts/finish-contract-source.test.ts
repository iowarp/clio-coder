import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { acceptanceFromTaskFlags } from "../../src/cli/tasks.js";
import { createFinishContractRegistration } from "../../src/domains/safety/finish-contract-registration.js";
import { createTaskBoardStore, foldTaskBoard } from "../../src/domains/session/task-board.js";
import { activeUserTaskAcceptance } from "../../src/domains/user-tasks/active-acceptance.js";
import { createUserTasksStore } from "../../src/domains/user-tasks/store.js";
import { bashTool } from "../../src/tools/bash.js";
import { limitationTool } from "../../src/tools/limitation.js";
import type { ToolSpec } from "../../src/tools/registry.js";
import { createTasksTool } from "../../src/tools/tasks.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("requires the owning project's check after a same-named examples check passes", async () => {
	const scratch = await isolateClioEnv("finish-source-");
	const originalCwd = process.cwd();
	try {
		const root = join(scratch.dir, "project");
		mkdirSync(join(root, "examples"), { recursive: true });
		for (const [directory, exitCode] of [
			[root, 1],
			[join(root, "examples"), 0],
		] as const) {
			writeFileSync(
				join(directory, "package.json"),
				JSON.stringify({ scripts: { "test:solver": "node solver.test.cjs" } }),
			);
			writeFileSync(join(directory, "solver.test.cjs"), `process.exitCode = ${exitCode};\n`);
		}
		process.chdir(root);
		const acceptance = acceptanceFromTaskFlags(root, ["src/solver.ts"], ["test:solver"]);
		const entries: unknown[] = [];
		async function execute(tool: ToolSpec, args: Record<string, unknown>) {
			const toolCallId = `call-${entries.length}`;
			entries.push({ kind: "message", role: "tool_call", payload: { name: tool.name, toolCallId, args } });
			const result = await tool.run(args);
			entries.push({ kind: "message", role: "tool_result", payload: { toolName: tool.name, toolCallId, result } });
			return result;
		}
		const hook = createFinishContractRegistration({
			readSessionEntries: () => entries,
			resolveRigor: () => "high",
			readActiveAcceptance: () => acceptance,
		});
		async function requiresCheck() {
			const effects = await hook.evaluate({ hook: "turn_end", text: "Updated the solver." });
			return effects.some((effect) => effect.kind === "request_continuation");
		}
		strictEqual((await execute(writeTool, { path: "src/solver.ts", content: "export const solver = 1;\n" })).kind, "ok");
		const failed = await execute(verifyTool, { check: "test:solver" });
		strictEqual(failed.kind, "error");
		strictEqual(failed.details?.exitCode, 1);
		strictEqual(await requiresCheck(), true);
		const example = await execute(verifyTool, { check: "test:solver", cwd: "examples" });
		strictEqual(example.kind, "ok");
		strictEqual(example.details?.cwd, join(root, "examples"));
		deepStrictEqual(example.details?.argv, ["npm", "run", "test:solver"]);
		strictEqual(await requiresCheck(), true, "a passing examples check must not satisfy root acceptance");
		deepStrictEqual(example.details?.source, { kind: "package.json", path: join(root, "examples/package.json") });
		strictEqual((await execute(bashTool, { command: "npm run test:solver", cwd: "examples" })).kind, "ok");
		strictEqual(await requiresCheck(), true, "a bash receipt from examples must not satisfy root acceptance");
		strictEqual(
			(await execute(limitationTool, { scope: "The root solver check fails", reason: "other", paths: ["test:solver"] }))
				.kind,
			"ok",
		);
		strictEqual(await requiresCheck(), false, "a scoped limitation settles the unmet root check");
		entries.splice(-2);
		writeFileSync(join(root, "solver.test.cjs"), "process.exitCode = 0;\n");
		const passed = await execute(verifyTool, { check: "test:solver" });
		strictEqual(passed.kind, "ok");
		strictEqual(passed.details?.cwd, root);
		ok(passed.details?.exitCode === 0);
		strictEqual(await requiresCheck(), false, "the intended root check still satisfies acceptance");
		entries.splice(2);
		strictEqual((await execute(bashTool, { command: "npm run test:solver" })).kind, "ok");
		strictEqual(await requiresCheck(), false, "an exact successful root bash check still satisfies acceptance");
	} finally {
		process.chdir(originalCwd);
		scratch.restore();
	}
});

it("accepts a catalog's declared subdirectory and distinguishes another workspace's source", async () => {
	const scratch = await isolateClioEnv("finish-catalog-source-");
	const originalCwd = process.cwd();
	try {
		const root = join(scratch.dir, "project");
		const example = join(scratch.dir, "example-project");
		for (const directory of [root, example]) {
			mkdirSync(join(directory, ".clio-coder"), { recursive: true });
			mkdirSync(join(directory, "checks"));
			writeFileSync(join(directory, "checks/oracle.cjs"), "process.exitCode = 0;\n");
			writeFileSync(
				join(directory, ".clio-coder/verifiers.yaml"),
				[
					"version: 1",
					"checks:",
					"  - id: solver-oracle",
					"    description: Solver oracle",
					"    command: [node, oracle.cjs]",
					"    cwd: checks",
					"    timeoutMs: 60000",
					"    tags: []",
					"",
				].join("\n"),
			);
		}
		process.chdir(root);
		const acceptance = acceptanceFromTaskFlags(root, ["solver.ts"], ["solver-oracle"]);
		const writeArgs = { path: "solver.ts", content: "export const solver = 1;\n" };
		const writeResult = await writeTool.run(writeArgs);
		strictEqual(writeResult.kind, "ok");
		const entries: unknown[] = [
			{ kind: "message", role: "tool_call", payload: { name: "write", toolCallId: "write", args: writeArgs } },
			{ kind: "message", role: "tool_result", payload: { toolName: "write", toolCallId: "write", result: writeResult } },
		];
		const hook = createFinishContractRegistration({
			readSessionEntries: () => entries,
			resolveRigor: () => "high",
			readActiveAcceptance: () => acceptance,
		});
		for (const directory of [example, root]) {
			process.chdir(directory);
			const args = { check: "solver-oracle" };
			const result = await verifyTool.run(args);
			strictEqual(result.kind, "ok");
			deepStrictEqual(result.details?.source, {
				kind: "project-catalog",
				path: join(directory, ".clio-coder/verifiers.yaml"),
			});
			strictEqual(result.details?.cwd, join(directory, "checks"));
			deepStrictEqual(result.details?.argv, ["node", "oracle.cjs"]);
			entries.push(
				{ kind: "message", role: "tool_call", payload: { name: "verify", toolCallId: directory, args } },
				{ kind: "message", role: "tool_result", payload: { toolName: "verify", toolCallId: directory, result } },
			);
			process.chdir(root);
			const effects = await hook.evaluate({ hook: "turn_end", text: "Updated the solver." });
			strictEqual(
				effects.some((effect) => effect.kind === "request_continuation"),
				directory !== root,
			);
		}
	} finally {
		process.chdir(originalCwd);
		scratch.restore();
	}
});

for (const outcome of ["passed", "failed", "absent"] as const) {
	it(`distinguishes acceptance declarations from ${outcome} receipts through task completion and detail`, async () => {
		const scratch = await isolateClioEnv("task-detail-");
		const originalCwd = process.cwd();
		try {
			process.chdir(scratch.dir);
			writeFileSync(
				"package.json",
				JSON.stringify({
					scripts: {
						"grid-numeric": "node numeric.cjs",
						"grid-perf": "node perf.cjs",
					},
				}),
			);
			mkdirSync(".clio-coder", { recursive: true });
			writeFileSync(
				".clio-coder/verifiers.yaml",
				"version: 1\nchecks:\n" +
					["numeric", "perf"]
						.map(
							(name) =>
								`  - id: grid-${name}\n    description: Grid ${name}\n    command: [node, ${name}.cjs]\n    cwd: .\n    timeoutMs: 30000\n    tags: []\n`,
						)
						.join(""),
			);
			writeFileSync("numeric.cjs", "process.exitCode = 0;\n");
			writeFileSync("perf.cjs", `process.exitCode = ${outcome === "failed" ? 1 : 0};\n`);
			const entries: unknown[] = [];
			const envelope = () => ({
				timestamp: new Date().toISOString(),
				turnId: `entry-${entries.length}`,
				parentTurnId: null,
			});
			const board = createTaskBoardStore({
				getSessionId: () => "s6",
				readEntries: () => entries,
				appendEntry: (entry) => entries.push({ ...envelope(), ...entry }),
			});
			const userTasks = createUserTasksStore({ cwd: scratch.dir });
			const acceptance = acceptanceFromTaskFlags(
				scratch.dir,
				["battletest-output/validation.txt"],
				["grid-numeric", "grid-perf"],
			);
			userTasks.add("S6 validation", undefined, acceptance);
			const tasks = createTasksTool({ board, userTasks, getSessionId: () => "s6" });
			async function execute(tool: ToolSpec, args: Record<string, unknown>) {
				const toolCallId = `call-${entries.length}`;
				entries.push({ ...envelope(), kind: "message", role: "tool_call", payload: { name: tool.name, toolCallId, args } });
				const result = await tool.run(args);
				entries.push({
					...envelope(),
					kind: "message",
					role: "tool_result",
					payload: { toolName: tool.name, toolCallId, result },
				});
				return result;
			}
			strictEqual((await execute(tasks, { action: "pick", id: "u1" })).kind, "ok");
			strictEqual((await execute(tasks, { action: "start", id: "t1" })).kind, "ok");
			strictEqual((await execute(verifyTool, { check: "grid-numeric" })).kind, "ok");
			if (outcome !== "absent") {
				const verified = await execute(verifyTool, { check: "grid-perf" });
				strictEqual(verified.kind, outcome === "passed" ? "ok" : "error");
				strictEqual(verified.details?.exitCode, outcome === "passed" ? 0 : 1);
			}
			strictEqual(
				(await execute(writeTool, { path: "battletest-output/validation.txt", content: "Both checks passed." })).kind,
				"ok",
			);
			const done = await execute(tasks, { action: "done", id: "t1", note: "Both checks passed." });
			ok(done.kind === "ok");
			strictEqual(userTasks.get("u1")?.status, "done");
			const hook = createFinishContractRegistration({
				readSessionEntries: () => entries,
				resolveRigor: () => "high",
				readActiveAcceptance: (window) => activeUserTaskAcceptance(userTasks.snapshot(), board.snapshot(), "s6", window),
			});
			const effects = await hook.evaluate({ hook: "turn_end", text: "Both checks passed. Done." });
			strictEqual(
				effects.some((effect) => effect.kind === "request_continuation"),
				outcome !== "passed",
			);
			if (outcome !== "passed")
				ok(effects.some((effect) => effect.kind === "request_continuation" && effect.message.includes("grid-perf")));
			for (const detail of [done, await execute(tasks, { action: "list" })]) {
				ok(detail.kind === "ok");
				match(detail.output, /acceptance requirement: grid-numeric/);
				match(detail.output, /execution status.*verification receipts/);
				const rows = detail.details?.tasks as {
					status: string;
					requiredValidationEvidence: { status: string; description: string }[];
				}[];
				strictEqual(rows[0]?.status, "completed");
				deepStrictEqual(
					rows[0]?.requiredValidationEvidence.map((item) => item.status),
					["required", "required"],
				);
				for (const item of rows[0]?.requiredValidationEvidence ?? []) match(item.description, /declaration only/);
			}
			deepStrictEqual(foldTaskBoard(entries)?.tasks, board.snapshot()?.tasks);
			board.invalidate();
			deepStrictEqual(
				board.snapshot()?.tasks[0]?.requiredValidationEvidence?.map((item) => item.status),
				["required", "required"],
			);
		} finally {
			process.chdir(originalCwd);
			scratch.restore();
		}
	});
}
