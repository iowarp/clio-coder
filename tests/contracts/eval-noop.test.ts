import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { noopFailureReason } from "../../src/domains/eval/metrics/noop.js";
import { renderEvalJunitReportV4 } from "../../src/domains/eval/reports/junit.js";
import { renderEvalTextReportV4 } from "../../src/domains/eval/reports/text.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SESSION = "session-under-test";
const BLOCKED = { tool: "write", actionClass: "write", reason: "headless run: permission denied" };

interface FixtureReceipt {
	name: string;
	sessionId: string;
	noop?: boolean;
	agentId?: string;
}

/** The fields a journal receipt needs to parse, plus the ones noop scoring reads. */
function receipt(input: FixtureReceipt): Record<string, unknown> {
	const runId = `run-${input.name}`;
	return {
		runId,
		agentId: input.agentId ?? "main-agent",
		exitCode: 0,
		outcome: "succeeded",
		sessionId: input.sessionId,
		lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
		integrity: { digest: "0".repeat(64) },
		safety: { decisions: { allowed: 0, blocked: 0, permissionRequested: 1 }, blockedAttempts: [BLOCKED] },
		...(input.noop === undefined ? {} : { noop: input.noop }),
	};
}

/**
 * Stands in for `clio-coder run --json`: seals receipts into the item's
 * journal the way the headless main agent does, prints the session header and
 * no receipt, then exits with the scripted code.
 */
async function runItem(input: { receipts: FixtureReceipt[]; exitCode?: number }) {
	const env = await isolateClioEnv("clio-coder-eval-noop-");
	try {
		const workspace = join(env.dir, "workspace");
		mkdirSync(workspace);
		const entry = join(env.dir, "fake-clio.cjs");
		writeFileSync(
			entry,
			`
const fs = require("node:fs"), path = require("node:path");
const dir = path.join(process.env.CLIO_CODER_STATE_DIR, "receipts");
fs.mkdirSync(dir, { recursive: true });
for (const r of ${JSON.stringify(input.receipts.map(receipt))}) fs.writeFileSync(path.join(dir, r.runId + ".json"), JSON.stringify(r));
process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "session", id: SESSION })}\n`)});
process.exit(${input.exitCode ?? 0});
`,
		);
		const artifact = await runEvalSuiteV2(
			{
				path: join(env.dir, "suite.yaml"),
				baseDir: env.dir,
				hash: "a".repeat(64),
				suite: {
					version: 2,
					suite: { id: "noop-scoring", title: "No-op scoring", visibility: "local" },
					matrix: { targets: [{ id: "fixture" }], repeats: 1 },
					tasks: [
						{
							id: "already-green",
							tags: [],
							workspace: { kind: "local", path: workspace },
							runner: { kind: "clio-coder-run", prompt: "Apply the change." },
							// No verifier: the untouched workspace already passes.
							verify: {},
							metrics: { collect: [] },
							timeoutMs: 10_000,
						},
					],
				},
			},
			{ clioEntry: entry },
		);
		const result = artifact.results[0];
		assert.ok(result);
		return { artifact, result };
	} finally {
		env.restore();
	}
}

test("eval noop: a no-op receipt fails a task whose verifier passes, with the blocked call as the reason", async () => {
	const { artifact, result } = await runItem({ receipts: [{ name: "main", sessionId: SESSION, noop: true }] });
	assert.equal(result.pass, false, JSON.stringify(result));
	assert.equal(result.failureClass, "noop");
	assert.equal(result.metrics["result.noop"], true);
	assert.equal(result.metrics["result.failureClass"], "noop");
	assert.equal(result.artifacts.failureReason, "no-op run: blocked write (headless run: permission denied)");
	// The machinery worked and the agent changed nothing: not an infrastructure failure.
	assert.equal(result.verdict?.machinery, "ok");
	assert.equal(result.verdict?.outcome, "fail");
	assert.equal(result.verdict?.reason, "noop");
	// The receipt is read for the decision only; runner evidence stays unset.
	assert.equal(result.terminalReceiptDigest, null);
	assert.equal(result.artifacts.receipt, undefined);
	assert.match(
		renderEvalTextReportV4(artifact),
		/^failure: already-green\[fixture:default:0\] noop: no-op run: blocked write \(headless run: permission denied\)$/mu,
	);
	assert.match(
		renderEvalJunitReportV4(artifact),
		/<failure message="noop">no-op run: blocked write \(headless run: permission denied\)<\/failure>/u,
	);
});

test("eval noop: a receipt that says noop false passes", async () => {
	const { result } = await runItem({ receipts: [{ name: "main", sessionId: SESSION, noop: false }] });
	assert.equal(result.pass, true, JSON.stringify(result));
	assert.equal(result.failureClass, null);
	assert.equal(result.metrics["result.noop"], false);
	assert.equal(result.artifacts.failureReason, undefined);
});

test("eval noop: only the receipt sealed for this run's session decides", async () => {
	const { result } = await runItem({
		receipts: [
			{ name: "main", sessionId: SESSION, noop: false },
			{ name: "other-session", sessionId: "someone-else", noop: true },
			{ name: "worker", sessionId: SESSION, noop: true, agentId: "worker-recipe" },
		],
	});
	assert.equal(result.pass, true, JSON.stringify(result));
	assert.equal(result.metrics["result.noop"], false);
});

test("eval noop: no receipt, or one that predates the field, leaves the outcome unchanged", async () => {
	for (const receipts of [[], [{ name: "legacy", sessionId: SESSION }]]) {
		const { result } = await runItem({ receipts });
		assert.equal(result.pass, true, JSON.stringify(result));
		assert.equal(result.failureClass, null);
		assert.equal("result.noop" in result.metrics, false);
	}
});

test("eval noop: a nonzero runner exit stays runner_failed", async () => {
	const { result } = await runItem({ receipts: [{ name: "main", sessionId: SESSION, noop: true }], exitCode: 1 });
	assert.equal(result.pass, false);
	assert.equal(result.failureClass, "runner_failed");
	assert.equal(result.metrics["result.noop"], true);
	assert.equal(result.artifacts.failureReason, undefined);
});

test("eval noop: a no-op without blocked calls says no mutating call succeeded", () => {
	const base = receipt({ name: "main", sessionId: SESSION, noop: true }) as unknown as RunReceipt;
	assert.equal(
		noopFailureReason({ ...base, safety: { ...base.safety, blockedAttempts: [] } } as RunReceipt),
		"no-op run: no mutating tool call succeeded",
	);
	const many = Array.from({ length: 7 }, () => BLOCKED);
	assert.match(
		noopFailureReason({
			...base,
			safety: { ...base.safety, blockedAttempts: many, blockedAttemptsTruncated: 3 },
		} as RunReceipt),
		/; and 5 more$/u,
	);
});
