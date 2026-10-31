import { loadRepoTelemetrySources } from "../session/telemetry-source.js";
import type { JournalSource } from "./read-model.js";

/** How far back `config inspect` reads a workspace's hook runs (#434). */
export const HOOK_RUN_WINDOW_DAYS = 7;

export interface HookRunSummary {
	count: number;
	outcomes: Record<string, number>;
	mostRecent: { at: string; hookId: string; outcome: string } | null;
}

/**
 * A workspace's `hook.ran` records over the window, across its sessions and the runs they dispatched. Hook runs a
 * process recorded outside any session sit in that process's journal and are not counted here (#434).
 */
export function workspaceHookRuns(stateDir: string, cwdHash: string, now = Date.now()): HookRunSummary {
	const { sessions } = loadRepoTelemetrySources(stateDir, {
		cwdHash,
		from: now - HOOK_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
		to: now,
		standaloneRuns: new Set(),
	});
	const summary: HookRunSummary = { count: 0, outcomes: {}, mostRecent: null };
	const fold = (journal: JournalSource): void => {
		for (const record of journal.records) {
			if (record.k !== "hook.ran") continue;
			summary.count += 1;
			summary.outcomes[record.data.outcome] = (summary.outcomes[record.data.outcome] ?? 0) + 1;
			if (!summary.mostRecent || record.t > summary.mostRecent.at)
				summary.mostRecent = { at: record.t, hookId: record.data.hookId, outcome: record.data.outcome };
		}
	};
	for (const session of sessions) {
		fold(session.journal);
		for (const run of session.runs.values()) fold(run);
	}
	return summary;
}
