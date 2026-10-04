/**
 * Triage: one side-model round over the queued steering messages.
 *
 * The queue delivers every pending message at the next slot in the order the
 * operator typed them. Triage reads the whole queue once it has settled and
 * says, per entry, how it relates to the work in progress and how soon it
 * should land. A `newTask` moves to the end of the turn unless the operator
 * pinned the entry; a confident `stop` may interrupt the run when the operator
 * allowed that; everything else keeps its slot and gains advisory marks the
 * panel shows. Nothing here runs on the critical path: the round is detached,
 * a verdict that lands after the queue changed is dropped, and a failed round
 * leaves the queue exactly as the operator left it.
 *
 * The relation and urgency vocabularies are the steer site's, so the dataset
 * rows this writes and the rows the site writes read the same labels.
 */

import type { SteerRelation, SteerUrgency } from "../domains/system-one/sites/steer.js";
import { STEER_RELATIONS, STEER_URGENCIES } from "../domains/system-one/sites/steer.js";
import type { QueuedChatMessage, QueuedMessageKind } from "./turn-queues.js";

export const TRIAGE_SCHEMA_NAME = "clio_coder_steering_triage";
export const TRIAGE_MAX_TOKENS = 600;
/** A `stop` below this confidence is marked, never acted on. */
export const TRIAGE_STOP_MIN_CONFIDENCE = 0.8;
/** A `stop` older than this when the verdict lands is stale: the operator has had time to press the key themselves. */
export const TRIAGE_STOP_MAX_AGE_MS = 30_000;

/** Code points of each queued message, the task and the latest reply sent to the triage model. */
const MAX_ENTRY_CHARS = 600;
const MAX_TASK_CHARS = 500;
const MAX_PREVIOUS_CHARS = 500;

export interface TriageEntry {
	readonly id: string;
	readonly text: string;
	readonly kind: QueuedMessageKind;
}

export interface TriageInput {
	/** The operator's request that started the run. */
	readonly task: string;
	/** The assistant's latest text, or empty. */
	readonly previous: string;
	readonly entries: ReadonlyArray<TriageEntry>;
}

export interface TriageVerdict {
	readonly id: string;
	readonly relation: SteerRelation;
	readonly urgency: SteerUrgency;
	/** 0 to 1, the model's own word; never a calibrated probability. */
	readonly confidence: number;
}

const RELATION_KEYS = Object.keys(STEER_RELATIONS) as ReadonlyArray<SteerRelation>;
const URGENCY_KEYS = Object.keys(STEER_URGENCIES) as ReadonlyArray<SteerUrgency>;

export const TRIAGE_RESPONSE_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					relation: { type: "string", enum: [...RELATION_KEYS] },
					urgency: { type: "string", enum: [...URGENCY_KEYS] },
					confidence: { type: "number", minimum: 0, maximum: 1 },
				},
				required: ["id", "relation", "urgency", "confidence"],
			},
		},
	},
	required: ["verdicts"],
};

export const TRIAGE_SYSTEM_PROMPT = [
	"You triage messages an operator typed while a coding assistant was working on a task.",
	"For each queued message decide how it relates to the task in progress and how soon it should reach the assistant.",
	"Relations: " + RELATION_KEYS.map((key) => `${key} = ${STEER_RELATIONS[key]}`).join("; ") + ".",
	"Urgencies: " + URGENCY_KEYS.map((key) => `${key} = ${STEER_URGENCIES[key]}`).join("; ") + ".",
	'Answer with JSON only, in the shape {"verdicts": [{"id", "relation", "urgency", "confidence"}]}, one verdict per message id, confidence between 0 and 1.',
	"Prefer nextSlot when unsure. Use stop only for an explicit instruction to stop, wait, hold or undo.",
].join("\n");

function head(text: string, max: number): string {
	const points = [...text];
	return points.length <= max ? text : `${points.slice(0, max).join("")}…`;
}

function tail(text: string, max: number): string {
	const points = [...text];
	return points.length <= max ? text : `…${points.slice(-max).join("")}`;
}

/** The user text of the triage round: the task, the latest reply, and the queued messages with their ids. */
export function triageUserText(input: TriageInput): string {
	const lines = [
		`Task in progress:\n${head(input.task, MAX_TASK_CHARS) || "(unknown)"}`,
		`Assistant's latest text:\n${tail(input.previous, MAX_PREVIOUS_CHARS) || "(none yet)"}`,
		"Queued messages, in the order the operator typed them:",
		...input.entries.map(
			(entry, index) =>
				`${index + 1}. id=${entry.id} (operator chose: ${entry.kind === "steer" ? "next slot" : "end of turn"})\n${head(entry.text, MAX_ENTRY_CHARS)}`,
		),
	];
	return lines.join("\n\n");
}

function isRelation(value: unknown): value is SteerRelation {
	return typeof value === "string" && (RELATION_KEYS as ReadonlyArray<string>).includes(value);
}

function isUrgency(value: unknown): value is SteerUrgency {
	return typeof value === "string" && (URGENCY_KEYS as ReadonlyArray<string>).includes(value);
}

/**
 * The verdicts in a model answer, one per known id at most. Tolerant of prose
 * around the JSON and of a bare array; anything unreadable yields no verdicts.
 */
export function parseTriageAnswer(text: string, ids: ReadonlyArray<string>): TriageVerdict[] {
	const start = text.indexOf("{");
	const arrayStart = text.indexOf("[");
	const from = start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart);
	if (from < 0) return [];
	const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
	if (end <= from) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(from, end + 1));
	} catch {
		return [];
	}
	const list = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { verdicts?: unknown }).verdicts)
			? ((parsed as { verdicts: unknown[] }).verdicts as unknown[])
			: [];
	const seen = new Set<string>();
	const verdicts: TriageVerdict[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const { id, relation, urgency, confidence } = item as Record<string, unknown>;
		if (typeof id !== "string" || !ids.includes(id) || seen.has(id)) continue;
		if (!isRelation(relation) || !isUrgency(urgency)) continue;
		const score =
			typeof confidence === "number" && Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
		seen.add(id);
		verdicts.push({ id, relation, urgency, confidence: score });
	}
	return verdicts;
}

/** The slot a verdict moves an entry to, or undefined to leave the operator's choice alone. */
export function triageKindFor(verdict: TriageVerdict): QueuedMessageKind | undefined {
	if (verdict.relation === "newTask" && verdict.urgency === "endOfTurn") return "follow-up";
	return undefined;
}

/** The advisory labels an entry carries after triage; the panel marks `urgency: "now"`. */
export function triageLabelsFor(verdict: TriageVerdict): Readonly<Record<string, string>> {
	return {
		producer: "triage",
		relation: verdict.relation,
		urgency: verdict.urgency === "now" ? "now" : verdict.urgency === "endOfTurn" ? "end-of-turn" : "next-slot",
		confidence: verdict.confidence.toFixed(2),
	};
}

/**
 * Whether a verdict may interrupt the run: a confident `stop` on an entry the
 * operator typed moments ago and did not pin. Everything else is a mark.
 */
export function triageMayInterrupt(
	verdict: TriageVerdict,
	entry: Pick<QueuedChatMessage, "enqueuedAt" | "pinned">,
	now: number,
): boolean {
	return (
		verdict.relation === "stop" &&
		verdict.confidence >= TRIAGE_STOP_MIN_CONFIDENCE &&
		entry.pinned !== true &&
		now - entry.enqueuedAt <= TRIAGE_STOP_MAX_AGE_MS
	);
}

/** True when the queue still holds exactly the entries the round was asked about, in the same order and text. */
export function triageSnapshotMatches(
	asked: ReadonlyArray<TriageEntry>,
	current: ReadonlyArray<Pick<QueuedChatMessage, "id" | "text">>,
): boolean {
	if (asked.length !== current.length) return false;
	return asked.every((entry, index) => current[index]?.id === entry.id && current[index]?.text === entry.text);
}
