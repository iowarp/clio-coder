import { readSettings } from "../core/config.js";
import { rawDurationMs } from "../core/timers.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { gitCheckoutRoot, listPreservedTaskWorktrees, type PreservedTaskWorktree } from "../tools/task-worktree.js";
import {
	allowedWorktreeParents,
	HOST_WORKTREE_ROOT_FACTS,
	resolveWorktreeRoot,
	type WorktreeRootFacts,
} from "../tools/worktree-root.js";

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
		`git branch -D ${entry.branch} && rm ${entry.claimPath}`
	);
}

export interface TaskWorktreeFindingOptions {
	now?: number;
	/** `fleet.worktrees.root`; read from settings when absent. */
	rootSetting?: string;
	remoteEligible?: boolean;
	facts?: WorktreeRootFacts;
}

function configuredRoot(): { setting: string; remoteEligible: boolean } {
	try {
		const fleet = readSettings().fleet;
		return { setting: fleet.worktrees.root, remoteEligible: fleet.nodes.length > 0 };
	} catch {
		return { setting: "disk", remoteEligible: false };
	}
}

function formatGiB(bytes: number | null): string {
	return bytes === null ? "free space unknown" : `${(bytes / 1024 ** 3).toFixed(1)} GiB free`;
}

/**
 * Task worktrees (`worktree: true` dispatch): where the next one would be
 * created, and every one that outlived its run. Doctor only reads: it never
 * removes one, because each may hold the only copy of a worker's changes.
 */
export function taskWorktreeFindings(workspaceRoot: string, options: TaskWorktreeFindingOptions = {}): DoctorFinding[] {
	const root = gitCheckoutRoot(workspaceRoot);
	if (root === null) return [];
	const now = options.now ?? Date.now();
	const facts = options.facts ?? HOST_WORKTREE_ROOT_FACTS;
	const configured = options.rootSetting === undefined ? configuredRoot() : null;
	const setting = options.rootSetting ?? configured?.setting ?? "disk";
	const remoteEligible = options.remoteEligible ?? configured?.remoteEligible ?? false;
	const resolved = resolveWorktreeRoot({ setting, projectRoot: root, remoteEligible, facts });
	const measured = resolved.base ?? root;
	const rootFinding: DoctorFinding = {
		ok: true,
		level: resolved.notice === undefined ? "ok" : "warn",
		name: "task worktree root",
		detail:
			`fleet.worktrees.root ${setting}: ${resolved.parent} (${facts.filesystemType(measured) ?? "unknown filesystem"}, ` +
			`${formatGiB(facts.freeBytes(measured))})${resolved.notice === undefined ? "" : `; ${resolved.notice}`}`,
	};
	const preserved = listPreservedTaskWorktrees(root, allowedWorktreeParents(setting, root, facts));
	if (preserved.length === 0) {
		return [rootFinding, { ok: true, name: "task worktrees", detail: "none preserved" }];
	}
	return [
		rootFinding,
		...preserved.map((entry) => ({
			ok: true,
			// A run keeps its worktree on purpose; a crash leaving work behind wants a look.
			level: entry.state === "settled" ? ("info" as const) : ("warn" as const),
			name: `task worktree ${entry.runId}`,
			detail: describe(entry, now),
		})),
	];
}
