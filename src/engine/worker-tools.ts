/**
 * Worker-subprocess tool resolver.
 *
 * Converts Clio `ToolSpec` registrations into pi-agent-core `AgentTool`
 * instances the agent can execute. Every wrapper routes through a
 * `ToolRegistry.invoke(...)` call so interactive and worker runs share the
 * same safety + confirmation admission path instead of calling `spec.run(...)`
 * directly.
 *
 * Validation runs exactly once per tool call. Inside the agent loop pi-ai's
 * `validateToolArguments` (called by pi-agent-core's `prepareToolCall`)
 * coerces and schema-checks args before they reach `AgentTool.execute`. For
 * direct callers (tests, scripts, future RPC paths) `invokeWorkerTool`
 * validates first and then funnels into the same shared executor as the loop.
 */

import type { TSchema } from "typebox";
import { type SkillActivation, skillActivationFromToolDetails } from "../core/skill-activation.js";
import type { ToolName } from "../core/tool-names.js";
import { ToolNames } from "../core/tool-names.js";
import {
	createMiddlewareContractFromSnapshot,
	type MiddlewareHookRegistration,
	type MiddlewareSnapshot,
} from "../domains/middleware/index.js";
import { classify as classifyAction } from "../domains/safety/action-classifier.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import {
	createLoopState,
	type LoopDetectorState,
	observe as observeLoopState,
} from "../domains/safety/loop-detector.js";
import { createSafetyPolicyEngine } from "../domains/safety/policy-engine.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../domains/safety/scope.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { applyToolProfile, type ToolProfileName } from "../tools/profiles.js";
import { createRegistry, type ToolInvokeOptions, type ToolRegistry, type ToolSpec } from "../tools/registry.js";
import { validateEngineToolArguments } from "./ai.js";
import type { AgentTool, AgentToolResult } from "./types.js";

/**
 * Lightweight per-call observability hook. Default no-op so unused
 * telemetry costs nothing. Both the agent loop path and `invokeWorkerTool`
 * emit identical events, which lets receipts/profiling consume one stream
 * regardless of how the tool was reached.
 */
export interface ToolTelemetry {
	onStart?(event: ToolStartEvent): void;
	onFinish?(event: ToolFinishEvent): void;
}

export type ToolOutcome = "ok" | "error" | "blocked";

export interface ToolStartEvent {
	tool: string;
	posture: "operating";
	startedAt: number;
}

export interface ToolFinishEvent {
	tool: string;
	posture: "operating";
	durationMs: number;
	outcome: ToolOutcome;
	terminate?: boolean;
	reason?: string;
	actionClass?: string;
	decision?: "allowed" | "blocked" | "permission_requested";
	ruleId?: string;
	reasonCode?: string;
	policySource?: string;
	skillActivation?: SkillActivation;
}

export interface ResolveAgentToolsInput {
	registry: ToolRegistry;
	allowedTools?: ReadonlyArray<ToolName>;
	toolProfile?: ToolProfileName;
	agentId?: string;
	task?: string;
	telemetry?: ToolTelemetry;
	invokeOptions?: () => Partial<ToolInvokeOptions>;
	includeInteractiveTools?: boolean;
}

export interface InvokeWorkerToolOptions {
	signal?: AbortSignal;
	telemetry?: ToolTelemetry;
}

type WorkerAgentToolResult = AgentToolResult<{ kind: "ok" } | { kind: "error" }>;
type WorkerToolOkDetails = { kind: "ok" } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RunValidatedToolCallInput {
	spec: ToolSpec;
	args: Record<string, unknown>;
	registry: ToolRegistry;
	signal?: AbortSignal;
	telemetry?: ToolTelemetry;
	invokeOptions?: Partial<ToolInvokeOptions>;
}

async function runValidatedToolCall(input: RunValidatedToolCallInput): Promise<WorkerAgentToolResult> {
	const { spec, args, registry, signal, telemetry } = input;
	const startedAt = Date.now();
	telemetry?.onStart?.({ tool: spec.name, posture: "operating", startedAt });
	const invokeOpts: ToolInvokeOptions = {};
	if (input.invokeOptions) Object.assign(invokeOpts, input.invokeOptions);
	if (signal) invokeOpts.signal = signal;
	const hasInvokeOpts = Object.keys(invokeOpts).length > 0;
	let verdictPromise: ReturnType<typeof registry.invoke>;
	try {
		verdictPromise = registry.invoke({ tool: spec.name, args }, hasInvokeOpts ? invokeOpts : undefined);
	} catch (err) {
		emitFinish(telemetry, spec.name, startedAt, "error", { reason: errorMessage(err) });
		throw err;
	}
	let verdict: Awaited<typeof verdictPromise>;
	try {
		verdict = await verdictPromise;
	} catch (err) {
		emitFinish(telemetry, spec.name, startedAt, "error", { reason: errorMessage(err) });
		throw err;
	}
	if (verdict.kind !== "ok") {
		emitFinish(telemetry, spec.name, startedAt, "blocked", {
			reason: verdict.reason,
			...(verdict.kind === "blocked" ? { decision: verdict.decision } : {}),
		});
		throw new Error(verdict.reason);
	}
	if (verdict.result.kind === "error") {
		emitFinish(telemetry, spec.name, startedAt, "error", {
			reason: verdict.result.message,
			decision: verdict.decision,
		});
		throw new Error(verdict.result.message);
	}
	const toolDetails = isRecord(verdict.result.details) ? verdict.result.details : {};
	const skillActivation =
		spec.name === ToolNames.ReadSkill ? skillActivationFromToolDetails(toolDetails, input.invokeOptions?.turnId) : null;
	const result: AgentToolResult<WorkerToolOkDetails> = {
		content: [{ type: "text", text: verdict.result.output }],
		details: { ...toolDetails, kind: "ok" },
	};
	if (verdict.result.terminate === true) {
		result.terminate = true;
		emitFinish(telemetry, spec.name, startedAt, "ok", {
			terminate: true,
			decision: verdict.decision,
			...(skillActivation ? { skillActivation } : {}),
		});
	} else {
		emitFinish(telemetry, spec.name, startedAt, "ok", {
			decision: verdict.decision,
			...(skillActivation ? { skillActivation } : {}),
		});
	}
	return result;
}

function emitFinish(
	telemetry: ToolTelemetry | undefined,
	tool: string,
	startedAt: number,
	outcome: ToolOutcome,
	extra?: { reason?: string; terminate?: boolean; decision?: SafetyDecision; skillActivation?: SkillActivation },
): void {
	if (!telemetry?.onFinish) return;
	const event: ToolFinishEvent = {
		tool,
		posture: "operating",
		durationMs: Date.now() - startedAt,
		outcome,
	};
	if (extra?.reason !== undefined) event.reason = extra.reason;
	if (extra?.terminate === true) event.terminate = true;
	if (extra?.decision !== undefined) {
		event.actionClass = extra.decision.classification.actionClass;
		const permissionWasRequired =
			outcome === "blocked" &&
			(extra.decision.kind === "ask" ||
				(extra.decision.kind === "allow" && extra.decision.classification.actionClass === "system_modify"));
		event.decision = permissionWasRequired
			? "permission_requested"
			: extra.decision.kind === "allow"
				? "allowed"
				: extra.decision.kind === "ask"
					? "permission_requested"
					: "blocked";
		if (extra.decision.policy?.ruleId !== undefined) event.ruleId = extra.decision.policy.ruleId;
		if (extra.decision.policy?.reasonCode !== undefined) event.reasonCode = extra.decision.policy.reasonCode;
		if (extra.decision.policy?.policySource !== undefined) event.policySource = extra.decision.policy.policySource;
	}
	if (extra?.skillActivation !== undefined) {
		event.skillActivation = extra.skillActivation;
	}
	telemetry.onFinish(event);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function toAgentTool(
	spec: ToolSpec,
	registry: ToolRegistry,
	telemetry: ToolTelemetry | undefined,
	invokeOptions: (() => Partial<ToolInvokeOptions>) | undefined,
): AgentTool<TSchema> {
	const tool: AgentTool<TSchema> = {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		label: spec.metadata?.uiLabel ?? spec.name,
		async execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<WorkerAgentToolResult> {
			const options = invokeOptions?.() ?? {};
			if (toolCallId.length > 0) options.toolCallId = toolCallId;
			const callInput: RunValidatedToolCallInput = {
				spec,
				args: params as Record<string, unknown>,
				registry,
			};
			if (signal) callInput.signal = signal;
			if (telemetry) callInput.telemetry = telemetry;
			if (Object.keys(options).length > 0) callInput.invokeOptions = options;
			return runValidatedToolCall(callInput);
		},
	};
	if (spec.executionMode) tool.executionMode = spec.executionMode;
	return tool;
}

/**
 * Build a worker-local SafetyContract that owns its own loop-detector state.
 * The state is per-worker-run (one subprocess per run) so two concurrent
 * workers do not share counts. The detector matches the orchestrator's
 * behaviour but skips audit-record bookkeeping which the worker does not own.
 */
export function createWorkerSafety(options: { cwd?: string } = {}): SafetyContract {
	let loopState: LoopDetectorState = createLoopState();
	const policyEngine = createSafetyPolicyEngine(options);
	return {
		classify: (call) => classifyAction(call),
		evaluate(call, posture) {
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
): ToolRegistry {
	// A worker always gets a middleware contract, even without a snapshot from
	// the orchestrator, because the loop guard rides on it as a before_tool
	// registration. An empty snapshot evaluates no declarative rules, matching
	// the former no-middleware behavior.
	const middleware = createMiddlewareContractFromSnapshot(middlewareSnapshot ?? { version: 1, rules: [] });
	for (const registration of hookRegistrations ?? []) {
		middleware.registerHook(registration);
	}
	const registry = createRegistry({ safety, middleware });
	registerAllTools(registry, {
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
 * Build the AgentTool array the agent should expose. Caller supplies the
 * registered tool set plus:
 *
 *   1. the explicit `allowedTools` list (typically from the agent recipe)
 *   2. an optional `telemetry` sink for `onStart`/`onFinish` events
 *
 * The returned tool set is the intersection of:
 *   1. tools registered on the supplied registry
 *   2. tools whose id appears in `allowedTools`
 *
 * When `allowedTools` is undefined, step 3 is skipped.
 */
export function resolveAgentTools(input: ResolveAgentToolsInput): AgentTool[] {
	const profileContext = {
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.task !== undefined ? { task: input.task } : {}),
	};
	const toolIds = new Set(applyToolProfile(input.registry.listRegistered(), input.toolProfile, profileContext));
	const allowed = input.allowedTools ? new Set(input.allowedTools) : null;
	const includeInteractiveTools = input.includeInteractiveTools !== false;
	const specs: ToolSpec[] = [];
	for (const name of toolIds) {
		// Orchestrator-only tools. Workers resolve their full surface once at
		// admission, so neither operator interviews nor self-activation apply.
		if (!includeInteractiveTools && name === ToolNames.AskUser) continue;
		if (allowed && !allowed.has(name)) continue;
		const spec = input.registry.get(name);
		if (spec) specs.push(spec);
	}
	specs.sort((a, b) => a.name.localeCompare(b.name));
	return specs.map((spec) =>
		toAgentTool(spec, input.registry, input.telemetry, input.invokeOptions),
	) as unknown as AgentTool[];
}

/**
 * Direct invocation entry point. Use this when calling a registered tool
 * from outside the agent loop (tests, scripts, RPC). Validates and coerces
 * `rawArgs` once via pi-ai's `validateToolArguments`, then runs the same
 * shared executor that `AgentTool.execute` uses inside the loop.
 *
 * The result mirrors the AgentToolResult an agent would observe; thrown
 * errors mirror the loop's behavior on a blocked or errored verdict.
 */
export async function invokeWorkerTool(
	registry: ToolRegistry,
	toolName: ToolName,
	rawArgs: unknown,
	opts?: InvokeWorkerToolOptions,
): Promise<WorkerAgentToolResult> {
	const spec = registry.get(toolName);
	if (!spec) throw new Error(`tool ${toolName} not registered`);
	const validated = validateEngineToolArguments(
		{ name: spec.name, description: spec.description, parameters: spec.parameters },
		{ type: "toolCall", id: "", name: spec.name, arguments: rawArgs as Record<string, unknown> },
	) as Record<string, unknown>;
	const callInput: RunValidatedToolCallInput = {
		spec,
		args: validated,
		registry,
	};
	if (opts?.signal) callInput.signal = opts.signal;
	if (opts?.telemetry) callInput.telemetry = opts.telemetry;
	return runValidatedToolCall(callInput);
}
