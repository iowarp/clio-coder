/**
 * `clio-coder trace` on an install where nothing has dispatched yet.
 *
 * Every read subcommand handed the absent `trace.sqlite` straight to
 * node:sqlite, so a fresh install got `trace database: unable to open database
 * file` and exit 1: a message naming neither the file it wanted nor a next
 * step, with the module's ExperimentalWarning leaking onto stderr behind it.
 * The absent default path is the empty state. A path the operator typed after
 * `--db` is a different claim and stays an error that says which path it means.
 */
import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TraceStore } from "../../src/domains/observability/trace-store.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const READ_SUBCOMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
	["trace", "runs"],
	["trace", "runs", "--limit", "5"],
	["trace", "phases", "nosuchrun"],
	["trace", "procs", "nosuchrun"],
	["trace", "sql", "SELECT 1"],
];

describe("contracts/cli-trace", () => {
	const scratch = makeScratchHome("clio-trace-cli-");
	const defaultDb = join(scratch.dir, "state", "trace.sqlite");
	after(() => scratch.cleanup());

	for (const args of READ_SUBCOMMANDS) {
		it(`clio-coder ${args.join(" ")} names the empty state and the absolute path it read`, async () => {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			match(result.stdout, /^no trace database yet at /);
			match(result.stdout, new RegExp(defaultDb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			// Session turns land in the same table since D2, so the empty state names
			// both ways a row appears rather than dispatch alone.
			match(result.stdout, /rows are recorded when a dispatch executes or an interactive turn runs/);
			// The empty state must not load node:sqlite, whose ExperimentalWarning
			// is the only Node internal this CLI ever leaked to a user.
			strictEqual(result.stderr, "", `unexpected stderr: ${result.stderr}`);
		});
	}

	it("distinguishes an explicit --db that is not there from having no trace yet", async () => {
		const missing = join(scratch.dir, "nowhere", "trace.sqlite");
		for (const args of [
			["trace", "runs", "--db", missing],
			["trace", "runs", `--db=${missing}`],
		]) {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, new RegExp(`trace database not found: ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			doesNotMatch(result.stderr, /no trace database yet/);
			doesNotMatch(result.stderr, /ExperimentalWarning/);
			// The remedy names the path the operator would have read without --db.
			match(result.stderr, new RegExp(defaultDb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
	});

	it("still reads a database that exists", async () => {
		const db = join(scratch.dir, "existing.sqlite");
		new TraceStore(db).close();
		const result = await runCli(["trace", "runs", "--db", db], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /^STATUS {3}STARTED/);
	});
});
