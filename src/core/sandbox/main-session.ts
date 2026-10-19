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
 * The main session's shell sandbox. At autonomy default every bash and
 * run_script call of the operator's own session runs inside the OS sandbox the
 * dispatched workers use, whenever a backend exists and `safety.sandbox` is
 * not off: the filesystem stays readable, writes land only in the workspace,
 * the effective scratch roots, the package caches and the repository's git
 * dirs, credentials and the SSH agent are masked, the command gets its own PID
 * namespace, and the network stays on because this is the operator's own
 * session. Unlike a worker the command sees the real /tmp, where operators
 * expect benchmark outputs. Containment is what lets such a call run without
 * an approval ask; a call that asks to leave it (`unsandboxed: true`) or that
 * publishes is judged instead. Under the operator's yolo only a script under
 * `safety.sandbox: required` runs here (#419, #407).
 */

/**
 * Whether the main session's shell calls at autonomy default run contained on
 * this host: `safety.sandbox` is auto or required and a backend answered the
 * probe. With no backend nothing is contained and the default rails apply.
 */
export function mainShellContained(mode: SandboxMode, availability: SandboxAvailability): boolean {
	if (mode === "off") return false;
	return availability.available && availability.backend !== null && availability.executable !== null;
}

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

export interface MainSandboxPolicyInput {
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
	git?: MainSandboxGitLayout;
}

export interface MainSandboxPolicy {
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
export interface MainSandboxGitLayout {
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

/** Impure: the directory holding the nearest `.git` at or above `workspace`, or null outside a repository. */
export function gitRepositoryTop(workspace: string): string | null {
	let top = path.resolve(workspace);
	while (!pathExists(path.join(top, ".git"))) {
		const parent = path.dirname(top);
		if (parent === top) return null;
		top = parent;
	}
	return top;
}

/**
 * Impure: the git layout of the repository holding the workspace, or
 * undefined outside one. The nearest `.git` at or above the workspace names
 * the repository; a `.git` file (a linked worktree or a submodule) is
 * followed to its git dir and that dir's `commondir`.
 */
export function mainSandboxGitLayout(workspace: string): MainSandboxGitLayout | undefined {
	const root = path.resolve(workspace);
	const top = gitRepositoryTop(root);
	if (top === null) return undefined;
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
 * Impure: the workspace repository's git control paths, the hooks
 * directories, config and commondir files and `.git` pointer files that
 * {@link resolveMainSandboxPolicy} keeps read-only, present or not. The
 * policy engine asks before a typed tool writes one, so typed writes and the
 * contained shell agree on what runs code outside the sandbox.
 */
export function mainSandboxGitControlPaths(workspace: string): string[] {
	const git = mainSandboxGitLayout(workspace);
	return git === undefined ? [] : [...new Set([...git.readOnlyPaths, ...git.absentHooks, ...git.absentFiles])];
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
export function resolveMainSandboxPolicy(input: MainSandboxPolicyInput): MainSandboxPolicy {
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
function mainSandboxCacheRoots(): { cacheRoots: string[]; codeCaches: string[] } {
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
export function mainSandboxPolicy(roots: {
	workspace: string;
	scratchRoots: ReadonlyArray<string>;
}): MainSandboxPolicy {
	const git = mainSandboxGitLayout(roots.workspace);
	return resolveMainSandboxPolicy({
		...roots,
		...mainSandboxCacheRoots(),
		clioDirs: [clioConfigDir(), clioDataDir(), clioStateDir(), clioCacheDir()],
		...(git !== undefined ? { git } : {}),
	});
}

/**
 * Pure: the backend-neutral spec for one script command. Credentials and
 * runtime sockets are masked with the worker sandbox's own list, and the
 * agent socket variable goes with them.
 */
export function mainSandboxInvocationSpec(
	policy: MainSandboxPolicy,
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

export type MainSandboxSpawnPlan =
	| { kind: "sandboxed"; file: string; args: string[]; afterExit: () => void }
	| { kind: "refused"; message: string };

/**
 * How one contained command spawns. Admission let it run without an ask
 * because a backend was there, so a backend that is gone at spawn time
 * refuses the command instead of running it bare.
 *
 * Under bubblewrap an absent hooks directory gets an empty tmpfs, so a hook
 * written there vanishes with the sandbox. An absent config or commondir file
 * cannot be covered the same way: the mount point would leave an empty file,
 * and git refuses an empty commondir. `afterExit` removes one the script
 * created; the caller runs it once the sandbox has exited, which ends every
 * process in its PID namespace.
 */
export function planMainSandboxSpawn(
	policy: MainSandboxPolicy,
	command: SandboxCommand,
	cwd: string,
	availability: SandboxAvailability = sandboxAvailability(),
): MainSandboxSpawnPlan {
	if (!availability.available || availability.backend === null || availability.executable === null) {
		return {
			kind: "refused",
			message: `sandbox: the main-session sandbox is unavailable (${availability.reason ?? "no backend"}); the command was not run`,
		};
	}
	const physicalPolicy: MainSandboxPolicy = {
		...policy,
		writableRoots: policy.writableRoots.map(physicalSandboxPath),
		readOnlyPaths: policy.readOnlyPaths.map(physicalSandboxPath),
	};
	const hookMasks: SandboxMaskedPath[] = policy.absentGitHooks
		.filter((hooks) => !pathExists(hooks))
		.map((hooks) => ({ path: hooks, kind: "directory" }));
	const spec = mainSandboxInvocationSpec(physicalPolicy, command, physicalSandboxPath(cwd), [
		...workerSandboxMasks(),
		...mainSandboxAgentMasks(),
		...hookMasks,
	]);
	const invocation = buildSandboxInvocation(spec, availability.backend, availability.executable);
	const absentFiles = policy.absentGitFiles.filter((file) => !pathExists(file));
	return {
		kind: "sandboxed",
		file: invocation.file,
		args: invocation.args,
		afterExit: () => sweepMainSandboxGitFiles(absentFiles),
	};
}

/**
 * Keeps worker parity for ssh-agent. A worker's private /tmp hides the
 * sockets OpenSSH's agent puts under `/tmp/ssh-*`; a contained command sees
 * the host's /tmp, so those directories are masked here, and so is the
 * session's own SSH_AUTH_SOCK wherever it lives (#419).
 */
export function mainSandboxAgentMasks(env: NodeJS.ProcessEnv = process.env, tmp: string = "/tmp"): SandboxMaskedPath[] {
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
function sweepMainSandboxGitFiles(absent: ReadonlyArray<string>): string[] {
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

/** One line for a failed contained command whose output shows a refused write, else null. */
export function mainSandboxWriteHint(output: string, policy: MainSandboxPolicy): string | null {
	if (!WRITE_REFUSED.test(output)) return null;
	return `sandbox: this command could write only to ${policy.writableRoots.join(", ")} (git hooks and config, scratch roots' .git and .clio-coder read-only; credentials hidden). If it failed because of the sandbox, rerun it with unsandboxed: true and it is reviewed against the operator's request; a directory scripts should always write belongs in safety.scratchRoots in the user settings.`;
}

/** One line for doctor: how the main session's shell calls run on this host, and where a contained one can write. */
export function mainSandboxLine(
	mode: SandboxMode,
	availability: SandboxAvailability,
	writableRoots: ReadonlyArray<string>,
): string {
	const yolo = yoloScriptSandboxState(mode, availability);
	const yoloLine =
		yolo === "sandboxed"
			? "yolo scripts run sandboxed too (safety.sandbox is required)"
			: yolo === "refused"
				? `yolo refuses scripts: safety.sandbox is required and no sandbox is available (${availability.reason ?? "no backend"})`
				: "yolo runs unsandboxed";
	if (mainShellContained(mode, availability)) {
		return `default-autonomy shell commands run in the ${availability.backend} sandbox; writable roots: ${writableRoots.join(", ")}; ${yoloLine}`;
	}
	const why = mode === "off" ? "safety.sandbox is off" : (availability.reason ?? "no sandbox backend");
	return `default-autonomy shell commands run uncontained and keep the approval rails (${why}); ${yoloLine}`;
}
