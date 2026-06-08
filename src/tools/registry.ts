import type { TSchema } from "typebox";
import { type SkillActivation, skillActivationFromToolDetails } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import type { MiddlewareContract } from "../domains/middleware/contract.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareMetadataValue } from "../domains/middleware/types.js";
import type { ModesContract } from "../domains/modes/contract.js";
import { MODE_MATRIX, type ModeName } from "../domains/modes/matrix.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import {
	classifyDestructiveCommand,
	detectValidationCommand,
	isProtectedPath,
	type ProtectedArtifact,
	type ProtectedArtifactState,
	protectArtifact,
} from "../domains/safety/protected-artifacts.js";
import { shapeToolResult } from "./result-shaping.js";

/**
 * Tool registry. Admission point for every tool call. Filters visible tools
 * by current mode, delegates classification + hard-block decisions to the
 * safety domain, then enforces the per-mode action-class policy gate before
 * running the tool body. Never throws on safety rejections; the caller (agent
 * loop in Phase 4) surfaces the rejection message back to the model.
 */

/**
 * Per-tool execution mode override forwarded to pi-agent-core's
 * `AgentTool.executionMode`. Parallel tools may run concurrently with other
 * parallel tool calls; sequential tools run one at a time and prevent any
 * other tool in the batch from running in parallel with them. Leaving this
 * undefined defers to the agent loop's global `toolExecution` setting.
 */
export type ToolExecutionMode = "sequential" | "parallel";
export type ToolSourceScope = "core" | "domain";
export type ToolRetrySafety = "idempotent" | "retry_safe" | "not_retry_safe" | "unknown";
export type ToolCostLatencyClass = "local_fast" | "local_medium" | "local_slow" | "network" | "agent";

export interface ToolSourceInfo {
	path: string;
	scope: ToolSourceScope;
}

export interface ToolResultSizePolicy {
	kind: "exact" | "bounded" | "summary" | "truncate";
	maxBytes?: number;
	followUpHint?: string;
}

export interface ToolMetadata {
	/** Short statement of the tool's purpose for audit/UI surfaces. */
	objective: string;
	/** Stable UI label shown in compact renderers. */
	uiLabel: string;
	/** Whether automatic recovery may safely retry an unfinished call. */
	retrySafety: ToolRetrySafety;
	/** Expected result-size behavior at the registry boundary. */
	resultSizePolicy: ToolResultSizePolicy;
	/** Coarse cost/latency bucket for palette and dashboard diagnostics. */
	costLatency: ToolCostLatencyClass;
}

export interface ToolSpec {
	name: ToolName;
	description: string;
	sourceInfo?: ToolSourceInfo;
	metadata?: ToolMetadata;
	/**
	 * TypeBox schema advertised to the model so it knows which named
	 * parameters the tool accepts. Must be a Type.Object(...). Runtime
	 * validation still happens inside `run()`, so the schema is advisory
	 * to the model, not an enforcement boundary.
	 */
	parameters: TSchema;
	/** Base action class for this tool when arguments are trivial. */
	baseActionClass: ActionClass;
	/**
	 * Modes in which this tool is admissible. When undefined, every mode is
	 * allowed (the mode matrix remains authoritative for visibility). When set,
	 * `invoke` rejects with `not_visible` for any mode outside this list.
	 */
	allowedModes?: ReadonlyArray<ModeName>;
	/**
	 * Per-tool execution mode. Read-only tools set `"parallel"` so the model
	 * can batch scans; mutating or filesystem-racing tools set `"sequential"`
	 * so two `bash` or `edit` calls in the same batch never run concurrently.
	 */
	executionMode?: ToolExecutionMode;
	/** Execute the tool. Only called after admission. */
	run(args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ToolResult>;
}

export type ToolResultDetails = Record<string, unknown>;

export type ToolResult =
	| {
			kind: "ok";
			output: string;
			details?: ToolResultDetails;
			/**
			 * Early-termination hint propagated to pi-agent-core's
			 * `AgentToolResult.terminate`. When every finalized tool result in
			 * the current batch sets this to true, the agent loop stops without
			 * a follow-up LLM call. Used by terminal advise-mode writers
			 * (write_plan, write_review) where writing the artifact is the
			 * whole turn.
			 */
			terminate?: boolean;
	  }
	| { kind: "error"; message: string; details?: ToolResultDetails };

export interface RegistryDeps {
	safety: SafetyContract;
	modes: ModesContract;
	middleware?: MiddlewareContract;
	protectedArtifacts?: ProtectedArtifactState;
	onProtectedArtifactEvent?: (event: ProtectedArtifactRegistryEvent) => void;
	onSkillActivation?: (activation: SkillActivation) => void;
}

export interface ToolInvokeOptions {
	signal?: AbortSignal;
	runId?: string;
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	correlationId?: string;
}

export interface ProtectedArtifactRegistryEvent {
	kind: "protect";
	artifact: ProtectedArtifact;
	toolName: ToolName;
	runId?: string;
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	correlationId?: string;
}

/**
 * One-shot elevation grant. The interactive layer issues this when the user
 * confirms a single parked tool call without escalating the persistent mode.
 * The registry consumes the grant on the next `resumeParkedCalls` pass so
 * exactly one parked call receives elevated admission; subsequent calls go
 * back through the normal mode gate.
 */
export interface OneShotGrant {
	/** Mode used for the single admission pass. Equivalent of "as if current mode were this". */
	mode: ModeName;
	/** Free-form origin tag carried into audit (`tool`, `keybind:single`, ...). */
	requestedBy: string;
}

export interface ToolRegistry {
	register(spec: ToolSpec): void;
	/** Tools visible to the current mode. Models only see these. */
	listVisible(): ReadonlyArray<ToolSpec>;
	/** Tools registered overall, regardless of mode. For /audit, /doctor. */
	listAll(): ReadonlyArray<ToolSpec>;
	/** Lookup by tool id. */
	get(name: ToolName): ToolSpec | undefined;
	/**
	 * Tool names admissible in `mode`. A tool qualifies only when the mode
	 * matrix exposes it and its per-spec `allowedModes` permits that mode.
	 * Workers use this primitive to resolve per-run tools without a live
	 * ModesContract, so the matrix must stay authoritative here too.
	 */
	listForMode(mode: ModeName): ReadonlyArray<ToolName>;
	/**
	 * Admission point. Classifies, evaluates safety, and either runs or
	 * returns a rejection. Never throws on safety rejections. When the
	 * injected `modes.elevatedModeFor(action)` reports an elevation target
	 * and the current mode denies the action, the returned promise stays
	 * pending until `resumeParkedCalls` or `cancelParkedCalls` is called.
	 */
	invoke(call: ClassifierCall, options?: ToolInvokeOptions): Promise<RegistryVerdict>;
	/** Current protected-artifact snapshot, cloned for callers. */
	protectedArtifacts(): ProtectedArtifactState;
	/** Replace the protected-artifact snapshot, typically after a session switch. */
	replaceProtectedArtifacts(state: ProtectedArtifactState): void;
	/**
	 * True while at least one call awaits mode elevation. The interactive
	 * layer reads this from `closeOverlay()` to re-open the super overlay
	 * whenever an unrelated overlay closes with a parked call still pending.
	 */
	hasParkedCalls(): boolean;
	/**
	 * Re-run admission for every parked call. When `grant` is provided the
	 * admission gate uses the grant mode for its action-allow check instead
	 * of the live mode, so the user can confirm a single tool call without
	 * flipping the persistent mode (one-shot escalation). Calls admitted on
	 * retry execute and their original promise resolves with the result.
	 * Calls still blocked only by the mode gate (with no grant or with a
	 * grant that does not cover their action class) stay parked.
	 */
	resumeParkedCalls(grant?: OneShotGrant): Promise<void>;
	/**
	 * Resolve every parked call with a `blocked` verdict carrying `reason`.
	 * Used when the super overlay is cancelled so the agent loop sees a
	 * clean rejection instead of an indefinitely pending tool call.
	 */
	cancelParkedCalls(reason: string): void;
	/**
	 * Subscribe to the signal fired when a call is parked awaiting super
	 * confirmation. The interactive layer wires this to open the super
	 * overlay. Returns an unsubscribe handle.
	 */
	onSuperRequired(listener: (call: ClassifierCall) => void): () => void;
}

export type RegistryVerdict =
	| { kind: "ok"; result: ToolResult; decision: SafetyDecision }
	| { kind: "blocked"; reason: string; decision: SafetyDecision }
	| { kind: "not_visible"; reason: string };

interface ParkedCall {
	call: ClassifierCall;
	decision: SafetyDecision;
	resolve: (verdict: RegistryVerdict) => void;
	options?: ToolInvokeOptions;
}

export function createRegistry(deps: RegistryDeps): ToolRegistry {
	const tools = new Map<ToolName, ToolSpec>();
	const parked: ParkedCall[] = [];
	const superListeners = new Set<(call: ClassifierCall) => void>();
	let protectedArtifactState = cloneProtectedArtifactState(deps.protectedArtifacts ?? { artifacts: [] });
	const successfulDispatchesByTurn = new Map<string, Set<string>>();

	const runSpec = async (
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options?: ToolInvokeOptions,
	): Promise<RegistryVerdict> => {
		const existingProtectedBlock = protectedArtifactBlock(spec, call);
		if (existingProtectedBlock) return { kind: "blocked", reason: existingProtectedBlock, decision };
		const duplicateDispatch = dispatchDuplicateBlock(successfulDispatchesByTurn, spec, call, options);
		if (duplicateDispatch !== null) return { kind: "blocked", reason: duplicateDispatch, decision };
		const beforeEffects = runToolHook("before_tool", spec, call, decision, options);
		applyProtectPathEffects(beforeEffects, spec, call, options);
		const block = firstBlockToolEffect(beforeEffects);
		if (block) return { kind: "blocked", reason: block.reason, decision };
		const protectedBlock = protectedArtifactBlock(spec, call);
		const duplicateDispatchAfterHooks = dispatchDuplicateBlock(successfulDispatchesByTurn, spec, call, options);
		if (duplicateDispatchAfterHooks !== null) return { kind: "blocked", reason: duplicateDispatchAfterHooks, decision };
		if (protectedBlock) return { kind: "blocked", reason: protectedBlock, decision };
		try {
			const result = shapeToolResult(spec, await spec.run(call.args ?? {}, options));
			const afterEffects = runToolHook("after_tool", spec, call, decision, options, result);
			applyProtectPathEffects(afterEffects, spec, call, options, result);
			const finalResult = shapeToolResult(spec, applyToolResultEffects(result, afterEffects));
			emitSkillActivation(deps, spec, finalResult, options);
			rememberSuccessfulDispatch(successfulDispatchesByTurn, spec, call, options, finalResult);
			return { kind: "ok", result: finalResult, decision };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const result = shapeToolResult(spec, { kind: "error", message });
			const afterEffects = runToolHook("after_tool", spec, call, decision, options, result);
			applyProtectPathEffects(afterEffects, spec, call, options, result);
			return { kind: "ok", result: shapeToolResult(spec, applyToolResultEffects(result, afterEffects)), decision };
		}
	};

	const runToolHook = (
		hook: "before_tool" | "after_tool",
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
		result?: ToolResult,
	): ReadonlyArray<MiddlewareEffect> => {
		if (!deps.middleware) return [];
		return deps.middleware.runHook(buildToolHookInput(hook, spec, call, decision, deps.modes.current(), options, result))
			.effects;
	};

	const applyProtectPathEffects = (
		effects: ReadonlyArray<MiddlewareEffect>,
		spec: ToolSpec,
		call: ClassifierCall,
		options?: ToolInvokeOptions,
		result?: ToolResult,
	): void => {
		for (const effect of effects) {
			if (effect.kind !== "protect_path") continue;
			const artifact = protectedArtifactFromEffect(effect, call, result);
			protectedArtifactState = protectArtifact(protectedArtifactState, artifact);
			emitProtectedArtifactEvent(deps, protectedArtifactEvent(artifact, spec, options));
		}
	};

	const protectedArtifactBlock = (spec: ToolSpec, call: ClassifierCall): string | null => {
		if (protectedArtifactState.artifacts.length === 0) return null;
		for (const candidate of toolMutationPaths(spec, call.args)) {
			if (isProtectedPath(protectedArtifactState, candidate)) {
				return `protected artifact blocked: ${spec.name} would modify protected path ${candidate}`;
			}
		}
		if (spec.name !== ToolNames.Bash) return null;
		const command = commandArg(call.args);
		if (command === null) return null;
		const classification = classifyDestructiveCommand(command, protectedArtifactState.artifacts);
		if (classification.kind === "benign") return null;
		const affected = classification.matches.map((match) => match.artifactPath).join(", ");
		return `protected artifact blocked: ${classification.operation} would affect ${affected}`;
	};

	type AdmitOutcome =
		| { kind: "terminal"; verdict: RegistryVerdict }
		| { kind: "execute"; spec: ToolSpec; decision: SafetyDecision }
		| { kind: "park"; decision: SafetyDecision };

	const admit = (call: ClassifierCall, grant?: OneShotGrant): AdmitOutcome => {
		const spec = tools.get(call.tool as ToolName);
		if (!spec) {
			return { kind: "terminal", verdict: { kind: "not_visible", reason: `tool not registered: ${call.tool}` } };
		}
		const visible = deps.modes.visibleTools();
		if (!visible.has(spec.name)) {
			return {
				kind: "terminal",
				verdict: { kind: "not_visible", reason: `tool ${spec.name} not in current mode's allowlist` },
			};
		}
		const currentMode = deps.modes.current();
		const safetyMode = grant?.mode ?? currentMode;
		if (spec.allowedModes && !spec.allowedModes.includes(currentMode)) {
			return {
				kind: "terminal",
				verdict: { kind: "not_visible", reason: `tool ${spec.name} not allowed in mode ${currentMode}` },
			};
		}
		const decision = applyRegisteredToolClassification(deps.safety.evaluate(call, safetyMode), spec);
		if (decision.kind === "block") {
			return { kind: "terminal", verdict: { kind: "blocked", reason: decision.rejection.short, decision } };
		}
		if (decision.kind === "ask") {
			return { kind: "park", decision };
		}
		const actionClass = decision.classification.actionClass;
		// Action gate: a one-shot grant lets a parked call execute as if the
		// current mode were `grant.mode`, without flipping the persistent mode.
		// Tool-name visibility (above) still uses the live mode so a one-shot
		// grant can never expose a tool that the live mode hides.
		const grantAllows = grant !== undefined && MODE_MATRIX[grant.mode].allowedActions.has(actionClass);
		if (!deps.modes.isActionAllowed(actionClass) && !grantAllows) {
			if (deps.modes.elevatedModeFor(actionClass) !== null) {
				return { kind: "park", decision };
			}
			return {
				kind: "terminal",
				verdict: {
					kind: "blocked",
					reason: `action ${actionClass} not allowed in mode ${currentMode}`,
					decision,
				},
			};
		}
		return { kind: "execute", spec, decision };
	};

	const notifySuperRequired = (call: ClassifierCall): void => {
		for (const listener of superListeners) {
			try {
				listener(call);
			} catch {
				// Listener errors never abort admission; they are surfaced via
				// whatever observability the caller wires up.
			}
		}
	};

	return {
		register(spec) {
			tools.set(spec.name, spec);
		},
		listAll: () => Array.from(tools.values()),
		get: (name) => tools.get(name),
		protectedArtifacts: () => cloneProtectedArtifactState(protectedArtifactState),
		replaceProtectedArtifacts(state) {
			protectedArtifactState = cloneProtectedArtifactState(state);
		},
		listForMode: (mode) =>
			Array.from(tools.values())
				.filter((t) => MODE_MATRIX[mode].tools.has(t.name) && (!t.allowedModes || t.allowedModes.includes(mode)))
				.map((t) => t.name),
		listVisible: () => {
			const visible = deps.modes.visibleTools();
			return Array.from(tools.values()).filter((t) => visible.has(t.name));
		},
		async invoke(call, options) {
			const outcome = admit(call);
			if (outcome.kind === "terminal") return outcome.verdict;
			if (outcome.kind === "execute") return runSpec(outcome.spec, call, outcome.decision, options);
			return new Promise<RegistryVerdict>((resolve) => {
				const parkedCall: ParkedCall = { call, decision: outcome.decision, resolve };
				if (options !== undefined) parkedCall.options = options;
				parked.push(parkedCall);
				notifySuperRequired(call);
			});
		},
		hasParkedCalls: () => parked.length > 0,
		async resumeParkedCalls(grant?: OneShotGrant) {
			if (parked.length === 0) return;
			const pending = grant === undefined ? parked.splice(0, parked.length) : parked.splice(0, 1);
			for (const entry of pending) {
				// A one-shot grant covers only the oldest parked call. Calls that
				// parked while the overlay was already open remain queued and need
				// their own confirmation, so a late or concurrent privileged call
				// cannot ride along on a grant the user approved for another call.
				const outcome = admit(entry.call, grant);
				if (outcome.kind === "park") {
					parked.push(entry);
					continue;
				}
				if (outcome.kind === "terminal") {
					entry.resolve(outcome.verdict);
					continue;
				}
				entry.resolve(await runSpec(outcome.spec, entry.call, outcome.decision, entry.options));
			}
		},
		cancelParkedCalls(reason) {
			if (parked.length === 0) return;
			const pending = parked.splice(0, parked.length);
			for (const entry of pending) {
				entry.resolve({ kind: "blocked", reason, decision: entry.decision });
			}
		},
		onSuperRequired(listener) {
			superListeners.add(listener);
			return () => {
				superListeners.delete(listener);
			};
		},
	};
}

function applyRegisteredToolClassification(decision: SafetyDecision, spec: ToolSpec): SafetyDecision {
	if (decision.classification.actionClass !== "unknown") return decision;
	const classification = {
		actionClass: spec.baseActionClass,
		reasons: [`registered tool: ${spec.name}`],
	};
	return decision.kind === "allow" ? { kind: "allow", classification } : { ...decision, classification };
}

const DISPATCH_GUARD_TURN_LIMIT = 32;
const DISPATCH_DEFAULT_AGENT_ID = "coder";

function dispatchDuplicateBlock(
	successfulDispatchesByTurn: Map<string, Set<string>>,
	spec: ToolSpec,
	call: ClassifierCall,
	options?: ToolInvokeOptions,
): string | null {
	if (spec.name !== ToolNames.Dispatch || !options?.turnId) return null;
	const fingerprint = dispatchFingerprint(call.args);
	if (fingerprint === null) return null;
	const seen = successfulDispatchesByTurn.get(options.turnId);
	if (!seen?.has(fingerprint)) return null;
	const summary = formatDispatchDuplicateSummary(call.args);
	return `dispatch duplicate blocked: ${summary} already completed successfully in this user turn. Use the existing dispatch receipt/output to answer instead of repeating the same fleet dispatch.`;
}

function rememberSuccessfulDispatch(
	successfulDispatchesByTurn: Map<string, Set<string>>,
	spec: ToolSpec,
	call: ClassifierCall,
	options: ToolInvokeOptions | undefined,
	result: ToolResult,
): void {
	if (spec.name !== ToolNames.Dispatch || !options?.turnId || result.kind !== "ok") return;
	const details = asRecord(result.details);
	if (details?.exitCode !== 0) return;
	const fingerprint = dispatchFingerprint(call.args);
	if (fingerprint === null) return;
	let seen = successfulDispatchesByTurn.get(options.turnId);
	if (!seen) {
		seen = new Set<string>();
		successfulDispatchesByTurn.set(options.turnId, seen);
		while (successfulDispatchesByTurn.size > DISPATCH_GUARD_TURN_LIMIT) {
			const oldest = successfulDispatchesByTurn.keys().next().value;
			if (typeof oldest !== "string") break;
			successfulDispatchesByTurn.delete(oldest);
		}
	}
	seen.add(fingerprint);
}

function dispatchFingerprint(args: unknown): string | null {
	const record = asRecord(args);
	if (record === null) return null;
	const task = stringValue(record.task);
	if (task === null) return null;
	const normalized = {
		agentId:
			stringValue(record.agent_id) ??
			stringValue(record.agentId) ??
			stringValue(record.agent) ??
			DISPATCH_DEFAULT_AGENT_ID,
		task,
		target: stringValue(record.target) ?? stringValue(record.endpoint) ?? "",
		model: stringValue(record.model) ?? "",
		profile:
			stringValue(record.agent_profile) ?? stringValue(record.worker_profile) ?? stringValue(record.workerProfile) ?? "",
		runtime:
			stringValue(record.agent_runtime) ?? stringValue(record.worker_runtime) ?? stringValue(record.workerRuntime) ?? "",
		toolProfile: stringValue(record.tool_profile) ?? stringValue(record.toolProfile) ?? "",
		thinkingLevel: stringValue(record.thinking_level) ?? stringValue(record.thinkingLevel) ?? "",
		cwd: stringValue(record.cwd) ?? "",
		memorySection: stringValue(record.memory_section) ?? stringValue(record.memorySection) ?? "",
		requiredCapabilities: stringArrayValue(record.required_capabilities ?? record.requiredCapabilities).sort(),
	};
	return stableJson(normalized);
}

function formatDispatchDuplicateSummary(args: unknown): string {
	const record = asRecord(args);
	if (record === null) return "that dispatch";
	const agentId =
		stringValue(record.agent_id) ?? stringValue(record.agentId) ?? stringValue(record.agent) ?? DISPATCH_DEFAULT_AGENT_ID;
	const task = stringValue(record.task) ?? "";
	const taskSummary = task.length > 80 ? `${task.slice(0, 77)}...` : task;
	return `agent=${agentId} task=${JSON.stringify(taskSummary)}`;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringArrayValue(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function emitProtectedArtifactEvent(deps: RegistryDeps, event: ProtectedArtifactRegistryEvent): void {
	if (!deps.onProtectedArtifactEvent) return;
	try {
		deps.onProtectedArtifactEvent(event);
	} catch {
		// Protection state is already live in memory. Persistence hooks are
		// best-effort and must not change tool execution semantics.
	}
}

function emitSkillActivation(
	deps: RegistryDeps,
	spec: ToolSpec,
	result: ToolResult,
	options?: ToolInvokeOptions,
): void {
	if (!deps.onSkillActivation || spec.name !== ToolNames.ReadSkill || result.kind !== "ok") return;
	const activation = skillActivationFromToolDetails(result.details, options?.turnId);
	if (!activation) return;
	try {
		deps.onSkillActivation(activation);
	} catch {
		// Activation writes are audit metadata. Tool execution has already
		// succeeded and must not be changed by a failed ledger append.
	}
}

function buildToolHookInput(
	hook: "before_tool" | "after_tool",
	spec: ToolSpec,
	call: ClassifierCall,
	decision: SafetyDecision,
	mode: ModeName,
	options: ToolInvokeOptions | undefined,
	result: ToolResult | undefined,
): MiddlewareHookInput {
	const metadata: Record<string, MiddlewareMetadataValue> = {
		mode,
		actionClass: decision.classification.actionClass,
		decisionKind: decision.kind,
	};
	const validationCommand = detectedValidationCommand(call);
	if (validationCommand !== null) {
		metadata.validationCommand = validationCommand;
		if (result?.kind === "ok") metadata.validationExitCode = 0;
	}
	if (call.tool !== spec.name) metadata.requestedToolName = call.tool;
	if (result !== undefined) {
		metadata.resultKind = result.kind;
		if (result.kind === "error") metadata.errorMessage = result.message;
		if (result.kind === "ok" && result.terminate === true) metadata.terminate = true;
	}

	const input: MiddlewareHookInput = {
		hook,
		toolName: spec.name,
		metadata,
	};
	if (options?.runId !== undefined) input.runId = options.runId;
	if (options?.sessionId !== undefined) input.sessionId = options.sessionId;
	if (options?.turnId !== undefined) input.turnId = options.turnId;
	if (options?.toolCallId !== undefined) input.toolCallId = options.toolCallId;
	if (options?.correlationId !== undefined) input.correlationId = options.correlationId;
	return input;
}

function protectedArtifactFromEffect(
	effect: Extract<MiddlewareEffect, { kind: "protect_path" }>,
	call: ClassifierCall,
	result: ToolResult | undefined,
): ProtectedArtifact {
	const artifact: ProtectedArtifact = {
		path: effect.path,
		protectedAt: new Date().toISOString(),
		reason: effect.reason,
		source: "middleware",
	};
	const validationCommand = detectedValidationCommand(call);
	if (validationCommand !== null) {
		artifact.validationCommand = validationCommand;
		if (result?.kind === "ok") artifact.validationExitCode = 0;
	}
	return artifact;
}

function protectedArtifactEvent(
	artifact: ProtectedArtifact,
	spec: ToolSpec,
	options?: ToolInvokeOptions,
): ProtectedArtifactRegistryEvent {
	const event: ProtectedArtifactRegistryEvent = {
		kind: "protect",
		artifact: cloneProtectedArtifact(artifact),
		toolName: spec.name,
	};
	if (options?.runId !== undefined) event.runId = options.runId;
	if (options?.sessionId !== undefined) event.sessionId = options.sessionId;
	if (options?.turnId !== undefined) event.turnId = options.turnId;
	if (options?.toolCallId !== undefined) event.toolCallId = options.toolCallId;
	if (options?.correlationId !== undefined) event.correlationId = options.correlationId;
	return event;
}

function cloneProtectedArtifactState(state: ProtectedArtifactState): ProtectedArtifactState {
	let next: ProtectedArtifactState = { artifacts: [] };
	for (const artifact of state.artifacts) {
		next = protectArtifact(next, artifact);
	}
	return next;
}

function cloneProtectedArtifact(artifact: ProtectedArtifact): ProtectedArtifact {
	const clone: ProtectedArtifact = {
		path: artifact.path,
		protectedAt: artifact.protectedAt,
		reason: artifact.reason,
		source: artifact.source,
	};
	if (artifact.validationCommand !== undefined) clone.validationCommand = artifact.validationCommand;
	if (artifact.validationExitCode !== undefined) clone.validationExitCode = artifact.validationExitCode;
	return clone;
}

function toolMutationPaths(spec: ToolSpec, args: Record<string, unknown> | undefined): string[] {
	if (spec.name === ToolNames.WritePlan) return [pathArg(args) ?? "PLAN.md"];
	if (spec.name === ToolNames.WriteReview) return [pathArg(args) ?? "REVIEW.md"];
	if (spec.name === ToolNames.Write || spec.name === ToolNames.Edit) {
		const candidate = pathArg(args);
		return candidate === null ? [] : [candidate];
	}
	return [];
}

function pathArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function commandArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	return typeof args.command === "string" && args.command.length > 0 ? args.command : null;
}

function detectedValidationCommand(call: ClassifierCall): string | null {
	if (call.tool !== ToolNames.Bash) return null;
	const command = commandArg(call.args);
	if (command === null) return null;
	const detected = detectValidationCommand(command);
	return detected.kind === "validation" ? detected.matched : null;
}

function firstBlockToolEffect(
	effects: ReadonlyArray<MiddlewareEffect>,
): Extract<MiddlewareEffect, { kind: "block_tool" }> | null {
	for (const effect of effects) {
		if (effect.kind === "block_tool") return effect;
	}
	return null;
}

function applyToolResultEffects(result: ToolResult, effects: ReadonlyArray<MiddlewareEffect>): ToolResult {
	const annotations = annotationMessages(effects);
	if (annotations.length === 0) return result;
	const suffix = `\n\n${annotations.join("\n")}`;
	if (result.kind === "ok") {
		const annotated: ToolResult = { kind: "ok", output: `${result.output}${suffix}` };
		if (result.details !== undefined) annotated.details = result.details;
		if (result.terminate === true) annotated.terminate = true;
		return annotated;
	}
	return { kind: "error", message: `${result.message}${suffix}` };
}

function annotationMessages(effects: ReadonlyArray<MiddlewareEffect>): string[] {
	const messages: string[] = [];
	for (const effect of effects) {
		if (effect.kind !== "annotate_tool_result") continue;
		const severity = effect.severity ?? "info";
		messages.push(`[middleware:${severity}] ${effect.message}`);
	}
	return messages;
}
