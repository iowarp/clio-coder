import { parseJsonObjectPayload, parseVerifierPayload } from "../core/json-payload.js";
import { renderFactField } from "../core/telemetry/render.js";
import type { CompletedRunCaveat } from "../domains/dispatch/failure-headline.js";
import {
	completedRunCaveat,
	TOOL_GUARD_REASON_CODE,
	workerFailureHeadline,
} from "../domains/dispatch/failure-headline.js";
import type { RunResult, SafetyBlockedAttempt } from "../domains/dispatch/types.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { holdCutOffText, redactUrlCredentials } from "../domains/safety/redaction.js";
import { runGatewayRoutingLabel, runResponseModelIdObservationLabel } from "../tools/dispatch-event-text.js";
import type { RunCompletionV2 } from "./modes/run-json-schema-v2.js";

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		: [];
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
			)
		: [];
}

/**
 * Failed checks as lines. `ran` selects a code-report's executed failures (true) or its checks that never started
 * (false), counting a check sealed without `ran` as not started; omitted, it selects every failure. A mutation report's
 * baseline entry ran before the change, so it is never a failure here.
 */
function failedChecks(value: unknown, ran?: boolean): string[] {
	return records(value).flatMap((check) =>
		check.passed === false &&
		check.baseline !== true &&
		typeof check.name === "string" &&
		(ran === undefined || (ran ? check.ran === true : check.ran !== true))
			? [`${check.name}: ${typeof check.evidence === "string" ? check.evidence : "did not pass"}`]
			: [],
	);
}

function sealedReport(receipt: RunResult): { kind: string; data: Record<string, unknown> } | null {
	const output = receipt.output;
	if (output?.state !== "final" || output.truncated) return null;
	const fact = receipt.quality.resultContract;
	// Verifier and debugger reports seal typed JSON without the helper envelope.
	const kind = output.structured?.kind ?? (fact?.conformance === "pass" ? fact.sourceId.split(":")[1] : undefined);
	if (kind === undefined) return null;
	const parsed = output.structured
		? { ok: true as const, value: output.structured.data }
		: kind === "verifier-report"
			? parseVerifierPayload(output.text)
			: parseJsonObjectPayload(output.text);
	return parsed.ok ? { kind, data: parsed.value } : null;
}

/**
 * A verifier's own verdict and the checks it ran that failed. A verifier that found a failure did its job, so the
 * run settles succeeded; only the process exit status says the gate failed. Other reports keep their semantics.
 */
export function verifierVerdict(receipt: RunResult): { verdict: string; failedChecks: string[] } | null {
	const report = sealedReport(receipt);
	if (report?.kind !== "verifier-report" || typeof report.data.verdict !== "string") return null;
	return { verdict: report.data.verdict, failedChecks: failedChecks(report.data.checks) };
}

/**
 * Checks that ran and failed, which print under Failed checks rather than as unverified: a code step's checks that
 * ran, and a mutation report's failed validations, since its contract lists only executed checks there and names the
 * ones it did not run under declaredChecks (CLI-6).
 */
function executedCodeFailures(receipt: RunResult): string[] {
	const report = sealedReport(receipt);
	if (report?.kind === "code-report") return failedChecks(report.data.checks, true);
	return report?.kind === "mutation-report" ? failedChecks(report.data.validations) : [];
}

/** DF-6: project only contract fields from the sealed result, never infer limits from narration. */
function sealedResultLimitations(receipt: RunResult): string[] {
	const report = sealedReport(receipt);
	if (report === null) return [];
	const { kind, data } = report;
	switch (kind) {
		case "mutation-report":
			return strings(data.declaredChecks);
		case "code-report":
			// A check that ran and failed is a failure, not a gap; a report sealed before `ran` keeps every failure here.
			return failedChecks(data.checks, false);
		case "scout-report":
			return [
				...strings([data.degradedReason]),
				...strings(data.ungroundedClaims).map((claim) => `Ungrounded claim: ${claim}`),
				...records(data.findings).flatMap((finding) =>
					typeof finding.claim === "string" &&
					(typeof finding.path !== "string" ||
						typeof finding.line !== "number" ||
						!Number.isSafeInteger(finding.line) ||
						finding.line < 1)
						? [`Ungrounded claim: ${finding.claim}`]
						: [],
				),
				...(data.needsSplit === true
					? records(data.proposedSubtasks).flatMap((subtask) =>
							strings([subtask.task]).map((task) => `Scout requested further work: ${task}`),
						)
					: []),
			];
		case "world-knowledge-report":
			return [
				...(data.discovery === "unavailable" || data.discovery === "caller-supplied-only"
					? [`Discovery: ${data.discovery}`]
					: []),
				...strings(data.uncertainties),
				...strings(data.followUpVerification),
			];
		case "provenance-report":
			return [...strings(data.missingEvidence), ...strings(data.nextInspections)];
		case "debugger-report":
			return data.reproduction === "unknown" || data.reproduction === "not-reproduced"
				? [`Reproduction: ${data.reproduction}`]
				: [];
		default:
			return [];
	}
}

function limitationLine(item: string): string {
	const plain = sanitizeCallTargetText(item);
	const chars = Array.from(plain);
	return chars.length > 400 ? `${chars.slice(0, 399).join("")}…` : plain;
}

/** The `Not verified:` block a run prints after its answer, one line per item; empty without items. */
function notVerifiedBlock(items: ReadonlyArray<string>): string {
	return items.length > 0 ? `\nNot verified:\n${items.map((item) => `- ${limitationLine(item)}`).join("\n")}\n` : "";
}

/**
 * The `Not verified:` block for a main run's host-sealed completion facts: a run whose last observation calls the
 * per-turn pool refused says so as an observation budget limit (CLI-P42). Empty when no such fact was sealed.
 */
export function sealedFactsNotVerified(facts: ReadonlyArray<string>): string {
	return notVerifiedBlock(
		facts.includes("observation_budget")
			? [
					"Observation budget: the per-turn observation pool refused the run's last observation calls (read, grep, find, ls, code_nav, context), so what they would have returned was not read.",
				]
			: [],
	);
}

/**
 * The sealed result's own prose, for a native worker that delivered its answer
 * only through the result contract and wrote no assistant text (DF-6: a read-only
 * coder's explanation reached stdout as a bare result line).
 */
function sealedResultAnswer(receipt: RunResult): string {
	const output = receipt.output;
	return output?.state === "final" ? sealedReportAnswer(output.text, output.structured) : "";
}

/**
 * A sealed report in the words it holds, or `text` as it is when nothing sealed it. `changed: false` leaves out the
 * report's changed paths for a surface that already lists the run's own.
 */
export function sealedReportAnswer(
	text: string,
	structured: { kind: string; data: Record<string, unknown> } | undefined,
	options: { changed?: boolean } = {},
): string {
	if (structured === undefined) return text.trim();
	const data = structured.data;
	const claims = (value: unknown): string[] =>
		records(value).flatMap((finding) => {
			if (typeof finding.claim !== "string") return [];
			const at =
				typeof finding.path === "string" && typeof finding.line === "number"
					? ` (${finding.path}:${finding.line})`
					: typeof finding.evidence === "string"
						? ` (${finding.evidence})`
						: "";
			return [`- ${finding.claim}${at}`];
		});
	const bullets = (value: unknown): string[] => strings(value).map((item) => `- ${item}`);
	let lines: string[];
	switch (structured.kind) {
		case "mutation-report": {
			// A coder's report names what it changed; a person reads that as a line, not as the JSON it sealed.
			const changed = strings(data.mutatedPaths);
			lines = [
				...strings([data.summary]),
				...bullets(data.observations),
				...(changed.length > 0 && options.changed !== false ? [`changed: ${changed.join(", ")}`] : []),
			];
			break;
		}
		case "scout-report":
		case "research-report":
			lines = claims(data.findings);
			break;
		case "world-knowledge-report":
			lines = [...strings(data.synthesis), ...claims(data.facts)];
			break;
		case "provenance-report":
			lines = bullets(data.confirmedFacts);
			break;
		case "oracle-report":
			lines = strings([data.verdict, data.challenge]);
			break;
		default:
			lines = [];
	}
	return lines.length > 0 ? lines.join("\n") : text.trim();
}

/** The human answer, settled evidence limits, and the run result line in that order. */
/**
 * A `run --agent` worker's answer in words, as text mode prints it and the v2 envelope's `result.text` holds it. A
 * worker whose last words were its sealed JSON report reads in the words the report holds, as the card does; the
 * report itself stays on the receipt's `output.structured`.
 */
export function dispatchAnswerText(streamedAnswer: string, receipt: RunResult): string {
	const streamedReport = receipt.output?.structured !== undefined && /^\s*\{[\s\S]*\}\s*$/u.test(streamedAnswer);
	const whole = streamedAnswer.length > 0 && !streamedReport ? streamedAnswer : sealedResultAnswer(receipt);
	// A run that never settled a final message can have stopped inside a URL, so what it holds stays hidden (#446).
	const cutOff = receipt.output === undefined ? receipt.exitCode !== 0 : receipt.output.state === "partial";
	return redactUrlCredentials(cutOff ? holdCutOffText(whole) : whole);
}

export function formatDispatchHumanOutput(streamedAnswer: string, receipt: RunResult): string {
	const answer = dispatchAnswerText(streamedAnswer, receipt);
	const limitations = sealedResultLimitations(receipt);
	const verifier = verifierVerdict(receipt);
	const executed = [...(verifier?.failedChecks ?? []), ...executedCodeFailures(receipt)];
	const failedBlock =
		executed.length > 0 ? `\nFailed checks:\n${executed.map((item) => `- ${limitationLine(item)}`).join("\n")}\n` : "";
	const block = notVerifiedBlock(limitations);
	// The one exit for a headless answer, whichever of the streamed, last or sealed text it came from (#446).
	// A person reading the run learns what went wrong in words before the machine line repeats the record's own detail.
	const headline = receipt.exitCode !== 0 ? workerFailureHeadline(receipt.failureMessage) : null;
	const failed = headline === null ? "" : `\nFailed: ${headline}\n`;
	// A run that finished with a refused call or a wrong-format answer says so in the words its worker card and board
	// row use, so a script reading exit 0 and a person reading the card are told the same thing.
	// A run that called no tools is only a hint on the card, and an answer-only worker legitimately calls none, so the
	// print states the two caveats that change what the answer is worth.
	const found = receipt.exitCode === 0 ? receiptCaveat(receipt) : null;
	const caveat = found?.kind === "no-tools" ? null : found;
	const finishedWith = caveat === null ? "" : `\nFinished with a caveat: ${caveat.words}\n`;
	return redactUrlCredentials(
		`${answer.length > 0 ? `${answer}\n` : ""}${failedBlock}${block}${failed}${finishedWith}${formatResultLine(receipt, limitations.length, verifier, executed.length)}\n`,
	);
}

/** The execute-class calls the run refused, a denied ask or a block; a guard's repetition stop is not a refusal. */
function refusedExecuteCalls(receipt: RunResult): SafetyBlockedAttempt[] {
	const safety = receipt.safety;
	return [...(safety?.permissionRequestedAttempts ?? []), ...(safety?.blockedAttempts ?? [])].filter(
		(attempt) => attempt.actionClass === "execute" && attempt.reasonCode !== TOOL_GUARD_REASON_CODE,
	);
}

/**
 * `run --agent`'s completion in the shape a main run's takes (CLI-P58), read only from the sealed receipt, never from
 * its prose. A worker declares through its sealed final answer: exit 0 claims `done`, any other exit `not_done`. A
 * `done` is assessed `partly_done` when a check failed (a failed result-contract quality or a rejected host
 * verification) or when an execute call was refused and nothing verified the run, which is how a refused run of the
 * operator's named check reads. `unverified` holds the checks the sealed report names as not run.
 */
export function agentRunCompletion(receipt: RunResult): RunCompletionV2 {
	const refused = refusedExecuteCalls(receipt);
	const limitations = refused.map((attempt) => {
		const why =
			attempt.reason ?? (attempt.permissionRequired === true ? "needed an approval this run could not give" : undefined);
		const what = `${attempt.tool} call refused${why !== undefined ? `: ${why}` : ""}`;
		return { what: limitationLine(redactUrlCredentials(what)), why: "blocked_by_policy" };
	});
	const unverified = sealedResultLimitations(receipt).map((item) => limitationLine(redactUrlCredentials(item)));
	if (receipt.output?.state !== "final")
		return { declared: false, claimed: null, assessed: "unknown", state: "unknown", limitations, unverified };
	const facts: NonNullable<RunCompletionV2["facts"]> = [];
	if (receipt.quality?.resultContract?.quality === "fail" || receipt.hostVerification?.status === "rejected")
		facts.push("failed_check");
	if (refused.length > 0 && receipt.verification?.state !== "verified") facts.push("refused_check");
	const claimed = receipt.exitCode === 0 ? "done" : "not_done";
	const assessed = claimed === "done" && facts.length > 0 ? "partly_done" : claimed;
	return {
		declared: true,
		claimed,
		assessed,
		state: assessed,
		...(facts.length > 0 ? { facts } : {}),
		limitations,
		unverified,
	};
}

/** The completion caveat from the receipt's own counts, through the one rule every run surface uses. */
function receiptCaveat(receipt: RunResult): CompletedRunCaveat | null {
	// Older and synthetic receipts can lack the per-tool counts; a missing count says nothing either way.
	const refusedCalls = (receipt.toolStats ?? []).reduce((sum, stat) => sum + (stat.blocked ?? 0), 0);
	// A receipt older than `guardBlockedAttempts` lists guard blocks among its blocked attempts.
	const guardedCalls = Math.min(
		refusedCalls,
		(receipt.safety?.guardBlockedAttempts?.length ?? 0) +
			(receipt.safety?.blockedAttempts ?? []).filter((attempt) => attempt.reasonCode === TOOL_GUARD_REASON_CODE).length,
	);
	const contract = receipt.quality?.resultContract?.conformance;
	return completedRunCaveat({
		toolCalls: receipt.toolCalls,
		...(refusedCalls > 0 ? { refusedCalls } : {}),
		...(guardedCalls > 0 ? { guardedCalls } : {}),
		...(contract !== undefined ? { contract } : {}),
	});
}

function formatResultLine(
	r: RunResult,
	notVerified: number,
	verifier: { verdict: string; failedChecks: string[] } | null,
	failedCount: number,
): string {
	const reasoningFact = r.spend.usage.reasoning;
	const reasoning =
		reasoningFact.kind === "measured" && reasoningFact.value > 0 ? ` reasoning=${renderFactField(reasoningFact)}` : "";
	const failure = r.failureMessage ? ` error=${r.failureMessage}` : "";
	const verification =
		(verifier !== null ? ` verdict=${verifier.verdict}` : "") +
		(failedCount > 0 ? ` failed_checks=${failedCount}` : "") +
		(notVerified > 0 ? ` verification=unverified not_verified=${notVerified}` : "");
	const responseModelIdObservation = runResponseModelIdObservationLabel(r);
	const gatewayRouting = runGatewayRoutingLabel(r);
	return `result: ${r.runId} agent=${r.agentId} exit=${r.exitCode}${verification} target=${r.targetId} requested_model_id=${r.wireModelId}${responseModelIdObservation ? ` ${responseModelIdObservation}` : ""}${gatewayRouting ? ` ${gatewayRouting}` : ""} tokens=${renderFactField(r.spend.totalTokens)}${reasoning}${failure} start=${r.startedAt} end=${r.endedAt}`;
}
