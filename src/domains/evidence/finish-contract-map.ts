import type { FinishContractEvidenceKind } from "../safety/finish-contract.js";
import type { EvidenceTag } from "./types.js";

/**
 * One evidence spine: the live finish-contract layer is a cheap projection of
 * the forensic evidence taxonomy.
 *
 * The forensic layer (`evidence/build.ts`) speaks the canonical 22-tag
 * `EVIDENCE_TAGS` vocabulary over durable artifacts. The live layer
 * (`safety/finish-contract.ts`) speaks a 4-kind in-loop vocabulary
 * (`FinishContractEvidenceKind`) over the last ~80 session entries. They are
 * the same accountability concept observed at two depths.
 *
 * This module documents that relationship as a pure mapping: each live kind
 * projects onto the canonical `EvidenceTag`(s) it informs. It is types and a
 * table only. It does NOT import the heavy evidence builder, and nothing here
 * changes runtime behavior; the live gate still behaves exactly as today.
 *
 * The mapping is a `Record` keyed by every `FinishContractEvidenceKind`, so the
 * compiler enforces totality: adding a live kind without a projection is a type
 * error.
 *
 * Projection rationale (live kind -> forensic tag(s)):
 *   - validation_command: positive validation evidence. Its forensic polarity
 *     tags are `no-validation` (validation absent) and `proxy-validation`
 *     (validation present but a weak proxy).
 *   - protected_artifact: a protect action, which the forensic layer records
 *     under `protected-artifact`.
 *   - dispatch_receipt: a passed dispatch receipt, whose forensic concerns are
 *     `receipt-integrity` (the receipt verifies) and `session-linked` (the run
 *     is linked to its session).
 *   - requested_inspection: a best-effort match of a user-requested git
 *     inspection, which the forensic layer links under `best-effort-link`.
 */
export const FINISH_CONTRACT_EVIDENCE_TAGS: Record<FinishContractEvidenceKind, readonly EvidenceTag[]> = {
	validation_command: ["no-validation", "proxy-validation"],
	protected_artifact: ["protected-artifact"],
	dispatch_receipt: ["receipt-integrity", "session-linked"],
	requested_inspection: ["best-effort-link"],
} as const;

/** The canonical tags a single live finish-contract kind projects onto. */
export function finishContractEvidenceTags(kind: FinishContractEvidenceKind): readonly EvidenceTag[] {
	return FINISH_CONTRACT_EVIDENCE_TAGS[kind];
}
