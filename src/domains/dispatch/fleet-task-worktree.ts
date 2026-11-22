/**
 * The task worktree a `worktree`-scoped fleet runs in.
 *
 * A playbook that asks for `worktree` runs every step (builds, repairs, the checks that read the change, code steps)
 * in one task worktree cut from the checkout's HEAD, on `clio-coder/task/<fleet root id>`, the branch `run --agent
 * --worktree` uses for a single run. The fleet keeps it at the end exactly as a preserve-mode dispatch keeps its own,
 * so `clio-coder fleet land <id>` previews and lands it and the operator's checkout never changes during the run.
 */

import {
	applyTaskWorktree,
	createTaskWorktree,
	discardIdleTaskWorktree,
	gitCheckoutRoot,
	loadKeptTaskWorktree,
	reopenTaskWorktree,
	settleTaskWorktree,
	type TaskWorktree,
	type TaskWorktreePreview,
	taskWorktreeHoldsWork,
} from "../../tools/task-worktree.js";
import {
	allowedWorktreeParents,
	diskWorktreeParent,
	prepareWorktreeParent,
	resolveWorktreeRoot,
	type WorktreeRootSetting,
} from "../../tools/worktree-root.js";

export interface FleetTaskWorktreeInput {
	/** The operator's checkout the run was started in. */
	workspaceRoot: string;
	fleetRootId: string;
	/** The prior run's worktree id when this run resumes one; the work it replays is there. */
	resumeWorktree?: string;
	/** `fleet.worktrees.root`; absent reads as `disk`. */
	worktreeRootSetting?: WorktreeRootSetting;
	/** True when fleet nodes are configured, as dispatch decides it for one task worktree. */
	remoteEligible: boolean;
	onNotice?: (text: string) => void;
}

/** Create the run's worktree, or take back the one a resumed run left. Throws before any step starts. */
export function openFleetTaskWorktree(input: FleetTaskWorktreeInput): TaskWorktree {
	const root = gitCheckoutRoot(input.workspaceRoot);
	if (root === null) {
		throw new Error(
			`fleet ${input.fleetRootId}: a playbook with scope 'worktree' runs in a task worktree, and ${input.workspaceRoot} is not a git checkout`,
		);
	}
	const setting = input.worktreeRootSetting ?? "disk";
	if (input.resumeWorktree !== undefined) {
		const kept = loadKeptTaskWorktree(root, input.resumeWorktree, allowedWorktreeParents(setting, root));
		if (kept === null) {
			throw new Error(
				`fleet ${input.fleetRootId}: the task worktree ${input.resumeWorktree} the resumed run worked in is gone (landed or removed); start a new run instead of resuming`,
			);
		}
		if (kept.kind === "running") {
			throw new Error(`fleet ${input.fleetRootId}: task worktree ${input.resumeWorktree} is still in use by a live run`);
		}
		reopenTaskWorktree(kept.worktree);
		return kept.worktree;
	}
	let resolved = resolveWorktreeRoot({ setting, projectRoot: root, remoteEligible: input.remoteEligible });
	const untrusted = prepareWorktreeParent(resolved);
	if (untrusted !== null) {
		resolved = { parent: diskWorktreeParent(root), kind: "disk", notice: `${untrusted}; using the project root` };
	}
	if (resolved.notice !== undefined) input.onNotice?.(`fleet ${input.fleetRootId} task worktree: ${resolved.notice}`);
	return createTaskWorktree(root, input.fleetRootId, undefined, "preserve", resolved.parent);
}

/** The task worktree a run kept for `fleet land`, as the fleet result document names it. */
export interface FleetKeptWorktree {
	path: string;
	branch: string;
	/** The task branch tip holding the run's work; null when the settle commit could not be made. */
	commit: string | null;
	/** `fleet land` previews it. */
	preview: string;
	/** `fleet land --yes` lands it on the checkout's branch. */
	land: string;
}

/**
 * Keep the worktree for `fleet land` when it holds work, remove it when the run changed nothing, and say which.
 * The run's work is committed onto the task branch first, as a preserve-mode dispatch commits its own, so the branch
 * holds it even if the worktree directory is removed by hand. Returns what was kept, or null when nothing was.
 * Never throws: the run's own outcome stands, and a claim left active is what restart recovery reads as a crash.
 */
export function keepFleetTaskWorktree(
	worktree: TaskWorktree,
	run: { fleetRootId: string; playbookName: string },
	onNotice?: (text: string) => void,
): FleetKeptWorktree | null {
	const { fleetRootId } = run;
	try {
		if (!taskWorktreeHoldsWork(worktree) && discardIdleTaskWorktree(worktree)) {
			onNotice?.(`fleet ${fleetRootId} changed nothing; removed its task worktree`);
			return null;
		}
		let accounted: TaskWorktreePreview | undefined;
		let commit: string | null = null;
		try {
			// The fleet keeps no per-file write record across steps and code steps, so every untracked file is taken,
			// exactly what `fleet land --yes` commits for a worktree it finds uncommitted.
			const receipt = applyTaskWorktree({
				worktree,
				apply: "preserve",
				commitMessage: `fleet ${run.playbookName}`,
				authoredPaths: null,
				onAccounted: (value) => {
					accounted = value;
				},
			});
			commit = receipt.reason === undefined ? (receipt.commit ?? null) : null;
			if (receipt.reason !== undefined) {
				onNotice?.(
					`fleet ${fleetRootId} could not commit its work onto ${worktree.branch}: ${receipt.detail ?? receipt.reason}`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onNotice?.(`fleet ${fleetRootId} could not commit its work onto ${worktree.branch}: ${message}`);
		}
		settleTaskWorktree(worktree, accounted);
		const kept: FleetKeptWorktree = {
			path: worktree.path,
			branch: worktree.branch,
			commit,
			preview: `clio-coder fleet land ${worktree.runId}`,
			land: `clio-coder fleet land ${worktree.runId} --yes`,
		};
		onNotice?.(
			`fleet ${fleetRootId} kept its work on ${worktree.branch}${commit !== null ? ` at ${commit.slice(0, 12)}` : ""} in ${worktree.path}; the checkout is unchanged. Preview: ${kept.preview}; land: ${kept.land}`,
		);
		return kept;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onNotice?.(`fleet ${fleetRootId} could not settle its task worktree ${worktree.path}: ${message}`);
		return null;
	}
}
