import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { JobChangedPayload } from "../job-types.js";
import type { CaptureFlag } from "./capture.js";
import type { ContentClass, Tier } from "./enums.js";
import type {
	AccountabilityEvidenceReadyPayload,
	AgentStatusChangedPayload,
	BudgetAlertPayload,
	CompactionPayload,
	ConfigChangePayload,
	ConfigReloadFailedPayload,
	ConfigSessionChangePayload,
	ContextActivityPayload,
	ContextSourcesChangedPayload,
	ContextWarningPayload,
	DeclaredRuntimeNotice,
	DispatchCompletedPayload,
	DispatchEnqueuedPayload,
	DispatchFailedPayload,
	DispatchProgressPayload,
	DispatchScopeNoticePayload,
	DispatchStartedPayload,
	DomainFailedPayload,
	ExtensionsLoadIssuePayload,
	GitHooksChangedPayload,
	InternalGitDriftPayload,
	LoopBlockedPayload,
	MemoryGuardianChangedPayload,
	MiddlewareHookFailedPayload,
	PermissionRequestedPayload,
	PermissionResolvedPayload,
	ProviderHealthPayload,
	ResidencyMutationPayload,
	RunAbortedPayload,
	SafetyBlockedPayload,
	SessionEndPayload,
	SessionOpenedPayload,
	SessionParkedPayload,
	SessionResumedPayload,
	SessionResumingPayload,
	SessionStartPayload,
	SessionTurnSwitchedPayload,
	ToolBudgetExceededPayload,
	TurnAbortedPayload,
} from "./live-events.js";
import type { CallSettled, ObjectRef } from "./schemas.js";
import * as S from "./schemas.js";

/**
 * Every event the harness emits, declared once (#434). A `journal` event is written to the scope its telemetry
 * context names and delivered live; a `live` event reaches in-process subscribers only. The hub
 * (src/core/telemetry/hub.ts) is the one emit path for both.
 */
export interface JournalDefinition<S extends TSchema = TSchema> {
	readonly durability: "journal";
	readonly version: 1;
	readonly schema: S;
	readonly tier: Tier;
	readonly cc: ContentClass;
	/** The research flag that admits a research-tier event; without one, research mode alone admits it (#434). */
	readonly capture?: CaptureFlag;
	/**
	 * The structural facts a journal keeps of a richer live payload. Live subscribers receive the payload as emitted;
	 * the producer applies this before enqueue, so card text and envelope ids never reach the journal (#434).
	 */
	readonly project?: (payload: never) => unknown;
	/**
	 * Where the record belongs regardless of how it was emitted. `process`: a fact about the process, always in the
	 * process journal. `session`: a fact about one session or run, which its seam names in the telemetry context; one
	 * emitted without a context is a gap, and one whose session writer closed idle reopens it (#434).
	 */
	readonly scope?: "process" | "session";
}

/** The payload exists only in the type system; live events carry no runtime schema. */
export interface LiveDefinition<P> {
	readonly durability: "live";
	readonly payload?: P;
}

function journal<
	S extends TSchema,
	const O extends {
		tier: Tier;
		cc: ContentClass;
		capture?: CaptureFlag;
		scope?: "process" | "session";
		// biome-ignore lint/suspicious/noExplicitAny: the projection's own annotation names the live payload type.
		project?: (payload: any) => Static<S>;
	},
>(schema: S, options: O): { durability: "journal"; version: 1; schema: S } & O {
	return { durability: "journal", version: 1, schema, ...options };
}

/** Optional live fields arrive as `undefined`; a closed journal schema holds only the ones present. */
function definedFields(value: object): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

/** The defined fields of a live payload, so a projection never writes an explicit undefined (#434). */
function pick<T extends object, const K extends keyof T>(
	value: T,
	keys: readonly K[],
): { [P in K]: Exclude<T[P], undefined> } {
	const out: Partial<Record<K, unknown>> = {};
	for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
	return out as { [P in K]: Exclude<T[P], undefined> };
}

const LIVE: LiveDefinition<never> = Object.freeze({ durability: "live" });
function live<P>(): LiveDefinition<P> {
	return LIVE as LiveDefinition<P>;
}

/** The journal keeps counts and identities from observation decisions, never envelopes or rendered copy (#434). */
function projectMemoryObservation(payload: {
	event: string;
	facts: Record<string, unknown>;
}): S.MemoryObservationRecorded {
	const input = payload.facts;
	const facts: Record<string, unknown> = {};
	for (const key of [
		"count",
		"grounded",
		"ungrounded",
		"rejected",
		"offered",
		"offerable",
		"units",
		"incompleteUnits",
		"attempts",
		"timeoutMs",
		"operations",
		"dropped",
		"extracted",
		"candidates",
		"accepted",
		"entries",
		"splitEntries",
		"revision",
		"priorObservationRevision",
		"batchId",
		"digest",
		"sourceDigest",
		"sourceSessionId",
		"commitId",
		"reason",
		"phase",
		"id",
		"by",
		"filing",
		"final",
		"answered",
		"unavailable",
		"split",
		"ids",
		"retainedIds",
		"route",
		"outcomes",
		"decision",
		"proven",
		"window",
	])
		if (input[key] !== undefined) facts[key] = input[key];
	for (const key of ["sourceTokens", "noteTokens", "originalInputTokens", "substitutedInputTokens", "proposed", "raw"])
		if (typeof input[key] === "number") facts[key] = { kind: "estimated", value: input[key], method: "chars/4" };
	if (typeof input.durationMs === "number")
		facts.durationMs = { kind: "measured", value: input.durationMs, source: "local-clock" };
	const usage = input.usage as
		| {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				reasoning: number;
				totalTokens: number;
				missingTokenCalls?: number;
				callId?: string;
				attemptId?: string;
		  }
		| null
		| undefined;
	if (usage) {
		const token = (value: number) =>
			value > 0 || usage.missingTokenCalls === 0
				? { kind: "measured", value, source: "provider" }
				: { kind: "unknown", reason: "not-observed" };
		facts.usage = {
			input: token(usage.input),
			output: token(usage.output),
			cacheRead: token(usage.cacheRead),
			cacheWrite: token(usage.cacheWrite),
			cacheWrite1h: { kind: "absent", reason: "not-applicable" },
			reasoning: token(usage.reasoning),
			total: token(usage.totalTokens),
		};
		if (usage.callId && usage.attemptId) facts.call = { callId: usage.callId, attemptId: usage.attemptId };
	}
	const receipt = input.receipt as { offerId?: string; batches?: { id: string }[] } | undefined;
	if (receipt?.offerId) facts.offerId = receipt.offerId;
	if (receipt?.batches) facts.batchIds = receipt.batches.map(({ id }) => id);
	if (Array.isArray(input.inputs)) facts.inputIds = input.inputs.map((entry: { id: string }) => entry.id);
	if (Array.isArray(input.offers)) facts.offerIds = input.offers.map((entry: { id: string }) => entry.id);
	return { event: payload.event, facts } as S.MemoryObservationRecorded;
}

/** Admission facts only: the task text, budget and board copy stay on the live payload (#434). */
function projectRunEnqueued(payload: DispatchEnqueuedPayload): Static<typeof S.RunEnqueuedSchema> {
	return {
		runId: payload.runId,
		agentId: payload.agentId,
		requestOrigin: payload.requestOrigin ?? null,
		targetId: payload.targetId,
		wireModelId: payload.wireModelId,
		runtimeId: payload.runtimeId,
		runtimeKind: payload.runtimeKind,
		...(payload.node !== undefined ? { node: payload.node } : {}),
		...(payload.endpoint !== undefined && Number.isSafeInteger(payload.endpoint.limit) && payload.endpoint.limit >= 0
			? { endpointLimit: payload.endpoint.limit }
			: {}),
		...(payload.gate !== undefined ? { gate: { role: payload.gate.role, cycle: payload.gate.cycle } } : {}),
		...(payload.rerouteCount !== undefined ? { rerouteCount: payload.rerouteCount } : {}),
	};
}

/** Start facts only: identity the envelope carries and the spawned command stay on the live payload (#434). */
function projectRunStarted(payload: DispatchStartedPayload): Static<typeof S.RunStartedSchema> {
	return { pid: payload.pid, assignmentId: payload.assignmentId, attempt: payload.attempt };
}

/**
 * Names are `subject.past_participle`. Where a live signal and a journal record mark the same moment but carry
 * different facts, they are two events: the live `session.created`, `session.reattached` and `compaction.ended` feed
 * the subscribers that open journals and repaint, the journal `session.opened`, `session.resumed` and
 * `compaction.settled` are what the scope keeps (#434).
 */
export const EVENTS = {
	"call.started": journal(S.CallStartedSchema, { tier: "accountability", cc: "content-free" }),
	"call.settled": journal(S.CallSettledSchema, { tier: "accountability", cc: "content-free" }),
	"call.linked": journal(S.CallLinkedSchema, { tier: "accountability", cc: "content-free" }),
	"compaction.settled": journal(S.CompactionSettledSchema, { tier: "accountability", cc: "content-free" }),
	"journal.gap": journal(S.JournalGapSchema, { tier: "accountability", cc: "content-free" }),
	"session.opened": journal(S.EmptySchema, { tier: "accountability", cc: "content-free" }),
	"session.resumed": journal(S.SessionResumedSchema, { tier: "accountability", cc: "content-free" }),
	"session.forked": journal(S.SessionForkedSchema, { tier: "accountability", cc: "content-free" }),
	"session.closed": journal(S.SessionClosedSchema, { tier: "accountability", cc: "content-free" }),
	"journal.segment_closed": journal(S.JournalSegmentClosedSchema, { tier: "accountability", cc: "content-free" }),
	"turn.settled": journal(S.TurnSettledSchema, { tier: "accountability", cc: "content-free" }),
	"run.settled": journal(S.RunSettledSchema, { tier: "accountability", cc: "content-free" }),
	"run.feed_appended": journal(S.RunFeedAppendedSchema, { tier: "operational", cc: "structural" }),
	"run.usage_reported": journal(S.RunUsageSchema, { tier: "accountability", cc: "structural" }),
	"run.linked": journal(S.RunLinkedSchema, { tier: "accountability", cc: "content-free" }),
	"run.enqueued": journal(S.RunEnqueuedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: projectRunEnqueued,
	}),
	"run.started": journal(S.RunStartedSchema, { tier: "accountability", cc: "content-free", project: projectRunStarted }),
	"route.decided": journal(S.RouteDecidedSchema, { tier: "operational", cc: "content-free" }),
	"gate.decided": journal(S.GateDecidedSchema, { tier: "accountability", cc: "content-free" }),
	"code_step.settled": journal(S.CodeStepSettledSchema, { tier: "accountability", cc: "content-free" }),
	"process.started": journal(S.EmptySchema, { tier: "accountability", cc: "content-free" }),
	"process.exited": journal(S.ProcessExitedSchema, { tier: "accountability", cc: "content-free" }),
	"prompt.text_captured": journal(S.PromptTextCapturedSchema, {
		tier: "research",
		cc: "content-bearing",
		capture: "content",
	}),
	"quota.read": journal(S.QuotaReadSchema, { tier: "operational", cc: "content-free" }),
	"budget.crossed": journal(S.BudgetCrossedSchema, { tier: "accountability", cc: "content-free" }),
	"budget.held": journal(S.BudgetHeldSchema, { tier: "accountability", cc: "content-free" }),
	"config.snapshotted": journal(S.ConfigSnapshottedSchema, { tier: "operational", cc: "structural" }),
	"config.changed": journal(S.ConfigChangedSchema, { tier: "operational", cc: "structural" }),
	"memory.traced": journal(S.MemoryTracedSchema, { tier: "research", cc: "content-bearing", capture: "content" }),
	"memory.observed": journal(S.MemoryObservedSchema, { tier: "research", cc: "content-bearing", capture: "content" }),
	"health.sampled": journal(S.HealthSampledSchema, { tier: "operational", cc: "content-free" }),
	"health.samples_captured": journal(S.HealthSamplesCapturedSchema, { tier: "research", cc: "content-free" }),
	"tool.settled": journal(S.ToolSettledSchema, { tier: "operational", cc: "content-free" }),
	"tool.decided": journal(S.ToolDecidedSchema, { tier: "accountability", cc: "content-free" }),
	"approval.requested": journal(S.ApprovalRequestedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: (p: PermissionRequestedPayload) =>
			pick(p, [
				"tool",
				"actionClass",
				"requestId",
				"origin",
				"requestedBy",
				"agentId",
				"axis",
				"posture",
				"ruleId",
				"reasonCode",
				"policySource",
				"timeoutMs",
				"fallback",
				"escalation",
				"approvalAuthority",
				"forwardedByMain",
			]),
	}),
	"approval.resolved": journal(S.ApprovalResolvedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: (p: PermissionResolvedPayload) => ({
			...pick(p, ["status", "requestId", "origin", "decidedBy", "tool", "actionClass", "requestedBy", "fallback"]),
			...(p.grant ? { grant: pick(p.grant, ["attempt", "authority", "issuer", "execution", "state"]) } : {}),
		}),
	}),
	"run.aborted": journal(S.RunAbortedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: (p: RunAbortedPayload) => pick(p, ["source", "runId", "startedAt", "elapsedMs"]),
	}),
	"turn.aborted": journal(S.TurnAbortedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: (p: TurnAbortedPayload) => ({ source: p.source }),
	}),
	"agent.status_changed": journal(S.AgentStatusChangedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: (p: AgentStatusChangedPayload) => ({
			...pick(p, ["phase", "prevPhase", "watchdogTier"]),
			elapsedFromStart: Math.max(0, p.elapsedFromStart),
			...(p.metadata?.toolName !== undefined ? { toolName: p.metadata.toolName } : {}),
			...(p.metadata?.attempt !== undefined ? { attempt: p.metadata.attempt } : {}),
			...(p.metadata?.agentName !== undefined ? { agentName: p.metadata.agentName } : {}),
			...(p.metadata?.reason !== undefined ? { stopReason: p.metadata.reason } : {}),
		}),
	}),
	"completion.evaluated": journal(S.CompletionEvaluatedSchema, { tier: "accountability", cc: "content-free" }),
	"safety.judged": journal(S.SafetyJudgedSchema, { tier: "accountability", cc: "content-free" }),
	"prompt.compiled": journal(S.PromptCompiledSchema, { tier: "operational", cc: "structural" }),
	"context.snapshotted": journal(S.ContextSnapshottedSchema, { tier: "operational", cc: "content-free" }),
	"call.timing_captured": journal(S.CallTimingCapturedSchema, {
		tier: "research",
		cc: "content-free",
		capture: "deltas",
	}),
	"prompt.prefix_captured": journal(S.PromptPrefixCapturedSchema, { tier: "research", cc: "structural" }),
	"auth.refreshed": journal(S.AuthRefreshedSchema, { tier: "operational", cc: "content-free" }),
	"middleware.fired": journal(S.MiddlewareFiredSchema, { tier: "operational", cc: "content-free" }),
	"system_one.decided": journal(S.SystemOneDecidedSchema, { tier: "operational", cc: "content-free" }),
	"worker.channel_failed": journal(S.WorkerChannelFailedSchema, { tier: "operational", cc: "content-free" }),
	"request.captured": journal(S.RequestCapturedSchema, { tier: "research", cc: "content-bearing", capture: "content" }),
	"provider.headers_captured": journal(S.ProviderHeadersCapturedSchema, {
		tier: "research",
		cc: "content-free",
		capture: "providerHeaders",
	}),
	"hook.ran": journal(S.HookRanSchema, { tier: "operational", cc: "structural", scope: "session" }),
	"library.installed": journal(S.LibraryLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"library.updated": journal(S.LibraryLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"library.enabled": journal(S.LibraryLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"library.disabled": journal(S.LibraryLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"library.removed": journal(S.LibraryLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"library.registered": journal(S.LibraryLifecycleSchema, {
		tier: "accountability",
		cc: "structural",
		scope: "process",
	}),
	"library.imported": journal(S.LibraryLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"library.share_imported": journal(S.LibraryLifecycleSchema, {
		tier: "accountability",
		cc: "structural",
		scope: "process",
	}),
	"job.changed": live<JobChangedPayload>(),
	"session.eggs_changed": live<{ sessionId: string | null; active: readonly string[] }>(),
	"session.started": live<SessionStartPayload>(),
	"session.ended": live<SessionEndPayload>(),
	"session.created": live<SessionOpenedPayload>(),
	"session.parked": live<SessionParkedPayload>(),
	"session.resume_started": live<SessionResumingPayload>(),
	"session.reattached": live<SessionResumedPayload>(),
	"session.turn_switched": live<SessionTurnSwitchedPayload>(),
	"domain.loaded": journal(S.DomainLoadedSchema, { tier: "operational", cc: "structural", scope: "process" }),
	"domain.failed": journal(S.DomainFailedSchema, {
		tier: "operational",
		cc: "structural",
		scope: "process",
		project: ({ name }: DomainFailedPayload) => ({ name }),
	}),
	"config.hot_reloaded": live<ConfigChangePayload>(),
	"config.next_turn_scheduled": live<ConfigChangePayload>(),
	"config.restart_required": live<ConfigChangePayload>(),
	"config.reload_failed": journal(S.ConfigReloadFailedSchema, {
		tier: "operational",
		cc: "content-free",
		scope: "process",
		project: ({ message }: ConfigReloadFailedPayload) => ({ state: message === null ? "recovered" : "rejected" }),
	}),
	"config.session_changed": live<ConfigSessionChangePayload>(),
	"safety.blocked": live<SafetyBlockedPayload>(),
	"safety.loop_blocked": live<LoopBlockedPayload>(),
	"safety.tool_budget_exceeded": live<ToolBudgetExceededPayload>(),
	"safety.git_hooks_changed": live<GitHooksChangedPayload>(),
	"safety.internal_git_drifted": live<InternalGitDriftPayload>(),
	"provider.health_changed": live<ProviderHealthPayload>(),
	"runtime.notice_raised": live<DeclaredRuntimeNotice>(),
	"residency.mutated": live<ResidencyMutationPayload>(),
	"run.scope_notice_raised": live<DispatchScopeNoticePayload>(),
	"run.progressed": live<DispatchProgressPayload>(),
	"run.completed": live<DispatchCompletedPayload>(),
	"run.failed": live<DispatchFailedPayload>(),
	"evidence.assessed": live<AccountabilityEvidenceReadyPayload>(),
	"compaction.started": live<CompactionPayload>(),
	"compaction.ended": live<CompactionPayload>(),
	"middleware.hook_failed": journal(S.MiddlewareHookFailedSchema, {
		tier: "operational",
		cc: "structural",
		project: ({ at: _at, message: _message, ...facts }: MiddlewareHookFailedPayload) =>
			definedFields(facts) as Static<typeof S.MiddlewareHookFailedSchema>,
	}),
	"plugin.reloaded": journal(S.PluginReloadedSchema, { tier: "operational", cc: "structural", scope: "process" }),
	"extension.load_failed": journal(S.EmptySchema, {
		tier: "operational",
		cc: "content-free",
		scope: "process",
		project: (_issue: ExtensionsLoadIssuePayload) => ({}),
	}),
	"context.activity_changed": live<ContextActivityPayload>(),
	"context.sources_changed": live<ContextSourcesChangedPayload>(),
	"context.warning_raised": journal(S.ContextWarningRaisedSchema, {
		tier: "operational",
		cc: "content-free",
		scope: "session",
		project: ({ warning }: ContextWarningPayload) => ({ state: warning === null ? "cleared" : "raised" }),
	}),
	"context.pruned": journal(S.ContextPrunedSchema, { tier: "operational", cc: "structural", scope: "session" }),
	"context.recalled": journal(S.ContextRecalledSchema, { tier: "operational", cc: "structural", scope: "session" }),
	"memory.step_completed": journal(S.MemoryStepCompletedSchema, { tier: "operational", cc: "structural" }),
	"memory.step_decided": journal(S.MemoryStepDecidedSchema, { tier: "accountability", cc: "structural" }),
	"memory.observation_recorded": journal(S.MemoryObservationRecordedSchema, {
		tier: "accountability",
		cc: "structural",
		project: projectMemoryObservation,
	}),
	"memory.guardian_changed": journal(S.MemoryGuardianChangedSchema, {
		tier: "operational",
		cc: "content-free",
		project: (payload: MemoryGuardianChangedPayload) => ({ state: payload.state }),
	}),
	"budget.alerted": live<BudgetAlertPayload>(),
	"shutdown.requested": journal(S.ShutdownRequestedSchema, {
		tier: "operational",
		cc: "content-free",
		scope: "process",
	}),
	"shutdown.drained": journal(S.EmptySchema, { tier: "operational", cc: "content-free", scope: "process" }),
	"shutdown.terminated": journal(S.EmptySchema, { tier: "operational", cc: "content-free", scope: "process" }),
	"shutdown.persisted": journal(S.EmptySchema, { tier: "operational", cc: "content-free", scope: "process" }),
} as const;

export type EventName = keyof typeof EVENTS;
type Definition<N extends EventName> = (typeof EVENTS)[N];
/** What `emit` takes and subscribers receive: a projected journal event's live payload, else its record data. */
export type EventPayload<N extends EventName> =
	Definition<N> extends { durability: "journal"; project: (payload: infer P) => unknown }
		? P
		: Definition<N> extends { durability: "journal"; schema: infer S extends TSchema }
			? Static<S>
			: Definition<N> extends LiveDefinition<infer P>
				? P
				: never;
/** The events a scope journals. */
export type JournalEventName = {
	[N in EventName]: Definition<N> extends { durability: "journal" } ? N : never;
}[EventName];
export type LiveEventName = Exclude<EventName, JournalEventName>;
/** The data a journal record of this kind carries, after any projection. */
export type JournalPayload<N extends JournalEventName> = Static<Definition<N>["schema"]>;

/**
 * Journal events whose content the writer stores in `objects/` and cites as `content`, with its size as `bytes`,
 * so consent, the research cap, export, prune and GC reach it through the writer alone (#434).
 */
export const PREIMAGE_SUBJECTS = {
	"memory.traced": "memory-trace",
	"memory.observed": "observation-trace",
	"request.captured": "request",
} as const satisfies Partial<Record<JournalEventName, ObjectRef["subject"]>>;
export type PreimageEventName = keyof typeof PREIMAGE_SUBJECTS;
export type PreimageData<N extends PreimageEventName> = Omit<JournalPayload<N>, "content" | "bytes">;

function isEventName(name: string): name is EventName {
	return Object.hasOwn(EVENTS, name);
}

export function isJournalEvent(name: string): name is JournalEventName {
	return isEventName(name) && EVENTS[name].durability === "journal";
}

export function journalDefinition(name: JournalEventName): JournalDefinition {
	return EVENTS[name];
}

/** Schema validation plus the cross-field invariants that JSON Schema cannot express (#434). */
export function validPayload<K extends JournalEventName>(kind: K, data: unknown): data is JournalPayload<K> {
	if (!Value.Check(journalDefinition(kind).schema, data)) return false;
	if (kind === "prompt.text_captured") {
		const prompt = data as EventPayload<"prompt.text_captured">;
		return (
			prompt.text.subject === "prompt-text" &&
			prompt.text.label === "resolvable" &&
			(prompt.structure === undefined || prompt.structure.subject === "prompt-structure")
		);
	}
	if (Object.hasOwn(PREIMAGE_SUBJECTS, kind)) {
		const content = (data as JournalPayload<PreimageEventName>).content;
		return content.subject === PREIMAGE_SUBJECTS[kind as PreimageEventName] && content.label === "resolvable";
	}
	if (kind === "compaction.settled") {
		const outcome = data as EventPayload<"compaction.settled">;
		return outcome.outcome !== "committed" || outcome.checkpointTurnId !== null;
	}
	if (kind === "tool.settled") {
		const tool = data as EventPayload<"tool.settled">;
		return (
			(tool.outcome === "blocked") === (tool.blocked !== undefined) &&
			(tool.outcome !== "blocked" || tool.resultBytes === undefined)
		);
	}
	if (kind === "auth.refreshed") {
		const auth = data as EventPayload<"auth.refreshed">;
		if (auth.outcome === "refreshed") return auth.attempted && auth.writerPid !== null;
		return auth.outcome !== "adopted" || !auth.attempted;
	}
	if (kind === "call.timing_captured") {
		const timing = data as EventPayload<"call.timing_captured">;
		return timing.gapCounts.reduce((sum, value) => sum + value, 0) === timing.deltas - 1;
	}
	if (kind !== "call.settled") return true;
	const call = data as CallSettled;
	if ((call.disposition === "never_sent") !== (call.usage === null)) return false;
	if (call.disposition === "never_sent" && (call.pricing.usd.kind !== "absent" || call.pricing.pricedBy !== "none"))
		return false;
	if (call.disposition === "settled" && !Object.values(call.usage ?? {}).some((fact) => fact.kind === "measured"))
		return false;
	// A sent_unsettled call may carry the counts its provider reported before the response ended (#434).
	if (
		call.disposition === "settled_no_usage" &&
		Object.values(call.usage ?? {}).some((fact) => fact.kind === "measured")
	)
		return false;
	const settledAt = call.stages.settle;
	if (settledAt === null) return Object.keys(call.stages).length === 1;
	return Object.values(call.stages).every(
		(value) =>
			value !== null &&
			(typeof value === "number" ? value <= settledAt : value.end >= value.start && value.end <= settledAt),
	);
}
