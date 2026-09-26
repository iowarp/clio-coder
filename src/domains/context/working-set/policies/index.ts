/**
 * Policy registry. One id in, one pure policy out, so the live engine and the
 * replay-lite runner resolve the same object from the same settings value and
 * cannot drift into running different selections.
 *
 * `structural-v1` is the recorded previous default and `structural-v2` the
 * master composition; `age-horizon` stays resolvable as the exact pre-layer
 * selection. The replay harness additionally resolves the derived
 * composition ids `compose.ts` spells (`<id>+<rung>`, `<id>-<rung>`,
 * `rungs:<a>/<b>`), which the live settings enum never admits.
 */

import type { WorkingSetPolicy, WorkingSetPolicyId } from "../contract.js";
import { ageHorizonPolicy } from "./age-horizon.js";
import { resolveComposedPolicy } from "./compose.js";
import { structuralPolicy, structuralV2Policy } from "./structural.js";

export { ageHorizonPolicy, structuralPolicy, structuralV2Policy };

export function resolveWorkingSetPolicy(id: WorkingSetPolicyId): WorkingSetPolicy {
	if (id === "age-horizon") return ageHorizonPolicy;
	if (id === "structural-v2") return structuralV2Policy;
	return structuralPolicy;
}

/** Every id the replay harness accepts: the shipped ids plus the derived compositions. Null when unknown. */
export function resolveReplayPolicy(id: string): WorkingSetPolicy | null {
	if (id === "age-horizon") return ageHorizonPolicy;
	return resolveComposedPolicy(id);
}
