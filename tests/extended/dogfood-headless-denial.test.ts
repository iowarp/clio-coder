import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BLOCKED_ATTEMPT_REASON_MAX_CHARS,
	BLOCKED_ATTEMPTS_LIMIT,
	recordBlockedAttempt,
} from "../../src/cli/modes/print.js";
import {
	HEADLESS_PERMISSION_DENIED_MARKER,
	HEADLESS_PERMISSION_DENIED_REASON,
} from "../../src/core/headless-permission.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { SafetyBlockedAttempt } from "../../src/domains/dispatch/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";
import { inline } from "../harness/headless-denial-fixture.js";
import { type HeadlessScratch, headlessScratch, runCli, sealedReceipt } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatFixture,
	type OpenAICompatToolCallScript,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { readRunJournal } from "../harness/run-journal.js";
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
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				fileURLToPath(new URL("../fixtures/headless-denial-driver.ts", import.meta.url)),
				eventsPath,
			],
			{ cwd: env.dir, env: process.env, encoding: "utf8", timeout: 30_000 },
		);
		strictEqual(child.error, undefined);
		strictEqual(child.status, 1, "the unresolved hard block fails the run");
		const output = child.stdout;
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
			// Both blocked bash calls land in the worker-shaped safety summary with
			// the rule that blocked them, and no write succeeded, so the run is a
			// no-op despite its final answer, and exits 1.
			const { safety } = tools();
			deepStrictEqual(
				receipt.safety?.blockedAttempts.map((attempt) => [attempt.tool, attempt.ruleId]),
				[inline, "rm -f sentinel.txt"].map((command) => [
					"bash",
					safety.evaluate({ tool: "bash", args: { command } }).policy?.ruleId,
				]),
			);
			// The headless-denied ask counts as a permission request, the hard
			// block as a block, and the two calls that ran as allowed. The legacy
			// producer reports no admission decision at all.
			deepStrictEqual(receipt.safety?.decisions, { allowed: 2, blocked: 1, permissionRequested: 1 });
			strictEqual(receipt.noop, true);
			strictEqual(receipt.outcome, "failed");
		}
	});

test("the headless blockedAttempts list is bounded and counts what it leaves out", () => {
	const stats = { blockedAttempts: [] as SafetyBlockedAttempt[], blockedAttemptsTruncated: 0 };
	const reason = "x".repeat(BLOCKED_ATTEMPT_REASON_MAX_CHARS + 100);
	for (let index = 0; index < BLOCKED_ATTEMPTS_LIMIT + 10; index += 1) {
		recordBlockedAttempt(stats, { tool: "write", actionClass: "write", reason });
	}
	strictEqual(stats.blockedAttempts.length, BLOCKED_ATTEMPTS_LIMIT);
	strictEqual(stats.blockedAttemptsTruncated, 10);
	strictEqual(stats.blockedAttempts[0]?.reason, `${reason.slice(0, BLOCKED_ATTEMPT_REASON_MAX_CHARS)}…`);
	stats.blockedAttempts = [];
	recordBlockedAttempt(stats, { tool: "edit", reason: "short" });
	deepStrictEqual(stats.blockedAttempts, [{ tool: "edit", reason: "short" }]);
});

/**
 * Ticket #378 end to end: the built binary, a scripted OpenAI-compatible model,
 * and the exit code and sealed receipt an external driver would read.
 */
describe("headless no-op contract through the built binary", () => {
	const fixtures: OpenAICompatFixture[] = [];
	const scratches: HeadlessScratch[] = [];
	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	const PROOF = "written by the no-op contract test\n";
	const writeProof: OpenAICompatToolCallScript = {
		id: "call-write",
		name: "write",
		arguments: { path: "c2-proof.txt", content: PROOF },
	};
	const deniedInline: OpenAICompatToolCallScript = { id: "call-inline", name: "bash", arguments: { command: inline } };

	/** Tool results already in the conversation, which is how far the script has got. */
	function toolResults(request: Record<string, unknown>): number {
		const messages = Array.isArray(request.messages) ? request.messages : [];
		return messages.filter((message) => (message as { role?: unknown }).role === "tool").length;
	}

	async function headlessTurn(input: {
		autonomy: string;
		steps: ReadonlyArray<OpenAICompatToolCallScript>;
		failOnNoop: boolean;
		reply?: string;
	}) {
		const scratch = headlessScratch("clio-coder-noop-");
		scratches.push(scratch);
		const fixture = await startOpenAICompatFixture(input.reply ?? "I could not apply the change.", {
			toolCall: (request) => input.steps[toolResults(request)] ?? null,
		});
		fixtures.push(fixture);
		seedOpenAICompatToolOrchestrator(scratch.configDir, fixture.url, input.autonomy);
		const project = join(scratch.root, "project");
		mkdirSync(project);
		writeFileSync(join(project, "sentinel.txt"), "blocked is harmless fixture text\n");
		const turn = await runCli(
			[
				"--no-context-files",
				"--no-skills",
				"run",
				"--autonomy",
				input.autonomy,
				...(input.failOnNoop ? ["--fail-on-noop"] : []),
				"Apply the change.",
			],
			{ env: scratch.env, cwd: project },
		);
		const { receipt, envelope } = sealedReceipt(scratch.stateDir);
		strictEqual(receipt.exitCode, turn.code, "the receipt and the process must agree on the exit code");
		strictEqual(readFileSync(join(project, "sentinel.txt"), "utf8"), "blocked is harmless fixture text\n");
		return { turn, receipt, envelope, project };
	}

	for (const failOnNoop of [true, false]) {
		test(`a run whose write was denied ${failOnNoop ? "fails under --fail-on-noop" : "also fails without the flag"}`, async () => {
			// At suggest a write parks for approval, and a headless run has no
			// operator, so the ask is denied and the model answers with prose.
			const { turn, receipt, project } = await headlessTurn({ autonomy: "suggest", steps: [writeProof], failOnNoop });
			ok(!existsSync(join(project, "c2-proof.txt")), "the denied write must not land");
			strictEqual(receipt.noop, true);
			ok((receipt.safety?.blockedAttempts.length ?? 0) > 0);
			deepStrictEqual(
				receipt.safety?.blockedAttempts.map((attempt) => [attempt.tool, attempt.actionClass]),
				[["write", "write"]],
			);
			deepStrictEqual(receipt.safety?.decisions, { allowed: 0, blocked: 0, permissionRequested: 1 });
			strictEqual(receipt.toolStats.find((stat) => stat.tool === "write")?.blocked, 1);
			if (failOnNoop) {
				strictEqual(turn.code, 1, turn.stderr);
				strictEqual(receipt.outcome, "failed");
				strictEqual(receipt.outcomeDetail, "noop");
				match(turn.stderr, /no-op under --fail-on-noop: 1 tool call was blocked without recovery and no write succeeded/);
				// The model's answer still reaches stdout; stderr says why the run failed.
				match(turn.stdout, /I could not apply the change\./);
			} else {
				strictEqual(turn.code, 1, turn.stderr);
				strictEqual(receipt.outcome, "failed");
				strictEqual(receipt.outcomeDetail, "noop");
				match(turn.stderr, /no-op: 1 tool call was blocked without recovery/);
			}
		});
	}

	test("a run whose write succeeded is not a no-op under --fail-on-noop", async () => {
		const { turn, receipt, project } = await headlessTurn({
			autonomy: "auto-edit",
			steps: [writeProof],
			failOnNoop: true,
			reply: "done",
		});
		strictEqual(turn.code, 0, turn.stderr);
		strictEqual(readFileSync(join(project, "c2-proof.txt"), "utf8"), PROOF);
		strictEqual(receipt.outcome, "succeeded");
		strictEqual(receipt.noop, false);
		deepStrictEqual(receipt.safety?.blockedAttempts, []);
		strictEqual(receipt.safety?.decisions.allowed, 1);
	});

	test("one blocked call and one successful write is not a no-op under --fail-on-noop", async () => {
		const { turn, receipt, project } = await headlessTurn({
			autonomy: "auto-edit",
			steps: [deniedInline, writeProof],
			failOnNoop: true,
			reply: "done",
		});
		strictEqual(turn.code, 0, turn.stderr);
		strictEqual(readFileSync(join(project, "c2-proof.txt"), "utf8"), PROOF);
		strictEqual(receipt.outcome, "succeeded");
		strictEqual(receipt.noop, false);
		ok((receipt.safety?.blockedAttempts.length ?? 0) > 0);
		deepStrictEqual(
			receipt.safety?.blockedAttempts.map((attempt) => [attempt.tool, attempt.ruleId]),
			[["bash", "bash-hidden-content"]],
		);
	});

	test("a report artifact after a blocked edit is still a no-op under --fail-on-noop", async () => {
		// The edit is a hard block on a zero-access path, so the only successful
		// write-class call is the artifact explaining the failure. That artifact
		// is the turn's answer, not a change to the workspace.
		const { turn, receipt, project } = await headlessTurn({
			autonomy: "auto-edit",
			steps: [
				{ id: "call-edit", name: "edit", arguments: { path: ".env", edits: [{ oldText: "A=1", newText: "A=2" }] } },
				{
					id: "call-artifact",
					name: "gateway",
					arguments: {
						op: "call",
						capability: "artifact",
						args: { kind: "report", content: "# Blocked\n\nThe edit was refused by policy.\n" },
					},
				},
			],
			failOnNoop: true,
		});
		ok(existsSync(join(project, ".clio-coder", "artifacts", "REPORT.md")), "the artifact itself must land");
		strictEqual(turn.code, 1, turn.stderr);
		strictEqual(receipt.noop, true);
		strictEqual(receipt.outcome, "failed");
		strictEqual(receipt.outcomeDetail, "noop");
		deepStrictEqual(
			receipt.safety?.blockedAttempts.map((attempt) => [attempt.tool, attempt.actionClass]),
			[["edit", "write"]],
		);
		strictEqual(receipt.toolStats.find((stat) => stat.tool === "gateway")?.ok, 1);
	});

	test("three identical denied writes all count as permission requests", async () => {
		// The loop guard rewrites the third denial's reason with its own
		// guidance, so a reason-prefix check would count that one as a hard block.
		const { receipt } = await headlessTurn({
			autonomy: "suggest",
			steps: [writeProof, { ...writeProof, id: "call-write-2" }, { ...writeProof, id: "call-write-3" }],
			failOnNoop: false,
		});
		strictEqual(receipt.safety?.blockedAttempts.length, 3);
		deepStrictEqual(receipt.safety?.decisions, { allowed: 0, blocked: 0, permissionRequested: 3 });
		strictEqual(receipt.noop, true);
	});

	test("the sealed noop bit is covered by the receipt integrity digest", async () => {
		const { receipt, envelope } = await headlessTurn({ autonomy: "suggest", steps: [writeProof], failOnNoop: false });
		strictEqual(receipt.noop, true);
		ok(verifyReceiptIntegrity(receipt, envelope).ok, "the sealed receipt must verify as written");
		strictEqual(verifyReceiptIntegrity({ ...receipt, noop: false }, envelope).ok, false, "a flipped noop must fail");
		const { noop: _noop, ...withoutNoop } = receipt;
		strictEqual(verifyReceiptIntegrity(withoutNoop, envelope).ok, false, "a removed noop must fail");
	});

	test("a prose answer with no tool call is not a no-op under --fail-on-noop", async () => {
		const { turn, receipt } = await headlessTurn({
			autonomy: "auto-edit",
			steps: [],
			failOnNoop: true,
			reply: "The answer is 42.",
		});
		strictEqual(turn.code, 0, turn.stderr);
		strictEqual(receipt.toolCalls, 0);
		strictEqual(receipt.noop, false);
		strictEqual(receipt.outcome, "succeeded");
	});

	test("tools that all failed without a block are a no-op under --fail-on-noop", async () => {
		const { turn, receipt } = await headlessTurn({
			autonomy: "auto-edit",
			steps: [{ id: "call-read", name: "read", arguments: { path: "missing-input.txt" } }],
			failOnNoop: true,
		});
		strictEqual(turn.code, 1, turn.stderr);
		deepStrictEqual(receipt.safety?.blockedAttempts, []);
		strictEqual(receipt.toolStats.find((stat) => stat.tool === "read")?.errors, 1);
		strictEqual(receipt.noop, true);
		strictEqual(receipt.outcome, "failed");
		strictEqual(receipt.outcomeDetail, "noop");
		match(turn.stderr, /no-op under --fail-on-noop: 1 tool call ran and none succeeded/);
	});

	test("--fail-on-noop is refused on the --agent path", async () => {
		const scratch = headlessScratch("clio-coder-noop-agent-");
		scratches.push(scratch);
		const turn = await runCli(["run", "--fail-on-noop", "--agent", "coder", "Apply the change."], {
			env: scratch.env,
			cwd: scratch.root,
		});
		strictEqual(turn.code, 2, turn.stderr);
		match(turn.stderr, /--fail-on-noop applies to the main agent, not --agent dispatch/);
	});
});
