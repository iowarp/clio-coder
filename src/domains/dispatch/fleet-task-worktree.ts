/**
 * The task worktree a `worktree`-scoped fleet runs in.
 *
 * A playbook that asks for `worktree` runs every step (builds, repairs, the checks that read the change, code steps)
 * in one task worktree cut from the checkout's HEAD, on `clio-coder/task/<fleet root id>`, the branch `run --agent
 * --worktree` uses for a single run. The fleet keeps it at the end exactly as a preserve-mode dispatch keeps its own,
 * so `clio-coder fleet land <id>` previews and lands it and the operator's checkout never changes during the run.
 */

import {
	createTaskWorktree,
	discardIdleTaskWorktree,
	gitCheckoutRoot,
	loadKeptTaskWorktree,
	reopenTaskWorktree,
	settleTaskWorktree,
	type TaskWorktree,
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

/**
 * Keep the worktree for `fleet land` when it holds work, remove it when the run changed nothing, and say which.
 * Never throws: the run's own outcome stands, and a claim left active is what restart recovery reads as a crash.
 */
export function keepFleetTaskWorktree(worktree: TaskWorktree, fleetRootId: string, onNotice?: (text: string) => void) {
	try {
		if (!taskWorktreeHoldsWork(worktree) && discardIdleTaskWorktree(worktree)) {
			onNotice?.(`fleet ${fleetRootId} changed nothing; removed its task worktree`);
			return;
		}
		settleTaskWorktree(worktree);
		onNotice?.(
			`fleet ${fleetRootId} kept its work on ${worktree.branch} in ${worktree.path}; the checkout is unchanged. Preview: clio-coder fleet land ${worktree.runId}; land: clio-coder fleet land ${worktree.runId} --yes`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onNotice?.(`fleet ${fleetRootId} could not settle its task worktree ${worktree.path}: ${message}`);
	}
}
