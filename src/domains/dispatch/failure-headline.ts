/**
 * The one line a person reads about a finished worker. Receipts keep the whole
 * detail for `/view`; these sentences are what notices, board rows and cards
 * lead with, because a spawn failure's detail is a flattened Node stack and a
 * contract failure's is the validator's own vocabulary.
 */

const HEADLINE_MAX_CHARS = 140;

/**
 * Why a stalled run ended. Its receipt names the kill signal and the output the
 * kill cut short, which are what stopping a silent worker costs, not why it stopped.
 */
export const STALLED_RUN_HEADLINE = "stopped responding, so Clio stopped it";

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
	vram_capacity_fit_failure: "model did not fit in memory",
	worker_tool_call_cap_exhausted: "hit the tool-call limit",
	worker_context_exhausted: "ran out of context",
	worker_turn_timeout: "timed out",
	worker_output_cap_exhausted: "hit the output limit",
	loop_guard_tools_disabled_exhausted: "stopped for repeating calls",
	result_contract_exhausted: "no usable answer",
	result_contract_invalid: "answer in the wrong format",
	worker_final_output_missing: "no final answer",
	host_verification_rejected: "Clio's checks failed",
	worker_no_work: "did no work",
	worker_mutation_blocked: "change was blocked",
	merge_withheld: "merge withheld",
	worker_removed_tests: "removed tests",
	information_flow_blocked: "route not allowed for this data",
	spawn_failed: "could not start",
	denied_by_policy: "denied by policy",
	stalled: "stopped responding",
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
 * A recorded failure reason in the words a person acts on. Each pattern is a detail the dispatch runtime records
 * verbatim for `/view` and the run's receipt; the row a person reads says what happened to their task instead of
 * naming the validator, the repair loop or the loop guard that produced it.
 */
const PLAIN_FAILURES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
	[/^operator abort\b/iu, () => "cancelled at your request"],
	// The worker's final reply held only tool calls after its tools were taken away, so there is no answer to show.
	[
		/result contract failed after \d+ bounded repair rounds?: .*(?:tool-call lockout|tool-call markup)/iu,
		() => "it gave no usable answer: it kept calling tools after they were turned off",
	],
	[
		/result contract failed after \d+ bounded repair rounds?: /iu,
		() => "its answer was not in the format Clio asked for",
	],
	[
		/^(?:\[worker\] )?synthesis lock\b/iu,
		() => "it gave no usable answer: it kept calling tools after they were turned off",
	],
	[
		/^the (operator|main agent|safety judge) denied (?:the worker's permission request|(\d+) of the worker's permission requests)/iu,
		(match) =>
			`${match[1] === "operator" ? "you" : `the ${match[1]}`} denied ${match[2] === undefined ? "its permission request" : `${match[2]} of its permission requests`}, so it changed nothing`,
	],
	[
		/^nobody answered (?:the worker's permission request|(\d+) of the worker's permission requests) in time/iu,
		(match) =>
			`nobody answered ${match[1] === undefined ? "its permission request" : `${match[1]} of its permission requests`} in time, so it changed nothing`,
	],
	[
		/^worker recorded a limitation and changed nothing, so the assignment was not done(?:: (.+))?$/iu,
		(match) =>
			match[1] === undefined
				? "it changed nothing and reported it could not do the task"
				: `it changed nothing and reported: ${match[1]}`,
	],
	// The response limit is the worker response setting, so the row names that limit and its value.
	[
		/^worker_turn_timeout: round \d+ exceeded the (\d+) second response limit/iu,
		(match) => `its model gave no complete reply within the ${match[1]}s worker response limit`,
	],
	[/^worker executed no tools, so it did none of its assignment/iu, () => "it ran no tools, so the task was not done"],
	[
		/^permission denied by policy: (\S+) raised an operator-authority ask and no operator can answer worker asks/iu,
		(match) => `its ${match[1]} call needed your approval, and this run had no way to ask you, so the call did not run`,
	],
];

function plainFailure(body: string): string | null {
	for (const [pattern, words] of PLAIN_FAILURES) {
		const match = pattern.exec(body);
		if (match !== null) return words(match);
	}
	return null;
}

/**
 * The first meaningful clause of a run's failure detail, on one line, in plain words. Empty or absent detail stays
 * absent so a caller can say nothing rather than invent one.
 */
export function workerFailureHeadline(detail: string | null | undefined): string | null {
	const text = (detail ?? "").replace(/\s+/gu, " ").trim();
	if (text.length === 0) return null;
	const exit = /^(?:exit=\d+ )?(exit code \d+);? ?/u.exec(text);
	const body = (exit === null ? text : text.slice(exit[0].length)).replace(/^permission_required; /u, "");
	if (body.length === 0) return exit === null ? null : "the worker stopped with an error before it gave an answer";
	const plain = plainFailure(body);
	if (plain !== null) return clip(plain);
	const stderrAt = body.indexOf("stderr: ");
	if (stderrAt < 0) return clip(body);
	const before = body.slice(0, stderrAt).replace(/[;,\s]+$/u, "");
	if (before.length > 0) return clip(plainFailure(before) ?? before);
	const fromStderr = stderrHeadline(body.slice(stderrAt + "stderr: ".length));
	return clip(plainFailure(fromStderr) ?? fromStderr);
}
