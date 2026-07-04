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
			deepStrictEqual(runOverrides(), { maxContextTokens: 111, kvCacheMode: "q4_0" });
		} finally {
			if (previous === undefined) delete process.env[RUN_OVERRIDES_ENV];
			else process.env[RUN_OVERRIDES_ENV] = previous;
		}
	});
});
