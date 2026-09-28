import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Resolve per-platform config/data/state/cache directories for Clio.
 *
 * This is the single resolution order, documented once:
 *   1. Platform defaults.
 *      Linux: XDG Base Directory spec (XDG_CONFIG_HOME, XDG_DATA_HOME,
 *      XDG_STATE_HOME, XDG_CACHE_HOME).
 *      macOS: ~/Library/Application Support/clio-coder/{config,data,state} and
 *      ~/Library/Caches/clio-coder.
 *      Windows: %APPDATA%/clio-coder/{config,data} and %LOCALAPPDATA%/clio-coder/{state,cache}.
 *      Every root is distinct on every platform; no root nests inside another.
 *   2. CLIO_CODER_HOME replaces all four roots symmetrically with
 *      CLIO_CODER_HOME/{config,data,state,cache}.
 *   3. CLIO_CODER_CONFIG_DIR / CLIO_CODER_DATA_DIR / CLIO_CODER_STATE_DIR / CLIO_CODER_CACHE_DIR each
 *      override their one root and beat CLIO_CODER_HOME (most specific wins).
 *
 * Role contents: config holds user-authored files (settings, credentials,
 * agents, skills, prompts, extensions, runtimes); data holds durable artifacts
 * (memory, evidence, vendored tools); state holds machine-produced session state
 * (sessions, audit, receipts, runs.json, recent-models.json, install.json,
 * interviews, scratch); cache holds disposable derived files.
 */

export interface ClioDirs {
	config: string;
	data: string;
	state: string;
	cache: string;
}

type ClioDirRole = keyof ClioDirs;

const CLIO_DIR_ROLES: ReadonlyArray<ClioDirRole> = ["config", "data", "state", "cache"];

/**
 * Resolve an existing prefix physically and append any missing suffix.
 *
 * A lexical comparison misses aliases through a symlinked parent: `~/clio`
 * and `/mnt/home/me/clio` can be the same directory even when only the first
 * spelling exists. Lifecycle deletion needs identity rather than spelling, so
 * the layout check resolves as much of each path as the filesystem currently
 * knows without creating anything.
 */
function physicalPath(path: string): string {
	let cursor = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		suffix.unshift(cursor.slice(parent.length).replace(/^[/\\]+/u, ""));
		cursor = parent;
	}
	try {
		cursor = realpathSync(cursor);
	} catch {
		// The directory finding reports unreadable paths. A lexical identity is
		// still useful here and never makes an unsafe layout look safer.
	}
	const joined = resolve(cursor, ...suffix);
	return process.platform === "win32" ? joined.toLowerCase() : joined;
}

function containsPath(parent: string, child: string): boolean {
	const inside = relative(parent, child);
	return (
		inside.length > 0 &&
		!isAbsolute(inside) &&
		inside !== ".." &&
		!inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	);
}

/**
 * Problems that make root-scoped reset/uninstall ambiguous or destructive.
 *
 * The four roles are ownership boundaries. They must be absolute, distinct,
 * and non-nesting even when environment overrides are used. Otherwise a
 * seemingly scoped `reset --state`, or an uninstall with `--keep-config`, can
 * erase a root the preview promised to preserve.
 */
export function clioDirLayoutProblems(dirs: ClioDirs = resolveClioDirs()): string[] {
	const problems: string[] = [];
	for (const role of CLIO_DIR_ROLES) {
		if (!isAbsolute(dirs[role])) problems.push(`${role} root is relative: ${dirs[role]}`);
	}
	const physical = Object.fromEntries(CLIO_DIR_ROLES.map((role) => [role, physicalPath(dirs[role])])) as Record<
		ClioDirRole,
		string
	>;
	for (let leftIndex = 0; leftIndex < CLIO_DIR_ROLES.length; leftIndex += 1) {
		const leftRole = CLIO_DIR_ROLES[leftIndex];
		if (leftRole === undefined) continue;
		for (const rightRole of CLIO_DIR_ROLES.slice(leftIndex + 1)) {
			const left = physical[leftRole];
			const right = physical[rightRole];
			if (left === right) {
				problems.push(`${leftRole} and ${rightRole} roots resolve to the same path: ${left}`);
			} else if (containsPath(left, right)) {
				problems.push(`${leftRole} root contains ${rightRole} root: ${left} -> ${right}`);
			} else if (containsPath(right, left)) {
				problems.push(`${rightRole} root contains ${leftRole} root: ${right} -> ${left}`);
			}
		}
	}
	return problems;
}

/** Refuse a layout in every writer, before it creates or removes a root. */
export function assertClioDirLayout(dirs: ClioDirs = resolveClioDirs()): void {
	const problems = clioDirLayoutProblems(dirs);
	if (problems.length === 0) return;
	throw new Error(
		`Unsafe Clio directory layout:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n` +
			"Set four absolute, distinct, non-nesting CLIO_CODER_*_DIR paths, then run `clio-coder doctor`.",
	);
}

let cachedConfigDir: string | undefined;
let cachedDataDir: string | undefined;
let cachedStateDir: string | undefined;
let cachedCacheDir: string | undefined;

function envOrNull(key: string): string | null {
	const v = process.env[key]?.trim();
	return v && v.length > 0 ? v : null;
}

function platformDefaults(): ClioDirs {
	const p = platform();
	const h = homedir();
	if (p === "win32") {
		const appData = process.env.APPDATA ?? join(h, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA ?? join(h, "AppData", "Local");
		return {
			config: join(appData, "clio-coder", "config"),
			data: join(appData, "clio-coder", "data"),
			state: join(localAppData, "clio-coder", "state"),
			cache: join(localAppData, "clio-coder", "cache"),
		};
	}
	if (p === "darwin") {
		const base = join(h, "Library", "Application Support", "clio-coder");
		return {
			config: join(base, "config"),
			data: join(base, "data"),
			state: join(base, "state"),
			cache: join(h, "Library", "Caches", "clio-coder"),
		};
	}
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(h, ".config");
	const xdgData = process.env.XDG_DATA_HOME ?? join(h, ".local", "share");
	const xdgState = process.env.XDG_STATE_HOME ?? join(h, ".local", "state");
	const xdgCache = process.env.XDG_CACHE_HOME ?? join(h, ".cache");
	return {
		config: join(xdgConfig, "clio-coder"),
		data: join(xdgData, "clio-coder"),
		state: join(xdgState, "clio-coder"),
		cache: join(xdgCache, "clio-coder"),
	};
}

function ensureDir(dir: string): string {
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== "EEXIST") throw err;
	}
	const s = statSync(dir);
	if (!s.isDirectory()) throw new Error(`Expected directory at ${dir}`);
	return dir;
}

function clioHomeOrNull(): string | null {
	return envOrNull("CLIO_CODER_HOME");
}

function resolveRole(specificVar: string, role: keyof ClioDirs, defaults: ClioDirs): string {
	const specific = envOrNull(specificVar);
	if (specific) return specific;
	const home = clioHomeOrNull();
	if (home) return join(home, role);
	return defaults[role];
}

export function resolveClioDirs(): ClioDirs {
	const defaults = platformDefaults();
	return {
		config: resolveRole("CLIO_CODER_CONFIG_DIR", "config", defaults),
		data: resolveRole("CLIO_CODER_DATA_DIR", "data", defaults),
		state: resolveRole("CLIO_CODER_STATE_DIR", "state", defaults),
		cache: resolveRole("CLIO_CODER_CACHE_DIR", "cache", defaults),
	};
}

/** Credential isolation must compare resolved roots without creating directories or reading credentials. */
export function isClioHomeRelocated(): boolean {
	const defaults = platformDefaults();
	const dirs = resolveClioDirs();
	return (Object.keys(defaults) as Array<keyof ClioDirs>).some(
		(role) => resolve(dirs[role]) !== resolve(defaults[role]),
	);
}

export function clioConfigDir(): string {
	if (cachedConfigDir) return cachedConfigDir;
	const dirs = resolveClioDirs();
	assertClioDirLayout(dirs);
	cachedConfigDir = ensureDir(dirs.config);
	return cachedConfigDir;
}

export function clioDataDir(): string {
	if (cachedDataDir) return cachedDataDir;
	const dirs = resolveClioDirs();
	assertClioDirLayout(dirs);
	cachedDataDir = ensureDir(dirs.data);
	return cachedDataDir;
}

export function clioStateDir(): string {
	if (cachedStateDir) return cachedStateDir;
	const dirs = resolveClioDirs();
	assertClioDirLayout(dirs);
	cachedStateDir = ensureDir(dirs.state);
	return cachedStateDir;
}

export function clioCacheDir(): string {
	if (cachedCacheDir) return cachedCacheDir;
	const dirs = resolveClioDirs();
	assertClioDirLayout(dirs);
	cachedCacheDir = ensureDir(dirs.cache);
	return cachedCacheDir;
}

export function clioStatePath(): string {
	return cachedStateDir ?? resolveClioDirs().state;
}

/**
 * True when the state root this process resolved is no longer on disk.
 *
 * `clio-coder uninstall` removes the whole root while processes holding session
 * writers, ledgers and audit files are still running, and every writer under
 * the root mkdirs its parent back: `safeResourceWrite` does it before the temp
 * file, the state file lock does it before the critical section, the audit
 * writer does it before opening the day's file. A write landing after the
 * removal therefore recreated the state home, so an uninstall that reported
 * success left one behind and the next `clio-coder` start read state from a home that
 * was supposed to be gone. The live case was the shutdown checkpoint, roughly
 * two minutes late, rebuilding the root around a meta.json and tree.json that
 * announced `lastCheckpointReason: shutdown`.
 *
 * "Removed" and "never created" are not the same thing, and only the first is a
 * reason to refuse a write. With no cached root this process has not resolved
 * one yet, so a writer creating it is an ordinary first run; the audit writer
 * reaches its first row before anything else has called `clioStateDir()`, and
 * treating that as an uninstall silently disabled audit on a fresh install.
 * Reads the cache directly rather than `clioStateDir()` because the latter
 * creates the directory it is being asked about.
 *
 * Every writer under the state root calls this before it touches disk, and
 * again inside whatever lock it holds, because the removal can land while the
 * call waits for a sibling process to leave its critical section.
 */
export function stateRootRemoved(): boolean {
	if (cachedStateDir === undefined) return false;
	return !existsSync(cachedStateDir);
}

export function resetXdgCache(): void {
	cachedConfigDir = undefined;
	cachedDataDir = undefined;
	cachedStateDir = undefined;
	cachedCacheDir = undefined;
}
