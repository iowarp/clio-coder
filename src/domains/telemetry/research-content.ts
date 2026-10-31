import { listStateDirectory, withinStateRootAsync } from "../../core/state-boundary.js";
import type { JournalPayload, PreimageEventName } from "../../core/telemetry/events.js";
import { readCallJournal } from "./call-journal.js";
import { readTelemetryObject } from "./objects.js";
import { telemetrySessionDirectory, telemetrySessionsDirectory } from "./paths.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/u;

export interface JournaledContent<N extends PreimageEventName> {
	sessionId: string;
	at: string;
	data: JournalPayload<N>;
	/** The record's content, or null when retention, the cap or damage left nothing to resolve. */
	content: unknown | null;
}

/**
 * Every session journal's records of one content-bearing kind, oldest session first, with their content resolved
 * from the session's `objects/` (#434). `want` picks the records whose content is read at all, so a reader that
 * needs only some kinds of sample pays for no other objects. Unreadable journals and objects are skipped.
 */
export async function* readJournaledContent<N extends PreimageEventName>(
	stateDir: string,
	kind: N,
	want: (data: JournalPayload<N>, at: string) => boolean = () => true,
): AsyncGenerator<JournaledContent<N>> {
	let sessions: string[];
	try {
		sessions = (await listStateDirectory(stateDir, telemetrySessionsDirectory(stateDir)))
			.filter((name) => SAFE_ID.test(name))
			.sort();
	} catch {
		// No session has journaled anything yet.
		return;
	}
	for (const sessionId of sessions) {
		const directory = telemetrySessionDirectory(stateDir, sessionId);
		// A session scope that is symlinked or leaves the state root is not this host's content (#434).
		if (!(await withinStateRootAsync(stateDir, directory))) continue;
		let records: Awaited<ReturnType<typeof readCallJournal>>["records"];
		try {
			records = (await readCallJournal(directory)).records;
		} catch {
			// A journal another install owns or one damaged mid-file is not this reader's to judge.
			continue;
		}
		for (const { record } of records) {
			if (record.k !== kind) continue;
			const data = record.data as JournalPayload<N>;
			if (!want(data, record.t)) continue;
			let content: unknown | null = null;
			try {
				const read = await readTelemetryObject(
					directory,
					(data as { content: Parameters<typeof readTelemetryObject>[1] }).content,
				);
				if (read.kind === "resolved") content = read.value;
			} catch {
				// A corrupt object reads as missing content; its record still counts.
			}
			yield { sessionId, at: record.t, data, content };
		}
	}
}
