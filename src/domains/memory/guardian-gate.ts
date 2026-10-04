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

/** Pure verdict over one record's retained observations. */
export function evaluateMemoryGate(record: MemoryRecord): MemoryGateVerdict {
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
	return held >= MEMORY_GATE_HELD_SESSIONS ? "approve" : "hold";
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
): Promise<MemoryGateOutcome> {
	const outcome: MemoryGateOutcome = { approved: [], demoted: [], missing: [] };
	if (inputs.length === 0) return outcome;
	const at = now.toISOString();
	return mutateMemoryRecords(dataDir, (records) => {
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
			next.observations = [...(next.observations ?? []), observation].slice(-MEMORY_OBSERVATIONS_MAX);
			touched.set(next.id, next);
		}
		if (touched.size === 0) return { result: outcome };
		for (const record of touched.values()) {
			const verdict = evaluateMemoryGate(record);
			if (verdict === "approve") {
				record.approved = true;
				record.lastVerifiedAt = at;
				record.approval = { by: "guardian", at };
				outcome.approved.push(record);
			} else if (verdict === "demote") {
				record.approved = false;
				Reflect.deleteProperty(record, "approval");
				// `regressions` already excludes a record from every prompt
				// (`eligibleMemoryRecords`), so demotion needs no second mechanism.
				record.regressions = [...(record.regressions ?? []), `contradicted after guardian approval at ${at}`];
				outcome.demoted.push(record);
			}
		}
		return { records: records.map((record) => touched.get(record.id) ?? record), result: outcome };
	});
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
