/**
 * Policy registry. One id in, one pure policy out, so the live engine and the
 * replay-lite runner resolve the same object from the same settings value and
 * cannot drift into running different selections.
 *
 * `age-horizon` stays the default until the replay table says `structural-v1`
 * is ahead on retention and ahead of the random control on precision. Both are
 * resolvable now so the table can be produced.
 */

import type { WorkingSetPolicy, WorkingSetPolicyId } from "../contract.js";
import { ageHorizonPolicy } from "./age-horizon.js";
import { structuralPolicy } from "./structural.js";

export { ageHorizonPolicy, structuralPolicy };

export function resolveWorkingSetPolicy(id: WorkingSetPolicyId): WorkingSetPolicy {
	if (id === "age-horizon") return ageHorizonPolicy;
	return structuralPolicy;
}
