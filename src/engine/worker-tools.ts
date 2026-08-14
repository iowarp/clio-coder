/**
 * Worker-subprocess tool construction.
 *
 * The agent-tool adapter itself lives in `src/tools/agent-tools.ts` and is
 * shared with the orchestrator. This module owns only what is specific to a
 * worker subprocess: its own safety contract with per-run loop-detector state,
 * its registry factory, and the tool signature a worker attests.
 */

import type { ToolName } from "../core/tool-names.js";
import {
	createMiddlewareContractFromSnapshot,
	type MiddlewareHookRegistration,
	type MiddlewareSnapshot,
} from "../domains/middleware/index.js";
import { classify as classifyAction } from "../domains/safety/action-classifier.js";
import { type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../domains/safety/autonomy.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import {
	createLoopState,
	type LoopDetectorState,
	observe as observeLoopState,
} from "../domains/safety/loop-detector.js";
import { createSafetyPolicyEngine } from "../domains/safety/policy-engine.js";
import {
	type ProtectedArtifactState,
	protectedArtifactMutationBlockReason,
} from "../domains/safety/protected-artifacts.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../domains/safety/scope.js";
import { effectiveToolNames } from "../tools/agent-tools.js";
import { registerAllTools } from "../tools/bootstrap.js";
import type { ToolProfileName } from "../tools/profiles.js";
import { createRegistry, type RegistryDeps, type ToolRegistry } from "../tools/registry.js";
import { type AgentLedgerPort, toolSignatureOf } from "../worker/protocol.js";

/**
 * Build a worker-local SafetyContract that owns its own loop-detector state.
 * The state is per-worker-run (one subprocess per run) so two concurrent
 * workers do not share counts. The detector matches the orchestrator's
 * behaviour but skips audit-record bookkeeping which the worker does not own.
 */
export interface WorkerSafetyOptions {
	cwd?: string;
	writeRoots?: ReadonlyArray<string>;
	protectedArtifactState?: ProtectedArtifactState;
}

export function createWorkerSafety(options: WorkerSafetyOptions = {}): SafetyContract {
	let loopState: LoopDetectorState = createLoopState();
	const policyEngine = createSafetyPolicyEngine({
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.writeRoots !== undefined ? { writeRoots: options.writeRoots } : {}),
	});
	const protectedArtifactState: ProtectedArtifactState = {
		artifacts: structuredClone(options.protectedArtifactState?.artifacts ?? []),
	};
	return {
		classify: (call) => classifyAction(call),
		evaluate(call, posture) {
			const protectedReason = protectedArtifactMutationBlockReason(protectedArtifactState, call.tool, call.args);
			if (protectedReason !== null) {
				const classification = classifyAction(call);
				const rejection = {
					short: "protected artifact blocked",
					detail: protectedReason,
					hints: [],
				};
				const metadata = policyEngine.metadata(posture);
				const policy = {
					kind: "block" as const,
					classification,
					tool: call.tool,
					actionClass: classification.actionClass,
					reasons: [...classification.reasons, protectedReason],
					ruleId: "protected-artifact",
					reasonCode: "protected-artifact",
					cwd: metadata.cwd,
					policySource: "builtin-classifier" as const,
					rejection,
					...(posture !== undefined ? { posture } : {}),
				};
				return { kind: "block", classification, rejection, policy };
			}
			const policy = policyEngine.evaluate(call, posture);
			const classification = policy.classification;
			if (policy.kind === "block") {
				const decision: SafetyDecision = {
					kind: "block",
					classification,
					rejection: policy.rejection ?? fallbackRejection(policy),
					policy,
				};
				if (policy.match) (decision as { match?: typeof policy.match }).match = policy.match;
				return decision;
			}
			if (policy.kind === "ask") {
				const decision: SafetyDecision = {
					kind: "ask",
					classification,
					rejection: policy.rejection ?? fallbackRejection(policy),
					policy,
				};
				if (policy.match) (decision as { match?: typeof policy.match }).match = policy.match;
				return decision;
			}
			return { kind: "allow", classification, policy };
		},
		observeLoop(key, now) {
			const [next, verdict] = observeLoopState(loopState, key, now ?? Date.now());
			loopState = next;
			return verdict;
		},
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		policy: { metadata: (posture) => policyEngine.metadata(posture) },
		audit: { recordCount: () => 0 },
	};
}

function fallbackRejection(policy: { tool: string; actionClass: string; reasons: ReadonlyArray<string> }) {
	return {
		short: `${policy.tool} blocked: ${policy.actionClass}`,
		detail: policy.reasons.join("\n"),
		hints: [],
	};
}

export function createWorkerToolRegistry(
	middlewareSnapshot?: MiddlewareSnapshot,
	safety: SafetyContract = createWorkerSafety(),
	skillLoaderOptions?: { noSkills?: boolean; skillPaths?: string[]; trustProjectCompatRoots?: boolean },
	hookRegistrations?: ReadonlyArray<MiddlewareHookRegistration>,
	autonomy?: AutonomyLevel,
	onMiddlewareEffects?: RegistryDeps["onMiddlewareEffects"],
	agentLedger?: AgentLedgerPort,
): ToolRegistry {
	// A worker always gets a middleware contract, even without a snapshot from
	// the orchestrator, because the loop guard rides on it as a before_tool
	// registration. An empty snapshot evaluates no declarative rules, matching
	// the former no-middleware behavior.
	const middleware = createMiddlewareContractFromSnapshot(middlewareSnapshot ?? { version: 1, rules: [] });
	for (const registration of hookRegistrations ?? []) {
		middleware.registerHook(registration);
	}
	// The level is fixed for the lifetime of the worker run: it ships on the
	// WorkerSpec at dispatch admission and never hot-reloads mid-run.
	const registry = createRegistry({
		safety,
		middleware,
		autonomy: () => autonomy ?? DEFAULT_AUTONOMY_LEVEL,
		...(onMiddlewareEffects ? { onMiddlewareEffects } : {}),
	});
	// The ledger tool registers unconditionally. attestedToolSignature signs the
	// names a bare registry produces, so a conditional registration would drift
	// the signature and fail admission; only the injected port varies, and a run
	// without one answers that it has no coordination ledger.
	registerAllTools(registry, {
		...(agentLedger ? { agentLedger } : {}),
		getSkillLoaderOptions: () => ({
			trustProjectCompatRoots: skillLoaderOptions?.trustProjectCompatRoots === true,
			disableDiscovery: skillLoaderOptions?.noSkills === true,
			...(skillLoaderOptions?.skillPaths && skillLoaderOptions.skillPaths.length > 0
				? { explicitSkillPaths: skillLoaderOptions.skillPaths }
				: {}),
		}),
	});
	return registry;
}

/**
 * Native worker registries receive no DispatchContract, so no worker runtime
 * mediates nested Clio dispatch. A constant, not a lookup: there is nothing to
 * vary by runtime, and a parameter would imply otherwise.
 */
export const WORKER_RUNTIME_MEDIATES_CLIO_DISPATCH = false;

export interface AttestedToolIdentityInput {
	allowedTools: ReadonlyArray<ToolName>;
	/** False when the resolved runtime mediates no tool calls at all. */
	toolsSupported: boolean;
	toolProfile?: ToolProfileName;
	agentId?: string;
	task?: string;
}

/**
 * The effective tool signature a worker announces before model execution. The
 * orchestrator compares it against the surface the plan approved, so a worker
 * whose registry resolved a different tool set is refused rather than run.
 */
export function attestedToolSignature(input: AttestedToolIdentityInput): string {
	const registry = createWorkerToolRegistry();
	return toolSignatureOf(
		effectiveToolNames({
			registry,
			allowedTools: input.toolsSupported ? input.allowedTools : [],
			includeInteractiveTools: false,
			...(input.toolProfile !== undefined ? { toolProfile: input.toolProfile } : {}),
			...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
			...(input.task !== undefined ? { task: input.task } : {}),
		}),
	);
}
