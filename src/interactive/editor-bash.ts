import { type BashCommandResult, combineBashOutput } from "../core/bash-exec.js";
import type { SessionEntryInput } from "../domains/session/contract.js";

export interface EditorBashCommand {
	command: string;
	excludeFromContext: boolean;
}

export function parseEditorBashCommand(text: string): EditorBashCommand | null {
	if (!text.startsWith("!")) return null;
	const excludeFromContext = text.startsWith("!!");
	const command = (excludeFromContext ? text.slice(2) : text.slice(1)).trim();
	if (command.length === 0) return null;
	return { command, excludeFromContext };
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

export function bashExecutionEntryInput(args: {
	command: string;
	result: BashCommandResult;
	parentTurnId: string | null;
	excludeFromContext: boolean;
	timeoutMs: number;
}): Extract<SessionEntryInput, { kind: "bashExecution" }> {
	const output = appendStatusNotes(combineBashOutput(args.result), args.result, args.timeoutMs);
	return {
		kind: "bashExecution",
		parentTurnId: args.parentTurnId,
		command: args.command,
		output,
		exitCode: args.result.exitCode,
		cancelled: args.result.aborted,
		truncated: args.result.outputCapped,
		excludeFromContext: args.excludeFromContext,
	};
}
