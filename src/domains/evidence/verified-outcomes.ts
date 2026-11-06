/**
 * Verified outcomes per session, and what the session spent per outcome.
 *
 * An outcome counts only from a typed field Clio recorded, never from prose a model wrote:
 *  - a `verify` result whose declared `reproduce` or `numeric-compare` judgement passed;
 *  - a worker run whose record verifies against its seal and whose host verification passed;
 *  - a board task marked done whose required checks all have an observed pass.
 * One verification is one outcome. A check passing again on the same judged payload is the same result, so it is keyed
 * by check id and payload digests. A worker run's host checks are keyed the same way from the dispatch result the
 * ledger holds (its sealed run record keeps no report), and a run whose every host check judged a payload a main-thread
 * pass already counts folds into that pass. A run whose checks the ledger does not show counts only when no
 * main-thread pass exists for it to duplicate. A done task is checked by the passes observed while it was
 * active, and those are often the very check passes or worker runs already counted; a task counts only for a pass of
 * its own. Its observed rows carry the timestamp of the ledger entry that recorded the pass (`standingChecks`), so a
 * row whose time is a counted outcome's entry time is that outcome. Two results written in the same millisecond share a
 * time, so the match errs toward counting the task as already counted, never toward counting it twice.
 *
 * The per-outcome figures divide the session's own folded totals, so they keep every mark the totals carry: a lower
 * bound stays a lower bound, an estimate stays an estimate, and an unpriced spend stays `not measured`.
 */

import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import { foldSessionTaskHistory, observedTaskChecks, taskCompletionStanding } from "../session/task-board.js";
import { readRunTrust } from "./run-trust.js";

/** The declared check kinds whose pass is a verified outcome; `command` and `perf-budget` passes are not. */
const VERIFIED_CHECK_KINDS = ["reproduce", "numeric-compare"] as const;

export interface VerifiedOutcomeCount {
	total: number;
	/** Distinct `reproduce` and `numeric-compare` passes. */
	checks: number;
	/** Sealed worker runs whose host verification passed on a payload no counted main-thread pass judged. */
	workers: number;
	/** Board tasks done with every required check observed passing, and a pass no other outcome here counts. */
	tasks: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * The identity of the result a passing declared check judged, or null when the entry is not one. The judged payload
 * digests name the result, so rerunning a check on unchanged output is the same outcome and changed output is another.
 */
function passedCheckKey(details: Record<string, unknown>): string | null {
	const judgement = details.judgement;
	if (!isRecord(judgement) || judgement.validation !== "passed" || judgement.execution !== "succeeded") return null;
	return judgedKey(str(details.check), details.report);
}

/** Kind, check id and judged digests of a passing reproduce or numeric-compare report; null for any other report. */
function judgedKey(check: string, report: unknown): string | null {
	return isRecord(report) && report.passed === true ? judgedPayloadKey(check, report) : null;
}

/**
 * Kind, check id and judged digests of a reproduce or numeric-compare report, passing or not; null for any other
 * report. The identity of what was judged: the claims log keys a claim's subject by it (#406).
 */
export function judgedPayloadKey(check: string, report: unknown): string | null {
	if (!isRecord(report)) return null;
	const kind = report.kind;
	if (!VERIFIED_CHECK_KINDS.some((verified) => verified === kind)) return null;
	const digests: string[] = [];
	const digest = (value: unknown): void => {
		if (isRecord(value) && typeof value.sha256 === "string") digests.push(value.sha256);
	};
	digest(report.reference);
	digest(report.actual);
	if (Array.isArray(report.runs)) for (const run of report.runs) digest(isRecord(run) ? run.payload : undefined);
	const conditions = report.conditions;
	if (isRecord(conditions) && Array.isArray(conditions.inputs)) for (const input of conditions.inputs) digest(input);
	return `${String(kind)}\0${check}\0${digests.join(",")}`;
}

/**
 * The judged keys of each run's host checks as the dispatch result reports them, by run id. A check with no report
 * (a `command` check) judged no payload any main-thread pass can count, so it is keyed by nothing and keeps its run.
 */
function hostCheckKeys(details: Record<string, unknown>): Map<string, Array<string | null>> {
	const keys = new Map<string, Array<string | null>>();
	const runs = Array.isArray(details.runs) ? details.runs : [details];
	for (const run of runs) {
		if (!isRecord(run) || typeof run.runId !== "string" || !isRecord(run.hostVerification)) continue;
		const host = run.hostVerification;
		if (!Array.isArray(host.checks)) continue;
		keys.set(
			run.runId,
			host.checks.map((check) => (isRecord(check) ? judgedKey(str(check.check), check.report) : null)),
		);
	}
	return keys;
}

/** A settled tool result entry's tool, details and ledger time, or null for any other entry. */
function toolResult(entry: unknown): { tool: string; details: Record<string, unknown>; at: string } | null {
	if (!isRecord(entry) || entry.kind !== "message" || entry.role !== "tool_result" || !isRecord(entry.payload))
		return null;
	const payload = entry.payload;
	if (payload.isError === true || !isRecord(payload.result) || !isRecord(payload.result.details)) return null;
	return { tool: str(payload.toolName), details: payload.result.details, at: str(entry.timestamp) };
}

/** The run ids a dispatch result names: one run's `runId`, or each of a batch's `runs[].runId`. */
function dispatchRunIds(details: Record<string, unknown>): string[] {
	const runs = Array.isArray(details.runs) ? details.runs : [details];
	return runs.flatMap((run) => (isRecord(run) && typeof run.runId === "string" ? [run.runId] : []));
}

/** Whether a run's sealed record says Clio's own host verification passed on it. */
export function runHostVerified(record: RunTelemetryV1 | null): boolean {
	if (record === null || record.settled === null) return false;
	const { integrity, trust } = readRunTrust(record);
	const grounding = trust.validationGrounding;
	return (
		integrity.state === "verified" &&
		grounding.state === "validated" &&
		"authority" in grounding &&
		grounding.authority.id === "host-verification"
	);
}

/**
 * Count a session's verified outcomes. `entries` is the session's whole ledger, every branch included, as its token
 * and cost totals cover every branch; gateway chain children must already be expanded. `verified` names the worker
 * runs the session's telemetry references whose sealed record passes `runHostVerified`.
 */
export function countVerifiedOutcomes(
	entries: ReadonlyArray<unknown>,
	verified: ReadonlySet<string>,
): VerifiedOutcomeCount {
	const checks = new Set<string>();
	const hostKeys = new Map<string, Array<string | null>>();
	/** Ledger times of the entries that recorded a counted pass or a host-verified run, counted or folded. */
	const counted = new Set<string>();
	for (const entry of entries) {
		const result = toolResult(entry);
		if (result === null) continue;
		const key = passedCheckKey(result.details);
		if (key !== null) checks.add(key);
		const dispatched = result.tool === "dispatch";
		if (dispatched) for (const [runId, keys] of hostCheckKeys(result.details)) hostKeys.set(runId, keys);
		const verifiedRun = dispatched && dispatchRunIds(result.details).some((id) => verified.has(id));
		if ((key !== null || verifiedRun) && result.at !== "") counted.add(result.at);
	}
	const workers = new Set<string>();
	for (const runId of verified) {
		const keys = hostKeys.get(runId);
		// Without its checks in view a run could repeat a counted pass, so it counts only when there is none to repeat.
		const own = keys === undefined ? checks.size === 0 : keys.some((key) => key === null || !checks.has(key));
		if (own) workers.add(runId);
	}
	let tasks = 0;
	for (const board of foldSessionTaskHistory(entries))
		for (const task of board.tasks) {
			if (taskCompletionStanding(task) !== "checked") continue;
			if (observedTaskChecks(task).passed.some((pass) => !counted.has(pass.observedAt))) tasks += 1;
		}
	return { total: checks.size + workers.size + tasks, checks: checks.size, workers: workers.size, tasks };
}

/**
 * A session total split evenly over its verified outcomes, with the same coverage: each contribution's known part is
 * divided and its unknown and absent counts kept, so the renderer marks the share exactly as it marks the total.
 */
export function perVerifiedOutcome(sum: FactSum, outcomes: number): FactSum {
	if (!(outcomes > 0)) throw new RangeError("perVerifiedOutcome needs at least one verified outcome");
	return {
		measured: sum.measured / outcomes,
		estimated: sum.estimated / outcomes,
		unknownCount: sum.unknownCount,
		absentCount: sum.absentCount,
		coverage: { ...sum.coverage },
	};
}
