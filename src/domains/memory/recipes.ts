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
 * Only a single invocation qualifies: no `&&`, `||`, `;`, pipe, or command
 * substitution, because a chain's exit status does not say which part worked.
 */

import type { CommandRun, CompletedLessonSource } from "./history-review.js";
import { readInsideRoot, repositoryRelativePath } from "./lesson-evidence.js";
import { TASK_MEMORY_CONTENT_MAX_CHARS } from "./task-bank.js";

export type RecipeRule = "trap_fix" | "read_run";

export interface ProvenRecipe {
	readonly command: string;
	readonly rule: RecipeRule;
	/** Lesson text; quotes the exact command in backticks, as command evidence requires. */
	readonly content: string;
}

interface Invocation {
	readonly program: string;
	/** Repository-relative paths of existing files the command names. */
	readonly files: readonly string[];
	/** Every other argument and environment assignment, in order. */
	readonly options: readonly string[];
}

export function provenRecipes(
	source: Pick<CompletedLessonSource, "commandRuns" | "observedReads">,
	root: string,
): ProvenRecipe[] {
	const recipes = new Map<string, ProvenRecipe>();
	const runs = source.commandRuns;
	runs.forEach((run, index) => {
		if (!run.ok || recipes.has(run.command)) return;
		const invocation = parseInvocation(run.command, root);
		if (invocation === null || invocation.files.length === 0) return;
		const file = invocation.files[0] ?? "";
		const trap = latestTrap(runs.slice(0, index), invocation, root);
		if (trap !== null) {
			recipes.set(run.command, {
				command: run.command,
				rule: "trap_fix",
				content: bounded(`Run ${file} as \`${run.command}\`; \`${trap.command}\` failed first: ${trap.diagnostic}`),
			});
			return;
		}
		const named = readRunFile(invocation, source, root);
		if (named !== null)
			recipes.set(run.command, {
				command: run.command,
				rule: "read_run",
				content: bounded(
					`Run ${named} as \`${run.command}\`; ${named} itself names the options ${invocation.options.map((option) => `\`${option}\``).join(" ")}.`,
				),
			});
	});
	return [...recipes.values()];
}

/** Both commands run the same program on at least one of the same repository files. */
export function sharesInvocationTarget(command: string, other: string, root: string): boolean {
	const left = parseInvocation(command, root);
	const right = parseInvocation(other, root);
	return (
		left !== null &&
		right !== null &&
		left.program === right.program &&
		left.files.some((file) => right.files.includes(file))
	);
}

/** The last failed run of the same program on one of the same files, other than the command itself. */
function latestTrap(earlier: readonly CommandRun[], invocation: Invocation, root: string): CommandRun | null {
	for (let index = earlier.length - 1; index >= 0; index--) {
		const run = earlier[index];
		if (run === undefined || run.ok) continue;
		const failed = parseInvocation(run.command, root, { requireFiles: false });
		if (
			failed !== null &&
			failed.program === invocation.program &&
			failed.files.some((file) => invocation.files.includes(file))
		)
			return run;
	}
	return null;
}

/** A file the task read that names the command and contains all of its options. */
function readRunFile(
	invocation: Invocation,
	source: Pick<CompletedLessonSource, "observedReads">,
	root: string,
): string | null {
	const options = invocation.options.filter((option) => !REDIRECTION.test(option));
	if (!options.some((option) => option.startsWith("-") || ENV_ASSIGNMENT.test(option))) return null;
	for (const file of invocation.files) {
		if (!source.observedReads.has(file)) continue;
		const text = readInsideRoot(root, file);
		if (text === null) continue;
		const present = options.every((option) => {
			const assignment = ENV_ASSIGNMENT.exec(option);
			return assignment ? text.includes(assignment[1] ?? "") && text.includes(assignment[2] ?? "") : text.includes(option);
		});
		if (present) return file;
	}
	return null;
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/u;
const REDIRECTION = /^\d?>>?(?:&\d|\/dev\/null)?$|^\d?>&\d$/u;
const CONTROL = /&&|\|\||[;|`]|\$\(/u;

function parseInvocation(command: string, root: string, options = { requireFiles: true }): Invocation | null {
	if (CONTROL.test(command) || /[\r\n]/u.test(command)) return null;
	const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(
		(match) => match[1] ?? match[2] ?? match[3] ?? "",
	);
	const env: string[] = [];
	while (tokens.length > 0 && ENV_ASSIGNMENT.test(tokens[0] ?? "")) env.push(tokens.shift() ?? "");
	const program = tokens.shift();
	if (program === undefined) return null;
	const files: string[] = [];
	const rest: string[] = [...env];
	const programFile = repositoryFile(program, root);
	if (programFile !== null) files.push(programFile);
	for (const token of tokens) {
		const file = token.startsWith("-") ? null : repositoryFile(token, root);
		if (file !== null) files.push(file);
		else rest.push(token);
	}
	if (options.requireFiles && files.length === 0) return null;
	return { program: programFile ?? program, files, options: rest };
}

/** The repository-relative path of an existing file inside the checkout, or null. */
function repositoryFile(token: string, root: string): string | null {
	const path = repositoryRelativePath(token, [root]);
	return path !== null && readInsideRoot(root, path) !== null ? path : null;
}

function bounded(text: string): string {
	const normalized = text.replace(/\s+/gu, " ").trim();
	return normalized.length <= TASK_MEMORY_CONTENT_MAX_CHARS
		? normalized
		: `${normalized.slice(0, TASK_MEMORY_CONTENT_MAX_CHARS - 1).trimEnd()}…`;
}
