import assert from "node:assert/strict";
import { test } from "node:test";
import { observeWorkspace } from "../../src/interactive/direction-observations.js";
import type { ToolInvokeOptions, ToolRegistry } from "../../src/tools/registry.js";

test("direction uses admitted harness reads and bounds directory entries and codemap areas", async () => {
	const calls: Array<{ tool: string; args?: Record<string, unknown>; options: ToolInvokeOptions | undefined }> = [];
	const registry = {
		async invoke(call, options) {
			calls.push({ ...call, options });
			const output =
				call.tool === "git"
					? call.args?.op === "status"
						? "## feature...origin/feature\n M src/a.ts\n?? new.ts\n"
						: "a12 First\nb34 Second\nc56 Third\n"
					: call.tool === "ls"
						? ["z.ts", "src/", ...Array.from({ length: 45 }, (_, i) => `file-${i}`)].join("\n")
						: JSON.stringify({
								files: [{ path: "src/a.ts", summary: "private body" }, { path: "src/b.ts" }, { path: "tests/a.ts" }],
							});
			return { kind: "ok", result: { kind: "ok", output }, decision: {} };
		},
	} as Pick<ToolRegistry, "invoke">;
	const result = await observeWorkspace({
		registry,
		cwd: "/repo",
		invokeOptions: { turnId: "u1" },
		observations: ["git-status", "git-log", "tree", "codemap"],
	});
	assert.deepEqual(
		calls.map(({ tool, args }) => [tool, args?.op ?? args?.path]),
		[
			["git", "status"],
			["git", "log"],
			["ls", "/repo"],
			["read", "/repo/.clio-coder/codemap.json"],
		],
	);
	assert.ok(calls.every(({ options }) => options?.origin === "harness" && options.turnId === "u1" && options.signal));
	assert.equal(calls[1]?.args?.limit, 3);
	assert.equal(calls[2]?.args?.limit, 40);
	assert.deepEqual(result.git, { branch: "feature", modified: 1, untracked: 1, recent: ["First", "Second", "Third"] });
	assert.equal(result.tree?.length, 40);
	assert.equal(result.tree?.[0], "src/");
	assert.equal(result.codemap, "src: 2 files; tests: 1 files");
});

test("refused git and malformed codemap leave unknown fields while tree survives", async () => {
	const registry = {
		async invoke(call) {
			if (call.tool === "git") return { kind: "not_visible", reason: "refused" };
			return { kind: "ok", decision: {}, result: { kind: "ok", output: call.tool === "ls" ? "src/" : "not JSON" } };
		},
	} as Pick<ToolRegistry, "invoke">;
	const result = await observeWorkspace({
		registry,
		cwd: "/repo",
		invokeOptions: {},
		observations: ["git-status", "git-log", "tree", "codemap"],
	});
	assert.equal(result.git, null);
	assert.equal(result.codemap, null);
	assert.deepEqual(result.tree, ["src/"]);
});

test("pre-admission harness reads survive turn_start and direction records execution without run ids", async () => {
	const { createTurnOutcomeCollector } = await import("../../src/interactive/turn-outcome-collector.js");
	const collector = createTurnOutcomeCollector();
	for (const toolName of ["git", "git", "ls", "read"])
		collector.evaluate({
			hook: "after_tool",
			sessionId: "s1",
			turnId: "reserved",
			toolName,
			metadata: { origin: "harness", resultKind: "ok" },
		});
	collector.evaluate({ hook: "turn_start", sessionId: "s1" });
	collector.recordControl({
		version: 1,
		turnId: "reserved",
		producer: "system-one",
		interpretation: null,
		factsDigest: "fixture",
		decision: { kind: "direction", observations: [] },
		decisionHash: "fixture",
		executed: { runIds: [], blockChars: 100, durationMs: 1 },
	});
	const facts = collector.take("reserved");
	assert.equal(facts.harness.reads, 4);
	assert.equal(facts.control?.executed, true);
	assert.deepEqual(facts.toolNames, []);
});

// A dispatch whose worker failed or was aborted still launched a run that spent
// worker tokens. Recording only successful dispatches left dispatches and the
// worker token total empty for an operator-aborted refactor.
test("a failed dispatch that launched a run is recorded as failed and never counts as a duplicate", async () => {
	const { createTurnOutcomeCollector } = await import("../../src/interactive/turn-outcome-collector.js");
	const collector = createTurnOutcomeCollector();
	collector.evaluate({ hook: "turn_start", sessionId: "s1", turnId: "u1" });
	const args = { agent: "coder", task: "refactor validateSettings" };
	for (const [resultKind, runs] of [
		["error", []],
		["error", [{ runId: "apc8sdap2qro", agentId: "coder" }]],
		["ok", [{ runId: "r2", agentId: "coder" }]],
	] as const) {
		const call = { sessionId: "s1", turnId: "u1", toolName: "dispatch", toolArgs: args };
		collector.evaluate({ hook: "before_tool", ...call });
		collector.evaluate({
			hook: "after_tool",
			...call,
			toolResultDetails: { runs: [...runs] },
			metadata: { resultKind },
		});
	}
	const facts = collector.take("u1");
	assert.equal(facts.toolNames.length, 3);
	assert.deepEqual(
		facts.dispatches.map((dispatch) => [dispatch.runIds, dispatch.failed === true]),
		[
			[["apc8sdap2qro"], true],
			[["r2"], false],
		],
	);
	assert.equal(facts.duplicateDispatch, false, "a failed attempt never makes its retry a duplicate");
});
