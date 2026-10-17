/**
 * What one shell receipt can vouch for.
 *
 * A successful shell call proves that its exact command string exited 0. It
 * proves nothing about a program the string only mentions: `echo 'node x.mjs'`,
 * `true # node x.mjs` and `node x.mjs &` all succeed without `node x.mjs`
 * finishing. So a receipt counts for a program only when the command is one
 * simple invocation the strict argv reader accepts (no operators, comments,
 * substitution or background launch), and a lesson's command is satisfied
 * only by a receipt for that same complete command.
 *
 * A record that carries a `command:` evidence ref names its recommended
 * command by this module's identity; `lessonCommands` in lesson-evidence reads
 * it back and falls back to conservative wording rules for older records.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { shellLikeChain, shellLikeInvocation } from "../../core/shell-argv.js";

export interface SimpleInvocation {
	readonly assignments: readonly string[];
	readonly argv: readonly string[];
}

/** Trailing redirections that cannot change whether the program itself ran and exited 0. */
const HARMLESS_REDIRECTION = /\s+(?:[12]?>&[12]|[12]?>\s*\/dev\/null|&>\s*\/dev\/null)\s*$/u;

function withoutHarmlessRedirection(command: string): string {
	let text = command.trim();
	for (let pass = 0; pass < 3; pass++) {
		const next = text.replace(HARMLESS_REDIRECTION, "");
		if (next === text) break;
		text = next;
	}
	return text;
}

/** One simple command with literal argv, or null for anything whose exit status speaks for more than one program. */
export function simpleInvocation(command: string): SimpleInvocation | null {
	const text = withoutHarmlessRedirection(command);
	if (text.length === 0 || /[\r\n]/u.test(text)) return null;
	const parsed = shellLikeInvocation(text, { rejectComments: true, allowAssignments: true });
	return parsed instanceof Error ? null : parsed;
}

export interface CommandChain {
	/** Each simple command in order, with the exact text the shell ran for it. */
	readonly segments: ReadonlyArray<SimpleInvocation & { readonly text: string }>;
	/** The directory a leading `cd` moved to before the rest ran, or null. */
	readonly cwd: string | null;
}

/**
 * Words that make one segment's success say something about the segments
 * after it, or that the shell parses on its own terms: a changed directory or
 * environment, an early exit (`exit 0 && b` never runs `b`), negation,
 * keywords and compound commands. A chain containing one is not read.
 * `builtin` and `command` run any of these under another name
 * (`builtin cd sub && node x.mjs`), so they refuse the chain too.
 */
const CHAIN_BREAKING_WORDS: ReadonlySet<string> = new Set([
	"builtin",
	"command",
	"cd",
	"pushd",
	"popd",
	"export",
	"unset",
	"set",
	"shopt",
	"source",
	".",
	"eval",
	"exec",
	"exit",
	"return",
	"alias",
	"unalias",
	"declare",
	"typeset",
	"local",
	"readonly",
	"let",
	"trap",
	"ulimit",
	"umask",
	"!",
	"[[",
	"((",
	"{",
	"}",
	"time",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"function",
	"select",
	"coproc",
]);

/**
 * A pure `&&` chain of simple commands, or null. Exit 0 from `a && b` proves
 * `a` and then `b` each ran to completion and exited 0, in the same directory
 * and environment, so each segment is a receipt of its own. One leading
 * `cd <path>` is kept as the chain's directory for the caller to judge;
 * every other state-changing word refuses the chain. `;`, `||`, pipes and
 * `&` stay refused: their exit status does not say which part ran.
 */
export function commandChain(command: string): CommandChain | null {
	const text = withoutHarmlessRedirection(command);
	if (text.length === 0 || /[\r\n]/u.test(text)) return null;
	const parsed = shellLikeChain(text, { rejectComments: true, allowAssignments: true });
	if (parsed instanceof Error || parsed.length === 0) return null;
	let cwd: string | null = null;
	const segments: Array<SimpleInvocation & { readonly text: string }> = [];
	for (const [index, segment] of parsed.entries()) {
		const program = segment.argv[0] ?? "";
		if (index === 0 && program === "cd" && segment.argv.length === 2 && segment.assignments.length === 0) {
			cwd = segment.argv[1] ?? null;
			continue;
		}
		if (CHAIN_BREAKING_WORDS.has(program) || program.startsWith("!")) return null;
		segments.push({
			assignments: segment.assignments,
			argv: segment.argv,
			text: withoutHarmlessRedirection(segment.text),
		});
	}
	return segments.length === 0 ? null : { segments, cwd };
}

/**
 * Every command one successful shell receipt vouches for: the command itself,
 * and each segment of a pure `&&` chain. A chain that first changed directory
 * counts only when that directory is the workspace root itself, because a
 * lesson's command is written relative to the root and `cd sub && node x.mjs`
 * runs a different `x.mjs`. The same holds for a call given its own `cwd`:
 * one that is not the root vouches for nothing, not even its exact text.
 */
export function succeededCommandForms(command: string, root: string, cwd?: string): string[] {
	if (cwd !== undefined && cwd.length > 0 && !sameDirectory(resolve(root, cwd), root)) return [];
	const forms = new Set<string>([command]);
	const chain = commandChain(command);
	if (chain === null) return [...forms];
	if (chain.segments.length === 1 && chain.cwd === null) return [...forms];
	if (chain.cwd !== null && !sameDirectory(resolve(root, chain.cwd), root)) return [...forms];
	for (const segment of chain.segments) forms.add(segment.text);
	return [...forms];
}

function sameDirectory(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false; /* A directory that does not exist is not the root. */
	}
}

const DIAGNOSTIC_FLAGS: ReadonlySet<string> = new Set(["--help", "-h", "-?", "--version", "-V", "--usage"]);
const DIAGNOSTIC_SUBCOMMANDS: ReadonlySet<string> = new Set(["help", "version"]);

/** A help, usage or version request: it describes a program without exercising what a lesson is about. */
export function diagnosticInvocation(invocation: SimpleInvocation): boolean {
	const args = invocation.argv.slice(1);
	return args.some((arg) => DIAGNOSTIC_FLAGS.has(arg)) || DIAGNOSTIC_SUBCOMMANDS.has(args[0] ?? "");
}

/** Whitespace-collapsed identity; lessons store commands with collapsed whitespace. */
function commandIdentity(command: string): string {
	return command.replace(/\s+/gu, " ").trim();
}

export function sameCommand(left: string, right: string): boolean {
	return commandIdentity(left) === commandIdentity(right);
}

export const COMMAND_EVIDENCE_REF_PREFIX = "command:";

/** Durable evidence identity for one exact command, kept apart from the claim's wording. */
export function commandEvidenceRef(command: string): string {
	return `${COMMAND_EVIDENCE_REF_PREFIX}${createHash("sha256").update(commandIdentity(command)).digest("hex").slice(0, 16)}`;
}

/** Durable evidence identity for one quoted source span. */
export function sourceEvidenceRef(path: string, quote: string): string {
	return `source:${path}#${createHash("sha256").update(commandIdentity(quote)).digest("hex").slice(0, 16)}`;
}

/**
 * The shell tool's own success receipt: an ok result that reported success and
 * exit 0. Direct calls and settled gateway chain children are judged by this
 * one rule; the caller supplies whether the call itself settled ok.
 */
export function successfulShellReceipt(settledOk: boolean, details: unknown): boolean {
	if (!settledOk || details === null || typeof details !== "object" || Array.isArray(details)) return false;
	const receipt = details as Record<string, unknown>;
	return (
		(receipt.kind === undefined || receipt.kind === "ok") && receipt.outcome === "success" && receipt.exitCode === 0
	);
}
