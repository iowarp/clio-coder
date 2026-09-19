import { rawDurationMs } from "../core/timers.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { gitCheckoutRoot, listPreservedTaskWorktrees, type PreservedTaskWorktree } from "../tools/task-worktree.js";

function ageLabel(createdAt: string | null, now: number): string {
	const created = createdAt === null ? Number.NaN : Date.parse(createdAt);
	if (!Number.isFinite(created)) return "age unknown";
	// A clock that stepped backwards renders as new, not as a negative age.
	const minutes = Math.floor(Math.max(0, rawDurationMs(created, now)) / 60_000);
	if (minutes < 60) return `${minutes}m old`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h old` : `${Math.floor(hours / 24)}d old`;
}

function describe(entry: PreservedTaskWorktree, now: number): string {
	return (
		`${entry.branch} (${entry.state}, ${ageLabel(entry.createdAt, now)}, ${entry.reason}): ` +
		`inspect with git log ${entry.base}..${entry.branch}; drop with git worktree remove --force ${entry.path} && ` +
		`git branch -D ${entry.branch} && rm ${entry.path}.task-owner.json`
	);
}

/**
 * Task worktrees (`worktree: true` dispatch) that outlived their run. Doctor
 * only reads: it never removes one, because each may hold the only copy of a
 * worker's changes.
 */
export function taskWorktreeFindings(workspaceRoot: string, now: number = Date.now()): DoctorFinding[] {
	const root = gitCheckoutRoot(workspaceRoot);
	if (root === null) return [];
	const preserved = listPreservedTaskWorktrees(root);
	if (preserved.length === 0) return [{ ok: true, name: "task worktrees", detail: "none preserved" }];
	return preserved.map((entry) => ({
		ok: true,
		// A run keeps its worktree on purpose; a crash leaving work behind wants a look.
		level: entry.state === "settled" ? ("info" as const) : ("warn" as const),
		name: `task worktree ${entry.runId}`,
		detail: describe(entry, now),
	}));
}
