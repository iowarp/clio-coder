/**
 * One scratch root per test run, removed when the run ends.
 *
 * Tests call `mkdtemp(join(tmpdir(), "clio-<something>-"))` in roughly 274
 * places and clean up in most of them. The exceptions are the ones that throw,
 * time out, or hand the directory to a child that outlives the assertion, and
 * they never clean up: this machine had 23,397 `clio-*` directories in /tmp,
 * 14,148 of them from one dispatch-state prefix. Every leaked prefix traces to
 * tests/, none to product code, so the fix belongs at the point tests resolve
 * `tmpdir()` rather than at 274 call sites that would each have to be right.
 *
 * `os.tmpdir()` reads TMPDIR on every call, so pointing TMPDIR at a per-run
 * root before any test module loads puts every one of those mkdtemp calls
 * inside it, whether or not the call site knows this file exists. Removing the
 * root at exit collects all of them, including the ones nobody cleaned up.
 *
 * Loaded with `--import` from the test scripts in package.json. It runs in the
 * runner and again in each test child, and the child inherits the root through
 * the environment, so the run has exactly one root and only the process that
 * created it removes it.
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const ROOT_ENV = "CLIO_CODER_TEST_TMP_ROOT";

// Node's test runner sets FORCE_COLOR=1 in every test child when its own
// stdout is a terminal, so the reporter's colours survive the round trip.
// Tests that spawn the CLI inherit it, and eight of them assert uncoloured
// text, so `npm test` from an interactive shell (and `npm publish`, whose
// prepublishOnly runs the suite) failed on output that ci and a piped run
// never see. Every test child loads this file first; dropping the variable
// here gives a spawned CLI the same environment in a terminal as in ci.
delete process.env.FORCE_COLOR;
/** Names every root this harness makes, and the only names it will remove. */
export const TEST_TMP_ROOT_PREFIX = "clio-tests-";

/** The real temp dir, read before TMPDIR is repointed at the run root. */
const systemTmp = resolve(tmpdir());

/**
 * Whether `dir` is a directory this module could have made, checked immediately
 * before a recursive delete.
 *
 * The value reaching here comes from the environment, so it is attacker-shaped
 * input as far as this module is concerned: an inherited `CLIO_CODER_TEST_TMP_ROOT`
 * of `/` or of a symlink pointing at a source tree must not be walked by
 * `rm -rf`. A path that fails any check is left alone; leaking one directory is
 * recoverable and deleting the wrong tree is not.
 */
export function isRemovableRoot(dir: string): boolean {
	if (typeof dir !== "string" || dir.length === 0) return false;
	const path = resolve(dir);
	if (!path.startsWith(`${systemTmp}${sep}`)) return false;
	if (!basename(path).startsWith(TEST_TMP_ROOT_PREFIX)) return false;
	// lstat, not stat: a symlink to a directory reports as a symlink here and is
	// refused, so the delete cannot be redirected outside the temp dir.
	const stats = lstatSync(path, { throwIfNoEntry: false });
	return stats?.isDirectory() ?? false;
}

/** How long a root must have gone untouched before a later run may collect it. */
const STALE_ROOT_MS = 4 * 60 * 60 * 1000;

/**
 * Remove roots that an earlier run never got to.
 *
 * The exit hook below only collects the root of a run that exits. A run killed
 * by SIGKILL, an out-of-memory abort, or an operator's Ctrl-C leaves its root
 * behind forever, and nothing else ever looks at it. On a machine where /tmp is
 * a tmpfs (4GB here) a day of interrupted runs fills it and every later run
 * fails for lack of space, which reads as an unrelated test failure.
 *
 * Age is the only signal available: a root carries no owner pid, and stat'ing
 * for holders would cost more than the sweep saves. Four hours is far longer
 * than any run this suite has, so a root that old belongs to nobody.
 */
function sweepStaleRoots(): void {
	const cutoff = Date.now() - STALE_ROOT_MS;
	let entries: string[];
	try {
		entries = readdirSync(systemTmp);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(TEST_TMP_ROOT_PREFIX)) continue;
		const path = join(systemTmp, entry);
		if (!isRemovableRoot(path)) continue;
		try {
			if (lstatSync(path).mtimeMs > cutoff) continue;
			rmSync(path, { recursive: true, force: true });
		} catch {
			// A root another run is actively removing, or one this user cannot
			// touch. Either way it is not this run's to worry about.
		}
	}
}

const inherited = process.env[ROOT_ENV];
// The same predicate the delete is gated on: a root that would not be safe to
// remove is not one to write into either, so a stale or hostile value from the
// environment is replaced by a fresh root rather than trusted.
if (inherited !== undefined && isRemovableRoot(inherited)) {
	// A test child inside a run that already has a root. Use it; the process that
	// created it is the one that removes it.
	process.env.TMPDIR = inherited;
} else {
	// Only the run that creates a root sweeps; a test child inherits one and has
	// nothing to collect.
	sweepStaleRoots();
	const root = mkdtempSync(join(systemTmp, TEST_TMP_ROOT_PREFIX));
	process.env[ROOT_ENV] = root;
	process.env.TMPDIR = root;
	process.on("exit", () => {
		if (!isRemovableRoot(root)) return;
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// Best effort. A run that cannot remove its own scratch has already
			// reported whatever failure caused that; it is not this module's to raise.
		}
	});
}
