import { recordResearchTrace, researchTraceAdmits } from "../../core/telemetry/research-trace.js";
import type { TaskMemoryEnvelope } from "./task-memory-policy.js";

export interface TaskMemoryTrace {
	active(): boolean;
	record(envelope: TaskMemoryEnvelope): void;
}

const TRACE_TEXT_MAX_CHARS = 8_000;

/** Raw memory envelopes belong only to consented research objects (#434). */
export function createTaskMemoryTrace(): TaskMemoryTrace {
	return {
		active: () => researchTraceAdmits("memory.traced"),
		record(envelope) {
			if (!researchTraceAdmits("memory.traced")) return;
			recordResearchTrace(
				"memory.traced",
				{
					decision: envelope.decision,
					reason: envelope.reason,
					bankOperations: envelope.bankOperations,
					droppedOperations: envelope.droppedOperations,
					responseChars: envelope.response.length,
					userPromptChars: envelope.userPrompt.length,
					systemPromptChars: envelope.systemPrompt.length,
				},
				{
					response: truncate(envelope.response),
					userPrompt: truncate(envelope.userPrompt),
					reminder: envelope.reminder,
					error: envelope.error,
				},
			);
		},
	};
}

function truncate(value: string): string {
	return value.length <= TRACE_TEXT_MAX_CHARS ? value : `${value.slice(0, TRACE_TEXT_MAX_CHARS)}…[truncated]`;
}
