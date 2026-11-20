/**
 * Confirmation for commands that act (CLI convention C8). `--yes`/`-y` skips
 * the question. Without a terminal and without `--yes` the command does not
 * act and exits 2 `confirmation_required`; a declined question exits 1
 * `declined`. `--json` never changes whether a command acts, and `--force`
 * is never a confirmation flag.
 *
 * The question is asked on stderr so stdout stays the command's document.
 * Leaf of the CLI kit: imports only node builtins and other kit modules.
 */
import { createInterface } from "node:readline/promises";
import { EXIT_CODES } from "./exit-codes.js";

export type ConfirmOutcome =
	| { readonly proceed: true }
	| { readonly proceed: false; readonly slug: "confirmation_required"; readonly exitCode: typeof EXIT_CODES.notStarted }
	| { readonly proceed: false; readonly slug: "declined"; readonly exitCode: typeof EXIT_CODES.failed };

export interface ConfirmOptions {
	/** The question without its answer hint, such as `Remove session 1a2b?`. */
	readonly question: string;
	/** `--yes` or `-y` was given. */
	readonly yes: boolean;
	/** A person can answer; defaults to stdin and stderr both being terminals. */
	readonly interactive?: boolean;
	/** Reads one answer; defaults to a readline prompt on stdin and stderr. */
	readonly ask?: (prompt: string) => Promise<string>;
}

async function askOnTerminal(prompt: string): Promise<string> {
	const reader = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return await reader.question(prompt);
	} finally {
		reader.close();
	}
}

export async function confirmAction(options: ConfirmOptions): Promise<ConfirmOutcome> {
	if (options.yes) return { proceed: true };
	const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
	if (!interactive) return { proceed: false, slug: "confirmation_required", exitCode: EXIT_CODES.notStarted };
	const answer = await (options.ask ?? askOnTerminal)(`${options.question} [y/N] `);
	return /^y(?:es)?$/iu.test(answer.trim())
		? { proceed: true }
		: { proceed: false, slug: "declined", exitCode: EXIT_CODES.failed };
}
