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
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
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
/** Every file under `dir`, recursively, for before/after side-effect diffs. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(full));
		else out.push(full);
	}
	return out;
}

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

	/**
	 * `--dry-run` is documented as a preview that changes nothing, and it
	 * shelled out to `npm config get prefix` for the removal guidance. npm
	 * writes a debug log into `$HOME/.npm/_logs` on every invocation, so the
	 * preview left a file in the home directory it had just finished promising
	 * not to touch, and one under `.npm` at that.
	 */
	it("writes no npm cache files when the dry-run probes the npm prefix", async () => {
		const home = join(scratch.dir, "fake-home");
		const npmCache = join(home, "npm-cache");
		mkdirSync(home, { recursive: true });
		// npm_config_cache is pinned because npm exports its own to every child of
		// an npm script, so an unpinned run under `npm run test` sends the debug
		// log to the developer's real ~/.npm and the assertion below would pass
		// while the litter landed somewhere worse.
		const env = { ...scratch.env, HOME: home, npm_config_cache: npmCache };
		await runCli(["doctor", "--fix"], { env });
		const before = filesUnder(home);

		const result = await runCli(["uninstall", "--dry-run"], { env });

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /uninstall preview complete/);
		// The probe still has to run; only its litter is gone.
		match(result.stdout, /npm prefix bin:/);
		const added = filesUnder(home).filter((path) => !before.includes(path));
		strictEqual(added.length, 0, `a side-effect-free preview wrote: ${added.join(", ")}`);
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

	/**
	 * A bare `clio reset` selects `--state` and takes every transcript on the
	 * machine. The preview for that was one line naming the root, and the note
	 * explaining the cost was attached to `--data`, the scope nobody gets by
	 * accident.
	 */
	it("shows what a default reset is about to take, and says what losing it costs", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		mkdirSync(join(scratch.dir, "state", "sessions", "hash-a", "session-1"), { recursive: true });
		writeFileSync(join(scratch.dir, "state", "runs.json"), "[]\n", "utf8");

		const result = await runCli(["reset", "--dry-run"], { env: scratch.env });

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /note: the state root holds every session transcript/);
		// The contents are read off the root, so the subdirectories the help text
		// never mentioned are in the preview.
		match(result.stdout, /sessions\/ \(1\)/);
		match(result.stdout, /interviews\//);
		match(result.stdout, /scratch\//);
		match(result.stdout, /runs\.json/);
		ok(existsSync(join(scratch.dir, "state", "runs.json")), "a preview removes nothing");
	});

	/**
	 * Uninstall removes four roots under the home directory, so every per-project
	 * `.clio/` survived it unlisted, and `--remove-binary` removed the binary that
	 * runs `clio context reset --all` before naming it.
	 */
	it("lists the project directories it is not removing, and names the cleaner before the binary", async () => {
		const binDir = join(scratch.dir, "bin");
		const launcher = join(binDir, "clio");
		const project = join(scratch.dir, "a-project");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(join(project, ".clio"), { recursive: true });
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const sessionDir = join(scratch.dir, "state", "sessions", "hash-a", "session-1");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "meta.json"),
			JSON.stringify({ id: "session-1", cwd: project, cwdHash: "hash-a" }),
			"utf8",
		);
		symlinkSync(CLI_ENTRY, launcher);

		const preview = await runCli(["uninstall", "--remove-binary", "--dry-run"], {
			env: { ...scratch.env, CLIO_BIN_DIR: binDir },
		});
		strictEqual(preview.code, 0, `stderr=${preview.stderr}`);
		ok(preview.stdout.includes(join(project, ".clio")), `preview lists the project: ${preview.stdout}`);
		ok(preview.stdout.includes("clio context reset --all"), preview.stdout);
		ok(existsSync(join(project, ".clio")), "and the preview removes none of it");

		const result = await runCli(["uninstall", "--remove-binary", "--force"], {
			env: { ...scratch.env, CLIO_BIN_DIR: binDir },
		});
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const cleaner = result.stdout.indexOf("clio context reset --all");
		const binary = result.stdout.search(/binary\s+remove/);
		ok(cleaner >= 0 && binary >= 0, result.stdout);
		ok(cleaner < binary, "the cleaner is named while the binary that runs it is still there");
		// Reading the record is this command's job; deleting the project's is not.
		ok(existsSync(join(project, ".clio")), "uninstall never removes project data itself");
		strictEqual(existsSync(launcher), false);
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
