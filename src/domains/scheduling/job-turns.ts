import type { SessionEntry } from "../session/entries.js";

const JOB_ORIGIN = /^job (\S+) \S+$/;

/**
 * The operator turns each job ran in a conversation, read off its ledger: a job's machine turn persists its user
 * message with the origin `job <id> <execution>`, which is the only record that outlives the job's bounded history.
 * The ledger only grows, so each read scans just the entries appended since the last one; a rewritten ledger, one whose
 * last scanned entry is no longer where it was, is scanned again from the start (#434 §11.3).
 */
export function createJobTurnIndex(read: () => ReadonlyArray<SessionEntry>): (jobId: string) => readonly string[] {
	let scanned: ReadonlyArray<SessionEntry> = [];
	let byJob = new Map<string, string[]>();
	return (jobId) => {
		const entries = read();
		if (entries !== scanned) {
			const last = scanned.at(-1);
			const appended = last !== undefined && entries[scanned.length - 1] === last;
			if (!appended) byJob = new Map();
			for (let index = appended ? scanned.length : 0; index < entries.length; index += 1) {
				const entry = entries[index];
				if (entry?.kind !== "message" || entry.role !== "user") continue;
				const origin = (entry.payload as { origin?: unknown } | null | undefined)?.origin;
				const id = typeof origin === "string" ? JOB_ORIGIN.exec(origin)?.[1] : undefined;
				if (id === undefined) continue;
				const turns = byJob.get(id);
				if (turns) turns.push(entry.turnId);
				else byJob.set(id, [entry.turnId]);
			}
			scanned = entries;
		}
		return byJob.get(jobId) ?? [];
	};
}
