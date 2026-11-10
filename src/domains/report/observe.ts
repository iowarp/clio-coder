import { loadSessionTelemetrySource, loadSessionTelemetrySourceAsync } from "../session/index.js";
import { whyStopped } from "../telemetry/index.js";

/**
 * What the harness recorded about a session, as typed facts. The model has no field that reaches this section of a
 * report: each observation is a code and vocabulary values or numbers, rendered through a fixed sentence table.
 */
export type ReportObservation =
	| {
			code: "turn-ended";
			values: { stopReason: string; cause: string | null; stage: string | null; retries: number };
	  }
	| { code: "turn-aborted"; values: { source: string } }
	| { code: "turn-continued"; values: { cause: string; attempt: number; cap: number } }
	| { code: "compaction"; values: { outcome: string } }
	| { code: "crash"; values: { name: string; frames: string[] } };

const VOCABULARY_VALUE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u;

/** A journal value is closed vocabulary when it was written; anything else reads as unknown, never as text. */
function word(value: unknown): string {
	return typeof value === "string" && VOCABULARY_VALUE.test(value) ? value : "unknown";
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1_000_000 ? value : 0;
}

/** A crash frame is `function@module` from the crash record; anything else reads as unknown. */
function frame(value: unknown): string {
	return typeof value === "string" && /^[\w$.<>[\] -]{1,80}@[\w$./@:-]{1,120}$/u.test(value) ? value : "unknown";
}

const ABORT_SOURCES: Readonly<Record<string, string>> = {
	stream_cancel: "the operator",
	loop_guard: "the loop guard",
	job_clock: "a job's clock",
	autonomy: "a yolo pause",
};

const COMPACTION_OUTCOMES: Readonly<Record<string, string>> = {
	committed: "committed",
	discarded: "discarded",
	failed: "failed",
	unresolved: "left unresolved",
};

/** One sentence per observation, built from vocabulary values and numbers only. */
export function renderObservation(observation: ReportObservation): string {
	switch (observation.code) {
		case "turn-ended": {
			const { stopReason, cause, stage, retries } = observation.values;
			const on = cause !== null ? ` on \`${word(cause)}\`` : "";
			const at = stage !== null ? ` at stage \`${word(stage)}\`` : "";
			const after = retries > 0 ? ` after ${count(retries)} ${retries === 1 ? "retry" : "retries"}` : "";
			return `The last turn ended (\`${word(stopReason)}\`)${on}${at}${after}.`;
		}
		case "turn-aborted":
			return `The last turn's stream was stopped by ${ABORT_SOURCES[observation.values.source] ?? `\`${word(observation.values.source)}\``}.`;
		case "turn-continued": {
			const { cause, attempt, cap } = observation.values;
			return `The turn continued automatically on \`${word(cause)}\`, ${count(attempt)} of ${count(cap)} allowed.`;
		}
		case "compaction":
			return `The last compaction was ${COMPACTION_OUTCOMES[observation.values.outcome] ?? `\`${word(observation.values.outcome)}\``}.`;
		case "crash": {
			const frames = observation.values.frames.slice(0, 5).map(frame);
			const top = frames.length > 0 ? `; top frames ${frames.map((item) => `\`${item}\``).join(", ")}` : "";
			return `Clio Coder crashed with \`${word(observation.values.name)}\`${top}.`;
		}
	}
}

/** The session's last turn, its abort source, its last continuation and the last compaction outcome. */
export function observeSession(stateDir: string, sessionId: string): ReportObservation[] {
	return observationsOf(loadSessionTelemetrySource(stateDir, sessionId));
}

/** `observeSession` without blocking: the TUI reads a long session's journal off its input loop. */
export async function observeSessionAsync(stateDir: string, sessionId: string): Promise<ReportObservation[]> {
	return observationsOf(await loadSessionTelemetrySourceAsync(stateDir, sessionId));
}

function observationsOf(source: ReturnType<typeof loadSessionTelemetrySource>): ReportObservation[] {
	if (source === null) return [];
	const observations: ReportObservation[] = [];
	const last = whyStopped(source).lastTurn;
	if (last !== null)
		observations.push({
			code: "turn-ended",
			values: {
				stopReason: word(last.stopReason),
				cause: last.cause === null ? null : word(last.cause),
				stage: last.stage === null ? null : word(last.stage),
				retries: count(last.retries),
			},
		});
	let aborted: string | null = null;
	let continued: { cause: string; attempt: number; cap: number } | null = null;
	let compaction: string | null = null;
	for (const record of source.journal.records) {
		if (record.k === "turn.aborted") aborted = word(record.data.source);
		else if (record.k === "turn.continued")
			continued = { cause: word(record.data.cause), attempt: count(record.data.attempt), cap: count(record.data.cap) };
		else if (record.k === "compaction.settled") compaction = word(record.data.outcome);
	}
	if (aborted !== null && last?.stopReason === "aborted")
		observations.push({ code: "turn-aborted", values: { source: aborted } });
	if (continued !== null) observations.push({ code: "turn-continued", values: continued });
	if (compaction !== null) observations.push({ code: "compaction", values: { outcome: compaction } });
	return observations;
}
