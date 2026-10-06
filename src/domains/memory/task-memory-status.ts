import type { EffectiveMemoryRoute } from "../../core/session-routing.js";
import type { TaskMemorySnapshot } from "./task-bank.js";
import type { TaskMemoryPolicyDecision, TaskMemoryPolicyReason } from "./task-memory-policy.js";
import type { TaskMemorySpendSummary } from "./task-memory-spend.js";
import type {
	TaskMemoryTelemetryDecision,
	TaskMemoryTelemetrySink,
	TaskMemoryTelemetryStep,
	TaskMemoryTelemetryTier,
	TaskMemoryTelemetryTrigger,
} from "./task-memory-telemetry.js";

export type TaskMemoryTier = "rules" | "llm";

/**
 * One completed memory step, projected for operator surfaces. It carries counts
 * and outcomes only, matching the telemetry sink's content-free discipline, so
 * it can be rendered without leaking bank or trajectory text into the TUI.
 */
export interface TaskMemoryActivityEvent {
	at: string;
	triggerReasons: ReadonlyArray<TaskMemoryTelemetryTrigger>;
	tier: TaskMemoryTelemetryTier;
	decision: TaskMemoryTelemetryDecision;
	reason: TaskMemoryPolicyReason;
	citedEntries: number;
	bankWrites: number;
	latencyMs: number;
}

/** What the always-on memory guardian is doing; one value every operator surface projects. */
export type TaskMemoryGuardianState = "off" | "idle" | "reviewing" | "waiting-capacity" | "unavailable";

/** Read-only projection shared by operator surfaces. */
export interface TaskMemoryOperatorStatus {
	enabled: boolean;
	tier: TaskMemoryTier;
	route?: EffectiveMemoryRoute;
	size: number;
	lastDecision: TaskMemoryPolicyDecision | null;
	bank: TaskMemorySnapshot;
	/** Newest-first bounded memory-step history; empty until a step completes. */
	activity: ReadonlyArray<TaskMemoryActivityEvent>;
	/** True while a detached background memory step is still running. */
	stepInFlight: boolean;
	/** Guardian state; absent on a surface that does not run the guardian. */
	guardian?: TaskMemoryGuardianState;
	/**
	 * Lifetime llm-tier spend and hit rate folded from the telemetry ledger. Null
	 * on a surface that does not read the ledger, which is every surface that
	 * only needs the live bank.
	 */
	spend?: TaskMemorySpendSummary | null;
}

/**
 * Compact operator wording for one memory step, used by the TUI surfaces.
 *
 * The reason rides alongside the decision because `silent` on its own is the
 * line an operator cannot act on: it reads the same whether the model declined
 * to write, the route refused the connection, or the answer was unreadable.
 * `intervened` is omitted, since `injected` already says it.
 */
export function describeTaskMemoryActivity(event: TaskMemoryActivityEvent): string {
	const parts: string[] = [event.decision];
	if (event.reason !== "intervened") parts.push(event.reason);
	if (event.bankWrites > 0) parts.push(`${event.bankWrites}w`);
	if (event.citedEntries > 0) parts.push(`${event.citedEntries} cited`);
	return `${event.triggerReasons.join("+")} ${parts.join(" ")}`;
}

/** The operator row for a step, built from the step its ledger row is built from. */
function taskMemoryActivityFromStep(step: TaskMemoryTelemetryStep, at: string): TaskMemoryActivityEvent {
	const delta = step.bankDelta;
	return {
		at,
		triggerReasons: [...new Set(step.triggerReasons)],
		tier: step.tier,
		decision: step.decision,
		reason: step.reason,
		citedEntries: step.citedEntries,
		bankWrites: [delta.status, delta.knowledge, delta.procedural].reduce(
			(total, entry) => total + entry.added + entry.updated + entry.deleted,
			0,
		),
		latencyMs: step.latencyMs,
	};
}

export interface HistoryReviewActivity {
	/** The sink the guardian records through. Every step still reaches the ledger. */
	telemetry: TaskMemoryTelemetrySink;
	/** Newest-first review steps that ran for `sessionId`. */
	recent(sessionId: string | null): TaskMemoryActivityEvent[];
}

/**
 * Operator rows for history reviews, derived from the steps the ledger records.
 *
 * A history review reports through the telemetry sink alone, so it spent tokens
 * the spend line counted while `/memory` listed no step and said `last none`.
 * Each row here is projected from the very step its ledger row is written from,
 * so the view cannot say less than the ledger and no count is derived twice.
 *
 * A review retired by a session or repository change settles after the change
 * with `scope_changed`. Its spend belongs in the ledger, but the session current
 * at that moment is not the one it reviewed for, so it gets no row. Every other
 * row is tagged with its session, so a later session starts empty.
 */
export function createHistoryReviewActivity(
	ledger: TaskMemoryTelemetrySink,
	currentSessionId: () => string | null,
	limit: number,
	now: () => Date = () => new Date(),
): HistoryReviewActivity {
	const rows: { sessionId: string | null; event: TaskMemoryActivityEvent }[] = [];
	return {
		telemetry: {
			record(step) {
				ledger.record(step);
				if (step.reason === "scope_changed") return;
				rows.unshift({ sessionId: currentSessionId(), event: taskMemoryActivityFromStep(step, now().toISOString()) });
				if (rows.length > limit) rows.length = limit;
			},
		},
		recent: (sessionId) => rows.filter((row) => row.sessionId === sessionId).map((row) => row.event),
	};
}

/**
 * Boundary steps and history reviews as the one history a surface shows.
 *
 * The last decision is that of the newest step that reached one, whichever
 * plane ran it. A dropped step never reached a decision, so it stays a visible
 * row without replacing the decision before it. The middleware's own value is
 * used whenever that step is not a review, because the middleware also sets it
 * on paths that add no row.
 */
export function projectTaskMemoryActivity(
	boundary: { activity: ReadonlyArray<TaskMemoryActivityEvent>; lastDecision: TaskMemoryPolicyDecision | null },
	reviews: ReadonlyArray<TaskMemoryActivityEvent>,
	limit: number,
): Pick<TaskMemoryOperatorStatus, "activity" | "lastDecision"> {
	const merged = [...boundary.activity, ...reviews].sort((a, b) => b.at.localeCompare(a.at));
	const decided = merged.find((event) => event.decision !== "dropped");
	return {
		activity: merged.slice(0, limit),
		lastDecision:
			decided !== undefined && decided.decision !== "dropped" && reviews.includes(decided)
				? decided.decision
				: boundary.lastDecision,
	};
}

export function taskMemoryBankSize(snapshot: TaskMemorySnapshot): number {
	return (snapshot.status === null ? 0 : 1) + snapshot.knowledge.length + snapshot.procedural.length;
}
