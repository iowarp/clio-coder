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
import {
	createLoopState,
	type LoopDetectorState,
	type LoopVerdict,
	observe as observeLoopState,
} from "../domains/safety/loop-detector.js";
import { createSafetyPolicyEngine } from "../domains/safety/policy-engine.js";
import { DEFAULT_SCOPE, isSubset, READONLY_SCOPE, SUPER_SCOPE } from "../domains/safety/scope.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { applyToolProfile, type ToolProfileName } from "../tools/profiles.js";
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
	actionClass?: string;
	decision?: "allowed" | "blocked" | "elevated";
	ruleId?: string;
	reasonCode?: string;
	policySource?: string;
}

export interface ResolveAgentToolsInput {
	registry: ToolRegistry;
	allowedTools?: ReadonlyArray<ToolName>;
	mode: ModeName;
	toolProfile?: ToolProfileName;
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
		emitFinish(telemetry, spec.name, mode, startedAt, "blocked", {
			reason: verdict.reason,
			...(verdict.kind === "blocked" ? { decision: verdict.decision } : {}),
		});
		throw new Error(verdict.reason);
	}
	if (verdict.result.kind === "error") {
		emitFinish(telemetry, spec.name, mode, startedAt, "error", {
			reason: verdict.result.message,
			decision: verdict.decision,
		});
		throw new Error(verdict.result.message);
	}
	const toolDetails = isRecord(verdict.result.details) ? verdict.result.details : {};
	const result: AgentToolResult<WorkerToolOkDetails> = {
		content: [{ type: "text", text: verdict.result.output }],
		details: { ...toolDetails, kind: "ok" },
	};
	if (verdict.result.terminate === true) {
		result.terminate = true;
		emitFinish(telemetry, spec.name, mode, startedAt, "ok", { terminate: true, decision: verdict.decision });
	} else {
		emitFinish(telemetry, spec.name, mode, startedAt, "ok", { decision: verdict.decision });
	}
	return result;
}

function emitFinish(
	telemetry: ToolTelemetry | undefined,
	tool: string,
	mode: ModeName,
	startedAt: number,
	outcome: ToolOutcome,
	extra?: { reason?: string; terminate?: boolean; decision?: SafetyDecision },
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
	if (extra?.decision !== undefined) {
		event.actionClass = extra.decision.classification.actionClass;
		event.decision = extra.decision.kind === "allow" ? "allowed" : extra.decision.kind === "ask" ? "elevated" : "blocked";
		if (extra.decision.policy?.ruleId !== undefined) event.ruleId = extra.decision.policy.ruleId;
		if (extra.decision.policy?.reasonCode !== undefined) event.reasonCode = extra.decision.policy.reasonCode;
		if (extra.decision.policy?.policySource !== undefined) event.policySource = extra.decision.policy.policySource;
	}
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
		evaluate(call, mode) {
			const policy = policyEngine.evaluate(call, mode);
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
				if (policy.elevationMode !== undefined) decision.elevationMode = policy.elevationMode;
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
		scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, super: SUPER_SCOPE },
		isSubset,
		policy: { metadata: (mode) => policyEngine.metadata(mode) },
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

/**
 * Stable canonical JSON serializer used to fingerprint tool arguments for the
 * loop detector. Sorts object keys, drops `undefined`, encodes sparse array
 * holes as `null`, serializes Date values through their JSON representation,
 * and rejects non-finite numbers, circular references, and bigint/symbol/function
 * values. Matches the prompts/hash.ts contract closely enough for hashing,
 * inlined here so worker code does not import a sibling domain.
 */
export function canonicalJson(value: unknown): string {
	if (value === undefined) {
		throw new Error("canonicalJson: undefined is not representable at root");
	}
	return canonicalSerialize(value, new WeakSet<object>());
}

function canonicalSerialize(value: unknown, seen: WeakSet<object>): string {
	if (value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`canonicalJson: non-finite number ${String(value)} is not representable`);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "bigint") {
		throw new Error("canonicalJson: bigint is not representable");
	}
	if (typeof value === "symbol" || typeof value === "function") {
		throw new Error(`canonicalJson: ${typeof value} is not representable`);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error("canonicalJson: circular reference is not representable");
		seen.add(value);
		try {
			const parts: string[] = [];
			for (let i = 0; i < value.length; i++) {
				if (!(i in value) || value[i] === undefined) {
					parts.push("null");
					continue;
				}
				parts.push(canonicalSerialize(value[i], seen));
			}
			return `[${parts.join(",")}]`;
		} finally {
			seen.delete(value);
		}
	}
	if (typeof value === "object") {
		if (value instanceof Date) {
			const jsonValue = value.toJSON();
			return jsonValue === null ? "null" : JSON.stringify(jsonValue);
		}
		if (seen.has(value)) throw new Error("canonicalJson: circular reference is not representable");
		seen.add(value);
		const obj = value as Record<string, unknown>;
		try {
			const keys = Object.keys(obj).sort();
			const parts: string[] = [];
			for (const key of keys) {
				const child = obj[key];
				if (child === undefined) continue;
				parts.push(`${JSON.stringify(key)}:${canonicalSerialize(child, seen)}`);
			}
			return `{${parts.join(",")}}`;
		} finally {
			seen.delete(value);
		}
	}
	throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

/** Compute a stable fingerprint from a tool name plus its arguments. */
export function hashToolCall(tool: string, args: unknown): string {
	let argPart: string;
	try {
		argPart = canonicalJson(args ?? {});
	} catch {
		// Fall back to a tool-only fingerprint when args contain non-serializable
		// values (e.g. functions). The detector still triggers when the tool name
		// alone repeats, which matches the user-visible failure mode.
		argPart = "<unrepresentable>";
	}
	return `${tool}${argPart}`;
}

/** Default per-turn tool-call cap when the env var is unset or invalid. */
export const DEFAULT_MAX_TOOL_CALLS = 50;
/** Environment variable that overrides the per-turn tool-call cap. */
export const MAX_TOOL_CALLS_ENV = "CLIO_MAX_TOOL_CALLS";
/**
 * Sliding window length used by the loop detector. Mirrors the default in
 * src/domains/safety/loop-detector.ts; surfaced here so the block reason can
 * include the window without round-tripping through the verdict.
 */
const LOOP_DETECTOR_WINDOW_MS = createLoopState().windowMs;

function readToolCallCap(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[MAX_TOOL_CALLS_ENV];
	if (raw === undefined || raw === "") return DEFAULT_MAX_TOOL_CALLS;
	const normalized = raw.trim();
	if (!/^[1-9]\d*$/.test(normalized)) return DEFAULT_MAX_TOOL_CALLS;
	const parsed = Number(normalized);
	if (!Number.isSafeInteger(parsed)) return DEFAULT_MAX_TOOL_CALLS;
	return parsed;
}

export interface WorkerLoopGuardDecision {
	block: boolean;
	reason?: string;
}

export interface WorkerLoopGuard {
	/**
	 * Inspect a pending tool call. When the loop detector flags repetition or
	 * the per-turn iteration cap is reached, returns `{ block: true, reason }`
	 * so the agent loop can feed the reason back to the model as a tool error.
	 */
	check(tool: string, args: unknown, now?: number): WorkerLoopGuardDecision;
	/** Read-only counters for tests and telemetry. */
	readonly count: () => number;
	readonly cap: number;
}

export interface CreateWorkerLoopGuardOptions {
	safety: SafetyContract;
	cap?: number;
	env?: NodeJS.ProcessEnv;
}

/**
 * Per-worker-run loop guard. Combines the safety contract's loop detector
 * (sliding-window repetition) with a hard tool-call cap so a degenerate model
 * cannot burn through the run by spamming distinct calls.
 */
export function createWorkerLoopGuard(opts: CreateWorkerLoopGuardOptions): WorkerLoopGuard {
	const cap = opts.cap ?? readToolCallCap(opts.env);
	let count = 0;
	return {
		check(tool, args, now): WorkerLoopGuardDecision {
			count += 1;
			if (count > cap) {
				return {
					block: true,
					reason: `tool-call cap reached (${cap}); abort turn`,
				};
			}
			const key = hashToolCall(tool, args);
			const verdict: LoopVerdict = opts.safety.observeLoop(key, now ?? Date.now());
			if (verdict.looping) {
				return {
					block: true,
					reason: `loop detected: tool '${tool}' repeated ${verdict.count} times in ${LOOP_DETECTOR_WINDOW_MS}ms; try a different approach`,
				};
			}
			return { block: false };
		},
		count: () => count,
		cap,
	};
}

export function createWorkerToolRegistry(
	mode: ModeName,
	middlewareSnapshot?: MiddlewareSnapshot,
	safety: SafetyContract = createWorkerSafety(),
): ToolRegistry {
	const registry = createRegistry({
		safety,
		modes: createWorkerModes(mode),
		...(middlewareSnapshot ? { middleware: createMiddlewareContractFromSnapshot(middlewareSnapshot) } : {}),
	});
	registerAllTools(registry);
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
	const modeIds = new Set(applyToolProfile(input.registry.listForMode(input.mode), input.toolProfile));
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
