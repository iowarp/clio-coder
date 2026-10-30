/**
 * `fleet land`: put a finished run's task branch onto the branch it was
 * dispatched from, after the run itself kept it (a withheld merge, apply mode
 * preserve, a conflict, a headless run, a crash recovery kept). The landing
 * commit is built with plumbing (`merge-tree --write-tree`, `commit-tree`), so
 * a conflict is found and reported before anything changes, and the only step
 * that touches the operator's checkout is `merge --ff-only`, which Git refuses
 * when it would overwrite a local change.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalGitArgv } from "../core/internal-git.js";
import { SAFE_TASK_RUN_ID } from "../core/task-worktree-claim.js";
import {
	COMMIT_IDENTITY,
	cleanupTaskWorktree,
	commitWorktreePath,
	destinationRefusal,
	gitOperationInProgress,
	hostCommitIdentity,
	listPreservedTaskWorktrees,
	loadKeptTaskWorktree,
	mergeDestination,
	type TaskWorktree,
	type TaskWorktreeState,
} from "./task-worktree.js";

export type TaskLandMode = "merge" | "squash";

export interface TaskLandPlan {
	root: string;
	runId: string;
	branch: string;
	/** The run's claimed worktree; null for a branch whose claim was already released. */
	worktree: TaskWorktree | null;
	/** Modified, staged or untracked paths in the kept worktree that landing commits onto the branch first. */
	uncommitted: number;
	tip: string;
	/** Tree of the branch tip plus any uncommitted work: what the task contributes. */
	sourceTree: string;
	base: string;
	destination: string;
	destinationHead: string;
	mode: TaskLandMode;
	fastForward: boolean;
	/** Every change the task carries is already on the destination. */
	alreadyLanded: boolean;
	/** Tree the destination holds after landing. */
	tree: string;
	/** `<short> <subject>` for the branch's own commits, newest first, at most 20. */
	commits: string[];
	changed: string;
	/** Digest of what the plan would land; `--plan` refuses a landing that drifted from it. */
	planId: string;
	refusal: string | null;
}

export interface TaskLandResult {
	/** The commit the destination now points at; null when nothing new landed. */
	landed: string | null;
	cleaned: boolean;
	detail: string;
}

interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

// merge-tree conflict lines and ff refusals are parsed or shown, so Git speaks one locale.
function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): GitResult {
	const result = spawnSync("git", internalGitArgv(["-C", cwd, ...args]), {
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, LC_ALL: "C", LANGUAGE: "", ...env },
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function firstLine(text: string): string {
	return (
		text
			.split(/\r?\n/u)
			.find((line) => line.trim().length > 0)
			?.trim() ?? ""
	);
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
	const result = run(cwd, args, env);
	if (result.status !== 0) throw new Error(firstLine(result.stderr) || `git ${args[0] ?? ""} failed`);
	return result.stdout.trim();
}

/** Git's refusal with the paths it names, which it prints on tab-indented lines after the message. */
function refusalText(stderr: string): string {
	const message = firstLine(stderr)
		.replace(/^error: /u, "")
		.replace(/:$/u, "");
	const paths = stderr
		.split(/\r?\n/u)
		.filter((line) => line.startsWith("\t"))
		.map((line) => line.trim());
	return `${message || "unknown reason"}${paths.length > 0 ? ` (${paths.slice(0, 10).join(", ")})` : ""}`;
}

function succeeds(cwd: string, args: string[]): boolean {
	return run(cwd, args).status === 0;
}

function configured(root: string, key: string): string | null {
	const value = run(root, ["config", "--get", key]).stdout.trim();
	return value.length > 0 ? value : null;
}

function runIdOf(ref: string): string {
	const runId = ref.startsWith("clio-coder/task/") ? ref.slice("clio-coder/task/".length) : ref;
	if (!SAFE_TASK_RUN_ID.test(runId)) throw new Error(`'${ref}' is not a task run id or clio-coder/task/<run id> branch`);
	return runId;
}

/**
 * The tree the kept worktree would commit, written through a private index so
 * neither the worktree's index nor its HEAD changes while only previewing.
 */
function snapshotTree(path: string, tip: string): string {
	const directory = mkdtempSync(join(tmpdir(), "clio-coder-land-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(directory, "index") };
		git(path, ["read-tree", tip], env);
		git(path, ["add", "-A", "--", "."], env);
		return git(path, ["write-tree"], env);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export function planTaskLand(input: {
	root: string;
	ref: string;
	mode: TaskLandMode;
	allowedParents?: ReadonlyArray<string>;
}): TaskLandPlan {
	const root = git(input.root, ["rev-parse", "--show-toplevel"]);
	const runId = runIdOf(input.ref);
	const loaded = loadKeptTaskWorktree(root, runId, input.allowedParents);
	if (loaded?.kind === "running")
		throw new Error(`task ${runId} is still running; wait for it to settle or cancel it first`);
	const worktree = loaded?.worktree ?? null;
	const branch = worktree?.branch ?? `clio-coder/task/${runId}`;
	const tipLookup = run(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`]);
	if (tipLookup.status !== 0) throw new Error(`no branch ${branch} for task ${runId}`);
	const tip = tipLookup.stdout.trim();
	const destinationHead = git(root, ["rev-parse", "HEAD"]);
	const base =
		worktree?.base ?? configured(root, `branch.${branch}.clio-coder-base`) ?? git(root, ["merge-base", "HEAD", tip]);
	const sourceBranch = worktree?.sourceBranch ?? configured(root, `branch.${branch}.clio-coder-source`) ?? undefined;
	const refusals: string[] = [];

	let uncommitted = 0;
	let sourceTree = git(root, ["rev-parse", `${tip}^{tree}`]);
	if (worktree !== null && existsSync(worktree.path)) {
		const head = run(worktree.path, ["symbolic-ref", "-q", "HEAD"]).stdout.trim();
		if (head !== `refs/heads/${branch}`) {
			refusals.push(
				`the kept worktree ${worktree.path} is on ${head || "a detached HEAD"}, not ${branch}; move its work onto ${branch} first`,
			);
		} else {
			const status = git(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
			uncommitted = status.length > 0 ? status.split("\n").length : 0;
			if (uncommitted > 0) sourceTree = snapshotTree(worktree.path, tip);
		}
	}
	// Merge analysis needs a commit; this one is a dangling object, never a ref.
	const source =
		uncommitted > 0
			? git(root, [...hostCommitIdentity(root, COMMIT_IDENTITY), "commit-tree", sourceTree, "-p", tip, "-m", "snapshot"])
			: tip;

	const destination = mergeDestination(root);
	const operation = gitOperationInProgress(git(root, ["rev-parse", "--absolute-git-dir"]));
	if (operation !== null) refusals.push(`a ${operation} is in progress in ${root}; finish or abort it first`);
	const stranded = destinationRefusal(
		{ root, runId, path: worktree?.path ?? "", branch, base, ...(sourceBranch ? { sourceBranch } : {}), ownerToken: "" },
		destination,
	);
	if (stranded !== null) refusals.push(stranded);

	const headTree = git(root, ["rev-parse", "HEAD^{tree}"]);
	let alreadyLanded = succeeds(root, ["merge-base", "--is-ancestor", source, destinationHead]);
	const fastForward = !alreadyLanded && succeeds(root, ["merge-base", "--is-ancestor", destinationHead, source]);
	let tree = headTree;
	let conflicted = false;
	if (fastForward) tree = sourceTree;
	else if (!alreadyLanded) {
		const merged = run(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", destinationHead, source]);
		const lines = merged.stdout.split("\n").filter((line) => line.length > 0);
		if (merged.status === 1) {
			conflicted = true;
			const files = lines.slice(1);
			refusals.push(
				`it conflicts with ${destination} in ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` and ${files.length - 10} more` : ""}; resolve the conflict on ${branch} or merge it by hand`,
			);
		} else if (merged.status !== 0 || lines[0] === undefined) {
			throw new Error(`git merge-tree --write-tree failed (Git 2.38 or newer is required): ${firstLine(merged.stderr)}`);
		}
		tree = lines[0] ?? headTree;
	}
	// A merge that would change nothing has already landed by other means.
	if (!alreadyLanded && refusals.length === 0 && tree === headTree) alreadyLanded = true;
	// A conflicted tree holds conflict markers, so its diff would overstate the task.
	const changed = alreadyLanded
		? "no changes"
		: conflicted
			? "unknown until the conflict is resolved"
			: git(root, ["diff", "--shortstat", destinationHead, tree]) || "no changes";
	const commits = git(root, ["log", "--format=%h %s", "-n", "20", `${base}..${tip}`])
		.split("\n")
		.filter((line) => line.length > 0);
	const planId = createHash("sha256")
		.update([tip, sourceTree, destinationHead, input.mode].join("\0"))
		.digest("hex")
		.slice(0, 12);
	return {
		root,
		runId,
		branch,
		worktree,
		uncommitted,
		tip,
		sourceTree,
		base,
		destination,
		destinationHead,
		mode: input.mode,
		fastForward,
		alreadyLanded,
		tree,
		commits,
		changed,
		planId,
		refusal: refusals.length > 0 ? refusals.join("; ") : null,
	};
}

/**
 * One commit keeps its own message and author, trailers included. Several
 * become one commit named after the newest, listing the rest.
 */
function squashCommit(plan: TaskLandPlan, source: string, message: string | undefined) {
	const shas = git(plan.root, ["rev-list", "--reverse", `${plan.base}..${source}`])
		.split("\n")
		.filter((sha) => sha.length > 0);
	if (message !== undefined) return { message, env: {} };
	const only = shas.length === 1 ? shas[0] : undefined;
	if (only !== undefined) {
		const [name, email, date] = git(plan.root, ["log", "-1", "--format=%an%x00%ae%x00%aI", only]).split("\0");
		return {
			message: git(plan.root, ["log", "-1", "--format=%B", only]),
			env: {
				...(name ? { GIT_AUTHOR_NAME: name } : {}),
				...(email ? { GIT_AUTHOR_EMAIL: email } : {}),
				...(date ? { GIT_AUTHOR_DATE: date } : {}),
			},
		};
	}
	const subjects = shas.map((sha) => git(plan.root, ["log", "-1", "--format=%s", sha]));
	return {
		message: `${subjects.at(-1) ?? `Clio Coder task ${plan.runId}`}\n\nSquashes ${shas.length} commits from ${plan.branch}:\n${subjects.map((subject) => `- ${subject}`).join("\n")}\n\nClio Coder task ${plan.runId}`,
		env: {},
	};
}

export function executeTaskLand(
	plan: TaskLandPlan,
	options: { message?: string; keep?: boolean } = {},
): TaskLandResult {
	if (plan.refusal !== null) throw new Error(plan.refusal);
	const tipNow = git(plan.root, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${plan.branch}^{commit}`]);
	if (tipNow !== plan.tip) throw new Error(`${plan.branch} moved since it was planned; plan again`);
	let source = plan.tip;
	if (plan.uncommitted > 0 && plan.worktree !== null) {
		commitWorktreePath(plan.worktree.path, COMMIT_IDENTITY, `Clio Coder task ${plan.runId}`);
		source = git(plan.root, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${plan.branch}^{commit}`]);
		if (git(plan.root, ["rev-parse", `${source}^{tree}`]) !== plan.sourceTree)
			throw new Error(
				`the worktree changed since it was planned; its work is now committed on ${plan.branch} and nothing landed`,
			);
	}
	let landed: string | null = null;
	if (!plan.alreadyLanded) {
		let landing = source;
		if (plan.mode === "squash" || !plan.fastForward) {
			const parents = plan.mode === "merge" ? ["-p", plan.destinationHead, "-p", source] : ["-p", plan.destinationHead];
			const commit =
				plan.mode === "squash" ? squashCommit(plan, source, options.message) : { message: options.message, env: {} };
			landing = git(
				plan.root,
				[
					...hostCommitIdentity(plan.root, COMMIT_IDENTITY),
					"commit-tree",
					plan.tree,
					...parents,
					"-m",
					commit.message ?? `Merge branch '${plan.branch}'`,
				],
				commit.env,
			);
		}
		if (git(plan.root, ["rev-parse", "HEAD"]) !== plan.destinationHead)
			throw new Error(`${plan.destination} moved since it was planned; plan again`);
		const fastForwarded = run(plan.root, ["merge", "--ff-only", "--quiet", landing]);
		if (fastForwarded.status !== 0)
			throw new Error(
				`Git refused to fast-forward ${plan.destination}: ${refusalText(fastForwarded.stderr)}; nothing changed on ${plan.destination}${source !== plan.tip ? `, and the worktree's work is committed on ${plan.branch}` : ""}`,
			);
		landed = landing;
	}
	if (options.keep) {
		return { landed, cleaned: false, detail: `kept ${plan.branch}${plan.worktree !== null ? " and its worktree" : ""}` };
	}
	if (plan.worktree !== null) cleanupTaskWorktree(plan.worktree, true);
	else git(plan.root, ["branch", "-D", plan.branch]);
	return {
		landed,
		cleaned: true,
		detail: `removed ${plan.branch}${plan.worktree !== null ? ", its worktree and its claim" : ""}`,
	};
}

export interface LandableTask {
	runId: string;
	branch: string;
	/** `branch only` is a task branch whose claim was released. */
	state: TaskWorktreeState | "branch only";
	commits: number | null;
	worktreePresent: boolean;
	reason: string;
}

/** Task branches a finished run left behind, with or without their claims. */
export function listLandableTasks(root: string, allowedParents?: ReadonlyArray<string>): LandableTask[] {
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	const count = (base: string, branch: string): number | null => {
		const value = Number.parseInt(run(top, ["rev-list", "--count", `${base}..refs/heads/${branch}`]).stdout, 10);
		return Number.isSafeInteger(value) ? value : null;
	};
	const kept = listPreservedTaskWorktrees(top, allowedParents).filter((entry) => !entry.stale);
	const out: LandableTask[] = kept.map((entry) => ({
		runId: entry.runId,
		branch: entry.branch,
		state: entry.state,
		commits: count(entry.base, entry.branch),
		worktreePresent: existsSync(entry.path),
		reason: entry.reason,
	}));
	const claimed = new Set(kept.map((entry) => entry.branch));
	for (const branch of git(top, ["for-each-ref", "--format=%(refname:short)", "refs/heads/clio-coder/task/"])
		.split("\n")
		.filter((name) => name.length > 0 && !claimed.has(name))) {
		const runId = branch.slice("clio-coder/task/".length);
		// A live run's claim is not listed as kept; its branch is not landable either.
		if (!SAFE_TASK_RUN_ID.test(runId) || loadKeptTaskWorktree(top, runId, allowedParents)?.kind === "running") continue;
		const base =
			configured(top, `branch.${branch}.clio-coder-base`) ?? run(top, ["merge-base", "HEAD", branch]).stdout.trim();
		out.push({
			runId,
			branch,
			state: "branch only",
			commits: base.length > 0 ? count(base, branch) : null,
			worktreePresent: false,
			reason: "its claim was released and the branch kept",
		});
	}
	return out;
}
