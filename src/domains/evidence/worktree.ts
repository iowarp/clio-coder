import { sep } from "node:path";
import { readRunRecordAsync } from "../telemetry/run-record.js";
import { inspectRunTrustStatus } from "./trust-status.js";

export type AuthenticatedRunWorktree =
	| {
			branch: string;
			changedPaths?: string[];
			changedPathsOmitted?: number;
			apply: "merge" | "preserve";
			applied: boolean;
			snapshot?: "working-tree" | "unavailable";
			reason?: string;
	  }
	| { status: "withheld"; reason: "run-seal" };

/**
 * A run's writer checkout as its sealed scope records it. `ledgerCwd` is the run ledger's cwd for the run, read only
 * to say a task worktree exists whose placement the failed seal no longer vouches for (#434).
 */
export async function authenticatedRunWorktree(
	stateDir: string,
	runId: string,
	ledgerCwd: string | null,
): Promise<AuthenticatedRunWorktree | null> {
	try {
		const record = await readRunRecordAsync(stateDir, runId);
		const integrity = inspectRunTrustStatus(record).integrity;
		if (integrity.state !== "verified") {
			const segment = `${sep}.clio-coder${sep}worktrees${sep}${runId}`;
			const taskWorktree = ledgerCwd !== null && (ledgerCwd.endsWith(segment) || ledgerCwd.includes(`${segment}${sep}`));
			return integrity.state === "failed" && taskWorktree ? { status: "withheld", reason: "run-seal" } : null;
		}
		const verdict = record?.settled?.worktree;
		const worktree = record?.result?.state === "resolved" ? record.result.value.worktree : null;
		if (!verdict || !worktree) return null;
		const { branch, changedPaths } = worktree;
		return {
			branch,
			apply: verdict.apply,
			applied: verdict.applied,
			...(verdict.snapshot !== null ? { snapshot: verdict.snapshot } : {}),
			...(worktree.reason !== undefined ? { reason: worktree.reason } : {}),
			...(changedPaths === undefined
				? {}
				: { changedPaths: changedPaths.slice(0, 20), changedPathsOmitted: Math.max(0, changedPaths.length - 20) }),
		};
	} catch {
		return null;
	}
}
