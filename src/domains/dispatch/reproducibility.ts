import type { SafetyPolicyMetadata } from "../safety/policy-engine.js";
import type { RunReceiptReproducibility } from "./types.js";

/**
 * The run's working directory and the safety policy it ran under. Builds
 * before 0.5.6 also recorded checkout state here, at three synchronous `git`
 * spawns per finalization, and nothing read it.
 */
export function collectReproducibilityMetadata(
	cwd: string,
	safety: SafetyPolicyMetadata | null,
): RunReceiptReproducibility {
	return {
		cwd,
		safetyPolicy: {
			version: safety?.version ?? 1,
			rulePackHash: safety?.rulePackHash ?? null,
			rulePackVersion: safety?.rulePackVersion ?? null,
			projectPolicyPath: safety?.projectPolicyPath ?? null,
			projectPolicyHash: safety?.projectPolicyHash ?? null,
			projectPolicyValid: safety?.projectPolicyValid ?? null,
		},
	};
}
