import type { TSchema } from "typebox";
import type { PendingSkillToolPolicy } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import type { MiddlewareContract } from "../domains/middleware/contract.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareMetadataValue } from "../domains/middleware/types.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import {
	type AutonomyLevel,
	autonomyAskRejection,
	autonomyDenyRejection,
	DEFAULT_AUTONOMY_LEVEL,
	mapAutonomy,
} from "../domains/safety/autonomy.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import { hashToolCall } from "../domains/safety/loop-detector.js";
import { detectValidationCommand } from "../domains/safety/protected-artifacts.js";
import { shapeToolResult } from "./result-shaping.js";

/**
 * Tool registry. Admission point for every tool call. Delegates classification
 * and policy decisions to the safety domain, parks one-shot confirmation asks,
 * and runs admitted tool bodies. Never throws on safety rejections; the caller
 * surfaces the rejection message back to the model.
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
	/** Coarse cost/latency bucket for dashboard diagnostics. */
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
	 * Per-tool execution mode. Read-only tools set `"parallel"` so the model
	 * can batch scans; mutating or filesystem-racing tools set `"sequential"`
	 * so two `bash` or `edit` calls in the same batch never run concurrently.
	 */
	executionMode?: ToolExecutionMode;
	/** Execute the tool. Only called after admission. */
	run(args: Record<string, unknown>, options?: ToolInvokeOptions): Promise<ToolResult>;
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
			 * a follow-up LLM call. Used by terminal artifact writers where
			 * writing the artifact is the whole turn.
			 */
			terminate?: boolean;
	  }
	| { kind: "error"; message: string; details?: ToolResultDetails };

export interface RegistryDeps {
	safety: SafetyContract;
	/**
	 * Hook layer. The loop guard, registered on `before_tool` by both
	 * composition roots (entry/orchestrator.ts and worker-runtime.ts via
	 * engine/loop-guard.ts), observes every call attempt through this contract;
	 * the registry feeds it `metadata.callFingerprint` and runs `before_tool`
	 * for safety-blocked attempts too, so repetition of rejected calls stays
	 * observable.
	 */
	middleware?: MiddlewareContract;
	/**
	 * Live autonomy level (sd-01 §2.2). Read per admission so hot-reloaded
	 * settings apply to the next call. The orchestrator wires this to current
	 * settings; workers wire it to the level carried on their WorkerSpec.
	 * Absent means the default level (M7: auto-edit).
	 */
	autonomy?: () => AutonomyLevel;
}

export interface ToolInvokeOptions {
	signal?: AbortSignal;
	runId?: string;
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	correlationId?: string;
	pendingSkillPolicy?: PendingSkillToolPolicy;
	askUserPolicy?: AskUserToolPolicy;
}

export type AskUserInterviewStatus = "idle" | "active" | "complete" | "cancelled";

export interface AskUserTranscriptQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multi_select?: boolean;
}

export interface AskUserTranscriptAnswer {
	question: string;
	answer: string;
}

export interface AskUserTranscriptDecision {
	key: string;
	value: string;
	label?: string;
	source_question?: string;
}

export interface AskUserTranscriptRound {
	round: number;
	requestedAt: string;
	answeredAt?: string;
	questions: AskUserTranscriptQuestion[];
	answers: AskUserTranscriptAnswer[];
	cancelled?: boolean;
}

export interface AskUserToolPolicy {
	id: string;
	status: AskUserInterviewStatus;
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
	sessionId?: string;
	turnId?: string;
	transcriptPath?: string;
	summary?: string;
	rounds: AskUserTranscriptRound[];
	decisions: AskUserTranscriptDecision[];
	inFlight: boolean;
	cancelled: boolean;
	answerCount: number;
	callCount: number;
	maxCalls: number;
	askedQuestionKeys: Set<string>;
}

/**
 * One-shot elevation grant. The interactive layer issues this when the user
 * confirms a single parked tool call without changing persistent posture.
 * The registry consumes the grant on the next `resumeParkedCalls` pass so
 * exactly one parked call receives elevated admission; subsequent calls go
 * back through the normal safety gate.
 */
export interface OneShotGrant {
	/** Parked action class approved for this single admission pass. */
	actionClass: ActionClass;
	/** Free-form origin tag carried into audit (`tool`, `keybind:single`, ...). */
	requestedBy: string;
}

export interface ToolRegistry {
	register(spec: ToolSpec): void;
	/** Tools visible in the single operating posture. Models only see these. */
	listVisible(): ReadonlyArray<ToolSpec>;
	/** Tools registered overall. For /audit, /doctor. */
	listAll(): ReadonlyArray<ToolSpec>;
	/** Lookup by tool id. */
	get(name: ToolName): ToolSpec | undefined;
	/** Tool names registered in the single operating posture. */
	listRegistered(): ReadonlyArray<ToolName>;
	/**
	 * Admission point. Classifies, evaluates safety, and either runs or
	 * returns a rejection. Never throws on safety rejections. When the
	 * a safety ask or confirmable action is encountered, the returned promise
	 * stays pending until `resumeParkedCalls` or `cancelParkedCalls` is called.
	 */
	invoke(call: ClassifierCall, options?: ToolInvokeOptions): Promise<RegistryVerdict>;
	/**
	 * True while at least one call awaits operator confirmation. The interactive
	 * layer reads this from `closeOverlay()` to re-open the confirmation overlay
	 * whenever an unrelated overlay closes with a parked call still pending.
	 */
	hasParkedCalls(): boolean;
	/**
	 * Re-run admission for every parked call. When `grant` is provided the
	 * grant covers the oldest parked action class. Calls admitted on retry
	 * execute and their original promise resolves with the result. Calls still
	 * waiting for confirmation stay parked.
	 */
	resumeParkedCalls(grant?: OneShotGrant): Promise<void>;
	/**
	 * Resolve every parked call with a `blocked` verdict carrying `reason`.
	 * Used when the confirmation overlay is cancelled so the agent loop sees a
	 * clean rejection instead of an indefinitely pending tool call.
	 */
	cancelParkedCalls(reason: string): void;
	/**
	 * Subscribe to the signal fired when a call is parked awaiting permission
	 * confirmation. Returns an unsubscribe handle.
	 */
	onPermissionRequired(listener: (call: ClassifierCall, decision: SafetyDecision) => void): () => void;
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
	const permissionListeners = new Set<(call: ClassifierCall, decision: SafetyDecision) => void>();

	const runSpec = async (
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options?: ToolInvokeOptions,
	): Promise<RegistryVerdict> => {
		// The hook layer is the only control stage past safety admission. Guards
		// (loop, protected artifacts, dispatch dedup) are before_tool
		// registrations; the first block_tool effect decides the verdict.
		const beforeEffects = runToolHook("before_tool", spec, call, decision, options);
		const block = firstBlockToolEffect(beforeEffects);
		if (block) return { kind: "blocked", reason: block.reason, decision };
		try {
			const result = shapeToolResult(spec, await spec.run(call.args ?? {}, options), options);
			const afterEffects = runToolHook("after_tool", spec, call, decision, options, result);
			const finalResult = shapeToolResult(spec, applyToolResultEffects(result, afterEffects), options);
			return { kind: "ok", result: finalResult, decision };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const result = shapeToolResult(spec, { kind: "error", message }, options);
			const afterEffects = runToolHook("after_tool", spec, call, decision, options, result);
			return {
				kind: "ok",
				result: shapeToolResult(spec, applyToolResultEffects(result, afterEffects), options),
				decision,
			};
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
		return deps.middleware.runHook(buildToolHookInput(hook, spec, call, decision, "operating", options, result)).effects;
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
		const level = deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		const decision = applyRegisteredToolClassification(deps.safety.evaluate(call, grant ? "confirmed" : undefined), spec);
		// Stage 1, the safety net (level-independent): engine blocks are final;
		// engine asks are confirm rails that park at every level. read-only is
		// the exception by definition: approvals are never invoked there, so a
		// confirm rail resolves as the same auto-deny as any other mutation.
		if (decision.kind === "block") {
			return { kind: "terminal", verdict: { kind: "blocked", reason: decision.rejection.short, decision } };
		}
		const actionClass = decision.classification.actionClass;
		if (decision.kind === "ask") {
			if (level === "read-only") {
				return { kind: "terminal", verdict: autonomyDenyVerdict(decision, level, call.tool, actionClass) };
			}
			if (grant?.actionClass === actionClass) return { kind: "execute", spec, decision };
			return { kind: "park", decision };
		}
		// One-shot grant: resumeParkedCalls re-admits exactly the parked call
		// the operator approved, with a confirmed posture. The engine converts
		// its confirm rail to an allow (including M3 git ask rules), so the
		// grant match executes directly instead of re-entering the mapping.
		if (grant?.actionClass === actionClass) {
			return { kind: "execute", spec, decision };
		}
		if (actionClass === "git_destructive") {
			return {
				kind: "terminal",
				verdict: {
					kind: "blocked",
					reason: `action ${actionClass} is hard-blocked`,
					decision,
				},
			};
		}
		// Stage 2, the autonomy mapping (sd-01 §2.3): the net passed; the level
		// decides run / ask / deny per action class.
		const disposition = mapAutonomy(level, actionClass, {
			executeRecognized: decision.policy?.execRecognition !== "unrecognized",
		});
		if (disposition === "deny") {
			return { kind: "terminal", verdict: autonomyDenyVerdict(decision, level, call.tool, actionClass) };
		}
		if (disposition === "ask") {
			return { kind: "park", decision: toAutonomyAskDecision(decision, level, call.tool, actionClass) };
		}
		return { kind: "execute", spec, decision };
	};

	/**
	 * Loop-observe a safety-blocked attempt. The verdict stands and every
	 * effect is discarded; this exists so the before_tool loop guard sees
	 * rejected attempts too. Without it, a model repeating an identical
	 * blocked call would never trip the detector (the former worker guard sat
	 * in front of admission and had this coverage).
	 */
	const observeBlockedAttempt = (call: ClassifierCall, verdict: RegistryVerdict, options?: ToolInvokeOptions): void => {
		if (verdict.kind !== "blocked") return;
		observeRejectedAttempt(call, verdict.decision, options);
	};

	/**
	 * Run before_tool hooks for an attempt that will not execute, so repetition
	 * detectors see it. Effects never change the rejection itself; the returned
	 * value is the first block_tool reason (the loop guard's actionable
	 * feedback), which the park-denial path substitutes for its generic reason
	 * so a model retrying a denied call learns to stop instead of looping until
	 * the run times out.
	 */
	const observeRejectedAttempt = (
		call: ClassifierCall,
		decision: SafetyDecision,
		options?: ToolInvokeOptions,
	): string | null => {
		if (!deps.middleware) return null;
		const spec = tools.get(call.tool as ToolName);
		if (!spec) return null;
		const effects = runToolHook("before_tool", spec, call, decision, options);
		return firstBlockToolEffect(effects)?.reason ?? null;
	};

	const notifyPermissionRequired = (call: ClassifierCall, decision: SafetyDecision): void => {
		for (const listener of permissionListeners) {
			try {
				listener(call, decision);
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
		listRegistered: () => Array.from(tools.keys()),
		listVisible: () => Array.from(tools.values()),
		async invoke(call, options) {
			const outcome = admit(call);
			if (outcome.kind === "terminal") {
				observeBlockedAttempt(call, outcome.verdict, options);
				return outcome.verdict;
			}
			if (outcome.kind === "execute") return runSpec(outcome.spec, call, outcome.decision, options);
			return new Promise<RegistryVerdict>((resolve) => {
				const parkedCall: ParkedCall = { call, decision: outcome.decision, resolve };
				if (options !== undefined) parkedCall.options = options;
				parked.push(parkedCall);
				notifyPermissionRequired(call, outcome.decision);
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
					observeBlockedAttempt(entry.call, outcome.verdict, entry.options);
					entry.resolve(outcome.verdict);
					continue;
				}
				entry.resolve(await runSpec(outcome.spec, entry.call, outcome.decision, entry.options));
			}
			const next = parked[0];
			if (next) notifyPermissionRequired(next.call, next.decision);
		},
		cancelParkedCalls(reason) {
			if (parked.length === 0) return;
			const pending = parked.splice(0, parked.length);
			for (const entry of pending) {
				// A denied/cancelled park is still a model attempt: observe it so
				// identical retries trip the loop detector. When the detector
				// fires, its reason replaces the generic denial so the model gets
				// recovery guidance rather than the same static message forever.
				const loopReason = observeRejectedAttempt(entry.call, entry.decision, entry.options);
				entry.resolve({ kind: "blocked", reason: loopReason ?? reason, decision: entry.decision });
			}
		},
		onPermissionRequired(listener) {
			permissionListeners.add(listener);
			return () => {
				permissionListeners.delete(listener);
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

/**
 * Terminal blocked verdict for an autonomy `deny` disposition (read-only).
 * The decision is re-shaped as a block so downstream consumers (worker
 * events, dispatch receipts) report it as a denial, not a pending ask.
 */
function autonomyDenyVerdict(
	decision: SafetyDecision,
	level: AutonomyLevel,
	tool: string,
	actionClass: ActionClass,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const rejection = autonomyDenyRejection(level, tool, actionClass);
	const blocked: SafetyDecision = {
		kind: "block",
		classification: decision.classification,
		rejection,
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
	return { kind: "blocked", reason: rejection.short, decision: blocked };
}

/**
 * Park-shaped decision for an autonomy `ask` disposition. The engine passed
 * the call, so the rejection names the level as the asking axis; overlays and
 * non-interactive deniers read it from here.
 */
function toAutonomyAskDecision(
	decision: SafetyDecision,
	level: AutonomyLevel,
	tool: string,
	actionClass: ActionClass,
): SafetyDecision {
	return {
		kind: "ask",
		classification: decision.classification,
		rejection: autonomyAskRejection(level, tool, actionClass),
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
}

function buildToolHookInput(
	hook: "before_tool" | "after_tool",
	spec: ToolSpec,
	call: ClassifierCall,
	decision: SafetyDecision,
	posture: string,
	options: ToolInvokeOptions | undefined,
	result: ToolResult | undefined,
): MiddlewareHookInput {
	const metadata: Record<string, MiddlewareMetadataValue> = {
		posture,
		actionClass: decision.classification.actionClass,
		decisionKind: decision.kind,
	};
	// Stable call identity for repetition detectors (engine/loop-guard.ts).
	// Computed for before_tool only; after_tool consumers identify the call
	// via toolCallId.
	if (hook === "before_tool") metadata.callFingerprint = hashToolCall(spec.name, call.args ?? {});
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
	if (call.args !== undefined) input.toolArgs = call.args;
	if (result?.details !== undefined) input.toolResultDetails = result.details;
	if (options?.runId !== undefined) input.runId = options.runId;
	if (options?.sessionId !== undefined) input.sessionId = options.sessionId;
	if (options?.turnId !== undefined) input.turnId = options.turnId;
	if (options?.toolCallId !== undefined) input.toolCallId = options.toolCallId;
	if (options?.correlationId !== undefined) input.correlationId = options.correlationId;
	return input;
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
