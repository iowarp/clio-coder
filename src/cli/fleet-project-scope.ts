import { readSettings } from "../core/config.js";
import { dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { FleetRunRecord } from "../domains/dispatch/state.js";
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
		// Old root records had no cwd. A complete set of recorded terminal runs
		// can still establish their project; an unstarted legacy root cannot.
		const terminalRuns = (record.steps ?? [])
			.map((step) => step.result.terminalRunId)
			.filter((id): id is string => typeof id === "string");
		if (record.cwd !== undefined && !ownership.inProject(record.cwd)) return false;
		return terminalRuns.length > 0 ? terminalRuns.every((id) => seesRunId(id, getRun)) : record.cwd !== undefined;
	};
	return { all, seesRun, seesRunId, seesRoot };
}
