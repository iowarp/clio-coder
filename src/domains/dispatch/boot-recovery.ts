/**
 * Restart recovery of the worktrees a hard-killed coordinator left behind:
 * its compete groups (leased workers terminated, then swept) and its task
 * worktrees (an empty one removed, one holding work kept and named).
 *
 * Boot creates the handle and starts it once the first frame is up, so the
 * terminate grace and the git calls never hold the first frame or block
 * input. Dispatch owns the ordering: its ledger scan and every admission wait
 * for the recovery to settle, so abandoned rows observe dead workers and no
 * stale worktree is reused. Any failure keeps the worktrees, reports once,
 * and settles the recovery; it never rejects.
 *
 * The git calls of compete cleanup and task-worktree recovery still run
 * synchronously; only their place moved, from before the first frame to
 * just after it.
 */

import { readSettings } from "../../core/config.js";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { isGitRepository, recoverCleanupReadyCompeteGroups } from "../../tools/compete-worktrees.js";
import { gitCheckoutRoot, recoverTaskWorktrees } from "../../tools/task-worktree.js";
import { allowedWorktreeParents, type WorktreeRootSetting } from "../../tools/worktree-root.js";
import { readGateDecisionArtifacts, readPendingGateDecisions } from "./gate-decisions.js";
import { normalizeYoloGateOutcome } from "./yolo-ids.js";

export interface WorktreeBootRecovery {
	/** Runs the recovery the first time; every call returns the same settlement. */
	start(): Promise<void>;
	/** Settles once a started recovery has finished; pending until start(). */
	readonly settled: Promise<void>;
	readonly started: boolean;
}

export interface WorktreeBootRecoveryOptions {
	cwd: string;
	/** fleet.worktrees.root from the boot settings; read when recovery runs if absent. */
	worktreeRootSetting?: WorktreeRootSetting;
	report?: (line: string) => void;
}

export function createWorktreeBootRecovery(options: WorktreeBootRecoveryOptions): WorktreeBootRecovery {
	const report = options.report ?? ((line: string) => writeDiagnostic(line));
	let resolveSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	let run: Promise<void> | null = null;
	return {
		start() {
			run ??= recoverWorktrees(options.cwd, options.worktreeRootSetting, report)
				.catch(() => {
					// A throwing reporter must not wedge the admissions waiting on this.
				})
				.then(resolveSettled);
			return run;
		},
		settled,
		get started() {
			return run !== null;
		},
	};
}

async function recoverWorktrees(
	cwd: string,
	worktreeRootSetting: WorktreeRootSetting | undefined,
	report: (line: string) => void,
): Promise<void> {
	if (!isGitRepository(cwd)) return;
	try {
		const pendingGate = readPendingGateDecisions();
		const pendingCompeteGroups = new Set<string>();
		for (const handle of pendingGate.records) {
			if (handle.record.kind === "output" && handle.record.topology === "compete") {
				pendingCompeteGroups.add(handle.record.group);
			} else if (handle.record.kind === "decision" && handle.record.decision.topology === "compete") {
				pendingCompeteGroups.add(handle.record.decision.group);
			}
		}
		const durableDecisions = readGateDecisionArtifacts();
		const confirmedGroups = new Set(
			durableDecisions
				.filter(
					({ artifact }) =>
						artifact.topology === "compete" &&
						(artifact.outcome === "operator-confirmed" || normalizeYoloGateOutcome(artifact.outcome) === "yolo-applied"),
				)
				.map(({ artifact }) => artifact.group),
		);
		for (const { artifact } of durableDecisions) {
			if (artifact.topology === "compete" && artifact.outcome === "winner" && !confirmedGroups.has(artifact.group)) {
				pendingCompeteGroups.add(artifact.group);
			}
		}
		const recovery = await recoverCleanupReadyCompeteGroups(cwd, {
			preserveActiveGroups: pendingCompeteGroups,
			preserveAllActive: pendingGate.errors.length > 0,
		});
		for (const failure of recovery.failed) {
			report(`[dispatch] compete recovery preserved ${failure.group}: ${failure.message}\n`);
		}
	} catch (err) {
		report(`[dispatch] compete recovery failed closed: ${err instanceof Error ? err.message : String(err)}\n`);
	}
	try {
		// Dispatch creates task worktrees under the checkout root, which a
		// session started in a subdirectory is not.
		const checkout = gitCheckoutRoot(cwd) ?? cwd;
		// A configured absolute root is only known from settings; the disk and
		// tmpfs locations are recognized whatever the settings say.
		const recovery = recoverTaskWorktrees(
			checkout,
			allowedWorktreeParents(worktreeRootSetting ?? configuredWorktreeRoot(), checkout),
		);
		for (const kept of recovery.preserved) {
			report(
				`[dispatch] task worktree recovery preserved ${kept.runId}: ${kept.reason} on ${kept.branch}; inspect with git log ${kept.base}..${kept.branch}\n`,
			);
		}
		for (const failure of recovery.failed) {
			report(`[dispatch] task worktree recovery preserved ${failure.runId}: ${failure.message}\n`);
		}
	} catch (err) {
		report(`[dispatch] task worktree recovery failed closed: ${err instanceof Error ? err.message : String(err)}\n`);
	}
}

/** The configured task worktree root, or the default when settings cannot be read. */
function configuredWorktreeRoot(): WorktreeRootSetting {
	try {
		return readSettings().fleet.worktrees.root;
	} catch {
		return "disk";
	}
}
