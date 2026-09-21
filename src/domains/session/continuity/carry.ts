/**
 * Summary carry and missing-commit reconstruction (CONTRACTS.md §3.5, §6).
 *
 * A later summary embeds the current validated folded payload: the same
 * identity, the same agent-authored note, the original policy, the original
 * commit envelope/outcome/refs and spent attempts, with `state` advanced to the
 * latest delivery, acknowledgement, pause or explicit resume. It never
 * manufactures a commit and never turns an eviction-only outcome into a
 * summarized one.
 *
 * Both functions are projections of a validated fold. Neither reads a clock,
 * mints an id, or writes anything.
 */

import type { ContinuityCheckpointPayload, ContinuityFoldResult, MissingCommitReconstruction } from "./contract.js";
import { HANDOFF_SCHEMA_VERSION } from "./contract.js";
import { isContinuityCheckpointPayload } from "./validate.js";

/**
 * The payload a summary written now should carry, or null when this fold has
 * nothing durable to carry.
 *
 * A carry requires a commit: before one exists there is no checkpoint to
 * project, only an in-flight transaction whose own records are the evidence.
 * The result is validated before being returned, so a fold that produced a
 * shape this core would refuse to read back cannot be written out.
 */
export function continuityPayloadFromFold(fold: ContinuityFoldResult): ContinuityCheckpointPayload | null {
	// Only a validated fold may be published. This is not the same as execution
	// authority: a paused or inherited historical transaction is recall-only and
	// still carries perfectly well, while a chain with conflicting copies or a
	// malformed record has nothing trustworthy to write forward.
	if (!fold.validated) return null;
	if (!fold.identity || !fold.accepted || !fold.policy || !fold.commit || !fold.state) return null;
	const payload: ContinuityCheckpointPayload = {
		schemaVersion: HANDOFF_SCHEMA_VERSION,
		identity: fold.identity,
		accepted: fold.accepted,
		policy: fold.policy,
		commit: fold.commit,
		state: fold.state,
	};
	return isContinuityCheckpointPayload(payload) ? payload : null;
}

/**
 * The commit a validated carry proves existed, when this projection does not
 * contain it.
 *
 * The fold has already refused to conclude absence while unreadable records
 * could hide the commit, so this is a projection of that decision rather than a
 * second search. The reconstruction reuses the reserved entry id, parent and
 * timestamp, which is what keeps recovery from minting a second commit
 * identity, and returns the later carried head separately so restoring it after
 * the append cannot regress an acknowledgement or a pause to `ready`.
 */
export function missingCommitFromCarry(fold: ContinuityFoldResult): MissingCommitReconstruction | null {
	return fold.validated ? fold.missingCommit : null;
}
