import type { DomainModule } from "../../core/domain-loader.js";
import { createSafetyBundle } from "./extension.js";
import { SafetyManifest } from "./manifest.js";

export const SafetyDomainModule: DomainModule<"safety"> = {
	manifest: SafetyManifest,
	createExtension: createSafetyBundle,
};

export {
	type AutonomyDisposition,
	type AutonomyExposure,
	type AutonomyLevel,
	autonomyFromUserInput,
	modelMayActivateSkills,
} from "./autonomy.js";
export { callChangesTree } from "./check-classifier.js";
export type { SafetyContract, SafetyDecision } from "./contract.js";
export type {
	FinishContractAssessment,
	FinishContractEvidence,
	FinishContractEvidenceKind,
	FinishContractInput,
	FinishContractReason,
} from "./finish-contract.js";
export type {
	FlowDestination,
	FlowRestriction,
	FlowRestrictionSet,
	FlowVerdictKind,
	InformationFlowInput,
	InformationFlowPolicy,
	InformationFlowVerdict,
} from "./information-flow.js";
export {
	EMPTY_INFORMATION_FLOW_POLICY,
	flowTransferRefusal,
	flowUnmediatedAgentRefusal,
	isFlowRestrictionSet,
	mergeFlowRestrictions,
	resolveModelDestination,
} from "./information-flow.js";
export {
	type CompiledPathPolicy,
	evaluatePathPolicy,
	type PathPolicyDecision,
	type PathPolicyEntry,
	type PathPolicyInput,
	type PathPolicyKind,
	type PathPolicyOperation,
} from "./path-policy.js";
export {
	parseRigorOverride,
	type Rigor,
	type RigorResolution,
	type RigorSource,
	resolveRigor,
} from "./rigor.js";
export {
	describeValidationContract,
	loadValidationContract,
	type ValidationContract,
	type ValidationContractArtifact,
	type ValidationContractLoadResult,
	type ValidationContractRuntime,
} from "./validation-contract.js";
