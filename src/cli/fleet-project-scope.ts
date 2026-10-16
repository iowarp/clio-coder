import { readSettings } from "../core/config.js";
import type { CodeStepRecord } from "../domains/dispatch/code-step.js";
import { readCodeStepRecords } from "../domains/dispatch/code-step-store.js";
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
		// Deterministic steps have their own command records, not model-ledger
		// rows, and are read only once a run id misses the ledger.
		let codeSteps: Map<string, CodeStepRecord> | undefined;
		return terminalRuns.every((id) => {
			const run = getRun(id);
			if (run !== null) return seesRun(run);
			codeSteps ??= new Map(readCodeStepRecords(record.id).map((step) => [step.runId, step]));
			const code = codeSteps.get(id);
			return code !== undefined && typeof code.cwd === "string" && ownership.inProject(code.cwd);
		});
	};
	return { all, seesRun, seesRunId, seesRoot };
}
