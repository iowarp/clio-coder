/**
 * The host-side evidence check for a repository lesson.
 *
 * A lesson is a model's claim. It earns a `held` observation, which is what
 * lets the durable store's gate approve it without an operator, only when the
 * host can bind it to something it observed itself:
 *
 * - command evidence: a command the shell tool reported succeeding with exit
 *   0 whose evidence identity (`commandSegments`) equals the lesson's own
 *   command, quoted whole in the lesson text; or
 * - source evidence: a quote the lesson text contains, found in the excerpt
 *   of a successful read result for that repository-relative path that the
 *   reviewed activity actually showed the model, and still present in the
 *   file at that path in the current checkout. A read of one range cannot
 *   vouch for text elsewhere in the file, and today's file cannot vouch for
 *   text no read ever showed.
 *
 * Model confidence, wording, or a path the agent never read is never evidence.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
	COMMAND_CLAIM_REF_PREFIX,
	COMMAND_EVIDENCE_REF_PREFIX,
	type CommandSegment,
	commandSegment,
	commandSegments,
	diagnosticInvocation,
	identityArgv,
	legacyCommandHash,
	receiptVouches,
	type SimpleInvocation,
	segmentKeyRef,
	simpleInvocation,
	trivialInvocation,
} from "./command-evidence.js";
import type { TaskMemoryEntry } from "./task-bank.js";

export type LessonEvidenceKind = "command" | "source";

export interface LessonEvidenceInput {
	/** Commands the shell tool reported succeeding, byte for byte, each already admitted from the workspace root. */
	succeededCommands: ReadonlySet<string>;
	/**
	 * Repository-relative POSIX path to the bounded, redacted excerpts of its
	 * successful read results, exactly as the reviewed activity rendered them.
	 */
	observedReads: ReadonlyMap<string, ReadonlyArray<string>>;
	/** Checkout the quote is verified against: the current session's workspace root. */
	workspaceRoot: string;
}

/** Files larger than this are not scanned for a quote. */
const SOURCE_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;

export function lessonEvidence(entry: TaskMemoryEntry, input: LessonEvidenceInput): LessonEvidenceKind | null {
	if (entry.durable !== true) return null;
	const claim = entry.evidenceCommand === undefined ? null : commandSegment(entry.evidenceCommand, input.workspaceRoot);
	if (
		claim !== null &&
		entry.evidenceCommand !== undefined &&
		// A compound, commented or background command exits 0 without proving
		// the program it names finished, a help call exercises nothing, and
		// `echo ok` could not have failed.
		simpleEvidenceCommand(entry.evidenceCommand) &&
		// The text has to make the same claim the evidence supports: the exact
		// command, delimited, so `node a.mjs --quick` does not vouch for `--full`.
		entry.content.includes(`\`${entry.evidenceCommand}\``) &&
		receiptsVouch(claim, input.succeededCommands, input.workspaceRoot)
	) {
		return "command";
	}
	const source = entry.evidenceSource;
	if (source === undefined) return null;
	const path = repositoryRelativePath(source.path, [input.workspaceRoot]);
	if (path === null) return null;
	const quote = collapse(source.quote);
	if (quote.length === 0 || !collapse(entry.content).includes(quote)) return null;
	const observed = input.observedReads.get(path) ?? [];
	if (!observed.some((snippet) => collapse(snippet).includes(quote))) return null;
	const content = readInsideRoot(input.workspaceRoot, path);
	return content !== null && collapse(content).includes(quote) ? "source" : null;
}

function simpleEvidenceCommand(command: string): boolean {
	const invocation = simpleInvocation(command);
	return invocation !== null && !diagnosticInvocation(invocation) && !trivialInvocation(invocation);
}

/** One of the succeeded commands has a segment that vouches for the claim; nothing else is consulted. */
function receiptsVouch(claim: CommandSegment, succeeded: ReadonlySet<string>, root: string): boolean {
	for (const command of succeeded)
		for (const segment of commandSegments(command, root)) if (receiptVouches(claim, segment)) return true;
	return false;
}

/** Whether a `relative()` result leaves its root; a child named `..x` stays inside. */
function escapesRoot(inside: string): boolean {
	return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
}

/**
 * A path as the repository names it: relative, POSIX-separated, inside one of
 * the given roots. An absolute path under a root is made relative to it; a
 * path that escapes every root is null.
 */
export function repositoryRelativePath(path: string, roots: ReadonlyArray<string>): string | null {
	const trimmed = path.trim();
	if (trimmed.length === 0) return null;
	let candidate: string | null = null;
	if (isAbsolute(trimmed)) {
		for (const root of roots) {
			const inside = relative(resolve(root), resolve(trimmed));
			if (inside.length > 0 && !escapesRoot(inside)) {
				candidate = inside;
				break;
			}
		}
	} else {
		candidate = trimmed;
	}
	if (candidate === null) return null;
	const normalized = posix.normalize(candidate.split(sep).join("/")).replace(/^\.\/+/u, "");
	if (normalized.length === 0 || normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
	return normalized;
}

export function readInsideRoot(root: string, path: string): string | null {
	try {
		const realRoot = realpathSync(root);
		const target = realpathSync(resolve(realRoot, path));
		const inside = relative(realRoot, target);
		if (inside.length === 0 || escapesRoot(inside)) return null;
		const info = statSync(target);
		if (!info.isFile() || info.size > SOURCE_EVIDENCE_MAX_BYTES) return null;
		return readFileSync(target, "utf8");
	} catch {
		// A file that is gone or unreadable in this checkout supports nothing here.
		return null;
	}
}

/** Excerpts remembered per path; the newest replace the oldest. */
const OBSERVED_SNIPPETS_PER_PATH = 4;
/** Paths remembered per reviewed scope. */
const OBSERVED_PATH_LIMIT = 256;

/** Record one excerpt a successful read showed the model, bounded per path and per scope. */
export function recordObservedRead(observed: Map<string, string[]>, path: string, snippet: string): void {
	if (snippet.trim().length === 0) return;
	const snippets = observed.get(path) ?? [];
	observed.delete(path);
	snippets.push(snippet);
	if (snippets.length > OBSERVED_SNIPPETS_PER_PATH) snippets.splice(0, snippets.length - OBSERVED_SNIPPETS_PER_PATH);
	observed.set(path, snippets);
	if (observed.size > OBSERVED_PATH_LIMIT) {
		const oldest = observed.keys().next().value;
		if (oldest !== undefined) observed.delete(oldest);
	}
}

/**
 * What a lesson is about, read from its own text alone. A lesson kept on
 * command evidence quotes its exact command in backticks, so a backticked span
 * with more than one word is a command; a single backticked word is a name.
 * Paths and environment variables are the other handles an operator searches
 * by. No model reads this, and nothing outside the text is consulted.
 */
export interface LessonSubject {
	readonly commands: readonly string[];
	readonly paths: readonly string[];
	readonly envVars: readonly string[];
}

export function lessonSubject(text: string): LessonSubject {
	const spans = backtickedSpans(text);
	// A span that opens with a flag (`--mode native`) is part of a command, not one.
	const commands = unique(spans.filter((span) => /\s/u.test(span) && !span.startsWith("-")));
	const prose = text.replace(/`[^`\n]*`/gu, " ");
	const pathLike = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?$|^[\w@-]+\.[a-z][a-z0-9]{0,5}$/iu;
	const paths = unique([
		...spans.filter((span) => !/\s/u.test(span) && pathLike.test(span)),
		...[...prose.matchAll(/(?:^|[\s(])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+)/gu)].map((match) => match[1] ?? ""),
		...commands.flatMap((command) => command.split(/\s+/u).filter((word) => pathLike.test(word))),
	]).filter(Boolean);
	// Assigned (`NAME=value`), expanded (`$NAME`) or named as one; an all-caps error code is neither.
	const envVars = unique(
		[
			...text.matchAll(
				/\b([A-Z][A-Z0-9_]{2,})=|\$\{?([A-Z][A-Z0-9_]{2,})|environment variable\s+`?([A-Z][A-Z0-9_]{2,})/gu,
			),
		].map((match) => match[1] ?? match[2] ?? match[3] ?? ""),
	);
	return { commands, paths, envVars };
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function backtickedSpans(text: string): string[] {
	return [...text.matchAll(/`([^`\n]+)`/gu)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
}

/**
 * The evidence keys a record's `command:` and `command-claimed:` refs name. A ref written before segment keys
 * hashed the command's text; it is resolved by finding the quoted span with that hash and running the span through
 * `commandSegment`, the same function every new ref comes from, so a rejection recorded under an old ref still
 * meets a rewording under a new one. A legacy ref no quoted span resolves stays its own hash, equal only to itself.
 */
export function commandRefKeys(text: string, refs: readonly string[]): Set<string> {
	const keys = new Set<string>();
	let spans: string[] | null = null;
	for (const ref of refs) {
		const hash = ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX)
			? ref.slice(COMMAND_EVIDENCE_REF_PREFIX.length)
			: ref.startsWith(COMMAND_CLAIM_REF_PREFIX)
				? ref.slice(COMMAND_CLAIM_REF_PREFIX.length)
				: null;
		if (hash === null) continue;
		if (segmentKeyRef(hash)) {
			keys.add(hash);
			continue;
		}
		spans ??= backtickedSpans(text);
		const span = spans.find((candidate) => legacyCommandHash(candidate) === hash);
		keys.add((span === undefined ? undefined : commandSegment(span)?.key) ?? `legacy:${hash}`);
	}
	return keys;
}

function collapse(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/**
 * Lessons quote commands in backticks, and not every quoted command is advice:
 * a recipe names the command that failed first, and a `--help` call explains a
 * tool without exercising it. A record's `command:` evidence ref names the
 * recommended command exactly; without one, a command is advice unless its
 * own clause says it failed or rules it out.
 */
export interface LessonCommands {
	/** Commands the lesson tells a session to run. */
	readonly recommended: readonly string[];
	/** Failed examples, prohibitions and help/version calls the text quotes for contrast. */
	readonly examples: readonly string[];
}

/**
 * Wording that, right after a quoted command, says it failed. Read only up to
 * the end of the clause, so `run \`a\`; \`b\` failed` marks only `b`.
 */
const FAILED_AFTER =
	/^\s*(?:fail(?:s|ed|ing)?|errors?|errored|crash(?:es|ed)?|exits? (?:non-?zero|[1-9])|is broken|does(?: not|n['’]t) work|hangs?)\b/iu;
/** Wording that, right before a quoted command, rules it out. */
const PROHIBITED_BEFORE =
	/\b(?:not|never|avoid|instead of|rather than|don['’]t(?: run| use)?|do not(?: run| use)?|stop|without)\s*$/iu;

export function lessonCommands(text: string, evidenceRefs: readonly string[] = [], root?: string): LessonCommands {
	const spans = lessonSubject(text).commands.filter((span) => realCommand(span, root));
	const declared = commandRefKeys(
		text,
		evidenceRefs.filter((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX)),
	);
	const recommended: string[] = [];
	const examples: string[] = [];
	for (const span of spans) {
		const invocation = simpleInvocation(span);
		const diagnostic = invocation !== null && diagnosticInvocation(invocation);
		const key = commandSegment(span)?.key;
		const advised =
			declared.size > 0 ? key !== undefined && declared.has(key) : !diagnostic && !contrastedSpan(text, span);
		(advised && !diagnostic ? recommended : examples).push(span);
	}
	return { recommended, examples };
}

/** Runners a lesson may name though the host running the check lacks them on `PATH`. */
const KNOWN_RUNNERS: ReadonlySet<string> = new Set([
	"npm",
	"npx",
	"pnpm",
	"pnpx",
	"yarn",
	"bunx",
	"corepack",
	"pip",
	"pip3",
	"uv",
	"uvx",
	"poetry",
	"pipenv",
	"pytest",
	"cargo",
	"go",
	"make",
	"cmake",
	"ninja",
	"mvn",
	"gradle",
	"java",
	"bundle",
	"rake",
	"dotnet",
	"git",
	"docker",
]);
const SCRIPT_PATH = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*$/u;
/** Whether a bare word names an executable on `PATH`, remembered per word; the answer cannot widen what vouches. */
const pathPrograms = new Map<string, boolean>();
const PATH_PROGRAMS_REMEMBERED = 256;

/**
 * A backticked span is a command only when it parses as one simple invocation and its first word resolves to a
 * program on `PATH`, a repository script or a known runner; `const x = 1` parses, and is not one. Without a root a
 * path-shaped first word is taken as a script it cannot check. This is a delivery-time check: it drops a span that
 * is certainly not a command and proves nothing about a subcommand, a flag or the claim.
 */
function realCommand(span: string, root?: string): boolean {
	const invocation = simpleInvocation(span);
	if (invocation === null) return false;
	return programResolves(identityArgv(invocation.argv)[0] ?? "", root);
}

/**
 * Whether a command's first word, after the identity rewrites, resolves to a program on `PATH`, a repository script or
 * a known runner. Delivery checks a kept lesson's command by this word: it withholds a lesson that is certainly dead
 * and proves nothing about a subcommand, a flag or the claim.
 */
export function programResolves(word: string, root?: string): boolean {
	if (word.length === 0) return false;
	if (word.includes("/")) {
		if (isAbsolute(word)) return executableFile(word);
		return root === undefined ? SCRIPT_PATH.test(word) : repositoryFile(word, root) !== null;
	}
	if (KNOWN_RUNNERS.has(word) || INTERPRETERS.has(word)) return true;
	return onPath(word);
}

function onPath(word: string): boolean {
	const known = pathPrograms.get(word);
	if (known !== undefined) return known;
	const found = (process.env.PATH ?? "")
		.split(delimiter)
		.some((dir) => dir.length > 0 && executableFile(join(dir, word)));
	if (pathPrograms.size >= PATH_PROGRAMS_REMEMBERED) pathPrograms.delete(pathPrograms.keys().next().value ?? word);
	pathPrograms.set(word, found);
	return found;
}

function executableFile(path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		const info = statSync(path);
		return info.isFile() && (info.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function contrastedSpan(text: string, span: string): boolean {
	const quoted = `\`${span}\``;
	for (let at = text.indexOf(quoted); at >= 0; at = text.indexOf(quoted, at + 1)) {
		const before =
			text
				.slice(Math.max(0, at - 40), at)
				.split(/[.;:!?]/u)
				.at(-1) ?? "";
		const after = text.slice(at + quoted.length, at + quoted.length + 48).split(/[.;,!?]/u)[0] ?? "";
		if (FAILED_AFTER.test(after) || PROHIBITED_BEFORE.test(before)) return true;
	}
	return false;
}

/** Programs that run the script named by their first repository-file argument. */
const INTERPRETERS: ReadonlySet<string> = new Set([
	"node",
	"nodejs",
	"python",
	"python3",
	"bash",
	"sh",
	"zsh",
	"ruby",
	"perl",
	"deno",
	"bun",
	"tsx",
	"ts-node",
	"php",
	"Rscript",
	"julia",
	"lua",
	"pwsh",
]);
/** Words that launch the program after them unchanged. */
const LAUNCHERS: ReadonlyArray<readonly string[]> = [
	["npx"],
	["env"],
	["pnpm", "exec"],
	["uv", "run"],
	["poetry", "run"],
	["pipenv", "run"],
	["bundle", "exec"],
];

export interface ExecutedFile {
	/** The executing program: the file itself, or the interpreter that runs it. */
	readonly program: string;
	/** Repository-relative path of the file the command executes. */
	readonly file: string;
	/** Every argument after the executed file, plus environment assignments. */
	readonly options: readonly string[];
}

/**
 * The repository file one simple invocation actually executes, or null. Naming
 * a file is not running it: `cat x.mjs` and `echo node x.mjs` mention a file
 * that never ran, so the file has to be the program itself or the script an
 * interpreter was asked to run.
 */
export function executedFile(invocation: SimpleInvocation, root: string): ExecutedFile | null {
	const argv = withoutLaunchers(invocation.argv);
	const program = argv[0];
	if (program === undefined) return null;
	const direct = repositoryFile(program, root);
	if (direct !== null) return { program: direct, file: direct, options: [...invocation.assignments, ...argv.slice(1)] };
	if (!INTERPRETERS.has(basename(program))) return null;
	for (let index = 1; index < argv.length; index++) {
		const word = argv[index] ?? "";
		if (word.startsWith("-")) continue;
		const file = repositoryFile(word, root);
		if (file !== null)
			return { program: basename(program), file, options: [...invocation.assignments, ...argv.slice(index + 1)] };
	}
	return null;
}

/** The repository-relative path of an existing file inside the checkout, or null. */
function repositoryFile(token: string, root: string): string | null {
	const path = repositoryRelativePath(token, [root]);
	return path !== null && readInsideRoot(root, path) !== null ? path : null;
}

function withoutLaunchers(words: readonly string[]): string[] {
	let argv = [...words];
	for (let changed = true; changed; ) {
		changed = false;
		for (const launcher of LAUNCHERS) {
			if (argv.length > launcher.length && launcher.every((word, index) => argv[index] === word)) {
				argv = argv.slice(launcher.length);
				while (argv[0]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[0] ?? "")) argv.shift();
				changed = true;
			}
		}
	}
	return argv;
}

/**
 * Search key, never evidence: the program, its subcommand and the script it runs. It finds candidate claims for a
 * failed call; equal subjects vouch for nothing, since `node x.mjs --a` and `node x.mjs --b` share one.
 */
export interface CommandSubject {
	readonly program: string;
	readonly subcommand?: string;
	readonly script?: string;
	/** The existing repository file the command executes, resolved only when a root was given. */
	readonly file?: string;
	readonly key: string;
}

export function commandSubject(argv: readonly string[], root?: string): CommandSubject | null {
	const words = identityArgv(argv);
	const executed = root === undefined ? null : executedFile({ assignments: [], argv: words }, root);
	if (executed !== null) return subjectOf(executed.program, undefined, executed.file, executed.file);
	const [program, ...rest] = withoutLaunchers(words);
	if (program === undefined || program.length === 0) return null;
	const name = basename(program);
	const operands = rest.filter((word) => !word.startsWith("-"));
	if (INTERPRETERS.has(name)) return subjectOf(name, undefined, operands[0], undefined);
	const subcommand = operands[0];
	return subjectOf(name, subcommand, subcommand === "run" ? operands[1] : undefined, undefined);
}

function subjectOf(
	program: string,
	subcommand: string | undefined,
	script: string | undefined,
	file: string | undefined,
): CommandSubject {
	return {
		program,
		...(subcommand !== undefined ? { subcommand } : {}),
		...(script !== undefined ? { script } : {}),
		...(file !== undefined ? { file } : {}),
		key: JSON.stringify([program, subcommand ?? "", script ?? ""]),
	};
}
