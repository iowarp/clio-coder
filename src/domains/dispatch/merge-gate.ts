import { taskCommitSubject } from "../../core/commit-message.js";
import type { RunAssurance } from "../../core/telemetry/run-vocabulary.js";
import { isTestFilePath } from "../../core/test-paths.js";
import type { ResultContract } from "../agents/result-contract.js";
import { mutationReportChecks, mutationReportFailures } from "../agents/result-contract.js";

/**
 * Whether a failed run's task worktree is committed to its branch as a partial
 * result. A worker stopped at its tool-call cap often stops mid-change, and one
 * whose report says it did not finish changed only part of what it was asked;
 * their edits are neither merged nor left as loose files, so the host commits
 * them on the preserved branch for the dispatcher to review, continue or land. A run that timed out (its wall clock,
 * fleet M8) stopped mid-change the same way.
 */
export function preservesPartialResult(
	outcomeCode: string | null,
	hasTaskWorktree: boolean,
	outcome?: string | null,
): boolean {
	return (
		hasTaskWorktree &&
		(outcome === "timed_out" || outcomeCode === "worker_tool_call_cap_exhausted" || outcomeCode === "worker_partial_work")
	);
}

/**
 * The commit message for a task worktree: the worker's own commitMessage, else its
 * summary, else its task. A partial result never takes the worker's words, which
 * either claim the change ("fix: ...") or report the failure ("Could not finish
 * everything"); its subject marks it partial over the task it was given.
 */
export function taskWorktreeCommitMessage(input: {
	task: string;
	partial: boolean;
	commitMessage?: string | null;
	summary?: string | null;
}): string | null {
	if (input.partial) {
		const subject = taskCommitSubject(input.task);
		return subject === null ? null : `partial: ${subject}`;
	}
	return input.commitMessage ?? taskCommitSubject(input.summary ?? null) ?? taskCommitSubject(input.task);
}

/** The failure detail suffix naming where a preserved partial result is and how to land it. */
export function partialResultDetail(branch: string): string {
	return `its partial work is committed, unmerged on ${branch}; review or continue it there, \`clio-coder fleet land ${branch}\` previews the merge and \`clio-coder fleet land ${branch} --yes\` lands it`;
}

const DECLARED_CHECK_DETAIL_MAX_CHARS = 120;

export interface MergeGateInput {
	/** The run's assurance (DESIGN 4.8): the one verdict value the gate reads. */
	assurance: RunAssurance;
	contract: ResultContract | null;
	/** The worker's captured final answer, read only for its typed fields. */
	output: string | null;
	branch: string;
	/** Test cases or test files the task branch removed against its base, from `removedTestCases`. */
	removedTests?: ReadonlyArray<string>;
	/** Checks this run executed that failed on its final tree, from its typed validations. */
	failedChecks?: ReadonlyArray<string>;
}

/**
 * Why a compromised result is not trusted, in the words every surface shows: the merge gate's withheld reason and
 * the grader's `assurance` rule both read it, so the card, the receipt and the envelope name one cause.
 */
export function compromisedReason(
	contract: ResultContract | null,
	output: string | null,
	failedChecks: ReadonlyArray<string> = [],
): string {
	return compromisedVerdict(contract, output, failedChecks).reason;
}

function compromisedVerdict(
	contract: ResultContract | null,
	output: string | null,
	failedChecks: ReadonlyArray<string>,
): MergeGateVerdict {
	const listed = (names: ReadonlyArray<string>): string => {
		const named = names.slice(0, 3).map(boundedCheck).join("; ");
		return `${named}${names.length > 3 ? `; and ${names.length - 3} more` : ""}`;
	};
	const failed = mutationReportFailures(contract, output);
	const already = "if that failure was already there";
	if (failed.length > 0)
		return { reason: `the worker's own report lists a failing validation (${listed(failed)})`, appliesWhen: already };
	if (failedChecks.length > 0)
		return {
			reason: `a check this run executed failed on its final tree (${listed(failedChecks)})`,
			appliesWhen: already,
		};
	return {
		reason: "its result is not trusted: a validation it claims was never observed or failed",
		appliesWhen: "once a check backs the change",
	};
}

/** A line that declares one test case, across the common frameworks. */
const TEST_DECLARATION =
	/^\s*(?:(?:test|it|describe|specify|context)(?:\.(?:only|skip|each|todo|concurrent|serial|failing))*\s*[(`]|(?:describe|it|context)\s+["']|(?:async\s+)?def\s+test_|func\s+Test\w*\s*\(|fn\s+test_|@Test\b|\[(?:Fact|Test|TestMethod)\]|(?:public\s+)?void\s+test\w*\s*\()/u;
/** Rust keeps its tests inline in source files, so this applies to any `.rs` path. */
const RUST_TEST_ATTRIBUTE = /^\s*#\[(?:[\w:]+::)?test\b/u;
const REMOVED_TESTS_MAX_ENTRIES = 50;
const DIFF_FILE_HEADER = /^diff --git a\/.+ b\/(.+)$/u;

function declaresTest(path: string, line: string): boolean {
	if (path.endsWith(".rs") && RUST_TEST_ATTRIBUTE.test(line)) return true;
	return isTestFilePath(path) && TEST_DECLARATION.test(line);
}

function declarationKey(line: string): string {
	const named = /^(test|it|specify)(?:\.\w+)*\s*\(\s*(["'`])((?:\\.|(?!\2).)*)\2/u.exec(line);
	if (named !== null) return `${named[1]}(${JSON.stringify(named[3])})`;
	const functionName = /^(?:(?:async\s+)?def|func|fn|(?:public\s+)?void)\s+(\w+)/u.exec(line);
	if (functionName !== null) return functionName[1] ?? line;
	return line
		.replace(/(["'])(.*?)\1/gu, (_match, _quote: string, body: string) => JSON.stringify(body))
		.replace(/\s+(?=(?:[^"\\]*"[^"\\]*")*[^"\\]*$)/gu, "")
		.replace(/;$/u, "");
}

/**
 * Compare declarations across the entire diff so moving a test between files
 * does not withhold a merge. Suite headings and snapshots are not test cases.
 * A declaration split by a formatter is ambiguous, so allow that match rather
 * than requiring the operator to merge a formatting-only change manually.
 */
export function removedTestCases(diff: string): string[] {
	const removed: Array<{ path: string; line: string; deleted: boolean }> = [];
	const added: string[] = [];
	let path = "";
	let inHeader = false;
	let deletedFile = false;
	for (const line of diff.split("\n")) {
		const header = DIFF_FILE_HEADER.exec(line);
		if (header !== null) {
			path = header[1] ?? "";
			inHeader = true;
			deletedFile = false;
			continue;
		}
		if (path === "" || /(?:^|\/)__snapshots__\/|\.snap(?:\.|$)/u.test(path)) continue;
		if (inHeader) {
			if (line.startsWith("deleted file mode")) deletedFile = true;
			else if (line.startsWith("@@")) inHeader = false;
			continue;
		}
		if (!line.startsWith("-") && !line.startsWith("+")) continue;
		const text = line.slice(1).trim();
		if (!declaresTest(path, text) || /^(?:describe|context)\b/u.test(text)) continue;
		if (line.startsWith("-")) removed.push({ path, line: text, deleted: deletedFile });
		else added.push(declarationKey(text));
	}
	const entries = new Set<string>();
	for (const item of removed) {
		const key = declarationKey(item.line);
		let match = added.indexOf(key);
		if (match < 0) {
			match = added.findIndex((candidate) =>
				/^(?:test|it|specify)(?:\.\w+)*\($/u.test(candidate)
					? key.startsWith(candidate)
					: /^(?:test|it|specify)(?:\.\w+)*\($/u.test(key) && candidate.startsWith(key),
			);
		}
		if (match >= 0) added.splice(match, 1);
		else entries.add(item.deleted ? `${item.path} (file removed)` : `${item.path}: ${item.line}`);
	}
	return [...entries].slice(0, REMOVED_TESTS_MAX_ENTRIES);
}

export function boundedCheck(check: string): string {
	// Worker prose lands in a receipt detail and a terminal line, so control
	// characters collapse to spaces and the length is capped.
	const flat = check.replace(/[\p{Cc}\s]+/gu, " ").trim();
	return flat.length <= DECLARED_CHECK_DETAIL_MAX_CHARS
		? flat
		: `${flat.slice(0, DECLARED_CHECK_DETAIL_MAX_CHARS - 1)}…`;
}

/** Why a merge is held and the condition under which the preserved branch is still safe to merge. */
export interface MergeGateVerdict {
	/** The failing or unrun check, as a clause: what the operator is being asked to overlook. */
	reason: string;
	/** Completes "`clio-coder fleet land <branch> --yes` lands it ...". */
	appliesWhen: string;
}

const TASK_CLAUSE_SPLIT = /[.;\n,]|\b(?:and|but|then)\b/iu;

const TEST_REMOVAL_REQUEST =
	/\b(?:delete|remove|drop|retire|prune)\b(?:(?!\b(?:so|until|making|make|that|which|because)\b)[^.\n]){0,60}\b(?:tests?|specs?|test\s+(?:cases?|files?|suites?))\b/iu;
const TEST_REMOVAL_NEGATION = /\b(?:do\s+not|don['’]t|never|without)\s+(?:delete|remove|drop|retire|prune)\b/iu;

/**
 * True when a clause of the task asks for tests to be removed ("delete the
 * obsolete totalDuration test"), so a diff that removes test cases did what was
 * asked (flywheel F-D1). "Do not delete tests" does not count.
 */
export function taskRequestsTestRemoval(task: string): boolean {
	return task
		.split(TASK_CLAUSE_SPLIT)
		.some((clause) => !TEST_REMOVAL_NEGATION.test(clause) && TEST_REMOVAL_REQUEST.test(clause));
}

/**
 * Decide whether a succeeded merge-mode task worktree is kept off the operator's branch. Returns the verdict when it
 * is withheld, null when it may merge. It reads the run's assurance, never the task's or the report's prose: a
 * compromised result is held (a failing check the worker's own report lists lowers assurance even when the host's
 * declared checks passed), a grounded or reviewed one merges, and an unverified one merges unless its typed report
 * names a check the host did not run. A diff that removes existing test cases is held whatever the assurance, because
 * a passing suite says nothing about a test that is gone.
 */
export function mergeGateVerdict(input: MergeGateInput): MergeGateVerdict | null {
	const removedTests = input.removedTests ?? [];
	if (removedTests.length > 0) {
		const shown = removedTests.slice(0, 2).map(boundedCheck).join("; ");
		const more = removedTests.length > 2 ? `; and ${removedTests.length - 2} more` : "";
		return {
			reason: `the diff removes existing test cases (${shown}${more})`,
			appliesWhen: "if removing those tests was intended",
		};
	}
	if (input.assurance === "compromised")
		return compromisedVerdict(input.contract, input.output, input.failedChecks ?? []);
	if (input.assurance === "grounded" || input.assurance === "reviewed" || input.contract === null) return null;
	const first = mutationReportChecks(input.contract, input.output).declaredChecks[0];
	if (first === undefined) return null;
	return {
		reason: `the worker asked for a check the host did not run (${boundedCheck(first)})`,
		appliesWhen: "once that check passes",
	};
}

/** The receipt detail for a withheld merge, or null when the merge may proceed. */
export function mergeWithheldDetail(input: MergeGateInput): string | null {
	const verdict = mergeGateVerdict(input);
	if (verdict === null) return null;
	return `merge withheld: ${verdict.reason}; its work is committed on the preserved branch ${input.branch}, \`clio-coder fleet land ${input.branch}\` previews the merge and \`clio-coder fleet land ${input.branch} --yes\` lands it ${verdict.appliesWhen}`;
}
