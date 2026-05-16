import type { DomainModule } from "../../core/domain-loader.js";
import { createSafetyBundle } from "./extension.js";
import { SafetyManifest } from "./manifest.js";

export const SafetyDomainModule: DomainModule = {
	manifest: SafetyManifest,
	createExtension: createSafetyBundle,
};

export type { SafetyContract, SafetyDecision } from "./contract.js";
export type { FinishContractAssessment, FinishContractEvidence, FinishContractInput } from "./finish-contract.js";
export {
	assessFinishContract,
	FINISH_CONTRACT_ADVISORY_MESSAGE,
	hasCompletionClaim,
	hasExplicitLimitation,
} from "./finish-contract.js";
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
