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
export type { AssignmentVerdictOwner, DurableAssignmentRecord } from "./assignment-store.js";
export type { CodeStepOutcome, CodeStepRecord, CodeStepRunInput } from "./code-step.js";
export {
	canonicalCodeReport,
	codeReportDigest,
	resolveCommandArgv,
	runCodeStep,
	workspaceHasChanges,
} from "./code-step.js";
export { readCodeStepRecords, writeCodeStepRecord } from "./code-step-store.js";
export type { DispatchContract, DispatchRequest } from "./contract.js";
export type {
	DelegationPlan,
	DelegationPlanReason,
	DelegationPlanTask,
	DelegationPlanValidation,
} from "./delegation-plan.js";
export {
	buildDelegationProposalBriefing,
	DELEGATION_PROPOSAL_BRIEFING_MAX_BYTES,
	validateDelegationPlan,
} from "./delegation-plan.js";
export type {
	ExecutionPlan,
	ExecutionPlanAgentStep,
	ExecutionPlanCodeStep,
	ExecutionPlanLoop,
	ExecutionPlanLoopMembership,
	ExecutionPlanStep,
	ExecutionPlanStepInput,
} from "./execution-plan.js";
export {
	compileExecutionPlan,
	compileLinearExecutionPlan,
	executionPlanAncestors,
	executionPlanWaves,
	isAgentStep,
	isCodeStep,
	spliceExecutionPlan,
} from "./execution-plan.js";
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
export type { ExecutionSchedulerAdapter } from "./execution-scheduler.js";
export {
	type ExecutionLoopDecision,
	type ExecutionLoopOutcome,
	type ExecutionLoopReason,
	type ExecutionPlanResult,
	executePlan,
	STALENESS_REVALIDATION_LIMIT,
} from "./execution-scheduler.js";
export {
	affectsNodeBreaker,
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
	type FailureClass,
	type RetryDecision,
	type RoutePart,
} from "./failure-classification.js";
export { gateBaselineFailure, gateFailureLines } from "./fleet-gate.js";
export { type CompileFleetPlanInput, compileFleetExecutionPlan } from "./fleet-plan.js";
export type {
	ExecuteFleetRunInput,
	FleetResumePlan,
	FleetResumeRefusal,
	FleetResumeStepDiff,
	FleetRunAgentAccess,
	FleetRunOutcome,
	FleetRunStepEvent,
	FleetRunStepOutcome,
} from "./fleet-run.js";
export { executeFleetRun, fleetPlanWaveIndex, planFleetResume } from "./fleet-run.js";
export type { GateDecisionArtifact, GateDecisionOutcome } from "./gate-decisions.js";
export {
	readGateDecisionArtifacts,
	readGateDecisionArtifactsForRunIds,
	verifyGateDecisionArtifact,
} from "./gate-decisions.js";
export { runHostVerification, workspaceFingerprint } from "./host-verification.js";
export type { DispatchIntent, DispatchIntentVerification } from "./intent.js";
export {
	DISPATCH_INTENT_PATH_ENTRY_BYTES_CAP,
	DISPATCH_INTENT_PATH_LIST_CAP,
	DISPATCH_INTENT_TIMEOUT_MIN_MS,
	DISPATCH_INTENT_VERIFICATION_CAP,
	isDispatchIntent,
	normalizeDispatchIntent,
} from "./intent.js";
export { DispatchManifest } from "./manifest.js";
export { verifyReceiptIntegrity } from "./receipt-integrity.js";
export { createRouteHistoryStore } from "./route-history.js";
export type { RouteQualityLabel, RouteQualityReduction } from "./route-quality.js";
export { reduceRouteQuality } from "./route-quality.js";
export type { RouteExplanation, RoutingIntent } from "./routing-intent.js";
export { explainRouteDecision, parseRoutingIntent, preferLocalTie, routingIntentRejection } from "./routing-intent.js";
export type { FleetRunRecord } from "./state.js";
export { readFleetRun, writeFleetRun } from "./state.js";
export type {
	ReceiptVerificationState,
	RunBriefingProvenance,
	RunEnvelope,
	RunHostVerification,
	RunHostVerificationCheck,
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
	INTERNAL_DISPATCH_BRIEFING_MAX_BYTES,
	type JobSpec,
} from "./validation.js";
export type {
	WorkspaceSnapshot,
	WriteBoundaryAttribution,
	WriteBoundaryStatus,
	WriteBoundaryVerdict,
} from "./write-boundary.js";
export {
	assertWriteBoundaryVisibleToGit,
	captureWorkspaceSnapshot,
	diffWorkspace,
	enforceWriteBoundary,
	WRITE_BOUNDARY_VIOLATION_REASON,
	writeBoundaryDir,
	writeWriteBoundaryVerdict,
} from "./write-boundary.js";
export type { WriteBoundaryEnforcer } from "./write-boundary-enforcer.js";
export { createWriteBoundaryEnforcer, preflightWriteBoundaries } from "./write-boundary-enforcer.js";
