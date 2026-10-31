import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readSettings } from "../core/config.js";
import { clioStateDir } from "../core/xdg.js";
import { dispatchOwnership } from "../domains/dispatch/ownership.js";
import { type FleetRunRecord, openLedger, readFleetRun } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";

/** The configured `fleet.worktrees.root`, so runs in a custom-root worktree stay visible to project scope. */
function configuredWorktreeRoot(): { worktreeRoot: string } | Record<string, never> {
	try {
		return { worktreeRoot: readSettings().fleet.worktrees.root };
	} catch {
		// Unreadable settings leave the disk and tmpfs locations, which is the pre-setting behavior.
		return {};
	}
}

/** One CLI inspection's explicit machine-wide choice or current-project view. */
export function fleetInspectionScope(all: boolean, cwd = process.cwd()) {
	const ownership = dispatchOwnership({ sessionId: null, cwd, ...configuredWorktreeRoot() });
	const seesRun = (run: RunEnvelope): boolean => all || ownership.seesRun(run);
	const seesRunId = (runId: string, getRun: (id: string) => RunEnvelope | null): boolean => {
		const run = getRun(runId);
		return run !== null && seesRun(run);
	};
	const seesRoot = (record: FleetRunRecord, getRun: (id: string) => RunEnvelope | null): boolean => {
		if (all) return true;
		// A root that records where it was launched answers from that alone. The
		// ledger keeps the newest 1000 runs, so a root whose step runs were
		// evicted must not vanish from its own project.
		if (record.cwd !== undefined) return ownership.inProject(record.cwd);
		// Old root records had no cwd. A complete set of recorded terminal runs
		// can still establish their project; an unstarted legacy root cannot.
		const terminalRuns = (record.steps ?? [])
			.map((step) => step.result.terminalRunId)
			.filter((id): id is string => typeof id === "string");
		if (terminalRuns.length === 0) return false;
		return terminalRuns.every((id) => {
			const run = getRun(id);
			return run !== null && seesRun(run);
		});
	};
	return { all, seesRun, seesRunId, seesRoot };
}

/**
 * Resolve a fleet root the way `fleet view` resolves a run: exact id
 * first, then a unique prefix over the durable fleet-run records. An ambiguous
 * prefix resolves to nothing so the caller can name what it matched.
 */
export function resolveFleetRootId(
	token: string,
	scope: ReturnType<typeof fleetInspectionScope>,
): { rootId: string } | { candidates: string[] } {
	const ledger = openLedger();
	const exact = readFleetRun(token);
	if (exact !== null && scope.seesRoot(exact, (id) => ledger.get(id))) return { rootId: token };
	let entries: string[];
	try {
		entries = readdirSync(join(clioStateDir(), "fleet-runs"));
	} catch {
		return { candidates: [] };
	}
	const candidates = entries
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.filter((id) => id.startsWith(token))
		.filter((id) => {
			const record = readFleetRun(id);
			return record !== null && scope.seesRoot(record, (runId) => ledger.get(runId));
		});
	if (candidates.length === 1 && candidates[0] !== undefined) return { rootId: candidates[0] };
	return { candidates };
}
