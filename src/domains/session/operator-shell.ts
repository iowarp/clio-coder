/**
 * One operator shell line, run the way the terminal's `!cmd` and `!!cmd` run
 * it. The terminal editor and ACP's `_clio-coder/session/shell` both call this,
 * so the timeout, the sandboxed runner, the information-flow labeling and the
 * recorded entry cannot drift between the two surfaces. Admission (refused
 * while a turn runs, one line at a time) and where the entry is appended stay
 * with each surface, because each owns its own turn and session state.
 */

import {
	type BashCommandProgress,
	type BashCommandResult,
	combineBashOutput,
	runBashCommand,
} from "../../core/bash-exec.js";
import type { SessionEntryInput } from "./contract.js";

export const OPERATOR_SHELL_TIMEOUT_MS = 300_000;

export type OperatorShellEntryInput = Extract<SessionEntryInput, { kind: "bashExecution" }>;

export interface OperatorShellLineInput {
	command: string;
	cwd: string;
	/** `!!cmd`: the output is recorded but never joins the model's context. */
	excludeFromContext: boolean;
	/** The leaf when the line started; the recorded entry stays anchored there. */
	parentTurnId: string | null;
	signal: AbortSignal;
	onUpdate?: (progress: BashCommandProgress) => void;
	/**
	 * Labels the information-flow sources the command names before its output
	 * joins the context, the way a bash tool call is labeled. Returns why the
	 * label could not be recorded, and the output then stays out of context.
	 */
	label?: (command: string, cwd: string) => string | null;
	runBash?: typeof runBashCommand;
}

export interface OperatorShellLineRun {
	result: BashCommandResult;
	entry: OperatorShellEntryInput;
	/** Why output the operator meant to share was kept out of context, or null. */
	unlabeled: string | null;
}

export async function runOperatorShellLine(input: OperatorShellLineInput): Promise<OperatorShellLineRun> {
	const result = await (input.runBash ?? runBashCommand)(input.command, {
		cwd: input.cwd,
		timeoutMs: OPERATOR_SHELL_TIMEOUT_MS,
		signal: input.signal,
		...(input.onUpdate ? { onUpdate: input.onUpdate } : {}),
	});
	const unlabeled = input.excludeFromContext ? null : (input.label?.(input.command, input.cwd) ?? null);
	return {
		result,
		unlabeled,
		entry: {
			kind: "bashExecution",
			parentTurnId: input.parentTurnId,
			command: input.command,
			output: appendStatusNotes(combineBashOutput(result), result, OPERATOR_SHELL_TIMEOUT_MS),
			exitCode: result.exitCode,
			cancelled: result.aborted,
			truncated: result.outputCapped,
			excludeFromContext: input.excludeFromContext || unlabeled !== null,
		},
	};
}

function appendStatusNotes(output: string, result: BashCommandResult, timeoutMs: number): string {
	const notes: string[] = [];
	if (result.aborted) notes.push("command aborted");
	if (result.timedOut) notes.push(`command timed out after ${timeoutMs}ms`);
	if (result.outputCapped) notes.push("command output exceeded the inline output limit");
	if (result.error && output.trim().length === 0) notes.push(result.error.message);
	if (notes.length === 0) return output;
	const suffix = notes.map((note) => `[${note}]`).join("\n");
	return output.length > 0 ? `${output.replace(/\s+$/g, "")}\n${suffix}` : suffix;
}
