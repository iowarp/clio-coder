/**
 * Pure aggregation helpers for the per-tool stats folded into a RunResult.
 *
 * Sourced from the worker's ToolTelemetry stream (`clio_coder_tool_finish` IPC
 * events). Kept as a small standalone module so receipts have a single source
 * of truth for the aggregation invariants, and so loops, retries, errors,
 * blocked admissions, and parallel-batch tool calls all flow through one
 * code path that unit tests can pin.
 *
 * Invariants (pinned by tests/contracts/dispatch.test.ts):
 *   - Each recognized outcome (ok|error|blocked) increments its own bucket and
 *     count, so count == ok + errors + blocked + withheld whenever every recorded
 *     finish carried an outcome. An `ok` finish the spent observation pool
 *     stopped before it ran (`notExecuted: "observation_budget"`, C-17) counts
 *     withheld instead of ok. The worker ToolFinishEvent always does; a synthetic
 *     finish without an outcome increments count only.
 *   - totalDurationMs accumulates only finite non-negative durations.
 *   - snapshot is sorted by tool-name UTF-16 code unit ascending so receipt
 *     digests stay deterministic across runs and host locales.
 *   - countToolCalls returns the sum of count across every entry.
 */

import type { ActionClass } from "../safety/action-classifier.js";
import type { Obligation } from "./obligation.js";
import type { ToolActivitySummary, ToolCallStat } from "./types.js";

export interface ToolFinishPayload {
	tool?: string;
	durationMs?: number;
	outcome?: "ok" | "error" | "blocked";
	actionClass?: string;
	/** An `ok` call that did no work (C-17); see `ToolFinishEvent.notExecuted`. */
	notExecuted?: string | undefined;
}

export interface ToolStartPayload {
	tool?: string;
}

/** Count starts independently from finishes so a worker crash cannot disappear an in-flight call. */
export function recordToolStart(inFlight: Map<string, number>, payload: ToolStartPayload): void {
	if (typeof payload.tool !== "string") return;
	inFlight.set(payload.tool, (inFlight.get(payload.tool) ?? 0) + 1);
}

/** Match one finish to its start without inventing a start for legacy or opaque streams. */
export function recordToolCompletion(inFlight: Map<string, number>, payload: ToolFinishPayload): void {
	if (typeof payload.tool !== "string") return;
	const count = inFlight.get(payload.tool) ?? 0;
	if (count <= 1) inFlight.delete(payload.tool);
	else inFlight.set(payload.tool, count - 1);
}

export function snapshotUnfinishedTools(inFlight: ReadonlyMap<string, number>): Array<{ tool: string; count: number }> {
	return [...inFlight.entries()]
		.filter(([, count]) => count > 0)
		.map(([tool, count]) => ({ tool, count }))
		.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

function blankStat(tool: string): ToolCallStat {
	return { tool, count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0 };
}

/**
 * The `details.notExecuted` type a tool result carries when its call returned a notice without running (C-17), for
 * the stats folds that see the result rather than the finish event: a gateway chain's steps and a headless run.
 */
export function resultNotExecuted(result: unknown): string | undefined {
	if (result === null || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (details === null || typeof details !== "object") return undefined;
	const value = (details as { notExecuted?: unknown }).notExecuted;
	return typeof value === "string" ? value : undefined;
}

export function recordToolFinish(stats: Map<string, ToolCallStat>, payload: ToolFinishPayload): void {
	if (typeof payload.tool !== "string") return;
	const existing = stats.get(payload.tool) ?? blankStat(payload.tool);
	existing.count += 1;
	if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs) && payload.durationMs >= 0) {
		existing.totalDurationMs += payload.durationMs;
	}
	if (payload.outcome === "ok" && payload.notExecuted === "observation_budget")
		existing.withheld = (existing.withheld ?? 0) + 1;
	else if (payload.outcome === "ok") existing.ok += 1;
	else if (payload.outcome === "error") existing.errors += 1;
	else if (payload.outcome === "blocked") existing.blocked += 1;
	// The store tool's class depends on its op, so the tool name alone reads a
	// granted put as a read; keep the per-call class the worker saw.
	if (payload.outcome === "ok" && (payload.actionClass === "write" || payload.actionClass === "destructive"))
		existing.okWrites = (existing.okWrites ?? 0) + 1;
	stats.set(payload.tool, existing);
}

export function countToolCalls(stats: Map<string, ToolCallStat>): number {
	let total = 0;
	for (const stat of stats.values()) total += stat.count;
	return total;
}

export function snapshotToolStats(stats: Map<string, ToolCallStat>): ToolCallStat[] {
	return [...stats.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * Whether a receipt contains an executed tool call that may have changed
 * state. Failed calls are included because an error result does not prove the
 * tool rolled back partial filesystem or external side effects. Blocked calls
 * are excluded because admission stopped them before execution. Unknown tools
 * are treated conservatively as potentially mutating.
 */
export function hasPotentiallyMutatingAttempt(
	stats: ReadonlyArray<ToolCallStat>,
	classify: (tool: string) => ActionClass,
): boolean {
	return stats.some((stat) => stat.count > stat.blocked && classify(stat.tool) !== "read");
}

/** Action classes that can change state outside the worker's own context. */
const MUTATING_ACTION_CLASSES: ReadonlySet<ActionClass> = new Set([
	"write",
	"execute",
	"dispatch",
	"system_modify",
	"git_destructive",
	"destructive",
]);

export function summarizeToolActivity(
	stats: Map<string, ToolCallStat>,
	classify: (tool: string) => ActionClass,
): ToolActivitySummary {
	const summary: ToolActivitySummary = { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false };
	let withheld = 0;
	for (const stat of stats.values()) {
		if (stat.tool === "clio_submit_result") continue;
		summary.calls += stat.count;
		summary.succeeded += stat.ok;
		summary.failed += stat.errors;
		summary.blocked += stat.blocked;
		withheld += stat.withheld ?? 0;
		if (stat.ok > 0 && MUTATING_ACTION_CLASSES.has(classify(stat.tool))) {
			summary.mutatingSucceeded = true;
		}
		if (stat.tool === "store" && (stat.okWrites ?? 0) > 0) summary.storeWritten = true;
	}
	if (withheld > 0) summary.withheld = withheld;
	return summary;
}

/** Calls that ran: a notice the spent observation pool returned in a call's place ran nothing (C-17). */
function executedCalls(activity: Pick<ToolActivitySummary, "calls" | "withheld">): number {
	return activity.calls - (activity.withheld ?? 0);
}

/**
 * Factual note for a run that finished as succeeded without a single
 * successful tool call. The outcome stays succeeded (the harness cannot judge
 * whether the task was semantically accomplished); the note only makes the
 * emptiness visible wherever outcomeDetail renders.
 */
export function zeroSuccessfulToolNote(activity: ToolActivitySummary): string | null {
	if (activity.succeeded > 0) return null;
	const withheld = activity.withheld ?? 0;
	if (executedCalls(activity) === 0)
		return withheld > 0
			? `completed without executing any tools (${withheld} withheld by the observation budget)`
			: "completed without executing any tools";
	return `completed without a successful tool call (${activity.calls} attempted: ${activity.failed} failed, ${activity.blocked} blocked${withheld > 0 ? `, ${withheld} withheld` : ""})`;
}

/**
 * Attempted write-class calls when every one of them was blocked by policy and
 * no state-changing call of any class succeeded. A workspace-edit worker in
 * that state produced no mutation, yet its finish contract reads "no
 * mutation" as success, so the caller seals it failed instead. Null whenever
 * no write was attempted, one write got past admission, or any mutating call
 * landed. A shell call may have changed anything, so it counts as landing until
 * `mutatedPathCount` says the run's tree did not move: a lint that passed beside
 * a refused write does not make the write's refusal `✓ execution ok`.
 */
export function blockedWriteAttempts(
	stats: ReadonlyMap<string, ToolCallStat>,
	classify: (tool: string) => ActionClass,
	mutatedPathCount: number | null = null,
): number | null {
	let attempted = 0;
	let blocked = 0;
	for (const stat of stats.values()) {
		const actionClass = classify(stat.tool);
		if (stat.ok > 0 && MUTATING_ACTION_CLASSES.has(actionClass) && (actionClass === "write" || mutatedPathCount !== 0)) {
			return null;
		}
		if (actionClass !== "write") continue;
		attempted += stat.count;
		blocked += stat.blocked;
	}
	return attempted > 0 && blocked === attempted ? attempted : null;
}

/**
 * Calls of the execute or write class that policy refused before they ran, when every such call was refused.
 * Zero once one of them got past admission, ran or failed: the refusals then are not why the tree did not move.
 */
export function blockedStateChangingCalls(
	stats: ReadonlyMap<string, ToolCallStat>,
	classify: (tool: string) => ActionClass,
): number {
	let blocked = 0;
	for (const stat of stats.values()) {
		const actionClass = classify(stat.tool);
		if (actionClass !== "write" && actionClass !== "execute") continue;
		if (stat.count > stat.blocked) return 0;
		blocked += stat.blocked;
	}
	return blocked;
}

/** A report that opens by saying the worker could not do something. */
const INABILITY_OPENING =
	/^(?:i\s+)?(?:cannot|can't|could not|couldn't|was unable to|am unable to|unable to|blocked\b)/iu;
/** A report that opens by saying the assignment needed no change, the finish an unrefused edit worker may give. */
const NO_CHANGE_NEEDED_OPENING =
	/^(?:no\s+(?:code\s+|source\s+)?(?:changes?|edits?|fix(?:es)?|modifications?)\s+(?:(?:is|are|was|were)\s+)?(?:needed|required|necessary)|nothing\s+(?:needed\s+to\s+(?:change|be\s+changed)|needs\s+(?:to\s+)?(?:change|changing|fixing)|to\s+(?:change|fix))|already\s+(?:implemented|done|fixed|correct|present|in\s+place|handled|satisfied))\b/iu;
/** A report that opens by saying the work is only partly done. */
const PARTIAL_OPENING =
	/^(?:(?:only\s+)?partial(?:ly)?\b|incomplete\b|(?:i\s+)?(?:did not|didn't|have not|haven't)\s+(?:finish|complete)|not\s+(?:all|everything|finished|complete)\b)/iu;

/**
 * With files changed, an inability counts as partial work only when what the worker could not do is the work itself.
 * "Unable to run the tests here; implemented X" is a finish it could not verify, not an unfinished assignment.
 */
const UNFINISHED_INABILITY = new RegExp(
	`${INABILITY_OPENING.source}\\s+(?:to\\s+)?(?:finish|complete|implement|fix|address|apply|do\\s+(?:all|everything|the\\s+rest|it))\\b`,
	"iu",
);

/**
 * The worker's report (a mutation report's summary, else its final prose) and its opening.
 * Only a report that opens with its inability counts: "the parser cannot overflow" is not one.
 * A leading conventional-commit subject line ("fix(scope): ...") is the report's title, not its opening.
 */
function workerReportOpening(finalText: string | undefined): { report: string; opening: string } {
	let report = finalText?.trim() ?? "";
	try {
		const parsed: unknown = JSON.parse(report);
		if (parsed && typeof parsed === "object" && "summary" in parsed && typeof parsed.summary === "string") {
			report = parsed.summary;
		}
	} catch {
		// Plain final prose is also a valid worker report.
	}
	const opening = report.trimStart().replace(/^[a-z]+(?:\([^)\n]*\))?!?:[^\n]*\n\s*/u, "");
	return { report, opening };
}

/**
 * An edit worker that changed files but opened its report by saying it could not
 * finish did part of its assignment. Its clean exit sealed "succeeded" and merged
 * the half-done tree under a subject such as "Could not finish everything".
 */
export function workerPartialWorkDetail(input: {
	activity: Pick<ToolActivitySummary, "mutatingSucceeded">;
	mutatedPathCount: number | null;
	finalText?: string;
}): string | null {
	const changed =
		(input.mutatedPathCount ?? 0) > 0 || (input.mutatedPathCount === null && input.activity.mutatingSucceeded);
	if (!changed) return null;
	const { opening } = workerReportOpening(input.finalText);
	if (!UNFINISHED_INABILITY.test(opening) && !PARTIAL_OPENING.test(opening)) return null;
	const reason = opening.split(/\r?\n/u)[0]?.trim() ?? "";
	return `worker reported it did not finish the assignment, so its changes are a partial result${reason ? `: ${reason}` : ""}`;
}

/** A clean process exit cannot overrule an edit worker's explicit report of inability. */
export function workerNoWorkDetail(input: {
	activity: ToolActivitySummary;
	/**
	 * False for a CLI subprocess: its tools run inside the external agent, so a zero
	 * count says Clio saw nothing, not that the worker did nothing. Defaults to true.
	 */
	toolLaneObserved?: boolean;
	limitationRecorded: boolean;
	mutatedPathCount: number | null;
	/** Permission asks the operator or main agent denied during the run. */
	escalationsDenied?: number;
	/** Who denied them, last one named. Absent reads as the operator. */
	escalationDeniedBy?: "operator" | "main agent" | "safety judge";
	/** Permission asks nobody answered inside their window, which the fallback then denied. */
	escalationsTimedOut?: number;
	/** Execute- or write-class calls policy refused without an escalation. */
	blockedStateChanging?: number;
	finalText?: string;
	limitationDetail?: string;
}): string | null {
	const { report, opening } = workerReportOpening(input.finalText);
	const reportedInability = INABILITY_OPENING.test(opening);
	const unchanged = input.mutatedPathCount === 0;
	// The operator must see that the run did nothing because they denied the call
	// (flywheel p7/A5); the worker's own text may not open with an inability.
	const denied = input.escalationsDenied ?? 0;
	if (denied > 0 && !input.activity.mutatingSucceeded && (input.mutatedPathCount ?? 0) === 0) {
		return `the ${input.escalationDeniedBy ?? "operator"} denied ${denied === 1 ? "the worker's permission request" : `${denied} of the worker's permission requests`}, so it changed nothing and the assignment was not done`;
	}
	// The same refusal with nobody at the keys sealed `✓ execution ok` over an unchanged tree.
	const timedOut = input.escalationsTimedOut ?? 0;
	if (timedOut > 0 && !input.activity.mutatingSucceeded && (input.mutatedPathCount ?? 0) === 0) {
		return `nobody answered ${timedOut === 1 ? "the worker's permission request" : `${timedOut} of the worker's permission requests`} in time, so it changed nothing and the assignment was not done`;
	}
	// A store put is the deliverable of a store-only worker, though it touches no workspace path.
	if (unchanged && !input.activity.storeWritten && (input.limitationRecorded || reportedInability)) {
		const reason = input.limitationDetail?.trim() || report;
		return `worker recorded a limitation and changed nothing, so the assignment was not done${reason ? `: ${reason}` : ""}`;
	}
	if (input.toolLaneObserved !== false && executedCalls(input.activity) === 0) {
		return "worker executed no tools, so it did none of its assignment";
	}
	// A worker that found nothing to change says so; one incidental refusal on the way does not undo that finish.
	const refused = input.blockedStateChanging ?? 0;
	if (unchanged && refused > 0 && !input.activity.mutatingSucceeded && !NO_CHANGE_NEEDED_OPENING.test(opening)) {
		return `the worker's ${refused === 1 ? "state-changing call was" : `${refused} state-changing calls were`} refused by policy and nothing changed, so the assignment was not done`;
	}
	return null;
}

/**
 * A run that owes `observed-evidence` and settled without executing one tool read nothing, so its report rests on
 * no evidence. Its clean exit sealed `succeeded`, quality=unmeasured and failed=0 (FX-19). The result-report call is
 * not a tool here: summarizeToolActivity already leaves it out. Null for any other obligation, and for a CLI
 * subprocess whose tool lane Clio cannot see.
 */
export function readScopedNoToolsReason(input: {
	activity: Pick<ToolActivitySummary, "calls" | "withheld">;
	obligation: Obligation;
	toolLaneObserved: boolean;
}): string | null {
	if (input.obligation !== "observed-evidence" || !input.toolLaneObserved || executedCalls(input.activity) > 0)
		return null;
	return "obligation observed-evidence unmet: no tools executed, so the worker reported without reading anything and its findings are unaudited";
}

export function blockedWriteDetail(attempted: number): string {
	return `${attempted === 1 ? "the one write it attempted was" : `all ${attempted} writes it attempted were`} blocked by policy, so no workspace change landed`;
}
