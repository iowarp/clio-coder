import { createHash, randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { isWorkerToolCallCapExceededReason } from "../core/guardrails.js";
import { HEADLESS_PERMISSION_DENIED_MARKER } from "../core/headless-permission.js";
import { normalizePromptHint } from "../core/prompt-hint.js";
import {
	carriesToolResultNote,
	recordedToolResultNotes,
	TOOL_RESULT_HOST_NOTES_KEY,
	TOOL_RESULT_NOTES_SEPARATOR,
	toolResultNote,
} from "../core/reminder-framing.js";
import {
	type MainSandboxPolicy,
	mainSandboxPolicy,
	type YoloScriptSandboxState,
} from "../core/sandbox/main-session.js";
import type { SandboxEnvPolicy, UnixSocketMode } from "../core/sandbox/types.js";
import type { PendingSkillToolPolicy, SkillToolSurfaceViolation } from "../core/skill-activation.js";
import { withToolTelemetryContext } from "../core/telemetry/context.js";
import type { ToolName } from "../core/tool-names.js";
import { isMcpToolName, ToolNames } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { toolSurfaceSources, turnAllowsTool } from "../core/turn-constraints.js";
import { containsInstructionMarkers, INSTRUCTION_SHAPED_WARNING } from "../core/untrusted-content.js";
import type { MiddlewareContract } from "../domains/middleware/contract.js";
import type {
	MiddlewareEffect,
	MiddlewareHookInput,
	MiddlewareMetadataValue,
	ToolCallLanding,
} from "../domains/middleware/types.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import {
	type AdmissionAskSource,
	type AdmissionDisposition,
	type AdmissionGitContext,
	type AdmissionPrincipal,
	type ApprovalAuthority,
	evaluateAdmission,
} from "../domains/safety/admission.js";
import { approvalAxisId } from "../domains/safety/approval-axis.js";
import { type AutonomyExposure, type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../domains/safety/autonomy.js";
import { describeCallTarget } from "../domains/safety/call-target.js";
import { GIT_CONTROL_FILE_RULE_ID } from "../domains/safety/containment.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import type { DecisionPresentation } from "../domains/safety/decision-presentation.js";
import { type DenialLayer, repeatedDenialReason, type ToolDenial } from "../domains/safety/denial.js";
import type { GitHookDriftGuard, GitHookDriftReport } from "../domains/safety/hook-drift.js";
import type { FlowRestrictionSet } from "../domains/safety/information-flow.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	flowTransferRefusal,
	isFlowRestrictionSet,
	mergeFlowRestrictions,
	resolveToolDestination,
} from "../domains/safety/information-flow.js";
import { hashToolCall } from "../domains/safety/loop-detector.js";
import type { OperatorDefaultScope, OperatorYoloScope } from "../domains/safety/policy-engine.js";
import { detectValidationCommand } from "../domains/safety/protected-artifacts.js";
import type { SafetyJudgeOutcome, SafetyJudgeSeat } from "../domains/safety/safety-judge.js";
import type { SessionCodeConsent } from "../domains/safety/session-code-consent.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "../domains/safety/session-code-consent.js";
import { UNATTENDED_ALLOWED_BY } from "../domains/safety/unattended.js";
import { YOLO_FLOOR_REASON_PREFIX } from "../domains/safety/yolo-floor.js";
import { screensToolResult } from "../domains/system-one/sites/tool-result.js";
import type { WorkspaceSnapshotOutcome, WorkspaceSnapshotRequest } from "../domains/workspace-snapshots/store.js";
import { type WorkspaceSnapshotTrigger, workspaceSnapshotTrigger } from "../domains/workspace-snapshots/trigger.js";
import type { ImageContent } from "../engine/types.js";
import { approvalGiver, withApprovalNote } from "./approval-note.js";
import { askUserExposure } from "./ask-user.js";
import { type DispatchPlanView, describeDispatchPlan } from "./dispatch-plan.js";
import type { ToolPresentationPolicy } from "./presentation.js";
import { type ToolResultDigest, type ToolResultDisposition, toolResultContextText } from "./result-disposition.js";
import { DEFAULT_TOOL_RESULT_MAX_BYTES, shapeToolResult, toolResultDigestFor } from "./result-shaping.js";
import { effectiveToolCall, type ToolPlacement, toolSpecPlacement } from "./surface.js";
import { pathToolLanding } from "./tool-landing.js";

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
	owner?: import("../core/package-identity.js").PackageIdentity;
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
	/** False keeps a contextual capability discoverable without adding it to the session startup prompt. */
	startupPrompt?: boolean;
	/** Short statement of the tool's purpose for audit/UI surfaces. */
	objective: string;
	/** Stable UI label shown in compact renderers. */
	uiLabel: string;
	/** Whether automatic recovery may safely retry an unfinished call. */
	retrySafety: ToolRetrySafety;
	/** Read-only idempotent MCP polling: bounded by call budgets rather than repetition. */
	repeatableRead?: boolean;
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

export interface ToolConfirmation {
	ruleId: string;
	detail: string;
	hints: ReadonlyArray<string>;
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
	/**
	 * The base class under a read-only ceiling, when the base class rests on
	 * something the operator did not set: an MCP tool classed read only by
	 * the server's own readOnlyHint.
	 */
	readOnlyActionClass?: ActionClass;
	/** A safety-net confirmation required at every autonomy level. */
	confirmationRuleId?: string;
	/**
	 * The same rail decided per call, for a tool whose arguments decide whether
	 * the operator must confirm. Wins over `confirmationRuleId` when it returns one.
	 */
	confirmationFor?(args: Record<string, unknown>): ToolConfirmation | undefined;
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
	 * Whether a before_tool rewrite of prepared admission arguments provably
	 * narrows the original's authority, so an operator approval of the original
	 * carries over to it (WX2). Absent means a rewrite never keeps an approval.
	 */
	rewriteNarrows?(original: Record<string, unknown>, rewritten: Record<string, unknown>): boolean;
	/**
	 * Host commands this call will run as its caller outside its own body, read
	 * from prepared admission arguments. Each is admitted as the direct call it
	 * stands for, at the caller's autonomy and never under a one-shot grant for
	 * this call. Any that would park or be blocked refuses this call outright,
	 * with a hard block reported first (F6).
	 */
	hostEffectCalls?(args: Record<string, unknown>): ReadonlyArray<HostEffectCall>;
	/**
	 * Where this call lands, read from prepared admission arguments, for the
	 * awaited hook phase. Path-taking tools that resolve against the process
	 * cwd need none: the registry resolves their `path` itself (`pathToolLanding`).
	 */
	describeHookLanding?(args: Record<string, unknown>): ToolCallLanding | null;
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
	 * Applies the protect_path effects an awaited extension hook returned, which
	 * reach the protected-artifacts guard only through the synchronous chain that
	 * already ran. Returns why the call still in flight must now be refused, else null.
	 */
	absorbAwaitedEffects?: (effects: ReadonlyArray<MiddlewareEffect>, input: MiddlewareHookInput) => string | null;
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
	/**
	 * The operator's `safety.scratchRoots`, read per admission. Only the main
	 * session's registry wires it, and its presence is what marks this registry's
	 * yolo as the operator's own (#419): workers, grants and jobs never carry it.
	 */
	scratchRoots?: () => ReadonlyArray<string>;
	/** How the operator's yolo runs a script on this host, from `safety.sandbox` and the probed backend (#419). */
	scriptSandbox?: () => YoloScriptSandboxState;
	/**
	 * The operator's containment at autonomy default, read per admission:
	 * whether this session's bash and run_script calls run in the main-session
	 * sandbox (`safety.sandbox` not off and a backend present), and whether a
	 * workspace snapshot precedes a destructive call (a git work tree and
	 * `safety.snapshots` on). Only the main session's registry wires it, beside
	 * `scratchRoots`; without it default keeps today's rails.
	 */
	containment?: () => { sandbox: boolean; snapshots: boolean };
	/**
	 * How a contained call's inherited environment is scrubbed: the operator's
	 * `safety.sandboxPassEnv` and the variables Clio's targets read keys from,
	 * read per call. Absent scrubs with the name and value rules alone.
	 */
	sandboxEnv?: () => SandboxEnvPolicy;
	/** `safety.sandboxUnixSockets`, read per contained call. Absent blocks them. */
	sandboxUnixSockets?: () => UnixSocketMode;
	/**
	 * The loop guard's parent-workspace mutation epoch for a turn. The main
	 * agent's denial memory keys on it, so a refusal is repeated only while
	 * nothing it was decided on has changed. Absent means epoch 0.
	 */
	mutationEpoch?: (turnId: string) => number;
	/** Dispatch-owned restriction, fixed for the lifetime of this run. */
	readOnly?: boolean;
	/** Who can make a turn's host scope read-only here, named by its denial; absent means `clio-coder run --read-only`. */
	hostReadOnlySource?: HostReadOnlySource;
	/**
	 * The worker's standing Git allowance and attested task worktree (Phase C).
	 * Read only when `principal` is worker; the git tool body receives it too,
	 * so a typed mutation re-attests right before Git runs.
	 */
	git?: AdmissionGitContext;
	/**
	 * Told about external content (a fetched page, an MCP result) as its result
	 * is delivered, so an experimental System One classifier can read it for
	 * instructions aimed at an agent, detached, and record what it read. The
	 * result reaches the model unchanged and at once; the deterministic marker
	 * scan is what labels it. Absent in workers.
	 */
	screenToolResult?: (
		source: string,
		content: string,
		ref: string | undefined,
		restrictions: FlowRestrictionSet | null,
	) => void;
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
	 * Told when autonomy is yolo and an execute-class call was admitted as
	 * unrecognized, as it starts running. The System One gate is experimental:
	 * it is evaluated detached and recorded under `ref`, the tool call id, and it
	 * never waits for an answer or changes how the call is admitted. Only the
	 * interactive TUI registry passes it; headless and ACP have nobody to label
	 * the record. Absent in workers.
	 */
	observeToolCallGate?: (subject: ToolCallGateSubject, ref: string | undefined) => void;
	/**
	 * The attended session's test-runner consent (#377 follow-up). Read on every
	 * main admission, and granted when the operator approves the consent ask.
	 * The orchestrator passes it on every surface; a headless run's consent is
	 * never pending, so it keeps #377's allow. Workers never consult it.
	 */
	sessionCodeConsent?: Pick<SessionCodeConsent, "pending" | "grant">;
	/**
	 * The safety judge. Only the main session's registry passes it: at autonomy
	 * default a call that would park for the operator is first reviewed against
	 * the operator's own messages, and runs, comes back refused, or parks as
	 * before when the judge skips it or gives no verdict. Workers never carry it.
	 */
	safetyJudge?: SafetyJudgeSeat;
	/**
	 * The git hook drift guard. Only the main session's registry passes it: at
	 * autonomy default a git command that would run a hook file added or
	 * changed since the operator's baseline outside the sandbox asks the
	 * operator under `git-hooks-changed`. The operator's allow accepts the
	 * files the card named; an approved or judge-allowed `git-control-file`
	 * write refreshes the file it wrote. Workers never carry it.
	 */
	hookDrift?: GitHookDriftGuard;
	/**
	 * Takes a workspace snapshot before an admitted call's body runs: before the
	 * first mutating call of each turn, and before every destructive, deleting,
	 * git-discarding or branch-deleting call (`workspaceSnapshotTrigger`). Only the main
	 * session's registry wires it; worker registries never snapshot. Resolves
	 * null when snapshots are off or no session is open. An unavailable snapshot
	 * never holds the call: it proceeds and its result says "no snapshot".
	 */
	workspaceSnapshot?: (
		request: WorkspaceSnapshotRequest & { sessionId?: string },
	) => Promise<WorkspaceSnapshotOutcome | null>;
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

/**
 * What an approval carried over a narrowing rewrite (WX3), so the receipt can
 * link the plan the approver saw to the one that ran.
 */
export interface ApprovalCarry {
	/** Extension whose before_tool rewrite the approval carried over. */
	extension: string;
	/** Hash of the approved call's plan view, when the tool renders one. */
	approvedPlanHash?: string;
}

export interface ToolInvokeOptions {
	/** An invocation the harness runner makes on its own decision; never derived from model arguments. */
	origin?: "harness";
	/** With `origin: "harness"`, the card whose rounds this is. */
	harnessHold?: HarnessHold;
	/** Display and drafts for harness interviews only; never taken from model arguments. */
	harnessInterview?: {
		title: string;
		step: number;
		total?: number;
		intro?: (width: number) => string[];
		initial?: ReadonlyArray<{ selected?: readonly number[]; text?: string }>;
	};
	/** Host-owned task scope, preserved on nested gateway calls. */
	turnConstraints?: TurnConstraints;
	/** Registry-owned filter bound to the active compiled safety policy. */
	allowsObservationPath?: (path: string) => boolean;
	/** Registry-owned write-root check the typed mutation seam repeats right before it publishes (F3). */
	writeTargetViolation?: (target: string) => string | null;
	/** Registry-owned worker Git context; the git tool re-attests a typed mutation with it. */
	gitContext?: AdmissionGitContext;
	/**
	 * Registry-owned landing the awaited extension hooks were shown. A path
	 * tool refuses when its own resolution differs, so a link swapped while a
	 * hook ran cannot point the body at a file the hook never judged.
	 */
	hookLanding?: ToolCallLanding;
	/**
	 * Registry-owned information-flow check for every URL a fetch actually
	 * connects to, redirect hops included. Returns the block reason or null.
	 * Present only while the session carries restricted content.
	 */
	flowAdmitsUrl?: (url: string) => string | null;
	/** Trusted submitting host identity for nested dispatch; never model arguments. */
	hostRun?: import("../domains/dispatch/contract.js").DispatchPreparationOptions["hostRun"];
	/**
	 * Set by the main session's registry while it admits at yolo (#419), so a
	 * tool's own workspace confinement (a bash or run_script cwd) can follow the
	 * admission that passed. Never taken from a caller.
	 */
	operatorYolo?: true;
	/**
	 * Set by the main session's registry when admission decided the call runs
	 * contained: a bash or run_script call at autonomy default with a sandbox
	 * backend, or a script under the operator's yolo with `safety.sandbox:
	 * required` (#419). The tool spawns it in the main-session sandbox with this
	 * policy, and a cwd outside the workspace is allowed inside it. Never taken
	 * from a caller.
	 */
	shellSandbox?: MainSandboxPolicy;
	/** Trusted resolved model capability; never read from tool arguments. */
	supportsImages?: boolean;
	/** Trusted effective context window in tokens; sizes the per-turn observation pool. */
	contextWindow?: number;
	signal?: AbortSignal;
	runId?: string;
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	/** Provider request identity observed on the assistant message that supplied this tool block (#434). */
	callId?: string;
	attemptId?: string;
	correlationId?: string;
	/** Session-effective ceiling for one tool result, read again before every invocation. */
	toolResultMaxBytes?: number;
	pendingSkillPolicy?: PendingSkillToolPolicy;
	askUserPolicy?: AskUserToolPolicy;
	/** Host-derived display copy for an ask_user round. It has no admission authority. */
	decisionPresentation?: DecisionPresentation;
	/**
	 * Set by the ask_user tool alone: the surface may close a round nobody
	 * answers within `safety.unattendedAfterSeconds` and report it as
	 * `timedOut`, and the tool chooses for the operator (#421). A harness card
	 * or a settings confirmation never carries it, so those still wait.
	 */
	unattendedFallback?: true;
	/** Registry-authenticated one-shot operator approval for this execution. */
	approval?: {
		requestId: string;
		requestedBy: string;
		actionClass: ActionClass;
		issuer?: ApprovalAuthority;
		/** Set when the approval carried over a before_tool rewrite of the approved call (WX3). */
		carriedOver?: ApprovalCarry;
	};
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
	 * How long this call sat parked awaiting an operator decision, or the safety
	 * judge's review, reported when each wait ends. A caller timing the invocation is measuring the tool,
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
	/** Clio chose this answer because nobody answered within the unattended window (#421). */
	auto?: true;
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
	/**
	 * `agent` when Clio chose the answer because nobody answered in time
	 * (#421), with the options it passed over and why. Harness-derived; the
	 * decision board records it as Clio's decision, not the operator's.
	 */
	source?: "agent";
	alternatives?: string[];
	rationale?: string;
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
	 * Set when a System One gate raised this park, to the reason it gave. That
	 * reason is the card's whole advisory and the card asks no second site. The
	 * registry raises no gate park while the gate only records; the card and
	 * the transcript keep rendering one.
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
	/** Host-only, one-shot consent for one external Scout root (#433). */
	requestReadRootApproval?(
		root: string,
		options?: ToolInvokeOptions,
	): Promise<{ requestId: string; requestedBy: string } | null>;
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
	/** Whether this approval request is still parked, so a late timer can tell it from one already settled. */
	isParked(requestId: string): boolean;
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
	 * Forget the main agent's remembered refusals, for a host whose policy or
	 * settings reloaded: what decided them may have changed.
	 */
	forgetRefusals(): void;
	/**
	 * Resolve one parked call with a `blocked` verdict carrying `reason`.
	 * Returns true when the request was found. `denied` marks an answer that
	 * refused the call, which alone carries an operator-approval refusal
	 * account; a stop, an expiry or a shutdown only cancels the ask.
	 */
	cancelParkedCall(requestId: string, reason: string, options?: ParkCancelOptions): boolean;
	/**
	 * Resolve every parked call with a `blocked` verdict carrying `reason`.
	 * Used when the confirmation overlay is cancelled so the agent loop sees a
	 * clean rejection instead of an indefinitely pending tool call.
	 */
	cancelParkedCalls(reason: string, options?: ParkCancelOptions): void;
	/**
	 * Subscribe to the signal fired when a call is parked awaiting permission
	 * confirmation. Returns an unsubscribe handle.
	 */
	onPermissionRequired(
		listener: (call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void,
	): () => void;
}

/** How a parked call ended without an approval. */
export interface ParkCancelOptions {
	/** Someone answered the ask and refused the call. Absent means the ask was cancelled unanswered. */
	denied?: boolean;
	/**
	 * With `denied`: nobody answered within `safety.unattendedAfterSeconds`, so
	 * Clio refused the call itself (#421). Like a headless refusal, nobody
	 * could approve an identical call later in the turn, so the registry
	 * remembers it and refuses the repeat without parking it again.
	 */
	unattended?: boolean;
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
			/** The guard withheld a duplicate of a call that already succeeded (`block_tool.redundantRepeat`). */
			redundantRepeat?: true;
			/**
			 * Which layer refused the call and what would allow it. Set on the main
			 * agent's refusals that an identical repeat cannot change; the registry
			 * refuses that repeat in the same turn without running or asking again.
			 */
			denial?: ToolDenial;
	  }
	| { kind: "not_visible"; reason: string };

interface ParkedCall {
	readRootApproval?: true;
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
	/** The hook drift a `git-hooks-changed` park showed the operator. */
	hookDrift?: GitHookDriftReport;
}

export function createRegistry(deps: RegistryDeps): ToolRegistry {
	const tools = new Map<ToolName, ToolSpec>();
	// The operator's own yolo exists only on the main session's registry (#419).
	const operatorYoloScope = (level: AutonomyLevel): OperatorYoloScope | undefined =>
		level === "yolo" && (deps.principal ?? "main") === "main" && deps.scratchRoots !== undefined
			? {
					scratchRoots: deps.scratchRoots(),
					...(deps.scriptSandbox !== undefined ? { scriptSandbox: deps.scriptSandbox() } : {}),
				}
			: undefined;
	// The operator's own default exists only there too, beside its containment.
	const operatorDefaultScope = (level: AutonomyLevel): OperatorDefaultScope | undefined =>
		level === "default" &&
		(deps.principal ?? "main") === "main" &&
		deps.scratchRoots !== undefined &&
		deps.containment !== undefined
			? { level: "default", scratchRoots: deps.scratchRoots(), ...deps.containment() }
			: undefined;
	const withOperatorScope = (
		level: AutonomyLevel,
	): { operatorYolo?: OperatorYoloScope; operatorDefault?: OperatorDefaultScope } => {
		const yolo = operatorYoloScope(level);
		if (yolo !== undefined) return { operatorYolo: yolo };
		const operatorDefault = operatorDefaultScope(level);
		return operatorDefault === undefined ? {} : { operatorDefault };
	};
	/**
	 * True yolo for this registry's calls (#407): the operator's session at
	 * yolo, or a worker whose permit inherited it. Admission decides the net;
	 * this tells the information-flow gate, which runs past admission, that its
	 * refusals do not hold either.
	 */
	const trueYolo = (): boolean =>
		(deps.principal ?? "main") === "worker"
			? deps.workerExecuteAutonomy === "yolo"
			: operatorYoloScope(deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) !== undefined;
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
		return flowTransferRefusal(
			deps.safety.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
			deps.flow?.carried() ?? null,
			destination,
		);
	};

	/**
	 * Tools whose result can carry a restricted source into the transcript: the
	 * path readers the source rules name, every MCP tool, and the outbound
	 * tools. While the policy cannot say what is restricted, running one would
	 * persist content under no label, and a later resume would read it as
	 * unrestricted. Refused with the policy's own reason, which names the
	 * snapshot and the remedy and never the content.
	 */
	const sourceAdmissionRefusal = (spec: ToolSpec, call: ClassifierCall): string | null => {
		const refusal = deps.safety.policy?.informationFlow?.().refusal ?? null;
		if (refusal === null) return null;
		const isSource =
			FLOW_SOURCE_TOOLS.has(spec.name) ||
			isMcpToolName(spec.name) ||
			resolveToolDestination(spec.name, call.args) !== null;
		return isSource ? `${spec.name} refused while the information-flow policy is unavailable: ${refusal}` : null;
	};

	/** The turn whose first mutating call already took its snapshot, or is taking it. */
	let snapshotTurn: { key: string; pending: Promise<WorkspaceSnapshotOutcome | null> } | null = null;

	/**
	 * Snapshot the workspace before an admitted call's body runs, when the
	 * trigger asks for one. `note` is the line for the call's result when the
	 * snapshot, or a ref pin, could not be taken; `missing` says why no
	 * snapshot holding everything the call destroys precedes it. Only a call
	 * admitted because a snapshot undoes it (`recoverable`) is refused for
	 * that; every other call runs either way.
	 */
	const snapshotBeforeBody = async (
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
	): Promise<{ note: MiddlewareEffect | null; missing: string | null }> => {
		const recoverable = decision.policy?.recoverable === true;
		const take = deps.workspaceSnapshot;
		if (take === undefined || (deps.principal ?? "main") !== "main") {
			return { note: null, missing: recoverable ? "this session takes no workspace snapshots" : null };
		}
		let effect: ClassifierCall = call;
		try {
			effect = spec.safetyCall?.(call.args ?? {}) ?? call;
		} catch {
			// Admission already ran this projection; the call's own name still classifies.
		}
		const triggered = workspaceSnapshotTrigger(effect, decision);
		// A call admitted because a snapshot undoes it always gets its own.
		const trigger: WorkspaceSnapshotTrigger =
			recoverable && triggered.kind !== "always" ? { kind: "always", reason: "destructive" } : triggered;
		if (trigger.kind === "none") return { note: null, missing: null };
		const turnKey = options?.turnId === undefined ? null : `${options.sessionId ?? ""}\0${options.turnId}`;
		const request = {
			tool: spec.name,
			...(options?.toolCallId !== undefined && options.toolCallId.length > 0 ? { toolCallId: options.toolCallId } : {}),
			...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
			...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
		};
		let pending: Promise<WorkspaceSnapshotOutcome | null>;
		if (trigger.kind === "always") {
			pending = take({
				...request,
				reason: trigger.reason,
				...(trigger.refs !== undefined ? { refs: trigger.refs } : {}),
			});
			if (turnKey !== null) snapshotTurn = { key: turnKey, pending };
		} else {
			// A turn takes one snapshot before its first mutation; a call without a
			// turn (an operator command) has none to anchor.
			if (turnKey === null) return { note: null, missing: null };
			if (snapshotTurn?.key === turnKey) {
				// A sibling call is still taking the turn's snapshot: mutate only after it lands.
				await snapshotTurn.pending.catch(() => null);
				return { note: null, missing: null };
			}
			pending = take({ ...request, reason: "turn-start" });
			snapshotTurn = { key: turnKey, pending };
		}
		let outcome: WorkspaceSnapshotOutcome | null;
		try {
			outcome = await pending;
		} catch (err) {
			outcome = { kind: "unavailable", reason: err instanceof Error ? err.message : String(err), durationMs: 0 };
		}
		if (outcome === null) {
			return { note: null, missing: recoverable ? "workspace snapshots are off or no session is open" : null };
		}
		if (outcome.kind !== "unavailable") {
			if (outcome.pinNote === undefined && outcome.unpinned === undefined) return { note: null, missing: null };
			const detail = outcome.pinNote ?? "not pinned";
			// A call admitted because the snapshot undoes it is refused when a ref
			// it destroys is not pinned; any other call only hears about it.
			const unpinned = outcome.unpinned ?? [];
			return {
				note: { kind: "annotate_tool_result", message: `snapshot #${outcome.record.n}: ${detail}`, severity: "warn" },
				missing:
					unpinned.length > 0
						? `snapshot #${outcome.record.n} holds the files but could not pin ${unpinned.join(", ")}: ${detail}`
						: null,
			};
		}
		return {
			note: { kind: "annotate_tool_result", message: `no snapshot: ${outcome.reason}`, severity: "warn" },
			missing: outcome.reason,
		};
	};

	const runSpec = async (
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options?: ToolInvokeOptions,
	): Promise<RegistryVerdict> => {
		let resultDisposition = spec.metadata?.resultDisposition;
		// Admission prepared these arguments; a rewrite never takes over their cleanup.
		const admittedArgs = call.args ?? {};
		// An admitted rewrite carries its own prepared arguments, released alongside.
		let rewrittenArgs: Record<string, unknown> | undefined;
		/** When the body started, so an awaited after_tool hook learns how long it ran. */
		let bodyStartedAt: number | undefined;
		const bodyMs = (): number => (bodyStartedAt === undefined ? 0 : Math.round(performance.now() - bodyStartedAt));
		// Resolved once per admitted call, so the before_tool hook, the body and
		// the after_tool hook all mean the same landing (undefined: not yet resolved).
		let landing: ToolCallLanding | null | undefined;
		try {
			// Explicit information-flow violations are final at every autonomy
			// level, including yolo, and are decided before any hook can run the
			// body. Permitted here grants nothing: admission already ran. A policy
			// that cannot label sources refuses the source tools outright.
			// Yolo admits the transfer as well (#407); the source's label is still
			// absorbed below, so the session keeps the record of what it carried.
			const flowViolation = trueYolo() ? null : (sourceAdmissionRefusal(spec, call) ?? outboundFlowViolation(spec, call));
			if (flowViolation !== null) {
				recordRegistryDisposition(call, decision, "blocked", {
					reasonCode: FLOW_BLOCK_REASON_CODE,
				});
				return flowBlockedVerdict(decision, call.tool, flowViolation);
			}
			// The hook layer is the only control stage past safety admission. Guards
			// (loop, protected artifacts, dispatch dedup) are before_tool
			// registrations; the first block_tool effect decides the verdict. Keep
			// this gate inside the admission cleanup boundary: dispatch may already
			// own a provisional reservation by the time a guard blocks execution.
			let beforeEffects = runToolHook("before_tool", spec, call, decision, options);
			let block = firstBlockToolEffect(beforeEffects);
			// Extension runtime hooks are awaited only when one matches this tool,
			// so a call nothing gates takes no extra turn of the event loop.
			if (!block && deps.middleware?.hasAwaitedHook?.("before_tool", spec.name)) {
				landing = hookLanding(spec, call);
				const awaited = await runAwaitedToolHook("before_tool", spec, call, decision, options, landing, beforeEffects);
				beforeEffects = [...beforeEffects, ...awaited];
				block = firstBlockToolEffect(awaited);
				const rewrite = block ? undefined : awaited.find((effect) => effect.kind === "rewrite_tool_input");
				if (rewrite?.kind === "rewrite_tool_input") {
					const rewritten = admitRewrite(spec, call, rewrite, options);
					const carried = "carriedApproval" in rewritten ? rewritten.carriedApproval : undefined;
					if ("refusal" in rewritten) block = { kind: "block_tool", reason: rewritten.refusal, severity: "hard-block" };
					else {
						rewrittenArgs = rewritten.admitted.args ?? {};
						const judged = await judgeRewrite(spec, call, rewritten, rewrite.source, options, beforeEffects);
						block = judged.block;
						if (block === null) {
							if (judged.landing !== undefined) landing = judged.landing;
							// The prepared rewrite runs, so the body and after_tool see what the
							// hooks judged and dispatch does not prepare it a second time.
							call = rewritten.admitted;
							decision = rewritten.decision;
							if (carried !== undefined && options?.approval !== undefined)
								options = { ...options, approval: { ...options.approval, carriedOver: carried } };
							beforeEffects = [
								...beforeEffects,
								{
									kind: "annotate_tool_result",
									message: `${spec.name} input rewritten by extension ${rewrite.source}: ${rewrite.reason}${carried !== undefined && options?.approval !== undefined ? `; ${approvalGiver(options.approval.requestedBy)} carried over because the rewrite only narrows the approved call` : ""}`,
									severity: "info",
								},
							];
						}
					}
				}
			}
			if (block) {
				const verdict = guardBlockedVerdict(decision, call.tool, block.reason);
				recordRegistryDisposition(call, verdict.decision, "blocked", {
					reasonCode: GUARD_BLOCK_REASON_CODE,
				});
				return block.redundantRepeat === true ? { ...verdict, redundantRepeat: true } : verdict;
			}
			// Recoverability point: admission allowed the call and no hook blocked it,
			// so a snapshot here precedes exactly the bodies that will run.
			const snapshot = await snapshotBeforeBody(spec, call, decision, options);
			if (snapshot.missing !== null && decision.policy?.recoverable === true) {
				const reason = `${spec.name} did not run: it was admitted without approval because a workspace snapshot would undo it, and no complete snapshot could be taken (${snapshot.missing}). Take a route that discards nothing, or record the open decision for the operator.`;
				const verdict = snapshotRequiredVerdict(decision, call.tool, reason);
				recordRegistryDisposition(call, verdict.decision, "blocked", {
					reasonCode: SNAPSHOT_REQUIRED_REASON_CODE,
				});
				return verdict;
			}
			if (snapshot.note !== null) beforeEffects = [...beforeEffects, snapshot.note];
			try {
				const preparedArgs = prepareToolArgs(spec, call.args ?? {});
				resultDisposition = resolveToolResultDisposition(spec, preparedArgs);
				const {
					allowsObservationPath: _callerPathFilter,
					writeTargetViolation: _callerWriteCheck,
					gitContext: _callerGitContext,
					flowAdmitsUrl: _callerFlowAdmitsUrl,
					hookLanding: _callerHookLanding,
					operatorYolo: _callerOperatorYolo,
					shellSandbox: _callerShellSandbox,
					...callerOptions
				} = options ?? {};
				const allowsObservationPath = deps.safety.policy?.allowsObservationPath;
				const writeTargetViolation = deps.safety.policy?.writeTargetViolation;
				// What this result will carry, decided from the path or tool name
				// before the body runs, so a link swapped in afterwards cannot
				// unlabel it and so the label exists before any screening.
				const ruleRestrictions = deps.safety.policy?.flowRestrictionsFor?.(call) ?? null;
				if (landing === undefined && deps.middleware?.hasAwaitedHook?.("after_tool", spec.name))
					landing = hookLanding(spec, call);
				bodyStartedAt = performance.now();
				const result = await spec.run(preparedArgs, {
					...callerOptions,
					...(allowsObservationPath ? { allowsObservationPath } : {}),
					...(writeTargetViolation ? { writeTargetViolation } : {}),
					...(deps.principal === "worker" && deps.git !== undefined ? { gitContext: deps.git } : {}),
					...(operatorYoloScope(deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) !== undefined
						? { operatorYolo: true as const }
						: {}),
					...(decision.policy?.shellSandbox !== undefined
						? {
								shellSandbox: mainSandboxPolicy({
									...decision.policy.shellSandbox,
									...(deps.sandboxEnv !== undefined ? { env: deps.sandboxEnv() } : {}),
									...(deps.sandboxUnixSockets !== undefined ? { unixSockets: deps.sandboxUnixSockets() } : {}),
								}),
							}
						: {}),
					...(landing !== undefined && landing !== null ? { hookLanding: landing } : {}),
					...(deps.flow !== undefined && !trueYolo()
						? { flowAdmitsUrl: (url: string) => outboundFlowViolation(spec, { tool: spec.name, args: { url } }) }
						: {}),
				});
				// A body that delegated to a nested invocation the registry refused
				// (the gateway calling a denied capability) hands the refusal back
				// whole, and this call settles as that same blocked verdict: the
				// model, telemetry, and the ledger then see exactly what a direct
				// call to the capability would have produced.
				const nestedBlocked = nestedBlockedVerdict(result);
				if (nestedBlocked === null) decision = nestedDecisions.get(result) ?? decision;
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
						recordRegistryDisposition(call, decision, "blocked", { reasonCode: FLOW_BLOCK_REASON_CODE });
						return flowBlockedVerdict(decision, call.tool, reason);
					}
				}
				// A refusal settles only after its label is absorbed: an MCP server's
				// refusal quotes the server's own text, which the source rule labels
				// exactly as it would label a result.
				if (nestedBlocked !== null) return nestedBlocked;
				const carriedForScreen = mergeFlowRestrictions(deps.flow?.carried() ?? null, sourceRestrictions);
				const labeled = withFlowRestrictions(result, sourceRestrictions);
				observeExternalResult(spec, call, labeled, options, carriedForScreen);
				const digest = toolResultDigestFor(spec, labeled, resultDisposition, options);
				const syncAfter = runToolHook("after_tool", spec, call, decision, options, labeled, digest);
				const afterEffects = deps.middleware?.hasAwaitedHook?.("after_tool", spec.name)
					? [
							...syncAfter,
							...(await runAwaitedToolHook(
								"after_tool",
								spec,
								call,
								decision,
								options,
								landing === undefined ? hookLanding(spec, call) : landing,
								syncAfter,
								labeled,
								digest,
								bodyMs(),
							)),
						]
					: syncAfter;
				const finalResult = shapeToolResult(
					spec,
					applyToolResultEffects(
						labeled,
						[...beforeEffects, ...afterEffects],
						labeled !== result,
						nestedDecisions.has(result) ? "call" : nestedChainResults.has(result) ? "chain" : null,
					),
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
					recordRegistryDisposition(call, decision, "blocked", { reasonCode: FLOW_BLOCK_REASON_CODE });
					return flowBlockedVerdict(decision, call.tool, reason);
				}
				const result: ToolResult = withFlowRestrictions({ kind: "error", message }, thrownRestrictions);
				const digest = toolResultDigestFor(spec, result, resultDisposition, options);
				const syncAfter = runToolHook("after_tool", spec, call, decision, options, result, digest);
				const afterEffects = deps.middleware?.hasAwaitedHook?.("after_tool", spec.name)
					? [
							...syncAfter,
							...(await runAwaitedToolHook(
								"after_tool",
								spec,
								call,
								decision,
								options,
								landing === undefined ? hookLanding(spec, call) : landing,
								syncAfter,
								result,
								digest,
								bodyMs(),
							)),
						]
					: syncAfter;
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
			disposeAdmissionArgs(spec, admittedArgs);
			if (rewrittenArgs !== undefined && rewrittenArgs !== admittedArgs) disposeAdmissionArgs(spec, rewrittenArgs);
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
		const input = buildToolHookInput(
			hook,
			spec,
			call,
			decision,
			"operating",
			options,
			result,
			resultDigest,
			deps.flow?.carried() ?? null,
			tools.get(effectiveToolCall(call.tool, call.args).toolName as ToolName)?.metadata?.repeatableRead === true,
		);
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
	 * An extension may rewrite a call's input only into one that passes the
	 * tool's schema and is admitted again without a new decision: a rewrite
	 * that would need approval, or that safety refuses, refuses the call. The
	 * original arguments keep their own admission cleanup; a refused rewrite's
	 * prepared arguments are released here, an admitted one's by runSpec.
	 */
	const admitRewrite = (
		spec: ToolSpec,
		call: ClassifierCall,
		rewrite: Extract<MiddlewareEffect, { kind: "rewrite_tool_input" }>,
		options: ToolInvokeOptions | undefined,
	): { admitted: ClassifierCall; decision: SafetyDecision; carriedApproval?: ApprovalCarry } | { refusal: string } => {
		if (!Value.Check(spec.parameters, rewrite.args))
			return { refusal: `extension ${rewrite.source} rewrote ${spec.name} input that does not match its schema` };
		const next: ClassifierCall = { ...call, args: rewrite.args };
		const admitted = prepareAdmissionCall(spec, next);
		// An operator-approved call keeps its approval only across a rewrite the
		// tool proves narrows it (WX2), such as a desk confining each dispatched
		// worker. The grant satisfies only the ask; every refusal still applies.
		const approval = options?.approval;
		const carried =
			approval !== undefined && spec.rewriteNarrows?.(call.args ?? {}, admitted.args ?? {}) === true
				? {
						actionClass: approval.actionClass,
						requestedBy: approval.requestedBy,
						...(approval.issuer !== undefined ? { issuer: approval.issuer } : {}),
					}
				: undefined;
		const outcome = admit(admitted, carried, options);
		if (outcome.kind === "execute")
			return carried === undefined
				? { admitted, decision: outcome.decision }
				: {
						admitted,
						decision: outcome.decision,
						carriedApproval: {
							extension: rewrite.source,
							...approvedPlanHash(spec, call),
						},
					};
		if (admitted.args !== next.args) disposeAdmissionArgs(spec, admitted.args ?? {});
		const why =
			outcome.kind === "park"
				? "would need operator approval"
				: outcome.verdict.kind === "blocked"
					? outcome.verdict.reason
					: "is not admitted";
		return { refusal: `extension ${rewrite.source} rewrote ${spec.name} input into a call that ${why}` };
	};

	/** The plan hash the approver was shown, read from the approved call's trusted plan view. */
	const approvedPlanHash = (spec: ToolSpec, call: ClassifierCall): { approvedPlanHash?: string } => {
		const hash = spec.describeDispatchPlan?.(call.args ?? {}).hash;
		return hash !== undefined ? { approvedPlanHash: hash } : {};
	};

	/**
	 * The guards and extension gates judged the arguments the model sent, and a
	 * rewrite changes what runs. The call that would run goes through the same
	 * chain, so a rewrite cannot reach what a guard would have refused (a
	 * protected path, a repeat). A rewrite that restates the arguments is not
	 * judged twice, which keeps one call from being counted twice. A rewrite
	 * returned by this second awaited pass is not applied, so rewrites do not chain.
	 */
	const judgeRewrite = async (
		spec: ToolSpec,
		original: ClassifierCall,
		rewritten: { admitted: ClassifierCall; decision: SafetyDecision },
		source: string,
		options: ToolInvokeOptions | undefined,
		priorEffects: ReadonlyArray<MiddlewareEffect>,
	): Promise<{ block: Extract<MiddlewareEffect, { kind: "block_tool" }> | null; landing?: ToolCallLanding | null }> => {
		if (isDeepStrictEqual(original.args ?? {}, rewritten.admitted.args ?? {})) return { block: null };
		const sync = runToolHook("before_tool", spec, rewritten.admitted, rewritten.decision, options);
		let block = firstBlockToolEffect(sync);
		let landing: ToolCallLanding | null | undefined;
		if (!block && deps.middleware?.hasAwaitedHook?.("before_tool", spec.name)) {
			landing = hookLanding(spec, rewritten.admitted);
			const awaited = await runAwaitedToolHook(
				"before_tool",
				spec,
				rewritten.admitted,
				rewritten.decision,
				options,
				landing,
				[...priorEffects, ...sync],
			);
			block = firstBlockToolEffect(awaited);
		}
		if (block === null) return landing === undefined ? { block: null } : { block: null, landing };
		return {
			block: {
				kind: "block_tool",
				reason: `extension ${source} rewrote ${spec.name} input into a call that is blocked: ${block.reason}`,
				severity: "hard-block",
			},
		};
	};

	/**
	 * The awaited phase for extension runtime hooks. Its effects follow the
	 * synchronous ones and pass through the same sinks; a failure here is the
	 * hook's own policy, decided inside the registration, never a throw.
	 */
	const runAwaitedToolHook = async (
		hook: "before_tool" | "after_tool",
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
		landing: ToolCallLanding | null,
		priorEffects: ReadonlyArray<MiddlewareEffect>,
		result?: ToolResult,
		resultDigest?: ToolResultDigest,
		durationMs?: number,
	): Promise<ReadonlyArray<MiddlewareEffect>> => {
		if (!deps.middleware?.runAwaitedHook) return [];
		const built = buildToolHookInput(
			hook,
			spec,
			call,
			decision,
			"operating",
			options,
			result,
			resultDigest,
			deps.flow?.carried() ?? null,
			tools.get(effectiveToolCall(call.tool, call.args).toolName as ToolName)?.metadata?.repeatableRead === true,
		);
		const input = {
			...built,
			...(durationMs === undefined ? {} : { metadata: { ...built.metadata, durationMs } }),
			...(landing === null ? {} : { toolLanding: landing }),
		};
		let effects: ReadonlyArray<MiddlewareEffect>;
		try {
			effects = (await deps.middleware.runAwaitedHook(input, priorEffects)).effects;
		} catch {
			// Registrations isolate their own failures; anything escaping is a runtime bug and changes no call.
			return [];
		}
		try {
			deps.onMiddlewareEffects?.(effects, input);
		} catch {
			// Advisory sink, as in the synchronous phase.
		}
		if (!deps.absorbAwaitedEffects) return effects;
		try {
			const refusal = deps.absorbAwaitedEffects(effects, input);
			return refusal === null ? effects : [...effects, { kind: "block_tool", reason: refusal, severity: "hard-block" }];
		} catch (err) {
			// A protection that cannot be recorded must not let the call through.
			return hook === "before_tool"
				? [
						...effects,
						{
							kind: "block_tool",
							reason: `protected artifact state could not be updated: ${err instanceof Error ? err.message : String(err)}`,
							severity: "hard-block",
						},
					]
				: effects;
		}
	};

	/**
	 * Hand a result that carries someone else's text to System One's classifier,
	 * which only records. Nothing is awaited and the result is never changed, so
	 * a late reading cannot put a banner in front of content the model already read.
	 */
	const observeExternalResult = (
		spec: ToolSpec,
		call: ClassifierCall,
		result: ToolResult,
		options: ToolInvokeOptions | undefined,
		restrictions: FlowRestrictionSet | null,
	): void => {
		const screen = deps.screenToolResult;
		if (screen === undefined || result.kind !== "ok" || !screensToolResult(spec.name)) return;
		if (result.output.trim().length === 0) return;
		try {
			screen(
				`${spec.name} ${describeCallTarget(spec.name, call.args)}`.trim(),
				result.output,
				options?.toolCallId,
				restrictions,
			);
		} catch {
			// The classifier only records; a failure to start it changes no tool call.
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
				/** Which admission step asked, for the safety judge's operator-only check. */
				source?: AdmissionAskSource;
				/** A plan-scale dispatch, whose body runs only under an operator approval or yolo. */
				planScale?: true;
				/** The hook drift a `git-hooks-changed` ask names; an operator's allow accepts it. */
				hookDrift?: GitHookDriftReport;
		  };

	/** The session's test-runner consent ask, the only obstacle among a call's host effects. */
	type SessionConsentObstacle = { kind: "session-consent"; label: string; decision: SafetyDecision };

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
		const confirmation = spec.confirmationFor?.(call.args ?? {});
		// The shared evaluator decides; this adapter only parks, audits and runs.
		// The SDK bridge and the ACP mediator call the same function.
		const admission = evaluateAdmission({
			principal: deps.principal ?? "main",
			// Both the public capability and its underlying effects must pass. A
			// trusted projection cannot bypass a rule targeting the capability's own name.
			...(projectedCall !== undefined ? { capability: call, effects: [projectedCall] } : { effects: [call] }),
			safety: deps.safety,
			autonomy: level,
			...withOperatorScope(level),
			...(deps.workerExecuteAutonomy !== undefined ? { workerExecuteAutonomy: deps.workerExecuteAutonomy } : {}),
			constraints: {
				...(deps.readOnly === true ? { readOnly: true } : {}),
				...(options?.turnConstraints !== undefined ? { turnConstraints: options.turnConstraints } : {}),
				...(options?.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
				...(options?.pendingSkillPolicy !== undefined ? { pendingSkillPolicy: options.pendingSkillPolicy } : {}),
			},
			...(confirmation !== undefined
				? {
						confirmationRuleId: confirmation.ruleId,
						confirmationText: { detail: confirmation.detail, hints: confirmation.hints },
					}
				: spec.confirmationRuleId !== undefined
					? { confirmationRuleId: spec.confirmationRuleId }
					: {}),
			...(grant !== undefined
				? { authorization: { actionClass: grant.actionClass, issuer: grant.issuer ?? "operator" } }
				: {}),
			normalize: (decision) =>
				applyRegisteredToolClassification(
					decision,
					spec,
					deps.readOnly === true || options?.turnConstraints?.readOnly === true,
				),
			...(deps.git !== undefined ? { git: deps.git } : {}),
			autonomyExtra: {
				...(call.tool === ToolNames.AskUser ? { exposure: askUserExposure(call.args) } : {}),
				...(planScale ? { dispatchPlanScale: true } : {}),
			},
			...(deps.sessionCodeConsent?.pending() === true ? { sessionCodeConsentPending: true } : {}),
			...(deps.hookDrift !== undefined && (deps.principal ?? "main") === "main" ? { hookDrift: deps.hookDrift } : {}),
		});
		if (admission.kind === "deny" && admission.code === "safety_net") {
			recordRegistryDisposition(call, admission.decision, "blocked");
			const policy = admission.decision.policy;
			const allowedBy =
				policy?.policySource === "project-policy"
					? `the project's safety policy${policy.ruleId !== undefined ? ` rule ${policy.ruleId}` : ""} must change, which only the operator can do.`
					: policy?.reasonCode.startsWith(YOLO_FLOOR_REASON_PREFIX) === true
						? "nothing within this run; it is the yolo floor, which holds at every autonomy level."
						: "nothing within this run; it is a hard block of Clio's safety net.";
			return {
				kind: "terminal",
				verdict: withDenial(
					{ kind: "blocked", reason: admission.reason, decision: admission.decision },
					"clio_policy",
					allowedBy,
					policy?.ruleId ?? policy?.reasonCode,
				),
			};
		}
		const effectOutcome = admitHostEffects(call, spec, admission, level);
		if (effectOutcome?.kind === "terminal") return effectOutcome;
		if (admission.kind === "deny")
			return { kind: "terminal", verdict: deniedVerdict(call, admission, options?.turnConstraints) };
		if (admission.kind === "allow") {
			if (effectOutcome !== null) {
				const decision = sessionConsentParkDecision(call, admission.decision, effectOutcome, dispatchPlan);
				return {
					kind: "park",
					decision,
					axis: approvalAxisId(decision, level),
					approvalAuthority: "operator",
					source: "session-consent",
				};
			}
			recordRegistryDisposition(call, admission.decision, "allowed");
			return { kind: "execute", spec, decision: admission.decision };
		}
		const askDecision =
			admission.source === "autonomy" && planScale && dispatchPlan !== null
				? toDispatchPlanAskDecision(admission.netDecision, level, dispatchPlan)
				: admission.decision;
		if (effectOutcome !== null) {
			// One combined ask: approving the call's own autonomy ask also gives the
			// consent its checks need, so the operator is never asked twice (#377
			// follow-up).
			const decision = sessionConsentParkDecision(call, askDecision, effectOutcome, dispatchPlan);
			return {
				kind: "park",
				decision,
				axis: approvalAxisId(decision, level),
				approvalAuthority: "operator",
				...(dispatchPlan !== null ? { dispatchPlan } : {}),
				source: "session-consent",
				...(planScale ? { planScale: true as const } : {}),
			};
		}
		return {
			kind: "park",
			decision: askDecision,
			axis: approvalAxisId(askDecision, level),
			approvalAuthority: admission.approvalAuthority,
			...(admission.source === "autonomy" && dispatchPlan !== null ? { dispatchPlan } : {}),
			source: admission.source,
			...(planScale ? { planScale: true as const } : {}),
			...(admission.hookDrift !== undefined ? { hookDrift: admission.hookDrift } : {}),
		};
	};

	/**
	 * Attach the structured account of a refusal. Worker registries leave it
	 * off: a worker's refusals already end in the typed permission_required
	 * contract (`src/engine/worker-refusals.ts`), which counts every ask.
	 */
	const withDenial = (
		verdict: Extract<RegistryVerdict, { kind: "blocked" }>,
		layer: DenialLayer,
		allowedBy: string,
		code?: string,
	): Extract<RegistryVerdict, { kind: "blocked" }> =>
		deps.principal === "worker"
			? verdict
			: {
					...verdict,
					denial: {
						layer,
						actionClass: verdict.decision.classification.actionClass,
						retryable: false,
						allowedBy,
						...(code !== undefined ? { code } : {}),
					},
				};

	/**
	 * The refusal account of an ask that was answered without an approval.
	 * Only a refusal carries one: an operator's or client's deny, or a headless
	 * run or a registry without a listener, which refuse every ask. A run
	 * cancelled or shut down, a stopped turn, an expired ask and the tool-call
	 * limit never answered the question, so the identical call stays askable.
	 */
	const parkDenial = (
		verdict: Extract<RegistryVerdict, { kind: "blocked" }>,
		reason: string,
		denied = false,
		unattended = false,
	): Extract<RegistryVerdict, { kind: "blocked" }> => {
		const headless = reason.startsWith(HEADLESS_PERMISSION_DENIED_MARKER) || reason === NO_PARK_LISTENER_REASON;
		const timedOut = denied && unattended;
		if (!denied && !headless) return verdict;
		const refused = withDenial(
			verdict,
			"operator_approval",
			headless
				? "an operator must approve it, which a headless run cannot do: rerun interactively, or let an approved policy or autonomy level admit it."
				: timedOut
					? UNATTENDED_ALLOWED_BY
					: "the operator must approve it; ask what to do instead of repeating it.",
			verdict.decision.policy?.ruleId,
		);
		if ((headless || timedOut) && refused.denial !== undefined) unattendedDenials.add(refused.denial);
		return refused;
	};

	/** Registry verdict and audit row for a hard denial past the safety net. */
	const deniedVerdict = (
		call: ClassifierCall,
		admission: Extract<AdmissionDisposition, { kind: "deny" }>,
		constraints: TurnConstraints | undefined,
	): Extract<RegistryVerdict, { kind: "blocked" }> => {
		const decision = admission.decision;
		if (admission.code === "read_only") {
			// A read-only dispatch and a host's read-only task scope deny alike;
			// the reason code names which one the operator set.
			const hostSource = deps.readOnly === true ? null : HOST_READ_ONLY_SOURCES[deps.hostReadOnlySource ?? "run"];
			const reasonCode = hostSource !== null ? "task:read_only" : "dispatch:read_only";
			const verdict = readOnlyDeniedVerdict(decision, call.tool, hostSource, reasonCode);
			recordRegistryDisposition(call, verdict.decision, "denied", { reasonCode });
			return withDenial(
				verdict,
				"clio_policy",
				hostSource?.remedy ?? "the dispatching agent must dispatch this work without read-only.",
				reasonCode,
			);
		}
		if (admission.code === "skill_surface" && admission.skillViolation !== undefined) {
			const verdict = skillSurfaceBlockedVerdict(decision, call.tool, admission.skillViolation);
			recordRegistryDisposition(call, verdict.decision, "blocked", {
				reasonCode: "skill_surface",
			});
			return verdict;
		}
		if (admission.code === "tool_scope" || admission.code === "skills_disabled") {
			const sources = toolSurfaceSources(constraints).filter(
				(source) => !turnAllowsTool({ allowedTools: source.tools }, call.tool),
			);
			const allowed = constraints?.allowedTools;
			const reason =
				admission.code === "tool_scope"
					? [
							admission.reason,
							...(sources.length > 0 ? [`Scope source: ${sources.map((source) => source.source).join("; ")}.`] : []),
							...(allowed !== undefined ? [`Allowed tools: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`] : []),
							"Do not retry this tool within the current scope.",
						].join(" ")
					: admission.reason;
			const blocked: SafetyDecision = {
				kind: "block",
				classification: decision.classification,
				rejection: {
					short: `${call.tool} blocked: turn constraint`,
					detail: reason,
					hints: ["Work within the operator's task scope; approval of an individual tool does not widen it."],
				},
			};
			recordRegistryDisposition(call, blocked, "blocked", { reasonCode: "turn_constraint" });
			return withDenial(
				{ kind: "blocked", reason, decision: blocked },
				"clio_policy",
				admission.code === "skills_disabled"
					? "the host must allow skills for this task."
					: sources.length > 0
						? sources.map((source) => source.remedy).join(" ")
						: "Ask the submitting operator to widen the task scope, then resubmit. Do not retry in this turn.",
				"turn_constraint",
			);
		}
		if (admission.code === "git_destructive") {
			recordRegistryDisposition(call, decision, "blocked", { reasonCode: "classification:git_destructive" });
			return withDenial(
				{ kind: "blocked", reason: admission.reason, decision },
				"clio_policy",
				"nothing within this run; destructive git is a hard block.",
				"classification:git_destructive",
			);
		}
		const reasonCode = `admission:${admission.code}`;
		const blocked: SafetyDecision = {
			kind: "block",
			classification: decision.classification,
			rejection: { short: admission.reason, detail: admission.reason, hints: [] },
			...(decision.policy !== undefined ? { policy: { ...decision.policy, reasonCode } } : {}),
		};
		recordRegistryDisposition(call, blocked, "blocked", { reasonCode });
		return withDenial(
			{ kind: "blocked", reason: admission.reason, decision: blocked },
			"clio_policy",
			"nothing within this run.",
			reasonCode,
		);
	};

	/**
	 * Admit the host commands a call runs on its caller's behalf (F6). Dispatch
	 * host verification executes declared checks as the dispatching agent, so a
	 * check must pass the same safety net and autonomy mapping as the direct
	 * verify call would. A check that would park is refused rather than parked:
	 * the operator is asked about the dispatch plan, not about each command it
	 * implies, and a headless run has nobody to ask. Every effect is evaluated
	 * so a hard block anywhere wins over an earlier ask.
	 *
	 * The session's test-runner consent is the exception when it is the only
	 * obstacle and the call itself is admitted or asks the operator only through
	 * autonomy: the effect returns the consent ask, and the caller parks once on
	 * a decision that approves both, so a fresh attended session can approve it
	 * there instead of first running a test runner directly.
	 */
	const admitHostEffects = (
		call: ClassifierCall,
		spec: ToolSpec,
		callAdmission: AdmissionDisposition,
		level: AutonomyLevel,
	): Extract<AdmitOutcome, { kind: "terminal" }> | SessionConsentObstacle | null => {
		const decision = callAdmission.decision;
		const effects = spec.hostEffectCalls?.(call.args ?? {}) ?? [];
		if (effects.length === 0) return null;
		let hard: { label: string; cause: string } | null = null;
		let soft: { label: string; cause: string } | null = null;
		let consent: { label: string; cause: string; decision: SafetyDecision } | null = null;
		for (const effect of effects) {
			const effectSpec = tools.get(effect.call.tool as ToolName);
			// Each check is admitted exactly as its direct call would be, by the
			// same evaluator, and never under a one-shot grant for this call.
			const admission = evaluateAdmission({
				principal: deps.principal ?? "main",
				effects: [effect.call],
				safety: deps.safety,
				autonomy: level,
				...withOperatorScope(level),
				...(deps.workerExecuteAutonomy !== undefined ? { workerExecuteAutonomy: deps.workerExecuteAutonomy } : {}),
				...(effectSpec !== undefined
					? { normalize: (raw: SafetyDecision) => applyRegisteredToolClassification(raw, effectSpec) }
					: {}),
				// A host check that runs a test runner owes the same session consent
				// its direct verify call would ask for.
				...(deps.sessionCodeConsent?.pending() === true ? { sessionCodeConsentPending: true } : {}),
			});
			if (
				admission.kind === "deny" ||
				(admission.kind === "ask" && admission.decision.classification.actionClass === "git_destructive")
			) {
				hard = { label: effect.label, cause: admission.reason };
				break;
			}
			if (admission.kind !== "ask") continue;
			if (admission.source === "session-consent") {
				if (consent === null) consent = { label: effect.label, cause: admission.reason, decision: admission.decision };
			} else if (soft === null) soft = { label: effect.label, cause: admission.reason };
		}
		const consentParks =
			callAdmission.kind === "allow" ||
			(callAdmission.kind === "ask" &&
				callAdmission.source === "autonomy" &&
				callAdmission.approvalAuthority === "operator");
		if (hard === null && soft === null && consentParks && consent !== null && consent.decision.kind === "ask") {
			return { kind: "session-consent", label: consent.label, decision: consent.decision };
		}
		const refused = hard ?? soft ?? consent;
		if (refused === null) return null;
		const reason = `${call.tool} refused: ${refused.label} would not be admitted as a direct call (${refused.cause})`;
		const reasonCode = hard !== null ? "host_effect_blocked" : "host_effect_not_admitted";
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
			...(decision.policy !== undefined ? { policy: { ...decision.policy, reasonCode } } : {}),
		};
		recordRegistryDisposition(call, blocked, "blocked", { reasonCode });
		return { kind: "terminal", verdict: { kind: "blocked", reason, decision: blocked } };
	};

	const recordRegistryDisposition = (
		call: ClassifierCall,
		decision: SafetyDecision,
		auditDecision: "allowed" | "blocked" | "permission_requested" | "denied",
		overrides?: { reasonCode?: string; requestId?: string },
	): void => {
		// Evaluation records nothing: admission keeps the final disposition and the classification together (#434).
		deps.safety.audit.recordToolCall?.({
			tool: call.tool,
			classification: decision.classification,
			decision: auditDecision,
			...(overrides?.requestId !== undefined ? { requestId: overrides.requestId } : {}),
			...(decision.policy !== undefined ? { policy: decision.policy } : {}),
			...(overrides?.reasonCode !== undefined ? { reasonCode: overrides.reasonCode } : {}),
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
		});
		return verdict;
	};

	const cleanupParkedEntry = (entry: ParkedCall): void => {
		entry.abortCleanup?.();
		delete entry.abortCleanup;
	};

	const resolveParkedAsBlocked = (entry: ParkedCall, reason: string, options?: ParkCancelOptions): void => {
		withToolTelemetryContext(entry.options ?? {}, () => {
			cleanupParkedEntry(entry);
			disposeAdmissionArgs(tools.get(entry.call.tool as ToolName), entry.call.args ?? {});
			// A denied/cancelled park is still a model attempt: observe it so
			// identical retries trip the loop detector. When the detector fires, its
			// reason replaces the generic denial so the model gets recovery guidance.
			const loopReason = observeRejectedAttempt(entry.call, entry.decision, entry.options);
			entry.resolve(
				guardOverrideForRejectedAttempt(entry.call, entry.decision, loopReason) ??
					parkDenial(
						parkAnsweredBlockedVerdict(entry.decision, entry.call.tool, loopReason ?? reason),
						reason,
						options?.denied,
						options?.unattended,
					),
			);
		});
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
	 * the one place where nothing has read the command at all. A bound System One
	 * site reads it alongside, detached, and its reading is only recorded: the
	 * call is admitted exactly as yolo admits it and never waits for the engine.
	 * A call the classifier already parks, blocks or recognizes does not reach it.
	 */
	const observeUnrecognizedExecute = (
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
	): void => {
		const observe = deps.observeToolCallGate;
		if (observe === undefined) return;
		const level = deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		if (
			level !== "yolo" ||
			decision.classification.actionClass !== "execute" ||
			decision.policy?.execRecognition !== "unrecognized"
		) {
			return;
		}
		try {
			observe(
				{
					tool: call.tool,
					actionClass: decision.classification.actionClass,
					target: describeCallTarget(call.tool, call.args),
				},
				options?.toolCallId,
			);
		} catch {
			// The gate only records; a failure to start it leaves the call as yolo admitted it.
		}
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

	const cancelParkedCallById = (requestId: string, reason: string, options?: ParkCancelOptions): boolean => {
		const index = parked.findIndex((entry) => entry.meta.requestId === requestId);
		if (index === -1) return false;
		const [entry] = parked.splice(index, 1);
		if (!entry) return false;
		resolveParkedAsBlocked(entry, reason, options);
		const next = parked[0];
		if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		return true;
	};

	/**
	 * A typed write the operator approved or the judge allowed under
	 * git-control-file landed; the hook files it wrote join the drift baseline,
	 * so the next git command does not ask about the change just approved.
	 */
	const refreshHooksAfterGitControlWrite = (
		call: ClassifierCall,
		decision: SafetyDecision,
		verdict: RegistryVerdict,
	): void => {
		if (deps.hookDrift === undefined || verdict.kind !== "ok" || verdict.result.kind === "error") return;
		if (approvalRailOf(decision) !== GIT_CONTROL_FILE_RULE_ID) return;
		const targets = [call.args?.path, call.args?.file_path]
			.filter((target): target is string => typeof target === "string" && target.length > 0)
			.map((target) => resolvePath(process.cwd(), target));
		try {
			deps.hookDrift.refresh(targets);
		} catch {
			// The baseline keeps its old entry, so the next git command asks: the safe direction.
		}
	};

	/**
	 * The safety judge's review of a main-session ask at autonomy default.
	 * `skip` everywhere else: workers, yolo, a registry without a judge, and a
	 * call already cancelled. The time spent judging is reported as park time,
	 * so the tool's own duration stays a measurement of the tool.
	 */
	const judgeParkedCall = (
		call: ClassifierCall,
		outcome: Extract<AdmitOutcome, { kind: "park" }>,
		options: ToolInvokeOptions | undefined,
	): SafetyJudgeOutcome | Promise<SafetyJudgeOutcome> => {
		const judge = deps.safetyJudge;
		if (judge === undefined || (deps.principal ?? "main") !== "main") return SAFETY_JUDGE_SKIP;
		if ((deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) !== "default" || options?.signal?.aborted === true) {
			return SAFETY_JUDGE_SKIP;
		}
		let pending: SafetyJudgeOutcome | Promise<SafetyJudgeOutcome>;
		try {
			pending = judge.review({
				tool: call.tool,
				args: call.args,
				decision: outcome.decision,
				...(outcome.source !== undefined ? { source: outcome.source } : {}),
				approvalAuthority: outcome.approvalAuthority,
				...(outcome.planScale === true ? { dispatchPlan: true } : {}),
				...(options?.origin === "harness" ? { harness: true } : {}),
				...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
				...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
				...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
				...(options?.signal !== undefined ? { signal: options.signal } : {}),
			});
		} catch {
			// The judge's own failure is no verdict: the call takes today's path.
			return SAFETY_JUDGE_SKIP;
		}
		const report = (judged: SafetyJudgeOutcome): SafetyJudgeOutcome => {
			if (judged.kind !== "skip" && judged.latencyMs > 0) options?.onParked?.(judged.latencyMs);
			return judged;
		};
		// Only a review that asks a model is awaited, so every other ask parks in
		// the same tick it did before the judge existed.
		return pending instanceof Promise ? pending.then(report, () => SAFETY_JUDGE_SKIP) : report(pending);
	};

	/** Admit, park or run one call; `invoke` adds the main agent's denial memory around it. */
	const invokeAdmitted = async (call: ClassifierCall, options?: ToolInvokeOptions): Promise<RegistryVerdict> => {
		const admissionCall = prepareAdmissionCall(tools.get(call.tool as ToolName), call);
		const outcome = admit(admissionCall, undefined, options);
		if (outcome.kind === "terminal") {
			disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
			return observeBlockedAttempt(admissionCall, outcome.verdict, options) ?? outcome.verdict;
		}
		if (outcome.kind === "execute") {
			observeUnrecognizedExecute(admissionCall, outcome.decision, options);
			return runSpec(outcome.spec, admissionCall, outcome.decision, options);
		}
		// The safety judge reviews the ask before anyone is asked. An allow runs
		// the call, a block refuses it back to the model, and anything else parks
		// exactly as before, with the judge's reason on the card when it had one.
		const pendingJudgement = judgeParkedCall(call, outcome, options);
		const judged = pendingJudgement instanceof Promise ? await pendingJudgement : pendingJudgement;
		const judgedSpec = tools.get(admissionCall.tool as ToolName);
		if (judged.kind === "allow" && judgedSpec !== undefined) {
			const allowed = safetyJudgeAllowedDecision(outcome.decision);
			recordRegistryDisposition(admissionCall, allowed, "allowed", {
				reasonCode: SAFETY_JUDGE_ALLOW_REASON_CODE,
			});
			const verdict = await runSpec(judgedSpec, admissionCall, allowed, options);
			refreshHooksAfterGitControlWrite(admissionCall, outcome.decision, verdict);
			return verdict;
		}
		if (judged.kind === "block") {
			disposeAdmissionArgs(judgedSpec, admissionCall.args ?? {});
			const reasonCode = `${SAFETY_JUDGE_REASON_PREFIX}${judged.rule}`;
			const blocked: SafetyDecision = {
				kind: "block",
				classification: outcome.decision.classification,
				rejection: {
					short: `${call.tool} blocked by the safety judge (rule ${judged.rule})`,
					detail: judged.refusal,
					hints: [],
				},
				...(outcome.decision.policy !== undefined
					? { policy: { ...outcome.decision.policy, kind: "block" as const, reasonCode } }
					: {}),
			};
			recordRegistryDisposition(admissionCall, blocked, "blocked", { reasonCode });
			const verdict = withDenial(
				{ kind: "blocked", reason: judged.refusal, decision: blocked },
				"clio_policy",
				judged.allowedBy,
				reasonCode,
			);
			return observeBlockedAttempt(admissionCall, verdict, options) ?? verdict;
		}
		const judgeGate = judged.kind === "park" ? { gateReason: judged.gateReason, gateBuild: judged.build } : {};
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
				parkDenial(
					parkAnsweredBlockedVerdict(outcome.decision, admissionCall.tool, loopReason ?? NO_PARK_LISTENER_REASON),
					NO_PARK_LISTENER_REASON,
				)
			);
		}
		const abortReason = PARK_ABORT_REASON;
		if (options?.signal?.aborted) {
			disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
			const loopReason = observeRejectedAttempt(admissionCall, outcome.decision, options);
			return { kind: "blocked", reason: loopReason ?? abortReason, decision: outcome.decision };
		}
		return new Promise<RegistryVerdict>((resolve) => {
			const meta: PermissionRequiredMeta = {
				requestId: nextApprovalRequestId(),
				axis: outcome.axis,
				approvalAuthority: outcome.approvalAuthority,
				...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
				...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
				...(options?.toolCallId !== undefined && options.toolCallId.length > 0 ? { toolCallId: options.toolCallId } : {}),
				...(outcome.dispatchPlan !== undefined ? { dispatchPlan: outcome.dispatchPlan } : {}),
				...judgeGate,
			};
			// A worker's host handoff decides whether an ask is delivered or refused locally (#434).
			if (deps.principal !== "worker")
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
				...(outcome.hookDrift !== undefined ? { hookDrift: outcome.hookDrift } : {}),
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
	};

	/**
	 * Refused calls of the main agent by turn, mutation epoch and call
	 * identity, oldest first. Grants, a changed autonomy level and a reload
	 * clear it, because each can change the answer.
	 */
	const deniedCalls = new Map<string, Extract<RegistryVerdict, { kind: "blocked" }>>();
	let deniedCallsLevel: AutonomyLevel | null = null;
	/**
	 * Operator-approval refusals that no operator could have answered
	 * otherwise: a headless run, a registry with no listener, or an attended
	 * card nobody answered within the unattended window (#421). An attended
	 * operator who refused once may approve when asked again, so only these
	 * are remembered.
	 */
	const unattendedDenials = new WeakSet<ToolDenial>();
	const rememberedRefusal = (verdict: RegistryVerdict): verdict is Extract<RegistryVerdict, { kind: "blocked" }> =>
		verdict.kind === "blocked" &&
		verdict.denial !== undefined &&
		(verdict.denial.layer !== "operator_approval" || unattendedDenials.has(verdict.denial));

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
			return withToolTelemetryContext(options ?? {}, async () => {
				if (deps.principal === "worker") return invokeAdmitted(call, options);
				// A refusal is final for the identical call within the turn: the same
				// policy, the same operator and the same server would answer it the
				// same way. Refusing the repeat here, before admission, keeps it from
				// asking the operator again or reaching the server again, where the
				// loop guard would otherwise allow two more attempts first. A call with
				// no turn (/council, an ACP host dispatch) is the operator's own
				// command, so nothing is remembered for it.
				const level = deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
				if (level !== deniedCallsLevel) {
					deniedCalls.clear();
					deniedCallsLevel = level;
				}
				const turnId = options?.turnId;
				const key =
					turnId === undefined
						? null
						: `${turnId}\0${deps.mutationEpoch?.(turnId) ?? 0}\0${hashToolCall(call.tool, call.args)}`;
				const prior = key === null ? undefined : deniedCalls.get(key);
				if (prior?.denial !== undefined) {
					const decision: SafetyDecision = {
						kind: "block",
						classification: prior.decision.classification,
						rejection:
							prior.decision.kind === "allow"
								? { short: prior.reason, detail: prior.reason, hints: [] }
								: prior.decision.rejection,
						...(prior.decision.policy !== undefined
							? { policy: { ...prior.decision.policy, reasonCode: DENIED_REPEAT_REASON_CODE } }
							: {}),
					};
					const repeat: Extract<RegistryVerdict, { kind: "blocked" }> = {
						kind: "blocked",
						reason: `${repeatedDenialReason(effectiveToolCall(call.tool, call.args).toolName, prior.denial)}\n${prior.reason}`,
						decision,
						// A repeat of an ask nobody could approve is still that unanswered
						// ask, so receipts keep counting it as a permission request.
						...(prior.deniedPark === true ? { deniedPark: true } : {}),
						denial: prior.denial,
					};
					recordRegistryDisposition(call, decision, "blocked", { reasonCode: DENIED_REPEAT_REASON_CODE });
					return observeBlockedAttempt(call, repeat, options) ?? repeat;
				}
				const verdict = await invokeAdmitted(call, options);
				// An operator's answer can grant what an earlier call was refused.
				if (effectiveToolCall(call.tool, call.args).toolName === ToolNames.AskUser && askUserAnswered(verdict)) {
					deniedCalls.clear();
				}
				if (key !== null && rememberedRefusal(verdict) && verdict.denial !== undefined) {
					// Only a remembered refusal tells the model its repeat is refused
					// without running; an attended operator's refusal, a worker's and a
					// turnless call's are asked or run again.
					const remembered: Extract<RegistryVerdict, { kind: "blocked" }> = {
						...verdict,
						denial: { ...verdict.denial, repeatRefused: true },
					};
					deniedCalls.delete(key);
					deniedCalls.set(key, remembered);
					if (deniedCalls.size > DENIED_CALL_MEMORY_LIMIT) {
						const oldest = deniedCalls.keys().next().value;
						if (oldest !== undefined) deniedCalls.delete(oldest);
					}
					return remembered;
				}
				return verdict;
			});
		},
		async requestReadRootApproval(root, options) {
			return withToolTelemetryContext(options ?? {}, async () => {
				if ((deps.principal ?? "main") !== "main" || options?.signal?.aborted || permissionListeners.size === 0)
					return null;
				const call: ClassifierCall = Object.freeze({ tool: ToolNames.Read, args: Object.freeze({ path: root }) });
				const admission = evaluateAdmission({
					principal: "main",
					effects: [call],
					safety: deps.safety,
					autonomy: "default",
					confirmationRuleId: "dispatch-external-read",
					confirmationText: {
						detail: `Allow one read-only Scout run to inspect external root ${JSON.stringify(root)}? This grants no writes, commands, or access to other external roots.`,
						hints: ["This approval expires with this Scout run."],
					},
				});
				if (admission.kind !== "ask") return null;
				const decision: SafetyDecision = {
					...admission.decision,
					kind: "ask",
					confirmationRuleId: "dispatch-external-read",
					rejection: {
						short: `Scout external read root needs approval: ${root}`,
						detail: `Allow one read-only Scout run to inspect external root ${JSON.stringify(root)}? No writes or commands are granted.`,
						hints: ["One approval covers only this run and root."],
					},
				};
				const meta: PermissionRequiredMeta = {
					requestId: nextApprovalRequestId(),
					axis: "net:dispatch-external-read",
					approvalAuthority: "operator",
					...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
					...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
					...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
				};
				return await new Promise((resolve) => {
					const started = performance.now();
					let reported = false;
					const closePark = () => {
						if (!reported) {
							reported = true;
							options?.onParked?.(Math.round(performance.now() - started));
						}
					};
					const entry: ParkedCall = {
						call,
						decision,
						meta,
						readRootApproval: true,
						closePark,
						...(options !== undefined ? { options } : {}),
						resolve(verdict) {
							closePark();
							const details = verdict.kind === "ok" ? verdict.result.details : undefined;
							resolve(
								details && typeof details.requestId === "string" && typeof details.requestedBy === "string"
									? { requestId: details.requestId, requestedBy: details.requestedBy }
									: null,
							);
						},
					};
					if (options?.signal) {
						const abort = () => cancelParkedCallById(meta.requestId, PARK_ABORT_REASON);
						options.signal.addEventListener("abort", abort, { once: true });
						entry.abortCleanup = () => options.signal?.removeEventListener("abort", abort);
					}
					parked.push(entry);
					recordRegistryDisposition(call, decision, "permission_requested", {
						requestId: meta.requestId,
						reasonCode: "confirmation:dispatch-external-read",
					});
					notifyPermissionRequired(call, decision, meta);
				});
			});
		},
		hasParkedCalls: () => parked.length > 0,
		parkedCount: () => parked.length,
		renotifyHead() {
			const next = parked[0];
			if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		},
		async resumeParkedCalls(grant?: OneShotGrant) {
			// A grant, session consent included, changes what admission answers.
			if (grant !== undefined) deniedCalls.clear();
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
				await withToolTelemetryContext(entry.options ?? {}, async () => {
					if (entry.readRootApproval === true) {
						if (grant === undefined || grant.actionClass !== "read" || (grant.issuer ?? "operator") !== "operator") {
							reparkEntry(entry, reparkIndex);
							return;
						}
						cleanupParkedEntry(entry);
						const disposition = evaluateAdmission({
							principal: "main",
							effects: [entry.call],
							safety: deps.safety,
							autonomy: "default",
							authorization: { actionClass: "read", issuer: "operator" },
						});
						entry.closePark();
						if (disposition.kind !== "allow") {
							entry.resolve({
								kind: "blocked",
								reason: "External read root no longer passes safety admission",
								decision: disposition.decision,
							});
							return;
						}
						recordRegistryDisposition(entry.call, disposition.decision, "allowed", {
							requestId: entry.meta.requestId,
							reasonCode: "confirmation:dispatch-external-read",
						});
						entry.resolve({
							kind: "ok",
							decision: disposition.decision,
							result: {
								kind: "ok",
								output: "External Scout read approved for one run.",
								details: { requestId: entry.meta.requestId, requestedBy: grant.requestedBy },
							},
						});
						return;
					}
					// A one-shot grant covers only the parked call it selected. Calls
					// that parked while the overlay was already open remain queued and
					// need their own confirmation, so a concurrent privileged call
					// cannot ride along on a grant approved for another call.
					const observed = grant?.requestId !== undefined && grant.requestId === entry.meta.requestId;
					if (grant !== undefined && entry.decision.classification.actionClass !== grant.actionClass) {
						if (observed) grant?.onExecution?.({ phase: "not_executed", reason: "the grant names another action class" });
						reparkEntry(entry, reparkIndex);
						return;
					}
					// The operator approved the session's test-runner consent ask; the
					// consent covers every later test runner this session. It is given
					// before re-admission, because a dispatch or job that parked on it
					// re-admits its host checks afresh and must find it given.
					if (
						grant !== undefined &&
						(grant.issuer ?? "operator") === "operator" &&
						entry.decision.kind === "ask" &&
						entry.decision.confirmationRuleId === SESSION_CODE_CONSENT_RULE_ID
					) {
						deps.sessionCodeConsent?.grant();
					}
					// The operator allowed a git-hooks-changed ask: the files the card
					// named join the baseline before re-admission, so a file changed
					// after the card was drawn still asks.
					if (grant !== undefined && (grant.issuer ?? "operator") === "operator" && entry.hookDrift !== undefined) {
						deps.hookDrift?.accept(entry.hookDrift);
					}
					const outcome = admit(entry.call, grant, entry.options);
					if (outcome.kind === "park") {
						if (observed) {
							grant?.onExecution?.({ phase: "not_executed", reason: "admission still requires another approval" });
						}
						reparkEntry(entry, reparkIndex);
						return;
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
						return;
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
										...(grant.issuer !== undefined ? { issuer: grant.issuer } : {}),
									},
								};
					// Seal the park before the body runs. Everything after this line is
					// the tool working, and the caller charges that to the tool.
					entry.closePark();
					// An operator's approval turns the safety judge's review back on after it
					// handed calls to the operator.
					if (grant !== undefined && (grant.issuer ?? "operator") === "operator") deps.safetyJudge?.operatorApproved();
					if (observed) grant?.onExecution?.({ phase: "start" });
					const verdict = await runSpec(outcome.spec, entry.call, outcome.decision, approvedOptions);
					if (grant !== undefined && (grant.issuer ?? "operator") === "operator") {
						refreshHooksAfterGitControlWrite(entry.call, entry.decision, verdict);
					}
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
				});
			}
			const next = parked[0];
			if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		},
		forgetRefusals() {
			deniedCalls.clear();
		},
		cancelParkedCall(requestId, reason, cancelOptions) {
			return cancelParkedCallById(requestId, reason, cancelOptions);
		},
		cancelParkedCalls(reason, cancelOptions) {
			if (parked.length === 0) return;
			const pending = parked.splice(0, parked.length);
			for (const entry of pending) {
				resolveParkedAsBlocked(entry, reason, cancelOptions);
			}
		},
		isParked: (requestId) => parked.some((entry) => entry.meta.requestId === requestId),
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

/** A landing the hook cannot have is no landing: the call is judged on its arguments, as before. */
function hookLanding(spec: ToolSpec, call: ClassifierCall): ToolCallLanding | null {
	try {
		return spec.describeHookLanding?.(call.args ?? {}) ?? pathToolLanding(spec.name, call.args);
	} catch {
		// Resolution only reads the filesystem; a failure leaves the hook its raw arguments.
		return null;
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

function applyRegisteredToolClassification(decision: SafetyDecision, spec: ToolSpec, readOnly = false): SafetyDecision {
	if (decision.classification.actionClass !== "unknown") return decision;
	const classification = {
		actionClass: readOnly ? (spec.readOnlyActionClass ?? spec.baseActionClass) : spec.baseActionClass,
		reasons: [`registered tool: ${spec.name}`],
	};
	return decision.kind === "allow" ? { kind: "allow", classification } : { ...decision, classification };
}

/** Final reason code for a before_tool guard block, matching the audit convention (sd-01 §2.5). */
const GUARD_BLOCK_REASON_CODE = "guard_block";
/** Reason code of a recoverable call refused because the snapshot that would undo it was not taken. */
const SNAPSHOT_REQUIRED_REASON_CODE = "snapshot-required";
/** Reason code of a final information-flow block, for the audit row and the panel. */
const FLOW_BLOCK_REASON_CODE = "information-flow";
/** The path-reading tools a source rule can name; kept in step with the evaluator's READ_PATH_TOOLS. */
const FLOW_SOURCE_TOOLS: ReadonlySet<string> = new Set([
	ToolNames.Read,
	ToolNames.Ls,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Data,
]);
/** Result detail that carries a restricted read's label to the host; never model text. */
export const FLOW_RESTRICTIONS_DETAIL = "clio_coder_flow_restrictions";

/** An error message can quote the source too, so both result kinds carry the label. */
function withFlowRestrictions(result: ToolResult, restrictions: FlowRestrictionSet | null): ToolResult {
	if (restrictions === null) return result;
	return { ...result, details: { ...(result.details ?? {}), [FLOW_RESTRICTIONS_DETAIL]: restrictions } };
}

const SAFETY_JUDGE_SKIP: SafetyJudgeOutcome = { kind: "skip" };
/** Audit code of a call the safety judge allowed instead of parking it. */
const SAFETY_JUDGE_ALLOW_REASON_CODE = "safety-judge:allow";
/** Prefix of the audit and denial code of a safety judge block; the judge's rule category follows. */
const SAFETY_JUDGE_REASON_PREFIX = "safety-judge:";

/** The parked ask turned into the allow the judge gave, keeping its classification and policy facts. */
function safetyJudgeAllowedDecision(ask: SafetyDecision): SafetyDecision {
	return {
		kind: "allow",
		classification: ask.classification,
		...(ask.policy !== undefined
			? { policy: { ...ask.policy, kind: "allow" as const, reasonCode: SAFETY_JUDGE_ALLOW_REASON_CODE } }
			: {}),
	};
}

const NO_PARK_LISTENER_REASON_CODE = "no_park_listener";
const NO_PARK_LISTENER_REASON =
	"refused: this call needs operator confirmation and no permission listener is registered to ask for it";
const PARK_ABORT_REASON = "run aborted before the operator decided";
/** Audit and event code of an identical repeat refused from the turn's denial memory. */
const DENIED_REPEAT_REASON_CODE = "denied_repeat";
/** Refused calls remembered per registry; identical repeats rarely span more than a handful. */
const DENIED_CALL_MEMORY_LIMIT = 64;

/** An ask_user round the operator answered rather than cancelled. */
function askUserAnswered(verdict: RegistryVerdict): boolean {
	if (verdict.kind !== "ok" || verdict.result.kind !== "ok") return false;
	const details = verdict.result.details;
	// A round Clio answered for an absent operator (#421) is no operator's answer.
	if (details?.unattended !== undefined) return false;
	return details?.cancelled !== true && Array.isArray(details?.answers) && details.answers.length > 0;
}

/**
 * Details key under which a tool body hands a refused nested verdict back to
 * the registry. Written by {@link nestedBlockedResult}, read once by `runSpec`,
 * never persisted: the registry settles the outer call as that verdict.
 */
const nestedDecisions = new WeakMap<ToolResult, SafetyDecision>();

const nestedChainResults = new WeakSet<ToolResult>();

/** Mark a gateway chain's combined result, whose step notes the nested calls recorded. */
export function nestedChainResult(result: ToolResult): ToolResult {
	nestedChainResults.add(result);
	return result;
}

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
	redundantRepeat?: true;
	denial?: ToolDenial;
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
		...(verdict.redundantRepeat === true ? { redundantRepeat: true } : {}),
		...(verdict.denial !== undefined ? { denial: verdict.denial } : {}),
	};
	return { kind: "error", message: verdict.reason, details: { [NESTED_BLOCKED_DETAIL]: marker } };
}

function nestedBlockedVerdict(result: ToolResult): Extract<RegistryVerdict, { kind: "blocked" }> | null {
	if (result.kind !== "error") return null;
	const marker = result.details?.[NESTED_BLOCKED_DETAIL];
	if (typeof marker !== "object" || marker === null) return null;
	const { reason, decision, deniedPark, redundantRepeat, denial } = marker as Partial<NestedBlockedMarker>;
	if (
		typeof reason !== "string" ||
		typeof decision !== "object" ||
		decision === null ||
		typeof decision.kind !== "string" ||
		typeof decision.classification !== "object"
	) {
		return null;
	}
	return {
		kind: "blocked",
		reason,
		decision,
		...(deniedPark === true ? { deniedPark: true } : {}),
		...(redundantRepeat === true ? { redundantRepeat: true } : {}),
		...(denial !== undefined ? { denial } : {}),
	};
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

/** Terminal blocked verdict for a recoverable call whose workspace snapshot could not be taken. */
function snapshotRequiredVerdict(
	decision: SafetyDecision,
	tool: string,
	reason: string,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const blocked: SafetyDecision = {
		kind: "block",
		classification: decision.classification,
		rejection: { short: `${tool} blocked: no workspace snapshot`, detail: reason, hints: [] },
		...(decision.policy !== undefined
			? { policy: { ...decision.policy, kind: "block" as const, reasonCode: SNAPSHOT_REQUIRED_REASON_CODE } }
			: {}),
	};
	return { kind: "blocked", reason, decision: blocked };
}

/**
 * Terminal blocked verdict for an information-flow refusal past admission: a
 * source that cannot be labeled, an outbound transfer the carried
 * restrictions forbid, or content withheld because its label did not reach
 * the ledger. The admission's allow is re-shaped as a block with the flow
 * code, so receipts do not report the refusal as allowed.
 */
function flowBlockedVerdict(
	decision: SafetyDecision,
	tool: string,
	reason: string,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const blocked: SafetyDecision = {
		kind: "block",
		classification: decision.classification,
		rejection: { short: `${tool} blocked: information flow`, detail: reason, hints: [] },
		...(decision.policy !== undefined ? { policy: { ...decision.policy, reasonCode: FLOW_BLOCK_REASON_CODE } } : {}),
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
		...(decision.policy !== undefined ? { policy: { ...decision.policy, reasonCode: "skill_surface" } } : {}),
	};
	return { kind: "blocked", reason, decision: blocked };
}

export type HostReadOnlySource = "run" | "acp-ceiling";

/**
 * What a host read-only denial says set the scope and who can lift it. The
 * run remedy says to drop the flag in plain words: a remedy that ended on the
 * flag itself was relayed to the user as the fix.
 */
export const HOST_READ_ONLY_SOURCES: Readonly<Record<HostReadOnlySource, { detail: string; remedy: string }>> = {
	run: {
		detail: "The host started this task read-only (clio-coder run --read-only)",
		remedy: "the operator must rerun this task without the --read-only flag.",
	},
	"acp-ceiling": {
		detail: "The ACP client set readOnly in its clio-coder/ceiling for this session or prompt",
		remedy: "the ACP client must send this work without readOnly in its clio-coder/ceiling.",
	},
};

/** A read-only dispatch or task scope resolves every forbidden call as a terminal denial. */
function readOnlyDeniedVerdict(
	decision: SafetyDecision,
	tool: string,
	hostSource: { detail: string } | null,
	reasonCode: string,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const rejection =
		hostSource !== null
			? {
					short: `${tool} denied: this task is read-only`,
					detail: `${hostSource.detail}, so this call cannot execute and no approval clears it.`,
					hints: [
						"Describe the proposed change as text in the answer.",
						"Inspection tools remain available for paths inside the workspace.",
					],
				}
			: {
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
		// The net passed this call; the block is the read-only ceiling's, so the
		// carried policy must not keep reporting the net's "allowed" code.
		...(decision.policy !== undefined ? { policy: { ...decision.policy, reasonCode } } : {}),
	};
	return { kind: "blocked", reason: rejection.short, decision: blocked };
}

/** One task reads as a task, not a plan: the overlay says what the approval launches. */
function dispatchPlanApprovalLead(plan: DispatchPlanView): string {
	const scope = plan.taskCount === 1 ? "this task" : "the whole plan";
	return `Approving this call approves ${scope}:\n${plan.text}`;
}

/**
 * The one parked decision for a call whose host checks need the session's
 * test-runner consent. It keeps the call's own classification and description,
 * so the card names the dispatch or job and not the test runner's execute
 * class, and it carries the consent rail, so approving it gives the consent
 * before the call re-admits. When the call asked on its own, its ask leads and
 * the consent is stated as part of the same approval.
 */
function sessionConsentParkDecision(
	call: ClassifierCall,
	own: SafetyDecision,
	consent: { label: string; decision: SafetyDecision },
	plan: DispatchPlanView | null,
): SafetyDecision {
	const need = `${consent.label} runs a test runner on repository code this session has not confirmed`;
	const grants = "Approving also gives this session's test-runner consent, so later test runners run without asking.";
	const consentAsk = consent.decision.kind === "ask" ? consent.decision : undefined;
	const ownAsk = own.kind === "ask" ? own : undefined;
	const lead =
		ownAsk !== undefined
			? ownAsk.rejection.detail
			: plan !== null
				? dispatchPlanApprovalLead(plan)
				: `${call.tool} needs the session's test-runner consent.`;
	const detail = `${lead}\n${need}. ${grants}`;
	return {
		kind: "ask",
		classification: own.classification,
		confirmationRuleId: SESSION_CODE_CONSENT_RULE_ID,
		rejection: {
			short:
				ownAsk !== undefined
					? `${ownAsk.rejection.short}; approving also gives the session's test-runner consent (${need})`
					: `${call.tool} needs the session's test-runner consent: ${need}`,
			detail,
			hints: [...(ownAsk?.rejection.hints ?? []), ...(consentAsk?.rejection.hints ?? [])],
		},
		...(consentAsk?.policy !== undefined
			? { policy: { ...consentAsk.policy, reasons: [`${need}. ${grants}`, ...consentAsk.policy.reasons.slice(1)] } }
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
	const single = plan.taskCount === 1;
	return {
		kind: "ask",
		classification: decision.classification,
		rejection: {
			short: `dispatch plan needs approval (${plan.topology}, ${plan.taskCount} ${single ? "task" : "tasks"}) at autonomy ${level}`,
			detail: dispatchPlanApprovalLead(plan),
			hints: single
				? [
						"One approval covers this task's run, including its remote placement or failover.",
						"Deny to keep the fleet idle and revise the task first.",
					]
				: [
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
	carriedFlow: FlowRestrictionSet | null,
	repeatableRead: boolean,
): MiddlewareHookInput {
	const metadata: Record<string, MiddlewareMetadataValue> = {
		posture,
		actionClass: decision.classification.actionClass,
		decisionKind: decision.kind,
		repeatableRead,
	};
	// Stable call identity for repetition detectors (engine/loop-guard.ts).
	// Computed for before_tool only; after_tool consumers identify the call
	// via toolCallId.
	if (hook === "before_tool") metadata.callFingerprint = hashToolCall(spec.name, call.args ?? {});
	// What the session already carries, so an adviser sees the restriction
	// before any model send; the result's own label rides on toolResultDetails.
	if (carriedFlow !== null)
		metadata.flowRuleIds = JSON.stringify([...new Set(carriedFlow.restrictions.map((r) => r.ruleId))]);
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
	nested: "call" | "chain" | null = null,
): ToolResult {
	const inherited = inheritedHostNotes(result, nested);
	const annotations = annotationMessages(effects);
	if (annotations.length === 0) return withHostNotes(result, inherited);
	const warning = `[middleware:warn] ${INSTRUCTION_SHAPED_WARNING}`;
	const prefix = !bannered && annotations.includes(warning) ? `${warning}\n\n` : "";
	const remaining = annotations.filter((annotation) => annotation !== warning);
	const suffix = remaining.length > 0 ? `${TOOL_RESULT_NOTES_SEPARATOR}${remaining.join("\n")}` : "";
	if (result.kind === "ok") {
		const annotated: ToolResult = { kind: "ok", output: `${prefix}${result.output}${suffix}` };
		if (result.details !== undefined) annotated.details = result.details;
		if (result.terminate === true) annotated.terminate = true;
		if (result.images !== undefined) annotated.images = result.images;
		return withHostNotes(annotated, [...inherited, ...remaining]);
	}
	const annotated: ToolResult = { kind: "error", message: `${prefix}${result.message}${suffix}` };
	if (result.details !== undefined) annotated.details = result.details;
	return withHostNotes(annotated, [...inherited, ...remaining]);
}

/**
 * Notes the nested registry call already appended and recorded, kept only
 * when this registry itself delegated the call (the WeakMap and WeakSet
 * entries no tool output can create) and the text still carries them: a
 * gateway call ends with exactly the capability's run, a chain keeps each
 * step's run in its section.
 */
function inheritedHostNotes(result: ToolResult, nested: "call" | "chain" | null): string[] {
	if (nested === null) return [];
	const notes = recordedToolResultNotes(result.details);
	if (notes.length === 0) return [];
	const text = toolResultContextText(result);
	const carried =
		nested === "call"
			? text.endsWith(`${TOOL_RESULT_NOTES_SEPARATOR}${notes.join("\n")}`)
			: notes.every((note) => carriesToolResultNote(text, note));
	return carried ? notes : [];
}

/**
 * Record the trailing notes this host appended, and drop any value a tool put
 * under the same key: delivery accounting trusts only this record, never
 * note-shaped text at the end of tool output.
 */
function withHostNotes(result: ToolResult, notes: readonly string[]): ToolResult {
	const details = result.details;
	if (notes.length === 0 && (details === undefined || !Object.hasOwn(details, TOOL_RESULT_HOST_NOTES_KEY)))
		return result;
	const { [TOOL_RESULT_HOST_NOTES_KEY]: _forged, ...rest } = details ?? {};
	const recorded = notes.length > 0 ? { ...rest, [TOOL_RESULT_HOST_NOTES_KEY]: [...notes] } : rest;
	return { ...result, details: recorded };
}

function annotationMessages(effects: ReadonlyArray<MiddlewareEffect>): string[] {
	const messages: string[] = [];
	for (const effect of effects) {
		if (effect.kind !== "annotate_tool_result") continue;
		const severity = effect.severity ?? "info";
		messages.push(toolResultNote(severity, effect.message));
	}
	return messages;
}
