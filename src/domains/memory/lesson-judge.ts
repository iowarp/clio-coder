import type { Question, SystemOne } from "../system-one/index.js";
import { yesNo } from "../system-one/index.js";
import { consultSite } from "../system-one/sites/consult.js";
import type { CompletedLessonSource } from "./history-review.js";
import { observationTracing, traceObservation } from "./observation-events.js";
import type { TaskMemoryEntry } from "./task-bank.js";

export type MemoryLessonJudge = (
	entries: readonly TaskMemoryEntry[],
	source: CompletedLessonSource,
	signal: AbortSignal,
) => Promise<ReadonlySet<string> | null>;

/** Existing consult engines can vote on usefulness; concrete source evidence remains a host requirement. */
export function createMemoryLessonJudge(systemOne: Pick<SystemOne, "run">): MemoryLessonJudge {
	return async (entries, source, signal) => {
		const selected = entries.slice(0, 2);
		const questions: Record<string, Question> = {};
		const candidates: Record<string, string> = {};
		for (const entry of selected) {
			candidates[entry.id] = entry.content;
			questions[entry.id] = yesNo(
				`Should a future session keep this repository fact: ${JSON.stringify(entry.content)}? Judge only this fact using the supplied evidence. A working verification recipe or required environment setting is useful even when it worked on the first attempt.`,
				"Keep: a reusable repository command, required setup, source convention or repeatable trap supported by the evidence",
				"Do not keep: temporary progress, a task label, the bug being fixed, generic advice, or an unsupported claim",
			);
		}
		const verdict = await systemOne.run(
			consultSite(questions),
			{
				state: { candidates, evidence: source.text },
				files: {},
			},
			{ signal, ref: source.revision },
		);
		if (observationTracing()) traceObservation("lesson-judge-output", { verdict });
		if (!verdict) return null;
		const accepted = new Set<string>();
		for (const entry of selected) {
			const answer = verdict.value.answers[entry.id];
			// A partial consult answer is unavailable work, not a negative judgment of its unanswered sibling.
			if (answer?.kind !== "yesNo" || "abstained" in answer) return null;
			// Conservative policy votes do not establish that the serving model is calibrated.
			if (answer.pTrue >= 0.8 && answer.certainty >= 0.6) accepted.add(entry.id);
		}
		return accepted;
	};
}
