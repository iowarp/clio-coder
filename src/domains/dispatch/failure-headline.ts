/**
 * The one line a person reads about a finished worker. Receipts keep the whole
 * detail for `/view`; these sentences are what notices, board rows and cards
 * lead with, because a spawn failure's detail is a flattened Node stack and a
 * contract failure's is the validator's own vocabulary.
 */

const HEADLINE_MAX_CHARS = 140;

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
	vram_capacity_fit_failure: "model did not fit in memory",
	worker_tool_call_cap_exhausted: "hit the tool-call limit",
	worker_context_exhausted: "ran out of context",
	worker_turn_timeout: "timed out",
	worker_output_cap_exhausted: "hit the output limit",
	loop_guard_tools_disabled_exhausted: "stopped by the loop guard",
	result_contract_exhausted: "no valid result",
	result_contract_invalid: "invalid result",
	worker_final_output_missing: "no final answer",
	host_verification_rejected: "host checks failed",
	worker_no_work: "did no work",
	worker_mutation_blocked: "change was blocked",
	merge_withheld: "merge withheld",
	worker_removed_tests: "removed tests",
	information_flow_blocked: "blocked by information flow",
	spawn_failed: "could not start",
	denied_by_policy: "denied by policy",
	timed_out: "timed out",
	canceled: "cancelled",
};

/** A machine outcome or outcome code as words. An unlisted one still reads, with its separators gone. */
export function plainOutcomeLabel(outcome: string): string {
	return OUTCOME_LABELS[outcome] ?? outcome.replace(/_/gu, " ");
}

function clip(text: string): string {
	if (text.length <= HEADLINE_MAX_CHARS) return text;
	const head = text.slice(0, HEADLINE_MAX_CHARS);
	const boundary = head.lastIndexOf(" ");
	return `${boundary > 80 ? head.slice(0, boundary) : head}…`;
}

function stderrHeadline(stderr: string): string {
	const error = /(?:^|\s)(?:[A-Z][A-Za-z]*)?Error: (.+?)(?=\s+at\s|\s+\{\s|$)/u.exec(stderr)?.[1];
	if (error !== undefined) {
		return /worker\/entry/u.test(error) ? `could not start the worker: ${error}` : error;
	}
	const harness = /\[worker\] (.+?)(?=\s+\[worker\]|$)/u.exec(stderr)?.[1];
	return harness ?? stderr;
}

/**
 * The first meaningful clause of a run's failure detail, on one line. Empty or
 * absent detail stays absent so a caller can say nothing rather than invent one.
 */
export function workerFailureHeadline(detail: string | null | undefined): string | null {
	const text = (detail ?? "").replace(/\s+/gu, " ").trim();
	if (text.length === 0) return null;
	const exit = /^(?:exit=\d+ )?(exit code \d+);? ?/u.exec(text);
	const body = (exit === null ? text : text.slice(exit[0].length)).replace(/^permission_required; /u, "");
	if (body.length === 0) return exit?.[1] ?? null;
	if (/^operator abort\b/iu.test(body)) return "cancelled at your request";
	const contract = /result contract failed after (\d+) bounded repair rounds?: (.+)$/iu.exec(body);
	if (contract !== null) {
		const reason = contract[2]?.split(/ failed: /u).at(-1) ?? "";
		return clip(`no valid result after ${contract[1]} repair ${contract[1] === "1" ? "try" : "tries"}: ${reason}`);
	}
	const stderrAt = body.indexOf("stderr: ");
	if (stderrAt < 0) return clip(body);
	const before = body.slice(0, stderrAt).replace(/[;,\s]+$/u, "");
	return clip(before.length > 0 ? before : stderrHeadline(body.slice(stderrAt + "stderr: ".length)));
}
