import type { DomainModule } from "../../core/domain-loader.js";
import { createDispatchBundle, type DispatchBundleOptions } from "./extension.js";
import { DispatchManifest } from "./manifest.js";

export const DispatchDomainModule: DomainModule = {
	manifest: DispatchManifest,
	createExtension: createDispatchBundle,
};

export function createDispatchDomainModule(options: DispatchBundleOptions = {}): DomainModule {
	return {
		manifest: DispatchManifest,
		createExtension: (context) => createDispatchBundle(context, options),
	};
}

export type {
	AssignmentId,
	AssignmentPolicy,
	AssignmentStatus,
	AttemptRef,
	DispatchAssignment,
} from "./assignment.js";
export type { DurableAssignmentRecord } from "./assignment-store.js";
export type { DispatchContract, DispatchRequest } from "./contract.js";
export {
	affectsNodeBreaker,
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
	type FailureClass,
	type RetryDecision,
	type RoutePart,
} from "./failure-classification.js";
export type { GateDecisionArtifact, GateDecisionOutcome } from "./gate-decisions.js";
export {
	readGateDecisionArtifacts,
	readGateDecisionArtifactsForRunIds,
	verifyGateDecisionArtifact,
} from "./gate-decisions.js";
export { DispatchManifest } from "./manifest.js";
export { verifyReceiptIntegrity } from "./receipt-integrity.js";
export type {
	ReceiptVerificationState,
	RunBriefingProvenance,
	RunEnvelope,
	RunKind,
	RunOutcomeCode,
	RunReceipt,
	RunReceiptIntegrity,
	RunReceiptVerification,
	RunStatus,
	ToolCallStat,
} from "./types.js";
export {
	DISPATCH_BRIEFING_MAX_BYTES,
	type DispatchFailoverCandidate,
	type DispatchFailoverMode,
	type JobSpec,
} from "./validation.js";
