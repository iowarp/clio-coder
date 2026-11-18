/**
 * Stage S0 selection (SPEC §2.4): results a later identical read-class call
 * covered, read over the request as render builds it.
 *
 * "Later" means later in the request, so the walk runs newest first over the
 * rendered elements, not over the ledger: ledger order is completion order,
 * and render orders parallel results by call order and drops orphans and the
 * calls of a failed assistant. Every fact comes from the ledger row an
 * element's source id names (call identity, error flag, delivery in
 * `result.details.observation`), because the rendered copy has lost
 * `details`. A unit the view holds as evicted is neither a candidate nor a
 * cover, so a marker never stands in for a body.
 *
 * Pure: the loop guard's call identity and read test are injected, so the
 * domain does not import the engine.
 */

import type { SessionEntry } from "../../session/entries.js";
import type { EvictionCandidate, WorkingSetView } from "./contract.js";
import { isRecord, toolResultPayload, toolResultText } from "./payload.js";

/** Gross pending body bytes a batch needs before it commits; one break buys back at least this much. */
export const SUPERSEDED_FLOOR_BYTES = 32 * 1024;
/** The internal stage's policy id; not a `WorkingSetPolicyId`. */
export const SUPERSEDED_POLICY_ID = "superseded-v1";
/** The policy id of the one record that adopts a v6 session's aging stubs (§1.5). */
export const LEGACY_AGING_POLICY_ID = "superseded-legacy-v6";

/** What the loop guard says about one call: its repeat identity, and whether a repeat reads the same state. */
export interface CallFacts {
	identity: string;
	read: boolean;
}
export type ClassifyCall = (name: string, args: unknown) => CallFacts;

export interface SupersededInput {
	/** The ledger the render read; each source id names one of its rows. */
	entries: ReadonlyArray<SessionEntry>;
	/** The render's source row id per element, in request order. */
	sourceIds: ReadonlyArray<string | null>;
	view: WorkingSetView;
	classify: ClassifyCall;
}

export interface SupersededCandidate extends EvictionCandidate {
	reason: "superseded_call";
	/** The row id of the result that covers this one. */
	by: string;
	/** Gross body bytes, counted toward the floor. */
	bytes: number;
	toolCallId: string;
	/** The call as the assistant row recorded it. */
	call: { name: string; args: unknown };
}

/** What a result delivered, from the shared `details.observation` envelope; null when it carries none. */
interface Delivery {
	truncated: boolean;
	shownCount: number;
	shownBytes: number;
}

interface Occurrence {
	rowId: string;
	toolCallId: string;
	isError: boolean;
	delivery: Delivery | null;
	bytes: number;
}

interface CallSite {
	name: string;
	args: unknown;
}

function deliveryOf(result: unknown): Delivery | null {
	const observation = isRecord(result) && isRecord(result.details) ? result.details.observation : undefined;
	if (!isRecord(observation)) return null;
	const { truncated, shownCount, shownBytes } = observation;
	if (typeof truncated !== "boolean" || typeof shownCount !== "number" || typeof shownBytes !== "number") return null;
	return { truncated, shownCount, shownBytes };
}

function toolCallIdOf(obj: Record<string, unknown>): string | null {
	for (const key of ["toolCallId", "tool_call_id", "id"])
		if (typeof obj[key] === "string" && obj[key].length > 0) return obj[key];
	return null;
}

function occurrenceOf(entry: SessionEntry): Occurrence | null {
	if (entry.kind !== "message" || entry.role !== "tool_result") return null;
	const { obj, result } = toolResultPayload(entry.payload);
	const toolCallId = toolCallIdOf(obj);
	if (toolCallId === null) return null;
	return {
		rowId: entry.turnId,
		toolCallId,
		isError: obj.isError === true || obj.error === true,
		delivery: deliveryOf(result),
		bytes: Buffer.byteLength(toolResultText(result), "utf8"),
	};
}

/**
 * A later result replaces an earlier one only when it delivered at least as much. Complete is a result that was not
 * truncated, or one with no envelope (bash, extension tools), so any ok repeat of those is a fresh copy. A truncated
 * repeat must have shown something, and at least what the earlier one showed.
 */
function coversResult(cover: { delivery: Delivery | null }, earlier: Occurrence): boolean {
	const delivered = cover.delivery;
	if (delivered === null || !delivered.truncated) return true;
	if (delivered.shownCount <= 0 || delivered.shownBytes <= 0) return false;
	return delivered.shownBytes >= (earlier.delivery !== null ? earlier.delivery.shownBytes : earlier.bytes);
}

/**
 * Every superseded result in the rendered request, in request order. A cover is the newest later result of the same
 * identity that is visible, not an error, not itself selected, and delivered enough; its row id is the `by`.
 */
export function selectSuperseded(input: SupersededInput): SupersededCandidate[] {
	const byId = new Map<string, SessionEntry>();
	for (const entry of input.entries) byId.set(entry.turnId, entry);
	const calls = new Map<string, CallSite>();
	const occurrences: Occurrence[] = [];
	const seen = new Set<string>();
	for (const sourceId of input.sourceIds) {
		if (sourceId === null || seen.has(sourceId)) continue;
		seen.add(sourceId);
		const entry = byId.get(sourceId);
		if (entry?.kind !== "message") continue;
		if (entry.role === "assistant") {
			const content = isRecord(entry.payload) ? entry.payload.content : undefined;
			if (!Array.isArray(content)) continue;
			for (const block of content)
				if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string")
					calls.set(block.id, { name: block.name, args: block.arguments });
			continue;
		}
		const occurrence = occurrenceOf(entry);
		if (occurrence !== null) occurrences.push(occurrence);
	}
	const facts = new Map<string, CallFacts>();
	const factsOf = (toolCallId: string): CallFacts | null => {
		const known = facts.get(toolCallId);
		if (known !== undefined) return known;
		const call = calls.get(toolCallId);
		if (call === undefined || call.name.length === 0) return null;
		const classified = input.classify(call.name, call.args);
		facts.set(toolCallId, classified);
		return classified;
	};
	// Newer visible results per identity, newest first: the covers an older result may name.
	const covers = new Map<string, Occurrence[]>();
	const selected: SupersededCandidate[] = [];
	for (let index = occurrences.length - 1; index >= 0; index -= 1) {
		const occurrence = occurrences[index];
		if (occurrence === undefined || input.view.evicted.has(occurrence.rowId)) continue;
		const site = calls.get(occurrence.toolCallId);
		const call = factsOf(occurrence.toolCallId);
		if (site === undefined || call === null || !call.read) continue;
		const later = covers.get(call.identity) ?? [];
		const cover = later.find((candidate) => coversResult(candidate, occurrence));
		if (cover !== undefined) {
			selected.push({
				ref: { entry: occurrence.rowId },
				reason: "superseded_call",
				by: cover.rowId,
				bytes: occurrence.bytes,
				toolCallId: occurrence.toolCallId,
				call: site,
			});
			continue;
		}
		if (!occurrence.isError) covers.set(call.identity, [...later, occurrence]);
	}
	return selected.reverse();
}

/** Gross body bytes of a selection, the figure the floor reads. */
export function supersededBytes(candidates: ReadonlyArray<{ bytes: number }>): number {
	return candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
}
