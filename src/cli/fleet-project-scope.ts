import { dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { FleetRunRecord } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";

/** One CLI inspection's explicit machine-wide choice or current-project view. */
export function fleetInspectionScope(all: boolean, cwd = process.cwd()) {
	const ownership = dispatchOwnership({ sessionId: null, cwd });
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
