import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { runClioRun } from "../../src/cli/run.js";
import { RUN_OVERRIDES_ENV, runOverrides } from "../../src/core/run-overrides.js";

function captureStdout<T>(fn: () => T | Promise<T>): Promise<{ result: T; stdout: string }> {
	const original = process.stdout.write.bind(process.stdout);
	let stdout = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	return Promise.resolve()
		.then(fn)
		.then((result) => ({ result, stdout }))
		.finally(() => {
			process.stdout.write = original;
		});
}

describe("contracts/run CLI args", () => {
	it("parses resource and steer flags", () => {
		const parsed = parseRunCliArgs([
			"--max-context-tokens",
			"32768",
			"--kv-cache-mode",
			"q8_0",
			"--steer-channel",
			"/tmp/clio-steer",
			"do work",
		]);
		strictEqual(parsed.maxContextTokens, 32768);
		strictEqual(parsed.kvCacheMode, "q8_0");
		strictEqual(parsed.steerChannel, "/tmp/clio-steer");
		deepStrictEqual(parsed.messages, ["do work"]);
		deepStrictEqual(parsed.diagnostics, []);
	});

	it("parses terminal JSON event mode as an additive JSON selector", () => {
		const parsed = parseRunCliArgs(["--json-events", "terminal", "do work"]);
		strictEqual(parsed.json, true);
		strictEqual(parsed.jsonEvents, "terminal");
		deepStrictEqual(parsed.messages, ["do work"]);
		deepStrictEqual(parsed.diagnostics, []);
	});

	it("parses only the four explicit one-run autonomy levels", () => {
		for (const level of ["read-only", "suggest", "auto-edit", "full-auto"] as const) {
			const parsed = parseRunCliArgs(["--autonomy", level, "do work"]);
			strictEqual(parsed.autonomy, level);
			deepStrictEqual(parsed.messages, ["do work"]);
			deepStrictEqual(parsed.diagnostics, []);
		}

		const invalid = parseRunCliArgs(["--autonomy", "unrestricted", "do work"]);
		strictEqual(invalid.autonomy, undefined);
		ok(
			invalid.diagnostics.some(
				(diagnostic) =>
					diagnostic.type === "error" &&
					diagnostic.message === "--autonomy must be one of: read-only|suggest|auto-edit|full-auto",
			),
		);
		const missing = parseRunCliArgs(["--autonomy", "--target", "local", "do work"]);
		strictEqual(missing.autonomy, undefined);
		strictEqual(missing.target, "local");
		ok(missing.diagnostics.some((diagnostic) => diagnostic.message === "--autonomy requires a value"));
	});

	it("rejects unknown JSON event modes", () => {
		const parsed = parseRunCliArgs(["--json-events", "deltas", "do work"]);
		strictEqual(parsed.json, true);
		strictEqual(parsed.jsonEvents, "full");
		ok(
			parsed.diagnostics.some(
				(diagnostic) => diagnostic.type === "error" && diagnostic.message === "--json-events must be one of: full|terminal",
			),
		);
	});

	it("rejects non-positive and non-integer max context values", () => {
		for (const value of ["0", "-1", "2.5", "abc"]) {
			const parsed = parseRunCliArgs(["--max-context-tokens", value, "task"]);
			strictEqual(parsed.maxContextTokens, undefined);
			ok(
				parsed.diagnostics.some(
					(diagnostic) =>
						diagnostic.type === "error" && diagnostic.message === "--max-context-tokens must be a positive integer",
				),
				`missing diagnostic for ${value}`,
			);
		}
	});

	it("does not consume a following option as a missing run flag value", () => {
		const parsed = parseRunCliArgs(["--skill", "--target", "local", "do work"]);
		deepStrictEqual(parsed.skillPaths, []);
		strictEqual(parsed.target, "local");
		deepStrictEqual(parsed.messages, ["do work"]);
		ok(parsed.diagnostics.some((diagnostic) => diagnostic.message === "--skill requires a value"));
	});

	it("keeps negative numeric flag values available for numeric validation", () => {
		const parsed = parseRunCliArgs(["--presence-penalty", "-1", "do work"]);
		strictEqual(parsed.sampling?.presencePenalty, -1);
		deepStrictEqual(parsed.messages, ["do work"]);
		deepStrictEqual(parsed.diagnostics, []);
	});

	it("documents resource and steer flags in run help and restores run overrides", async () => {
		// Pre-existing run overrides in scope (e.g. a caller already inside
		// withRunOverrides) must survive a nested clio run invocation untouched.
		const previous = process.env[RUN_OVERRIDES_ENV];
		process.env[RUN_OVERRIDES_ENV] = JSON.stringify({ maxContextTokens: 111, kvCacheMode: "q4_0" });
		try {
			const { result, stdout } = await captureStdout(() =>
				runClioRun(["--max-context-tokens", "222", "--kv-cache-mode", "q8_0", "--help"]),
			);
			strictEqual(result, 0);
			ok(stdout.includes("--max-context-tokens <N>"));
			ok(stdout.includes("--kv-cache-mode <mode>"));
			ok(stdout.includes("--steer-channel <path>"));
			ok(stdout.includes("--json-events <mode>"));
			ok(stdout.includes("--autonomy <level>"));
			deepStrictEqual(runOverrides(), { maxContextTokens: 111, kvCacheMode: "q4_0" });
		} finally {
			if (previous === undefined) delete process.env[RUN_OVERRIDES_ENV];
			else process.env[RUN_OVERRIDES_ENV] = previous;
		}
	});
	it("session continuity is a named flag, and the two forms are mutually exclusive", async () => {
		const byId = parseRunCliArgs(["--session", "abc123", "keep going"]);
		strictEqual(byId.sessionId, "abc123");
		strictEqual(byId.continueSession, false);
		deepStrictEqual(byId.diagnostics, []);

		const latest = parseRunCliArgs(["--continue", "keep going"]);
		strictEqual(latest.sessionId, undefined);
		strictEqual(latest.continueSession, true);

		const fresh = parseRunCliArgs(["do work"]);
		strictEqual(fresh.sessionId, undefined);
		strictEqual(fresh.continueSession, false);

		const { result: bothForms } = await captureStdout(() =>
			runClioRun(["--session", "abc123", "--continue", "keep going"]),
		);
		strictEqual(bothForms, 2, "naming two different sessions is refused, not resolved");

		const { result: withDispatch } = await captureStdout(() =>
			runClioRun(["--continue", "--agent", "scout", "keep going"]),
		);
		strictEqual(withDispatch, 2, "a dispatched agent has no main-agent session to continue");

		const { result, stdout } = await captureStdout(() => runClioRun(["--help"]));
		strictEqual(result, 0);
		ok(stdout.includes("--session <id>"));
		ok(stdout.includes("--continue"));
	});
});
