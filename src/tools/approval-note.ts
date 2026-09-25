/**
 * The sentence a granted call carries back to the model.
 *
 * A one-shot grant was invisible in the tool result: a damage-control
 * confirmation the operator approved produced the same result text as a call
 * that never asked, so the model reported "no prompt, no block" for a run the
 * audit recorded as `permission_requested` then `allowed` (BT-003). The
 * transcript marker is the operator's record; this is the model's.
 *
 * Four sources release a parked call and they are not the same fact. The main
 * TUI card (`tool:one_shot`) and a forwarded worker escalation
 * (`escalation:operator`) are a person answering. An ACP client answering
 * `allow-once` is that client, not this session's operator. A remembered
 * escalation replays an earlier answer, so the note must not claim anyone was
 * asked for this call. An escalation timeout always denies and never releases
 * a call; any source not named here gets the neutral wording.
 *
 * Every wording states the scope the registry already enforces: the grant
 * covers this call and nothing else, so the model cannot read it as standing
 * permission for a later one.
 */

/** Prefix for a grant a person gave. */
export const OPERATOR_APPROVAL_NOTE_PREFIX = "[operator approval]";
/** Prefix for a grant no operator of this session gave. */
export const APPROVAL_NOTE_PREFIX = "[approval]";

export interface ApprovalNoteInput {
	actionClass: string;
	/** `OneShotGrant.requestedBy`: which surface released the parked call. */
	requestedBy: string;
	/** Damage-control rule or policy rail that parked the call, when one named it. */
	ruleId?: string | undefined;
}

const SCOPE = "The grant covers this call only; another call still needs its own approval.";

export function approvalNote(input: ApprovalNoteInput): string {
	const rail = input.ruleId !== undefined && input.ruleId.trim() !== "" ? ` (rail: ${input.ruleId.trim()})` : "";
	const call = `this ${input.actionClass} call`;
	switch (input.requestedBy) {
		case "tool:one_shot":
			return `${OPERATOR_APPROVAL_NOTE_PREFIX} The operator approved ${call} once${rail}. ${SCOPE} Say that the operator was asked and approved, not that the call ran without a prompt.`;
		case "escalation:operator":
			return `${OPERATOR_APPROVAL_NOTE_PREFIX} The operator approved ${call} once${rail}, through a forwarded worker escalation. ${SCOPE} Say that the operator was asked and approved, not that the call ran without a prompt.`;
		case "acp-client":
			return `${APPROVAL_NOTE_PREFIX} The connected ACP client approved ${call} once${rail}. ${SCOPE} Say the client was asked and granted it, and do not claim this session's operator approved it.`;
		case "escalation:remembered":
			return `${APPROVAL_NOTE_PREFIX} ${capitalize(call)} ran under a remembered escalation decision${rail}, not a new ask. ${SCOPE} Do not say anyone was asked for this call.`;
		default:
			return `${APPROVAL_NOTE_PREFIX} ${capitalize(call)} was released by '${input.requestedBy}'${rail}. ${SCOPE} Name that source rather than claiming an operator was asked.`;
	}
}

function capitalize(text: string): string {
	return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

type NotedResult = ({ kind: "ok"; output: string } | { kind: "error"; message: string }) & {
	modelContext?: string;
	details?: Record<string, unknown>;
};

/**
 * Prepend the note to every text the result can show the model. A tool that
 * declares a result disposition, bash among them, is read through its
 * `modelContext` projection rather than `output`, and the live retest of
 * BT-003 lost the note there. The note lands after the projection's byte cap,
 * so it displaces none of the result, and `contextBytes` counts it so the
 * recorded size stays the size the model received.
 */
export function withApprovalNote<T extends NotedResult>(result: T, input: ApprovalNoteInput): T {
	const note = `${approvalNote(input)}\n`;
	const text = result.kind === "ok" ? { output: `${note}${result.output}` } : { message: `${note}${result.message}` };
	if (result.modelContext === undefined) return { ...result, ...text };
	const disposition = result.details?.resultDisposition;
	const details =
		isRecord(disposition) && typeof disposition.contextBytes === "number"
			? {
					...result.details,
					resultDisposition: { ...disposition, contextBytes: disposition.contextBytes + Buffer.byteLength(note) },
				}
			: result.details;
	return {
		...result,
		...text,
		modelContext: `${note}${result.modelContext}`,
		...(details === undefined ? {} : { details }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
