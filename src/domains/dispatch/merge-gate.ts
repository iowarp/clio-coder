import type { ResultContract } from "../agents/result-contract.js";
import { mutationReportChecks } from "../agents/result-contract.js";

const DECLARED_CHECK_DETAIL_MAX_CHARS = 120;

export interface MergeGateInput {
	/** Quality sealed on the receipt's result contract fact, if any. */
	quality: string | undefined;
	/** Host verification status, undefined when no check was configured. */
	hostStatus: string | undefined;
	contract: ResultContract | null;
	/** The worker's captured final answer. */
	output: string | null;
	branch: string;
	task?: string;
	executedCheckingCalls?: number;
	/** Test cases or test files the task branch removed against its base, from `removedTestCases`. */
	removedTests?: ReadonlyArray<string>;
}

const TEST_DIR = /(?:^|\/)(?:[Tt]ests?|__tests__|specs?)\//u;
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|swift|scala|exs?|php|c|cc|cpp|sh|bats)$/u;
const TEST_FILE_NAME =
	/\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs|rb|exs?)$|(?:^|\/)test_[^/]*\.py$|(?:Test|Tests|Spec)\.(?:java|kt|cs|swift|scala)$/u;
/** A line that declares one test case, across the common frameworks. */
const TEST_DECLARATION =
	/^\s*(?:(?:test|it|describe|specify|context)(?:\.(?:only|skip|each|todo|concurrent|serial|failing))*\s*[(`]|(?:describe|it|context)\s+["']|(?:async\s+)?def\s+test_|func\s+Test\w*\s*\(|fn\s+test_|@Test\b|\[(?:Fact|Test|TestMethod)\]|(?:public\s+)?void\s+test\w*\s*\()/u;
/** Rust keeps its tests inline in source files, so this applies to any `.rs` path. */
const RUST_TEST_ATTRIBUTE = /^\s*#\[(?:[\w:]+::)?test\b/u;
const REMOVED_TESTS_MAX_ENTRIES = 50;
const DIFF_FILE_HEADER = /^diff --git a\/.+ b\/(.+)$/u;

function isTestFilePath(path: string): boolean {
	return TEST_FILE_NAME.test(path) || (TEST_DIR.test(path) && CODE_EXTENSION.test(path));
}

function declaresTest(path: string, line: string): boolean {
	if (path.endsWith(".rs") && RUST_TEST_ATTRIBUTE.test(line)) return true;
	return isTestFilePath(path) && TEST_DECLARATION.test(line);
}

/**
 * Test cases and test files a zero-context unified diff removes. A declaration
 * line counts as removed only when no identical line is added in the same file,
 * so a moved or reformatted test is not flagged while a replaced one is. A task
 * told to leave a test alone once deleted it to get green, and the passing
 * suite hid it (flywheel p6/U3). Entries read `path: declaration line` or
 * `path (file removed)`, capped so a mass deletion stays cheap to report.
 */
export function removedTestCases(diff: string): string[] {
	const entries: string[] = [];
	let path = "";
	let inHeader = false;
	let deletedFile = false;
	let removed: string[] = [];
	let added = new Map<string, number>();
	const flush = (): void => {
		if (path === "") return;
		if (deletedFile) {
			if (isTestFilePath(path)) entries.push(`${path} (file removed)`);
		} else {
			for (const line of removed) {
				const left = added.get(line) ?? 0;
				if (left > 0) added.set(line, left - 1);
				else entries.push(`${path}: ${line}`);
			}
		}
		path = "";
		deletedFile = false;
		removed = [];
		added = new Map();
	};
	for (const line of diff.split("\n")) {
		if (entries.length >= REMOVED_TESTS_MAX_ENTRIES) break;
		const header = DIFF_FILE_HEADER.exec(line);
		if (header !== null) {
			flush();
			path = header[1] ?? "";
			inHeader = true;
			continue;
		}
		if (path === "") continue;
		if (inHeader) {
			if (line.startsWith("deleted file mode")) deletedFile = true;
			else if (line.startsWith("@@")) inHeader = false;
			continue;
		}
		if (line.startsWith("@@")) continue;
		const text = line.slice(1).trim();
		if (line.startsWith("-") && declaresTest(path, line.slice(1))) removed.push(text);
		else if (line.startsWith("+")) added.set(text, (added.get(text) ?? 0) + 1);
	}
	flush();
	return entries.slice(0, REMOVED_TESTS_MAX_ENTRIES);
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
	/** Completes "`git merge <branch>` applies it ...". */
	appliesWhen: string;
}

const TASK_CLAUSE_SPLIT = /[.;\n,]|\b(?:and|but|then)\b/iu;
const VALIDATION_OPT_OUT =
	/\b(?:do\s+not|don['’]t|never|skip|without|no\s+need\s+to|need\s+not)\b|\bnot\s+(?:required|needed|necessary)\b/iu;
const VALIDATION_REQUEST =
	/\b(?:run|runs|running|execute|validate|verify|test)\b[^.\n]{0,100}\b(?:tests?|checks?|validation|npm|pnpm|pytest|vitest|jest|tsc|lint|typecheck)\b/iu;

function taskRequestsValidation(task: string): boolean {
	return task
		.split(TASK_CLAUSE_SPLIT)
		.some((clause) => !VALIDATION_OPT_OUT.test(clause) && VALIDATION_REQUEST.test(clause));
}

/**
 * True when a clause of the task tells the worker not to validate. A check the
 * worker then reports as not run honored that instruction, so it is not a
 * reason to hold the merge (flywheel p7/A2).
 */
function taskOptsOutOfValidation(task: string): boolean {
	return task
		.split(TASK_CLAUSE_SPLIT)
		.some((clause) => VALIDATION_OPT_OUT.test(clause) && VALIDATION_REQUEST.test(clause));
}

/**
 * Decide whether a succeeded merge-mode task worktree is kept off the
 * operator's branch. Returns the verdict when it is withheld, null when it may
 * merge. Three cases withhold: a report listing a failing validation, a report
 * that asked for a check it did not run (`declaredChecks`) without any passing
 * validation, and a diff that removes existing test cases. The first two yield
 * to passing host verification (the second merged a left-pad change onto a red
 * main, flywheel 31jukrioe38d). The third does not, because a passing suite
 * says nothing about a test that is gone.
 */
export function mergeGateVerdict(input: MergeGateInput): MergeGateVerdict | null {
	// Ahead of the host-verified exit: a suite that passes proves nothing about
	// a test the worker deleted, so only the operator can accept the removal.
	const removedTests = input.removedTests ?? [];
	if (removedTests.length > 0) {
		const shown = removedTests.slice(0, 2).map(boundedCheck).join("; ");
		const more = removedTests.length > 2 ? `; and ${removedTests.length - 2} more` : "";
		return {
			reason: `the diff removes existing test cases (${shown}${more})`,
			appliesWhen: "if removing those tests was intended",
		};
	}
	if (input.hostStatus === "verified") return null;
	if (input.quality === "fail") {
		return {
			reason: "the worker's own report lists a failing validation",
			appliesWhen: "if that failure was already there",
		};
	}
	if (input.executedCheckingCalls === 0 && input.task !== undefined && taskRequestsValidation(input.task)) {
		return {
			reason: "the task requested validation but the worker executed no check",
			appliesWhen: "once the requested validation passes",
		};
	}
	if (input.contract === null) return null;
	const reported = mutationReportChecks(input.contract, input.output);
	const first = reported.declaredChecks[0];
	if (first === undefined || reported.validationPassed) return null;
	if (input.task !== undefined && taskOptsOutOfValidation(input.task)) return null;
	return {
		reason: `the worker asked for a check the host did not run (${boundedCheck(first)})`,
		appliesWhen: "once that check passes",
	};
}

/** The receipt detail for a withheld merge, or null when the merge may proceed. */
export function mergeWithheldDetail(input: MergeGateInput): string | null {
	const verdict = mergeGateVerdict(input);
	if (verdict === null) return null;
	return `merge withheld: ${verdict.reason}; its work is committed on the preserved branch ${input.branch}, and \`git merge ${input.branch}\` applies it ${verdict.appliesWhen}`;
}
