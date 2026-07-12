import { createHash, randomBytes } from "node:crypto";
import type { TSchema } from "typebox";
import { isWorkerToolCallCapExceededReason } from "../core/guardrails.js";
import {
	evaluateSkillToolSurface,
	type PendingSkillToolPolicy,
	type SkillToolSurfaceViolation,
} from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import type { MiddlewareContract } from "../domains/middleware/contract.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareMetadataValue } from "../domains/middleware/types.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import { approvalAxisId } from "../domains/safety/approval-axis.js";
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
import { describeDispatchPlan, isPlanScaleDispatchArgs } from "./dispatch-plan.js";
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
	/**
	 * One sentence of usage guidance rendered into the session Tool Contract
	 * when this tool is on the frozen surface. Hints render sorted by tool
	 * name, so the compiled prompt stays byte-stable per surface. Most tools
	 * need none; the schema description covers them.
	 */
	promptHint?: string;
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
	/**
	 * Optional argument normalizer applied before the tool body (and its own
	 * internal validation). Mirrors pi's `prepareArguments`: lets a tool accept
	 * the common weak-model argument shapes (legacy top-level fields, a
	 * JSON-string array) without hand-parsing inside every `run`. Must be pure
	 * and idempotent; a throwing normalizer is ignored and the raw args pass
	 * through. Tools that also want direct `run` calls normalized should invoke
	 * the same function at the top of `run`.
	 */
	prepareArguments?(args: Record<string, unknown>): Record<string, unknown>;
	/**
	 * Pure, synchronous admission planner. Unlike `prepareArguments`, this runs
	 * before safety/autonomy mapping so approval-sensitive tools can attach the
	 * exact immutable artifact that admission and execution will share.
	 */
	prepareAdmissionArguments?(args: Record<string, unknown>): Record<string, unknown>;
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
	/** Registry-authenticated one-shot operator approval for this execution. */
	approval?: { requestId: string; requestedBy: string; actionClass: ActionClass };
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
	/** Parked approval request approved for this single admission pass. */
	requestId?: string;
	/** Free-form origin tag carried into audit (`tool`, `keybind:single`, ...). */
	requestedBy: string;
}

export interface PermissionRequiredMeta {
	requestId: string;
	axis: string;
	/**
	 * Provider tool-call id carried on the parked call's invoke options, when
	 * one exists. The interactive layer uses it to correlate the park to its
	 * transcript tool segment so a parked call renders as awaiting approval
	 * instead of running. Purely descriptive: park/resume semantics never
	 * read it.
	 */
	toolCallId?: string;
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
	 * stays pending until a resume or cancel method resolves it.
	 */
	invoke(call: ClassifierCall, options?: ToolInvokeOptions): Promise<RegistryVerdict>;
	/**
	 * True while at least one call awaits operator confirmation. The interactive
	 * layer reads this from `closeOverlay()` to re-open the confirmation overlay
	 * whenever an unrelated overlay closes with a parked call still pending.
	 */
	hasParkedCalls(): boolean;
	/** Number of calls currently waiting for operator confirmation. */
	parkedCount(): number;
	/**
	 * Re-fire the permission-required signal for the oldest parked call without
	 * changing queue order or resolving anything.
	 */
	renotifyHead(): void;
	/**
	 * Re-run admission for every parked call. When `grant` is provided the
	 * grant covers one parked action class. Calls admitted on retry
	 * execute and their original promise resolves with the result. Calls still
	 * waiting for confirmation stay parked.
	 */
	resumeParkedCalls(grant?: OneShotGrant): Promise<void>;
	/**
	 * Resolve one parked call with a `blocked` verdict carrying `reason`.
	 * Returns true when the request was found.
	 */
	cancelParkedCall(requestId: string, reason: string): boolean;
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
	onPermissionRequired(
		listener: (call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void,
	): () => void;
	/**
	 * Subscribe to the signal fired when the autonomy mapping auto-denies a
	 * call (deny dispositions, today only at read-only). The verdict already
	 * carries the rejection; this exists for operator-facing notices.
	 */
	onAutonomyDenied(listener: (call: ClassifierCall, decision: SafetyDecision, level: AutonomyLevel) => void): () => void;
}

export type RegistryVerdict =
	| { kind: "ok"; result: ToolResult; decision: SafetyDecision }
	| { kind: "blocked"; reason: string; decision: SafetyDecision }
	| { kind: "not_visible"; reason: string };

interface ParkedCall {
	call: ClassifierCall;
	decision: SafetyDecision;
	meta: PermissionRequiredMeta;
	resolve: (verdict: RegistryVerdict) => void;
	options?: ToolInvokeOptions;
	abortCleanup?: () => void;
}

export function createRegistry(deps: RegistryDeps): ToolRegistry {
	const tools = new Map<ToolName, ToolSpec>();
	const parked: ParkedCall[] = [];
	const permissionListeners = new Set<
		(call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void
	>();
	const autonomyDeniedListeners = new Set<
		(call: ClassifierCall, decision: SafetyDecision, level: AutonomyLevel) => void
	>();
	let approvalRequestCounter = 0;
	const approvalRequestToken = randomBytes(4).toString("hex");

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
		if (block) {
			const verdict = guardBlockedVerdict(decision, call.tool, block.reason);
			recordRegistryDisposition(call, verdict.decision, "blocked", {
				reasonCode: GUARD_BLOCK_REASON_CODE,
				reasons: [block.reason],
			});
			return verdict;
		}
		try {
			const preparedArgs = prepareToolArgs(spec, call.args ?? {});
			const result = shapeToolResult(spec, await spec.run(preparedArgs, options), options);
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
		| { kind: "park"; decision: SafetyDecision; axis: string };

	const admit = (call: ClassifierCall, grant?: OneShotGrant, options?: ToolInvokeOptions): AdmitOutcome => {
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
		// Stage 1.5, the skill tool surface: a loaded SKILL.md that declares
		// allowed-tools or disallowed-tools narrows the surface until the
		// policy's lifetime ends (turn end for the main agent, run end for
		// workers). Narrowing only blocks; it never grants, and an out-of-
		// surface call blocks terminally instead of parking for confirmation.
		const surfaceViolation = evaluateSkillToolSurface(options?.pendingSkillPolicy, call.tool);
		if (surfaceViolation) {
			const verdict = skillSurfaceBlockedVerdict(decision, call.tool, surfaceViolation);
			recordRegistryDisposition(call, verdict.decision, "blocked", {
				reasonCode: "skill_surface",
				reasons: [verdict.reason],
			});
			return { kind: "terminal", verdict };
		}
		const actionClass = decision.classification.actionClass;
		if (decision.kind === "ask") {
			if (level === "read-only") {
				const verdict = autonomyDenyVerdict(decision, level, call.tool, actionClass);
				recordRegistryDisposition(call, verdict.decision, "denied", { reasonCode: `autonomy:${level}` });
				notifyAutonomyDenied(call, verdict.decision, level);
				return { kind: "terminal", verdict };
			}
			if (grant?.actionClass === actionClass) return { kind: "execute", spec, decision };
			return { kind: "park", decision, axis: approvalAxisId(decision, level) };
		}
		// One-shot grant: resumeParkedCalls re-admits exactly the parked call
		// the operator approved, with a confirmed posture. The engine converts
		// its confirm rail to an allow (including M3 git ask rules), so the
		// grant match executes directly instead of re-entering the mapping.
		if (grant?.actionClass === actionClass) {
			return { kind: "execute", spec, decision };
		}
		if (actionClass === "git_destructive") {
			recordRegistryDisposition(call, decision, "blocked", {
				reasons: [`action ${actionClass} is hard-blocked`],
				reasonCode: "classification:git_destructive",
			});
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
		// decides run / ask / deny per action class. Plan-scale dispatch calls
		// (multi-task, compete, remote node) carry the plan flag so supervised
		// levels route them through one plan approval.
		const planScale = call.tool === ToolNames.Dispatch && isPlanScaleDispatchArgs(call.args);
		const disposition = mapAutonomy(level, actionClass, {
			executeRecognized: decision.policy?.execRecognition !== "unrecognized",
			...(planScale ? { dispatchPlanScale: true } : {}),
		});
		if (disposition === "deny") {
			const verdict = autonomyDenyVerdict(decision, level, call.tool, actionClass);
			recordRegistryDisposition(call, verdict.decision, "denied", { reasonCode: `autonomy:${level}` });
			notifyAutonomyDenied(call, verdict.decision, level);
			return { kind: "terminal", verdict };
		}
		if (disposition === "ask") {
			const askDecision = planScale
				? toDispatchPlanAskDecision(decision, level, call)
				: toAutonomyAskDecision(decision, level, call.tool, actionClass);
			return { kind: "park", decision: askDecision, axis: approvalAxisId(askDecision, level) };
		}
		recordRegistryDisposition(call, decision, "allowed");
		return { kind: "execute", spec, decision };
	};

	const recordRegistryDisposition = (
		call: ClassifierCall,
		decision: SafetyDecision,
		auditDecision: "allowed" | "blocked" | "permission_requested" | "denied",
		overrides?: { reasons?: ReadonlyArray<string>; reasonCode?: string; requestId?: string },
	): void => {
		// Row sequence for net-pass calls: safety.evaluate writes `classified`;
		// registry admission writes the final autonomy disposition. Confirmed
		// re-admissions keep their existing `allowed` row from safety.evaluate.
		// When the registry, not the policy engine, made the final call, the
		// caller passes a reasonCode override so the row does not repeat the
		// net pass's "allowed" code on a non-allowed decision.
		const reasons = overrides?.reasons;
		deps.safety.audit.recordToolCall?.({
			tool: call.tool,
			classification: decision.classification,
			decision: auditDecision,
			args: call.args,
			...(overrides?.requestId !== undefined ? { requestId: overrides.requestId } : {}),
			...(decision.policy !== undefined ? { policy: decision.policy } : {}),
			...(overrides?.reasonCode !== undefined ? { reasonCode: overrides.reasonCode } : {}),
			...(reasons !== undefined ? { reasons } : decision.kind === "allow" ? {} : { reasons: [decision.rejection.detail] }),
		});
	};

	/**
	 * Loop-observe a safety-blocked attempt. The verdict stands and every
	 * effect is discarded; this exists so the before_tool loop guard sees
	 * rejected attempts too. Without it, a model repeating an identical
	 * blocked call would never trip the detector (the former worker guard sat
	 * in front of admission and had this coverage).
	 */
	const observeBlockedAttempt = (
		call: ClassifierCall,
		verdict: RegistryVerdict,
		options?: ToolInvokeOptions,
	): RegistryVerdict | null => {
		if (verdict.kind !== "blocked") return null;
		return guardOverrideForRejectedAttempt(
			call,
			verdict.decision,
			observeRejectedAttempt(call, verdict.decision, options),
		);
	};

	/**
	 * Run before_tool hooks for an attempt that will not execute, so repetition
	 * detectors see it. Most effects do not change the rejection itself; the
	 * worker tool-call cap is the exception, because it is the deterministic
	 * run bound for denied-call spirals. The returned value is the first
	 * block_tool reason (the loop guard's actionable feedback), which the
	 * park-denial path substitutes for its generic reason so a model retrying a
	 * denied call learns to stop instead of looping until the run times out.
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

	const guardOverrideForRejectedAttempt = (
		call: ClassifierCall,
		decision: SafetyDecision,
		reason: string | null,
	): RegistryVerdict | null => {
		if (reason === null || !isWorkerToolCallCapExceededReason(reason)) return null;
		const verdict = guardBlockedVerdict(decision, call.tool, reason);
		recordRegistryDisposition(call, verdict.decision, "blocked", {
			reasonCode: GUARD_BLOCK_REASON_CODE,
			reasons: [reason],
		});
		return verdict;
	};

	const cleanupParkedEntry = (entry: ParkedCall): void => {
		entry.abortCleanup?.();
		delete entry.abortCleanup;
	};

	const resolveParkedAsBlocked = (entry: ParkedCall, reason: string): void => {
		cleanupParkedEntry(entry);
		// A denied/cancelled park is still a model attempt: observe it so
		// identical retries trip the loop detector. When the detector fires, its
		// reason replaces the generic denial so the model gets recovery guidance.
		const loopReason = observeRejectedAttempt(entry.call, entry.decision, entry.options);
		entry.resolve(
			guardOverrideForRejectedAttempt(entry.call, entry.decision, loopReason) ?? {
				kind: "blocked",
				reason: loopReason ?? reason,
				decision: entry.decision,
			},
		);
	};

	const reparkEntry = (entry: ParkedCall, index?: number): void => {
		if (index === undefined || index < 0 || index >= parked.length) {
			parked.push(entry);
			return;
		}
		parked.splice(index, 0, entry);
	};

	const nextApprovalRequestId = (): string => `apr-${approvalRequestToken}-${++approvalRequestCounter}`;

	const notifyPermissionRequired = (
		call: ClassifierCall,
		decision: SafetyDecision,
		meta: PermissionRequiredMeta,
	): void => {
		for (const listener of permissionListeners) {
			try {
				listener(call, decision, meta);
			} catch {
				// Listener errors never abort admission; they are surfaced via
				// whatever observability the caller wires up.
			}
		}
	};

	const notifyAutonomyDenied = (call: ClassifierCall, decision: SafetyDecision, level: AutonomyLevel): void => {
		for (const listener of autonomyDeniedListeners) {
			try {
				listener(call, decision, level);
			} catch {
				// Same contract as permission listeners: never abort admission.
			}
		}
	};

	const cancelParkedCallById = (requestId: string, reason: string): boolean => {
		const index = parked.findIndex((entry) => entry.meta.requestId === requestId);
		if (index === -1) return false;
		const [entry] = parked.splice(index, 1);
		if (!entry) return false;
		resolveParkedAsBlocked(entry, reason);
		const next = parked[0];
		if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		return true;
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
			const admissionCall = prepareAdmissionCall(tools.get(call.tool as ToolName), call);
			const outcome = admit(admissionCall, undefined, options);
			if (outcome.kind === "terminal") {
				return observeBlockedAttempt(admissionCall, outcome.verdict, options) ?? outcome.verdict;
			}
			if (outcome.kind === "execute") return runSpec(outcome.spec, admissionCall, outcome.decision, options);
			const abortReason = "run aborted before the operator decided";
			if (options?.signal?.aborted) {
				const loopReason = observeRejectedAttempt(admissionCall, outcome.decision, options);
				return { kind: "blocked", reason: loopReason ?? abortReason, decision: outcome.decision };
			}
			return new Promise<RegistryVerdict>((resolve) => {
				const meta: PermissionRequiredMeta = {
					requestId: nextApprovalRequestId(),
					axis: outcome.axis,
					...(options?.toolCallId !== undefined && options.toolCallId.length > 0 ? { toolCallId: options.toolCallId } : {}),
				};
				recordRegistryDisposition(admissionCall, outcome.decision, "permission_requested", { requestId: meta.requestId });
				const parkedCall: ParkedCall = { call: admissionCall, decision: outcome.decision, meta, resolve };
				if (options !== undefined) parkedCall.options = options;
				if (options?.signal) {
					const onAbort = (): void => {
						cancelParkedCallById(meta.requestId, abortReason);
					};
					options.signal.addEventListener("abort", onAbort, { once: true });
					parkedCall.abortCleanup = () => {
						options.signal?.removeEventListener("abort", onAbort);
					};
				}
				parked.push(parkedCall);
				notifyPermissionRequired(admissionCall, outcome.decision, meta);
			});
		},
		hasParkedCalls: () => parked.length > 0,
		parkedCount: () => parked.length,
		renotifyHead() {
			const next = parked[0];
			if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		},
		async resumeParkedCalls(grant?: OneShotGrant) {
			if (parked.length === 0) return;
			const pending: Array<{ entry: ParkedCall; reparkIndex?: number }> = [];
			if (grant === undefined) {
				pending.push(...parked.splice(0, parked.length).map((entry) => ({ entry })));
			} else if (grant.requestId !== undefined) {
				const index = parked.findIndex((entry) => entry.meta.requestId === grant.requestId);
				if (index === -1) {
					const next = parked[0];
					if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
					return;
				}
				const [entry] = parked.splice(index, 1);
				if (entry) pending.push({ entry, reparkIndex: index });
			} else {
				const [entry] = parked.splice(0, 1);
				if (entry) pending.push({ entry });
			}
			for (const { entry, reparkIndex } of pending) {
				// A one-shot grant covers only the parked call it selected. Calls
				// that parked while the overlay was already open remain queued and
				// need their own confirmation, so a concurrent privileged call
				// cannot ride along on a grant approved for another call.
				if (grant !== undefined && entry.decision.classification.actionClass !== grant.actionClass) {
					reparkEntry(entry, reparkIndex);
					continue;
				}
				const outcome = admit(entry.call, grant, entry.options);
				if (outcome.kind === "park") {
					reparkEntry(entry, reparkIndex);
					continue;
				}
				cleanupParkedEntry(entry);
				if (outcome.kind === "terminal") {
					entry.resolve(observeBlockedAttempt(entry.call, outcome.verdict, entry.options) ?? outcome.verdict);
					continue;
				}
				const approvedOptions: ToolInvokeOptions | undefined =
					grant === undefined
						? entry.options
						: {
								...(entry.options ?? {}),
								approval: {
									requestId: entry.meta.requestId,
									requestedBy: grant.requestedBy,
									actionClass: grant.actionClass,
								},
							};
				entry.resolve(await runSpec(outcome.spec, entry.call, outcome.decision, approvedOptions));
			}
			const next = parked[0];
			if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		},
		cancelParkedCall(requestId, reason) {
			return cancelParkedCallById(requestId, reason);
		},
		cancelParkedCalls(reason) {
			if (parked.length === 0) return;
			const pending = parked.splice(0, parked.length);
			for (const entry of pending) {
				resolveParkedAsBlocked(entry, reason);
			}
		},
		onPermissionRequired(listener) {
			permissionListeners.add(listener);
			return () => {
				permissionListeners.delete(listener);
			};
		},
		onAutonomyDenied(listener) {
			autonomyDeniedListeners.add(listener);
			return () => {
				autonomyDeniedListeners.delete(listener);
			};
		},
	};
}

/**
 * Run a tool's optional `prepareArguments` normalizer before its body. A
 * throwing or non-object result is discarded so a buggy normalizer can never
 * abort admission; the raw args pass through unchanged.
 */
function prepareToolArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
	if (!spec.prepareArguments) return args;
	try {
		const prepared = spec.prepareArguments(args);
		return prepared !== null && typeof prepared === "object" && !Array.isArray(prepared) ? prepared : args;
	} catch {
		return args;
	}
}

function prepareAdmissionCall(spec: ToolSpec | undefined, call: ClassifierCall): ClassifierCall {
	if (!spec?.prepareAdmissionArguments) return call;
	try {
		const prepared = spec.prepareAdmissionArguments(call.args ?? {});
		if (prepared === null || typeof prepared !== "object" || Array.isArray(prepared)) return call;
		return { ...call, args: prepared };
	} catch {
		return call;
	}
}

function applyRegisteredToolClassification(decision: SafetyDecision, spec: ToolSpec): SafetyDecision {
	if (decision.classification.actionClass !== "unknown") return decision;
	const classification = {
		actionClass: spec.baseActionClass,
		reasons: [`registered tool: ${spec.name}`],
	};
	return decision.kind === "allow" ? { kind: "allow", classification } : { ...decision, classification };
}

/** Final reason code for a before_tool guard block, matching the audit convention (sd-01 §2.5). */
const GUARD_BLOCK_REASON_CODE = "guard_block";

/**
 * Terminal blocked verdict for a before_tool guard block (loop guard,
 * protected artifacts, dispatch dedup, declarative block rules) on a call
 * whose admission already passed. The decision is re-shaped as a block, and
 * the carried policy's net-pass reasonCode is replaced with the guard axis,
 * so downstream consumers (worker finish events, dispatch receipts, audit)
 * count a blocked safety decision instead of repeating the admission's allow.
 */
function guardBlockedVerdict(
	decision: SafetyDecision,
	tool: string,
	reason: string,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const blocked: SafetyDecision = {
		kind: "block",
		classification: decision.classification,
		rejection: {
			short: `${tool} blocked: tool guard`,
			detail: reason,
			hints: [],
		},
		...(decision.policy !== undefined ? { policy: { ...decision.policy, reasonCode: GUARD_BLOCK_REASON_CODE } } : {}),
	};
	return { kind: "blocked", reason, decision: blocked };
}

/**
 * Terminal blocked verdict for a call outside the merged tool surface the
 * loaded skills declared. The reason carries the remediation, since blocked
 * reasons are what the model reads; context and ask_user stay exempt at
 * the evaluator so the message can honestly point at ask_user.
 */
function skillSurfaceBlockedVerdict(
	decision: SafetyDecision,
	tool: string,
	violation: SkillToolSurfaceViolation,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const reason =
		violation.disallowedBy.length > 0
			? `${tool} is disallowed by the active skill(s) ${violation.disallowedBy.join(", ")} (disallowed-tools). The narrowing ends when the skill policy's turn or worker run ends. Work within the skill workflow; if it genuinely needs this step, use ask_user when available or state the blocker in your reply.`
			: `${tool} is outside the tool surface declared by the active skill(s) ${violation.skills.join(", ")}. Tools are narrowed to: ${(violation.mergedAllowedTools ?? []).join(", ")} (plus context and ask_user). The narrowing ends when the skill policy's turn or worker run ends. Work within the skill workflow; if it genuinely needs this step, use ask_user when available or state the blocker in your reply.`;
	const blocked: SafetyDecision = {
		kind: "block",
		classification: decision.classification,
		rejection: {
			short: `${tool} blocked: outside active skill tool surface`,
			detail: reason,
			hints: ["Skill narrowing never grants tools; it only blocks calls outside the declared workflow surface."],
		},
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
	return { kind: "blocked", reason, decision: blocked };
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

/**
 * Plan-approval ask for a plan-scale dispatch call. The rejection detail IS
 * the plan artifact (topology, per-task agent/model/node), so the approval
 * overlay shows the operator exactly what one approval will launch.
 */
function toDispatchPlanAskDecision(
	decision: SafetyDecision,
	level: AutonomyLevel,
	call: ClassifierCall,
): SafetyDecision {
	const plan = describeDispatchPlan(call.args);
	return {
		kind: "ask",
		classification: decision.classification,
		rejection: {
			short: `dispatch plan needs approval (${plan.topology}, ${plan.taskCount} task(s)) at autonomy ${level}`,
			detail: `Approving this call approves the whole plan:\n${plan.text}`,
			hints: [
				"One approval covers every run in the plan, including remote placements.",
				"Deny to keep the fleet idle and revise the plan first.",
			],
		},
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
		// Result identity for the stagnation detector (engine/loop-guard.ts):
		// consecutive same-shape calls whose outputs hash identically are not
		// producing new information, whatever their size arguments say.
		if (result.kind === "ok" && typeof result.output === "string") {
			metadata.resultFingerprint = createHash("sha256").update(result.output).digest("hex");
			metadata.resultBytes = Buffer.byteLength(result.output, "utf8");
		}
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
