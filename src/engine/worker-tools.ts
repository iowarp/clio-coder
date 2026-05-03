/**
 * Worker-subprocess tool resolver.
 *
 * Converts Clio `ToolSpec` registrations into pi-agent-core `AgentTool`
 * instances the agent can execute. Every wrapper routes through a
 * `ToolRegistry.invoke(...)` call so interactive and worker runs share the
 * same safety + mode admission path instead of calling `spec.run(...)`
 * directly.
 *
 * Validation runs exactly once per tool call. Inside the agent loop pi-ai's
 * `validateToolArguments` (called by pi-agent-core's `prepareToolCall`)
 * coerces and schema-checks args before they reach `AgentTool.execute`. For
 * direct callers (tests, scripts, future RPC paths) `invokeWorkerTool`
 * validates first and then funnels into the same shared executor as the loop.
 */

import type { TSchema } from "typebox";
import type { ToolName } from "../core/tool-names.js";
import { createMiddlewareContractFromSnapshot, type MiddlewareSnapshot } from "../domains/middleware/index.js";
import type { ModesContract } from "../domains/modes/contract.js";
import { MODE_MATRIX, type ModeName } from "../domains/modes/matrix.js";
import { classify as classifyAction } from "../domains/safety/action-classifier.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import { formatRejection } from "../domains/safety/rejection-feedback.js";
import { DEFAULT_SCOPE, isSubset, READONLY_SCOPE, SUPER_SCOPE } from "../domains/safety/scope.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../tools/registry.js";
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
	mode: ModeName;
	startedAt: number;
}

export interface ToolFinishEvent {
	tool: string;
	mode: ModeName;
	durationMs: number;
	outcome: ToolOutcome;
	terminate?: boolean;
	reason?: string;
}

export type WorkerToolRegistrar = (registry: ToolRegistry) => void;

export interface ResolveAgentToolsInput {
	registry: ToolRegistry;
	allowedTools?: ReadonlyArray<ToolName>;
	mode: ModeName;
	telemetry?: ToolTelemetry;
}

export interface InvokeWorkerToolOptions {
	signal?: AbortSignal;
	telemetry?: ToolTelemetry;
	mode?: ModeName;
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
	mode: ModeName;
	signal?: AbortSignal;
	telemetry?: ToolTelemetry;
}

async function runValidatedToolCall(input: RunValidatedToolCallInput): Promise<WorkerAgentToolResult> {
	const { spec, args, registry, mode, signal, telemetry } = input;
	const startedAt = Date.now();
	telemetry?.onStart?.({ tool: spec.name, mode, startedAt });
	const invokeOpts = signal ? { signal } : undefined;
	let verdictPromise: ReturnType<typeof registry.invoke>;
	try {
		verdictPromise = registry.invoke({ tool: spec.name, args }, invokeOpts);
	} catch (err) {
		emitFinish(telemetry, spec.name, mode, startedAt, "error", { reason: errorMessage(err) });
		throw err;
	}
	let verdict: Awaited<typeof verdictPromise>;
	try {
		verdict = await verdictPromise;
	} catch (err) {
		emitFinish(telemetry, spec.name, mode, startedAt, "error", { reason: errorMessage(err) });
		throw err;
	}
	if (verdict.kind !== "ok") {
		emitFinish(telemetry, spec.name, mode, startedAt, "blocked", { reason: verdict.reason });
		throw new Error(verdict.reason);
	}
	if (verdict.result.kind === "error") {
		emitFinish(telemetry, spec.name, mode, startedAt, "error", { reason: verdict.result.message });
		throw new Error(verdict.result.message);
	}
	const toolDetails = isRecord(verdict.result.details) ? verdict.result.details : {};
	const result: AgentToolResult<WorkerToolOkDetails> = {
		content: [{ type: "text", text: verdict.result.output }],
		details: { ...toolDetails, kind: "ok" },
	};
	if (verdict.result.terminate === true) {
		result.terminate = true;
		emitFinish(telemetry, spec.name, mode, startedAt, "ok", { terminate: true });
	} else {
		emitFinish(telemetry, spec.name, mode, startedAt, "ok");
	}
	return result;
}

function emitFinish(
	telemetry: ToolTelemetry | undefined,
	tool: string,
	mode: ModeName,
	startedAt: number,
	outcome: ToolOutcome,
	extra?: { reason?: string; terminate?: boolean },
): void {
	if (!telemetry?.onFinish) return;
	const event: ToolFinishEvent = {
		tool,
		mode,
		durationMs: Date.now() - startedAt,
		outcome,
	};
	if (extra?.reason !== undefined) event.reason = extra.reason;
	if (extra?.terminate === true) event.terminate = true;
	telemetry.onFinish(event);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function toAgentTool(
	spec: ToolSpec,
	registry: ToolRegistry,
	mode: ModeName,
	telemetry: ToolTelemetry | undefined,
): AgentTool<TSchema> {
	const tool: AgentTool<TSchema> = {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		label: spec.name,
		async execute(_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<WorkerAgentToolResult> {
			const callInput: RunValidatedToolCallInput = {
				spec,
				args: params as Record<string, unknown>,
				registry,
				mode,
			};
			if (signal) callInput.signal = signal;
			if (telemetry) callInput.telemetry = telemetry;
			return runValidatedToolCall(callInput);
		},
	};
	if (spec.executionMode) tool.executionMode = spec.executionMode;
	return tool;
}

function createWorkerModes(mode: ModeName): ModesContract {
	const profile = MODE_MATRIX[mode];
	return {
		current: () => mode,
		setMode: () => mode,
		cycleNormal: () => mode,
		visibleTools: () => profile.tools,
		isToolVisible: (tool) => profile.tools.has(tool),
		isActionAllowed: (action) => profile.allowedActions.has(action),
		requestSuper: () => {},
		confirmSuper: () => mode,
		// Workers have no Alt+S pathway; parking requires interactive
		// confirmation. Returning null forces the registry to reject
		// mode-gate blocks synchronously.
		elevatedModeFor: () => null,
	};
}

function createWorkerSafety(): SafetyContract {
	return {
		classify: (call) => classifyAction(call),
		evaluate(call, mode) {
			const classification = classifyAction(call);
			if (classification.actionClass === "git_destructive") {
				const rejection = formatRejection({
					tool: call.tool,
					actionClass: classification.actionClass,
					reasons: classification.reasons,
					...(mode ? { mode } : {}),
				});
				return { kind: "block", classification, rejection };
			}
			const decision: SafetyDecision = { kind: "allow", classification };
			return decision;
		},
		observeLoop: (key) => ({ looping: false, key, count: 1 }),
		scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, super: SUPER_SCOPE },
		isSubset,
		audit: { recordCount: () => 0 },
	};
}

export function createWorkerToolRegistry(
	mode: ModeName,
	middlewareSnapshot?: MiddlewareSnapshot,
	registerPrivateTools?: WorkerToolRegistrar,
): ToolRegistry {
	const registry = createRegistry({
		safety: createWorkerSafety(),
		modes: createWorkerModes(mode),
		...(middlewareSnapshot ? { middleware: createMiddlewareContractFromSnapshot(middlewareSnapshot) } : {}),
	});
	registerAllTools(registry);
	registerPrivateTools?.(registry);
	return registry;
}

/**
 * Build the AgentTool array the agent should expose. Caller supplies the
 * registered tool set plus:
 *
 *   1. the explicit `allowedTools` list (typically from the agent recipe)
 *   2. the active `mode`
 *   3. an optional `telemetry` sink for `onStart`/`onFinish` events
 *
 * The returned tool set is the intersection of:
 *   1. tools registered on the supplied registry
 *   2. tools whose allowedModes admits `mode`
 *   3. tools whose id appears in `allowedTools`
 *
 * When `allowedTools` is undefined, step 3 is skipped.
 */
export function resolveAgentTools(input: ResolveAgentToolsInput): AgentTool[] {
	const modeIds = new Set(input.registry.listForMode(input.mode));
	const allowed = input.allowedTools ? new Set(input.allowedTools) : null;
	const specs: ToolSpec[] = [];
	for (const name of modeIds) {
		if (allowed && !allowed.has(name)) continue;
		const spec = input.registry.get(name);
		if (spec) specs.push(spec);
	}
	return specs.map((spec) => toAgentTool(spec, input.registry, input.mode, input.telemetry)) as unknown as AgentTool[];
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
		mode: opts?.mode ?? "default",
	};
	if (opts?.signal) callInput.signal = opts.signal;
	if (opts?.telemetry) callInput.telemetry = opts.telemetry;
	return runValidatedToolCall(callInput);
}
