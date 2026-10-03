import { parseJsonObjectPayload } from "../core/json-payload.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { receiptGatewayRoutingLabel, receiptResponseModelIdObservationLabel } from "../tools/dispatch-event-text.js";

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

/** DF-6: project only contract fields from the sealed result, never infer limits from narration. */
function sealedResultLimitations(receipt: RunReceipt): string[] {
	const output = receipt.output;
	if (output?.state !== "final" || output.truncated) return [];
	const fact = receipt.quality.resultContract;
	// Verifier and debugger reports seal typed JSON without the helper envelope.
	const kind = output.structured?.kind ?? (fact?.conformance === "pass" ? fact.sourceId.split(":")[1] : undefined);
	if (kind === undefined) return [];
	const parsed = output.structured
		? { ok: true as const, value: output.structured.data }
		: parseJsonObjectPayload(output.text);
	if (!parsed.ok) return [];
	const data = parsed.value;
	switch (kind) {
		case "mutation-report":
			return [...strings(data.declaredChecks), ...failedChecks(data.validations)];
		case "verifier-report":
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

/** The human answer, sealed evidence limits, and execution receipt in that order. */
export function formatDispatchHumanOutput(answer: string, receipt: RunReceipt): string {
	const limitations = sealedResultLimitations(receipt);
	const block =
		limitations.length > 0
			? `\nNot verified:\n${limitations.map((item) => `- ${limitationLine(item)}`).join("\n")}\n`
			: "";
	return `${answer.length > 0 ? `${answer}\n` : ""}${block}${formatReceipt(receipt, limitations.length)}\n`;
}

function formatReceipt(r: RunReceipt, notVerified: number): string {
	const reasoning =
		typeof r.reasoningTokenCount === "number" && r.reasoningTokenCount > 0 ? ` reasoning=${r.reasoningTokenCount}` : "";
	const failure = r.failureMessage ? ` error=${r.failureMessage}` : "";
	const verification = notVerified > 0 ? ` verification=unverified not_verified=${notVerified}` : "";
	const responseModelIdObservation = receiptResponseModelIdObservationLabel(r);
	const gatewayRouting = receiptGatewayRoutingLabel(r);
	return `receipt: ${r.runId} agent=${r.agentId} exit=${r.exitCode}${verification} target=${r.targetId} requested_model_id=${r.wireModelId}${responseModelIdObservation ? ` ${responseModelIdObservation}` : ""}${gatewayRouting ? ` ${gatewayRouting}` : ""} tokens=${r.tokenCount}${reasoning}${failure} start=${r.startedAt} end=${r.endedAt}`;
}
