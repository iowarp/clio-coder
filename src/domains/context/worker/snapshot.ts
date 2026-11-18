import type { AgentMessage } from "../../../engine/types.js";
import { carriedMarkers, completeHistoryLength, contextHash, messageToolCalls } from "../../../worker/context-seed.js";
import type { SessionEntry } from "../../session/entries.js";
import { foldWorkingSet } from "../working-set/fold.js";
import type { WorkerContextRecallMarks, WorkerContextSnapshot, WorkerContextSource } from "./contract.js";

export { completeHistoryLength, contextHash, messageToolCalls } from "../../../worker/context-seed.js";

/**
 * The parent's recall aliases from its view: the alias mark across every branch of the file, and the markers the
 * active path renders.
 */
function recallMarks(entries: ReadonlyArray<SessionEntry>, leafTurnId: string | null): WorkerContextRecallMarks {
	const view = foldWorkingSet(entries, leafTurnId ?? undefined);
	return {
		aliasFloor: view.recallAliasSequence ?? 0,
		markers: [...view.evicted].flatMap(([ref, state]) =>
			state.alias === undefined ? [] : [{ alias: state.alias, ref }],
		),
	};
}

/**
 * The deep copy is essential: Pi copies message arrays but retains nested objects. With the session's entries the
 * snapshot also carries the parent's recall aliases, so a worker allocates its own above them.
 */
export function captureWorkerContext(
	source: WorkerContextSource,
	messages: ReadonlyArray<AgentMessage>,
	entries?: ReadonlyArray<SessionEntry>,
): WorkerContextSnapshot {
	// Worker prompts and executable tools belong to the child. Pi 0.86 stores
	// the parent's declarations in its transcript; they are not inherited history.
	const conversation = messages.filter((message) => message.role !== "system");
	// Pi's provider transform omits interrupted assistant responses. Match that
	// rule before validating pairs, so a canceled earlier turn cannot poison all
	// later dispatches. Their partial tool declarations/results never seed a child.
	const interrupted = (message: AgentMessage) =>
		message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
	const interruptedIds = new Set(
		conversation
			.filter(interrupted)
			.flatMap(messageToolCalls)
			.map((call) => call.id),
	);
	const visible = conversation.filter(
		(message) => !interrupted(message) && !(message.role === "toolResult" && interruptedIds.has(message.toolCallId)),
	);
	const end = completeHistoryLength(visible, true);
	const captured = structuredClone(visible.slice(0, end));
	const marks = entries === undefined ? undefined : recallMarks(entries, source.leafTurnId);
	const snapshot = {
		version: 1 as const,
		source: structuredClone(source),
		messages: captured,
		excludedTailMessages: visible.length - end,
		excludedInterruptedMessages: conversation.length - visible.length,
		...(marks === undefined ? {} : { recall: { ...marks, markers: carriedMarkers(marks.markers, captured) } }),
	};
	return { ...snapshot, contentHash: contextHash(snapshot) };
}
