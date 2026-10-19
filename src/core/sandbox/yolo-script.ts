import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { clioCacheDir, clioConfigDir, clioDataDir, clioStateDir } from "../xdg.js";
import { sandboxAvailability } from "./availability.js";
import { buildSandboxInvocation } from "./invocation.js";
import type {
	SandboxAvailability,
	SandboxCommand,
	SandboxInvocationSpec,
	SandboxMaskedPath,
	SandboxMode,
} from "./types.js";
import { protectedInside } from "./worker-policy.js";
import { physicalSandboxPath, workerSandboxMasks } from "./worker-process.js";

/**
 * The operator's yolo script sandbox (#419). Under the main session's yolo a
 * bash command that runs a script file, and run_script, run inside the OS
 * sandbox the dispatched workers use instead of resting on the static scan
 * alone: the filesystem stays readable, writes land only in the workspace, the
 * effective scratch roots, the package caches and the repository's git dirs,
 * and the network stays on because this is the
 * operator's own session. Unlike a worker the script sees the real /tmp,
 * where operators expect benchmark outputs.
 */

/**
 * How the operator's yolo treats a script on this host. Yolo runs scripts
 * unsandboxed by default (#407): it is the operator's skip-permissions mode,
 * and `auto` keeps the OS sandbox for dispatched workers only. Only
 * `safety.sandbox: required` keeps the script sandbox: `sandboxed` runs the
 * script under the backend, and `refused` refuses it because no backend
 * exists.
 */
export type YoloScriptSandboxState = "sandboxed" | "unsandboxed" | "refused";

export function yoloScriptSandboxState(mode: SandboxMode, availability: SandboxAvailability): YoloScriptSandboxState {
	if (mode !== "required") return "unsandboxed";
	if (availability.available && availability.backend !== null && availability.executable !== null) return "sandboxed";
	return "refused";
}

export interface YoloScriptSandboxPolicyInput {
	/** The session workspace root. */
	workspace: string;
	/** Effective scratch roots: the built-in temp roots, the real /tmp among them, plus `safety.scratchRoots`. */
	scratchRoots: ReadonlyArray<string>;
	/**
	 * Package-manager caches a script may fill: the XDG cache dir and ~/.npm.
	 * Unlike the scratch roots they are not delete targets for the judge.
	 */
	cacheRoots: ReadonlyArray<string>;
	/** Existing caches inside the cache roots that hold code run later outside the sandbox; kept read-only. */
	codeCaches: ReadonlyArray<string>;
	/** Clio's own config, data, state and cache directories. */
	clioDirs: ReadonlyArray<string>;
	/** The workspace repository's git layout, when the workspace is inside one. */
	git?: YoloScriptGitLayout;
}

export interface YoloScriptSandboxPolicy {
	writableRoots: ReadonlyArray<string>;
	/** Re-bound read-only inside the writable roots, after them. */
	readOnlyPaths: ReadonlyArray<string>;
	/** Git hooks directories that do not exist yet; bubblewrap covers each with an empty tmpfs. */
	absentGitHooks: ReadonlyArray<string>;
	/** Git config and commondir files that do not exist yet; one a script leaves behind is removed. */
	absentGitFiles: ReadonlyArray<string>;
	network: true;
}

/**
 * Where git in a sandboxed script may write, and what stays read-only. A
 * write to a hooks directory, a config file or a `commondir` file becomes code
 * that runs later outside the sandbox (core.hooksPath, core.fsmonitor,
 * aliases, filter drivers), so those stay read-only while objects, refs and
 * the index stay writable for commit, fetch, pull and checkout (#419).
 */
export interface YoloScriptGitLayout {
	/**
	 * Bound writable as mounts of their own: every git dir, the `worktrees`
	 * and `modules` directories on the way to one, and submodule checkouts in
	 * the workspace. A mount cannot be renamed, so a script cannot move a
	 * protected directory aside and put a forged one in its place.
	 */
	mountDirs: ReadonlyArray<string>;
	/** Existing hooks directories, config and commondir files, and the `.git` files that point at a git dir. */
	readOnlyPaths: ReadonlyArray<string>;
	absentHooks: ReadonlyArray<string>;
	absentFiles: ReadonlyArray<string>;
}

/** Read in every git dir: config.worktree applies with extensions.worktreeConfig, commondir redirects the common dir. */
const GIT_DIR_FILES = ["config", "config.worktree", "commondir"] as const;
/** Submodule names may nest; a deeper modules tree is not walked. */
const GIT_MODULES_DEPTH = 8;

function isDirectory(entry: string): boolean {
	try {
		return lstatSync(entry).isDirectory();
	} catch {
		return false;
	}
}

function pathExists(entry: string): boolean {
	try {
		lstatSync(entry);
		return true;
	} catch {
		return false;
	}
}

function realDir(entry: string): string | null {
	try {
		const real = realpathSync(entry);
		return isDirectory(real) ? real : null;
	} catch {
		return null;
	}
}

/** The git dir a `.git` file names, relative to the file's directory. */
function gitFileTarget(dotGit: string): string | null {
	try {
		const match = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, "utf8"));
		return match?.[1] === undefined ? null : realDir(path.resolve(path.dirname(dotGit), match[1]));
	} catch {
		return null;
	}
}

/** A submodule git dir's `core.worktree`, resolved against the git dir. */
function moduleWorktree(gitDir: string): string | null {
	try {
		const match = /^\s*worktree\s*=\s*(.+?)\s*$/mu.exec(readFileSync(path.join(gitDir, "config"), "utf8"));
		return match?.[1] === undefined ? null : path.resolve(gitDir, match[1]);
	} catch {
		return null;
	}
}

function isInside(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Impure: the git layout of the repository holding the workspace, or
 * undefined outside one. The nearest `.git` at or above the workspace names
 * the repository; a `.git` file (a linked worktree or a submodule) is
 * followed to its git dir and that dir's `commondir`.
 */
export function yoloScriptGitLayout(workspace: string): YoloScriptGitLayout | undefined {
	const root = path.resolve(workspace);
	let top = root;
	while (!pathExists(path.join(top, ".git"))) {
		const parent = path.dirname(top);
		if (parent === top) return undefined;
		top = parent;
	}
	const mountDirs: string[] = [];
	const readOnlyPaths: string[] = [];
	const absentHooks: string[] = [];
	const absentFiles: string[] = [];
	const dotGit = path.join(top, ".git");
	const gitDir = isDirectory(dotGit) ? realDir(dotGit) : gitFileTarget(dotGit);
	if (gitDir === null) return undefined;
	if (!isDirectory(dotGit)) readOnlyPaths.push(dotGit);

	const addGitDir = (dir: string): void => {
		mountDirs.push(dir);
		for (const name of GIT_DIR_FILES) {
			const file = path.join(dir, name);
			(pathExists(file) ? readOnlyPaths : absentFiles).push(file);
		}
	};
	const addModules = (dir: string, depth: number): void => {
		if (depth > GIT_MODULES_DEPTH || !isDirectory(dir)) return;
		mountDirs.push(dir);
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const child = path.join(dir, entry.name);
			if (!pathExists(path.join(child, "HEAD"))) {
				addModules(child, depth + 1);
				continue;
			}
			addRepository(child, depth + 1);
			const checkout = moduleWorktree(child);
			if (checkout === null || !pathExists(path.join(checkout, ".git"))) continue;
			readOnlyPaths.push(path.join(checkout, ".git"));
			// The checkout holds its `.git` file; inside the workspace it could otherwise be renamed aside.
			if (isInside(root, checkout) && checkout !== root) mountDirs.push(checkout);
		}
	};
	// Hooks, linked worktrees and submodules hang off a common dir.
	const addRepository = (commonDir: string, depth: number): void => {
		addGitDir(commonDir);
		const hooks = path.join(commonDir, "hooks");
		(pathExists(hooks) ? readOnlyPaths : absentHooks).push(hooks);
		const worktrees = path.join(commonDir, "worktrees");
		if (isDirectory(worktrees)) {
			mountDirs.push(worktrees);
			for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
				if (entry.isDirectory()) addGitDir(path.join(worktrees, entry.name));
			}
		}
		addModules(path.join(commonDir, "modules"), depth);
	};

	const commonFile = path.join(gitDir, "commondir");
	const commonDir = existsSync(commonFile)
		? realDir(path.resolve(gitDir, readFileSync(commonFile, "utf8").trim()))
		: gitDir;
	if (commonDir === null) return undefined;
	addRepository(commonDir, 0);
	// A linked worktree's own git dir lies under the common dir's worktrees and is already covered.
	if (!mountDirs.includes(gitDir)) addGitDir(gitDir);
	const unique = (entries: string[]): string[] => [...new Set(entries)];
	return {
		mountDirs: unique(mountDirs),
		readOnlyPaths: unique(readOnlyPaths),
		absentHooks: unique(absentHooks),
		absentFiles: unique(absentFiles),
	};
}

/**
 * Pure: the writable roots are the workspace, the scratch roots, the cache
 * roots and the workspace repository's git dirs, and nothing else. Each other root's .git
 * and every .clio-coder are re-bound read-only as the worker policy does, the
 * git layout keeps its hooks and config read-only, and so are Clio's own
 * directories, which matters when one of them lives under a scratch root.
 * Absent git paths are listed read-only too: seatbelt denies creating them,
 * while bubblewrap's -try binds skip them and the spawn plan covers them.
 */
export function resolveYoloScriptSandboxPolicy(input: YoloScriptSandboxPolicyInput): YoloScriptSandboxPolicy {
	const git = input.git;
	const writableRoots = [
		...new Set([input.workspace, ...input.scratchRoots, ...input.cacheRoots, ...(git?.mountDirs ?? [])]),
	];
	const workspaceProtected =
		git === undefined ? protectedInside(input.workspace) : [path.join(input.workspace, ".clio-coder")];
	return {
		writableRoots,
		readOnlyPaths: [
			...new Set([
				...workspaceProtected,
				...[...input.scratchRoots, ...input.cacheRoots].flatMap(protectedInside),
				...(git?.readOnlyPaths ?? []),
				...(git?.absentHooks ?? []),
				...(git?.absentFiles ?? []),
				...input.codeCaches,
				...input.clioDirs,
			]),
		],
		absentGitHooks: git?.absentHooks ?? [],
		absentGitFiles: git?.absentFiles ?? [],
		network: true,
	};
}

/**
 * The built-in cache roots. ~/.local stays read-only: ~/.local/bin on PATH
 * would turn a script's write into a command the operator runs later.
 */
function yoloScriptCacheRoots(): { cacheRoots: string[]; codeCaches: string[] } {
	const xdgCache = process.env.XDG_CACHE_HOME?.trim();
	// The XDG spec ignores a relative value.
	const cache = xdgCache !== undefined && path.isAbsolute(xdgCache) ? xdgCache : path.join(homedir(), ".cache");
	const npm = path.join(homedir(), ".npm");
	// npx, corepack and uv run packages and tools from their caches, and
	// pre-commit runs hook environments from its own, all later and outside the
	// sandbox. An absent one is skipped rather than created.
	const codeCaches = [
		path.join(npm, "_npx"),
		path.join(cache, "pre-commit"),
		path.join(cache, "node", "corepack"),
		path.join(cache, "uv"),
	].filter(pathExists);
	return { cacheRoots: [cache, npm], codeCaches };
}

/** The policy for roots an admission decided, with this process's Clio directories kept read-only. */
export function yoloScriptSandboxPolicy(roots: {
	workspace: string;
	scratchRoots: ReadonlyArray<string>;
}): YoloScriptSandboxPolicy {
	const git = yoloScriptGitLayout(roots.workspace);
	return resolveYoloScriptSandboxPolicy({
		...roots,
		...yoloScriptCacheRoots(),
		clioDirs: [clioConfigDir(), clioDataDir(), clioStateDir(), clioCacheDir()],
		...(git !== undefined ? { git } : {}),
	});
}

/**
 * Pure: the backend-neutral spec for one script command. Credentials and
 * runtime sockets are masked with the worker sandbox's own list, and the
 * agent socket variable goes with them.
 */
export function yoloScriptSandboxInvocationSpec(
	policy: YoloScriptSandboxPolicy,
	command: SandboxCommand,
	cwd: string,
	maskedPaths: ReadonlyArray<SandboxMaskedPath>,
): SandboxInvocationSpec {
	return {
		command,
		cwd,
		writableRoots: policy.writableRoots,
		readOnlyPaths: policy.readOnlyPaths,
		network: policy.network,
		maskedPaths,
		unsetEnv: ["SSH_AUTH_SOCK"],
		privateTmp: false,
	};
}

export type YoloScriptSpawnPlan =
	| { kind: "sandboxed"; file: string; args: string[]; afterExit: () => void }
	| { kind: "refused"; message: string };

/**
 * How one admitted yolo script spawns. Admission relaxed the scan because a
 * backend was there, so a backend that is gone at spawn time refuses the
 * command instead of running it bare.
 *
 * Under bubblewrap an absent hooks directory gets an empty tmpfs, so a hook
 * written there vanishes with the sandbox. An absent config or commondir file
 * cannot be covered the same way: the mount point would leave an empty file,
 * and git refuses an empty commondir. `afterExit` removes one the script
 * created; the caller runs it once the sandbox has exited, which ends every
 * process in its PID namespace.
 */
export function planYoloScriptSpawn(
	policy: YoloScriptSandboxPolicy,
	command: SandboxCommand,
	cwd: string,
	availability: SandboxAvailability = sandboxAvailability(),
): YoloScriptSpawnPlan {
	if (!availability.available || availability.backend === null || availability.executable === null) {
		return {
			kind: "refused",
			message: `sandbox: the yolo script sandbox is unavailable (${availability.reason ?? "no backend"}); the script was not run`,
		};
	}
	const physicalPolicy: YoloScriptSandboxPolicy = {
		...policy,
		writableRoots: policy.writableRoots.map(physicalSandboxPath),
		readOnlyPaths: policy.readOnlyPaths.map(physicalSandboxPath),
	};
	const hookMasks: SandboxMaskedPath[] = policy.absentGitHooks
		.filter((hooks) => !pathExists(hooks))
		.map((hooks) => ({ path: hooks, kind: "directory" }));
	const spec = yoloScriptSandboxInvocationSpec(physicalPolicy, command, physicalSandboxPath(cwd), [
		...workerSandboxMasks(),
		...yoloScriptAgentMasks(),
		...hookMasks,
	]);
	const invocation = buildSandboxInvocation(spec, availability.backend, availability.executable);
	const absentFiles = policy.absentGitFiles.filter((file) => !pathExists(file));
	return {
		kind: "sandboxed",
		file: invocation.file,
		args: invocation.args,
		afterExit: () => sweepYoloScriptGitFiles(absentFiles),
	};
}

/**
 * Keeps worker parity for ssh-agent. A worker's private /tmp hides the
 * sockets OpenSSH's agent puts under `/tmp/ssh-*`; a yolo script sees the
 * host's /tmp, so those directories are masked here, and so is the
 * session's own SSH_AUTH_SOCK wherever it lives (#419).
 */
export function yoloScriptAgentMasks(env: NodeJS.ProcessEnv = process.env, tmp: string = "/tmp"): SandboxMaskedPath[] {
	const masks: SandboxMaskedPath[] = [];
	try {
		for (const entry of readdirSync(tmp, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith("ssh-")) {
				masks.push({ path: path.join(tmp, entry.name), kind: "directory" });
			}
		}
	} catch {
		// An unreadable /tmp has no agent directory this process could list.
	}
	const socket = env["SSH_AUTH_SOCK"]?.trim();
	if (socket !== undefined && path.isAbsolute(socket) && pathExists(socket)) {
		if (!masks.some((mask) => isInside(mask.path, socket))) masks.push({ path: socket, kind: "file" });
	}
	return masks;
}

/** Removes the git files in `absent` that exist now, and returns them. */
function sweepYoloScriptGitFiles(absent: ReadonlyArray<string>): string[] {
	const planted = absent.filter(pathExists);
	for (const file of planted) {
		try {
			rmSync(file, { recursive: true, force: true });
		} catch {
			// Runs from a child's exit listener, where a throw would take the session down; a file left behind is bound read-only from the next run on.
		}
	}
	return planted;
}

const WRITE_REFUSED = /\b(?:EROFS|EACCES|EPERM)\b|Read-only file system|Permission denied|Operation not permitted/u;

/** One line for a failed sandboxed script whose output shows a refused write, else null. */
export function yoloScriptSandboxWriteHint(output: string, policy: YoloScriptSandboxPolicy): string | null {
	if (!WRITE_REFUSED.test(output)) return null;
	return `yolo script sandbox: this script could write only to ${policy.writableRoots.join(", ")} (git hooks and config, scratch roots' .git and .clio-coder read-only); to let scripts write another directory, add it to safety.scratchRoots in your user settings.`;
}

/** One line for doctor: whether yolo scripts run sandboxed here, and where they can write. */
export function yoloScriptSandboxLine(
	state: YoloScriptSandboxState,
	availability: SandboxAvailability,
	writableRoots: ReadonlyArray<string>,
): string {
	if (state === "sandboxed") {
		return `yolo scripts run in the ${availability.backend} sandbox; writable roots: ${writableRoots.join(", ")}`;
	}
	if (state === "refused") {
		return `yolo scripts ask: safety.sandbox is required and no sandbox is available (${availability.reason ?? "no backend"})`;
	}
	return availability.available
		? "yolo scripts run unsandboxed under the static scan: safety.sandbox is off"
		: `yolo scripts run unsandboxed under the static scan: ${availability.reason ?? "no sandbox backend"}`;
}
