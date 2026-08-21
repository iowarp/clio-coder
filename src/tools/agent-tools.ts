/**
 * The one agent-tool adapter, owned by the tool registry.
 *
 * Converts Clio `ToolSpec` registrations into engine `AgentTool` instances the
 * agent can execute. Every wrapper routes through a `ToolRegistry.invoke(...)`
 * call so the orchestrator's chat loop and worker subprocesses share the same
 * safety + confirmation admission path instead of calling `spec.run(...)`
 * directly. Both surfaces resolve their tools here, so they cannot drift: the
 * executable surface and the attested tool signature are computed by the same
 * `effectiveToolNames` narrowing in this file.
 *
 * Validation runs exactly once per tool call. Inside the agent loop pi-ai's
 * `validateToolArguments` (called by pi-agent-core's `prepareToolCall`)
 * coerces and schema-checks args before they reach `AgentTool.execute`. For
 * direct callers (tests, scripts, future RPC paths) `invokeRegisteredTool`
 * validates first and then funnels into the same shared executor as the loop.
 */

import { performance } from "node:perf_hooks";
import type { TSchema } from "typebox";
import { type SkillActivation, skillActivationFromToolDetails } from "../core/skill-activation.js";
import type { ToolName } from "../core/tool-names.js";
import { ToolNames } from "../core/tool-names.js";
import type { ResolvedRuntimeTarget } from "../domains/providers/index.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { formatModelRejection } from "../domains/safety/rejection-feedback.js";
import { validateEngineToolArguments } from "../engine/ai.js";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../engine/types.js";
import { applyToolProfile, type ToolProfileName } from "./profiles.js";
import type { ToolInvokeOptions, ToolRegistry, ToolResult, ToolSpec } from "./registry.js";
import { isDispositionedToolResultError, toolResultContextText } from "./result-disposition.js";

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
	/**
	 * Wall-clock anchor for the instant the call began, for a human correlating
	 * it against other records. It is stamped by whichever process ran the tool,
	 * so it is never an endpoint for a span: `durationMs` on the matching finish
	 * event is measured on that process's monotonic clock instead.
	 */
	startedAt: number;
}

export interface ToolFinishEvent {
	tool: string;
	/**
	 * The engine's id for this call, when the caller supplied one through
	 * `invokeOptions`. Consumers that correlate this authoritative outcome back
	 * to an engine `tool_execution_end` event key on it: the engine event
	 * carries only `isError` plus result text, which cannot distinguish a
	 * permission block from a command that ran and exited nonzero.
	 */
	toolCallId?: string;
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

function projectToolResult(result: ToolResult): WorkerAgentToolResult {
	const details = { ...(result.details ?? {}), kind: result.kind } as { kind: "ok" } | { kind: "error" };
	if (result.kind === "error") {
		return { content: [{ type: "text", text: toolResultContextText(result) }], details };
	}
	return {
		content: [{ type: "text", text: toolResultContextText(result) }],
		details,
		...(result.terminate === true ? { terminate: true } : {}),
	};
}

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
	/** Agent loops can preserve canonical failure envelopes and classify them after execution. */
	returnDispositionedErrors?: boolean;
}

async function runValidatedToolCall(input: RunValidatedToolCallInput): Promise<WorkerAgentToolResult> {
	const { spec, args, registry, signal, telemetry } = input;
	// Wall read anchors the instant the start event carries; the monotonic twin
	// spans the call, so `durationMs` survives a clock correction mid-tool.
	const startedAt = Date.now();
	const startedAtClock = performance.now();
	telemetry?.onStart?.({ tool: spec.name, posture: "operating", startedAt });
	// Stamped onto every finish event so a consumer can join this authoritative
	// outcome to the engine's `tool_execution_end` for the same call.
	const callId = input.invokeOptions?.toolCallId;
	const withCallId = callId === undefined ? {} : { toolCallId: callId };
	const invokeOpts: ToolInvokeOptions = {};
	if (input.invokeOptions) Object.assign(invokeOpts, input.invokeOptions);
	if (signal) invokeOpts.signal = signal;
	// The registry parks a call that needs an operator decision inside this
	// invocation, so the span below covers the operator as well as the tool.
	// Subtracting the park keeps `durationMs` a measurement of the tool: an
	// approved `npm test` was rendered as a 56s test run and sealed into the
	// receipt and toolStats that way, when the command itself took a fraction
	// of a second.
	let parkedMs = 0;
	const callerOnParked = invokeOpts.onParked;
	invokeOpts.onParked = (ms) => {
		parkedMs += ms;
		callerOnParked?.(ms);
	};
	const executedMs = (): number => Math.max(0, Math.round(performance.now() - startedAtClock) - parkedMs);
	const hasInvokeOpts = Object.keys(invokeOpts).length > 0;
	let verdictPromise: ReturnType<typeof registry.invoke>;
	try {
		verdictPromise = registry.invoke({ tool: spec.name, args }, hasInvokeOpts ? invokeOpts : undefined);
	} catch (err) {
		emitFinish(telemetry, spec.name, executedMs, "error", { ...withCallId, reason: errorMessage(err) });
		throw err;
	}
	let verdict: Awaited<typeof verdictPromise>;
	try {
		verdict = await verdictPromise;
	} catch (err) {
		emitFinish(telemetry, spec.name, executedMs, "error", { ...withCallId, reason: errorMessage(err) });
		throw err;
	}
	if (verdict.kind !== "ok") {
		emitFinish(telemetry, spec.name, executedMs, "blocked", {
			...withCallId,
			reason: verdict.reason,
			...(verdict.kind === "blocked" ? { decision: verdict.decision } : {}),
		});
		// The model sees only this thrown message. The short verdict reason
		// starves the next turn of the policy's why and how-to-recover, so
		// compose the rejection detail and hints into the tool error; the
		// telemetry event above keeps the terse reason for receipts and UI.
		const rejection =
			verdict.kind === "blocked" && "rejection" in verdict.decision ? verdict.decision.rejection : undefined;
		throw new Error(formatModelRejection(verdict.reason, rejection));
	}
	if (verdict.result.kind === "error") {
		emitFinish(telemetry, spec.name, executedMs, "error", {
			...withCallId,
			reason: verdict.result.message,
			decision: verdict.decision,
		});
		if (input.returnDispositionedErrors === true && isDispositionedToolResultError(verdict.result)) {
			return projectToolResult(verdict.result);
		}
		throw new Error(toolResultContextText(verdict.result));
	}
	const toolDetails = isRecord(verdict.result.details) ? verdict.result.details : {};
	const skillActivation =
		spec.name === ToolNames.Context ? skillActivationFromToolDetails(toolDetails, input.invokeOptions?.turnId) : null;
	const result: AgentToolResult<WorkerToolOkDetails> = {
		content: [{ type: "text", text: toolResultContextText(verdict.result) }],
		details: { ...toolDetails, kind: "ok" },
	};
	if (verdict.result.terminate === true) {
		result.terminate = true;
		emitFinish(telemetry, spec.name, executedMs, "ok", {
			...withCallId,
			terminate: true,
			decision: verdict.decision,
			...(skillActivation ? { skillActivation } : {}),
		});
	} else {
		emitFinish(telemetry, spec.name, executedMs, "ok", {
			...withCallId,
			decision: verdict.decision,
			...(skillActivation ? { skillActivation } : {}),
		});
	}
	return result;
}

function emitFinish(
	telemetry: ToolTelemetry | undefined,
	tool: string,
	executedMs: () => number,
	outcome: ToolOutcome,
	extra?: {
		reason?: string;
		terminate?: boolean;
		decision?: SafetyDecision;
		skillActivation?: SkillActivation;
		toolCallId?: string;
	},
): void {
	if (!telemetry?.onFinish) return;
	const event: ToolFinishEvent = {
		tool,
		posture: "operating",
		durationMs: executedMs(),
		outcome,
	};
	if (extra?.toolCallId !== undefined) event.toolCallId = extra.toolCallId;
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
	} else if (outcome === "blocked") {
		// A blocked verdict that carries no admission decision (not_visible) is
		// still a safety block. Receipts count safety.decisions from this field,
		// so a blocked attempt must never land without a blocked decision.
		event.decision = "blocked";
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
		async execute(
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback,
		): Promise<WorkerAgentToolResult> {
			const options = invokeOptions?.() ?? {};
			if (toolCallId.length > 0) options.toolCallId = toolCallId;
			if (onUpdate !== undefined) {
				options.onUpdate = (partialResult) => onUpdate(projectToolResult(partialResult));
			}
			const callInput: RunValidatedToolCallInput = {
				spec,
				args: params as Record<string, unknown>,
				registry,
				returnDispositionedErrors: true,
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
	const specs: ToolSpec[] = [];
	for (const name of effectiveToolNames(input)) {
		const spec = input.registry.get(name);
		if (spec) specs.push(spec);
	}
	specs.sort((a, b) => a.name.localeCompare(b.name));
	return specs.map((spec) => toAgentTool(spec, input.registry, input.telemetry, input.invokeOptions));
}

/**
 * The effective tool surface for one worker run, as names. This is the single
 * narrowing used both to build the executable tool set and to compute the
 * signature the worker attests, so an attested identity can never describe a
 * different surface than the one the agent actually gets.
 */
export function effectiveToolNames(input: Omit<ResolveAgentToolsInput, "telemetry" | "invokeOptions">): ToolName[] {
	const profileContext = {
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.task !== undefined ? { task: input.task } : {}),
	};
	const toolIds = applyToolProfile(input.registry.listRegistered(), input.toolProfile, profileContext);
	const allowed = input.allowedTools ? new Set<string>(input.allowedTools) : null;
	const includeInteractiveTools = input.includeInteractiveTools !== false;
	const names: ToolName[] = [];
	for (const name of new Set(toolIds)) {
		// Orchestrator-only tools. Workers resolve their full surface once at
		// admission, so neither operator interviews nor self-activation apply.
		if (!includeInteractiveTools && name === ToolNames.AskUser) continue;
		if (allowed && !allowed.has(name)) continue;
		names.push(name);
	}
	return names;
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
export async function invokeRegisteredTool(
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

/**
 * The orchestrator's session tool surface: the full resolved surface when the
 * resolved runtime mediates tool calls, nothing otherwise. Deterministic and
 * identical on every submit so the serialized tool schemas stay byte-stable
 * for provider prefix caching. Per-tool gating (pending-skill policy, safety)
 * happens at invoke time, inside the same admission path workers use.
 */
export function resolveSessionTools(
	runtime: { runtimeResolution: ResolvedRuntimeTarget },
	toolRegistry: ToolRegistry | undefined,
	invokeOptions?: () => Partial<ToolInvokeOptions>,
	telemetry?: ToolTelemetry,
): AgentTool[] {
	if (!toolRegistry || runtime.runtimeResolution.capabilityDecisions.tools !== true) return [];
	const input: ResolveAgentToolsInput = { registry: toolRegistry };
	if (invokeOptions) input.invokeOptions = invokeOptions;
	if (telemetry) input.telemetry = telemetry;
	return resolveAgentTools(input);
}
