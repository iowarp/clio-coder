/**
 * One scratch root per test run, removed when the run ends.
 *
 * Tests call `mkdtemp(join(tmpdir(), "clio-coder-<something>-"))` in roughly 274
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
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";

const ROOT_ENV = "CLIO_CODER_TEST_TMP_ROOT";

// Color-control variables inherited from the shell must not choose the shared
// theme every styling contract sees. Node's test runner can inject FORCE_COLOR
// for its reporter, while developer and agent shells commonly carry NO_COLOR;
// either one otherwise enters every lane before clioTheme() is cached. Tests
// for a color mode opt into it locally with createClioTheme or a fresh child
// environment. Every test child loads this file first, so clearing both here
// gives the suite one deterministic default without changing product behavior.
delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;
// The terminal background picks the palette the same way, so a light-themed
// shell cannot move the suite off the unknown-background palette.
delete process.env.COLORFGBG;
delete process.env.CLIO_CODER_THEME;
// Git configuration injected through the environment, as agent shells do with
// GIT_CONFIG_COUNT/KEY_n/VALUE_n (core.fsmonitor=false, safe.bareRepository),
// overrides every repository fixture's own config and turned fsmonitor and
// module git-dir contracts red. Fixtures that need a key set it themselves.
for (const name of Object.keys(process.env)) {
	if (/^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(name)) delete process.env[name];
}
/** Names every root this harness makes, and the only names it will remove. */
export const TEST_TMP_ROOT_PREFIX = "clio-coder-tests-";

/**
 * The real temp dir, read before TMPDIR is repointed at the run root, and
 * canonical. Every path contract reports where a path lands, and macOS hands
 * out a temp dir behind a link (`/var/folders/...` resolves under
 * `/private/var`), so a lexical root made each of those contracts compare
 * `/var/...` against `/private/var/...`. On Linux `/tmp` is already canonical.
 */
const systemTmp = canonicalTmp();

function canonicalTmp(): string {
	const lexical = resolve(tmpdir());
	try {
		return realpathSync(lexical);
	} catch {
		// A temp dir that does not resolve fails at mkdtemp below, as it always has.
		return lexical;
	}
}

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

/** Collect only old roots whose recorded owner has exited. Never infer death from age alone. */
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
			const owner = JSON.parse(readFileSync(join(path, ".owner.json"), "utf8")) as { pid?: unknown };
			if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) continue;
			try {
				process.kill(owner.pid, 0);
				continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
			}
			rmSync(path, { recursive: true, force: true });
		} catch {
			// A root another run is actively removing, or one this user cannot
			// touch. Either way it is not this run's to worry about.
		}
	}
}

/**
 * The canonical path of an inherited run root this process may trust, else null.
 *
 * Every Clio root the run writes through is confined to this directory, so it
 * must itself sit physically inside the approved scratch boundary, the real
 * temp dir. A lexical prefix check is not enough: `<tmp>/alias/clio-coder-tests-x`
 * passes it when `alias` points at a real home. A test child sees the root as
 * its own temp dir, so the root may also equal the boundary. The final component
 * must be a real directory (lstat), matching what the exit cleanup accepts.
 */
function trustedInheritedRoot(value: string | undefined): string | null {
	if (value === undefined || !isAbsolute(value)) return null;
	if (!lstatSync(value, { throwIfNoEntry: false })?.isDirectory()) return null;
	let real: string;
	try {
		real = realpathSync(value);
	} catch {
		return null;
	}
	if (!basename(real).startsWith(TEST_TMP_ROOT_PREFIX)) return null;
	return real === systemTmp || real.startsWith(`${systemTmp}${sep}`) ? real : null;
}

// A root that is not physically inside the scratch boundary is not one to write
// into, so a stale or hostile value from the environment is replaced by a fresh
// root rather than trusted.
const inherited = trustedInheritedRoot(process.env[ROOT_ENV]);
if (inherited !== null) {
	// A test child inside a run that already has a root. Use it; the process that
	// created it is the one that removes it.
	process.env[ROOT_ENV] = inherited;
	process.env.TMPDIR = inherited;
} else {
	// Only the run that creates a root sweeps; a test child inherits one and has
	// nothing to collect.
	sweepStaleRoots();
	const root = mkdtempSync(join(systemTmp, TEST_TMP_ROOT_PREFIX));
	writeFileSync(join(root, ".owner.json"), JSON.stringify({ pid: process.pid }));
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

const clioRootEnvKeys = [
	"CLIO_CODER_HOME",
	"CLIO_CODER_CONFIG_DIR",
	"CLIO_CODER_DATA_DIR",
	"CLIO_CODER_STATE_DIR",
	"CLIO_CODER_CACHE_DIR",
] as const;

/**
 * The physical path `value` writes through when it stays inside the run root,
 * else null. Only an absolute path counts: a relative one moves with the cwd of
 * whichever child or worker inherits it. Containment is judged on the realpath
 * of the deepest entry that exists (lstat, so a dangling link is refused rather
 * than skipped), because `<runRoot>/link/state` with `link` pointing at a real
 * home is lexically inside and physically not. A `..` segment is refused since
 * the kernel applies it after following a link and `resolve()` before.
 */
function confinedPath(value: string, realRunRoot: string): string | null {
	if (!isAbsolute(value) || value.split(/[\\/]/u).includes("..")) return null;
	let existing = resolve(value);
	const suffix: string[] = [];
	while (lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
		const parent = dirname(existing);
		if (parent === existing) return null;
		suffix.unshift(basename(existing));
		existing = parent;
	}
	let physical: string;
	try {
		physical = join(realpathSync(existing), ...suffix);
	} catch {
		return null;
	}
	return physical === realRunRoot || physical.startsWith(`${realRunRoot}${sep}`) ? physical : null;
}

/**
 * Drop every Clio root variable that is not confined to the run root.
 *
 * The four per-role `CLIO_CODER_*_DIR` variables beat `CLIO_CODER_HOME`, so a
 * shell that exported only `CLIO_CODER_STATE_DIR` used to skip the home
 * override below and send every state write through that variable into a real
 * home. A runner is never handed a home on purpose (scripts/ci-tests.mjs and
 * the package.json test scripts pass none), and operators routinely export a
 * test or live home in the same shell, so refusing would stop every such shell
 * from running tests. The values are overridden instead, with one notice.
 * Confined values are a test's own scratch roots handed to a child; they are
 * kept, rewritten to the physical path that was checked. Dropped values are
 * deleted rather than repointed, so a test that later sets only
 * `CLIO_CODER_HOME` still resolves every role under it.
 */
function confineClioRootEnv(env: NodeJS.ProcessEnv, runRoot: string): string[] {
	const realRunRoot = realpathSync(runRoot);
	const dropped: string[] = [];
	for (const key of clioRootEnvKeys) {
		const value = env[key]?.trim();
		if (value === undefined) continue;
		const confined = value.length > 0 ? confinedPath(value, realRunRoot) : null;
		if (confined !== null) {
			env[key] = confined;
			continue;
		}
		Reflect.deleteProperty(env, key);
		if (value.length > 0) dropped.push(key);
	}
	// Foreign agent roots (~/.claude, ~/.codex) are the operator's too. Off unless
	// a test points them inside the run root, as tests/harness/scratch-env.ts does.
	const interop = env.CLIO_CODER_INTEROP_HOME?.trim();
	if (interop !== "none") {
		const confined = interop ? confinedPath(interop, realRunRoot) : null;
		if (confined === null && interop) dropped.push("CLIO_CODER_INTEROP_HOME");
		env.CLIO_CODER_INTEROP_HOME = confined ?? "none";
	}
	// A role no surviving per-role variable names falls back to CLIO_CODER_HOME,
	// and without one to the operator's platform default, so the home is always
	// pinned. The prefix guard holds only when the home alone decides every role;
	// a surviving per-role root outside it is legitimate here and would trip it.
	if (!env.CLIO_CODER_HOME?.trim()) {
		env.CLIO_CODER_HOME = join(realRunRoot, "home");
		if (clioRootEnvKeys.every((key) => key === "CLIO_CODER_HOME" || !env[key]?.trim())) {
			env.CLIO_CODER_REQUIRE_HOME_PREFIX = "1";
		}
	}
	return dropped;
}

const clioRoleEnvKeys = {
	config: "CLIO_CODER_CONFIG_DIR",
	data: "CLIO_CODER_DATA_DIR",
	state: "CLIO_CODER_STATE_DIR",
	cache: "CLIO_CODER_CACHE_DIR",
} as const;

/**
 * Refuse to run when any root Clio would actually write through escapes the run
 * root. Confining the variables is not enough on its own: `<runRoot>/home` or
 * `<home>/state` can already be a link to a real home, and Clio appends the
 * role after the variables are read. Each root is resolved the way
 * resolveRole in src/core/xdg.ts does it (trimmed role variable, else
 * `<CLIO_CODER_HOME>/<role>`) and checked physically. The order is inlined
 * because a worker thread inherits this preload without tsx's resolver on
 * Node 22 and cannot import src/. The platform default never applies here,
 * since the home is pinned first, so a role with no root counts as an escape.
 */
function assertClioDirsConfined(env: NodeJS.ProcessEnv, realRunRoot: string): void {
	const home = env.CLIO_CODER_HOME?.trim();
	const escaped: string[] = [];
	for (const [role, key] of Object.entries(clioRoleEnvKeys)) {
		const dir = env[key]?.trim() || (home ? join(home, role) : "");
		if (dir.length === 0 || confinedPath(dir, realRunRoot) === null)
			escaped.push(`${role} root ${dir || "(platform default)"}`);
	}
	if (escaped.length === 0) return;
	throw new Error(
		`tests/harness/tmp-root.ts: refusing to run, the Clio ${escaped.join(", ")} resolves outside the run root ${realRunRoot}`,
	);
}

// A test must never inherit the operator's Clio roots or platform defaults. The
// preload runs before every test module, so this catches settingsPath() and
// every XDG role resolver without requiring each call site to remember an
// override. Tests of default XDG resolution set an explicit environment in
// their own child process.
{
	const runRoot = process.env[ROOT_ENV];
	if (runRoot !== undefined) {
		const dropped = confineClioRootEnv(process.env, runRoot);
		if (dropped.length > 0) {
			process.stderr.write(
				`tests/harness/tmp-root.ts: ignoring inherited ${dropped.join(", ")}; tests use the run root ${runRoot}\n`,
			);
		}
		assertClioDirsConfined(process.env, realpathSync(runRoot));
	}
}

// Last, because the guard needs the run root this file just settled on. Both
// the system temp dir and the run root sit on the parent walk that
// src/tools/ignore-policy.ts does from a mkdtemp scratch, so a `.git` at either
// level rewrites the answer for every path-walking OBSERVE tool contract. The
// guard refuses one and names whoever tried. See issue #205.
//
// A worker thread inherits this preload through execArgv, but on Node 22 not
// tsx's resolver, so a static `./tmp-git-guard.js` import killed every GUI
// worker before its entry ran. The guard patches this thread's fs module, so
// the main thread installs it and a worker, which never had it before the GUI
// tier gained this preload, skips it.
if (isMainThread) {
	const { installTmpGitGuard } = await import("./tmp-git-guard.js");
	installTmpGitGuard({ systemTmp, runRoot: process.env[ROOT_ENV] });
}
