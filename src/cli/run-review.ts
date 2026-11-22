/**
 * `run --agent <recipe> --review <run>`: review a fleet run's kept task branch. The worker judges the files of the
 * directory it runs in, so a review started from the operator's checkout judged that checkout and not the branch.
 * The run id or `clio-coder/task/<run id>` branch resolves through fleet land's resolver to the kept worktree, its
 * base and its destination; the run then enters that worktree and the subject is prepended to the task. A branch the
 * reviewer could not see, and a task naming one without `--review`, is refused before boot with the remedy.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { internalGitArgv, withoutRepositoryEnv } from "../core/internal-git.js";
import { planTaskLand } from "../tools/task-land.js";

export type ReviewSubject = { worktree: string; task: string } | { refusal: string };

function headOf(cwd: string): string {
	const result = spawnSync("git", internalGitArgv(["-C", cwd, "symbolic-ref", "-q", "HEAD"]), {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...withoutRepositoryEnv(), LC_ALL: "C" },
	});
	return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/** The kept worktree to run in and the subject text, or the refusal naming the remedy. */
export function resolveReviewSubject(input: {
	root: string;
	ref: string;
	agentId: string;
	allowedParents?: ReadonlyArray<string>;
}): ReviewSubject {
	let plan: ReturnType<typeof planTaskLand>;
	try {
		plan = planTaskLand({
			root: input.root,
			ref: input.ref,
			mode: "merge",
			...(input.allowedParents !== undefined ? { allowedParents: input.allowedParents } : {}),
		});
	} catch (error) {
		return { refusal: `cannot review ${input.ref}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const { branch, runId } = plan;
	const path = plan.worktree?.path;
	if (path === undefined || !existsSync(path)) {
		return {
			refusal: `cannot review ${branch}: it has no kept worktree to review in (its claim was released or the worktree removed); check it out with \`git worktree add <dir> ${branch}\` and run \`clio-coder run --agent ${input.agentId} --cwd <dir> "<task>"\`, or land it with \`clio-coder fleet land ${runId}\` and review it there`,
		};
	}
	const head = headOf(path);
	if (head !== `refs/heads/${branch}`) {
		return {
			refusal: `cannot review ${branch}: its kept worktree ${path} is on ${head.replace(/^refs\/heads\//u, "") || "a detached HEAD"}, not ${branch}; check out ${branch} there first`,
		};
	}
	// No absolute path in the text: a dispatch without declared intent refuses an absolute path token in its task.
	const lines = [
		`Review subject: task branch ${branch} of run ${runId}, checked out in this run's working directory.`,
		`Base: ${plan.base} (the commit the run started from). Destination: ${plan.destination} at ${plan.destinationHead.slice(0, 12)}.`,
		`The change is the diff of this worktree against the base${plan.uncommitted > 0 ? `, including ${plan.uncommitted} uncommitted path(s)` : ""}; changes against the destination: ${plan.changed}.`,
		...(plan.commits.length > 0
			? ["Commits, newest first:", ...plan.commits.map((line) => `  ${line}`)]
			: ["The branch has no commits of its own."]),
	];
	return { worktree: path, task: lines.join("\n") };
}

const TASK_BRANCH = /clio-coder\/task\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/u;

/**
 * An `--agent` task that names a task branch from a directory that does not have it checked out: the worker would
 * judge these files, not the branch. Returns the refusal naming `--review`, or null.
 */
export function taskBranchRefusal(text: string, cwd: string, agentId: string): string | null {
	const named = TASK_BRANCH.exec(text)?.[1]?.replace(/\.+$/u, "");
	if (named === undefined || named.length === 0) return null;
	const branch = `clio-coder/task/${named}`;
	const head = headOf(cwd);
	if (head === `refs/heads/${branch}`) return null;
	return `the task names ${branch}, but this run's directory has ${head.replace(/^refs\/heads\//u, "") || "no branch"} checked out, so the worker would judge these files, not that branch; review it with \`clio-coder run --agent ${agentId} --review ${named} "<task>"\``;
}
