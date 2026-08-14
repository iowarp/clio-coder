import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadWithSqliteWarningSuppressed, TraceStore } from "../../src/domains/observability/trace-store.js";
import { runCli } from "../harness/spawn.js";

/**
 * E1 and slice-3 S1 recorded the same line twice: loading `node:sqlite` emits
 * an ExperimentalWarning that lands on the operator's stderr in the middle of
 * `clio trace` output, on a fresh install, about a Node internal they never
 * chose. `databaseSyncConstructor` is the one load site every path reaches, so
 * one narrow filter closes both residuals.
 */
describe("contracts/trace/sqlite experimental warning", () => {
	const sqliteWarning = "SQLite is an experimental feature and might change at any time";

	it("drops the SQLite warning and forwards every other warning from the same window", () => {
		const original = process.emitWarning;
		const seen: string[] = [];
		process.emitWarning = ((warning: string | Error, type?: unknown) => {
			seen.push(`${typeof warning === "string" ? warning : warning.message}|${String(type)}`);
		}) as typeof process.emitWarning;
		try {
			const result = loadWithSqliteWarningSuppressed(() => {
				process.emitWarning(sqliteWarning, "ExperimentalWarning");
				process.emitWarning("Blob is an experimental feature", "ExperimentalWarning");
				process.emitWarning("something is deprecated", "DeprecationWarning");
				// Node's other emitWarning shape: an Error plus an options object.
				process.emitWarning(new Error(sqliteWarning), { type: "ExperimentalWarning" });
				return "loaded";
			});
			strictEqual(result, "loaded");
			deepStrictEqual(seen, [
				"Blob is an experimental feature|ExperimentalWarning",
				"something is deprecated|DeprecationWarning",
			]);
		} finally {
			process.emitWarning = original;
		}
	});

	it("hands the global back even when the load throws", () => {
		const original = process.emitWarning;
		try {
			loadWithSqliteWarningSuppressed(() => {
				throw new Error("load failed");
			});
			ok(false, "the load error must reach the caller");
		} catch (error) {
			strictEqual(error instanceof Error ? error.message : null, "load failed");
		}
		strictEqual(process.emitWarning, original);
	});

	/**
	 * `--trace-warnings` asks for more warning detail, not less. Suppressing a
	 * warning the operator explicitly asked to trace is the one case where this
	 * filter would be lying, so it stands down entirely.
	 */
	it("stands down when the operator asked to trace warnings", () => {
		const originalEmit = process.emitWarning;
		const originalOptions = process.env.NODE_OPTIONS;
		const seen: string[] = [];
		process.emitWarning = ((warning: string | Error) => {
			seen.push(typeof warning === "string" ? warning : warning.message);
		}) as typeof process.emitWarning;
		process.env.NODE_OPTIONS = "--stack-size=2000 --trace-warnings";
		try {
			loadWithSqliteWarningSuppressed(() => {
				process.emitWarning(sqliteWarning, "ExperimentalWarning");
			});
			deepStrictEqual(seen, [sqliteWarning]);
		} finally {
			process.emitWarning = originalEmit;
			if (originalOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = originalOptions;
		}
	});
});

describe("contracts/trace/sqlite experimental warning end to end", () => {
	let dir = "";
	let db = "";

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-trace-warn-"));
		db = join(dir, "trace.sqlite");
		const store = new TraceStore(db);
		store.close();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads a real trace database without leaking a Node warning onto stderr", async () => {
		const result = await runCli(["trace", "runs", "--db", db]);
		strictEqual(result.code, 0);
		match(result.stdout, /STATUS/);
		strictEqual(result.stderr, "", `stderr should be empty, got: ${result.stderr}`);
	});
});
