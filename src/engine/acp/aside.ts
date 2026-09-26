/**
 * `_clio-coder/aside/*`: the terminal's `/btw` and `/draft` for an ACP client.
 *
 * Both are rounds beside the session. They read the history the next turn
 * would send, answer the operator, and never become a turn, a session entry or
 * a `session/update`. The host's chat loop runs them and refuses while a turn
 * is in flight; this module only bounds what comes back and labels drafts the
 * way the overlay does, so a client shows the same candidates and verdict.
 */

export const ACP_ASIDE_META_KEY = "clio-coder/aside";
export const ACP_ASIDE_ASK_METHOD = "_clio-coder/aside/ask";
export const ACP_ASIDE_DRAFT_METHOD = "_clio-coder/aside/draft";
export const ACP_ASIDE_CANCEL_METHOD = "_clio-coder/aside/cancel";
export const ACP_ASIDE_DRAFT_COUNTS = { min: 1, max: 4, default: 3 } as const;
export const ACP_ASIDE_QUESTION_MAX_CHARS = 8_000;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_REASON_BYTES = 1024;
const LABELS = ["A", "B", "C", "D"] as const;

export type AcpAsideAnswer =
	| { status: "answered"; text: string }
	| { status: "aborted"; text: string }
	| { status: "refused"; reason: string }
	| { status: "failed"; reason: string };

export interface AcpDraftVerdict {
	picked: string | null;
	probabilities: Partial<Record<string, number>>;
	sound: Partial<Record<string, boolean | null>>;
	source: string;
	elapsedMs: number;
}

export type AcpDraftOutcome =
	| {
			status: "drafted";
			aborted: boolean;
			candidates: ReadonlyArray<{ status: "drafted"; text: string } | { status: "failed"; reason: string }>;
			/** Absent when the rounds were aborted before a judgment was asked for. */
			judgment?: { verdict: AcpDraftVerdict } | { reason: string };
	  }
	| { status: "refused"; reason: string };

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

const reasonText = (reason: string) => clean(reason, MAX_REASON_BYTES).text;
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const ROUND_FAILED = "the model round failed; the agent's diagnostics carry the provider's answer";
const JUDGMENT_UNAVAILABLE = "not judged: the model round did not produce a judgment; inspect the agent's diagnostics";
/** Exact process-authored outcomes; any other judgment reason can contain provider prose. */
const SAFE_JUDGMENT_REASONS = new Set([
	"not judged: settings are not loaded",
	"not judged: bind fleet.decisionProfiles.drafts to a System One profile",
	"not judged: cancelled",
	"not judged: a draft failed or came back empty",
	"not judged: fewer than 2 drafts to compare",
]);

export function projectAsideAnswer(answer: AcpAsideAnswer, diagnostics?: (line: string) => void) {
	if (answer.status === "refused") return { status: answer.status, reason: reasonText(answer.reason) };
	if (answer.status === "failed") {
		diagnostics?.(`side question failed: ${reasonText(answer.reason)}`);
		return { status: answer.status, reason: ROUND_FAILED };
	}
	const bounded = clean(answer.text, MAX_ANSWER_BYTES);
	return { status: answer.status, text: bounded.text, truncated: bounded.truncated };
}

export function projectDraftOutcome(outcome: AcpDraftOutcome, diagnostics?: (line: string) => void) {
	if (outcome.status === "refused") return { status: "refused" as const, reason: reasonText(outcome.reason) };
	const labels = LABELS.slice(0, outcome.candidates.length);
	const pick = <T>(record: Partial<Record<string, T>>, read: (value: T | undefined) => T) =>
		Object.fromEntries(labels.map((label) => [label, read(record[label])]));
	const judgment = outcome.judgment;
	let judgmentReason: string | undefined;
	if (judgment !== undefined && "reason" in judgment) {
		if (SAFE_JUDGMENT_REASONS.has(judgment.reason)) judgmentReason = judgment.reason;
		else {
			diagnostics?.(`draft judgment unavailable: ${reasonText(judgment.reason)}`);
			judgmentReason = JUDGMENT_UNAVAILABLE;
		}
	}
	return {
		status: "drafted" as const,
		aborted: outcome.aborted,
		candidates: outcome.candidates.slice(0, LABELS.length).map((candidate, index) => {
			const label = LABELS[index] ?? "A";
			if (candidate.status === "failed") {
				diagnostics?.(`draft ${label} failed: ${reasonText(candidate.reason)}`);
				return { label, status: "failed" as const, reason: ROUND_FAILED };
			}
			const bounded = clean(candidate.text, MAX_ANSWER_BYTES);
			return { label, status: "drafted" as const, text: bounded.text, truncated: bounded.truncated };
		}),
		...(judgment === undefined
			? {}
			: {
					judgment:
						"verdict" in judgment
							? {
									status: "judged" as const,
									picked: labels.find((label) => label === judgment.verdict.picked) ?? null,
									probabilities: pick(judgment.verdict.probabilities, (value) => Math.max(0, finite(value))),
									sound: pick(judgment.verdict.sound, (value) => (typeof value === "boolean" ? value : null)),
									source: reasonText(judgment.verdict.source),
									elapsedMs: Math.max(0, Math.round(finite(judgment.verdict.elapsedMs))),
								}
							: { status: "unjudged" as const, reason: judgmentReason ?? JUDGMENT_UNAVAILABLE },
				}),
	};
}
