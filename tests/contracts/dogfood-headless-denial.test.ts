import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	HEADLESS_PERMISSION_DENIED_MARKER,
	HEADLESS_PERMISSION_DENIED_REASON,
} from "../../src/core/headless-permission.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { readRunJournal } from "../../src/domains/eval/metrics/invariants.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";
import { inline } from "../harness/headless-denial-fixture.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const pivot =
	"Do not retry this action through another tool unless a hint above names one; pivot or report the blocker.";
let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("d6-");
	previousCwd = process.cwd();
	process.chdir(env.dir);
	writeFileSync("sentinel.txt", "blocked is harmless fixture text\n");
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

function tools() {
	const safety = createWorkerSafety({ cwd: env.dir });
	const registry = createRegistry({ safety, autonomy: () => "full-auto" });
	registry.register(bashTool);
	return { safety, registry };
}

test("headless denied asks preserve the actual cause/rule, final denial and bounded no-bypass feedback", async () => {
	const { safety, registry } = tools();
	const original = safety.evaluate({ tool: "bash", args: { command: inline } });
	strictEqual(original.kind, "ask", "full-auto must not relax the hidden-content confirmation rail");
	strictEqual(original.policy?.ruleId, "bash-hidden-content");
	registry.onPermissionRequired(() => registry.cancelParkedCalls(HEADLESS_PERMISSION_DENIED_REASON));
	const bash = resolveAgentTools({ registry })[0];
	ok(bash);
	await rejects(bash.execute("denied-inline", { command: inline }), (error: unknown) => {
		ok(error instanceof Error);
		ok(error.message.startsWith(HEADLESS_PERMISSION_DENIED_MARKER));
		match(error.message, /rule: bash-hidden-content/);
		match(error.message, /shell variables or interpreter source hide paths/);
		match(error.message, /denied|not approved/);
		doesNotMatch(error.message, /hard block|is parked|resumeParked|awaiting approval/);
		ok(error.message.endsWith(pivot));
		ok(error.message.split("\n").length <= 16);
		ok(error.message.split("\n").every((line) => line.length <= 301));
		return true;
	});
	strictEqual(registry.parkedCount(), 0);
	strictEqual(readFileSync("sentinel.txt", "utf8"), "blocked is harmless fixture text\n");
});

test("interactive denials remain terminal, while actual hard blocks retain hard-block guidance", async () => {
	const { safety, registry } = tools();
	registry.onPermissionRequired(() => registry.cancelParkedCalls("Operator denied this action."));
	const bash = resolveAgentTools({ registry })[0];
	ok(bash);
	await rejects(bash.execute("interactive", { command: inline }), (error: unknown) => {
		ok(error instanceof Error);
		strictEqual(error.message, `Operator denied this action.\n${pivot}`);
		return true;
	});
	strictEqual(safety.evaluate({ tool: "bash", args: { command: "rm -f sentinel.txt" } }).kind, "block");
	await rejects(bash.execute("hard", { command: "rm -f sentinel.txt" }), /hard block; confirmation cannot override/);
	strictEqual(readFileSync("sentinel.txt", "utf8"), "blocked is harmless fixture text\n");
});

for (const check of ["correlation", "receipt"] as const)
	test(`headless production ${check} preserves authoritative outcomes rather than classifying text`, async () => {
		const eventsPath = join(env.dir, "events.json");
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				fileURLToPath(new URL("../fixtures/headless-denial-driver.ts", import.meta.url)),
				eventsPath,
			],
			{ cwd: env.dir, env: process.env, encoding: "utf8", timeout: 30_000 },
		);
		const events = JSON.parse(readFileSync(eventsPath, "utf8")) as ChatLoopEvent[];
		const { safety } = tools();
		const ends = events.filter((event) => event.type === "tool_execution_end") as Array<
			Extract<ChatLoopEvent, { type: "tool_execution_end" }> & {
				outcome?: string;
				ruleId?: string;
				reasonCode?: string;
				policySource?: string;
			}
		>;
		deepStrictEqual(
			ends.slice(0, 2).map((event) => event.toolCallId),
			["error-second", "ask-first"],
		);
		strictEqual(readFileSync("sentinel.txt", "utf8"), "blocked is harmless fixture text\n");
		if (check === "correlation") {
			for (const [id, command, outcome] of [
				["ask-first", inline, "blocked"],
				["error-second", "cat missing-blocked.txt", "error"],
				["success", "cat sentinel.txt", "ok"],
				["hard", "rm -f sentinel.txt", "blocked"],
			] as const) {
				const event = ends.find((entry) => entry.toolCallId === id);
				ok(event);
				const policy = safety.evaluate({ tool: "bash", args: { command } }).policy;
				ok(policy);
				deepStrictEqual(
					{ outcome: event.outcome, ruleId: event.ruleId, reasonCode: event.reasonCode, policySource: event.policySource },
					{ outcome, ruleId: policy.ruleId, reasonCode: policy.reasonCode, policySource: policy.policySource },
					id,
				);
				const wire = output
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.find((entry) => entry.type === "tool_execution_end" && entry.toolCallId === id);
				strictEqual(wire.ruleId, policy.ruleId);
			}
			for (const legacy of ends.filter((event) => event.toolName === "legacy")) {
				strictEqual(legacy.outcome, undefined);
				strictEqual(legacy.ruleId, undefined);
			}
		} else {
			const journal = readRunJournal(join(env.dir, "state"));
			ok(journal);
			strictEqual(journal.receipts.length, 1);
			const receipt = journal.receipts[0];
			ok(receipt);
			const envelope = journal.envelopes.get(receipt.runId);
			ok(envelope);
			strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
			const stats = receipt.toolStats.map(({ tool, count, ok, errors, blocked }) => ({
				tool,
				count,
				ok,
				errors,
				blocked,
			}));
			deepStrictEqual(stats, [
				{ tool: "bash", count: 4, ok: 1, errors: 1, blocked: 2 },
				{ tool: "legacy", count: 2, ok: 1, errors: 1, blocked: 0 },
			]);
			for (const stat of receipt.toolStats) strictEqual(stat.count, stat.ok + stat.errors + stat.blocked);
		}
	});
