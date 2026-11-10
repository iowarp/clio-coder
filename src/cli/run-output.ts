import { parseJsonObjectPayload, parseVerifierPayload } from "../core/json-payload.js";
import { renderFactField } from "../core/telemetry/render.js";
import type { CompletedRunCaveat } from "../domains/dispatch/failure-headline.js";
import {
	completedRunCaveat,
	TOOL_GUARD_REASON_CODE,
	workerFailureHeadline,
} from "../domains/dispatch/failure-headline.js";
import type { RunResult } from "../domains/dispatch/types.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { holdCutOffText, redactUrlCredentials } from "../domains/safety/redaction.js";
import { runGatewayRoutingLabel, runResponseModelIdObservationLabel } from "../tools/dispatch-event-text.js";

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

function failedChecks(value: unknown): string[] {
	return records(value).flatMap((check) =>
		check.passed === false && typeof check.name === "string"
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

/** DF-6: project only contract fields from the sealed result, never infer limits from narration. */
function sealedResultLimitations(receipt: RunResult): string[] {
	const report = sealedReport(receipt);
	if (report === null) return [];
	const { kind, data } = report;
	switch (kind) {
		case "mutation-report":
			return [...strings(data.declaredChecks), ...failedChecks(data.validations)];
		case "code-report":
			return failedChecks(data.checks);
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

/**
 * The sealed result's own prose, for a native worker that delivered its answer
 * only through the result contract and wrote no assistant text (DF-6: a read-only
 * coder's explanation reached stdout as a bare result line).
 */
function sealedResultAnswer(receipt: RunResult): string {
	const output = receipt.output;
	if (output?.state !== "final") return "";
	const structured = output.structured;
	if (structured === undefined) return output.text.trim();
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
				...(changed.length > 0 ? [`changed: ${changed.join(", ")}`] : []),
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
	return lines.length > 0 ? lines.join("\n") : output.text.trim();
}

/** The human answer, settled evidence limits, and the run result line in that order. */
export function formatDispatchHumanOutput(streamedAnswer: string, receipt: RunResult): string {
	// A worker whose last words were its sealed JSON report reads in the words the report holds, as the card does.
	const streamedReport = receipt.output?.structured !== undefined && /^\s*\{[\s\S]*\}\s*$/u.test(streamedAnswer);
	const whole = streamedAnswer.length > 0 && !streamedReport ? streamedAnswer : sealedResultAnswer(receipt);
	// A run that never settled a final message can have stopped inside a URL, so what it holds stays hidden (#446).
	const cutOff = receipt.output === undefined ? receipt.exitCode !== 0 : receipt.output.state === "partial";
	const answer = cutOff ? holdCutOffText(whole) : whole;
	const limitations = sealedResultLimitations(receipt);
	const verifier = verifierVerdict(receipt);
	const failedBlock =
		verifier !== null && verifier.failedChecks.length > 0
			? `\nFailed checks:\n${verifier.failedChecks.map((item) => `- ${limitationLine(item)}`).join("\n")}\n`
			: "";
	const block =
		limitations.length > 0
			? `\nNot verified:\n${limitations.map((item) => `- ${limitationLine(item)}`).join("\n")}\n`
			: "";
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
		`${answer.length > 0 ? `${answer}\n` : ""}${failedBlock}${block}${failed}${finishedWith}${formatResultLine(receipt, limitations.length, verifier)}\n`,
	);
}

/** The completion caveat from the receipt's own counts, through the one rule every run surface uses. */
function receiptCaveat(receipt: RunResult): CompletedRunCaveat | null {
	// Older and synthetic receipts can lack the per-tool counts; a missing count says nothing either way.
	const refusedCalls = (receipt.toolStats ?? []).reduce((sum, stat) => sum + (stat.blocked ?? 0), 0);
	const guardedCalls = Math.min(
		refusedCalls,
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
): string {
	const reasoningFact = r.spend.usage.reasoning;
	const reasoning =
		reasoningFact.kind === "measured" && reasoningFact.value > 0 ? ` reasoning=${renderFactField(reasoningFact)}` : "";
	const failure = r.failureMessage ? ` error=${r.failureMessage}` : "";
	const verification =
		(verifier !== null ? ` verdict=${verifier.verdict}` : "") +
		(verifier !== null && verifier.failedChecks.length > 0 ? ` failed_checks=${verifier.failedChecks.length}` : "") +
		(notVerified > 0 ? ` verification=unverified not_verified=${notVerified}` : "");
	const responseModelIdObservation = runResponseModelIdObservationLabel(r);
	const gatewayRouting = runGatewayRoutingLabel(r);
	return `result: ${r.runId} agent=${r.agentId} exit=${r.exitCode}${verification} target=${r.targetId} requested_model_id=${r.wireModelId}${responseModelIdObservation ? ` ${responseModelIdObservation}` : ""}${gatewayRouting ? ` ${gatewayRouting}` : ""} tokens=${renderFactField(r.spend.totalTokens)}${reasoning}${failure} start=${r.startedAt} end=${r.endedAt}`;
}
