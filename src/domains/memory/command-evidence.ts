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
 * Evidence identity (`commandSegments`) is what vouches: one identity per
 * segment of a permitted command, keyed on its argv as an array. Only three
 * rewrites reach it, each leaving what ran unchanged, and no path is ever
 * replaced. A record that carries a `command:` evidence ref names its
 * recommended command by that key; `lessonCommands` in lesson-evidence reads
 * it back, resolving a ref written before the key existed through the same
 * function, and falls back to conservative wording rules for older records.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { commandName, wrappedCommand } from "../../core/command-words.js";
import { sameDirectory, withoutLeadingCdTo } from "../../core/leading-cd.js";
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

/** Whether a lone invocation's program, under any `command` or `builtin` prefix, is a word that refuses a chain. */
function shellControlInvocation(argv: readonly string[]): boolean {
	let index = 0;
	while (argv[index] === "command" || argv[index] === "builtin") {
		index += 1;
		while (argv[index]?.startsWith("-") === true) index += 1;
	}
	const program = argv[index] ?? "";
	return program.startsWith("!") || CHAIN_BREAKING_WORDS.has(program);
}

/** One segment's evidence identity: what ran, as the shell split it, and the key that vouches for it. */
export interface CommandSegment {
	readonly assignments: readonly string[];
	/** The argv after the identity rewrites; nothing else is changed. */
	readonly argv: readonly string[];
	/** The exact text the shell ran for this segment, before any rewrite. */
	readonly text: string;
	/** SHA-256 over the assignments and argv as arrays, so argument boundaries are part of the identity. */
	readonly key: string;
}

/**
 * Evidence identity: every segment one command vouches for, or none.
 *
 * A permitted command is one simple invocation or a pure `&&` chain run from
 * the workspace root; exit 0 proves each segment ran and exited 0, so each is
 * an identity of its own. Everything else yields nothing: pipes, `;`, `||`,
 * `&`, substitution, a `cd` other than one leading `cd` to the root, and a
 * `cwd` that is not the root, because `cd sub && node x.mjs` runs a different
 * `x.mjs` than the one a lesson written at the root names. Without a root
 * neither a leading `cd` nor a `cwd` can be judged, so both refuse.
 *
 * Exactly three rewrites reach the key, each leaving what ran unchanged: the
 * leading `cd <root> &&` or `cd <root>;` is dropped (the shared reader in
 * core/leading-cd.ts, XR-9), `corepack <manager>` is unwrapped, and a package
 * manager's output-only flags are dropped. A path is never replaced.
 */
export function commandSegments(command: string, workspaceRoot?: string, cwd?: string): CommandSegment[] {
	if (!atWorkspaceRoot(workspaceRoot, cwd)) return [];
	const atRoot = withoutLeadingCdTo(command, workspaceRoot);
	const chain = commandChain(atRoot);
	if (chain === null) {
		// One simple invocation is its own receipt even under a word that refuses a chain (`command node x.mjs`), but
		// never one that negates, re-parses, replaces or changes the shell's state: `! a` exits 0 when `a` fails.
		const simple = simpleInvocation(atRoot);
		if (simple === null || shellControlInvocation(simple.argv)) return [];
		const argv = identityArgv(simple.argv);
		const text = withoutHarmlessRedirection(atRoot);
		return [{ assignments: simple.assignments, argv, text, key: segmentKey(simple.assignments, argv) }];
	}
	// The one cd to the root is gone; any cd left moves the rest somewhere a lesson written at the root does not name.
	if (chain.cwd !== null) return [];
	return chain.segments.map((segment) => {
		const argv = identityArgv(segment.argv);
		return { assignments: segment.assignments, argv, text: segment.text, key: segmentKey(segment.assignments, argv) };
	});
}

/** A call's own `cwd` leaves it at the workspace root: absent, empty, or the root itself. */
export function atWorkspaceRoot(workspaceRoot: string | undefined, cwd: string | undefined): boolean {
	if (cwd === undefined || cwd.length === 0) return true;
	return workspaceRoot !== undefined && sameDirectory(resolve(workspaceRoot, cwd), workspaceRoot);
}

/** The identity of a command that must be exactly one segment, as a lesson's recommended command is. */
export function commandSegment(command: string, workspaceRoot?: string, cwd?: string): CommandSegment | null {
	const segments = commandSegments(command, workspaceRoot, cwd);
	return segments.length === 1 ? (segments[0] ?? null) : null;
}

/** Two commands are the same command when each is one segment with the same key. */
export function sameCommandIdentity(left: string, right: string, workspaceRoot?: string): boolean {
	const a = commandSegment(left, workspaceRoot);
	const b = commandSegment(right, workspaceRoot);
	return a !== null && b !== null && a.key === b.key;
}

function segmentKey(assignments: readonly string[], argv: readonly string[]): string {
	return createHash("sha256")
		.update(JSON.stringify([assignments, argv]))
		.digest("hex");
}

/** Package managers `corepack <manager>` runs with the rest of the words unchanged (the finish gate's set, CLI-P24). */
const COREPACK_MANAGERS: ReadonlySet<string> = new Set(["npm", "npx", "pnpm", "yarn"]);
/** Package managers whose output-only flags are dropped from an identity. */
const OUTPUT_FLAG_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
/**
 * Flags that only change what a package manager prints, and those of them that take a value. The same fixed table
 * the finish gate credits check spellings with (`PACKAGE_OUTPUT_FLAGS` in safety/protected-artifacts.ts, 3774e5e13);
 * a change to one is a change to both.
 */
const PACKAGE_OUTPUT_FLAGS: ReadonlySet<string> = new Set(["-s", "--silent", "-q", "--quiet", "--color", "--no-color"]);
const PACKAGE_OUTPUT_VALUE_FLAGS: ReadonlySet<string> = new Set(["--loglevel", "--reporter"]);

function outputFlagWidth(args: readonly string[], index: number): number {
	const arg = args[index];
	if (arg === undefined) return 0;
	if (PACKAGE_OUTPUT_FLAGS.has(arg)) return 1;
	const equals = arg.indexOf("=");
	if (equals > 0) return PACKAGE_OUTPUT_VALUE_FLAGS.has(arg.slice(0, equals)) ? 1 : 0;
	return PACKAGE_OUTPUT_VALUE_FLAGS.has(arg) && args[index + 1] !== undefined ? 2 : 0;
}

/**
 * The two argv rewrites: `corepack <manager>` runs that manager on the same words, and a package manager's
 * output-only flags, where they stand before its command or between `run` and the script, change only what it
 * prints. A flag after the script belongs to the script and is kept.
 */
export function identityArgv(argv: readonly string[]): readonly string[] {
	let words = [...argv];
	if (commandName(words[0] ?? "") === "corepack" && COREPACK_MANAGERS.has(words[1] ?? "")) words = words.slice(1);
	if (!OUTPUT_FLAG_MANAGERS.has(commandName(words[0] ?? ""))) return words;
	const kept = [words[0] ?? ""];
	let index = 1;
	for (let width = outputFlagWidth(words, index); width > 0; width = outputFlagWidth(words, index)) index += width;
	if (words[index] === "run") {
		kept.push("run");
		index += 1;
		for (let width = outputFlagWidth(words, index); width > 0; width = outputFlagWidth(words, index)) index += width;
	}
	return [...kept, ...words.slice(index)];
}

/**
 * A claim on one command. Its key vouches by equality; a claim may instead declare one argument a scratch-path
 * parameter, and then a receipt that holds a path under a scratch root at that position, and is equal everywhere
 * else, matches it. The claim is parametric by its own declaration; the receipt is never rewritten.
 */
export interface CommandClaim {
	readonly assignments: readonly string[];
	readonly argv: readonly string[];
	readonly key: string;
	/** Index into `argv` of the declared scratch-path parameter. */
	readonly scratchParameter?: number;
}

/** Whether one receipt segment vouches for a claim: an equal key, or a match on the claim's declared parameter. */
export function receiptVouches(
	claim: CommandClaim,
	receipt: CommandSegment,
	scratchRoots: readonly string[] = [],
): boolean {
	if (claim.key === receipt.key) return true;
	const at = claim.scratchParameter;
	if (at === undefined || at <= 0 || at >= claim.argv.length) return false;
	if (receipt.argv.length !== claim.argv.length || receipt.assignments.length !== claim.assignments.length) return false;
	if (claim.assignments.some((assignment, index) => receipt.assignments[index] !== assignment)) return false;
	for (let index = 0; index < claim.argv.length; index++) {
		if (index === at) continue;
		if (receipt.argv[index] !== claim.argv[index]) return false;
	}
	// `--dir=<path>` declares the value after its own unchanged prefix.
	const declared = claim.argv[at] ?? "";
	const held = receipt.argv[at] ?? "";
	const equals = declared.startsWith("-") ? declared.indexOf("=") + 1 : 0;
	if (held.slice(0, equals) !== declared.slice(0, equals)) return false;
	return scratchRoots.some((root) => strictlyInside(held.slice(equals), root));
}

function strictlyInside(path: string, root: string): boolean {
	if (!isAbsolute(path) || !isAbsolute(root)) return false;
	const inside = relative(canonicalPath(root), canonicalPath(path));
	return inside.length > 0 && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/**
 * A path with symlinks resolved as far as it exists: the real path of its nearest existing ancestor and the rest
 * unchanged, so `<root>/link/new` under a link out of the root is judged where it lands.
 */
function canonicalPath(path: string): string {
	const absolute = resolve(path);
	const rest: string[] = [];
	for (let current = absolute; ; ) {
		try {
			return join(realpathSync(current), ...rest.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return absolute;
			rest.push(basename(current));
			current = parent;
		}
	}
}

const DIAGNOSTIC_FLAGS: ReadonlySet<string> = new Set(["--help", "-h", "-?", "--version", "-V", "--usage"]);
const DIAGNOSTIC_SUBCOMMANDS: ReadonlySet<string> = new Set(["help", "version"]);

/** A help, usage or version request: it describes a program without exercising what a lesson is about. */
export function diagnosticInvocation(invocation: SimpleInvocation): boolean {
	const args = invocation.argv.slice(1);
	return args.some((arg) => DIAGNOSTIC_FLAGS.has(arg)) || DIAGNOSTIC_SUBCOMMANDS.has(args[0] ?? "");
}

/** Programs that exit 0 whatever the repository holds, so their success proves nothing a lesson could claim. */
const TRIVIAL_PROGRAMS: ReadonlySet<string> = new Set([
	"echo",
	"printf",
	"true",
	":",
	"ls",
	"cat",
	"pwd",
	"cd",
	"which",
	"type",
	"date",
	"sleep",
]);
/** `test` operators whose result depends on a file. */
const TEST_FILE_OPERATORS: ReadonlySet<string> = new Set(["-e", "-f", "-d", "-r", "-w", "-x", "-s", "-L", "-h"]);

/**
 * A command whose exit 0 could not have been a failure, so it cannot be
 * evidence. A wrapper that exits with the status of the command it runs
 * (`env FOO=1 true`, `timeout 5 true`) is judged by that command, help and
 * version requests included; a wrapper form the host cannot read with
 * certainty names no program, so it is no evidence either. xargs is never
 * evidence: whether it runs its command at all depends on its input.
 */
export function trivialInvocation(invocation: SimpleInvocation): boolean {
	let argv = invocation.argv;
	for (let depth = 0; ; depth++) {
		const inner = wrappedCommand(argv);
		if (inner === undefined) break;
		// xargs runs its command once, or not at all, depending on its input.
		if (inner === null || inner.length === 0 || depth >= 8 || commandName(argv[0] ?? "") === "xargs") return true;
		argv = inner;
		if (diagnosticInvocation({ assignments: [], argv })) return true;
	}
	const program = commandName(argv[0] ?? "");
	const args = argv.slice(1);
	if (TRIVIAL_PROGRAMS.has(program)) return true;
	if (program === "test" || program === "[") {
		return !args.some((arg, index) => TEST_FILE_OPERATORS.has(arg) && (args[index + 1] ?? "]") !== "]");
	}
	return false;
}

/** Whitespace-collapsed text: what refs hashed before evidence identity, and what a quoted span is hashed over. */
function collapsedText(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

export const COMMAND_EVIDENCE_REF_PREFIX = "command:";
export const COMMAND_CLAIM_REF_PREFIX = "command-claimed:";

/** The hash a ref carried before evidence identity: 16 hex characters of the whitespace-collapsed text. */
export function legacyCommandHash(command: string): string {
	return createHash("sha256").update(collapsedText(command)).digest("hex").slice(0, 16);
}

/** Whether a ref's hash is a segment key, as opposed to a legacy text hash. */
export function segmentKeyRef(hash: string): boolean {
	return /^[0-9a-f]{64}$/u.test(hash);
}

/**
 * Durable evidence identity for one command, kept apart from the claim's wording: the key of its one segment. A
 * command that is not one segment has no evidence identity and keeps its text hash, which vouches for nothing.
 */
export function commandEvidenceRef(command: string): string {
	return `${COMMAND_EVIDENCE_REF_PREFIX}${commandSegment(command)?.key ?? legacyCommandHash(command)}`;
}

/**
 * The same identity for a command a lesson names but the host has not seen succeed. It grants no evidence; it only
 * lets the gate see that the lesson claims the command, so a rejected one still holds a later rewording.
 */
export function commandClaimRef(command: string): string {
	return `${COMMAND_CLAIM_REF_PREFIX}${commandEvidenceRef(command).slice(COMMAND_EVIDENCE_REF_PREFIX.length)}`;
}

/**
 * A source is a path and the SHA-256 of one quoted span in it, so two quotes in one file are two sources. The span
 * is hashed with its whitespace collapsed, as quotes are compared.
 */
export interface SourceEvidence {
	readonly path: string;
	readonly spanHash: string;
}

function sourceEvidence(path: string, quote: string): SourceEvidence {
	return { path, spanHash: createHash("sha256").update(collapsedText(quote)).digest("hex") };
}

/** Durable evidence identity for one quoted source span. */
export function sourceEvidenceRef(path: string, quote: string): string {
	const source = sourceEvidence(path, quote);
	return `source:${source.path}#${source.spanHash}`;
}

/**
 * A `source:` ref read back, or null. A ref written before the full hash carries the first 16 hex characters of the
 * same digest, so a legacy hash is a prefix of the full one.
 */
export function parseSourceEvidenceRef(ref: string): SourceEvidence | null {
	const match = /^source:(.+)#([0-9a-f]{16}|[0-9a-f]{64})$/u.exec(ref);
	return match === null ? null : { path: match[1] ?? "", spanHash: match[2] ?? "" };
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
