/**
 * The evidence gate that lets a repository lesson become durable without an
 * operator.
 *
 * Until this existed every proposal waited for `clio-coder memory approve`,
 * and on the maintainer's own machine the store never held one approved
 * record: the background tier wrote candidates nobody reviewed, so no session
 * ever read what an earlier one learned. The gate replaces that review for the
 * narrow case it can judge. A proposal already passed the delivery checks in
 * `runTaskMemoryPolicy` (cited, fresh paths, repeated-failure basis); what the
 * gate adds is what the session saw afterwards. `held` means the failure did
 * not recur or the guardian kept the fact on a later look. That is absence of
 * a contradiction, not proof, which is why an approval can be withdrawn.
 *
 * It only ever speaks for repository scope and for records the task bank
 * produced. Global, runtime and agent scope widen where a lesson applies, and
 * an operator rejection or approval is a decision the guardian never revisits.
 */

import { cloneMemoryRecord } from "./operations.js";
import type { MemoryMutationOptions } from "./store.js";
import { mutateMemoryRecords } from "./store.js";
import {
	MEMORY_OBSERVATIONS_MAX,
	type MemoryObservation,
	type MemoryObservationKind,
	type MemoryRecord,
} from "./types.js";

export type MemoryGateVerdict = "approve" | "demote" | "hold";

/**
 * A knowledge entry is a stable fact about the repository, so one session that
 * reported it held is enough. A procedural entry records one attempt and its
 * outcome. Its record id is derived from the session that wrote it
 * (`promotedMemoryId`), so a second session writes a second record and no
 * record can ever collect two sessions; rather than approve session history on
 * one session's word, a procedural proposal stays pending for the operator.
 */
export const MEMORY_GATE_HELD_SESSIONS = 1;

export interface MemoryObservationInput {
	memoryId: string;
	sessionId: string;
	kind: MemoryObservationKind;
}

export interface MemoryGateOutcome {
	approved: MemoryRecord[];
	demoted: MemoryRecord[];
	/** Ids named by an observation that the store no longer holds. */
	missing: string[];
}

/**
 * Pure verdict over one record's retained observations. `store` is the rest of
 * the store as read inside the same locked mutation, so a record approved a
 * moment earlier counts.
 */
export function evaluateMemoryGate(record: MemoryRecord, store: ReadonlyArray<MemoryRecord> = []): MemoryGateVerdict {
	if (record.scope !== "repo" || record.rejectedAt !== undefined) return "hold";
	if (record.provenance?.sourceKind !== "task-bank-entry") return "hold";
	if (record.approval?.by === "operator") return "hold";
	const observations = record.observations ?? [];
	if (record.approved) {
		// A record approved before the gate existed carries no approval stamp and
		// was reviewed by a person, so it is theirs.
		const approvedAt = record.approval?.at;
		if (approvedAt === undefined) return "hold";
		return observations.some((item) => item.kind === "contradicted" && item.at > approvedAt) ? "demote" : "hold";
	}
	if ((record.regressions?.length ?? 0) > 0) return "hold";
	const verdicts = sessionVerdicts(observations);
	const contradicted = [...verdicts.values()].filter((kind) => kind === "contradicted").length;
	const held = [...verdicts.values()].filter((kind) => kind === "held").length;
	if (contradicted > 0) return "hold";
	if (record.provenance.sourceEntryKind !== "knowledge") return "hold";
	if (held < MEMORY_GATE_HELD_SESSIONS) return "hold";
	return commandAlreadyClaimed(record, store) ? "hold" : "approve";
}

/**
 * Claim identity stays the wording, so a reworded lesson is a second record,
 * and a shared command never merges two claims. Approving it on its own is a
 * different matter: when an approved record of the same repository already
 * carries one of its `command:` refs, which wording should stand is the
 * operator's call, so it waits as a pending proposal. Live (run 4) a turn-end
 * pass and the completion retention 24 ms later each wrote one wording of the
 * same validation lesson; one was approved, the other was approved 47 s later
 * on a later look, and both were delivered after resume.
 *
 * An operator-rejected record holds it too. The rejection matches only its
 * exact wording (`similarRepositoryLesson`), so without this a rewording of
 * the declined lesson citing the same command would be approved on one
 * session's word and delivered as though the operator had never ruled.
 */
function commandAlreadyClaimed(record: MemoryRecord, store: ReadonlyArray<MemoryRecord>): boolean {
	const commands = record.evidenceRefs.filter((ref) => ref.startsWith("command:"));
	const repository = record.repository;
	if (commands.length === 0 || repository === undefined) return false;
	return store.some(
		(other) =>
			other.id !== record.id &&
			(other.approved || other.rejectedAt !== undefined) &&
			other.scope === "repo" &&
			other.repository?.kind === repository.kind &&
			other.repository.key === repository.key &&
			other.evidenceRefs.some((ref) => commands.includes(ref)),
	);
}

/** Apply the same verdict whether observations arrive separately or with a new evidence-backed proposal. */
export function applyMemoryGate(
	record: MemoryRecord,
	at: string,
	store: ReadonlyArray<MemoryRecord> = [],
): MemoryGateVerdict {
	const verdict = evaluateMemoryGate(record, store);
	if (verdict === "approve") {
		record.approved = true;
		record.lastVerifiedAt = at;
		record.approval = { by: "guardian", at };
	} else if (verdict === "demote") {
		record.approved = false;
		Reflect.deleteProperty(record, "approval");
		record.regressions = [...(record.regressions ?? []), `contradicted after guardian approval at ${at}`];
	}
	return verdict;
}

/**
 * Append observations and apply the gate inside the store's one locked
 * read-modify-write, so concurrent sessions and operator decisions are never
 * overwritten by a copy read before them.
 */
export async function recordMemoryObservations(
	dataDir: string,
	inputs: ReadonlyArray<MemoryObservationInput>,
	now: Date = new Date(),
	options: MemoryMutationOptions = {},
): Promise<MemoryGateOutcome> {
	const outcome: MemoryGateOutcome = { approved: [], demoted: [], missing: [] };
	if (inputs.length === 0) return outcome;
	const at = now.toISOString();
	return mutateMemoryRecords(
		dataDir,
		(records) => {
			const byId = new Map(records.map((record) => [record.id, record]));
			const touched = new Map<string, MemoryRecord>();
			for (const input of inputs) {
				const current = touched.get(input.memoryId) ?? byId.get(input.memoryId);
				if (current === undefined) {
					outcome.missing.push(input.memoryId);
					continue;
				}
				const next = cloneMemoryRecord(current);
				const observation: MemoryObservation = { at, sessionId: input.sessionId, kind: input.kind };
				// One verdict per session and kind: repeats add nothing the gate counts and
				// would push older contradictions out of the bounded window.
				if (!(next.observations ?? []).some((seen) => seen.sessionId === input.sessionId && seen.kind === input.kind))
					next.observations = [...(next.observations ?? []), observation].slice(-MEMORY_OBSERVATIONS_MAX);
				// A later session that saw an approved lesson hold re-verified it; approval itself does not change.
				if (input.kind === "held" && next.approved) next.lastVerifiedAt = at;
				touched.set(next.id, next);
			}
			if (touched.size === 0) return { result: outcome };
			for (const record of touched.values()) {
				// Approvals made earlier in this loop are part of the store the next verdict reads.
				const verdict = applyMemoryGate(
					record,
					at,
					records.map((candidate) => touched.get(candidate.id) ?? candidate),
				);
				if (verdict === "approve") {
					outcome.approved.push(record);
				} else if (verdict === "demote") {
					outcome.demoted.push(record);
				}
			}
			return { records: records.map((record) => touched.get(record.id) ?? record), result: outcome };
		},
		options,
	);
}

/** One verdict per session: a session that saw a contradiction never counts as held. */
function sessionVerdicts(observations: ReadonlyArray<MemoryObservation>): Map<string, "held" | "contradicted"> {
	const verdicts = new Map<string, "held" | "contradicted">();
	for (const item of observations) {
		if (item.kind === "delivered") continue;
		if (verdicts.get(item.sessionId) === "contradicted") continue;
		verdicts.set(item.sessionId, item.kind);
	}
	return verdicts;
}
