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
	ContextPrunedPayload,
	ContextRecalledPayload,
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
	DomainLoadedPayload,
	EmptyPayload,
	ExtensionsLoadIssuePayload,
	GitHooksChangedPayload,
	InternalGitDriftPayload,
	LoopBlockedPayload,
	MemoryGuardianChangedPayload,
	MemoryStepCompletedPayload,
	MiddlewareHookFailedPayload,
	PermissionRequestedPayload,
	PermissionResolvedPayload,
	PluginsReloadedPayload,
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
	ShutdownRequestedPayload,
	ToolBudgetExceededPayload,
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
}

/** The payload exists only in the type system; live events carry no runtime schema. */
export interface LiveDefinition<P> {
	readonly durability: "live";
	readonly payload?: P;
}

function journal<S extends TSchema, const O extends { tier: Tier; cc: ContentClass; capture?: CaptureFlag }>(
	schema: S,
	options: O,
): { durability: "journal"; version: 1; schema: S } & O {
	return { durability: "journal", version: 1, schema, ...options };
}

const LIVE: LiveDefinition<never> = Object.freeze({ durability: "live" });
function live<P>(): LiveDefinition<P> {
	return LIVE as LiveDefinition<P>;
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
	"session.resumed": journal(S.EmptySchema, { tier: "accountability", cc: "content-free" }),
	"session.forked": journal(S.SessionForkedSchema, { tier: "accountability", cc: "content-free" }),
	"session.closed": journal(S.SessionClosedSchema, { tier: "accountability", cc: "content-free" }),
	"journal.segment_closed": journal(S.JournalSegmentClosedSchema, { tier: "accountability", cc: "content-free" }),
	"turn.settled": journal(S.TurnSettledSchema, { tier: "accountability", cc: "content-free" }),
	"run.settled": journal(S.RunSettledSchema, { tier: "accountability", cc: "content-free" }),
	"run.feed_appended": journal(S.RunFeedAppendedSchema, { tier: "operational", cc: "structural" }),
	"run.usage_reported": journal(S.RunUsageSchema, { tier: "accountability", cc: "structural" }),
	"run.linked": journal(S.RunLinkedSchema, { tier: "accountability", cc: "content-free" }),
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
	"job.changed": live<JobChangedPayload>(),
	"session.eggs_changed": live<{ sessionId: string | null; active: readonly string[] }>(),
	"session.started": live<SessionStartPayload>(),
	"session.ended": live<SessionEndPayload>(),
	"session.created": live<SessionOpenedPayload>(),
	"session.parked": live<SessionParkedPayload>(),
	"session.resume_started": live<SessionResumingPayload>(),
	"session.reattached": live<SessionResumedPayload>(),
	"session.turn_switched": live<SessionTurnSwitchedPayload>(),
	"domain.loaded": live<DomainLoadedPayload>(),
	"domain.failed": live<DomainFailedPayload>(),
	"config.hot_reloaded": live<ConfigChangePayload>(),
	"config.next_turn_scheduled": live<ConfigChangePayload>(),
	"config.restart_required": live<ConfigChangePayload>(),
	"config.reload_failed": live<ConfigReloadFailedPayload>(),
	"config.session_changed": live<ConfigSessionChangePayload>(),
	"approval.requested": live<PermissionRequestedPayload>(),
	"approval.resolved": live<PermissionResolvedPayload>(),
	"safety.blocked": live<SafetyBlockedPayload>(),
	"safety.loop_blocked": live<LoopBlockedPayload>(),
	"safety.tool_budget_exceeded": live<ToolBudgetExceededPayload>(),
	"safety.git_hooks_changed": live<GitHooksChangedPayload>(),
	"safety.internal_git_drifted": live<InternalGitDriftPayload>(),
	"provider.health_changed": live<ProviderHealthPayload>(),
	"runtime.notice_raised": live<DeclaredRuntimeNotice>(),
	"residency.mutated": live<ResidencyMutationPayload>(),
	"run.scope_notice_raised": live<DispatchScopeNoticePayload>(),
	"run.enqueued": live<DispatchEnqueuedPayload>(),
	"run.started": live<DispatchStartedPayload>(),
	"run.progressed": live<DispatchProgressPayload>(),
	"run.completed": live<DispatchCompletedPayload>(),
	"run.failed": live<DispatchFailedPayload>(),
	"evidence.assessed": live<AccountabilityEvidenceReadyPayload>(),
	"compaction.started": live<CompactionPayload>(),
	"compaction.ended": live<CompactionPayload>(),
	"middleware.hook_failed": live<MiddlewareHookFailedPayload>(),
	"plugin.reloaded": live<PluginsReloadedPayload>(),
	"extension.load_failed": live<ExtensionsLoadIssuePayload>(),
	"context.activity_changed": live<ContextActivityPayload>(),
	"context.sources_changed": live<ContextSourcesChangedPayload>(),
	"context.warning_raised": live<ContextWarningPayload>(),
	"context.pruned": live<ContextPrunedPayload>(),
	"context.recalled": live<ContextRecalledPayload>(),
	"memory.step_completed": live<MemoryStepCompletedPayload>(),
	"memory.guardian_changed": live<MemoryGuardianChangedPayload>(),
	"agent.status_changed": live<AgentStatusChangedPayload>(),
	"run.aborted": live<RunAbortedPayload>(),
	"budget.alerted": live<BudgetAlertPayload>(),
	"shutdown.requested": live<ShutdownRequestedPayload>(),
	"shutdown.drained": live<EmptyPayload>(),
	"shutdown.terminated": live<EmptyPayload>(),
	"shutdown.persisted": live<EmptyPayload>(),
} as const;

export type EventName = keyof typeof EVENTS;
type Definition<N extends EventName> = (typeof EVENTS)[N];
export type EventPayload<N extends EventName> =
	Definition<N> extends { durability: "journal"; schema: infer S extends TSchema }
		? Static<S>
		: Definition<N> extends LiveDefinition<infer P>
			? P
			: never;
/** The events a scope journals. */
export type JournalEventName = {
	[N in EventName]: Definition<N> extends { durability: "journal" } ? N : never;
}[EventName];
export type LiveEventName = Exclude<EventName, JournalEventName>;

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
export type PreimageData<N extends PreimageEventName> = Omit<EventPayload<N>, "content" | "bytes">;

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
export function validPayload<K extends JournalEventName>(kind: K, data: unknown): data is EventPayload<K> {
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
		const content = (data as EventPayload<PreimageEventName>).content;
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
