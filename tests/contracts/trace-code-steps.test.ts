import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runTraceCommand } from "../../src/cli/trace.js";
import type { CodeStepRecord } from "../../src/domains/dispatch/code-step.js";
import { readCodeStepRecords, writeCodeStepRecord } from "../../src/domains/dispatch/code-step-store.js";

/** Runs one trace invocation with stdout and stderr captured. */
async function capture(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const outWrite = process.stdout.write;
	const errWrite = process.stderr.write;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await runTraceCommand(args);
		return { code, stdout, stderr };
	} finally {
		process.stdout.write = outWrite;
		process.stderr.write = errWrite;
	}
}

function record(overrides: Partial<CodeStepRecord>): CodeStepRecord {
	return {
		version: 1,
		runId: "run-1",
		stepId: "lint",
		commandId: "npm-lint",
		argv: ["npm", "run", "lint"],
		cwd: "/work",
		envNames: ["PATH"],
		timeoutMs: 60_000,
		startedAt: "2026-09-02T10:00:00.000Z",
		endedAt: "2026-09-02T10:00:01.000Z",
		durationMs: 1000,
		exitCode: 0,
		signal: null,
		timedOut: false,
		outputBytes: 12,
		outputTruncated: false,
		outputDigest: "a".repeat(64),
		artifactPaths: [],
		reportDigest: "b".repeat(64),
		...overrides,
	};
}

describe("contracts/trace code-steps reads the deterministic code-step records back", () => {
	let home = "";
	let previousHome: string | undefined;
	before(() => {
		home = mkdtempSync(join(tmpdir(), "clio-trace-code-steps-"));
		previousHome = process.env.CLIO_CODER_HOME;
		process.env.CLIO_CODER_HOME = home;
	});
	after(() => {
		if (previousHome === undefined) delete process.env.CLIO_CODER_HOME;
		else process.env.CLIO_CODER_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("requires a fleet root id and exits 2 without one, like the run-scoped subcommands", async () => {
		const result = await capture(["code-steps"]);
		strictEqual(result.code, 2);
		match(result.stderr, /trace code-steps requires a fleet root id/);
	});

	it("treats a root that never ran a code step as the empty state, not a failure", async () => {
		const result = await capture(["code-steps", "root-empty"]);
		strictEqual(result.code, 0);
		match(result.stdout, /no code-step records for fleet root root-empty/);
		const json = await capture(["code-steps", "root-empty", "--json"]);
		strictEqual(json.code, 0);
		deepStrictEqual(JSON.parse(json.stdout), []);
	});

	it("prints every record the writer persisted, oldest first, verbatim under --json", async () => {
		const later = record({ runId: "run-2", stepId: "test", startedAt: "2026-09-02T10:05:00.000Z", exitCode: 1 });
		const earlier = record({});
		await writeCodeStepRecord("root-a", later);
		await writeCodeStepRecord("root-a", earlier);
		deepStrictEqual(readCodeStepRecords("root-a"), [earlier, later]);

		const json = await capture(["code-steps", "root-a", "--json"]);
		strictEqual(json.code, 0);
		deepStrictEqual(JSON.parse(json.stdout), [earlier, later]);

		const table = await capture(["code-steps", "root-a"]);
		strictEqual(table.code, 0);
		const lines = table.stdout.trimEnd().split("\n");
		strictEqual(lines.length, 3);
		match(lines[0] ?? "", /^EXIT\s+DURATION\s+STARTED\s+STEP\s+COMMAND\s+ARGV$/);
		match(lines[1] ?? "", /^0\s+1000ms .*lint .*npm run lint$/);
		match(lines[2] ?? "", /^1\s+1000ms .*test .*npm run lint$/);
	});

	it("ignores --db, because the records are files beside the ledger and not rows in the mirror", async () => {
		const result = await capture(["code-steps", "root-a", "--db", join(home, "does-not-exist.sqlite"), "--json"]);
		strictEqual(result.code, 0);
		strictEqual((JSON.parse(result.stdout) as unknown[]).length, 2);
	});
});
