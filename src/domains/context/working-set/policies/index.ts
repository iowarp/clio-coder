/**
 * Policy registry. One id in, one pure policy out, so the live engine and the
 * replay-lite runner resolve the same object from the same settings value and
 * cannot drift into running different selections.
 *
 * `structural-v1` is the default; internal replay studies put it ahead of
 * `age-horizon` on retention and ahead of the random control on precision.
 * `age-horizon` stays resolvable as the exact pre-layer selection.
 */

import type { WorkingSetPolicy, WorkingSetPolicyId } from "../contract.js";
import { ageHorizonPolicy } from "./age-horizon.js";
import { structuralPolicy } from "./structural.js";

export { ageHorizonPolicy, structuralPolicy };

export function resolveWorkingSetPolicy(id: WorkingSetPolicyId): WorkingSetPolicy {
	if (id === "age-horizon") return ageHorizonPolicy;
	return structuralPolicy;
}
