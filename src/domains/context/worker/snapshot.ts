import type { AgentMessage } from "../../../engine/types.js";
import { completeHistoryLength, contextHash, messageToolCalls } from "../../../worker/context-seed.js";
import type { WorkerContextSnapshot, WorkerContextSource } from "./contract.js";

export { completeHistoryLength, contextHash, messageToolCalls } from "../../../worker/context-seed.js";

/** The deep copy is essential: Pi copies message arrays but retains nested objects. */
export function captureWorkerContext(
	source: WorkerContextSource,
	messages: ReadonlyArray<AgentMessage>,
): WorkerContextSnapshot {
	// Pi's provider transform omits interrupted assistant responses. Match that
	// rule before validating pairs, so a canceled earlier turn cannot poison all
	// later dispatches. Their partial tool declarations/results never seed a child.
	const interrupted = (message: AgentMessage) =>
		message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
	const interruptedIds = new Set(
		messages
			.filter(interrupted)
			.flatMap(messageToolCalls)
			.map((call) => call.id),
	);
	const visible = messages.filter(
		(message) => !interrupted(message) && !(message.role === "toolResult" && interruptedIds.has(message.toolCallId)),
	);
	const end = completeHistoryLength(visible, true);
	const snapshot = {
		version: 1 as const,
		source: structuredClone(source),
		messages: structuredClone(visible.slice(0, end)),
		excludedTailMessages: visible.length - end,
		excludedInterruptedMessages: messages.length - visible.length,
	};
	return { ...snapshot, contentHash: contextHash(snapshot) };
}
