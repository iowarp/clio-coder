import { redactFinalUrlCredentials, redactUrlCredentials } from "../../domains/safety/redaction.js";
import type { AcpAsideAnswer, AcpDraftOutcome } from "./types.js";

export type { AcpAsideAnswer, AcpDraftOutcome } from "./types.js";
export { ACP_ASIDE_ASK_METHOD, ACP_ASIDE_CANCEL_METHOD, ACP_ASIDE_DRAFT_METHOD, ACP_ASIDE_META_KEY } from "./types.js";
/**
 * `_clio-coder/aside/*`: the terminal's `/btw` and `/draft` for an ACP client.
 *
 * Both are rounds beside the session. They read the history the next turn
 * would send, answer the operator, and never become a turn, a session entry or
 * a `session/update`. The host's chat loop runs them, beside a turn in flight
 * over a snapshot of its history (#415); this module only bounds what comes
 * back and labels drafts the way the overlay does, so a client shows the same
 * candidates.
 */

export const ACP_ASIDE_DRAFT_COUNTS = { min: 1, max: 4, default: 3 } as const;
export const ACP_ASIDE_QUESTION_MAX_CHARS = 8_000;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_REASON_BYTES = 1024;
const LABELS = ["A", "B", "C", "D"] as const;

/** The host's two rounds. Each takes the signal `_clio-coder/aside/cancel` aborts. */
export interface AcpAsideControl {
	ask(question: string, signal: AbortSignal): Promise<AcpAsideAnswer>;
	draft(request: string, count: number, signal: AbortSignal): Promise<AcpDraftOutcome>;
}

function clean(text: string, maxBytes: number): { text: string; truncated: boolean } {
	let safe = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		// Newlines and tabs are the answer's own layout; every other control byte is noise.
		safe += code === 0x0a || code === 0x09 || (code > 0x1f && code !== 0x7f) ? character : " ";
	}
	if (Buffer.byteLength(safe, "utf8") <= maxBytes) return { text: safe, truncated: false };
	let cut = safe.slice(0, maxBytes);
	while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
	return { text: cut, truncated: true };
}

// Redacted ahead of the bound, which could cut a password out of the pattern's reach. An aborted round's text stopped short (#446).
const reasonText = (reason: string) => clean(redactUrlCredentials(reason), MAX_REASON_BYTES).text;
const boundedText = (text: string, completed: boolean) =>
	clean(redactFinalUrlCredentials(text, completed), MAX_ANSWER_BYTES);
const ROUND_FAILED = "the model round failed; the agent's diagnostics carry the provider's answer";
export function projectAsideAnswer(answer: AcpAsideAnswer, diagnostics?: (line: string) => void) {
	if (answer.status === "refused") return { status: answer.status, reason: reasonText(answer.reason) };
	if (answer.status === "failed") {
		diagnostics?.(`side question failed: ${reasonText(answer.reason)}`);
		return { status: answer.status, reason: ROUND_FAILED };
	}
	const bounded = boundedText(answer.text, answer.status === "answered");
	return { status: answer.status, text: bounded.text, truncated: bounded.truncated };
}

export function projectDraftOutcome(outcome: AcpDraftOutcome, diagnostics?: (line: string) => void) {
	if (outcome.status === "refused") return { status: "refused" as const, reason: reasonText(outcome.reason) };
	return {
		status: "drafted" as const,
		aborted: outcome.aborted,
		candidates: outcome.candidates.slice(0, LABELS.length).map((candidate, index) => {
			const label = LABELS[index] ?? "A";
			if (candidate.status === "failed") {
				diagnostics?.(`draft ${label} failed: ${reasonText(candidate.reason)}`);
				return { label, status: "failed" as const, reason: ROUND_FAILED };
			}
			const bounded = boundedText(candidate.text, !outcome.aborted);
			return { label, status: "drafted" as const, text: bounded.text, truncated: bounded.truncated };
		}),
	};
}
