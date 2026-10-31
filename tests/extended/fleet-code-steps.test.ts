import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runFleetCodeSteps } from "../../src/cli/fleet-code-steps.js";
import type { EventPayload } from "../../src/core/telemetry/events.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { openFleetRootTelemetry } from "../../src/domains/dispatch/run-telemetry.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";

/** Runs one fleet code-steps invocation with stdout and stderr captured. */
async function capture(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const outWrite = process.stdout.write;
	const errWrite = process.stderr.write;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		if (typeof chunk !== "string") return outWrite.call(process.stdout, chunk);
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = runFleetCodeSteps(args);
		return { code, stdout, stderr };
	} finally {
		process.stdout.write = outWrite;
		process.stderr.write = errWrite;
	}
}

function record(overrides: Partial<EventPayload<"code_step.settled">>): EventPayload<"code_step.settled"> {
	return {
		runId: "run-1",
		stepId: "lint",
		commandId: "npm-lint",
		startedAt: "2026-09-02T10:00:00.000Z",
		durationMs: 1000,
		timeoutMs: 60_000,
		exitCode: 0,
		signal: null,
		timedOut: false,
		commands: [],
		outputBytes: 12,
		outputTruncated: false,
		outputDigest: "a".repeat(64),
		reportDigest: "b".repeat(64),
		...overrides,
	};
}

describe("contracts/fleet code-steps reads code_step.settled back from the fleet root journal", () => {
	let home = "";
	let previousHome: string | undefined;
	before(() => {
		home = mkdtempSync(join(tmpdir(), "clio-coder-fleet-code-steps-"));
		previousHome = process.env.CLIO_CODER_HOME;
		process.env.CLIO_CODER_HOME = home;
	});
	after(() => {
		if (previousHome === undefined) delete process.env.CLIO_CODER_HOME;
		else process.env.CLIO_CODER_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("requires a fleet root id and exits 2 without one, like the run-scoped subcommands", async () => {
		const result = await capture([]);
		strictEqual(result.code, 2);
		match(result.stderr, /fleet code-steps requires a fleet root id/);
	});

	it("treats a root that never ran a code step as the empty state, not a failure", async () => {
		const result = await capture(["root-empty"]);
		strictEqual(result.code, 0);
		match(result.stdout, /no code steps settled in the journal of fleet root root-empty/);
		const json = await capture(["root-empty", "--json"]);
		strictEqual(json.code, 0);
		deepStrictEqual(JSON.parse(json.stdout), []);
	});

	it("prints every settled code step, oldest first, under --json with its journal time", async () => {
		const later = record({ runId: "run-2", stepId: "test", startedAt: "2026-09-02T10:05:00.000Z", exitCode: 1 });
		const earlier = record({});
		const root = await openFleetRootTelemetry("root-a", null, telemetryRunDirectory(clioStateDir(), "root-a"));
		telemetryHub().emit("code_step.settled", later, root.context);
		telemetryHub().emit("code_step.settled", earlier, root.context);
		await root.close();

		const json = await capture(["root-a", "--json"]);
		strictEqual(json.code, 0);
		deepStrictEqual(
			(JSON.parse(json.stdout) as Array<Record<string, unknown>>).map(({ at: _at, ...data }) => data),
			[earlier, later],
		);

		const table = await capture(["root-a"]);
		strictEqual(table.code, 0);
		const lines = table.stdout.trimEnd().split("\n");
		strictEqual(lines.length, 3);
		match(lines[0] ?? "", /^EXIT\s+DURATION\s+STARTED\s+STEP\s+COMMAND\s+RUN$/);
		match(lines[1] ?? "", /^0\s+1000ms .*lint .*npm-lint\s+run-1$/);
		match(lines[2] ?? "", /^1\s+1000ms .*test .*npm-lint\s+run-2$/);
	});
});
