import { createHash, randomBytes } from "node:crypto";
import type { TSchema } from "typebox";
import { isWorkerToolCallCapExceededReason } from "../core/guardrails.js";
import { HEADLESS_PERMISSION_DENIED_MARKER } from "../core/headless-permission.js";
import { normalizePromptHint } from "../core/prompt-hint.js";
import type { PendingSkillToolPolicy, SkillToolSurfaceViolation } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { containsInstructionMarkers, INSTRUCTION_SHAPED_WARNING } from "../core/untrusted-content.js";
import type { MiddlewareContract } from "../domains/middleware/contract.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareMetadataValue } from "../domains/middleware/types.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import {
	type AdmissionDisposition,
	type AdmissionGitContext,
	type AdmissionPrincipal,
	type ApprovalAuthority,
	evaluateAdmission,
} from "../domains/safety/admission.js";
import { approvalAxisId } from "../domains/safety/approval-axis.js";
import { type AutonomyExposure, type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../domains/safety/autonomy.js";
import { describeCallTarget } from "../domains/safety/call-target.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import type { DecisionPresentation } from "../domains/safety/decision-presentation.js";
import type { FlowRestrictionSet } from "../domains/safety/information-flow.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	evaluateInformationFlow,
	isFlowRestrictionSet,
	mergeFlowRestrictions,
	resolveToolDestination,
} from "../domains/safety/information-flow.js";
import { SYSTEM_ONE_GATE_RULE_ID } from "../domains/safety/decision-presentation.js";
import { hashToolCall } from "../domains/safety/loop-detector.js";
import { detectValidationCommand } from "../domains/safety/protected-artifacts.js";
import { screensToolResult } from "../domains/system-one/sites/tool-result.js";
import type { ImageContent } from "../engine/types.js";
import { withApprovalNote } from "./approval-note.js";
import { askUserExposure } from "./ask-user.js";
import { type DispatchPlanView, describeDispatchPlan } from "./dispatch-plan.js";
import type { ToolPresentationPolicy } from "./presentation.js";
import type { ToolResultDigest, ToolResultDisposition } from "./result-disposition.js";
import { DEFAULT_TOOL_RESULT_MAX_BYTES, shapeToolResult, toolResultDigestFor } from "./result-shaping.js";
import { type ToolPlacement, toolSpecPlacement } from "./surface.js";

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
export type ToolPromptHintRole = "session" | "worker" | "bound-worker";

export interface ToolPromptHintVariants {
	session?: string;
	worker?: string;
	boundWorker?: string;
}

export type ToolPromptHintMetadata = string | ToolPromptHintVariants;

/** Worked examples, never part of the permanently attached tool schema. */
export interface ToolUsageExample {
	goal: string;
	args: Readonly<Record<string, unknown>>;
	/** Also show this one call in the reachable capability's compact orientation. */
	startup?: boolean;
}

/** Resolve one tool's guidance for the exact prompt role being compiled. */
export function resolveToolPromptHint(
	hint: ToolPromptHintMetadata | undefined,
	role: ToolPromptHintRole,
): string | undefined {
	if (typeof hint === "string") return normalizePromptHint(hint);
	if (!hint) return undefined;
	const selected =
		role === "session" ? hint.session : role === "bound-worker" ? (hint.boundWorker ?? hint.worker) : hint.worker;
	return normalizePromptHint(selected);
}

export interface ToolSourceInfo {
	path: string;
	scope: ToolSourceScope;
	/** Verified installed capability identity, when this is a harness extension tool. */
	extension?: import("../domains/extensions/types.js").ExtensionProvenance;
}

export interface ToolResultSizePolicy {
	kind: "exact" | "bounded" | "summary" | "truncate";
	maxBytes?: number;
	/** Scratch retention ceiling for this tool; defaults to the generic 10 MiB cap. */
	offloadMaxBytes?: number;
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
	/** Independent operator-presentation and model-context policy for this result. */
	resultDisposition?: ToolResultDisposition;
	/** Coarse cost/latency bucket for dashboard diagnostics. */
	costLatency: ToolCostLatencyClass;
	/**
	 * One sentence of usage guidance rendered when this tool is on the frozen
	 * surface. A string applies to every role; variants keep session consent
	 * rules out of ordinary and recipe-bound workers. Most tools need none.
	 */
	promptHint?: ToolPromptHintMetadata;
	/** Compact capability orientation for coordinators, even when its schema is behind gateway. */
	discoveryHint?: string;
	/** Small worked calls disclosed by the gateway and checked against parameters. */
	examples?: ReadonlyArray<ToolUsageExample>;
	/**
	 * How transcript surfaces present this tool's block under Standard output style.
	 * Optional: tools that declare nothing fold like every other tool.
	 */
	presentation?: ToolPresentationPolicy;
}

export interface ToolSpec {
	name: ToolName;
	description: string;
	sourceInfo?: ToolSourceInfo;
	metadata?: ToolMetadata;
	/**
	 * Which surface carries this tool: `direct` attaches its schema on every
	 * turn, `gateway` hides it behind `gateway` find/describe/call. Absent means
	 * the name's placement in src/tools/surface.ts. Placement changes what the
	 * model sees, never admission: `invoke` runs any registered spec by name.
	 */
	placement?: ToolPlacement;
	/**
	 * TypeBox schema advertised to the model so it knows which named
	 * parameters the tool accepts. Must be a Type.Object(...). Runtime
	 * validation still happens inside `run()`, so the schema is advisory
	 * to the model, not an enforcement boundary.
	 */
	parameters: TSchema;
	/** Smaller attached schema; canonical validation and gateway describe retain parameters. */
	modelParameters?: TSchema;
	/** Base action class for this tool when arguments are trivial. */
	baseActionClass: ActionClass;
	/** A safety-net confirmation required at every autonomy level. */
	confirmationRuleId?: string;
	/** Harness-owned projection of executable effects for the safety engine. Never package-supplied code. */
	safetyCall?(args: Record<string, unknown>): ClassifierCall | undefined;
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
	 * Resolve an argument-sensitive canonical disposition after normalization
	 * and before execution. The registry applies the result exactly once after
	 * middleware has annotated the terminal result.
	 */
	resolveResultDisposition?(
		args: Record<string, unknown>,
		declared: ToolResultDisposition | undefined,
	): ToolResultDisposition | undefined;
	/**
	 * Synchronous admission planner. Unlike `prepareArguments`, this runs before
	 * safety/autonomy mapping so approval-sensitive tools can attach the exact
	 * immutable artifact—and provisional resources—that admission and execution
	 * share. Resource owners must pair it with `disposeAdmissionArguments`.
	 */
	prepareAdmissionArguments?(args: Record<string, unknown>): Record<string, unknown>;
	/** Release provisional resources when prepared admission is denied or execution returns. */
	disposeAdmissionArguments?(args: Record<string, unknown>): void;
	/** Trusted admission artifact renderer used by policy after preparation. */
	describeDispatchPlan?(args: Record<string, unknown>): DispatchPlanView;
	/**
	 * Host commands this call will run as its caller outside its own body, read
	 * from prepared admission arguments. Each is admitted as the direct call it
	 * stands for, at the caller's autonomy and never under a one-shot grant for
	 * this call. Any that would park or be blocked refuses this call outright,
	 * with a hard block reported first (F6).
	 */
	hostEffectCalls?(args: Record<string, unknown>): ReadonlyArray<HostEffectCall>;
	/** Execute the tool. Only called after admission. */
	run(args: Record<string, unknown>, options?: ToolInvokeOptions): Promise<ToolResult>;
}

export type ToolResultDetails = Record<string, unknown>;

export type ToolResult =
	| {
			kind: "ok";
			output: string;
			/** Bounded visual evidence accompanying the mandatory text result. */
			images?: ImageContent[];
			details?: ToolResultDetails;
			/** Internal registry projection consumed only by the agent-tool adapter. */
			modelContext?: string;
			/**
			 * Early-termination hint propagated to pi-agent-core's
			 * `AgentToolResult.terminate`. When every finalized tool result in
			 * the current batch sets this to true, the agent loop stops without
			 * a follow-up LLM call. Used by terminal artifact writers where
			 * writing the artifact is the whole turn.
			 */
			terminate?: boolean;
	  }
	| { kind: "error"; message: string; details?: ToolResultDetails; modelContext?: string };

/** What the yolo gate is told about a call: the card's own allowlisted, redacted one-line description. */
export interface ToolCallGateSubject {
	readonly tool: string;
	readonly actionClass: string;
	readonly target: string;
}

/** The gate's opinion. It can only ask for more friction, never remove any. */
export interface ToolCallGateVerdict {
	readonly escalate: boolean;
	readonly reason: string;
	/** The build that answered, as its decision record names it. The card and the transcript rows state it. */
	readonly build?: string;
}

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
	 * Provider-routing effects emitted by tool hooks apply to the next model
	 * round. The registry owns those hook calls, so it forwards the complete
	 * effect batch to the composition root after evaluation. Consumers may only
	 * narrow routing (`require_tool` / `lock_tools`); admission still happens
	 * through this registry on the resulting call.
	 */
	onMiddlewareEffects?: (effects: ReadonlyArray<MiddlewareEffect>, input: MiddlewareHookInput) => void;
	/**
	 * Live autonomy level (sd-01 §2.2). Read per admission so hot-reloaded
	 * settings apply to the next call. The orchestrator wires this to current
	 * settings; workers always wire it to default.
	 * Absent means the default operator mode.
	 */
	autonomy?: () => AutonomyLevel;
	/**
	 * Whose calls this registry admits. Worker execute authority comes from
	 * its bound permit, not this autonomy callback. Only its autonomy asks may
	 * later be answered by the main agent. Absent means the main agent.
	 */
	principal?: AdmissionPrincipal;
	workerExecuteAutonomy?: "yolo";
	/** Dispatch-owned restriction, fixed for the lifetime of this run. */
	readOnly?: boolean;
	/**
	 * The worker's standing Git allowance and attested task worktree (Phase C).
	 * Read only when `principal` is worker; the git tool body receives it too,
	 * so a typed mutation re-attests right before Git runs.
	 */
	git?: AdmissionGitContext;
	/**
	 * Reads external content (a fetched page, an MCP result, worker text) for
	 * instructions aimed at an agent, and returns a banner to put in front of the
	 * result, or null. It only tightens: the deterministic marker scan runs
	 * regardless, and a null, a failure or a slow answer leaves the result as it
	 * was. Awaited between the tool body and the `after_tool` hook, so its own
	 * deadline is the most it can add to a call. Absent in workers.
	 */
	screenToolResult?: (
		source: string,
		content: string,
		ref: string | undefined,
		signal: AbortSignal | undefined,
		restrictions: FlowRestrictionSet | null,
	) => Promise<string | null>;
	/**
	 * The session's information-flow ledger. `carried` is what the context
	 * already holds, judged before a mediated outbound call (web_fetch,
	 * web_read, an MCP tool) runs; `absorb` records what a restricted read
	 * just added, before its result is screened or returned. Absent means an
	 * unrestricted session (a worker passes its own run-scoped ledger).
	 */
	flow?: {
		carried(): FlowRestrictionSet | null;
		/** Why provenance cannot be vouched for (unreadable or unpersisted ledger), or null. */
		refusal(): string | null;
		/** The gateway's pinned launch identity for an MCP tool, when a gateway is attached. */
		mcpTransport?(tool: string): string | null;
		absorb(set: FlowRestrictionSet, origin: { tool?: string; toolCallId?: string }): void;
	};
	/**
	 * Asked when autonomy is yolo and an execute-class call was admitted as
	 * unrecognized, before it runs. An escalating verdict parks the call for a
	 * one-shot confirmation card that shows the reason, but only where
	 * `gateParks` is set. `ref` is the permission request id the card would
	 * carry, so the decision joins the operator's answer. Only the interactive
	 * TUI registry passes it. Headless and ACP pass none: they have no operator
	 * to answer a card, so asking would cost up to the site deadline per
	 * unrecognized execute call and record a verdict nobody can label, and
	 * without it the call runs as it did before the gate existed. Absent in workers.
	 */
	gateToolCall?: (
		subject: ToolCallGateSubject,
		ref: string | undefined,
		signal: AbortSignal | undefined,
	) => Promise<ToolCallGateVerdict | null>;
	/**
	 * True only on the interactive session's registry, the one registry given a
	 * `gateToolCall`. A registry that has a gate but no operator to answer it
	 * records the verdict and lets the call proceed.
	 */
	gateParks?: boolean;
}

/**
 * Keeps the operator's screen reserved across the rounds of one harness card, so
 * a model question cannot take it between two of them. Created and released by
 * the card's owner, never derived from model arguments.
 */
export interface HarnessHold {
	/** Ends the reservation; later calls do nothing. */
	release(): void;
	/** Runs once when the reservation ends, immediately if it already has. */
	onRelease(listener: () => void): void;
}

export function createHarnessHold(): HarnessHold {
	let released = false;
	const listeners: Array<() => void> = [];
	return {
		release() {
			if (released) return;
			released = true;
			for (const listener of listeners.splice(0)) listener();
		},
		onRelease(listener) {
			if (released) listener();
			else listeners.push(listener);
		},
	};
}

export interface ToolInvokeOptions {
	/** An invocation the harness runner makes on its own decision; never derived from model arguments. */
	origin?: "harness";
	/** With `origin: "harness"`, the card whose rounds this is. */
	harnessHold?: HarnessHold;
	/** Host-owned task scope, preserved on nested gateway calls. */
	turnConstraints?: TurnConstraints;
	/** Registry-owned filter bound to the active compiled safety policy. */
	allowsObservationPath?: (path: string) => boolean;
	/** Registry-owned write-root check the typed mutation seam repeats right before it publishes (F3). */
	writeTargetViolation?: (target: string) => string | null;
	/** Registry-owned worker Git context; the git tool re-attests a typed mutation with it. */
	gitContext?: AdmissionGitContext;
	/**
	 * Registry-owned information-flow check for every URL a fetch actually
	 * connects to, redirect hops included. Returns the block reason or null.
	 * Present only while the session carries restricted content.
	 */
	flowAdmitsUrl?: (url: string) => string | null;
	/** Trusted submitting host identity for nested dispatch; never model arguments. */
	hostRun?: import("../domains/dispatch/contract.js").DispatchPreparationOptions["hostRun"];
	/** Trusted resolved model capability; never read from tool arguments. */
	supportsImages?: boolean;
	signal?: AbortSignal;
	runId?: string;
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	correlationId?: string;
	/** Session-effective ceiling for one tool result, read again before every invocation. */
	toolResultMaxBytes?: number;
	pendingSkillPolicy?: PendingSkillToolPolicy;
	askUserPolicy?: AskUserToolPolicy;
	/** Host-derived display copy for an ask_user round. It has no admission authority. */
	decisionPresentation?: DecisionPresentation;
	/** Registry-authenticated one-shot operator approval for this execution. */
	approval?: { requestId: string; requestedBy: string; actionClass: ActionClass };
	/**
	 * True for an invocation a tool body makes on the model's behalf (the
	 * gateway calling the capability it was asked for). The nested call keeps
	 * its own admission, hooks, and evidence; the flag only tells the loop
	 * guard that the model's one call has already been counted.
	 */
	nested?: boolean;
	/**
	 * The capability surface this run was admitted to, when the run is
	 * narrower than the registry (a worker). The gateway refuses to call any
	 * capability outside it, so a recipe's declared tools bound the gateway
	 * exactly as they bound the attached schemas.
	 */
	allowedTools?: ReadonlyArray<ToolName>;
	/**
	 * How long this call sat parked awaiting an operator decision, reported when
	 * the park resolves. A caller timing the invocation is measuring the tool,
	 * and the park is the operator, so the two have to be separable: without
	 * this a `npm test` approved after a minute of reading was recorded as a
	 * one-minute test run in the transcript, the receipt, and toolStats.
	 */
	onParked?: (parkedMs: number) => void;
	/**
	 * Display-only cumulative progress supplied by pi-agent-core's
	 * `AgentToolUpdateCallback`. Tool bodies may report the result snapshot the
	 * operator should see while the call runs. Admission, final result shaping,
	 * telemetry, and ledger persistence continue to consume only the terminal
	 * return value.
	 */
	onUpdate?: (partialResult: ToolResult) => void;
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
	/** The whole answer on one line: the chosen labels, then the typed text. */
	answer: string;
	/**
	 * The option labels the operator chose, in list order. Absent when they only
	 * typed. Present with no {@link value} is a label-only answer.
	 */
	options?: string[];
	/**
	 * The operator's typed text, exactly as submitted. Absent when they only
	 * chose. Recording an option label without this is what lost the figures in
	 * issue #228.
	 */
	value?: string;
}

export interface AskUserTranscriptDecision {
	key: string;
	value: string;
	label?: string;
	/** The chosen labels behind {@link value}, when the answer had any. Harness-derived. */
	options?: string[];
	/** The typed text behind {@link value}, when the answer had any. Harness-derived. */
	text?: string;
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
	planOnly?: boolean;
	id: string;
	status: AskUserInterviewStatus;
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
	sessionId?: string;
	turnId?: string;
	transcriptPath?: string;
	/** Monotonic exposure fact for live presentation and durable replay. */
	exposure?: AutonomyExposure;
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
	/**
	 * Surface that released the call: `tool:one_shot` (TUI card), `acp-client`,
	 * `escalation:operator` or `escalation:remembered`. It is carried into audit
	 * and decides the wording of the note the model reads (`approval-note.ts`).
	 * It is audit text, never authority: the issuer below decides what clears.
	 */
	requestedBy: string;
	/**
	 * Who issued the grant. Absent means the operator, which every current
	 * surface is. A `main` grant can discharge only an ask whose approval
	 * authority is `main`; an operator rail stays parked under it.
	 */
	issuer?: ApprovalAuthority;
	/**
	 * Observes the one parked call a `requestId` grant selected: it started,
	 * it finished, or it was not executed. A live grant reports execution
	 * separately from the decision (Phase D); "decision delivered" is not
	 * "tool executed".
	 */
	onExecution?: (event: GrantExecutionEvent) => void;
}

export type GrantExecutionEvent =
	| { phase: "start" }
	| { phase: "end"; outcome: "ok" | "error" | "blocked" }
	| { phase: "not_executed"; reason: string };

export interface PermissionRequiredMeta {
	requestId: string;
	axis: string;
	/**
	 * Who may answer this park. Every safety-net rail and tool confirmation is
	 * `operator`; only a worker's autonomy ask is `main`.
	 */
	approvalAuthority: ApprovalAuthority;
	sessionId?: string;
	turnId?: string;
	/**
	 * Provider tool-call id carried on the parked call's invoke options, when
	 * one exists. The interactive layer uses it to correlate the park to its
	 * transcript tool segment so a parked call renders as awaiting approval
	 * instead of running. Purely descriptive: park/resume semantics never
	 * read it.
	 */
	toolCallId?: string;
	/**
	 * The plan admission rendered for a dispatch call, the same view whose hash
	 * a plan-scale run seals. Carried so a surface shows the operator what
	 * admission judged rather than re-rendering it from the arguments.
	 */
	dispatchPlan?: DispatchPlanView;
	/**
	 * Set when the System One gate raised this park, to the reason it gave. That
	 * reason is the card's whole advisory and the card asks no second site: the
	 * gate's decision is already on the ledger under `requestId`, and a second
	 * reading of the same command only adds latency and a line that can
	 * contradict the reason the card exists.
	 */
	gateReason?: string;
	/** The build that gave `gateReason`, so the card and the transcript rows can say whose judgment it was. */
	gateBuild?: string;
}

/** One host command a tool runs on its caller's behalf, as the direct call it stands for. */
export interface HostEffectCall {
	/** Operator-facing name for the effect, used in the refusal text. */
	label: string;
	call: ClassifierCall;
}

export interface ToolRegistry {
	register(spec: ToolSpec): void;
	/** Remove a session scoped dynamic capability after its owner closes. */
	unregister?(name: ToolName): void;
	/** Direct-placed tools: the ones whose schemas the model sees attached. */
	listVisible(): ReadonlyArray<ToolSpec>;
	/** Tools registered overall, direct and gateway. For /audit, /doctor, and the bootstrap policy assertion. */
	listAll(): ReadonlyArray<ToolSpec>;
	/** Lookup by tool id, whatever its placement. */
	get(name: ToolName): ToolSpec | undefined;
	/** Names of the direct-placed tools, in registration order. */
	listRegistered(): ReadonlyArray<ToolName>;
	/** Gateway-placed tools: reachable through `gateway` find/describe/call, never attached. */
	listGateway(): ReadonlyArray<ToolSpec>;
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
}

export type RegistryVerdict =
	| { kind: "ok"; result: ToolResult; decision: SafetyDecision }
	| {
			kind: "blocked";
			reason: string;
			decision: SafetyDecision;
			/**
			 * The call parked for approval and the park was answered without one:
			 * denied (by an operator, or by a headless run that has none) or
			 * cancelled. Set by `parkAnsweredBlockedVerdict` only. Consumers key on
			 * this instead of the reason text, which the loop guard replaces on a
			 * repeated denied call.
			 */
			deniedPark?: true;
	  }
	| { kind: "not_visible"; reason: string };

interface ParkedCall {
	call: ClassifierCall;
	decision: SafetyDecision;
	meta: PermissionRequiredMeta;
	resolve: (verdict: RegistryVerdict) => void;
	/**
	 * Seals the park at the instant the operator's decision lands, before the
	 * admitted body runs. Idempotent, so the resolve paths that never reach a
	 * body still report exactly one park.
	 */
	closePark: () => void;
	options?: ToolInvokeOptions;
	abortCleanup?: () => void;
}

export function createRegistry(deps: RegistryDeps): ToolRegistry {
	const tools = new Map<ToolName, ToolSpec>();
	const parked: ParkedCall[] = [];
	const permissionListeners = new Set<
		(call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void
	>();
	let approvalRequestCounter = 0;
	const approvalRequestToken = randomBytes(4).toString("hex");

	/** The rail that named the parked call, when the decision carried one. */
	const approvalRailOf = (decision: SafetyDecision): string | undefined => {
		if (decision.kind === "allow") return decision.policy?.ruleId;
		return decision.match?.ruleId ?? decision.policy?.ruleId;
	};

	/**
	 * Block reason when this call would carry the session's restricted content
	 * to a destination its source rules do not admit, or null. Judged on the
	 * requested identity; a fetch's redirect hops are judged again by the
	 * fetch loop through `flowAdmitsUrl`.
	 */
	const outboundFlowViolation = (spec: ToolSpec, call: ClassifierCall): string | null => {
		const destination = resolveToolDestination(spec.name, call.args, (tool) => deps.flow?.mcpTransport?.(tool) ?? null);
		if (destination === null) return null;
		const refusal = deps.flow?.refusal() ?? null;
		if (refusal !== null) return refusal;
		const carried = deps.flow?.carried() ?? null;
		if (carried === null) return null;
		const verdict = evaluateInformationFlow({
			restrictions: carried,
			destination,
			policy: deps.safety.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
		});
		return verdict.kind === "permitted" ? null : verdict.reason;
	};

	const runSpec = async (
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options?: ToolInvokeOptions,
	): Promise<RegistryVerdict> => {
		let resultDisposition = spec.metadata?.resultDisposition;
		try {
			// Explicit information-flow violations are final at every autonomy
			// level, including yolo, and are decided before any hook can run the
			// body. Permitted here grants nothing: admission already ran.
			const flowViolation = outboundFlowViolation(spec, call);
			if (flowViolation !== null) {
				recordRegistryDisposition(call, decision, "blocked", {
					reasonCode: FLOW_BLOCK_REASON_CODE,
					reasons: [flowViolation],
				});
				return { kind: "blocked", reason: flowViolation, decision };
			}
			// The hook layer is the only control stage past safety admission. Guards
			// (loop, protected artifacts, dispatch dedup) are before_tool
			// registrations; the first block_tool effect decides the verdict. Keep
			// this gate inside the admission cleanup boundary: dispatch may already
			// own a provisional reservation by the time a guard blocks execution.
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
				resultDisposition = resolveToolResultDisposition(spec, preparedArgs);
				const {
					allowsObservationPath: _callerPathFilter,
					writeTargetViolation: _callerWriteCheck,
					gitContext: _callerGitContext,
					flowAdmitsUrl: _callerFlowAdmitsUrl,
					...callerOptions
				} = options ?? {};
				const allowsObservationPath = deps.safety.policy?.allowsObservationPath;
				const writeTargetViolation = deps.safety.policy?.writeTargetViolation;
				// What this result will carry, decided from the path or tool name
				// before the body runs, so a link swapped in afterwards cannot
				// unlabel it and so the label exists before any screening.
				const ruleRestrictions = deps.safety.policy?.flowRestrictionsFor?.(call) ?? null;
				const result = await spec.run(preparedArgs, {
					...callerOptions,
					...(allowsObservationPath ? { allowsObservationPath } : {}),
					...(writeTargetViolation ? { writeTargetViolation } : {}),
					...(deps.principal === "worker" && deps.git !== undefined ? { gitContext: deps.git } : {}),
					...(deps.flow !== undefined && deps.flow.carried() !== null
						? {
								flowAdmitsUrl: (url: string) => {
									const violation = outboundFlowViolation(spec, { tool: spec.name, args: { url } });
									return violation;
								},
							}
						: {}),
				});
				// A body that delegated to a nested invocation the registry refused
				// (the gateway calling a denied capability) hands the refusal back
				// whole, and this call settles as that same blocked verdict: the
				// model, telemetry, and the ledger then see exactly what a direct
				// call to the capability would have produced.
				const nestedBlocked = nestedBlockedVerdict(result);
				if (nestedBlocked !== null) return nestedBlocked;
				decision = nestedDecisions.get(result) ?? decision;
				// A trusted body (dispatch, monitor) labels what it carried back from
				// a worker's context; that label joins the source rule's own.
				const reportedRestrictions = result.details?.[FLOW_RESTRICTIONS_DETAIL];
				const sourceRestrictions = mergeFlowRestrictions(
					ruleRestrictions,
					isFlowRestrictionSet(reportedRestrictions) ? reportedRestrictions : null,
				);
				// The restriction enters the ledger before the result goes anywhere:
				// not to the screening classifier, not to the hooks, not to the model.
				// An error can quote the source, so it is labeled and absorbed too.
				if (sourceRestrictions !== null) {
					deps.flow?.absorb(sourceRestrictions, {
						tool: spec.name,
						...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
					});
					// A label that did not reach the ledger must not be outlived by the
					// content it labels: the transcript would then hold the bytes
					// without the restriction across a restart. The content is withheld
					// and the queued label is retried on the next ledger access.
					const unlabeled = deps.flow?.refusal() ?? null;
					if (unlabeled !== null) {
						const reason = `${spec.name} result withheld: ${unlabeled}`;
						recordRegistryDisposition(call, decision, "blocked", { reasonCode: FLOW_BLOCK_REASON_CODE, reasons: [reason] });
						return { kind: "blocked", reason, decision };
					}
				}
				const carriedForScreen = mergeFlowRestrictions(deps.flow?.carried() ?? null, sourceRestrictions);
				const screened = await screenExternalResult(
					spec,
					call,
					withFlowRestrictions(result, sourceRestrictions),
					options,
					carriedForScreen,
				);
				const digest = toolResultDigestFor(spec, screened, resultDisposition, options);
				const afterEffects = runToolHook("after_tool", spec, call, decision, options, screened, digest);
				const finalResult = shapeToolResult(
					spec,
					applyToolResultEffects(screened, [...beforeEffects, ...afterEffects], screened !== result),
					options,
					resultDisposition,
				);
				return { kind: "ok", result: finalResult, decision };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// A body that threw may have read the source before failing, so
				// its message carries the same label as a result would.
				const thrownRestrictions = deps.safety.policy?.flowRestrictionsFor?.(call) ?? null;
				if (thrownRestrictions !== null) {
					deps.flow?.absorb(thrownRestrictions, {
						tool: spec.name,
						...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
					});
				}
				const unlabeled = thrownRestrictions === null ? null : (deps.flow?.refusal() ?? null);
				if (unlabeled !== null) {
					const reason = `${spec.name} error withheld: ${unlabeled}`;
					recordRegistryDisposition(call, decision, "blocked", { reasonCode: FLOW_BLOCK_REASON_CODE, reasons: [reason] });
					return { kind: "blocked", reason, decision };
				}
				const result: ToolResult = withFlowRestrictions({ kind: "error", message }, thrownRestrictions);
				const digest = toolResultDigestFor(spec, result, resultDisposition, options);
				const afterEffects = runToolHook("after_tool", spec, call, decision, options, result, digest);
				return {
					kind: "ok",
					result: shapeToolResult(
						spec,
						applyToolResultEffects(result, [...beforeEffects, ...afterEffects]),
						options,
						resultDisposition,
					),
					decision,
				};
			}
		} finally {
			disposeAdmissionArgs(spec, call.args ?? {});
		}
	};

	const runToolHook = (
		hook: "before_tool" | "after_tool",
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
		result?: ToolResult,
		resultDigest?: ToolResultDigest,
	): ReadonlyArray<MiddlewareEffect> => {
		if (!deps.middleware) return [];
		const input = buildToolHookInput(hook, spec, call, decision, "operating", options, result, resultDigest);
		const effects = deps.middleware.runHook(input).effects;
		try {
			deps.onMiddlewareEffects?.(effects, input);
		} catch {
			// A provider-routing sink is advisory to this call. It may narrow the
			// next request, but it must never throw through tool admission.
		}
		return effects;
	};

	/**
	 * Put System One's banner in front of a result that carries someone else's
	 * text. Placed before the hook so the deterministic marker scan reads the
	 * same bytes the model will, and tighten-only: any failure returns the
	 * result untouched.
	 */
	const screenExternalResult = async (
		spec: ToolSpec,
		call: ClassifierCall,
		result: ToolResult,
		options: ToolInvokeOptions | undefined,
		restrictions: FlowRestrictionSet | null,
	): Promise<ToolResult> => {
		const screen = deps.screenToolResult;
		if (screen === undefined || result.kind !== "ok" || !screensToolResult(spec.name)) return result;
		if (result.output.trim().length === 0) return result;
		try {
			const banner = await screen(
				`${spec.name} ${describeCallTarget(spec.name, call.args)}`.trim(),
				result.output,
				options?.toolCallId,
				options?.signal,
				restrictions,
			);
			if (banner === null || banner.trim().length === 0) return result;
			return { ...result, output: `${banner}\n\n${result.output}` };
		} catch {
			// Screening is an addition to the deterministic scan; it never fails a tool call.
			return result;
		}
	};

	type AdmitOutcome =
		| { kind: "terminal"; verdict: RegistryVerdict }
		| { kind: "execute"; spec: ToolSpec; decision: SafetyDecision }
		| {
				kind: "park";
				decision: SafetyDecision;
				axis: string;
				approvalAuthority: ApprovalAuthority;
				dispatchPlan?: DispatchPlanView;
				/** Pre-allocated so a gate's decision and the card it raises share one id. */
				requestId?: string;
				/** The reason a System One gate gave for raising this park; absent for every other park. */
				gateReason?: string;
				gateBuild?: string;
		  };

	const admit = (call: ClassifierCall, grant?: OneShotGrant, options?: ToolInvokeOptions): AdmitOutcome => {
		const spec = tools.get(call.tool as ToolName);
		if (!spec) {
			return { kind: "terminal", verdict: { kind: "not_visible", reason: `tool not registered: ${call.tool}` } };
		}
		const level = deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		const projectedCall = spec.safetyCall?.(call.args ?? {});
		// Plan-scale dispatch calls (multi-task, compete, remote node) carry the
		// plan flag so default routes them through one plan approval.
		const dispatchPlan =
			call.tool === ToolNames.Dispatch
				? (spec.describeDispatchPlan?.(call.args ?? {}) ?? describeDispatchPlan(call.args))
				: null;
		const planScale = dispatchPlan?.planScale === true;
		// The shared evaluator decides; this adapter only parks, audits and runs.
		// The SDK bridge and the ACP mediator call the same function.
		const admission = evaluateAdmission({
			principal: deps.principal ?? "main",
			// Both the public capability and its underlying effects must pass. A
			// trusted projection cannot bypass a rule targeting the capability's own name.
			...(projectedCall !== undefined ? { capability: call, effects: [projectedCall] } : { effects: [call] }),
			safety: deps.safety,
			autonomy: level,
			...(deps.workerExecuteAutonomy !== undefined ? { workerExecuteAutonomy: deps.workerExecuteAutonomy } : {}),
			constraints: {
				...(deps.readOnly === true ? { readOnly: true } : {}),
				...(options?.turnConstraints !== undefined ? { turnConstraints: options.turnConstraints } : {}),
				...(options?.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
				...(options?.pendingSkillPolicy !== undefined ? { pendingSkillPolicy: options.pendingSkillPolicy } : {}),
			},
			...(spec.confirmationRuleId !== undefined ? { confirmationRuleId: spec.confirmationRuleId } : {}),
			...(grant !== undefined
				? { authorization: { actionClass: grant.actionClass, issuer: grant.issuer ?? "operator" } }
				: {}),
			normalize: (decision) => applyRegisteredToolClassification(decision, spec),
			...(deps.git !== undefined ? { git: deps.git } : {}),
			autonomyExtra: {
				...(call.tool === ToolNames.AskUser ? { exposure: askUserExposure(call.args) } : {}),
				...(planScale ? { dispatchPlanScale: true } : {}),
			},
		});
		if (admission.kind === "deny" && admission.code === "safety_net") {
			return { kind: "terminal", verdict: { kind: "blocked", reason: admission.reason, decision: admission.decision } };
		}
		const effectRefusal = admitHostEffects(call, spec, admission.decision, level);
		if (effectRefusal !== null) return effectRefusal;
		if (admission.kind === "deny") return { kind: "terminal", verdict: deniedVerdict(call, admission) };
		if (admission.kind === "allow") {
			// A confirmed re-admission keeps the `allowed` row safety.evaluate wrote.
			if (!admission.authorized) recordRegistryDisposition(call, admission.decision, "allowed");
			return { kind: "execute", spec, decision: admission.decision };
		}
		const askDecision =
			admission.source === "autonomy" && planScale && dispatchPlan !== null
				? toDispatchPlanAskDecision(admission.netDecision, level, dispatchPlan)
				: admission.decision;
		return {
			kind: "park",
			decision: askDecision,
			axis: approvalAxisId(askDecision, level),
			approvalAuthority: admission.approvalAuthority,
			...(admission.source === "autonomy" && dispatchPlan !== null ? { dispatchPlan } : {}),
		};
	};

	/** Registry verdict and audit row for a hard denial past the safety net. */
	const deniedVerdict = (
		call: ClassifierCall,
		admission: Extract<AdmissionDisposition, { kind: "deny" }>,
	): Extract<RegistryVerdict, { kind: "blocked" }> => {
		const decision = admission.decision;
		if (admission.code === "read_only") {
			const verdict = readOnlyDeniedVerdict(decision, call.tool);
			recordRegistryDisposition(call, verdict.decision, "denied", { reasonCode: "dispatch:read_only" });
			return verdict;
		}
		if (admission.code === "skill_surface" && admission.skillViolation !== undefined) {
			const verdict = skillSurfaceBlockedVerdict(decision, call.tool, admission.skillViolation);
			recordRegistryDisposition(call, verdict.decision, "blocked", {
				reasonCode: "skill_surface",
				reasons: [verdict.reason],
			});
			return verdict;
		}
		if (admission.code === "tool_scope" || admission.code === "skills_disabled") {
			const reason = admission.reason;
			const blocked: SafetyDecision = {
				kind: "block",
				classification: decision.classification,
				rejection: {
					short: `${call.tool} blocked: turn constraint`,
					detail: reason,
					hints: ["Work within the operator's task scope; approval of an individual tool does not widen it."],
				},
			};
			recordRegistryDisposition(call, blocked, "blocked", { reasonCode: "turn_constraint", reasons: [reason] });
			return { kind: "blocked", reason, decision: blocked };
		}
		if (admission.code === "git_destructive") {
			recordRegistryDisposition(call, decision, "blocked", {
				reasons: [admission.reason],
				reasonCode: "classification:git_destructive",
			});
			return { kind: "blocked", reason: admission.reason, decision };
		}
		const blocked: SafetyDecision = {
			kind: "block",
			classification: decision.classification,
			rejection: { short: admission.reason, detail: admission.reason, hints: [] },
			...(decision.policy !== undefined ? { policy: decision.policy } : {}),
		};
		recordRegistryDisposition(call, blocked, "blocked", { reasonCode: `admission:${admission.code}` });
		return { kind: "blocked", reason: admission.reason, decision: blocked };
	};

	/**
	 * Admit the host commands a call runs on its caller's behalf (F6). Dispatch
	 * host verification executes declared checks as the dispatching agent, so a
	 * check must pass the same safety net and autonomy mapping as the direct
	 * verify call would. A check that would park is refused rather than parked:
	 * the operator is asked about the dispatch plan, not about each command it
	 * implies, and a headless run has nobody to ask. Every effect is evaluated
	 * so a hard block anywhere wins over an earlier ask.
	 */
	const admitHostEffects = (
		call: ClassifierCall,
		spec: ToolSpec,
		decision: SafetyDecision,
		level: AutonomyLevel,
	): Extract<AdmitOutcome, { kind: "terminal" }> | null => {
		const effects = spec.hostEffectCalls?.(call.args ?? {}) ?? [];
		if (effects.length === 0) return null;
		let hard: { label: string; cause: string } | null = null;
		let soft: { label: string; cause: string } | null = null;
		for (const effect of effects) {
			const effectSpec = tools.get(effect.call.tool as ToolName);
			// Each check is admitted exactly as its direct call would be, by the
			// same evaluator, and never under a one-shot grant for this call.
			const admission = evaluateAdmission({
				principal: deps.principal ?? "main",
				effects: [effect.call],
				safety: deps.safety,
				autonomy: level,
				...(deps.workerExecuteAutonomy !== undefined ? { workerExecuteAutonomy: deps.workerExecuteAutonomy } : {}),
				...(effectSpec !== undefined
					? { normalize: (raw: SafetyDecision) => applyRegisteredToolClassification(raw, effectSpec) }
					: {}),
			});
			if (
				admission.kind === "deny" ||
				(admission.kind === "ask" && admission.decision.classification.actionClass === "git_destructive")
			) {
				hard = { label: effect.label, cause: admission.reason };
				break;
			}
			if (soft === null && admission.kind === "ask") soft = { label: effect.label, cause: admission.reason };
		}
		const refused = hard ?? soft;
		if (refused === null) return null;
		const reason = `${call.tool} refused: ${refused.label} would not be admitted as a direct call (${refused.cause})`;
		const blocked: SafetyDecision = {
			kind: "block",
			classification: decision.classification,
			rejection: {
				short: reason,
				detail: `${reason}. Host verification runs each declared check as the dispatching agent, so each check must pass the admission its direct call would.`,
				hints: [
					"Run the check yourself with verify after the receipt, or declare a check the policy recognizes.",
					"Approving the dispatch does not approve the commands its verification runs.",
				],
			},
			...(decision.policy !== undefined ? { policy: decision.policy } : {}),
		};
		recordRegistryDisposition(call, blocked, "blocked", {
			reasonCode: hard !== null ? "host_effect_blocked" : "host_effect_not_admitted",
			reasons: [reason],
		});
		return { kind: "terminal", verdict: { kind: "blocked", reason, decision: blocked } };
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
		disposeAdmissionArgs(tools.get(entry.call.tool as ToolName), entry.call.args ?? {});
		// A denied/cancelled park is still a model attempt: observe it so
		// identical retries trip the loop detector. When the detector fires, its
		// reason replaces the generic denial so the model gets recovery guidance.
		const loopReason = observeRejectedAttempt(entry.call, entry.decision, entry.options);
		entry.resolve(
			guardOverrideForRejectedAttempt(entry.call, entry.decision, loopReason) ??
				parkAnsweredBlockedVerdict(entry.decision, entry.call.tool, loopReason ?? reason),
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

	/**
	 * The yolo gate. Yolo runs an unrecognized command without asking, which is
	 * the one place where nothing has read the command at all; a System One
	 * engine that reads it as reaching far or destroying data can turn that
	 * silence into one confirmation. It never removes friction: a call the
	 * classifier already parks, blocks or recognizes does not reach it.
	 */
	const gateUnrecognizedExecute = async (
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
	): Promise<Extract<AdmitOutcome, { kind: "park" }> | null> => {
		const gate = deps.gateToolCall;
		if (gate === undefined) return null;
		const level = deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		if (
			level !== "yolo" ||
			decision.classification.actionClass !== "execute" ||
			decision.policy?.execRecognition !== "unrecognized"
		) {
			return null;
		}
		const requestId = nextApprovalRequestId();
		let verdict: ToolCallGateVerdict | null;
		try {
			verdict = await gate(
				{
					tool: call.tool,
					actionClass: decision.classification.actionClass,
					target: describeCallTarget(call.tool, call.args),
				},
				requestId,
				options?.signal,
			);
		} catch {
			// An unavailable gate leaves yolo exactly as permissive as it was.
			return null;
		}
		if (verdict === null || !verdict.escalate) return null;
		// The verdict is already on the ledger. Headless and ACP pass no gate and
		// never reach this line; a call with nobody to answer its card (no
		// `gateParks`, no permission listener, or an abort while the verdict was
		// pending) proceeds.
		if (deps.gateParks !== true || permissionListeners.size === 0 || options?.signal?.aborted === true) return null;
		const ask = toGateAskDecision(decision, call.tool, verdict.reason);
		return {
			kind: "park",
			decision: ask,
			axis: approvalAxisId(ask, level),
			// The System One gate speaks to the operator; no agent may answer it.
			approvalAuthority: "operator",
			requestId,
			gateReason: verdict.reason,
			...(verdict.build !== undefined ? { gateBuild: verdict.build } : {}),
		};
	};

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
		unregister(name) {
			tools.delete(name);
		},
		listAll: () => Array.from(tools.values()),
		get: (name) => tools.get(name),
		listRegistered: () =>
			Array.from(tools.values())
				.filter((spec) => toolSpecPlacement(spec) === "direct")
				.map((spec) => spec.name),
		listVisible: () => Array.from(tools.values()).filter((spec) => toolSpecPlacement(spec) === "direct"),
		listGateway: () => Array.from(tools.values()).filter((spec) => toolSpecPlacement(spec) === "gateway"),
		async invoke(call, options) {
			const admissionCall = prepareAdmissionCall(tools.get(call.tool as ToolName), call);
			let outcome = admit(admissionCall, undefined, options);
			if (outcome.kind === "terminal") {
				disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
				return observeBlockedAttempt(admissionCall, outcome.verdict, options) ?? outcome.verdict;
			}
			if (outcome.kind === "execute") {
				const escalated = await gateUnrecognizedExecute(admissionCall, outcome.decision, options);
				if (escalated === null) return runSpec(outcome.spec, admissionCall, outcome.decision, options);
				outcome = escalated;
			}
			// A park settles only through a listener's answer, so with no listener
			// the promise would never resolve. Refuse the call instead, fail closed.
			if (permissionListeners.size === 0) {
				disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
				recordRegistryDisposition(admissionCall, outcome.decision, "denied", {
					reasonCode: NO_PARK_LISTENER_REASON_CODE,
				});
				const loopReason = observeRejectedAttempt(admissionCall, outcome.decision, options);
				return (
					guardOverrideForRejectedAttempt(admissionCall, outcome.decision, loopReason) ??
					parkAnsweredBlockedVerdict(outcome.decision, admissionCall.tool, loopReason ?? NO_PARK_LISTENER_REASON)
				);
			}
			const abortReason = "run aborted before the operator decided";
			if (options?.signal?.aborted) {
				disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
				const loopReason = observeRejectedAttempt(admissionCall, outcome.decision, options);
				return { kind: "blocked", reason: loopReason ?? abortReason, decision: outcome.decision };
			}
			return new Promise<RegistryVerdict>((resolve) => {
				const meta: PermissionRequiredMeta = {
					requestId: outcome.requestId ?? nextApprovalRequestId(),
					axis: outcome.axis,
					approvalAuthority: outcome.approvalAuthority,
					...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
					...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
					...(options?.toolCallId !== undefined && options.toolCallId.length > 0 ? { toolCallId: options.toolCallId } : {}),
					...(outcome.dispatchPlan !== undefined ? { dispatchPlan: outcome.dispatchPlan } : {}),
					...(outcome.gateReason !== undefined ? { gateReason: outcome.gateReason } : {}),
					...(outcome.gateBuild !== undefined ? { gateBuild: outcome.gateBuild } : {}),
				};
				recordRegistryDisposition(admissionCall, outcome.decision, "permission_requested", {
					requestId: meta.requestId,
					...(outcome.decision.kind === "ask" && outcome.decision.confirmationRuleId !== undefined
						? { reasonCode: `confirmation:${outcome.decision.confirmationRuleId}` }
						: {}),
				});
				// The park ends when the operator decides, not when the verdict
				// resolves: an approved call runs its body inside the resume pass,
				// so measuring to the resolve would fold the tool's own execution
				// into the park and the caller would subtract it. A dispatch that
				// fanned out for 224.8s settled as a 15ms line that way (issue #82).
				// closePark seals it at the decision; settle covers every path that
				// ends a park without reaching a body, including one added later,
				// because they all resolve the entry through this function.
				const parkedAtClock = performance.now();
				let parkReported = false;
				const closePark = (): void => {
					if (parkReported) return;
					parkReported = true;
					options?.onParked?.(Math.round(performance.now() - parkedAtClock));
				};
				const settle = (verdict: RegistryVerdict): void => {
					closePark();
					resolve(verdict);
				};
				const parkedCall: ParkedCall = {
					call: admissionCall,
					decision: outcome.decision,
					meta,
					resolve: settle,
					closePark,
				};
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
					grant.onExecution?.({ phase: "not_executed", reason: "the parked call is no longer waiting" });
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
				const observed = grant?.requestId !== undefined && grant.requestId === entry.meta.requestId;
				if (grant !== undefined && entry.decision.classification.actionClass !== grant.actionClass) {
					if (observed) grant?.onExecution?.({ phase: "not_executed", reason: "the grant names another action class" });
					reparkEntry(entry, reparkIndex);
					continue;
				}
				const outcome = admit(entry.call, grant, entry.options);
				if (outcome.kind === "park") {
					if (observed) {
						grant?.onExecution?.({ phase: "not_executed", reason: "admission still requires another approval" });
					}
					reparkEntry(entry, reparkIndex);
					continue;
				}
				cleanupParkedEntry(entry);
				if (outcome.kind === "terminal") {
					disposeAdmissionArgs(tools.get(entry.call.tool as ToolName), entry.call.args ?? {});
					if (observed) {
						grant?.onExecution?.({
							phase: "not_executed",
							reason: "reason" in outcome.verdict ? outcome.verdict.reason : "admission refused the call",
						});
					}
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
				// Seal the park before the body runs. Everything after this line is
				// the tool working, and the caller charges that to the tool.
				entry.closePark();
				if (observed) grant?.onExecution?.({ phase: "start" });
				const verdict = await runSpec(outcome.spec, entry.call, outcome.decision, approvedOptions);
				if (observed) {
					grant?.onExecution?.({
						phase: "end",
						outcome: verdict.kind !== "ok" ? "blocked" : verdict.result.kind === "error" ? "error" : "ok",
					});
				}
				// A grant is invisible in the result otherwise, and the model reported
				// a confirmed call as one that never asked. The note names the
				// surface that released the call, because an ACP client or a
				// remembered escalation is not this session's operator. Only this path
				// runs a released call, so no ordinary call is annotated.
				entry.resolve(
					grant !== undefined && verdict.kind === "ok"
						? {
								...verdict,
								result: withApprovalNote(verdict.result, {
									actionClass: grant.actionClass,
									requestedBy: grant.requestedBy,
									ruleId: approvalRailOf(entry.decision),
									gateReason: entry.meta.gateReason,
								}),
							}
						: verdict,
				);
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
	};
}

/**
 * Run a tool's optional `prepareArguments` normalizer before its body. A
 * throwing or non-object result is discarded so a buggy normalizer can never
 * abort admission; the raw args pass through unchanged.
 */
export function prepareToolArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
	if (!spec.prepareArguments) return args;
	try {
		const prepared = spec.prepareArguments(args);
		return prepared !== null && typeof prepared === "object" && !Array.isArray(prepared) ? prepared : args;
	} catch {
		return args;
	}
}

/**
 * Resolve the argument-sensitive disposition, failing closed. A throwing
 * resolver cannot fall back to the declared disposition: the caller may have
 * asked for a narrower context than the tool declares, and silently restoring
 * the declared mode would widen model context while recording the declared mode
 * as the requested one. The failure keeps the declared presentation and applies
 * the narrowest context instead, so the applied and recorded modes stay honest.
 */
function resolveToolResultDisposition(
	spec: ToolSpec,
	args: Record<string, unknown>,
): ToolResultDisposition | undefined {
	const declared = spec.metadata?.resultDisposition;
	if (!spec.resolveResultDisposition) return declared;
	try {
		return spec.resolveResultDisposition(args, declared);
	} catch (error) {
		const maxBytes =
			declared !== undefined && declared.context.maxBytes !== undefined
				? declared.context.maxBytes
				: DEFAULT_TOOL_RESULT_MAX_BYTES;
		return {
			presentation: declared?.presentation ?? { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true },
			context: { mode: "metadata-only", maxBytes },
			// The narrowing is recorded with the result, so a resolver bug shows up
			// on the transcript row and in the model's header instead of reading as
			// a deliberate metadata-only request.
			fallback: { reason: "resolver-error", message: error instanceof Error ? error.message : String(error) },
		};
	}
}

function disposeAdmissionArgs(spec: ToolSpec | undefined, args: Record<string, unknown>): void {
	try {
		spec?.disposeAdmissionArguments?.(args);
	} catch {
		// Cleanup is best-effort here; durable reservation expiry is the backstop.
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
/** Reason code of a final information-flow block, for the audit row and the panel. */
const FLOW_BLOCK_REASON_CODE = "information-flow";
/** Result detail that carries a restricted read's label to the host; never model text. */
export const FLOW_RESTRICTIONS_DETAIL = "clio_coder_flow_restrictions";

/** An error message can quote the source too, so both result kinds carry the label. */
function withFlowRestrictions(result: ToolResult, restrictions: FlowRestrictionSet | null): ToolResult {
	if (restrictions === null) return result;
	return { ...result, details: { ...(result.details ?? {}), [FLOW_RESTRICTIONS_DETAIL]: restrictions } };
}

const NO_PARK_LISTENER_REASON_CODE = "no_park_listener";
const NO_PARK_LISTENER_REASON =
	"refused: this call needs operator confirmation and no permission listener is registered to ask for it";

/**
 * Details key under which a tool body hands a refused nested verdict back to
 * the registry. Written by {@link nestedBlockedResult}, read once by `runSpec`,
 * never persisted: the registry settles the outer call as that verdict.
 */
const nestedDecisions = new WeakMap<ToolResult, SafetyDecision>();

/** Carry trusted in-process delegation authority without adding model-visible metadata. */
export function nestedExecutedResult(result: ToolResult, decision: SafetyDecision): ToolResult {
	nestedDecisions.set(result, decision);
	return result;
}

const NESTED_BLOCKED_DETAIL = "nestedBlockedVerdict";

interface NestedBlockedMarker {
	reason: string;
	decision: SafetyDecision;
	deniedPark?: true;
}

/**
 * The result a tool body returns when a nested `invoke` it made on the model's
 * behalf came back blocked. The gateway uses it so a capability the registry
 * refused (denied at read-only, not approved, guarded) refuses the gateway
 * call identically instead of dressing the refusal as a tool error.
 */
export function nestedBlockedResult(verdict: Extract<RegistryVerdict, { kind: "blocked" }>): ToolResult {
	const marker: NestedBlockedMarker = {
		reason: verdict.reason,
		decision: verdict.decision,
		...(verdict.deniedPark === true ? { deniedPark: true } : {}),
	};
	return { kind: "error", message: verdict.reason, details: { [NESTED_BLOCKED_DETAIL]: marker } };
}

function nestedBlockedVerdict(result: ToolResult): Extract<RegistryVerdict, { kind: "blocked" }> | null {
	if (result.kind !== "error") return null;
	const marker = result.details?.[NESTED_BLOCKED_DETAIL];
	if (typeof marker !== "object" || marker === null) return null;
	const { reason, decision, deniedPark } = marker as Partial<NestedBlockedMarker>;
	if (
		typeof reason !== "string" ||
		typeof decision !== "object" ||
		decision === null ||
		typeof decision.kind !== "string" ||
		typeof decision.classification !== "object"
	) {
		return null;
	}
	return { kind: "blocked", reason, decision, ...(deniedPark === true ? { deniedPark: true } : {}) };
}

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
 * Longest guidance sentence carried into a headless denial. The model-facing
 * composer caps a line at 300 characters and interpolates policy text verbatim,
 * so bound it here too and leave room for the elision marker.
 */
const HEADLESS_GUIDANCE_MAX_CHARS = 240;

/**
 * The recovery guidance a headless denial should repeat, or null when the
 * parked decision has none.
 *
 * A headless run answers every ask with one sentence: nobody can confirm, rerun
 * interactively. That says nothing about what would have run, so a headless
 * model that hits an unrecognized-bash rail retries the same shape until the run
 * ends. An unrecognized execution decision carries the working form in its
 * reasons, and those reasons reach the audit record and the interactive approval
 * overlay but not the model. Preserve one bounded recovery hint separately
 * from the actual policy cause carried by the terminal denial below.
 */
function headlessDenialGuidance(decision: SafetyDecision, reason: string): string | null {
	// Interactive denials are left exactly as they were: the operator saw the
	// reasons in the approval overlay before answering.
	if (!reason.startsWith(HEADLESS_PERMISSION_DENIED_MARKER)) return null;
	const policy = decision.policy;
	if (policy?.execRecognition !== "unrecognized") return null;
	const guidance = policy.reasons.slice(1).find((entry) => entry.trim().length > 0);
	if (guidance === undefined) return null;
	const trimmed = guidance.trim();
	return trimmed.length > HEADLESS_GUIDANCE_MAX_CHARS ? `${trimmed.slice(0, HEADLESS_GUIDANCE_MAX_CHARS)}…` : trimmed;
}

/**
 * Rule ids whose bare name tells neither the model nor the operator reading its
 * report what the rule guards. The model relays the id verbatim ("the rule that
 * blocked it is system-modify-confirm"), so the meaning goes first and the id
 * stays as the parenthetical a maintainer can grep. Ids that carry their own
 * cause in the policy reasons need no entry.
 */
const HEADLESS_RULE_MEANINGS: Readonly<Record<string, string>> = {
	"system-modify-confirm": "writes outside the workspace and other system-level changes need operator confirmation",
};

function headlessRuleLabel(ruleId: string): string {
	const meaning = HEADLESS_RULE_MEANINGS[ruleId];
	return meaning === undefined ? ruleId : `${meaning} (${ruleId})`;
}

/**
 * Terminal blocked verdict for a parked call that has been answered: denied at
 * the confirmation prompt, cancelled with the turn, or settled by an abort.
 *
 * The ask decision's rejection explains that the call *is* parked and what
 * approving it would do. Once the answer is in, that text is stale, and
 * `formatModelRejection` printed it as a second paragraph restating a denial the
 * reason had already stated, followed by four approval hints for an approval
 * that is not coming. The answer is the whole message; the composer still closes
 * it with the standing pivot instruction.
 *
 * A headless answer is the exception: nobody will ever approve it, so the detail
 * carries the policy cause and rule, a terminal settlement statement, and any
 * recovery guidance. The denial sentence stays the detail's prefix, so the
 * stable marker still recognizes a headless denial.
 */
function parkAnsweredBlockedVerdict(
	decision: SafetyDecision,
	tool: string,
	reason: string,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const guidance = headlessDenialGuidance(decision, reason);
	const detail = [reason];
	if (reason.startsWith(HEADLESS_PERMISSION_DENIED_MARKER)) {
		if (decision.policy?.ruleId) detail.push(`rule: ${headlessRuleLabel(decision.policy.ruleId)}`);
		const cause =
			decision.policy?.kind === "ask"
				? decision.policy.reasons[0]
				: decision.kind === "allow"
					? undefined
					: decision.rejection.short;
		if (cause) detail.push(cause);
		detail.push("This call was denied; no approval is pending.");
		if (guidance !== null) detail.push(guidance);
	}
	const blocked: SafetyDecision = {
		kind: "block",
		classification: decision.classification,
		rejection: {
			short: `${tool} blocked: ${decision.classification.actionClass} was not approved`,
			detail: detail.join("\n"),
			hints: [],
		},
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
	return { kind: "blocked", reason, decision: blocked, deniedPark: true };
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
	const lifetime = violation.carriedSurface
		? "The narrowing stays active for the rest of the session, across the operator's later turns, until a different skill replaces it or the operator clears it with /skill off."
		: "The narrowing ends when the skill policy's turn or worker run ends.";
	const reason =
		violation.disallowedBy.length > 0
			? `${tool} is disallowed by the active skill(s) ${violation.disallowedBy.join(", ")} (disallowed-tools). ${lifetime} Work within the skill workflow; if it genuinely needs this step, use ask_user when available or state the blocker in your reply.`
			: `${tool} is outside the tool surface declared by the active skill(s) ${violation.skills.join(", ")}. Tools are narrowed to: ${(violation.mergedAllowedTools ?? []).join(", ")} (plus context and ask_user). The limitation receipt is also available unless explicitly disallowed. ${lifetime} Work within the skill workflow; if it genuinely needs this step, use ask_user when available or state the blocker in your reply.`;
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

/** A read-only dispatch resolves every forbidden call as a terminal denial. */
function readOnlyDeniedVerdict(decision: SafetyDecision, tool: string): Extract<RegistryVerdict, { kind: "blocked" }> {
	const rejection = {
		short: `${tool} denied: this run is read-only`,
		detail: `The dispatch that started this run is read-only, so this call cannot execute.`,
		hints: [
			"Describe the proposed change as text for the dispatching agent.",
			"Inspection tools remain available for paths inside the workspace.",
		],
	};
	const blocked: SafetyDecision = {
		kind: "block",
		classification: decision.classification,
		rejection,
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
	return { kind: "blocked", reason: rejection.short, decision: blocked };
}

/** Tools whose results carry text somebody else wrote: a page, an MCP server's answer, a worker's report. */
/**
 * The card a System One escalation raises: its reason is the whole message.
 * The rail id is set on the ask and on the policy it carries, because the
 * approval axis reads the first and the audit row, the bus event and the note
 * handed back to the model read the second.
 */
function toGateAskDecision(decision: SafetyDecision, tool: string, reason: string): SafetyDecision {
	return {
		kind: "ask",
		classification: decision.classification,
		confirmationRuleId: SYSTEM_ONE_GATE_RULE_ID,
		rejection: {
			short: `${tool} needs operator confirmation: System One flagged this command`,
			detail: reason,
			hints: [
				"Approving resumes only this call.",
				"System One advises and never blocks; deny to have the agent take another route.",
			],
		},
		...(decision.policy !== undefined
			? {
					policy: {
						...decision.policy,
						ruleId: SYSTEM_ONE_GATE_RULE_ID,
						reasonCode: SYSTEM_ONE_GATE_RULE_ID,
						reasons: [reason],
					},
				}
			: {}),
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
	plan: DispatchPlanView,
): SafetyDecision {
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
	resultDigest: ToolResultDigest | undefined,
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
	// What the session already carries, so an adviser sees the restriction
	// before any model send; the result's own label rides on toolResultDetails.
	const carriedFlow = deps.flow?.carried() ?? null;
	if (carriedFlow !== null) metadata.flowRuleIds = [...new Set(carriedFlow.restrictions.map((r) => r.ruleId))];
	// A nested invocation (gateway → capability) is the model's one call seen
	// twice by the hook layer; the loop guard counts and fingerprints only the
	// outer occurrence. Every other hook still fires under the inner name.
	if (options?.nested === true) metadata.nested = true;
	if (options?.origin === "harness") metadata.origin = "harness";
	const validationCommand = detectedValidationCommand(call);
	if (validationCommand !== null) {
		metadata.validationCommand = validationCommand;
		if (result?.kind === "ok") metadata.validationExitCode = 0;
	}
	if (call.tool !== spec.name) metadata.requestedToolName = call.tool;
	if (result !== undefined) {
		if (hook === "after_tool" && ["web_fetch", "read", "bash", "dispatch", "monitor"].includes(spec.name))
			metadata.untrustedInstructionMarkers = containsInstructionMarkers(
				result.kind === "ok" ? result.output : result.kind === "error" ? result.message : "",
			);
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
	if (resultDigest !== undefined) input.toolResultDigest = resultDigest;
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

/**
 * `bannered` means System One already put its own untrusted-content banner in
 * front of the output. The deterministic marker warning carries the same
 * header, so it is dropped rather than shown twice.
 */
function applyToolResultEffects(
	result: ToolResult,
	effects: ReadonlyArray<MiddlewareEffect>,
	bannered = false,
): ToolResult {
	const annotations = annotationMessages(effects);
	if (annotations.length === 0) return result;
	const warning = `[middleware:warn] ${INSTRUCTION_SHAPED_WARNING}`;
	const prefix = !bannered && annotations.includes(warning) ? `${warning}\n\n` : "";
	const remaining = annotations.filter((annotation) => annotation !== warning);
	const suffix = remaining.length > 0 ? `\n\n${remaining.join("\n")}` : "";
	if (result.kind === "ok") {
		const annotated: ToolResult = { kind: "ok", output: `${prefix}${result.output}${suffix}` };
		if (result.details !== undefined) annotated.details = result.details;
		if (result.terminate === true) annotated.terminate = true;
		if (result.images !== undefined) annotated.images = result.images;
		return annotated;
	}
	const annotated: ToolResult = { kind: "error", message: `${prefix}${result.message}${suffix}` };
	if (result.details !== undefined) annotated.details = result.details;
	return annotated;
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
