import type { TelemetryContext } from "../../core/telemetry/context.js";
import { telemetryContext } from "../../core/telemetry/context.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { TaskMemoryEntry, TaskMemorySnapshot } from "./task-bank.js";
import type {
	TaskMemoryCallReference,
	TaskMemoryPolicyDecision,
	TaskMemoryPolicyReason,
	TaskMemoryRoute,
} from "./task-memory-policy.js";

export type TaskMemoryTelemetryTrigger =
	| "interval"
	| "tool_error_streak"
	| "loop_signal"
	| "repeated_failure"
	/** An approved lesson from an earlier session was surfaced at the session's first workspace change. */
	| "durable_lesson"
	/** A failed command matched the program and file of a command an approved lesson quotes. */
	| "durable_lesson_variant"
	/** Clio's verify tool found no declared or derivable check while an approved lesson quotes a command. */
	| "durable_lesson_verify"
	/** The session read, changed or ran a repository file an approved lesson names. */
	| "durable_lesson_subject"
	| "turn_end"
	| "post_compaction"
	/** The idle guardian reviewed completed activity or repository history between turns. */
	| "idle_review"
	| "manual";

export type TaskMemoryTelemetryTier = "rules" | "llm";

/**
 * A memory boundary that never ran has no policy decision, but it is exactly the
 * outcome an operator needs to distinguish a starved cadence from a quiet one.
 * `dropped` is therefore a telemetry-only outcome: the boundary triggered, a
 * step was already in flight, and its triggers stayed pending for a later
 * boundary.
 */
export type TaskMemoryTelemetryDecision = TaskMemoryPolicyDecision | "dropped";

export interface TaskMemoryClassDelta {
	added: number;
	updated: number;
	deleted: number;
}

export interface TaskMemoryBankDelta {
	status: TaskMemoryClassDelta;
	knowledge: TaskMemoryClassDelta;
	procedural: TaskMemoryClassDelta;
}

export interface TaskMemoryTelemetryStep {
	context?: TelemetryContext;
	calls?: readonly TaskMemoryCallReference[];
	triggerReasons: ReadonlyArray<TaskMemoryTelemetryTrigger>;
	tier: TaskMemoryTelemetryTier;
	bankDelta: TaskMemoryBankDelta;
	decision: TaskMemoryTelemetryDecision;
	reason: TaskMemoryPolicyReason;
	refusalReason?: string;
	bankOperations: number;
	droppedOperations: number;
	citedEntries: number;
	inputTokens: number;
	outputTokens: number;
	missingTokenCalls?: number;
	latencyMs: number;
	/** Resolved route of the attempt, present only when a model client was resolved. */
	route?: TaskMemoryRoute;
	/** When a budget skip expects room again. */
	resumeAt?: string;
}

export interface TaskMemoryTelemetrySink {
	record(step: TaskMemoryTelemetryStep): void;
}

/** Steps share the journal writer and its owning context; no memory side store exists (#434). */
export function createTaskMemoryTelemetrySink(): TaskMemoryTelemetrySink {
	return {
		record(step) {
			const context =
				step.context ??
				telemetryContext() ??
				(step.calls?.[0] ? { sessionId: step.calls[0].sessionId, label: "memory" as const } : undefined);
			telemetryHub().emit(
				"memory.step_decided",
				{
					triggerReasons: [...new Set(step.triggerReasons)],
					tier: step.tier,
					bankDelta: step.bankDelta,
					decision: step.decision,
					reason: step.reason,
					bankOperations: step.bankOperations,
					droppedOperations: step.droppedOperations,
					citedEntries: step.citedEntries,
					inputTokens: tokenFact(step.inputTokens, step.missingTokenCalls),
					outputTokens: tokenFact(step.outputTokens, step.missingTokenCalls),
					latencyMs: { kind: "measured", value: step.latencyMs, source: "local-clock" },
					...(step.calls === undefined ? {} : { calls: step.calls.map(({ callId, attemptId }) => ({ callId, attemptId })) }),
					...(step.missingTokenCalls === undefined ? {} : { missingTokenCalls: step.missingTokenCalls }),
					...(step.route === undefined ? {} : { route: step.route }),
					...(step.resumeAt === undefined ? {} : { resumeAt: step.resumeAt }),
				},
				context,
			);
		},
	};
}

function tokenFact(value: number, missing: number | undefined): Fact<number> {
	return value > 0 || missing === 0
		? { kind: "measured", value, source: "provider" }
		: { kind: "unknown", reason: "not-observed" };
}

export function taskMemoryBankDelta(before: TaskMemorySnapshot, after: TaskMemorySnapshot): TaskMemoryBankDelta {
	return {
		status: entryDelta(before.status === null ? [] : [before.status], after.status === null ? [] : [after.status]),
		knowledge: entryDelta(before.knowledge, after.knowledge),
		procedural: entryDelta(before.procedural, after.procedural),
	};
}

function entryDelta(
	before: ReadonlyArray<TaskMemoryEntry>,
	after: ReadonlyArray<TaskMemoryEntry>,
): TaskMemoryClassDelta {
	const old = new Map(before.map((entry) => [entry.id, entry]));
	const next = new Map(after.map((entry) => [entry.id, entry]));
	let added = 0;
	let updated = 0;
	let deleted = 0;
	for (const [id, entry] of next) {
		const previous = old.get(id);
		if (previous === undefined) added += 1;
		else if (!sameEntry(previous, entry)) updated += 1;
	}
	for (const id of old.keys()) {
		if (!next.has(id)) deleted += 1;
	}
	return { added, updated, deleted };
}

/**
 * Only durable content decides whether an entry changed. `lastTouchedAt` and
 * `injectionCount` also move when the bank records that an entry contributed to
 * a visible reminder, and attribution is not a write: counting it made every
 * intervening step report one bank write per cited entry, which is why the
 * intervened steps in the shipped telemetry disagree with `bankOperations`.
 * `createdAt` stays in the comparison because `clear()` restarts id allocation,
 * so one window can straddle a session switch that reuses an id.
 */
function sameEntry(left: TaskMemoryEntry, right: TaskMemoryEntry): boolean {
	return left.content === right.content && left.createdAt === right.createdAt;
}
