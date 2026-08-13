/**
 * `clio doctor` is the command a user runs to find out whether anything is
 * wrong, so a green row it cannot back up is worse than no row at all.
 *
 * The failures these cover: `touch $CLIO_CACHE_DIR` produced `OK cache dir` and
 * exit 0, then `clio doctor --fix` one command later died on "Expected
 * directory" and printed no report; a mode-000 state root also read `OK`; and
 * the metadata row said "missing" about an install.json that was present and
 * merely unreadable, pointing at a `--fix` that fails the same way.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("clio doctor honesty about its own roots", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome("clio-doctor-honesty-");
	});

	afterEach(() => {
		for (const relative of ["state", "data", "config", "cache"]) {
			try {
				chmodSync(join(scratch.dir, relative), 0o700);
			} catch {
				// Absent by design in some of these.
			}
		}
		scratch.cleanup();
	});

	function rowFor(stdout: string, name: string): string {
		const row = stdout.split("\n").find((line) => line.includes(name));
		ok(row !== undefined, `expected a "${name}" row in:\n${stdout}`);
		return row;
	}

	it("calls a root that is a regular file a failure, not an OK directory", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		rmSync(join(scratch.dir, "cache"), { recursive: true, force: true });
		writeFileSync(join(scratch.dir, "cache"), "not a directory\n", "utf8");

		const result = await runCli(["doctor"], { env: scratch.env });
		strictEqual(result.code, 1, "a root that cannot hold anything is not a healthy install");
		const row = rowFor(result.stdout, "cache dir");
		ok(!row.startsWith("OK"), `cache dir must not report OK: ${row}`);
		match(row, /is a regular file, not a directory/u);
	});

	it("calls a root it cannot traverse a failure", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		chmodSync(join(scratch.dir, "state"), 0o000);

		const result = await runCli(["doctor"], { env: scratch.env });
		strictEqual(result.code, 1);
		const row = rowFor(result.stdout, "state dir");
		ok(!row.startsWith("OK"), `state dir must not report OK: ${row}`);
		match(row, /is not readable or writable or traversable/u);
	});

	// A row that says only "unusable" tells the operator it is unhappy without
	// telling them what to change, so the permissions actually missing are named.
	it("names which permission a root is missing rather than one string for all of them", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const cache = join(scratch.dir, "cache");

		chmodSync(cache, 0o555);
		const readOnly = await runCli(["doctor"], { env: scratch.env });
		match(rowFor(readOnly.stdout, "cache dir"), /is not writable \(/u);

		chmodSync(cache, 0o000);
		const noAccess = await runCli(["doctor"], { env: scratch.env });
		const noAccessRow = rowFor(noAccess.stdout, "cache dir");
		match(noAccessRow, /is not readable or writable or traversable/u);
		ok(
			rowFor(readOnly.stdout, "cache dir") !== noAccessRow,
			"a read-only root and an inaccessible one must not print the same string",
		);
	});

	it("still prints the full report when --fix cannot finish", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		rmSync(join(scratch.dir, "data"), { recursive: true, force: true });
		writeFileSync(join(scratch.dir, "data"), "not a directory\n", "utf8");

		const result = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(result.code, 1);
		match(result.stdout, /--fix could not finish/u);
		// The point of surviving the throw is that the rows below it still say
		// which root is wrong.
		match(rowFor(result.stdout, "data dir"), /is a regular file, not a directory/u);
		ok(result.stdout.includes("Clio Coder version"), "the report is not truncated by the failed repair");
	});

	it("distinguishes install metadata that is unreadable from metadata that is absent", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const installJson = join(scratch.dir, "state", "install.json");

		chmodSync(installJson, 0o000);
		const unreadable = await runCli(["doctor"], { env: scratch.env });
		strictEqual(unreadable.code, 1);
		const unreadableRow = rowFor(unreadable.stdout, "state metadata");
		match(unreadableRow, /could not be read/u);
		ok(!unreadableRow.includes("missing"), `present-but-unreadable must not be reported as missing: ${unreadableRow}`);

		chmodSync(installJson, 0o600);
		rmSync(installJson);
		const absent = await runCli(["doctor"], { env: scratch.env });
		strictEqual(absent.code, 1);
		match(rowFor(absent.stdout, "state metadata"), /missing \(run `clio doctor --fix`\)/u);
	});

	it("still reports every root OK on a healthy install", async () => {
		const fixed = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(fixed.code, 0, `a repaired install is healthy:\n${fixed.stdout}${fixed.stderr}`);
		for (const name of ["config dir", "data dir", "state dir", "cache dir"]) {
			ok(rowFor(fixed.stdout, name).startsWith("OK"), `${name} should be OK after --fix`);
		}
		// A root Clio created and can use must not trip the new usability check.
		mkdirSync(join(scratch.dir, "cache", "sub"), { recursive: true });
		const again = await runCli(["doctor"], { env: scratch.env });
		strictEqual(again.code, 0);
	});
});
