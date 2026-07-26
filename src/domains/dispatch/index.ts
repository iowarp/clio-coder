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
export type { ExecutionPlan, ExecutionPlanStep } from "./execution-plan.js";
export { compileExecutionPlan, compileLinearExecutionPlan, executionPlanWaves } from "./execution-plan.js";
export {
	type AgentRoleFacts,
	type AgentRoleFactsResolver,
	agentRoleFactsResolver,
	DEFAULT_GATE_DECIDER_AGENT_ID,
	deriveExecutionRole,
	EXECUTION_ROLES,
	type ExecutionRole,
	type GateRouteCorrelation,
	type GateTopologyRole,
	gateDeciderAgentId,
	gateRouteCorrelation,
	isExecutionRole,
	modelFamily,
	preferIndependentRoute,
	type RouteCorrelationFacts,
	requestExecutionRole,
	withAttemptRole,
} from "./execution-role.js";
export type { ExecutionPlanResult, ExecutionSchedulerAdapter } from "./execution-scheduler.js";
export { executePlan } from "./execution-scheduler.js";
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
export { createRouteHistoryStore } from "./route-history.js";
export type { RouteQualityLabel, RouteQualityReduction } from "./route-quality.js";
export { reduceRouteQuality } from "./route-quality.js";
export type {
	ReceiptVerificationState,
	RunBriefingProvenance,
	RunEnvelope,
	RunKind,
	RunOutcomeCode,
	RunReceipt,
	RunReceiptIntegrity,
	RunReceiptQuality,
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
