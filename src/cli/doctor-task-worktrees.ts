import { existsSync } from "node:fs";
import { readSettings } from "../core/config.js";
import { shellQuote } from "../core/shell-quote.js";
import { rawDurationMs } from "../core/timers.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import {
	clearStaleTaskClaim,
	gitCheckoutRoot,
	listPreservedTaskWorktrees,
	type PreservedTaskWorktree,
} from "../tools/task-worktree.js";
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

/** Safe paths print bare, as before; anything a shell would split or expand is quoted. */
function shellWord(value: string): string {
	return /^[\w@%+=:,./-]+$/u.test(value) ? value : shellQuote(value);
}

function describe(entry: PreservedTaskWorktree, now: number, root: string, inRam: boolean): string {
	// The leading `cd` makes the drop line work from any directory; without it
	// `git worktree remove` failed with "not a git repository" outside the checkout.
	// A tmpfs working tree is gone after a reboot; `worktree remove` then fails
	// on the missing path and the `&&` chain would leave the branch and claim.
	const release = existsSync(entry.path) ? `git worktree remove --force ${shellWord(entry.path)}` : "git worktree prune";
	return (
		`${entry.branch} (${entry.state}, ${ageLabel(entry.createdAt, now)}, ${entry.reason})${inRam ? " [held in RAM]" : ""}: ` +
		`inspect with git log ${entry.base}..${entry.branch}; drop with cd ${shellWord(root)} && ` +
		`${release} && ` +
		`git branch -D ${entry.branch} && rm ${shellWord(entry.claimPath)}`
	);
}

export interface TaskWorktreeFindingOptions {
	now?: number;
	/** `fleet.worktrees.root`; read from settings when absent. */
	rootSetting?: string;
	remoteEligible?: boolean;
	facts?: WorktreeRootFacts;
	/** `doctor --fix`: remove claim files whose branch and worktree are already gone. */
	fix?: boolean;
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
 * created, and every one that outlived its run. Doctor never removes a
 * worktree or a branch, because each may hold the only copy of a worker's
 * changes. A claim whose branch and worktree were both removed by hand holds
 * nothing; it used to be listed as a kept worktree with a drop command that
 * failed on the missing branch. It is reported as stale, and `--fix` removes it.
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
		...preserved.map((entry): DoctorFinding => {
			const name = `task worktree ${entry.runId}`;
			if (entry.stale) {
				if (options.fix === true && clearStaleTaskClaim(root, entry)) {
					return { ok: true, name, detail: `removed the stale claim; ${entry.branch} and its worktree were already gone` };
				}
				return {
					ok: true,
					level: "warn",
					name,
					detail: `stale claim: ${entry.branch} and its worktree are gone; clear with rm ${shellWord(entry.claimPath)} or clio-coder doctor --fix`,
				};
			}
			// Nothing removes a preserved worktree, so one on tmpfs keeps its
			// files in memory until the operator drops it or the host reboots.
			const inRam = existsSync(entry.path) && facts.filesystemType(entry.path) === "tmpfs";
			return {
				ok: true,
				// A run keeps its worktree on purpose; a crash leaving work behind wants a look.
				level: entry.state === "settled" ? ("info" as const) : ("warn" as const),
				name,
				detail: describe(entry, now, root, inRam),
			};
		}),
	];
}
