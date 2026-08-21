/**
 * Policy registry. One id in, one pure policy out, so the live engine and the
 * replay-lite runner resolve the same object from the same settings value and
 * cannot drift into running different selections.
 */

import type { WorkingSetPolicy, WorkingSetPolicyId } from "../contract.js";
import { ageHorizonPolicy } from "./age-horizon.js";

export { ageHorizonPolicy };

export function resolveWorkingSetPolicy(id: WorkingSetPolicyId): WorkingSetPolicy {
	if (id === "age-horizon") return ageHorizonPolicy;
	throw new Error(
		`working-set policy "${id}" is not implemented in this slice; set context.workingSet.policy to "age-horizon"`,
	);
}
