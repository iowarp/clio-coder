import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { inspectRunEvidence } from "../../src/domains/evidence/run-evidence.js";
import { runCli, sealedReceipt } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatToolCallScript,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome } from "../harness/scratch-env.js";

/**
 * The headless main agent's enforced ceilings, read the way a host bridge
 * reads them: from the schema v2 envelope and the sealed receipt, never from prose.
 */
async function terminalFrame(t: TestContext, toolCall: OpenAICompatToolCallScript, flags: string[]) {
	const scratch = makeScratchHome("clio-headless-ceilings-");
	t.after(scratch.cleanup);
	const env = {
		...process.env,
		...scratch.env,
		NODE_ENV: "test",
		NO_COLOR: "1",
		CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
	};
	const initialized = await runCli(["doctor", "--fix"], { env, cwd: scratch.dir });
	strictEqual(initialized.code, 0, initialized.stderr);
	const fixture = await startOpenAICompatFixture("done", { toolCall });
	t.after(() => closeServer(fixture.server));
	seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url, "default");
	const run = await runCli(["--no-context-files", "run", ...flags, "--output-format", "json", "Do the task."], {
		env,
		cwd: scratch.dir,
	});
	const frames = run.stdout
		.trim()
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const end = frames.at(-1);
	ok(end && end.type === "run_end" && end.schemaVersion === 3, run.stdout);
	return { code: run.code, end, dir: scratch.dir, receipt: sealedReceipt(join(scratch.dir, "state")).receipt };
}

test("run --read-only denies the main agent's write and reports the ceiling that refused it", {
	timeout: 30_000,
}, async (t) => {
	const { code, end, dir, receipt } = await terminalFrame(
		t,
		{ name: "write", arguments: { path: "out.txt", content: "x" } },
		["--read-only"],
	);
	strictEqual(code, 0);
	strictEqual(existsSync(join(dir, "out.txt")), false);
	strictEqual(end.outcome, "succeeded");
	const attempts = receipt.settled.blockedAttempts as unknown as Array<Record<string, unknown>>;
	deepStrictEqual(
		attempts.map(({ tool, actionClass, reasonCode, permissionRequired }) => ({
			tool,
			actionClass,
			reasonCode,
			permissionRequired,
		})),
		[{ tool: "write", actionClass: "write", reasonCode: "task:read_only", permissionRequired: undefined }],
	);
});

// Read-only runs a shell command in a read-only sandbox where one exists and refuses it where none does;
// either way the workspace is unchanged and the run still answers in full.
test("run --read-only answers in full after a shell write and leaves the workspace unchanged", {
	timeout: 30_000,
}, async (t) => {
	const { code, end, dir } = await terminalFrame(t, { name: "bash", arguments: { command: "touch made.txt" } }, [
		"--read-only",
	]);
	strictEqual(code, 0);
	strictEqual(end.outcome, "succeeded");
	strictEqual(existsSync(join(dir, "made.txt")), false);
});

test("a headless run reports an ask it could not put to anyone as a permission request", {
	timeout: 30_000,
}, async (t) => {
	const { code, end, dir, receipt } = await terminalFrame(
		t,
		{ name: "bash", arguments: { command: "curl -X POST http://127.0.0.1:9/never" } },
		[],
	);
	strictEqual(code, 1);
	strictEqual(end.outcome, "failed");
	// The v2 envelope carries no safety summary; the sealed receipt is the record a host reads it from.
	const safety = receipt.settled as unknown as {
		blockedAttempts: Array<Record<string, unknown>>;
		permissionRequestedAttempts?: Array<Record<string, unknown>>;
	};
	// bt-15 c13a: the refused ask is listed as a refused ask, never as a safety refusal.
	strictEqual(safety.permissionRequestedAttempts?.length, 1);
	deepStrictEqual(safety.blockedAttempts, []);
	// The sealed record lists the ask under permissionRequestedAttempts; that list is what marks it as a refused ask.
	deepStrictEqual(
		safety.permissionRequestedAttempts?.map(({ tool }) => tool),
		["bash"],
	);
	// The sealed record's tools row does not count the ask as a blocked call (bt-15 c14a).
	strictEqual(receipt.settled.tools.find((row) => row.tool === "bash")?.blocked, 0);
	// FX-3: the row still sums, and evidence counts the refused ask as a call that did not run, as the run line does.
	strictEqual(receipt.settled.tools.find((row) => row.tool === "bash")?.asked, 1);
	const evidence = await inspectRunEvidence(join(dir, "state"), receipt.row.runId);
	strictEqual(evidence.totals?.blockedToolCalls, 1);
});
