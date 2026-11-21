import { createHash } from "node:crypto";
import path from "node:path";
import type { WorkerRecall } from "../domains/context/worker/recall.js";
/**
 * Worker-subprocess tool construction.
 *
 * The agent-tool adapter itself lives in `src/tools/agent-tools.ts` and is
 * shared with the orchestrator. This module owns only what is specific to a
 * worker subprocess: its own safety contract with per-run loop-detector state,
 * its registry factory, and the tool signature a worker attests.
 */

import { workerReadOnlyTargetViolation, workerSandboxWritesNothing } from "../core/sandbox/worker-process.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import {
	createMiddlewareHostFromSnapshot,
	type MiddlewareHookRegistration,
	type MiddlewareSnapshot,
} from "../domains/middleware/index.js";
import { classify as classifyAction } from "../domains/safety/action-classifier.js";
import type { AdmissionGitContext } from "../domains/safety/admission.js";
import { DEFAULT_AUTONOMY_LEVEL } from "../domains/safety/autonomy.js";
import { type SafetyContract, toSafetyDecision } from "../domains/safety/contract.js";
import type { ToolDecisionInput } from "../domains/safety/decision-events.js";
import { recordToolDecision as emitToolDecision } from "../domains/safety/decision-events.js";
import type { WorkerFlowPolicyInput } from "../domains/safety/information-flow.js";
import { compileWorkerFlowPolicy, flowRestrictionsForCall } from "../domains/safety/information-flow.js";
import {
	createLoopState,
	type LoopDetectorState,
	observe as observeLoopState,
} from "../domains/safety/loop-detector.js";
import { createSafetyPolicyEngine, flowSourceCallFor } from "../domains/safety/policy-engine.js";
import {
	type ProtectedArtifactState,
	protectedArtifactMutationBlockReason,
} from "../domains/safety/protected-artifacts.js";
import { isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../domains/safety/scope.js";
import { probeWorkspace } from "../domains/session/workspace/index.js";
import { effectiveToolNames, wireParameterSchema } from "../tools/agent-tools.js";
import { assertRegisteredBuiltinTools, registerCoreTools } from "../tools/core-bootstrap.js";
import type { McpCapabilitySource } from "../tools/gateway/index.js";
import { registerHarnessExtensionTools } from "../tools/harness-extensions.js";
import type { ToolProfileName } from "../tools/profiles.js";
import { createRegistry, type RegistryDeps, type ToolRegistry } from "../tools/registry.js";
import { runtimeAttachesGateway } from "../tools/surface.js";
import { type AgentLedgerPort, canonicalJson, toolSignatureOf } from "../worker/protocol.js";

export { WORKER_RUNTIME_MEDIATES_CLIO_DISPATCH } from "./worker-runtime-capabilities.js";

/** Host-owned terminal protocol, never an additional workspace capability. */
export const INTERNAL_HELPER_RESULT_TOOL = "clio_submit_result";

/**
 * Build a worker-local SafetyContract that owns its own loop-detector state.
 * The state is per-worker-run (one subprocess per run) so two concurrent
 * workers do not share counts. The detector matches the orchestrator's
 * behaviour and forwards structural tool decisions to the run journal (#434).
 */
export interface WorkerSafetyOptions {
	cwd?: string;
	/** Exact artifact required by the admitted architect contract; never a general write grant. */
	requiredArtifactPath?: string;
	writeRoots?: ReadonlyArray<string>;
	/** The worker's OS sandbox confines its commands to `writeRoots`. */
	writeRootsOsConfined?: boolean;
	/** Trees the worker's sandbox lets it read outside its workspace. */
	readExemptRoots?: ReadonlyArray<string>;
	protectedArtifactState?: ProtectedArtifactState;
	flowPolicy?: WorkerFlowPolicyInput;
	taskWorktreeRoot?: string;
}

/**
 * An architect run's plan lives at its contract path. A plan artifact spelled elsewhere ("PLAN.md" because the task
 * said so) would fail the contract after the document was written, so it is refused up front; the caller moves the
 * plan if it wants it elsewhere (row 295).
 */
function architectPlanPathRefusal(
	required: { cwd: string; path: string } | undefined,
	tool: string,
	args: Readonly<Record<string, unknown>> | undefined,
): string | null {
	if (required === undefined || tool !== ToolNames.Artifact || args?.kind !== "plan") return null;
	const spelled = typeof args.path === "string" ? args.path.trim() : "";
	if (spelled.length === 0 || path.resolve(required.cwd, spelled) === path.resolve(required.cwd, required.path)) {
		return null;
	}
	return `This architect run's plan goes to its contract path ${required.path}, not ${spelled}. Call artifact with kind="plan" and no path; the caller receives the plan and its path, and moves it if it wants the plan elsewhere.`;
}

export function createWorkerSafety(options: WorkerSafetyOptions = {}): SafetyContract {
	let loopState: LoopDetectorState = createLoopState();
	const recordToolDecision = (input: ToolDecisionInput): void => {
		emitToolDecision(input);
	};
	const policyEngine = createSafetyPolicyEngine({
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.writeRoots !== undefined ? { writeRoots: options.writeRoots } : {}),
		...(options.writeRootsOsConfined === true ? { writeRootsOsConfined: true } : {}),
		...(options.readExemptRoots !== undefined ? { readExemptRoots: options.readExemptRoots } : {}),
	});
	const informationFlow =
		options.flowPolicy === undefined
			? policyEngine.informationFlow()
			: compileWorkerFlowPolicy(options.flowPolicy, options.taskWorktreeRoot);
	const protectedArtifactState: ProtectedArtifactState = {
		artifacts: structuredClone(options.protectedArtifactState?.artifacts ?? []),
	};
	const requiredArtifact =
		options.requiredArtifactPath === undefined
			? undefined
			: { cwd: options.cwd ?? process.cwd(), path: options.requiredArtifactPath };
	return {
		classify: (call) => classifyAction(call),
		evaluate(call, posture, scope) {
			const protectedReason = protectedArtifactMutationBlockReason(protectedArtifactState, call.tool, call.args);
			const planReason = protectedReason ?? architectPlanPathRefusal(requiredArtifact, call.tool, call.args);
			if (planReason !== null) {
				const ruleId = protectedReason !== null ? "protected-artifact" : "architect-plan-path";
				const classification = classifyAction(call);
				const rejection = {
					short: protectedReason !== null ? "protected artifact blocked" : "plan path refused",
					detail: planReason,
					hints: [],
				};
				const metadata = policyEngine.metadata(posture);
				const policy = {
					kind: "block" as const,
					classification,
					tool: call.tool,
					actionClass: classification.actionClass,
					reasons: [...classification.reasons, planReason],
					ruleId,
					reasonCode: ruleId,
					cwd: metadata.cwd,
					policySource: "builtin-classifier" as const,
					rejection,
					...(posture !== undefined ? { posture } : {}),
				};
				return { kind: "block", classification, rejection, policy };
			}
			// A permit that inherited the operator's yolo is judged the true yolo way (#407).
			return toSafetyDecision(policyEngine.evaluate(call, posture, scope));
		},
		observeLoop(key, now) {
			const [next, verdict] = observeLoopState(loopState, key, now ?? Date.now());
			loopState = next;
			return verdict;
		},
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE },
		isSubset,
		policy: {
			informationFlow: () => informationFlow,
			// With no rules there is nothing to label, and resolving the call's cwd
			// is a filesystem walk every worker edit and write would pay for.
			flowRestrictionsFor: (rawCall) =>
				informationFlow.rules.length === 0
					? null
					: flowRestrictionsForCall(informationFlow, flowSourceCallFor(rawCall, options.cwd ?? process.cwd())),
			metadata: (posture) => policyEngine.metadata(posture),
			writeTargetViolation: (target) => workerReadOnlyTargetViolation(target) ?? policyEngine.writeTargetViolation(target),
			...(requiredArtifact !== undefined
				? {
						artifactTargetViolation: (target: string) =>
							workerReadOnlyTargetViolation(target, requiredArtifact) ?? policyEngine.writeTargetViolation(target),
					}
				: {}),
			allowsObservationPath: (path) => policyEngine.readablePath(path),
		},
		decisions: { recordToolCall: recordToolDecision },
	};
}

export function createWorkerToolRegistry(
	middlewareSnapshot?: MiddlewareSnapshot,
	safety: SafetyContract = createWorkerSafety(),
	skillLoaderOptions?: { noSkills?: boolean; skillPaths?: string[]; trustProjectCompatRoots?: boolean },
	hookRegistrations?: ReadonlyArray<MiddlewareHookRegistration>,
	readOnly?: boolean,
	onMiddlewareEffects?: RegistryDeps["onMiddlewareEffects"],
	agentLedger?: AgentLedgerPort,
	workerRecall?: WorkerRecall,
	/** The run's Git allowance and attested task worktree; absent means git inspect. */
	git?: AdmissionGitContext,
	executeAutonomy?: "yolo",
	/** The run's information-flow ledger; absent means an unrestricted run. */
	flow?: RegistryDeps["flow"],
	/** The worker-local MCP source, present only when the permit attests MCP capabilities. */
	mcpSource?: (registry: ToolRegistry) => McpCapabilitySource,
	/** Applies protect_path effects of awaited hooks, which run after the guard's own step. */
	absorbAwaitedEffects?: RegistryDeps["absorbAwaitedEffects"],
	/** The dispatch's store tag grant (M-31); absent leaves the store read-only. */
	storeGrant?: { tags: ReadonlyArray<string>; dispatchRunId?: string },
): ToolRegistry {
	// A worker always gets a middleware contract, even without a snapshot from
	// the orchestrator, because the loop guard rides on it as a before_tool
	// registration. An empty snapshot evaluates no declarative rules, matching
	// the former no-middleware behavior.
	const { contract: middleware, registrar } = createMiddlewareHostFromSnapshot(
		middlewareSnapshot ?? { version: 1, rules: [] },
	);
	for (const registration of hookRegistrations ?? []) {
		registrar.registerHook(registration);
	}
	// Execute authority comes only from the host-bound permit; read-only still dominates.
	const registry = createRegistry({
		safety,
		middleware,
		principal: "worker",
		autonomy: () => DEFAULT_AUTONOMY_LEVEL,
		...(executeAutonomy !== undefined ? { workerExecuteAutonomy: executeAutonomy } : {}),
		...(readOnly === true ? { readOnly: true, readOnlyShellConfined: workerSandboxWritesNothing } : {}),
		...(onMiddlewareEffects ? { onMiddlewareEffects } : {}),
		...(git !== undefined ? { git } : {}),
		...(flow !== undefined ? { flow } : {}),
		...(absorbAwaitedEffects !== undefined ? { absorbAwaitedEffects } : {}),
	});
	// The ledger tool registers unconditionally. attestedToolSignature signs the
	// names a bare registry produces, so a conditional registration would drift
	// the signature and fail admission; only the injected port varies, and a run
	// without one answers that it has no coordination ledger. The explicit flag
	// is what keeps that true now that the session registry omits the tool.
	const registration = registerCoreTools(registry, {
		...(mcpSource !== undefined ? { mcpCapabilities: mcpSource(registry) } : {}),
		includeLedgerTools: true,
		...(storeGrant !== undefined && storeGrant.tags.length > 0 ? { storeGrant } : {}),
		...(workerRecall ? { workerRecall } : {}),
		// A fresh probe of the worker's own cwd; nothing is saved into the dispatching session.
		workerWorkspace: () => probeWorkspace(process.cwd()),
		...(agentLedger ? { agentLedger } : {}),
		// A worker cannot install a skill or reach the operator who could, so
		// its skill listing carries installed (or bound) skills only; the
		// marketplace is the orchestrator's to offer.
		skillMarketplace: false,
		getSkillLoaderOptions: () => ({
			trustProjectCompatRoots: skillLoaderOptions?.trustProjectCompatRoots === true,
			disableDiscovery: skillLoaderOptions?.noSkills === true,
			...(skillLoaderOptions?.skillPaths && skillLoaderOptions.skillPaths.length > 0
				? { explicitSkillPaths: skillLoaderOptions.skillPaths }
				: {}),
		}),
	});
	assertRegisteredBuiltinTools(registry, registration, false);
	registerHarnessExtensionTools(registry);
	return registry;
}

/**
 * Native worker registries receive no DispatchContract, so no worker runtime
 * mediates nested Clio dispatch. A constant, not a lookup: there is nothing to
 * vary by runtime, and a parameter would imply otherwise.
 */
export interface AttestedToolIdentityInput {
	allowedTools: ReadonlyArray<ToolName>;
	helperResult?: true;
	/** False when the resolved runtime mediates no tool calls at all. */
	toolsSupported: boolean;
	toolProfile?: ToolProfileName;
	agentId?: string;
	task?: string;
	/**
	 * The resolved runtime. Its tool loop decides whether `gateway` rides on
	 * the surface, the same rule dispatch admission applies. Absent means a
	 * native runtime, which attaches it.
	 */
	runtime?: { readonly kind: string; readonly id: string };
}

/**
 * The effective tool signature a worker announces before model execution. The
 * orchestrator compares it against the surface the plan approved, so a worker
 * whose registry resolved a different tool set is refused rather than run.
 */
export function attestedToolSignature(input: AttestedToolIdentityInput): string {
	return toolSignatureOf(attestedToolNames(input));
}

/** The names `attestedToolSignature` signs, in the order the projection produced them. */
export function attestedToolNames(input: AttestedToolIdentityInput): string[] {
	if (!input.toolsSupported || input.allowedTools.length === 0) {
		return input.helperResult === true && input.toolsSupported ? [INTERNAL_HELPER_RESULT_TOOL] : [];
	}
	// This private registry only projects names. Preserve canonical registration
	// and extension verification without compiling an unused policy; executable
	// worker registries still construct their safety contract eagerly.
	let safety: SafetyContract | undefined;
	const resolveSafety = (): SafetyContract => (safety ??= createWorkerSafety());
	const registry = createWorkerToolRegistry(undefined, {
		classify: (call) => resolveSafety().classify(call),
		evaluate: (call, posture, scope) => resolveSafety().evaluate(call, posture, scope),
		observeLoop: (key, now) => resolveSafety().observeLoop(key, now),
		get scopes() {
			return resolveSafety().scopes;
		},
		isSubset: (worker, orchestrator) => resolveSafety().isSubset(worker, orchestrator),
		get policy() {
			// biome-ignore lint/style/noNonNullAssertion: createWorkerSafety always sets policy; the optional member is the contract shape, not this value.
			return resolveSafety().policy!;
		},
		get decisions() {
			return resolveSafety().decisions;
		},
	});
	const names = effectiveToolNames({
		registry,
		allowedTools: input.toolsSupported ? input.allowedTools : [],
		includeInteractiveTools: false,
		...(input.toolProfile !== undefined ? { toolProfile: input.toolProfile } : {}),
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.task !== undefined ? { task: input.task } : {}),
	});
	// The registry projection attaches `gateway` for any gateway-placed
	// capability it admits. An external agent loop is never offered it, and
	// dispatch admission leaves it off that surface, so the worker must too or
	// every such run is refused for tool surface drift (#449).
	const attachesGateway =
		input.runtime === undefined ||
		runtimeAttachesGateway(input.runtime) ||
		input.allowedTools.includes(ToolNames.Gateway);
	return [
		...(attachesGateway ? names : names.filter((name) => name !== ToolNames.Gateway)),
		...(input.helperResult === true && input.toolsSupported ? [INTERNAL_HELPER_RESULT_TOOL] : []),
	];
}

let schemaRegistry: ToolRegistry | undefined;

/**
 * Digest of the model-facing parameter schemas behind a signed name list. The name signature cannot see a tool whose
 * name stayed while its parameters changed (another build on a fleet node), so the worker announces this beside it and
 * the orchestrator computes it from its own build for the names it approved. Only built-in specs from a bare worker
 * registry are read: they are fixed per build, unlike node-local extension and MCP capabilities, which sit behind
 * `gateway`. A name without a registered spec, such as the helper result tool, hashes as null.
 */
export function attestedToolSchemaSignature(names: ReadonlyArray<string>): string {
	if (names.length === 0) return sha256Hex("clio-coder.toolSchemas:[]");
	schemaRegistry ??= createWorkerToolRegistry();
	const registry = schemaRegistry;
	const entries = [...new Set(names)].sort().map((name) => {
		const spec = registry.get(name as ToolName);
		return { name, parameters: spec ? wireParameterSchema(spec.modelParameters ?? spec.parameters) : null };
	});
	return sha256Hex(`clio-coder.toolSchemas:${canonicalJson(entries)}`);
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
