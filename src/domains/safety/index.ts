import type { DomainModule } from "../../core/domain-loader.js";
import { createSafetyBundle } from "./extension.js";
import { SafetyManifest } from "./manifest.js";

export const SafetyDomainModule: DomainModule = {
	manifest: SafetyManifest,
	createExtension: createSafetyBundle,
};

export {
	AUTONOMY_EXPOSURES,
	AUTONOMY_LEVELS,
	type AutonomyDisposition,
	type AutonomyExposure,
	type AutonomyLevel,
	autonomyAskRejection,
	autonomyDenyRejection,
	DEFAULT_AUTONOMY_EXPOSURE,
	DEFAULT_AUTONOMY_LEVEL,
	isAutonomyLevel,
	mapAutonomy,
} from "./autonomy.js";
export type { SafetyContract, SafetyDecision } from "./contract.js";
export type {
	FinishContractAssessment,
	FinishContractEvidence,
	FinishContractEvidenceKind,
	FinishContractInput,
	FinishContractReason,
} from "./finish-contract.js";
export { assessFinishContract, FINISH_CONTRACT_ADVISORY_MESSAGE } from "./finish-contract.js";
export { SafetyManifest } from "./manifest.js";
export {
	type CompiledPathPolicy,
	compilePathPolicy,
	evaluatePathPolicy,
	isSameOrDescendant,
	type PathPolicyDecision,
	type PathPolicyEntry,
	type PathPolicyInput,
	type PathPolicyKind,
	type PathPolicyOperation,
} from "./path-policy.js";
export { parseRigorOverride, type Rigor, resolveRigor } from "./rigor.js";
