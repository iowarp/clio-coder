/**
 * What is left of observation aging (v6): the ledger records it wrote and the
 * stub it sent, read once per session so the superseded stage can adopt them.
 *
 * Format v6 stubbed superseded results in the outgoing request only and
 * recorded each batch's tool call ids as a custom row. Stage S0 replaced it
 * (ContextFold CF-5): a superseded result now leaves through an ordinary
 * `contextEviction` record, so render alone decides the request. A v6 session
 * still opens. At its first fold checkpoint, an uncached route writes one
 * record (`superseded-legacy-v6`) holding each result a v6 record named that
 * a visible later copy still covers, with the stub that request carried as
 * its marker, so the request keeps the shape it had reached. A cached route
 * writes nothing: those results were never stubbed there, and S0 does not run.
 */

import type { EvictionCandidate } from "../domains/context/working-set/contract.js";
import type { SupersededCandidate } from "../domains/context/working-set/superseded.js";
import { LEGACY_AGING_POLICY_ID } from "../domains/context/working-set/superseded.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { effectiveToolCall } from "../tools/surface.js";

/** The custom row a v6 batch wrote: the tool call ids it stubbed. Replay renders none of it. */
export const OBSERVATION_AGING_CUSTOM_TYPE = "clio-coder.observation-aging";

interface ObservationAgingRecord {
	version: 1;
	toolCallIds: string[];
}

/** Every tool call id an aging record in `entries` names. */
export function agedToolCallIdsFromEntries(entries: ReadonlyArray<SessionEntry>): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		if (entry.kind !== "custom" || entry.customType !== OBSERVATION_AGING_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<ObservationAgingRecord> | undefined;
		if (data?.version !== 1 || !Array.isArray(data.toolCallIds)) continue;
		for (const id of data.toolCallIds) if (typeof id === "string") ids.push(id);
	}
	return ids;
}

/** The record data for one v6 batch, as a v6 ledger holds it. */
export function observationAgingRecord(toolCallIds: ReadonlyArray<string>): ObservationAgingRecord {
	return { version: 1, toolCallIds: [...toolCallIds] };
}

/** Longest rendering of a call's arguments a stub carries. */
const STUB_ARGS_CHARS = 160;

function renderArgs(args: Record<string, unknown> | undefined): string {
	let text: string;
	try {
		text = JSON.stringify(args ?? {}) ?? "{}";
	} catch {
		text = "{}";
	}
	return text.length <= STUB_ARGS_CHARS ? text : `${text.slice(0, STUB_ARGS_CHARS - 3)}...`;
}

/** The stub a v6 request carried for a superseded result, byte for byte. */
export function observationAgingStub(name: string, args: unknown, bytes: number): string {
	const call = effectiveToolCall(name, args);
	const shown = renderArgs(call.args);
	return (
		`[observation aged] ${call.toolName} ${shown} returned ${bytes} bytes here. A later call with the same ` +
		`arguments succeeded and its result is already in context below; call ${call.toolName} again with these ` +
		"arguments if you need a fresh copy."
	);
}

/** What the first checkpoint of a session found of v6 aging on its active path. */
export type LegacyAging =
	| { kind: "none" }
	/** v6 records name `results` ids; `adopt` holds the ones still superseded, each with its v6 stub as the marker. */
	| { kind: "found"; results: number; adopt: EvictionCandidate[] };

/**
 * The v6 records on `path` and the superseded results they cover. A path that already holds the adoption record
 * found nothing: adoption runs once per session, a fork inheriting the parent's record included.
 */
export function legacyAgingOnPath(
	path: ReadonlyArray<SessionEntry>,
	superseded: ReadonlyArray<SupersededCandidate>,
): LegacyAging {
	const named = new Set(agedToolCallIdsFromEntries(path));
	if (named.size === 0) return { kind: "none" };
	if (path.some((entry) => entry.kind === "contextEviction" && entry.policyId === LEGACY_AGING_POLICY_ID))
		return { kind: "none" };
	const adopt = superseded
		.filter((candidate) => named.has(candidate.toolCallId))
		.map(
			(candidate): EvictionCandidate => ({
				ref: candidate.ref,
				reason: candidate.reason,
				by: candidate.by,
				marker: observationAgingStub(candidate.call.name, candidate.call.args, candidate.bytes),
			}),
		);
	return { kind: "found", results: named.size, adopt };
}
