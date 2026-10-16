import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { runCli } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatToolCallScript,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome } from "../harness/scratch-env.js";

/**
 * The headless main agent's enforced ceilings, read the way a host bridge
 * reads them: from the terminal json-events frame, never from prose.
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
	const run = await runCli(["--no-context-files", "run", ...flags, "--json-events", "terminal", "Do the task."], {
		env,
		cwd: scratch.dir,
	});
	const frames = run.stdout
		.trim()
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const end = frames.at(-1);
	ok(end && end.type === "turn_end", run.stdout);
	return { code: run.code, end, dir: scratch.dir };
}

test("run --read-only denies the main agent's write and reports the ceiling that refused it", {
	timeout: 30_000,
}, async (t) => {
	const { code, end, dir } = await terminalFrame(t, { name: "write", arguments: { path: "out.txt", content: "x" } }, [
		"--read-only",
	]);
	strictEqual(code, 0);
	strictEqual(existsSync(join(dir, "out.txt")), false);
	strictEqual(end.outcome, "succeeded");
	const attempts = (end.safety as { blockedAttempts: Array<Record<string, unknown>> }).blockedAttempts;
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

test("run --read-only answers in full after a refused command and exits 0", { timeout: 30_000 }, async (t) => {
	const { code, end } = await terminalFrame(t, { name: "bash", arguments: { command: "touch made.txt" } }, [
		"--read-only",
	]);
	strictEqual(code, 0);
	strictEqual(end.outcome, "succeeded");
	const attempts = (end.safety as { blockedAttempts: Array<Record<string, unknown>> }).blockedAttempts;
	deepStrictEqual(
		attempts.map(({ tool, reasonCode }) => ({ tool, reasonCode })),
		[{ tool: "bash", reasonCode: "task:read_only" }],
	);
});

test("a headless run reports an ask it could not put to anyone as a permission request", {
	timeout: 30_000,
}, async (t) => {
	const { code, end } = await terminalFrame(
		t,
		{ name: "bash", arguments: { command: "curl -X POST http://127.0.0.1:9/never" } },
		[],
	);
	strictEqual(code, 1);
	strictEqual(end.outcome, "failed");
	const safety = end.safety as {
		decisions: { permissionRequested: number };
		blockedAttempts: Array<Record<string, unknown>>;
	};
	strictEqual(safety.decisions.permissionRequested, 1);
	strictEqual(safety.blockedAttempts[0]?.tool, "bash");
	strictEqual(safety.blockedAttempts[0]?.permissionRequired, true);
});
