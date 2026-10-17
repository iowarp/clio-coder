/**
 * Working commands the host proves from a completed task's own receipts.
 *
 * Whether a session kept what it learned used to rest on the lesson model
 * choosing to write an operation. On identical evidence, a session that read a
 * validator, learned its required flag and ran it with exit 0, Ornith kept the
 * recipe in some runs and answered with an empty list in others, and the next
 * session rediscovered the validator step for step. A recipe the receipts
 * already prove needs no model's agreement: the model pass may add lessons,
 * and it never vetoes these.
 *
 * Two rules, each a named fact about the task and nothing about its prompt:
 *
 * - `trap_fix`: the same program on the same repository file failed earlier in
 *   the task, then this command exited 0.
 * - `read_run`: the task read the repository file this command names, and that
 *   file's text contains every option and environment assignment the command
 *   passes, at least one of them.
 *
 * Only one simple invocation qualifies (`simpleInvocation`): no chain, pipe,
 * substitution, comment or background launch, because such a command's exit
 * status does not say which part worked or whether the program finished. The
 * repository file has to be what the command executes, not text it mentions,
 * and a help or version call teaches nothing about running the file.
 */

import { commandChain, commandEvidenceRef, diagnosticInvocation, simpleInvocation } from "./command-evidence.js";
import type { CommandRun, CompletedLessonSource } from "./history-review.js";
import { type ExecutedFile, executedFile, readInsideRoot } from "./lesson-evidence.js";
import { TASK_MEMORY_CONTENT_MAX_CHARS } from "./task-bank.js";

export type RecipeRule = "trap_fix" | "read_run";

export interface ProvenRecipe {
	readonly command: string;
	readonly rule: RecipeRule;
	/** Lesson text; quotes the exact command in backticks, as command evidence requires. */
	readonly content: string;
}

export function provenRecipes(
	source: Pick<CompletedLessonSource, "commandRuns" | "observedReads">,
	root: string,
): ProvenRecipe[] {
	const recipes = new Map<string, ProvenRecipe>();
	const runs = source.commandRuns;
	runs.forEach((run, index) => {
		if (!run.ok || recipes.has(run.command)) return;
		const executed = executedInvocation(run.command, root);
		if (executed === null) return;
		const trap = latestTrap(runs.slice(0, index), executed, root);
		if (trap !== null) {
			recipes.set(run.command, {
				command: run.command,
				rule: "trap_fix",
				content: bounded(
					`Run ${executed.file} as \`${run.command}\`; \`${trap.command}\` failed first: ${trap.diagnostic}`,
				),
			});
			return;
		}
		if (readRunFile(executed, source, root))
			recipes.set(run.command, {
				command: run.command,
				rule: "read_run",
				content: bounded(
					`Run ${executed.file} as \`${run.command}\`; ${executed.file} itself names the options ${executed.options.map((option) => `\`${option}\``).join(" ")}.`,
				),
			});
	});
	return [...recipes.values()];
}

/**
 * A host recipe claims only that its command works here. When another kept
 * claim already carries that command as evidence in different wording, the
 * template adds a second record saying less, so it is not filed; the same
 * template text still is, which is how a later session re-verifies it.
 */
export function recipeAlreadyClaimed(
	recipe: ProvenRecipe,
	kept: ReadonlyArray<{ text: string; evidenceRefs?: readonly string[] }>,
): boolean {
	const ref = commandEvidenceRef(recipe.command);
	const text = recipe.content.replace(/\s+/gu, " ").trim();
	return kept.some(
		(lesson) => lesson.evidenceRefs?.includes(ref) === true && lesson.text.replace(/\s+/gu, " ").trim() !== text,
	);
}

/**
 * The failed command (or, for a pure `&&` chain, any of its segments)
 * executes the same repository file through the same program as a recommended
 * command. This selects advice to show, never evidence, so a chain whose
 * failing segment is unknown may still match on one of them.
 */
export function sharesInvocationTarget(command: string, other: string, root: string): boolean {
	const right = executedInvocation(other, root, false);
	if (right === null) return false;
	const candidates = [command, ...(commandChain(command)?.segments.map((segment) => segment.text) ?? [])];
	return candidates.some((candidate) => {
		const left = executedInvocation(candidate, root, false);
		return left !== null && left.program === right.program && left.file === right.file;
	});
}

/**
 * The file a simple, non-diagnostic invocation executes. A failed trap may be
 * a help call too: `--help` failing still says nothing about the run that
 * worked, so diagnostics are refused on both sides unless the caller only
 * compares targets.
 */
function executedInvocation(command: string, root: string, refuseDiagnostic = true): ExecutedFile | null {
	const invocation = simpleInvocation(command);
	if (invocation === null || (refuseDiagnostic && diagnosticInvocation(invocation))) return null;
	return executedFile(invocation, root);
}

/** The last failed run of the same program on the same file, other than the command itself. */
function latestTrap(earlier: readonly CommandRun[], executed: ExecutedFile, root: string): CommandRun | null {
	for (let index = earlier.length - 1; index >= 0; index--) {
		const run = earlier[index];
		if (run === undefined || run.ok) continue;
		const failed = executedInvocation(run.command, root);
		if (failed !== null && failed.program === executed.program && failed.file === executed.file) return run;
	}
	return null;
}

/** The executed file was read by the task and its text contains every option the command passes. */
function readRunFile(
	executed: ExecutedFile,
	source: Pick<CompletedLessonSource, "observedReads">,
	root: string,
): boolean {
	const options = executed.options;
	if (!options.some((option) => option.startsWith("-") || ENV_ASSIGNMENT.test(option))) return false;
	if (!source.observedReads.has(executed.file)) return false;
	const text = readInsideRoot(root, executed.file);
	if (text === null) return false;
	return options.every((option) => {
		const assignment = ENV_ASSIGNMENT.exec(option);
		return assignment ? text.includes(assignment[1] ?? "") && text.includes(assignment[2] ?? "") : text.includes(option);
	});
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/u;

function bounded(text: string): string {
	const normalized = text.replace(/\s+/gu, " ").trim();
	return normalized.length <= TASK_MEMORY_CONTENT_MAX_CHARS
		? normalized
		: `${normalized.slice(0, TASK_MEMORY_CONTENT_MAX_CHARS - 1).trimEnd()}…`;
}
