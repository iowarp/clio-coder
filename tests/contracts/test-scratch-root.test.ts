/**
 * The suite leaked its own scratch. 274 call sites do
 * `mkdtemp(join(tmpdir(), "clio-…"))` and most of them clean up; the ones that
 * throw, time out, or hand the directory to a child that outlives the assertion
 * do not, and this machine had 23,397 `clio-*` directories in /tmp from them.
 *
 * `tests/harness/tmp-root.ts` is loaded with `--import` ahead of every suite,
 * so `tmpdir()` resolves inside one per-run root that is removed at exit. These
 * cases pin the two halves of that: the redirect is live in this process, and
 * the delete refuses anything that is not a root this harness made.
 */
import { match, ok, strictEqual, throws } from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { isRemovableRoot, TEST_TMP_ROOT_PREFIX } from "../harness/tmp-root.js";

describe("contracts/test scratch root", () => {
	const strays: string[] = [];
	after(() => {
		for (const stray of strays) rmSync(stray, { recursive: true, force: true });
	});

	it("resolves every mkdtemp in this run inside one removable root", () => {
		// The suite is started with --import tmp-root.ts, so this holds in the
		// runner and in every test child without any test opting in.
		const root = process.env.CLIO_CODER_TEST_TMP_ROOT;
		ok(root, "the run has a scratch root");
		strictEqual(tmpdir(), root, "tmpdir() resolves to it, so untouched call sites land inside it");
		ok(basename(root).startsWith(TEST_TMP_ROOT_PREFIX), `root is named for the harness: ${root}`);

		const scratch = mkdtempSync(join(tmpdir(), "clio-leak-check-"));
		ok(scratch.startsWith(`${root}${sep}`), `a plain mkdtemp lands inside the root: ${scratch}`);
		ok(isRemovableRoot(root), "and the root the exit handler will remove is the one being written into");
	});

	it("refuses to recursively delete anything it did not make", () => {
		const outside = mkdtempSync(join(tmpdir(), "clio-outside-"));
		strays.push(outside);
		const wrongPrefix = join(outside, "not-a-run-root");
		mkdirSync(wrongPrefix);
		const link = join(outside, `${TEST_TMP_ROOT_PREFIX}link`);
		symlinkSync(wrongPrefix, link);

		// A nested mkdtemp is not a root, whatever it is named.
		strictEqual(isRemovableRoot(wrongPrefix), false, "the prefix is part of the identity");
		// A symlink wearing the right name would redirect the delete out of /tmp.
		strictEqual(isRemovableRoot(link), false, "a symlink is not a directory to walk");
		strictEqual(isRemovableRoot("/"), false);
		// The run root's parent is the system temp dir, which is never removable
		// however the name is spelled.
		strictEqual(isRemovableRoot(dirname(tmpdir())), false, "the temp dir itself is never the root");
		strictEqual(isRemovableRoot(join(outside, "absent")), false, "a path that is not there is not deleted");
		strictEqual(isRemovableRoot(""), false);
	});

	it("keeps ambient config and state untouched when a child uses Clio paths", () => {
		const canaryHome = mkdtempSync(join(tmpdir(), "clio-operator-canary-"));
		strays.push(canaryHome);
		const configDir = join(canaryHome, ".config", "clio-coder");
		const stateDir = join(canaryHome, ".local", "state", "clio-coder");
		const workspace = join(canaryHome, "workspace");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(workspace, { recursive: true });
		const settingsCanary = "version: operator-canary\n";
		const stateCanary = "operator-state-canary\n";
		writeFileSync(join(configDir, "settings.yaml"), settingsCanary, "utf8");
		writeFileSync(join(stateDir, "canary"), stateCanary, "utf8");

		const source = `
			import { writeFileSync } from "node:fs";
			import { join } from "node:path";
			import { updateLayeredSettings } from "./src/core/settings-layers.ts";
			import { clioStateDir } from "./src/core/xdg.ts";
			updateLayeredSettings(${JSON.stringify(workspace)}, (settings) => {
				settings.autonomy = "read-only";
			});
			writeFileSync(join(clioStateDir(), "child-probe"), "scratch state\\n", "utf8");
		`;
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: canaryHome };
		for (const key of [
			"CLIO_CODER_HOME",
			"CLIO_CODER_CONFIG_DIR",
			"CLIO_CODER_DATA_DIR",
			"CLIO_CODER_STATE_DIR",
			"CLIO_CODER_CACHE_DIR",
			"CLIO_CODER_REQUIRE_HOME_PREFIX",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"XDG_STATE_HOME",
			"XDG_CACHE_HOME",
		]) {
			delete env[key];
		}
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "--import", "./tests/harness/tmp-root.ts", "--input-type=module", "--eval", source],
			{ cwd: process.cwd(), env, encoding: "utf8" },
		);

		strictEqual(child.status, 0, child.stderr);
		strictEqual(readFileSync(join(configDir, "settings.yaml"), "utf8"), settingsCanary);
		strictEqual(readFileSync(join(stateDir, "canary"), "utf8"), stateCanary);
		strictEqual(readdirSync(configDir).join("\n"), "settings.yaml");
		strictEqual(readdirSync(stateDir).join("\n"), "canary");
	});
});

/**
 * A `.git` at the system temp root or at the run root sits on the parent walk
 * that `src/tools/ignore-policy.ts` does from every mkdtemp scratch, so one
 * stray marker silently flips `--no-require-git` for the whole suite and fails
 * the ignore-policy contracts in a lane that had nothing to do with it. These
 * cases pin that the harness refuses the write and names the caller. Issue #205.
 */
describe("contracts/test scratch root refuses a stray .git", () => {
	const systemTmp = dirname(tmpdir());
	const strays: string[] = [];
	after(() => {
		for (const stray of strays) rmSync(stray, { recursive: true, force: true });
	});

	/**
	 * A child with its own system temp dir, so a case that really does create the
	 * marker cannot poison this process's run root for every later test.
	 */
	function runIsolatedChild(source: string): { status: number | null; stdout: string; stderr: string } {
		const enclosing = mkdtempSync(join(tmpdir(), "clio-git-guard-"));
		const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: enclosing };
		delete env.CLIO_CODER_TEST_TMP_ROOT;
		try {
			const child = spawnSync(
				process.execPath,
				["--import", "tsx", "--import", "./tests/harness/tmp-root.ts", "--input-type=module", "--eval", source],
				{ cwd: process.cwd(), env, encoding: "utf8" },
			);
			return { status: child.status, stdout: String(child.stdout ?? ""), stderr: String(child.stderr ?? "") };
		} finally {
			rmSync(enclosing, { recursive: true, force: true });
		}
	}

	it("refuses an in-process write at either guarded level and creates nothing", () => {
		for (const parent of [tmpdir(), systemTmp]) {
			const marker = join(parent, ".git");
			// The directory form a normal repository has.
			throws(() => mkdirSync(marker, { recursive: true }), /refused a \.git at/, `mkdirSync ${marker}`);
			// The file form a worktree or submodule has. Both are markers to the walk.
			throws(() => writeFileSync(marker, "gitdir: elsewhere\n"), /refused a \.git at/, `writeFileSync ${marker}`);
			// A nested path underneath is the same marker once it exists.
			throws(() => mkdirSync(join(marker, "hooks"), { recursive: true }), /refused a \.git at/, `nested ${marker}`);
			strictEqual(existsSync(marker), false, `the guard refuses before anything is created: ${marker}`);
		}
	});

	it("leaves promisify(execFile) resolving stdout and stderr", async () => {
		// The guard wraps every child_process entry point. `exec` and `execFile`
		// carry a util.promisify.custom implementation as an own symbol, and a
		// wrapper that drops it silently downgrades promisify() to callback
		// promisification, which resolves the first callback value instead of the
		// { stdout, stderr } pair. src/domains/session/workspace reads that pair.
		const result = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write('probe')"]);
		strictEqual(result.stdout, "probe");
		strictEqual(result.stderr, "");
	});

	it("leaves a scratch directory's own .git alone", () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-git-guard-ok-"));
		strays.push(scratch);
		mkdirSync(join(scratch, ".git"), { recursive: true });
		ok(existsSync(join(scratch, ".git")), "a marker one level down is the legitimate case every test uses");
	});

	it("names the spawn that created one from a child process", () => {
		const child = runIsolatedChild(`
			import { spawnSync } from "node:child_process";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			spawnSync(process.execPath, ["-e", "require('node:fs').mkdirSync(process.argv[1])", join(tmpdir(), ".git")]);
		`);
		ok(child.status !== 0, `the guard fails the child: ${child.stdout}${child.stderr}`);
		match(child.stderr, /refused a \.git at/);
		match(child.stderr, /child_process\.spawnSync/);
	});

	it("reports at exit when the creator was an asynchronous child", () => {
		const child = runIsolatedChild(`
			import { spawn } from "node:child_process";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			const marker = join(tmpdir(), ".git");
			await new Promise((resolve) => {
				spawn(process.execPath, ["-e", "require('node:fs').mkdirSync(process.argv[1])", marker]).on("close", resolve);
			});
		`);
		strictEqual(child.status, 1, `the exit report fails the run: ${child.stdout}${child.stderr}`);
		match(child.stderr, /refused a \.git at/);
		match(child.stderr, /child_process\.spawn/);
	});
});
