// Every decision the conversation view makes, as plain functions. The app has no DOM test
// environment, so `ChatTurn.tsx` and `ActivityGroup.tsx` stay declarative and everything that can be
// wrong lives here where node:test can call it.
//
// Two rules carry this file. The first is that a time is never invented: a replayed turn has no
// `startedAt` and the view says so rather than stamping the current wall clock on history. The
// second is that a missing prompt is reported as missing: a replayed turn whose user item was never
// written still gets a request card, truthfully empty, because a headless response reads as though
// the model spoke first.

import type { Turn } from "../../contracts/sessions.js";
import { workerLabel } from "./activity.js";
import type { HealthRow } from "./health.js";
import type { ChatTurn } from "./turns.js";

export const PRODUCT_NAME = "Clio Coder";
export const REASONING_PREVIEW_MAX = 140;
export const REASONING_LABEL = "Reasoning";
export const REASONING_SOURCE = "reported by Clio Coder";
export const REPLAY_CHIP = "earlier record";
export const REPLAY_PROMPT_MISSING = "(earlier prompt not replayed)";
export const EMPTY_PROMPT = "(empty prompt)";

/** Verbatim. The wording the page carried before read like data loss, which it is not. */
export const TRUNCATION_NOTE = "Earlier turns are not shown; Clio Coder still has the full context.";

export const EMPTY_GLYPH = "◎";
export const EMPTY_EYEBROW = "NEW RESEARCH THREAD";
export const EMPTY_HEADING = "What would you like to understand or change?";
export const STARTER_PROMPTS = [
	"Map this project and explain how its parts fit together.",
	"Run the existing checks and summarize what the evidence shows.",
	"Help me plan a careful change without editing anything yet.",
] as const;

/**
 * The whole reasoning affordance is its first line. Thinking is provenance, not prose, and inlining
 * it puts the model's private deliberation at the same weight as its answer.
 */
export function reasoningPreview(text: string, latest = false): string {
	const lines = text.trim().split("\n");
	// While the thought is still streaming, its newest line is what shows the work moving.
	const line = (latest ? lines.filter((entry) => entry.trim() !== "").at(-1) : lines[0]) ?? "";
	return line.length > REASONING_PREVIEW_MAX ? `${line.slice(0, REASONING_PREVIEW_MAX)}…` : line;
}

export interface RequestView {
	readonly heading: string;
	readonly text: string;
	/** True when the text is a stated absence rather than something the operator typed. */
	readonly missing: boolean;
	readonly replay: boolean;
}

/**
 * The request card. A replayed turn keeps a card even with no user item, because the alternative is
 * a response with no question above it, which reads as the model having spoken unprompted.
 */
export function requestView(turn: ChatTurn): RequestView {
	const replay = turn.origin === "replay";
	const heading = replay ? "Earlier request" : "You";
	if (turn.request === null) {
		// A live turn always writes its user item first, so an absent request here is history.
		return { heading, text: REPLAY_PROMPT_MISSING, missing: true, replay };
	}
	const text = turn.request.text;
	if (text.trim().length === 0) return { heading, text: EMPTY_PROMPT, missing: true, replay };
	return { heading, text, missing: false, replay };
}

/** The accessible name of the whole turn, so a screen reader can skip between exchanges. */
export function turnAriaLabel(turn: ChatTurn): string {
	const request = requestView(turn);
	if (request.missing) return turn.origin === "replay" ? "Earlier turn" : "Turn";
	return `Request: ${request.text.slice(0, 80)}`;
}

/**
 * The streaming-tail rule. Only the last segment of a live turn can still grow, so every earlier
 * segment is lexed once, canonically, even while the turn runs.
 */
export function segmentSettled(live: boolean, index: number, total: number): boolean {
	return !live || index < total - 1;
}

export interface ResponseAuthor {
	readonly name: string;
	/** True when Clio Coder named a delegated worker, which outranks the orchestrator. */
	readonly delegated: boolean;
}

/**
 * Whose name goes on the response. The last provenance entry wins and only a `worker` role is
 * printed, so an unattributed narrative stays attributed to the product rather than being guessed at.
 * The last narrative segment decides, because that is the text the name sits above.
 */
export function responseAuthor(turn: ChatTurn): ResponseAuthor {
	for (let index = turn.segments.length - 1; index >= 0; index -= 1) {
		const segment = turn.segments[index];
		if (segment === undefined || segment.kind === "activity") continue;
		const label = workerLabel(segment.item.provenance);
		if (label !== null) return { name: label, delegated: true };
		break;
	}
	return { name: PRODUCT_NAME, delegated: false };
}

/** Tool calls in this turn, which is the number the outcome footer reports. */
export function toolCount(turn: ChatTurn): number {
	let total = 0;
	for (const item of turn.items) if (item.kind === "tool") total += 1;
	return total;
}

/** Every response text in the turn, joined, which is what Copy response hands to the clipboard. */
export function responseText(turn: ChatTurn): string {
	const parts: string[] = [];
	for (const segment of turn.segments) if (segment.kind === "response") parts.push(segment.item.text);
	return parts.join("\n\n");
}

/**
 * The turn's own start. A replayed item carries no timestamp because the host refuses to stamp
 * history with the current wall clock, and `null` here means exactly that: unavailable, not now.
 */
export function turnStartedAt(row: Turn | undefined): string | null {
	return row?.startedAt ?? null;
}

export interface TimelineNotices {
	/** Rows that happened before the first turn this view holds. */
	readonly leading: readonly HealthRow[];
	/** Rows rendered immediately after the turn whose id keys them. */
	readonly after: ReadonlyMap<string, readonly HealthRow[]>;
}

const EMPTY_NOTICES: TimelineNotices = { leading: [], after: new Map() };

function instant(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Places compaction and tool-budget rows at the point in the conversation they happened, using each
 * turn's own `startedAt`. A row whose stamp does not parse, or that predates every turn, goes above
 * the transcript rather than being dropped: the operator needs to know the context was compacted
 * even when nothing on the wire says exactly when.
 */
export function placeHealthRows(rows: readonly HealthRow[], turns: readonly Turn[]): TimelineNotices {
	if (rows.length === 0) return EMPTY_NOTICES;
	const starts: { id: string; at: number }[] = [];
	for (const turn of turns) {
		const at = instant(turn.startedAt);
		if (at !== null) starts.push({ id: turn.id, at });
	}
	const leading: HealthRow[] = [];
	const after = new Map<string, HealthRow[]>();
	for (const row of rows) {
		const at = instant(row.at);
		let owner: string | null = null;
		if (at !== null) for (const start of starts) if (start.at <= at) owner = start.id;
		if (owner === null) leading.push(row);
		else {
			const bucket = after.get(owner);
			if (bucket === undefined) after.set(owner, [row]);
			else bucket.push(row);
		}
	}
	return { leading, after };
}

/**
 * Nothing on the wire stamps a timeline item, so "running for 40s" can only ever be a fact this
 * browser measured. The first sighting of an item id is recorded and reused, which is what keeps the
 * figure stable across re-renders instead of restarting on every frame. The label below says whose
 * measurement it is, because a number with no warranty behind it is worse than no number.
 */
export const ELAPSED_TITLE = "Measured by this browser since the call first appeared here";

const MAX_OBSERVED_STARTS = 2048;
const observedStarts = new Map<string, number>();

/** The first moment this browser saw `id`. Later calls return the original sighting. */
export function observeStart(id: string, nowMs: number): number {
	const seen = observedStarts.get(id);
	if (seen !== undefined) return seen;
	if (observedStarts.size >= MAX_OBSERVED_STARTS) {
		const oldest = observedStarts.keys().next();
		if (!oldest.done) observedStarts.delete(oldest.value);
	}
	observedStarts.set(id, nowMs);
	return nowMs;
}

export function resetObservedStarts(): void {
	observedStarts.clear();
}

/** The context warning is standing session chrome, not a point in the transcript. */
export const CONTEXT_WARNING_LABEL = "Context is filling up";
