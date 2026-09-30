import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { buildSafeToolEnv } from "../core/safe-exec.js";
import type { AdmissionGitContext } from "../domains/safety/admission.js";
import { classifyGitArgv, literalGitPathError } from "../domains/safety/git-policy.js";
import type { WorkerGitAllowance } from "../domains/safety/worker-permit.js";
import { attestTaskWorktreeCwd, type TaskWorktree } from "./task-worktree.js";

/**
 * The fixed Git surface of the typed git tool (Phase C). Every typed op runs
 * one exact argv, never a shell, under an environment that names no system
 * configuration, no terminal prompt, no editor and no pager. What the model
 * selects is the argv; what the host selects rides command-scope
 * configuration (GIT_CONFIG_COUNT), so the argv the safety net judged is the
 * argv that runs.
 */

/** Environment every typed git op runs with, on top of the safe-exec allowlist. */
const TYPED_GIT_ENV: Readonly<Record<string, string>> = {
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_PAGER: "cat",
	PAGER: "cat",
	// Git treats ":" as the no-op editor and never launches one.
	GIT_EDITOR: ":",
};

/** Host-selected configuration every typed op carries: no pager, no fsmonitor helper. */
const TYPED_GIT_BASE_CONFIG: ReadonlyArray<readonly [string, string]> = [
	["core.pager", "cat"],
	["core.fsmonitor", "false"],
];

/** Command-scope configuration as the GIT_CONFIG_COUNT environment pairs Git reads. */
export function typedGitEnv(
	config: ReadonlyArray<readonly [string, string]>,
	extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const env: Record<string, string> = { ...TYPED_GIT_ENV, ...extra };
	const pairs = [...TYPED_GIT_BASE_CONFIG, ...config];
	env.GIT_CONFIG_COUNT = String(pairs.length);
	pairs.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

/** Inspect ops also skip optional index writes, so no post-index-change hook fires. */
export function typedGitInspectEnv(): Record<string, string> {
	return typedGitEnv([], { GIT_OPTIONAL_LOCKS: "0" });
}

function gitRead(cwd: string, args: ReadonlyArray<string>): string | null {
	try {
		return execFileSync("git", [...args], {
			cwd,
			env: buildSafeToolEnv({ ...TYPED_GIT_ENV, GIT_OPTIONAL_LOCKS: "0" }),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		}).trim();
	} catch {
		return null;
	}
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function inside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface GitHooksResolution {
	/** Absolute working tree top level of the cwd. */
	top: string;
	/** Absolute hooks directory Git would run for a command in the cwd, core.hooksPath honored. */
	hooks: string;
}

/**
 * The hooks directory a Git command in `cwd` runs, as Git itself resolves it
 * without Clio's attribution wrapper. Null when it cannot be resolved.
 */
export function resolveGitHooksDirectory(cwd: string): GitHooksResolution | null {
	const top = gitRead(cwd, ["rev-parse", "--show-toplevel"]);
	const hooks = gitRead(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
	if (top === null || hooks === null || top.length === 0 || hooks.length === 0) return null;
	return { top: canonical(top), hooks: canonical(hooks) };
}

/**
 * Whether the hooks a Git mutation in `cwd` would run live inside that
 * working tree, where the worker can write them. Checked lexically and
 * through links; an unresolvable directory counts as inside.
 */
function gitHooksInsideWorkingTree(cwd: string): boolean {
	const top = gitRead(cwd, ["rev-parse", "--show-toplevel"]);
	const hooks = gitRead(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
	if (top === null || hooks === null || top.length === 0 || hooks.length === 0) return true;
	return inside(resolve(top), resolve(hooks)) || inside(canonical(top), canonical(hooks));
}

/** A boolean Git config value as the command would read it, or null when unset. */
export function gitConfigBool(cwd: string, key: string): boolean | null {
	const value = gitRead(cwd, ["config", "--type=bool", "--get", key]);
	return value === null || value.length === 0 ? null : value === "true";
}

export function gitConfigValue(cwd: string, key: string): string | null {
	const value = gitRead(cwd, ["config", "--get", key]);
	return value === null || value.length === 0 ? null : value;
}

/** Longest commit message the typed commit accepts. */
export const TYPED_GIT_MESSAGE_MAX_CHARS = 16_384;

export type TypedGitMutation = { ok: true; op: "add" | "commit"; argv: string[] } | { ok: false; error: string };

/**
 * The exact argv a typed `add` or `commit` runs. The same argv is what the
 * safety net and the Git classifier judge, so a typed call and the equivalent
 * bash command reach one verdict.
 */
export function typedGitMutationArgv(op: string, args: Record<string, unknown>): TypedGitMutation | null {
	if (op === "add") {
		const paths = args.paths;
		if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string")) {
			return { ok: false, error: "git: op add needs args.paths, a non-empty array of literal paths" };
		}
		for (const path of paths as string[]) {
			const error = literalGitPathError(path);
			if (error !== null) return { ok: false, error: `git: op add refused ${error}` };
		}
		return { ok: true, op, argv: ["add", "--", ...(paths as string[])] };
	}
	if (op === "commit") {
		const message = args.message;
		if (typeof message !== "string" || message.trim().length === 0) {
			return { ok: false, error: "git: op commit needs args.message, a non-empty commit message" };
		}
		if (message.includes("\0")) return { ok: false, error: "git: op commit message contains a NUL byte" };
		if (message.length > TYPED_GIT_MESSAGE_MAX_CHARS) {
			return { ok: false, error: `git: op commit message exceeds ${TYPED_GIT_MESSAGE_MAX_CHARS} characters` };
		}
		return { ok: true, op, argv: ["commit", "-m", message] };
	}
	return null;
}

/** Sanity check that a typed argv is still what the classifier calls a task mutation. */
export function typedArgvIsTaskMutation(argv: ReadonlyArray<string>): boolean {
	return classifyGitArgv(argv).class === "task-mutation";
}

/**
 * The admission Git context for a native worker: its permit's allowance, its
 * execute capability, and, when the host created one, the task worktree it
 * owns, re-attested on every call.
 */
export function createWorkerGitContext(input: {
	allowance: WorkerGitAllowance;
	executePermitted: boolean;
	cwd: string;
	taskWorktree?: TaskWorktree;
}): AdmissionGitContext {
	const worktree = input.taskWorktree;
	return {
		allowance: input.allowance,
		executePermitted: input.executePermitted,
		cwd: input.cwd,
		hooksInsideWorkingTree: gitHooksInsideWorkingTree,
		...(worktree !== undefined
			? { taskWorktree: { attest: (cwd: string) => attestTaskWorktreeCwd(worktree, cwd) } }
			: {}),
	};
}
