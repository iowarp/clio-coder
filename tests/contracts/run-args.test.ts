import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { runClioRun } from "../../src/cli/run.js";

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

	it("documents resource and steer flags in run help and restores env overrides", async () => {
		const previousMax = process.env.CLIO_MAX_CONTEXT_TOKENS;
		const previousKv = process.env.CLIO_KV_CACHE_MODE;
		process.env.CLIO_MAX_CONTEXT_TOKENS = "111";
		process.env.CLIO_KV_CACHE_MODE = "q4_0";
		try {
			const { result, stdout } = await captureStdout(() =>
				runClioRun(["--max-context-tokens", "222", "--kv-cache-mode", "q8_0", "--help"]),
			);
			strictEqual(result, 0);
			ok(stdout.includes("--max-context-tokens <N>"));
			ok(stdout.includes("--kv-cache-mode <mode>"));
			ok(stdout.includes("--steer-channel <path>"));
			strictEqual(process.env.CLIO_MAX_CONTEXT_TOKENS, "111");
			strictEqual(process.env.CLIO_KV_CACHE_MODE, "q4_0");
		} finally {
			if (previousMax === undefined) delete process.env.CLIO_MAX_CONTEXT_TOKENS;
			else process.env.CLIO_MAX_CONTEXT_TOKENS = previousMax;
			if (previousKv === undefined) delete process.env.CLIO_KV_CACHE_MODE;
			else process.env.CLIO_KV_CACHE_MODE = previousKv;
		}
	});
});
