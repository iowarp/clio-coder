/**
 * What became of each operator message, folded from the session timeline's `message` rows for `/view`. The journal
 * holds lengths and points, never text, so a path is identified by when it was sent and how long it was.
 */

import type { CallRowV1, TimelineV1 } from "../../core/telemetry/dto.js";

type MessageRow = Extract<TimelineV1["entries"][number], { kind: "message" }>;
type Failure = NonNullable<MessageRow["callFailure"]>;
type Wait = NonNullable<MessageRow["why"]>;
type Slot = NonNullable<MessageRow["slot"]>;
type Removal = NonNullable<MessageRow["reason"]>;

export type MessagePathState =
	| "delivered"
	| "failed"
	| "stopped"
	| "sending"
	| "with-run"
	| "preparing"
	| "queued"
	| "held"
	| "removed"
	| "lost";

export type MessagePathTone = "ok" | "error" | "warning" | "muted" | "active";

export interface CarrierFacts {
	/** This session's calls in the order they left, counted from one. */
	ordinal: number;
	model: string | null;
}

export interface MessagePathView {
	id: string;
	state: MessagePathState;
	tone: MessagePathTone;
	submittedAt: number;
	/** State, then lane, then length: the list row. */
	title: string;
	/** What happened and what the operator can do next. */
	summary: string;
	/** One line per step, oldest first, with no raw identifiers. */
	steps: string[];
	/** The same steps with their raw ids, for the detail view. */
	record: string[];
	searchText: string[];
}

const FAILURE_WORDS: Record<Failure, string> = {
	budget_wait_aborted: "stopped waiting for budget",
	admission_refused: "refused before it left",
	auth_rejected: "the provider rejected the credential",
	auth_refresh_failed: "the credential could not be refreshed",
	transport_connect: "could not connect",
	transport_dropped: "the connection dropped",
	provider_4xx: "the provider refused the request",
	provider_5xx: "the provider failed",
	rate_limited: "rate limited",
	usage_limit_reached: "usage limit reached",
	tool_choice_rejected: "the provider rejected the tool choice",
	context_overflow: "too long for the model's context",
	stall_pre_invocation: "stalled before it was sent",
	stall_first_token: "no reply arrived in time",
	stall_mid_stream: "the reply stalled",
	route_moved: "you moved it to another route",
	operator_cancel: "you stopped it",
	parent_cancel: "its parent run stopped it",
	internal: "Clio failed internally",
};

const WAIT_WORDS: Record<Wait, string> = {
	"operator-stop": "you stopped the run",
	interrupt: "an interrupt took the run",
	"prompt-not-started": "a prompt never started",
	"session-move": "the session moved",
	"run-cancelled": "the run was cancelled",
};

const SLOT_WORDS: Record<Slot, string> = {
	"finish-turn": "as a turn finished",
	"prepare-next-turn": "before the next turn",
	prompt: "with a new prompt",
};

const REMOVAL_STEP_WORDS: Record<Removal, string> = {
	removed: "Removed by you",
	"sent-now": "Taken off the queue to send now",
	"to-editor": "Moved back to the composer",
	restored: "Restored to the composer",
	cancelled: "Dropped unsent",
	resubmitted: "Taken off the queue to resend",
	"not-started": "Dropped: its prompt never started",
};

const REMOVAL_TITLE: Record<Removal, string> = {
	removed: "Removed",
	"sent-now": "Preparing",
	"to-editor": "In composer",
	restored: "In composer",
	cancelled: "Dropped unsent",
	resubmitted: "Preparing",
	"not-started": "Never started",
};

const REMOVAL_SUMMARY: Record<Removal, string> = {
	removed: "You removed it from the queue. It was never sent.",
	"sent-now": "It left the queue to send now and no request has carried it yet.",
	"to-editor": "You moved it back to the composer. It was not sent from the queue.",
	restored: "It went back to the composer. It was not sent from the queue.",
	cancelled: "It was dropped unsent when the queue was cleared or the session ended.",
	resubmitted: "It left the queue to go as a fresh prompt and no request has carried it yet.",
	"not-started": "Its prompt never started, so nothing was sent. Type it again to send it.",
};

const laneWord = (lane: MessageRow["lane"]): string =>
	lane === "follow-up" ? "later" : lane === "steer" ? "steer" : "prompt";

const laneArticle = (lane: MessageRow["lane"]): string =>
	lane === "follow-up" ? "for the end of the turn" : lane === "steer" ? "as a steer" : "as a prompt";

function isCarrierFailed(row: MessageRow): boolean {
	return row.callFailure !== null || row.callDisposition === "sent_unsettled" || row.callDisposition === "never_sent";
}

function isCarrierAnswered(row: MessageRow): boolean {
	return !isCarrierFailed(row) && row.callDisposition !== "incomplete" && row.callDisposition !== null;
}

function isCancel(failure: MessageRow["callFailure"]): boolean {
	return failure === "operator_cancel" || failure === "parent_cancel";
}

function callName(row: MessageRow, carriers: ReadonlyMap<string, CarrierFacts>): string {
	const ordinal = row.attemptId === null ? undefined : carriers.get(row.attemptId)?.ordinal;
	const retry = row.attempt !== null && row.attempt > 0 ? `, retry ${row.attempt}` : "";
	return ordinal === undefined ? `a call${retry}` : `call ${ordinal}${retry}`;
}

function carriedOutcome(row: MessageRow): string {
	if (row.callFailure !== null) return FAILURE_WORDS[row.callFailure];
	if (isCarrierAnswered(row)) return "answered";
	if (row.callDisposition === "incomplete") return "not settled";
	return "ended without a full reply";
}

function stepWords(row: MessageRow, carriers: ReadonlyMap<string, CarrierFacts>): string {
	switch (row.step) {
		case "submitted":
			return `Sent ${laneArticle("prompt")}`;
		case "queued":
			return `Queued ${laneArticle(row.lane)}`;
		case "lane-changed":
			return `Moved to ${laneWord(row.lane)} by ${row.changedBy === "operator" ? "you" : "triage"}`;
		case "held":
			return `Held: ${row.why ? WAIT_WORDS[row.why] : "no slot is coming"}`;
		case "released":
			return "Released by your next prompt";
		case "handed-over":
			return row.lane === "prompt"
				? "Handed to the run"
				: `Handed to the run ${row.slot ? SLOT_WORDS[row.slot] : "at a slot"}`;
		case "returned":
			return `Back in the queue: ${row.why ? WAIT_WORDS[row.why] : "the run took it back"}`;
		case "carried":
			return `Carried by ${callName(row, carriers)}: ${carriedOutcome(row)}`;
		case "removed":
			return row.reason ? REMOVAL_STEP_WORDS[row.reason] : "Removed";
		default:
			return row.step;
	}
}

function recordLine(row: MessageRow): string {
	const facts = [
		`step=${row.step}`,
		row.lane === null ? null : `lane=${row.lane}`,
		row.slot === null ? null : `slot=${row.slot}`,
		row.why === null ? null : `why=${row.why}`,
		row.reason === null ? null : `reason=${row.reason}`,
		row.changedBy === null ? null : `changedBy=${row.changedBy}`,
		row.callId === null ? null : `call=${row.callId}`,
		row.attemptId === null ? null : `attempt=${row.attemptId}`,
		row.callDisposition === null ? null : `disposition=${row.callDisposition}`,
		row.callFailure === null ? null : `failure=${row.callFailure}`,
		row.turnId === null ? null : `turn=${row.turnId}`,
	].filter((fact): fact is string => fact !== null);
	return `${row.at} ${facts.join(" ")}`;
}

function carrierSentence(row: MessageRow, carriers: ReadonlyMap<string, CarrierFacts>): string {
	const model = row.attemptId === null ? null : (carriers.get(row.attemptId)?.model ?? null);
	return `${callName(row, carriers)}${model === null ? "" : ` to ${model}`}`;
}

function foldOne(
	id: string,
	rows: readonly MessageRow[],
	carriers: ReadonlyMap<string, CarrierFacts>,
	queued: ReadonlySet<string> | undefined,
	clock: (at: string) => string,
): MessagePathView {
	const first = rows[0] as MessageRow;
	const submittedAt = Date.parse(first.at) - sinceMs(first);
	// A lane change says nothing about how far the message got.
	const last = [...rows].reverse().find((row) => row.step !== "lane-changed") ?? first;
	const lane = [...rows].reverse().find((row) => row.lane !== null)?.lane ?? "prompt";
	const chars = rows.find((row) => row.chars !== null)?.chars?.display ?? null;
	const byPeer = rows.some((row) => row.by === "machine");
	const carried = rows.filter((row) => row.step === "carried");
	const failedBefore = carried.filter(isCarrierFailed).length;

	let state: MessagePathState;
	let label: string;
	let summary: string;
	switch (last.step) {
		case "carried": {
			const call = carrierSentence(last, carriers);
			if (isCarrierAnswered(last)) {
				state = "delivered";
				label = `Delivered ${last.sinceSubmit.display}`;
				summary = `Delivered by ${call}, ${last.sinceSubmit.display} after you sent it.${
					failedBefore > 0 ? ` ${failedBefore} earlier call${failedBefore === 1 ? "" : "s"} carrying it did not finish.` : ""
				}`;
			} else if (last.callDisposition === "incomplete") {
				state = "sending";
				label = "Sending";
				summary = `It left on ${call}, which has not settled.`;
			} else if (isCancel(last.callFailure)) {
				state = "stopped";
				label = "Stopped";
				summary = `It left on ${call}, and ${carriedOutcome(last)} before a reply. It stays in the conversation, so the next request Clio sends carries it.`;
			} else {
				state = "failed";
				label = "Failed";
				summary = `Not answered. It left on ${call}: ${carriedOutcome(last)}. It stays in the conversation, so the next request Clio sends carries it.`;
			}
			break;
		}
		case "held":
		case "returned":
			state = queued !== undefined && !queued.has(id) ? "lost" : "held";
			label = state === "lost" ? "Not sent" : "Held";
			summary =
				state === "lost"
					? "It was held and is no longer in the queue. Clio has no record that it was sent."
					: `Held and not sent, because ${last.why ? WAIT_WORDS[last.why] : "no slot is coming"}. It goes with your next prompt, or send it from the queue navigator.`;
			break;
		case "queued":
		case "released":
			state = queued !== undefined && !queued.has(id) ? "lost" : "queued";
			label = state === "lost" ? "Not sent" : "Queued";
			summary =
				state === "lost"
					? "It was queued and is no longer in the queue. Clio has no record that it was sent."
					: `Waiting in the queue ${lane === "follow-up" ? "for the end of the turn" : "for the next slot"}. No request has carried it yet.`;
			break;
		case "handed-over":
			state = "with-run";
			label = "With the run";
			summary = "The run took it and no request has carried it yet.";
			break;
		case "submitted":
			state = "preparing";
			label = "Preparing";
			summary = "It was sent and has not reached the run yet.";
			break;
		default: {
			const reason: Removal = last.reason ?? "removed";
			state = reason === "sent-now" || reason === "resubmitted" ? "preparing" : "removed";
			label = REMOVAL_TITLE[reason];
			summary = REMOVAL_SUMMARY[reason];
		}
	}
	const tone: MessagePathTone =
		state === "delivered"
			? "ok"
			: state === "failed"
				? "error"
				: state === "held" || state === "stopped" || state === "lost"
					? "warning"
					: state === "removed"
						? "muted"
						: "active";
	const title = [label, laneWord(lane), byPeer ? "from a peer" : chars === null ? null : `${chars} chars`]
		.filter((part): part is string => part !== null)
		.join(" · ");
	return {
		id,
		state,
		tone,
		submittedAt,
		title,
		summary,
		steps: rows.map((row) => `${clock(row.at)} ${stepWords(row, carriers)}`),
		record: [`message=${id}`, ...rows.map(recordLine)],
		searchText: [
			id,
			state,
			label,
			laneWord(lane),
			...rows.flatMap((row) => (row.callId === null ? [] : [row.callId])),
			...rows.flatMap((row) => (row.turnId === null ? [] : [row.turnId])),
		],
	};
}

function sinceMs(row: MessageRow): number {
	const { fact } = row.sinceSubmit;
	return "kind" in fact && (fact.kind === "measured" || fact.kind === "estimated") ? fact.value : 0;
}

/**
 * Every message of the timeline, newest submitted first. `queued` names the messages in the live queue, so one whose
 * process ended reads as not sent instead of waiting; a host with no queue to read leaves it undefined.
 */
export function foldMessagePaths(
	dto: TimelineV1,
	calls: ReadonlyArray<Pick<CallRowV1, "attemptId" | "callId" | "startedAt" | "target">>,
	queued: ReadonlySet<string> | undefined,
	clock: (at: string) => string,
): MessagePathView[] {
	const carriers = new Map<string, CarrierFacts>();
	const ordinals = new Map<string, number>();
	const started = [...calls].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	for (const call of started) {
		const ordinal = ordinals.get(call.callId) ?? ordinals.size + 1;
		ordinals.set(call.callId, ordinal);
		carriers.set(call.attemptId, { ordinal, model: call.target.requestedModel });
	}
	const groups = new Map<string, MessageRow[]>();
	for (const entry of dto.entries) {
		if (entry.kind !== "message") continue;
		const rows = groups.get(entry.messageId);
		if (rows) rows.push(entry);
		else groups.set(entry.messageId, [entry]);
	}
	return [...groups]
		.map(([id, rows]) => foldOne(id, rows, carriers, queued, clock))
		.sort((a, b) => b.submittedAt - a.submittedAt);
}
