/**
 * Destructive-transition safety for `clio reset` and `clio uninstall`.
 *
 * Every case here begins after something has already gone wrong: a path that
 * will not delete, or a launcher symlink that belongs to somebody else. None
 * of them is reachable from a healthy machine, which is how a half-finished
 * delete kept reporting success and an ownership test three ways too broad
 * kept unlinking other installations' launchers.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

/**
 * Whether the path itself is there, which `existsSync` does not answer: it
 * follows the link and calls a dangling one absent. Asserting removal with
 * `existsSync` passes whether or not the link was removed, which is how a
 * dangling launcher survived an uninstall that reported removing it.
 */
function linkPresent(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

describe("clio destructive-transition safety", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome("clio-lifecycle-");
	});

	afterEach(() => {
		// A test that made a directory unwritable has to hand the permission
		// back, or the scratch cleanup inherits the same failure it was testing.
		for (const relative of ["data/memory", "data", "state", "config", "cache"]) {
			try {
				chmodSync(join(scratch.dir, relative), 0o700);
			} catch {
				// Absent by design in most of these tests.
			}
		}
		scratch.cleanup();
	});

	it("reports every path a reset could not remove and keeps going past the first failure", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const locked = join(scratch.dir, "data", "memory", "locked");
		mkdirSync(locked, { recursive: true });
		writeFileSync(join(locked, "record.json"), "{}\n", "utf8");
		const cacheMarker = join(scratch.dir, "cache", "marker.txt");
		writeFileSync(cacheMarker, "cache marker\n", "utf8");
		chmodSync(join(scratch.dir, "data", "memory"), 0o500);

		const result = await runCli(["reset", "--data", "--cache", "--force"], { env: scratch.env });

		strictEqual(result.code, 1, `partial deletion must not exit 0; stdout=${result.stdout}`);
		match(result.stderr, /did not remove everything/);
		match(result.stderr, /1 path\(s\) could not be removed/);
		match(result.stderr, /data\s+.*data/);
		match(result.stderr, /clio reset --data --cache --force/);
		ok(existsSync(locked), "the path that refused to delete is still named as surviving");
		strictEqual(existsSync(cacheMarker), false, "a later root is still attempted after an earlier one fails");
		ok(existsSync(join(scratch.dir, "cache")), "the skeleton is rebuilt even after a partial failure");
	});

	it("keeps a launcher symlink that points at a different clio installation", async () => {
		const binDir = join(scratch.dir, "bin");
		const launcher = join(binDir, "clio");
		const foreign = join(scratch.dir, "other-clio", "dist", "cli", "index.js");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(join(scratch.dir, "other-clio", "dist", "cli"), { recursive: true });
		writeFileSync(foreign, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o755 });
		await runCli(["doctor", "--fix"], { env: scratch.env });
		symlinkSync(foreign, launcher);

		const result = await runCli(["uninstall", "--remove-binary", "--force"], {
			env: { ...scratch.env, CLIO_BIN_DIR: binDir },
		});

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /binary\s+keep/);
		match(result.stdout, /not this installation/);
		match(result.stdout, new RegExp(`rm ${launcher.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		ok(existsSync(launcher), "another installation's launcher survives this installation's uninstall");
		ok(existsSync(foreign), "and so does the installation it points at");
	});

	it("keeps a launcher symlink whose target is a directory named like a clio entry", async () => {
		const binDir = join(scratch.dir, "bin");
		const launcher = join(binDir, "clio");
		// The old ownership test was a suffix match on the target path, so a
		// directory carrying the entry's name passed it and was unlinked.
		const trap = join(scratch.dir, "trap", "dist", "cli", "index.js");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(trap, { recursive: true });
		await runCli(["doctor", "--fix"], { env: scratch.env });
		symlinkSync(trap, launcher);

		const result = await runCli(["uninstall", "--remove-binary", "--force"], {
			env: { ...scratch.env, CLIO_BIN_DIR: binDir },
		});

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /binary\s+keep/);
		ok(existsSync(launcher), "a symlink to a directory is never a launcher this installation owns");
	});

	it("removes a dangling launcher symlink that names a clio entry", async () => {
		const binDir = join(scratch.dir, "bin");
		const launcher = join(binDir, "clio");
		mkdirSync(binDir, { recursive: true });
		await runCli(["doctor", "--fix"], { env: scratch.env });
		symlinkSync(join(scratch.dir, "removed-install", "dist", "cli", "index.js"), launcher);

		const result = await runCli(["uninstall", "--remove-binary", "--force"], {
			env: { ...scratch.env, CLIO_BIN_DIR: binDir },
		});

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /binary\s+remove/);
		match(result.stdout, /dangling/);
		// lstat, not exists: `rmSync` with `force: true` stats through the link,
		// sees ENOENT, and returns as though the path were already gone, so the
		// link stayed on PATH while the command reported removing it.
		strictEqual(linkPresent(join(binDir, "clio")), false, "a broken clio launcher does not survive uninstall");
	});

	it("removes the launcher symlink that points at this installation", async () => {
		const binDir = join(scratch.dir, "bin");
		const launcher = join(binDir, "clio");
		mkdirSync(binDir, { recursive: true });
		await runCli(["doctor", "--fix"], { env: scratch.env });
		symlinkSync(CLI_ENTRY, launcher);

		const result = await runCli(["uninstall", "--remove-binary", "--force"], {
			env: { ...scratch.env, CLIO_BIN_DIR: binDir },
		});

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /binary\s+remove/);
		strictEqual(existsSync(launcher), false);
		// The flag it just honored is not offered again as a remaining step.
		ok(
			!result.stdout.includes("source symlink:  clio uninstall --remove-binary --force"),
			"guidance must not re-suggest the flag that already ran",
		);
	});
});
