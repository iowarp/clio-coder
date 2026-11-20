import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import { canonicalizeExistingPath, canonicalizeRawPath } from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import { isVerificationScriptName, isWriteCapableScriptName } from "../../core/verification-scripts.js";
import { isSameOrDescendant } from "./path-policy.js";

export type ProtectedArtifactSource = "validation" | "middleware" | "user" | "session";

export interface ProtectedArtifact {
	path: string;
	protectedAt: string;
	reason: string;
	validationCommand?: string;
	validationExitCode?: number;
	source: ProtectedArtifactSource;
}

export interface ProtectedArtifactState {
	artifacts: ProtectedArtifact[];
}

export type DestructiveCommandOperation =
	| "rm"
	| "mv"
	| "truncate"
	| "redirect"
	| "cp"
	| "git_checkout"
	| "git_restore"
	| "git_reset_hard"
	| "find_delete";

export interface ProtectedArtifactCommandMatch {
	artifactPath: string;
	commandPath: string;
	reason: string;
}

export type DestructiveCommandClassification =
	| { kind: "benign"; matches: [] }
	| {
			kind: "destructive";
			operation: DestructiveCommandOperation;
			matches: ProtectedArtifactCommandMatch[];
	  };

export type ValidationCommandDetection = { kind: "validation"; matched: string } | { kind: "none" };

/**
 * Which vocabulary of checking commands a caller wants recognized.
 *
 * `finish-contract` is the strict set: commands that assert something about
 * correctness and fail loudly when it does not hold. It is the default because
 * the consumers that spend it are gates. The finish contract counts a match as
 * a validating turn, and the mutation-report validator counts one as the
 * difference between `pass` and `unmeasured`. A turn whose only command was
 * `git diff` has validated nothing, so admitting read-verification here would
 * hand both gates a way to be satisfied by inspection alone.
 *
 * `grounding` is the wider set: everything strict plus the read-verification
 * and ad-hoc shapes agents actually reach for (`git diff`, `node -e`,
 * `npx vitest`, `tsc --noEmit`). Its consumer, dispatch validation grounding,
 * spends a match on nothing. An unmatched claim there is reported and never
 * downgrades a quality label, so the cost of a miss is noise in the receipt
 * rather than a gate opening. Commands such as `git diff` and
 * `node -e "import(...)"` can ground inspection claims even when they do not
 * satisfy the strict validation vocabulary.
 */
export type ValidationCommandScope = "finish-contract" | "grounding";

interface NormalizedArtifact {
	key: string;
	artifact: ProtectedArtifact;
}

// `(` and `)` open and close a subshell or group; each side starts a new command.
const COMMAND_SEPARATORS = new Set([";", "&", "&&", "||", "|", "(", ")"]);
const SHELL_WRAPPERS = new Set(["command", "builtin", "sudo", "doas"]);
const SHELL_REDIRECTIONS = new Set([">", ">>", "<", "<<", "<<<", "<&", ">&", "<>", ">|", "&>", "&>>"]);
const SHELL_WRITE_REDIRECTIONS = new Set([">", ">>", ">&", "<>", ">|", "&>", "&>>"]);

export interface ShellToken {
	value: string;
	operator: boolean;
	quoted: boolean;
	start: number;
	end: number;
	/** Scripts of the `$(...)`, backtick, `<(...)`, and `>(...)` substitutions this word carries. */
	substitutions?: string[];
	/**
	 * The word begins with a reference the shell expands to the home directory:
	 * an unquoted `~`, or `$HOME` and `${HOME}` outside single quotes. `value`
	 * still holds the literal text. Absent for `'~/x'`, `"~/x"` and `'$HOME/x'`.
	 */
	homeRelative?: true;
	hiddenContent?: boolean;
	ansiCQuoted?: boolean;
	/** The command ends inside this word's quote, so the shell reads the rest differently or not at all. */
	unterminated?: true;
}

/**
 * Paths a tool call would mutate, derived from the tool's path argument.
 * Returns at most one path today: write/edit when a path arg is present, and
 * the artifact writers' defaults. Bash mutation targets are handled
 * separately through command classification.
 */
export function toolMutationPaths(toolName: string, args: Record<string, unknown> | undefined): string[] {
	if (toolName === ToolNames.Artifact) {
		return [mutationPathArg(args) ?? artifactDefaultPath(args?.kind)];
	}
	if (toolName === ToolNames.Write || toolName === ToolNames.Edit) {
		const candidate = mutationPathArg(args);
		return candidate === null ? [] : [candidate];
	}
	return [];
}

/**
 * Shared protected-artifact decision used by both the orchestrator middleware
 * guard and mediated worker runtimes. Keeping target extraction and bash
 * classification in one function prevents a dispatched worker from applying
 * a weaker interpretation of the same frozen protection state.
 */
export function protectedArtifactMutationBlockReason(
	state: ProtectedArtifactState,
	toolName: string,
	args: Record<string, unknown> | undefined,
): string | null {
	if (state.artifacts.length === 0) return null;
	for (const candidate of toolMutationPaths(toolName, args)) {
		if (isProtectedPath(state, candidate)) {
			return `protected artifact blocked: ${toolName} would modify protected path ${candidate}`;
		}
	}
	if (toolName !== ToolNames.Bash) return null;
	const command = typeof args?.command === "string" && args.command.length > 0 ? args.command : null;
	if (command === null) return null;
	const classification = classifyDestructiveCommand(command, state.artifacts);
	if (classification.kind === "benign") return null;
	const affected = classification.matches.map((match) => match.artifactPath).join(", ");
	return `protected artifact blocked: ${classification.operation} would affect ${affected}`;
}

function mutationPathArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export function protectArtifact(state: ProtectedArtifactState, artifact: ProtectedArtifact): ProtectedArtifactState {
	const artifacts = artifactMap(state.artifacts);
	const key = normalizePathKey(artifact.path);
	if (key !== null) artifacts.set(key, cloneArtifact(artifact));
	return stateFromMap(artifacts);
}

function isProtectedPath(state: ProtectedArtifactState, artifactPath: string): boolean {
	const candidate = normalizePathKey(artifactPath);
	if (candidate === null) return false;
	for (const artifact of normalizedArtifacts(state.artifacts)) {
		if (isSameOrDescendant(candidate, artifact.key, path.posix)) return true;
	}
	return false;
}

function classifyDestructiveCommand(
	command: string,
	protectedArtifacts: ReadonlyArray<ProtectedArtifact>,
): DestructiveCommandClassification {
	const artifacts = normalizedArtifacts(protectedArtifacts);
	if (artifacts.length === 0) return { kind: "benign", matches: [] };

	const segments = splitSegments(scanShellLike(command)).flatMap((tokens) => [
		tokens,
		...substitutionSegments(tokens, 0),
	]);
	for (const tokens of segments) {
		const segment = shellCommandArguments(tokens);
		const redirect = classifyRedirect(tokens, artifacts);
		if (redirect.kind === "destructive") return redirect;

		const commandIndex = commandTokenIndex(segment);
		if (commandIndex === null) continue;
		const executable = basenameToken(segment[commandIndex]);
		if (executable === "rm") {
			const result = classifyPathOperation(
				"rm",
				"rm can remove protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "mv") {
			const result = classifyPathOperation(
				"mv",
				"mv can move or overwrite protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "truncate") {
			const result = classifyPathOperation(
				"truncate",
				"truncate can overwrite protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "cp") {
			const args = pathArgs(segment, commandIndex);
			const destination = args.at(-1);
			const result = classifyPathOperation(
				"cp",
				"cp can overwrite protected artifacts",
				destination === undefined ? [] : [destination],
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "git") {
			const result = classifyGitOperation(segment.slice(commandIndex + 1), artifacts);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "find") {
			const result = classifyFindDelete(segment.slice(commandIndex + 1), artifacts);
			if (result.kind === "destructive") return result;
		}
	}

	return { kind: "benign", matches: [] };
}

export function detectValidationCommand(
	command: string,
	scope: ValidationCommandScope = "finish-contract",
): ValidationCommandDetection {
	for (const tokens of splitSegments(scanShellLike(command, true))) {
		const segment = shellCommandArguments(tokens);
		const commandIndex = commandTokenIndex(segment);
		if (commandIndex === null) continue;
		const executable = basenameToken(segment[commandIndex]);
		const args = segment.slice(commandIndex + 1);
		const matched =
			validationMatch(executable, args) ?? (scope === "grounding" ? groundingMatch(executable, args) : null);
		if (matched !== null) return { kind: "validation", matched };
	}
	return { kind: "none" };
}

/**
 * The command's single-line form: a backslash-newline is a line continuation, not a separator, so
 * `npm test \<newline>  -- -x` is `npm test -- -x` (x7-4). A here-document body is data the shell does not join here,
 * so it stays as written, terminator line included (S2).
 */
export function joinLineContinuations(command: string): string {
	const join = (text: string) =>
		text.replace(/([ \t]*)(?<=(?:^|[^\\])(?:\\\\)*)\\\n([ \t]*)/gu, (_, before: string, after: string) =>
			before.length > 0 || after.length > 0 ? " " : "",
		);
	let joined = "";
	let cursor = 0;
	for (const body of cachedShellScan(command, true).bodies) {
		joined += `${join(command.slice(cursor, body.start))}${command.slice(body.start, body.end)}`;
		cursor = body.end;
	}
	return `${joined}${join(command.slice(cursor))}`;
}

/**
 * The name an observed check's outcome is filed under: the command with trailing output plumbing (`2>&1`, `| tail`,
 * `| head`, `| tee log`, `> log`) removed, so `make test 2>&1 | tail -5` and `make test` settle each other. Under `pipefail` a pipeline exits
 * 0 only when the check did, so a green settles the name however it was piped; `head` can turn a green into a red
 * (SIGPIPE), so a red behind it lands nowhere ({@link checkFailureAttributable}). Tools and arguments stay distinct, so
 * `pytest` never settles `pytest -q` (bt-27).
 */
export function observedValidationCommand(command: string): string {
	let current = joinLineContinuations(command).trim();
	for (;;) {
		const next = current
			.replace(/\s*\|&?\s*(?:tail|head|tee)(?:\s+[^|;&<>]*)?$/u, "")
			.replace(/\s+2>&1$/u, "")
			.replace(/\s+(?:[0-9]?>>?|&>>?)\s*[^\s|;&<>"']+$/u, "")
			.trim();
		if (next === current) return current;
		current = next;
	}
}

/** npm's own abbreviations of `test` and `run`. */
const NPM_COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
	["t", "test"],
	["tst", "test"],
	["run-script", "run"],
	["rum", "run"],
	["urn", "run"],
]);

/**
 * The check an observed name ({@link observedValidationCommand}) runs, so respellings of one check settle each other
 * while each outcome keeps the name it was filed under (SF-2). One literal step is read past `time` and the transparent
 * wrappers (`timeout 300 npm test` is `npm test`), and an npm, pnpm or yarn script run as `<pm> [selectors] run
 * <script> [args]`, so `npm test`, `npm t` and `npm run test` are one check. Anything else is its own text: arguments,
 * environment prefixes and tools stay distinct, so `pytest` never settles `pytest -q` (bt-27).
 */
export function checkIdentity(name: string): string {
	const steps = commandSteps(name);
	const [step] = steps;
	if (steps.length !== 1 || step === undefined || !step.literal || step.grouped) return `text:${name}`;
	const [executable = "", first, ...rest] = step.argv.slice(step.command);
	const args = first === undefined ? [] : [(executable === "npm" && NPM_COMMAND_ALIASES.get(first)) || first, ...rest];
	const run =
		executable === "npm" || executable === "pnpm" || executable === "yarn" ? packageScriptRun(executable, args) : null;
	const argv =
		run === null ? [executable, ...args] : [executable, ...run.selectors, "run", run.script, ...run.forwarded];
	return `argv:${JSON.stringify(argv)}`;
}

/**
 * Returns every path the command would write to: shell redirect targets
 * (`>`, `>>`), all path arguments to `tee`, `mkdir`, and `touch`, the
 * destination argument of `cp`, `mv`, and `ln`, and the file operands of an
 * in-place `sed -i` edit. Standard descriptors like `/dev/null` and fd
 * references like `&1` are filtered out so callers only see real filesystem
 * targets.
 *
 * Used by the action classifier to escalate bash calls that write to a
 * system root or out-of-cwd path through the same confirmation gate as the
 * write tool, and by the finish-contract to decide whether a turn mutated
 * workspace state. Both consumers read the same primitive, so a write pattern
 * this recognizes gates and gate-completes consistently. pi-mono executes the
 * bash command verbatim, so the registry-side check has to happen before the
 * shell runs.
 */
export function extractCommandWriteTargets(command: string): string[] {
	const targets: string[] = [];
	for (const segment of expandedShellSegments(command, 0, true)) {
		collectRedirectTargets(segment, targets);
		const argv = shellCommandArguments(segment);
		collectInvokedWriteTargets(argv, targets);
		collectInPlaceEditTargets(argv, targets);
	}
	return targets.filter(isInterestingWriteTarget);
}

/** One simple command: its executable, the words after it, and the files its redirects truncate. */
export interface ShellCommandStep {
	/** Lowercased basename of the command word, or "" for a redirect with no command. */
	executable: string;
	/** The command word is a relative path such as `./sbatch` or `bin/ssh`: a workspace file, not the CLI on PATH. */
	relativePath?: true;
	/** Literal words after the command word, redirections removed. */
	args: string[];
	/** Targets of `>`-style redirects that replace the file's contents. `>>` is not listed. */
	truncatingRedirects: string[];
}

/**
 * The simple commands of a command line in order, following `sh -c` scripts and
 * substitutions the way the write and delete scanners do. Presentation callers
 * read this instead of re-tokenizing, so the words they describe are the words
 * admission already scanned.
 */
export function shellCommandSteps(command: string, home?: string): ShellCommandStep[] {
	const steps: ShellCommandStep[] = [];
	// A here-document body is data for the command, not commands: admission
	// removes the bodies before it reads, and so does the card. A here-document
	// that survives (inside a substitution or an `sh -c` script) cannot be told
	// from commands, so only the top-level commands are described then.
	const body = withoutHeredocBodies(command);
	const segments = /<<(?!<)/u.test(body) ? splitSegments(scanShellLike(body)) : expandedShellSegments(body);
	for (const segment of segments) {
		const truncatingRedirects: string[] = [];
		for (let index = 0; index < segment.length - 1; index += 1) {
			const operator = segment[index];
			// `<>` opens read-write and does not truncate.
			if (operator === undefined || [">>", "&>>", "<>"].includes(operator.value)) continue;
			const target = redirectWriteTarget(operator, segment[index + 1]);
			const targetToken = segment[index + 1];
			if (target !== null && targetToken !== undefined && isInterestingWriteTarget(target)) {
				truncatingRedirects.push(homeExpanded(targetToken, home));
			}
		}
		const argv = shellCommandWords(segment).map((token) => homeExpanded(token, home));
		const commandIndex = commandTokenIndex(argv);
		if (commandIndex === null) {
			if (truncatingRedirects.length > 0) steps.push({ executable: "", args: [], truncatingRedirects });
			continue;
		}
		steps.push({
			executable: basenameToken(argv[commandIndex]),
			args: argv.slice(commandIndex + 1),
			truncatingRedirects,
			...(isRelativeCommandPath(argv[commandIndex]) ? { relativePath: true as const } : {}),
		});
	}
	return steps;
}

/** File operands of `sed -i`, or null when these `sed` arguments do not edit in place. */
export function sedInPlaceOperands(args: ReadonlyArray<string>): string[] | null {
	const segment = ["sed", ...args];
	return hasSedInPlaceFlag(segment, 0) ? sedFileOperands(segment, 0) : null;
}

/** Shells whose `-c` argument is a script this scanner has to read as a command line. */
const INNER_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Depth cap for `sh -c 'sh -c "..."'`; three levels is far past anything real. */
const INNER_SHELL_MAX_DEPTH = 3;

/**
 * The script a segment hands a shell through `-c`, or null when the segment is
 * not that shape. The tokenizer keeps a quoted script as one token, so without
 * this every scanner here is blind one `sh -c` deep: `sh -c 'echo x >
 * /etc/foo'` exposed no redirect target at all, which is how a recorded drive
 * got a write past the gate that refused the same redirect written plainly
 * (REPORT-dispatch-drive-1.md S1). Flag clusters (`-lc`, `-ec`) count, since
 * the shell reads them the same way.
 */
function segmentShellScript(segment: ReadonlyArray<string>): string | null | undefined {
	const invocation = segmentShellInvocation(segment);
	if (invocation.kind === "none") return null;
	return invocation.kind === "inline" ? invocation.script : undefined;
}

/**
 * How a segment hands a shell its script: not a shell at all, inline through
 * `-c`, from a named file operand, from standard input, or through a startup
 * option this scanner does not model.
 */
type ShellInvocation =
	| { kind: "none" }
	| { kind: "inline"; script: string | undefined }
	| { kind: "file"; path: string }
	| { kind: "stdin" }
	| { kind: "opaque" };

function segmentShellInvocation(segment: ReadonlyArray<string>): ShellInvocation {
	const commandIndex = commandTokenIndex(segment);
	if (commandIndex === null) return { kind: "none" };
	if (!INNER_SHELLS.has(basenameToken(segment[commandIndex]))) return { kind: "none" };
	for (let index = commandIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) return { kind: "opaque" };
		if (token === "-o" || token === "+o" || token === "-O" || token === "+O") {
			const option = segment[++index];
			if (option === undefined || option.startsWith("-") || option.startsWith("+")) return { kind: "opaque" };
			continue;
		}
		if (["--norc", "--noprofile", "--posix", "--login", "--restricted", "--verbose"].includes(token)) continue;
		if (token === "--rcfile" || token === "--init-file") return { kind: "opaque" };
		if (/^[-+][a-zA-Z]+$/u.test(token)) {
			if (!/^[-+][abCefhiklmnprstuvxBDEHILPTXc]+$/u.test(token)) return { kind: "opaque" };
			if (token.startsWith("-") && token.slice(1).includes("c")) return { kind: "inline", script: segment[index + 1] };
			// `-s` reads the script from standard input even with operands.
			if (token.startsWith("-") && token.slice(1).includes("s")) return { kind: "stdin" };
			continue;
		}
		if (token === "--")
			return segment[index + 1] === undefined ? { kind: "stdin" } : { kind: "file", path: segment[index + 1] as string };
		return token.startsWith("-") ? { kind: "opaque" } : { kind: "file", path: token };
	}
	return { kind: "stdin" };
}

/**
 * Script files a command runs through a shell, for the operator's yolo to scan
 * (#419): `bash x.sh`, `sh -e x.sh` and `bash < x.sh`, also inside an `sh -c`
 * script or a substitution. Null when some script cannot be named: one fed
 * through a pipe, a here-document, `-s` or a startup option keeps its ask.
 */
export function shellScriptSources(command: string): ScriptSource[] | null {
	const sources: ScriptSource[] = [];
	return collectScriptSources(command, 0, false, sources) ? sources : null;
}

/**
 * A file one line of a script hands the shell; `program` marks an `exec`
 * target, which may be a binary, `sourced` one that `source` or `.` runs in
 * the script's own shell, and `stdin` one fed to the shell on standard input,
 * where `$0` names the shell rather than the file.
 */
export interface ScriptSource {
	path: string;
	program: boolean;
	stdin: boolean;
	sourced: boolean;
}

/**
 * The files one line of a scanned script runs (#419): what
 * {@link shellScriptSources} names, plus `source x`, `. x` and `exec` of a
 * shell or of a path. Null when the line runs a script it cannot name.
 */
export function scriptLineSources(line: string): ScriptSource[] | null {
	const sources: ScriptSource[] = [];
	return collectScriptSources(line, 0, true, sources) ? sources : null;
}

/** Options of `exec` that take the next word: `-a name`. */
const EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-a"]);

function collectScriptSources(command: string, depth: number, sourced: boolean, sources: ScriptSource[]): boolean {
	for (const segment of splitSegments(scanShellLike(command))) {
		for (const token of segment) {
			for (const substitution of token.substitutions ?? []) {
				if (depth >= INNER_SHELL_MAX_DEPTH || !collectScriptSources(substitution, depth + 1, sourced, sources))
					return false;
			}
		}
		let argv = shellCommandArguments(segment);
		if (sourced) {
			const commandIndex = commandTokenIndex(argv);
			const executable = commandIndex === null ? "" : basenameToken(argv[commandIndex]);
			if (commandIndex !== null && (executable === "source" || executable === ".")) {
				const operands = argv.slice(commandIndex + 1);
				const target = operands[0] === "--" ? operands[1] : operands[0];
				if (target === undefined || target.startsWith("-")) return false;
				sources.push({ path: target, program: false, sourced: true, stdin: false });
				continue;
			}
			if (commandIndex !== null && executable === "exec") {
				let next = commandIndex + 1;
				while (argv[next]?.startsWith("-") === true) next += EXEC_VALUE_OPTIONS.has(argv[next] ?? "") ? 2 : 1;
				const target = argv[next];
				// `exec >log` only redirects; `exec node app.js` runs a program found on PATH.
				if (target === undefined) continue;
				if (!INNER_SHELLS.has(basenameToken(target))) {
					if (target.includes("/")) sources.push({ path: target, program: true, sourced: false, stdin: false });
					continue;
				}
				argv = argv.slice(next);
			}
		}
		const invocation = segmentShellInvocation(argv);
		if (invocation.kind === "none") continue;
		if (invocation.kind === "opaque") return false;
		if (invocation.kind === "file") sources.push({ path: invocation.path, program: false, sourced: false, stdin: false });
		else if (invocation.kind === "inline") {
			if (
				invocation.script === undefined ||
				depth >= INNER_SHELL_MAX_DEPTH ||
				!collectScriptSources(invocation.script, depth + 1, sourced, sources)
			)
				return false;
		} else {
			const redirect = segment.findIndex((token) => token.operator && token.value === "<");
			const target = redirect < 0 ? undefined : segment[redirect + 1];
			if (target === undefined || target.operator) return false;
			sources.push({ path: target.value, program: false, sourced: false, stdin: true });
		}
	}
	return true;
}

/** Shell source that cannot be inspected must keep the one-shot confirmation rail. */
export function hasUnparsedShellScript(command: string, depth = 0): boolean {
	for (const segment of splitSegments(scanShellLike(command))) {
		const script = segmentShellScript(shellCommandArguments(segment));
		if (script === undefined) return true;
		if (script !== null && (depth >= INNER_SHELL_MAX_DEPTH || hasUnparsedShellScript(script, depth + 1))) return true;
		for (const token of segment) {
			for (const substitution of token.substitutions ?? []) {
				if (depth >= INNER_SHELL_MAX_DEPTH || hasUnparsedShellScript(substitution, depth + 1)) return true;
			}
		}
	}
	return false;
}

/**
 * A command's segments, with every `sh -c '<script>'` wrapper followed by the
 * segments of the script it runs. The wrapper segment itself is kept: a
 * scanner that reads its operands (`cp`, `tee`) must still see them.
 */
function expandedShellSegments(command: string, depth = 0, skipHeredocBodies = false): ShellToken[][] {
	const segments = splitSegments(scanShellLike(skipHeredocBodies ? withoutHeredocBodies(command, true) : command));
	if (depth >= INNER_SHELL_MAX_DEPTH) return segments;
	const out: ShellToken[][] = [];
	for (const segment of segments) {
		out.push(segment, ...substitutionSegments(segment, depth, skipHeredocBodies));
		const script = segmentShellScript(shellCommandArguments(segment));
		if (typeof script === "string") out.push(...expandedShellSegments(script, depth + 1, skipHeredocBodies));
	}
	return out;
}

/**
 * The script when the whole command is one `sh -c '<script>'` invocation and
 * nothing else. The policy engine recognizes such a command by its inner
 * script rather than treating `sh` as an unrecognized executable.
 */
export function inlineShellScript(command: string): string | null {
	const segments = splitSegments(scanShellLike(command));
	if (segments.length !== 1) return null;
	const segment = segments[0];
	if (segment === undefined) return null;
	return segmentShellScript(shellCommandArguments(segment)) ?? null;
}

/** Shells a bare wrapper may name: the bare name only, never a path. */
const BARE_WRAPPER_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh"]);

/**
 * The script when the command is exactly `<shell> [options] -c '<script>'`
 * and nothing else: no leading assignment or `env`, no pathful shell, no
 * operand after the script, no redirect, and no option that runs other code
 * first (`-x` with `PS4`, `-i`, `-l`, `--rcfile`, `--init-file`). Only this
 * form may be judged by its script alone; anything else on the wrapper's line
 * would run unexamined.
 */
export function bareInlineShellScript(command: string): string | null {
	const segments = splitSegments(scanShellLike(command));
	if (segments.length !== 1) return null;
	const segment = segments[0];
	if (segment === undefined || segment.some((token) => token.operator)) return null;
	const words = segment.map((token) => token.value);
	if (!BARE_WRAPPER_SHELLS.has(words[0] ?? "")) return null;
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index] as string;
		if (word === "--norc" || word === "--noprofile") continue;
		if (!/^-[ceufv]+$/u.test(word)) return null;
		if (word.includes("c")) return index === words.length - 2 ? (words[index + 1] as string) : null;
	}
	return null;
}

/**
 * Returns the directory each `cd`/`pushd` in the command targets. A bare
 * `cd` (and `cd -`, whose OLDPWD is unset in a fresh shell) is reported as
 * `~`: it goes to the user's home directory. The action classifier resolves
 * these against the workspace root, because a `cd` outside the workspace
 * re-bases every relative path that follows it — the laundering pattern the
 * recorded escape used (`cd /abs/outside && python3 <<EOF ...` writing
 * relative files outside the session workspace).
 */
export function extractCommandCdTargets(command: string): string[] {
	const targets: string[] = [];
	for (const tokens of expandedShellSegments(command)) {
		const target = cdTarget(shellCommandArguments(tokens));
		if (target !== null) targets.push(target);
	}
	return targets;
}

function cdTarget(segment: ReadonlyArray<string>): string | null {
	const commandIndex = commandTokenIndex(segment);
	if (commandIndex === null) return null;
	const executable = basenameToken(segment[commandIndex]);
	if (executable !== "cd" && executable !== "pushd") return null;
	return pathArgs(segment, commandIndex).at(0) ?? "~";
}

/**
 * A path-bearing step of a shell command, in the order the shell takes them.
 * `link` is a link the command creates: `sources` are what it points at (a
 * symbolic link's text, or the file a hard link shares), and `linkDirs` are the
 * directories it may be created in, relative to where the shell is. A
 * `subshell` opens or closes a child shell: `( ... )`, a substitution, or the
 * script of an `sh -c`. A cd is `unmodeled` when it can run more times than it
 * is written, or resolve somewhere its text does not say: inside a loop, after
 * a function definition, or with CDPATH named.
 */
export type CommandPathEvent =
	| { kind: "cd"; target: string; unmodeled: boolean }
	| { kind: "write"; target: string }
	| { kind: "link"; symbolic: boolean; sources: string[]; linkDirs: string[]; origin: LinkOrigin }
	| { kind: "delete"; target: string; scope: DeleteScope; findRoot?: FindRootFilter }
	| { kind: "subshell"; open: boolean };

/**
 * Whether a find root's expression narrows what its delete removes before the
 * delete runs. Only the operator's yolo reads it (#419): there an unfiltered
 * root is judged like `rm -rf` of it, while every other view keeps judging
 * the root's children.
 */
export type FindRootFilter = "filtered" | "unfiltered";

/**
 * What a delete event names. `path` is the operand itself. `children` is a
 * directory whose entries go (the roots of `find ... -exec rm`), so the
 * directory may be the workspace root. `input` is `xargs rm`, whose operands
 * the scanner never sees.
 */
export type DeleteScope = "path" | "children" | "input" | "remote";

/**
 * How a link event knows its sources. `text` is a link made from the words
 * the command names. `copied` is `mv`, or a `cp` that keeps links, whose
 * sources are existing paths: a source that is itself a link is recreated with
 * the same text. `input` is `xargs` or `find -exec`, whose real operands come
 * from input the scanner never sees.
 */
export type LinkOrigin = "text" | "copied" | "input";

interface CommandPathWalkState {
	events: CommandPathEvent[];
	/** Loops open around the current segment; their cds may run any number of times. */
	loopDepth: number;
	/** A function is defined before this point, so a later call can rerun any cd. */
	functionSeen: boolean;
	/** CDPATH is named, so a relative cd may resolve against it instead. */
	cdpath: boolean;
	/** A `case` pattern ends in a bare `)`, so no parenthesis can be trusted as a subshell. */
	caseSeen: boolean;
	/**
	 * A here-document opened before this point that the walk reads with its
	 * body. The scanner reads body lines as commands, so a later cd or
	 * parenthesis may be body text.
	 */
	heredocSeen: boolean;
	/** Whether a top-level here-document counts, or only one inside a substitution or `sh -c`. */
	topLevelHeredocs: boolean;
}

/** Words that open a loop whose condition and body may run more than once; `done` closes it. */
const LOOP_WORDS: ReadonlySet<string> = new Set(["for", "while", "until", "select"]);

/** The reserved words a segment starts with, and a leading for, case, or select. */
function leadingShellWords(argv: ReadonlyArray<string>): string[] {
	const words: string[] = [];
	for (const word of argv) {
		if (SHELL_RESERVED_PREFIXES.has(word)) {
			words.push(word);
			continue;
		}
		if (word === "for" || word === "case" || word === "select") words.push(word);
		break;
	}
	return words;
}

/**
 * The cd, write, and link steps of a command in order, with the child shells
 * around them, so a caller can resolve each write against every directory an
 * earlier cd can leave the shell in. A segment's substitutions and redirects
 * are opened before its command runs, so they come before its cd.
 */
function extractCommandPathWalk(command: string, topLevelHeredocs = true): CommandPathEvent[] {
	const walk: CommandPathWalkState = {
		events: [],
		loopDepth: 0,
		functionSeen: false,
		cdpath: /\bCDPATH\b/u.test(command),
		caseSeen: false,
		heredocSeen: false,
		topLevelHeredocs,
	};
	collectPathWalk(command, 0, walk);
	return walk.caseSeen ? walk.events.filter((event) => event.kind !== "subshell") : walk.events;
}

/**
 * The path walks a caller has to judge a command by. The scanner cannot tell a
 * here-document body line from a command: a body `(` and `)` around a real cd
 * made the walk forget it, and a lone quote in a body swallowed every later
 * command. So a command with a here-document is also read with its bodies
 * removed, and a write escalates when either walk escalates it. A
 * here-document that cannot be removed, because it sits inside a substitution
 * or an `sh -c` script or has no word, leaves every later cd unmodeled.
 *
 * When every here-document is quoted and copied by `cat` or `tee` into a file,
 * no shell reads its body, so only the walk without bodies counts: `=>` in a
 * TypeScript body is not a redirect. A body fed to a shell, an interpreter,
 * a pipe, or any other command is still read as commands, and so is one whose
 * file a later command names, since that command may run it, or a script
 * file a step such as `make` may run without naming it.
 */
export function extractCommandPathWalks(command: string): CommandPathEvent[][] {
	const { text: withoutBodies, dataOutputs } = removeHeredocBodies(command, false);
	if (withoutBodies === command) return [extractCommandPathWalk(command)];
	const removedAll = !scanShellLike(withoutBodies).some((token) => token.operator && token.value === "<<");
	if (removedAll && dataOutputs !== null && !mayRunHeredocOutputs(withoutBodies, dataOutputs))
		return [extractCommandPathWalk(withoutBodies)];
	return [extractCommandPathWalk(command, !removedAll), extractCommandPathWalk(withoutBodies)];
}

/** Commands that copy a here-document to their output as text and run none of it. */
const HEREDOC_DATA_CONSUMERS: ReadonlySet<string> = new Set(["cat", "tee"]);

/**
 * The files a quoted here-document's command copies it into, or null unless
 * that command is `cat` or `tee` with its standard output sent to a file, so
 * no pipe, process substitution, or descriptor can hand the text to a shell.
 */
function heredocDataOutputs(tokens: ReadonlyArray<ShellToken>, operatorIndex: number): string[] | null {
	const separator = (token: ShellToken | undefined): boolean =>
		token?.operator === true && COMMAND_SEPARATORS.has(token.value);
	let start = operatorIndex;
	while (start > 0 && !separator(tokens[start - 1])) start -= 1;
	let end = operatorIndex;
	while (end < tokens.length && !separator(tokens[end])) end += 1;
	const segment = tokens.slice(start, end);
	if (segment.some((token) => (token.substitutions?.length ?? 0) > 0)) return null;
	const argv = shellCommandArguments(segment);
	const commandIndex = commandTokenIndex(argv);
	if (commandIndex === null || !HEREDOC_DATA_CONSUMERS.has(basenameToken(argv[commandIndex]))) return null;
	let stdout: string | null = null;
	for (let index = 0; index < segment.length - 1; index += 1) {
		const operator = segment[index];
		const target = segment[index + 1];
		if (operator === undefined || target === undefined || !operator.operator || target.operator) continue;
		const previous = segment[index - 1];
		const fd =
			previous !== undefined &&
			!previous.operator &&
			!previous.quoted &&
			previous.end === operator.start &&
			/^\d+$/u.test(previous.value)
				? previous.value
				: null;
		if (operator.value === "<&") {
			if (fd === "1") stdout = null;
			continue;
		}
		if (!SHELL_WRITE_REDIRECTIONS.has(operator.value)) continue;
		const both = operator.value === "&>" || operator.value === "&>>";
		if (!both && (fd ?? (operator.value === "<>" ? "0" : "1")) !== "1") continue;
		stdout = operator.value === ">&" && /^(?:\d+-?|-)$/u.test(target.value) ? null : target.value;
	}
	if (stdout === null || (stdout.startsWith("/dev/") && stdout !== "/dev/null")) return null;
	const outputs = basenameToken(argv[commandIndex]) === "tee" ? pathArgs(argv, commandIndex) : [];
	return [stdout, ...outputs].filter((output) => output !== "/dev/null");
}

/** Writers that run none of the files they touch, so a data here-document's file stays unrun by them. */
const NON_RUNNING_WRITERS: ReadonlySet<string> = new Set([
	"cat",
	"tee",
	"cp",
	"mv",
	"rm",
	"rmdir",
	"mkdir",
	"touch",
	"ln",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
	"unlink",
]);

/**
 * A file name a step may run as a shell script without naming it (bt-low1): a `.sh`, `.bash`, `.zsh` or `.mk` file,
 * or a name with no extension, such as a Makefile, a git hook, a `bin/` tool or `.envrc`.
 */
function shellRunnableOutput(output: string): boolean {
	const name = basenameToken(output);
	return /\.(?:sh|bash|zsh|ksh|mk)$/iu.test(name) || !name.slice(1).includes(".");
}

/**
 * Whether a step of the command, bodies removed, may run a file it does not name: anything but shell setup, read-only
 * inspection and {@link NON_RUNNING_WRITERS}, or any step with a substitution (`make`, `npm test`, `git commit`'s
 * hooks, `for f in *.sh`).
 */
function mayRunUnnamedFile(command: string): boolean {
	return shellSteps(scanShellLike(command)).some((step) => {
		if (step.tokens.some((token) => (token.substitutions?.length ?? 0) > 0 || token.hiddenContent === true)) return true;
		if (step.index === null) return false;
		const argv = step.argv.slice(step.index);
		const [first = ""] = argv;
		if (SHELL_SETUP_STEPS.has(first)) return first === "source" || first === ".";
		return !NON_RUNNING_WRITERS.has(basenameToken(first)) && !readOnlyInspectionStep(argv, true);
	});
}

/**
 * Whether the command, bodies removed, may run a file a data here-document
 * wrote: another word names the file, a function, alias, or PATH change
 * may make `cat` or `tee` something else, or the file is a script some step
 * may run unnamed ({@link shellRunnableOutput}, {@link mayRunUnnamedFile}).
 */
function mayRunHeredocOutputs(command: string, outputs: ReadonlyArray<string>): boolean {
	if (mayRedefineHeredocCopier(command)) return true;
	if (outputs.some(shellRunnableOutput) && mayRunUnnamedFile(command)) return true;
	const text = command.toLowerCase();
	const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
	for (const output of outputs) {
		const name = basenameToken(output);
		if (name === "") return true;
		const written = outputs.reduce((sum, other) => sum + count(other.toLowerCase(), name), 0);
		if (count(text, name) > written) return true;
	}
	return false;
}

/** A function, alias or PATH change in the command, bodies removed, may make `cat` or `tee` something that runs its input. */
function mayRedefineHeredocCopier(command: string): boolean {
	return /\bPATH=|\balias\b|\bfunction\b|\(\s*\)/u.test(command);
}

/** More here-documents than this in one command are left in place. */
const MAX_HEREDOCS = 64;

/**
 * The command with each top-level here-document body removed and its `<<WORD`
 * blanked, so what is left reads as the commands bash runs. A body starts on
 * the line after its operator and ends at the line that is exactly its word
 * (tabs stripped first for `<<-`), or at the end of the command, as in bash.
 * Several here-documents on one line take their bodies in order.
 */
export function withoutHeredocBodies(command: string, keepSubstitutions = false): string {
	return removeHeredocBodies(command, keepSubstitutions).text;
}

/**
 * The command without its here-document bodies when every one is quoted data that `cat` or `tee` copies into a file and
 * nothing may redefine that copier; otherwise the command as written. Such a body is never this shell's command lines,
 * so its lines separate nothing (SF-5), even when a later step runs the file it wrote (`cat > t.test.mjs <<'EOF' && node
 * --test t.test.mjs`, SF-6): that step's status is its own, as for any file it runs.
 */
export function withoutDataHeredocBodies(command: string): string {
	const { text, dataOutputs } = removeHeredocBodies(command, false);
	if (text === command || dataOutputs === null) return command;
	if (scanShellLike(text).some((token) => token.operator && token.value === "<<")) return command;
	return mayRedefineHeredocCopier(text) ? command : text;
}

/**
 * The write targets a quoted here-document is copied into by `cat` or `tee`. That step writes before any later step
 * runs, so the write stands even when the call exits nonzero because a later step, such as the suite run on the file,
 * failed (SF-5).
 */
export function heredocDataWriteTargets(command: string): string[] {
	const { text, dataOutputs } = removeHeredocBodies(command, false);
	if (text === command || dataOutputs === null) return [];
	const outputs = new Set(dataOutputs);
	return extractCommandWriteTargets(command).filter((target) => outputs.has(target));
}

/**
 * {@link withoutHeredocBodies}, with the files its here-documents are copied
 * into as data ({@link heredocDataOutputs}), or null when any one is not.
 */
function removeHeredocBodies(
	command: string,
	keepSubstitutions: boolean,
): { text: string; dataOutputs: string[] | null } {
	let text = command;
	let dataOutputs: string[] | null = [];
	for (let pass = 0; pass < MAX_HEREDOCS; pass += 1) {
		const tokens = scanShellLike(text);
		const first = tokens.findIndex((token) => token.operator && token.value === "<<");
		if (first === -1) return { text, dataOutputs };
		const lineEnd = tokens.findIndex(
			(token, index) => index > first && token.operator && token.value === ";" && text[token.start] === "\n",
		);
		const docs: Array<{ start: number; end: number; word: string; stripTabs: boolean; quoted: boolean }> = [];
		for (let index = first; index < (lineEnd === -1 ? tokens.length : lineEnd); index += 1) {
			const operator = tokens[index];
			if (operator === undefined || !operator.operator || operator.value !== "<<") continue;
			let word = tokens[index + 1];
			let stripTabs = false;
			if (word !== undefined && !word.operator && word.start === operator.end && text[word.start] === "-") {
				stripTabs = true;
				if (word.value === "-") word = tokens[index + 2];
			}
			// `<<` with no word is a syntax error: bash runs nothing, so leave it as written.
			if (word === undefined || word.operator) return { text, dataOutputs: null };
			const outputs = word.quoted ? heredocDataOutputs(tokens, index) : null;
			dataOutputs = outputs === null || dataOutputs === null ? null : [...dataOutputs, ...outputs];
			const delimiter = stripTabs && text[word.start] === "-" ? word.value.slice(1) : word.value;
			docs.push({ start: operator.start, end: word.end, word: delimiter, stripTabs, quoted: word.quoted });
		}
		let head = text;
		for (const doc of [...docs].reverse()) {
			head = `${head.slice(0, doc.start)}${" ".repeat(doc.end - doc.start)}${head.slice(doc.end)}`;
		}
		if (lineEnd === -1) {
			text = head;
			continue;
		}
		const bodyStart = (tokens[lineEnd]?.start ?? text.length) + 1;
		let cursor = bodyStart;
		const substitutions: string[] = [];
		for (const doc of docs) {
			const start = cursor;
			let bodyEnd = cursor;
			while (cursor < text.length) {
				bodyEnd = cursor;
				const newline = text.indexOf("\n", cursor);
				const line = text.slice(cursor, newline === -1 ? text.length : newline);
				cursor = newline === -1 ? text.length : newline + 1;
				if ((doc.stripTabs ? line.replace(/^\t+/u, "") : line) === doc.word) break;
				bodyEnd = cursor;
			}
			if (keepSubstitutions && !doc.quoted)
				substitutions.push(...heredocSubstitutions(text.slice(start, bodyEnd)).map((found) => found.text));
		}
		text = `${head.slice(0, bodyStart)}${substitutions.length > 0 ? `${substitutions.join("\n")}\n` : ""}${text.slice(cursor)}`;
	}
	return { text, dataOutputs: null };
}

/** The `$(...)` and backtick substitutions an unquoted here-document body runs, each with its offset in `body`. */
function heredocSubstitutions(body: string): Array<{ start: number; text: string }> {
	const substitutions: Array<{ start: number; text: string }> = [];
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		if (char === "\\" && /[$`\\\n]/u.test(body[index + 1] ?? "")) {
			index += 1;
			continue;
		}
		const close =
			char === "$" && body[index + 1] === "("
				? matchingParen(body, index + 1)
				: char === "`"
					? matchingBacktick(body, index)
					: null;
		if (close === null) continue;
		substitutions.push({ start: index, text: body.slice(index, close + 1) });
		index = close;
	}
	return substitutions;
}

function collectPathWalk(command: string, depth: number, walk: CommandPathWalkState): void {
	const tokens = scanShellLike(command);
	let segment: ShellToken[] = [];
	for (const [index, token] of tokens.entries()) {
		if (token.operator && COMMAND_SEPARATORS.has(token.value)) {
			collectSegmentPathEvents(segment, depth, walk);
			segment = [];
			// `name()` defines a function whose body may run any number of times.
			const next = tokens[index + 1];
			if (token.value === "(" && next?.operator === true && next.value === ")") walk.functionSeen = true;
			// After a here-document a parenthesis may be body text, and a false `)`
			// would restore bases from before a real cd, so none are trusted.
			if ((token.value === "(" || token.value === ")") && !walk.heredocSeen)
				walk.events.push({ kind: "subshell", open: token.value === "(" });
			continue;
		}
		segment.push(token);
	}
	collectSegmentPathEvents(segment, depth, walk);
}

function collectChildScript(script: string, depth: number, walk: CommandPathWalkState): void {
	if (depth >= INNER_SHELL_MAX_DEPTH) return;
	walk.events.push({ kind: "subshell", open: true });
	collectPathWalk(script, depth + 1, walk);
	// A body line can hide a later command from the walk above, as a lone quote does.
	const withoutBodies = withoutHeredocBodies(script);
	if (withoutBodies !== script) collectPathWalk(withoutBodies, depth + 1, walk);
	// A here-document body can move where the scanner thinks a substitution
	// ends, so the script may hold commands of the parent: keep its cds.
	if (!walk.heredocSeen) walk.events.push({ kind: "subshell", open: false });
}

function collectSegmentPathEvents(segment: ReadonlyArray<ShellToken>, depth: number, walk: CommandPathWalkState): void {
	if (segment.length === 0) return;
	for (const token of segment) {
		for (const script of token.substitutions ?? []) collectChildScript(script, depth, walk);
	}
	const argv = shellCommandArguments(segment);
	if (argv[0] === "done" && walk.loopDepth > 0) walk.loopDepth -= 1;
	if (argv[0] === "function") walk.functionSeen = true;
	for (const word of leadingShellWords(argv)) {
		if (LOOP_WORDS.has(word)) walk.loopDepth += 1;
		if (word === "case") walk.caseSeen = true;
	}
	const writes: string[] = [];
	collectRedirectTargets(segment, writes);
	collectInvokedWriteTargets(argv, writes);
	collectInPlaceEditTargets(argv, writes);
	for (const target of writes.filter(isInterestingWriteTarget)) walk.events.push({ kind: "write", target });
	collectLinkEvents(argv, walk.events);
	collectDeleteEvents(argv, walk.events);
	const cd = cdTarget(argv);
	if (cd !== null) {
		walk.events.push({
			kind: "cd",
			target: cd,
			unmodeled: walk.loopDepth > 0 || walk.functionSeen || walk.cdpath || walk.heredocSeen,
		});
	}
	const script = segmentShellScript(argv);
	if (typeof script === "string") collectChildScript(script, depth, walk);
	// The body starts on the next line, so this segment's own cd is real.
	if ((depth > 0 || walk.topLevelHeredocs) && segment.some((token) => token.operator && token.value === "<<"))
		walk.heredocSeen = true;
}

/** Commands that run the command after them, possibly with options and arguments of their own. */
const LINK_WRAPPERS: ReadonlySet<string> = new Set([
	"nice",
	"nohup",
	"timeout",
	"stdbuf",
	"ionice",
	"chrt",
	"xargs",
	"busybox",
	"setsid",
	"taskset",
	"flock",
	"exec",
	"find",
]);

/** Commands that can make a link, or recreate one they move or copy. */
const LINK_COMMANDS: ReadonlySet<string> = new Set(["ln", "link", "cp", "mv"]);

/** Commands that remove the paths they name. */
const DELETE_COMMANDS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink"]);

/**
 * The index of the command in `commands` that a wrapper runs, and whether its
 * operands come from input. A wrapper's own options and arguments are skipped
 * by looking for the next word that names such a command or another wrapper;
 * `find` runs what follows `-exec`, `-execdir`, `-ok`, or `-okdir`.
 */
function wrappedCommandIndex(
	argv: ReadonlyArray<string>,
	commands: ReadonlySet<string>,
): { index: number; fromInput: boolean } | null {
	let index = commandTokenIndex(argv);
	let fromInput = false;
	while (index !== null && LINK_WRAPPERS.has(basenameToken(argv[index]))) {
		const wrapper = basenameToken(argv[index]);
		if (wrapper === "xargs" || wrapper === "find") fromInput = true;
		const from = index;
		const next =
			wrapper === "find"
				? argv.findIndex((word, at) => at > from && /^-(?:exec|execdir|ok|okdir)$/u.test(word)) + 1
				: argv.findIndex(
						(word, at) => at > from && (commands.has(basenameToken(word)) || LINK_WRAPPERS.has(basenameToken(word))),
					);
		index = next > from ? next : null;
	}
	return index === null ? null : { index, fromInput };
}

/**
 * Paths a command removes, whatever flags it spells. Admission judges a delete
 * by where it lands: a flag pattern let `rm -v -r /` through and blocked
 * `rm -f` on scratch files, and it taught the model that dropping `-f` was the
 * way around a block. Behind `find -exec` the roots bound what goes; behind
 * `xargs` nothing does.
 */
function collectDeleteEvents(argv: ReadonlyArray<string>, out: CommandPathEvent[]): void {
	const outerIndex = commandTokenIndex(argv);
	const outerCommand = outerIndex === null ? "" : basenameToken(argv[outerIndex]);
	// `find -delete` and `rsync --delete` remove what lies under their roots, so
	// they are judged by those roots like any other delete (#419). A find root
	// carries whether its expression filters, because an unfiltered one can
	// match every entry: under the operator's yolo `find . -delete` empties the
	// workspace and its .git. Every rsync operand counts, sources included: a
	// misread option value can only add a judged path, never hide the
	// destination. A remote operand cannot be placed.
	if (outerIndex !== null && outerCommand === "find" && argv.includes("-delete")) {
		out.push(...findRootDeletes(argv.slice(outerIndex + 1)));
	}
	if (outerIndex !== null && outerCommand === "rsync" && argv.some((word) => /^--delete(?:-|$)/u.test(word))) {
		for (const operand of pathArgs(argv, outerIndex)) {
			const remote = /^[^/]*:/u.test(operand);
			out.push({ kind: "delete", target: operand, scope: remote ? "remote" : "children" });
		}
	}
	const found = wrappedCommandIndex(argv, DELETE_COMMANDS);
	if (found === null || !DELETE_COMMANDS.has(basenameToken(argv[found.index]))) return;
	if (!found.fromInput) {
		for (const target of pathArgs(argv, found.index).filter(isInterestingWriteTarget))
			out.push({ kind: "delete", target, scope: "path" });
		return;
	}
	const outer = commandTokenIndex(argv);
	if (outer !== null && basenameToken(argv[outer]) === "find") {
		out.push(...findRootDeletes(argv.slice(outer + 1)));
		return;
	}
	out.push({ kind: "delete", target: "<input>", scope: "input" });
}

/**
 * Links a command makes. `ln` (hard unless `-s`), `link` (always hard), `cp -s`,
 * and `cp -l` make one from the words they name. `mv` and a `cp` that keeps
 * links (`-a`, `-P`, `-d`, `--no-dereference`, or a recursive copy without
 * `-L` or `-H`) recreate any source that is itself a link. Behind `xargs` or
 * `find -exec` the operands are unknown. With `-t DIR` every link goes in DIR;
 * with one operand it goes in the current directory; otherwise the last operand
 * is either the link or, when it is a directory, where the links go, unless
 * `-T` says it is never a directory.
 */
function collectLinkEvents(argv: ReadonlyArray<string>, out: CommandPathEvent[]): void {
	const found = wrappedCommandIndex(argv, LINK_COMMANDS);
	if (found === null) return;
	const cmdIndex = found.index;
	const executable = basenameToken(argv[cmdIndex]);
	if (!LINK_COMMANDS.has(executable)) return;
	let symbolic = false;
	let hard = executable === "ln" || executable === "link";
	let keepsLinks = executable === "mv";
	let dereferences = false;
	let targetDirectory: string | null = null;
	let noTargetDirectory = false;
	let endOfOptions = false;
	const operands: string[] = [];
	for (let index = cmdIndex + 1; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		// `find -exec` ends its command at a lone `;` or `+`.
		if (found.fromInput && (token === ";" || token === "+")) break;
		if (endOfOptions || !token.startsWith("-") || token === "-") {
			operands.push(token);
			continue;
		}
		if (token === "--") {
			endOfOptions = true;
			continue;
		}
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			const name = eq === -1 ? token : token.slice(0, eq);
			const value = eq === -1 ? undefined : token.slice(eq + 1);
			if (executable === "mv") {
				if (name === "--target-directory") {
					targetDirectory = value ?? argv[index + 1] ?? null;
					if (value === undefined) index += 1;
				} else if (name === "--no-target-directory") noTargetDirectory = true;
				else if (name === "--suffix" && value === undefined) index += 1;
				continue;
			}
			if (name === "--symbolic" || name === "--symbolic-link") symbolic = true;
			else if (name === "--link") hard = true;
			else if (name === "--archive" || name === "--no-dereference" || name === "--recursive") keepsLinks = true;
			else if (name === "--dereference") dereferences = true;
			else if (name === "--no-target-directory") noTargetDirectory = true;
			else if (name === "--target-directory") {
				targetDirectory = value ?? argv[index + 1] ?? null;
				if (value === undefined) index += 1;
			} else if (name === "--suffix" && value === undefined) index += 1;
			continue;
		}
		for (let at = 1; at < token.length; at += 1) {
			const flag = token[at];
			if (flag === "s" && executable !== "mv") symbolic = true;
			else if (flag === "l" && executable === "cp") hard = true;
			else if (executable === "cp" && flag !== undefined && "aPdrR".includes(flag)) keepsLinks = true;
			else if (executable === "cp" && (flag === "L" || flag === "H")) dereferences = true;
			else if (flag === "T") noTargetDirectory = true;
			else if (flag === "t" || flag === "S") {
				// The rest of the cluster, or the next word, is the option's argument.
				const rest = token.slice(at + 1);
				const value = rest.length > 0 ? rest : argv[index + 1];
				if (rest.length === 0) index += 1;
				if (flag === "t") targetDirectory = value ?? null;
				break;
			}
		}
	}
	const copied = !symbolic && !hard && keepsLinks && !dereferences;
	if (!symbolic && !hard && !copied) return;
	let sources = operands;
	let linkDirs = ["."];
	if (targetDirectory !== null) {
		linkDirs = [targetDirectory];
		out.push({ kind: "write", target: targetDirectory });
	} else if (operands.length > 1) {
		const destination = operands.at(-1) as string;
		sources = operands.slice(0, -1);
		const parent = path.posix.dirname(destination);
		linkDirs = noTargetDirectory ? [parent] : [parent, destination];
	}
	const origin: LinkOrigin = found.fromInput ? "input" : copied ? "copied" : "text";
	if (origin === "input") {
		out.push({
			kind: "link",
			symbolic: symbolic || copied,
			sources: operands.length > 0 ? operands : ["<input>"],
			linkDirs,
			origin,
		});
		return;
	}
	if (sources.length > 0) out.push({ kind: "link", symbolic: symbolic || copied, sources, linkDirs, origin });
}

/**
 * Returns paths that common shell commands would remove from their current
 * location. This intentionally covers only deterministic, path-bearing
 * patterns; broader command admission remains owned by the policy engine.
 */
/**
 * Write and delete targets of the steps that follow a literal `cd`, spelled
 * from the directory that cd chain leaves the shell in (`cd ..` included).
 * A target written before any cd is not listed: the call cwd already judges it.
 */
export function extractCommandCdScopedTargets(command: string): Array<{ operation: "write" | "delete"; path: string }> {
	const out: Array<{ operation: "write" | "delete"; path: string }> = [];
	let cdDir: string | null = null;
	for (const tokens of expandedShellSegments(command, 0, true)) {
		const argv = shellCommandArguments(tokens);
		const cd = cdTarget(argv);
		if (cd !== null) {
			cdDir = cdDir === null || cd.startsWith("/") || cd.startsWith("~") ? cd : path.posix.join(cdDir, cd);
			continue;
		}
		if (cdDir === null) continue;
		const writes: string[] = [];
		collectRedirectTargets(tokens, writes);
		collectInvokedWriteTargets(argv, writes);
		collectInPlaceEditTargets(argv, writes);
		const deletes: string[] = [];
		const commandIndex = commandTokenIndex(argv);
		if (commandIndex !== null) {
			const executable = basenameToken(argv[commandIndex]);
			const args = pathArgs(argv, commandIndex);
			if (executable === "rm") deletes.push(...args);
			else if (executable === "mv" && args.length >= 2) deletes.push(...args.slice(0, -1));
			else if (executable === "find" && argv.includes("-delete")) deletes.push(...findRoots(argv.slice(commandIndex + 1)));
		}
		const base = cdDir;
		const spell = (target: string) =>
			target.startsWith("/") || target.startsWith("~") ? target : path.posix.join(base, target);
		for (const target of writes.filter(isInterestingWriteTarget)) out.push({ operation: "write", path: spell(target) });
		for (const target of deletes.filter(isInterestingWriteTarget)) out.push({ operation: "delete", path: spell(target) });
	}
	return out;
}

export function extractCommandDeleteTargets(command: string): string[] {
	const targets: string[] = [];
	for (const tokens of expandedShellSegments(command)) {
		const segment = shellCommandArguments(tokens);
		const commandIndex = commandTokenIndex(segment);
		if (commandIndex === null) continue;
		const executable = basenameToken(segment[commandIndex]);
		if (executable === "rm") {
			targets.push(...pathArgs(segment, commandIndex));
			continue;
		}
		if (executable === "mv") {
			const args = pathArgs(segment, commandIndex);
			if (args.length >= 2) targets.push(...args.slice(0, -1));
			continue;
		}
		if (executable === "find" && segment.includes("-delete")) {
			targets.push(...findRoots(segment.slice(commandIndex + 1)));
		}
	}
	return targets.filter(isInterestingWriteTarget);
}

/** Read-only inspection commands, each with the arguments that would make it write or run something else. */
const READ_ONLY_INSPECTION_REFUSALS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["cat", []],
	["ls", []],
	["head", []],
	["tail", []],
	["wc", []],
	["pwd", []],
	["grep", []],
	// `--hostname-bin` runs the named program even with no hyperlink format and stdout piped (x1-3).
	["rg", ["--pre", "--hostname-bin"]],
	["find", ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]],
	["stat", []],
	["which", []],
	["echo", []],
	["printf", []],
	["cut", []],
	["tr", []],
	// `file -C` compiles a magic file into the working directory.
	["file", ["-C", "--compile"]],
	["diff", []],
	["cmp", []],
	["du", []],
	["df", []],
	["tree", ["-o"]],
	["basename", []],
	["dirname", []],
	["realpath", []],
	["readlink", []],
	["date", ["-s", "--set"]],
	["sleep", []],
	["true", []],
	["false", []],
	// Shell control that ends or skips the script writes nothing, so `exit 0; npm test` retires no pass (d).
	["exit", []],
	["return", []],
	[":", []],
	["test", []],
	["[", []],
	// jq has no way to write a file or run a program.
	["jq", []],
]);

/**
 * Stdout filters whose arguments decide whether they only read (x3-4): `sed` with no in-place edit, script file, or
 * `w`/`e`/`r` command, `awk` with no `system`, pipe, redirect, include or program file, `sort` with no output file or
 * compress program, `uniq` with no output operand. Whatever these cannot parse stays a change.
 */
const READ_ONLY_FILTERS: ReadonlyMap<string, (args: ReadonlyArray<string>) => boolean> = new Map([
	["sed", sedOnlyReads],
	["awk", awkOnlyReads],
	[
		"sort",
		// GNU sort takes any unambiguous prefix of a long option, so `--out=x` is `--output=x` (x4-3).
		(args: ReadonlyArray<string>) =>
			!args.some((arg) => {
				const long = /^--([^=]+)/u.exec(arg)?.[1];
				if (long !== undefined) return "output".startsWith(long) || "compress-program".startsWith(long);
				return /^-[^-]/u.test(arg) && arg.includes("o");
			}),
	],
	["uniq", uniqOnlyReads],
]);

const SED_READ_FLAGS: ReadonlySet<string> = new Set([
	"--quiet",
	"--silent",
	"--regexp-extended",
	"--posix",
	"--separate",
	"--unbuffered",
	"--null-data",
	"--debug",
	"--sandbox",
]);

function sedOnlyReads(args: ReadonlyArray<string>): boolean {
	const scripts = sedScripts(args, false);
	return scripts !== null && scripts.every(sedScriptOnlyReads);
}

/**
 * The inline scripts of a sed invocation. Strict, it answers null for any flag but the read-only ones; lenient, it
 * steps over the others (`-i`, `-s`) and stops at a script read from a file (`-f`), which it does not read.
 */
function sedScripts(args: ReadonlyArray<string>, lenient: boolean): string[] | null {
	const scripts: string[] = [];
	let first: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			first ??= args[index + 1];
			break;
		}
		if (/^-[nErsuz]*e$/u.test(arg) || arg === "--expression") {
			scripts.push(args[index + 1] ?? "");
			index += 1;
		} else if (arg.startsWith("--expression=")) scripts.push(arg.slice("--expression=".length));
		else if (arg === "-l" || arg === "--line-length") index += 1;
		else if (arg.startsWith("-") && arg !== "-") {
			if (/^-[nErsuz]+$/u.test(arg) || SED_READ_FLAGS.has(arg) || arg.startsWith("--line-length=")) continue;
			if (!lenient) return null;
			if (/^-[A-Za-z]*f$/u.test(arg) || arg === "--file" || arg.startsWith("--file=")) return scripts;
		} else first ??= arg;
	}
	if (scripts.length === 0) {
		if (first === undefined) return null;
		scripts.push(first);
	}
	return scripts;
}

/**
 * A sed script made only of commands that print, edit the pattern space or branch. `w`, `W`, `e`, `r`, `R`, an `s`
 * flagged `w` or `e`, and anything this cannot parse answer false. A bracket expression in a regex may hold the
 * delimiter (`s/[/]/x/w out`, x4-3), so the scan steps over it whole (x5-5); an unclosed one answers false.
 */
function sedScriptOnlyReads(script: string): boolean {
	let index = 0;
	const at = () => script[index] ?? "";
	const skip = (pattern: RegExp) => {
		while (index < script.length && pattern.test(at())) index += 1;
	};
	// Past a bracket expression's `]`. A leading `]` (after an optional `^`) is literal, `[:class:]`, `[.x.]` and
	// `[=x=]` nest, and a backslash inside is literal, as GNU sed reads it.
	const bracket = (): boolean => {
		index += 1;
		if (at() === "^") index += 1;
		if (at() === "]") index += 1;
		while (index < script.length) {
			const char = at();
			const kind = script[index + 1] ?? "";
			if (char === "]") {
				index += 1;
				return true;
			}
			if (char === "[" && ".:=".includes(kind) && kind !== "") {
				const end = script.indexOf(`${kind}]`, index + 2);
				if (end < 0) return false;
				index = end + 2;
			} else index += 1;
		}
		return false;
	};
	const closes = (delimiter: string, regex = true): boolean => {
		while (index < script.length) {
			const char = at();
			if (regex && char === "[" && char !== delimiter) {
				if (!bracket()) return false;
				continue;
			}
			index += char === "\\" ? 2 : 1;
			if (char === delimiter) return true;
		}
		return false;
	};
	const address = (): boolean => {
		const char = at();
		if (/[0-9]/u.test(char)) skip(/[0-9~]/u);
		else if (char === "$") index += 1;
		else if (char === "/" || char === "\\") {
			const delimiter = char === "/" ? "/" : (script[index + 1] ?? "");
			index += char === "/" ? 1 : 2;
			if (delimiter === "" || !closes(delimiter)) return false;
			skip(/[IM]/u);
		}
		return true;
	};
	while (index < script.length) {
		skip(/[\s;]/u);
		if (index >= script.length) break;
		if (!address()) return false;
		if (at() === ",") {
			index += 1;
			if (at() === "+" || at() === "~") index += 1;
			if (!address()) return false;
		}
		skip(/[\s!]/u);
		const command = at();
		index += 1;
		if ("{}pPdDnNgGhHxzF=".includes(command) && command !== "") continue;
		if (command === "q" || command === "Q" || command === "l") skip(/[ \t0-9]/u);
		else if (command === "s" || command === "y") {
			const delimiter = at();
			if (delimiter === "" || delimiter === "\\" || delimiter === "\n") return false;
			index += 1;
			if (!closes(delimiter, command === "s") || !closes(delimiter, false)) return false;
			// `w` and `e` stop here and parse next as a command, which refuses them.
			if (command === "s") skip(/[gpiImM0-9]/u);
		} else if (command === "b" || command === "t" || command === "T" || command === ":" || command === "#")
			while (index < script.length && at() !== "\n" && (command === "#" || at() !== ";")) index += 1;
		else return false;
	}
	return true;
}

function awkOnlyReads(args: ReadonlyArray<string>): boolean {
	const programs = awkPrograms(args);
	// A comparison spelled `>` reads as a redirect here, which only costs a pass.
	return programs !== null && programs.every((program) => !/system|[|>@]/u.test(program));
}

/** The inline programs of an awk invocation, or null when it names a program file or a flag this cannot read. */
function awkPrograms(args: ReadonlyArray<string>): string[] | null {
	const programs: string[] = [];
	let first: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			first ??= args[index + 1];
			break;
		}
		if (arg === "-F" || arg === "-v" || arg === "--field-separator" || arg === "--assign") index += 1;
		else if (/^-[Fv]./u.test(arg) || arg.startsWith("--field-separator=") || arg.startsWith("--assign=")) continue;
		else if (arg === "-e" || arg === "--source") {
			programs.push(args[index + 1] ?? "");
			index += 1;
		} else if (arg.startsWith("--source=")) programs.push(arg.slice("--source=".length));
		else if (arg.startsWith("-") && arg !== "-") return null;
		else first ??= arg;
	}
	if (programs.length === 0) {
		if (first === undefined) return null;
		programs.push(first);
	}
	return programs;
}

const SED_NAMES: ReadonlySet<string> = new Set(["sed", "gsed"]);
const AWK_NAMES: ReadonlySet<string> = new Set(["awk", "gawk", "mawk", "nawk"]);

/** A sed `w`/`W` command or an `s` flagged `w`, and the file name it runs to the end of the line with. */
const SED_WRITE_FILE = /(?:^|[\s;{}!$0-9]|[/|#,:@%][gpiImMe0-9]*)[wW][ \t]+(\S[^\n]*)/gu;

/** An awk output redirect to a string literal: `print > "/etc/x"`, `printf ... >> "log"`. */
const AWK_WRITE_FILE = />>?[ \t]*"([^"\\\n]+)"/gu;

/**
 * Files a sed or awk script writes itself (LEAD-1): sed's `w`, `W` and `s///w`, and awk's `>` and `>>` to a string
 * literal. Only a script the read-only parsers above refuse is read, and it is read lexically, so text that merely
 * looks like such a command adds a target rather than hiding one. A program file (`sed -f`, `awk -f`) is not read.
 */
function collectScriptWriteTargets(name: string, args: ReadonlyArray<string>, out: string[]): void {
	if (SED_NAMES.has(name) && !sedOnlyReads(args)) {
		for (const script of sedScripts(args, true) ?? []) {
			for (const match of script.matchAll(SED_WRITE_FILE)) out.push((match[1] ?? "").trim());
		}
	} else if (AWK_NAMES.has(name) && !awkOnlyReads(args)) {
		for (const program of awkPrograms(args) ?? []) {
			for (const match of program.matchAll(AWK_WRITE_FILE)) out.push(match[1] ?? "");
		}
	}
}

function uniqOnlyReads(args: ReadonlyArray<string>): boolean {
	let operands = 0;
	let options = true;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (options && arg === "--") options = false;
		else if (options && ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"].includes(arg)) index += 1;
		else if (options && arg.startsWith("-") && arg !== "-") continue;
		else operands += 1;
	}
	return operands < 2;
}

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"branch",
	"ls-files",
	"rev-list",
	"describe",
	"cat-file",
	"ls-tree",
	"grep",
	"blame",
]);

/** Read-only git subcommands that only read objects and refs, so no configured helper program can run under them. */
const HELPER_FREE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["rev-parse", "rev-list", "ls-tree", "cat-file"]);

/** Git globals that take no value and change neither the repository nor a program Git runs (x6-2). */
const READ_ONLY_GIT_GLOBALS: ReadonlySet<string> = new Set([
	"--no-pager",
	"-P",
	"--no-optional-locks",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-replace-objects",
	"--no-lazy-fetch",
	"--no-advice",
]);

/**
 * Config keys a `git -c key=value` may set on a read-only step: display settings that name no program. Any other key
 * (`core.pager`, `alias.*`, `diff.external`, `*.textconv`, `core.fsmonitor`, `credential.*`, `include.path`) may run
 * one, so it is refused.
 */
const READ_ONLY_GIT_CONFIG_KEY =
	/^(?:color\.[^=]+|advice\.[^=.]+|column\.ui|core\.quotepath|core\.abbrev|diff\.(?:noprefix|mnemonicprefix|relative|renames|renamelimit|algorithm|indentheuristic|context|interhunkcontext|statgraphwidth)|log\.(?:decorate|abbrevcommit|date|follow)|status\.(?:short|branch|showuntrackedfiles|relativepaths)|grep\.(?:linenumber|patterntype|extendedregexp|column|fullname))$/u;

/** Helper config is probed at the recorder's cwd, so only selectors of that same checkout are transparent (x6). */
function sameGitDirectory(cwd: string | undefined, target: string, metadata = false): boolean {
	if (cwd === undefined || target === "" || /[~$`*?[\]{}]/u.test(target)) return false;
	const selected = canonicalizeRawPath(target, cwd);
	const expected = canonicalizeRawPath(metadata ? ".git" : ".", cwd);
	return selected !== null && expected !== null && path.relative(expected, selected) === "";
}

/** The git subcommand and its arguments past the read-only global options; null when a global may run or relocate. */
function gitSubcommand(
	args: ReadonlyArray<string>,
	gitCwd?: string,
): { subcommand: string; rest: ReadonlyArray<string> } | null {
	let index = 0;
	for (; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (READ_ONLY_GIT_GLOBALS.has(arg)) continue;
		if (arg === "-C") {
			if (!sameGitDirectory(gitCwd, args[index + 1] ?? "")) return null;
			index += 1;
			continue;
		}
		if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
			if (!sameGitDirectory(gitCwd, arg.slice(arg.indexOf("=") + 1), arg.startsWith("--git-dir="))) return null;
			continue;
		}
		if (arg !== "-c") break;
		const setting = args[index + 1] ?? "";
		const key = setting.split("=", 1)[0] ?? "";
		if (!READ_ONLY_GIT_CONFIG_KEY.test(key.toLowerCase()) || setting.includes("!")) return null;
		index += 1;
	}
	const subcommand = args[index];
	if (subcommand === undefined || subcommand.startsWith("-")) return null;
	return { subcommand, rest: args.slice(index + 1) };
}

/** `git cat-file` modes that print an object, its type or its size; `--textconv`, `--filters` and batches stay out. */
const READ_ONLY_CAT_FILE_FLAGS: ReadonlySet<string> = new Set(["-p", "-t", "-s", "-e"]);

/**
 * Where the repository's git config names a helper program (x1-3), `git status` and `git diff` refresh the index
 * and run `core.fsmonitor`, and `git log` and `git show` run an external diff or textconv driver unless both are
 * switched off.
 */
const GIT_HELPER_OPT_OUTS: ReadonlyArray<string> = ["--no-ext-diff", "--no-textconv"];

/** `git branch` flags that only list or name branches; any other argument creates, moves or deletes one. */
const READ_ONLY_GIT_BRANCH_FLAGS: ReadonlySet<string> = new Set([
	"-a",
	"--all",
	"-r",
	"--remotes",
	"-l",
	"--list",
	"-v",
	"-vv",
	"--verbose",
	"--show-current",
	"--no-color",
]);

function readOnlyInspectionStep(argv: ReadonlyArray<string>, gitHelpersConfigured: boolean, gitCwd?: string): boolean {
	const [executable, ...args] = argv;
	if (executable === undefined) return false;
	if (executable === "git") {
		const invocation = gitSubcommand(args, gitCwd);
		if (invocation === null || !READ_ONLY_GIT_SUBCOMMANDS.has(invocation.subcommand)) return false;
		const { subcommand, rest } = invocation;
		if (subcommand === "branch") return rest.every((arg) => READ_ONLY_GIT_BRANCH_FLAGS.has(arg));
		if (subcommand === "rev-parse") return true;
		if (rest.some((arg) => arg.startsWith("--output") || arg === "--ext-diff" || arg === "--textconv")) return false;
		if (subcommand === "cat-file")
			return (
				rest.some((arg) => READ_ONLY_CAT_FILE_FLAGS.has(arg)) &&
				rest.every((arg) => !arg.startsWith("-") || READ_ONLY_CAT_FILE_FLAGS.has(arg))
			);
		// `-O`/`--open-files-in-pager` hands the matches to a program, bundled (`-nOvim`) or not.
		if (subcommand === "grep" && rest.some((arg) => /^-[^-]*O/u.test(arg) || arg.startsWith("--open-files-in-pager")))
			return false;
		if (HELPER_FREE_GIT_SUBCOMMANDS.has(subcommand)) return true;
		if (!gitHelpersConfigured) return true;
		return (subcommand === "log" || subcommand === "show") && GIT_HELPER_OPT_OUTS.every((flag) => rest.includes(flag));
	}
	const filter = READ_ONLY_FILTERS.get(executable);
	if (filter !== undefined) return filter(args);
	const refused = READ_ONLY_INSPECTION_REFUSALS.get(executable);
	if (refused === undefined) return false;
	return !args.some((arg) => refused.some((option) => arg === option || arg.startsWith(`${option}=`)));
}

/**
 * How a shell command that runs a recognized check stands against the tree it leaves (x1-1). `pure`: every step is
 * that check, read-only inspection, shell setup (`cd`, `source`, `.`, `export`, `set`, a bare assignment) or output
 * plumbing, so the command changed no tree. `after-change`: every step that may change the tree runs before every
 * check, the last of them hands over through `&&`, `;` or a newline, and nothing but those and `|` joins the steps, so
 * the check judged the changed tree (`npm ci && npm test`, `git apply x.patch; npm test`; bt-46 S2). `mixed`: anything
 * else (`npm ci | npm test`, `npm test && node codemod.mjs`), whose check cannot speak for the tree the command left. A check that rewrites the tree
 * ({@link checkWritesTree}) is a change as well, so its own outcome never lands as a pass. Null when no step is a
 * recognized check.
 */
export type CheckCommandShape = "pure" | "after-change" | "mixed";

/**
 * Shell setup that changes the shell, not the tree (x3-1). `source` and `.` run a script, but the one sourced before a
 * check is an environment activation by convention; reading it as a change would let `source .venv/bin/activate &&
 * pytest tests/one.py` clear a standing red.
 */
const SHELL_SETUP_STEPS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "source", ".", "export", "set"]);

interface ShellStep {
	tokens: ShellToken[];
	argv: string[];
	index: number | null;
	/** The separator joining this step to the next; `""` where two separators meet, null for the last step. */
	joinedBy: string | null;
	/** Subshells `(` opened right before this step, and closed `)` right after it. */
	opens: number;
	closes: number;
}

function shellSteps(tokens: ReadonlyArray<ShellToken>): ShellStep[] {
	const steps: ShellStep[] = [];
	let current: ShellToken[] = [];
	let separator: string | null = null;
	let opens = 0;
	const endStep = () => {
		if (current.length === 0) return;
		const previous = steps.at(-1);
		if (previous !== undefined) previous.joinedBy = separator;
		separator = null;
		const argv = shellCommandArguments(current);
		steps.push({ tokens: current, argv, index: commandTokenIndex(argv), joinedBy: null, opens, closes: 0 });
		opens = 0;
		current = [];
	};
	for (const token of tokens) {
		if (token.operator && COMMAND_SEPARATORS.has(token.value)) {
			endStep();
			// A subshell's status is its last command's, so `(cd lib && make) && npm test` joins `make` to the check by `&&`.
			if (token.value === "(") opens += 1;
			else if (token.value === ")") {
				const last = steps.at(-1);
				if (opens > 0) opens -= 1;
				else if (last !== undefined) last.closes += 1;
			}
			if (token.value === "(" || token.value === ")") continue;
			// Two separators in a row (`) ;`) join no simple pair, so neither can hand a change to a check.
			separator = separator === null && steps.length > 0 ? token.value : "";
			continue;
		}
		current.push(token);
	}
	endStep();
	return steps;
}

/** One step of a shell command as {@link checkCommandShape} indexes it, for the declared-check reader (x7-5). */
export interface CommandStep {
	/** The step's words, its redirections left out. */
	argv: string[];
	/** Where its command starts past a leading `time` and the transparent wrappers (`timeout 600`, `nice`, `xvfb-run`). */
	command: number;
	/** The separator joining it to the next step; `""` where two meet, null for the last step. */
	joinedBy: string | null;
	/** No word is one the shell would rewrite: no expansion, substitution, glob or `~`. */
	literal: boolean;
	/** It opens or closes a subshell. */
	grouped: boolean;
}

export function commandSteps(command: string): CommandStep[] {
	return shellSteps(scanShellLike(command, true)).map((step) => {
		let start = 0;
		for (let past = -1; past !== start; ) {
			past = start;
			if (step.argv[start] === "time") start += step.argv[start + 1] === "-p" ? 2 : 1;
			start = pastTransparentWrapper(step.argv, start);
		}
		const literal = shellCommandWords(step.tokens).every((token) => {
			if (token.substitutions?.length || token.hiddenContent || token.ansiCQuoted || token.homeRelative) return false;
			const raw = command.slice(token.start, token.end);
			if (/[$`]/u.test(raw) && !/^'[^']*'$/u.test(raw)) return false;
			return token.quoted || !/[*?[]/u.test(token.value);
		});
		return {
			argv: step.argv,
			command: start,
			joinedBy: step.joinedBy,
			literal,
			grouped: step.opens > 0 || step.closes > 0,
		};
	});
}

function isCheckStep(step: ShellStep): boolean {
	return step.index !== null && checkStepMatch(basenameToken(step.argv[step.index]), step.argv.slice(step.index + 1));
}

function checkStepMatch(executable: string, args: ReadonlyArray<string>): boolean {
	return validationMatch(executable, args) !== null || readOnlyCheckMatch(executable, args);
}

/**
 * What one command, or one step of a shell command, does to the tree, as the call classifier
 * (`check-classifier.ts`) reads it: `check` runs a recognized check, `inspection` only reads, `mutation` provably or
 * plausibly writes, and `unknown` cannot be told apart.
 */
export type CommandVerdict = "check" | "inspection" | "mutation" | "unknown";

/** Package-manager subcommands that install, remove or rewrite the project's dependencies or manifest. */
const PACKAGE_WRITES: ReadonlySet<string> = new Set([
	"install",
	"i",
	"ci",
	"add",
	"remove",
	"rm",
	"uninstall",
	"un",
	"update",
	"up",
	"upgrade",
	"link",
	"unlink",
	"rebuild",
	"dedupe",
	"prune",
	"init",
	"create",
	"version",
	"import",
	"patch",
]);

/** Commands whose run writes, moves, removes or re-permissions files whatever their operands. */
const FILE_WRITERS: ReadonlySet<string> = new Set([
	"cp",
	"mv",
	"rm",
	"rmdir",
	"mkdir",
	"touch",
	"ln",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
	"patch",
	"dd",
	"install",
	"rsync",
	"unzip",
	"tar",
	"shred",
	"unlink",
	"tee",
	"wget",
]);

/** Toolchain subcommands that write the tree: dependency edits, generators and in-place formatters. */
const TOOLCHAIN_WRITES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["cargo", new Set(["add", "remove", "fix", "install", "update", "generate-lockfile"])],
	["go", new Set(["generate", "get", "mod", "install", "work"])],
	["uv", new Set(["add", "remove", "sync", "lock", "pip"])],
	["poetry", new Set(["add", "remove", "install", "update", "lock"])],
	["pip", new Set(["install", "uninstall"])],
	["pip3", new Set(["install", "uninstall"])],
]);

/** Formatters that rewrite what they read unless told only to check or diff. */
const CHECKABLE_FORMATTERS: ReadonlySet<string> = new Set(["black", "isort", "rustfmt"]);

/** isort's own spellings of check-only mode (x10-2). */
function isortCheckFlag(arg: string): boolean {
	return arg === "--check-only" || arg === "--check" || arg === "-c";
}

/** Interpreter flags that run a script given on the command line. */
const INLINE_SCRIPT_FLAGS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["node", ["-e", "--eval", "-p", "--print"]],
	["bun", ["-e", "--eval", "-p", "--print"]],
	["perl", ["-e", "-E", "-i", "-pi", "-pie"]],
	["ruby", ["-e", "-i"]],
]);

/**
 * A step outside the check and inspection sets that provably or plausibly writes: git beyond read-only inspection
 * (hooks and helpers included), an install, a file writer, a read-only filter or inspection command its own options
 * turned into a writer or runner, an emitting `tsc`, a runner updating snapshots or fixing, an inline script
 * (`node -e`, `python -c`), a formatter in write mode, or a check whose name or flags rewrite the tree
 * ({@link checkWritesTree}). Anything else is unknown.
 */
function writerStep(executable: string, args: ReadonlyArray<string>): boolean {
	if (executable === "git" || FILE_WRITERS.has(executable)) return true;
	if (READ_ONLY_FILTERS.has(executable) || READ_ONLY_INSPECTION_REFUSALS.has(executable)) return true;
	if (executable === "tsc" || READ_ONLY_RUNNERS.has(executable)) return true;
	if (executable === "npx") {
		if (args.some((arg) => arg === "-c" || arg === "--call" || arg.startsWith("--call="))) return true;
		const inner = npxInvocation(args);
		return inner !== null && writerStep(inner.executable, inner.args);
	}
	if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "bun") {
		// A read-only check behind `exec` is the check, not a writer (`npm exec vitest run`).
		const exec = packageExecInvocation(executable, args);
		if (exec !== null) return !readOnlyCheckMatch(exec.executable, exec.args) && writerStep(exec.executable, exec.args);
		if (args[0] === "dlx" && typeof args[1] === "string" && !args[1].startsWith("-"))
			return writerStep(basenameToken(args[1]), args.slice(2));
		if (args[0] !== undefined && PACKAGE_WRITES.has(args[0])) return true;
		// `pnpm prettier -w .` runs the writer `pnpm exec prettier -w .` does (x10-4); anything else falls through, so a
		// write-capable script name (`pnpm format`) still writes.
		const bin = packageBinInvocation(executable, args);
		if (bin !== null && !readOnlyCheckMatch(bin.executable, bin.args) && writerStep(bin.executable, bin.args))
			return true;
	}
	if (TOOLCHAIN_WRITES.get(executable)?.has(args[0] ?? "") === true) return true;
	if (isPythonExecutable(executable)) {
		const module = pythonToolModule(executable, args);
		return (
			args.includes("-c") ||
			(moduleArg(args) === "pip" && args.some((arg) => PACKAGE_WRITES.has(arg))) ||
			(module !== null && writerStep(module.executable, module.args))
		);
	}
	const inline = INLINE_SCRIPT_FLAGS.get(executable);
	if (inline?.some((flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) === true) return true;
	const checksOnly = args.some(
		(arg) =>
			arg === "--check" ||
			arg === "--diff" ||
			arg.startsWith("--check=") ||
			(executable === "isort" && isortCheckFlag(arg)),
	);
	if (CHECKABLE_FORMATTERS.has(executable)) return !checksOnly;
	if ((executable === "cargo" || executable === "go") && args[0] === "fmt") return !checksOnly;
	if (executable === "ruff" && args[0] === "format") return !checksOnly;
	if (executable === "clang-format" || executable === "autopep8")
		return args.some((arg) => arg === "-i" || arg === "--in-place");
	if (executable === "curl")
		return args.some((arg) => /^-[a-zA-Z]*[oO]/u.test(arg) || arg.startsWith("--output") || arg === "--remote-name");
	return checkWritesTree([executable, ...args]);
}

/** Do not reuse the recorder's Git config after shell setup can change cwd, environment or command lookup. */
function shellGitCwd(steps: ReadonlyArray<ShellStep>, cwd: string | undefined): string | undefined {
	if (cwd === undefined) return undefined;
	return steps.some((step) => {
		const executable = step.index === null ? "" : (step.argv[step.index] ?? "");
		return (
			executable === "export" ||
			LIST_BENDING_BUILTINS.has(executable) ||
			SHELL_STATE_BUILTINS.has(executable) ||
			COMPOUND_COMMAND_WORDS.has(executable) ||
			(step.index === null && step.argv.length > 0)
		);
	})
		? undefined
		: cwd;
}

/** A prefixed Git step or a hidden shell word can select a different repository than its visible argv. */
function stepGitCwd(step: ShellStep, cwd: string | undefined): string | undefined {
	return cwd !== undefined &&
		step.index === 0 &&
		step.argv[0] === "git" &&
		!step.tokens.some((token) => token.hiddenContent || token.unterminated || token.substitutions || token.ansiCQuoted)
		? cwd
		: undefined;
}

/** A step outside any recognized check: setup and inspection only read, a known writer writes, the rest is unknown. */
function stepVerdict(argv: ReadonlyArray<string>, gitHelpersConfigured: boolean, gitCwd?: string): CommandVerdict {
	const [first] = argv;
	if (first === undefined) return "inspection";
	if (SHELL_SETUP_STEPS.has(first)) return first === "source" || first === "." ? "unknown" : "inspection";
	if (readOnlyInspectionStep(argv, gitHelpersConfigured, gitCwd)) return "inspection";
	return writerStep(basenameToken(first), argv.slice(1)) ? "mutation" : "unknown";
}

/**
 * The verdict of one shell command, the bash half of the call classifier: `check` when any step runs a recognized
 * check (its {@link checkCommandShape} then says whether the call also changed the tree), `mutation` when it names a
 * write or delete target or any step is a known writer, `inspection` when every step, substitution and inline script
 * only reads, and `unknown` otherwise. A check inside a substitution or an inline shell is not this call's check, so
 * there it reads as unknown.
 */
export function shellCommandVerdict(
	command: string,
	gitHelpersConfigured: boolean,
	recorderCwd?: string,
	depth = 0,
): CommandVerdict {
	const tokens = scanShellLike(command, true);
	const steps = shellSteps(tokens);
	if (steps.length === 0) return "unknown";
	if (steps.some(isCheckStep)) return "check";
	if (extractCommandWriteTargets(command).length > 0 || extractCommandDeleteTargets(command).length > 0)
		return "mutation";
	const gitCwd = shellGitCwd(steps, recorderCwd);
	const nested = (script: string | undefined): CommandVerdict => {
		if (script === undefined || depth >= INNER_SHELL_MAX_DEPTH) return "unknown";
		const verdict = shellCommandVerdict(script, gitHelpersConfigured, undefined, depth + 1);
		return verdict === "check" ? "unknown" : verdict;
	};
	const join = (a: CommandVerdict, b: CommandVerdict): CommandVerdict =>
		a === "mutation" || b === "mutation" ? "mutation" : a === "unknown" || b === "unknown" ? "unknown" : "inspection";
	let verdict: CommandVerdict = "inspection";
	for (const step of steps) {
		for (const token of step.tokens) {
			if (token.hiddenContent === true || token.unterminated === true) verdict = join(verdict, "unknown");
			for (const script of token.substitutions ?? []) verdict = join(verdict, nested(script));
		}
		const script = segmentShellScript(step.argv);
		const argv = step.index === null ? [] : step.argv.slice(step.index);
		const inline = script === null ? inlinePythonVerdict(command, step) : null;
		verdict = join(
			verdict,
			inline ?? (script === null ? stepVerdict(argv, gitHelpersConfigured, stepGitCwd(step, gitCwd)) : nested(script)),
		);
		if (verdict === "mutation") return verdict;
	}
	return verdict;
}

/** A write-mode `open`, a file-writing or deleting call, or a call that runs a program or code. */
const PYTHON_WRITE_SHAPE =
	/\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?[rbuf]*['"][rbt]*[wax+]|\b(?:write_text|write_bytes|remove|unlink|rmdir|rmtree|rename|makedirs|mkdir|touch|truncate|copyfile|copytree|move|chmod|symlink|system|popen|subprocess|exec|eval)\b/u;

/** Interpreter flags that change neither where a script comes from nor what it may import. */
const PLAIN_PYTHON_FLAGS: ReadonlySet<string> = new Set(["-B", "-E", "-I", "-O", "-OO", "-P", "-q", "-s", "-S", "-u"]);

/**
 * The verdict of a step that runs an inline Python script (c17-a): `python3 -c '<script>'`, or `python3 -` / bare
 * `python3` reading the one quoted here-document its line opens. A change when the literal script shows a
 * write-shaped operation ({@link PYTHON_WRITE_SHAPE}), unknown otherwise: it neither settles nor retires a recorded
 * outcome. A stdin script no reader can see is a change. Null for any other step, including one behind an
 * environment prefix.
 */
function inlinePythonVerdict(command: string, step: ShellStep): CommandVerdict | null {
	if (step.index !== 0 || !isPythonExecutable(basenameToken(step.argv[0]))) return null;
	const words = shellCommandWords(step.tokens);
	let index = 1;
	while (PLAIN_PYTHON_FLAGS.has(step.argv[index] ?? "")) index += 1;
	const reads = (script: string): CommandVerdict => (PYTHON_WRITE_SHAPE.test(script) ? "mutation" : "unknown");
	if (step.argv[index] === "-c") {
		const word = words[index + 1];
		if (word === undefined) return null;
		const raw = command.slice(word.start, word.end);
		const literal =
			(word.substitutions?.length ?? 0) === 0 &&
			word.hiddenContent !== true &&
			word.unterminated !== true &&
			(/^'[^']*'$/u.test(raw) || !/[$`\\]/u.test(raw));
		return literal ? reads(word.value) : "mutation";
	}
	if (index < step.argv.length && step.argv[index] !== "-") return null;
	const first = step.tokens[0];
	const last = step.tokens.at(-1);
	if (first === undefined || last === undefined || step.tokens.some((token) => token.operator)) return "mutation";
	const lineEnd = command.indexOf("\n", last.end);
	const head = /^[ \t]*<<[ \t]*(?:'(\w+)'|"(\w+)"|(\w+))[ \t]*$/u.exec(
		command.slice(last.end, lineEnd === -1 ? command.length : lineEnd),
	);
	const body = cachedShellScan(command, true).bodies.find((candidate) => candidate.start === lineEnd + 1);
	if (head === null || body === undefined || command.slice(first.start, last.end).includes("<<")) return "mutation";
	const word = head[1] ?? head[2] ?? head[3] ?? "";
	const lines = command.slice(body.start, body.end).replace(/\n$/u, "").split("\n");
	if (lines.pop() !== word) return "mutation";
	const script = lines.join("\n");
	return head[3] !== undefined && /[$`\\]/u.test(script) ? "mutation" : reads(script);
}

/** Writers whose every write is a target {@link extractCommandWriteTargets} or {@link extractCommandDeleteTargets} names. */
const NAMED_TARGET_WRITERS: ReadonlySet<string> = new Set(["tee", "mkdir", "touch", "rm", "cp"]);

/**
 * Whether a command writes only the targets the write and delete extractors name (x7-1): every step only reads, is
 * a bare redirect, or is a writer whose targets those extractors list in full. A here-document body is data unless a
 * shell or interpreter reads it, and either of those, git, a substitution or an inline script stays unenumerable.
 */
export function shellWritesOnlyNamedTargets(
	command: string,
	gitHelpersConfigured: boolean,
	recorderCwd?: string,
): boolean {
	const steps = shellSteps(scanShellLike(command, true));
	if (steps.length === 0) return false;
	const gitCwd = shellGitCwd(steps, recorderCwd);
	return steps.every((step) => {
		if (step.tokens.some((token) => token.substitutions?.length || token.hiddenContent || token.unterminated))
			return false;
		if (segmentShellScript(step.argv) !== null) return false;
		const argv = step.index === null ? [] : step.argv.slice(step.index);
		if (argv.length === 0 || NAMED_TARGET_WRITERS.has(basenameToken(argv[0]))) return true;
		return stepVerdict(argv, gitHelpersConfigured, stepGitCwd(step, gitCwd)) === "inspection";
	});
}

/** Runners that read the tree and write none of it, unless told to update snapshots or fix what they find. */
const READ_ONLY_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest", "mocha", "eslint"]);

/** Runners that run their operand in the project's environment; the operand is what runs (x8-2). */
const ENVIRONMENT_RUNNERS: ReadonlyMap<string, string> = new Map([
	["uv", "run"],
	["poetry", "run"],
	["pipenv", "run"],
	["hatch", "run"],
	["pdm", "run"],
	["rye", "run"],
	["bundle", "exec"],
]);

/** The command `uv run`, `poetry run`, `bundle exec` and the like run, past their own flags; null for anything else. */
function environmentRunnerInvocation(
	executable: string,
	args: ReadonlyArray<string>,
): { executable: string; args: ReadonlyArray<string> } | null {
	if (args[0] === undefined || ENVIRONMENT_RUNNERS.get(executable) !== args[0]) return null;
	const inner = args.findIndex((arg, index) => index > 0 && !arg.startsWith("-"));
	return inner < 0 ? null : { executable: basenameToken(args[inner]), args: args.slice(inner + 1) };
}

/** Make targets that run a check, read like the opaque `npm test` and `npm run lint` scripts (x8-2). */
const MAKE_CHECK_TARGETS: ReadonlySet<string> = new Set(["test", "check", "lint"]);

/** `make test`, `make -s lint`, `make -j 4 test check`: only check targets, behind output and parallelism flags. */
function makeCheckMatch(args: ReadonlyArray<string>): boolean {
	let targets = 0;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-j" || arg === "--jobs") {
			if (/^\d+$/u.test(args[index + 1] ?? "")) index += 1;
			continue;
		}
		// `make -C dir test` runs dir's target; checkReachesOutside holds dir to the workspace (SF-2).
		if (arg === "-C" || arg === "--directory") {
			if (args[index + 1] === undefined) return false;
			index += 1;
			continue;
		}
		if (/^-C./u.test(arg) || arg.startsWith("--directory=")) continue;
		if (/^(?:-s|--silent|--quiet|-k|--keep-going|-j\d+|--jobs=\d+)$/u.test(arg)) continue;
		if (arg.startsWith("-")) return false;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)) continue;
		if (!MAKE_CHECK_TARGETS.has(arg)) return false;
		targets += 1;
	}
	return targets > 0;
}

/**
 * Read-only checks of other ecosystems by their subcommand (x8-2): cargo check, clippy, build and `insta test`, go vet
 * and build (whose binary the output reader judges, {@link checkReportTargets}), `gofmt -l`, mypy, pyright, pylint, flake8, ruff check, `prettier --check`, the format checks
 * `black --check`, `isort --check-only`, `ruff format --check`, `cargo fmt --check` and `rustfmt --check` (x10-2),
 * `golangci-lint run`, staticcheck (x10-3), biome check and lint,
 * dotnet test, rspec, phpunit, composer test, deno test, check and lint, playwright test, cypress run, tox, nox, hatch
 * test, rake test, `python manage.py test`, `php artisan test` and make's check targets. An option that writes what they read (`--fix`, `--write`, `-w`, a
 * snapshot update, mypy's `--install-types`, ruff's `--add-noqa`, biome's `--apply`) or a tox or nox environment named
 * as a writer (`-e format`) keeps the run out of the set.
 */
function ecosystemCheckMatch(executable: string, args: ReadonlyArray<string>): boolean {
	const has = (pattern: RegExp) => args.some((arg) => pattern.test(arg));
	const subcommand = args[0] ?? "";
	let matched: boolean;
	switch (executable) {
		case "cargo":
			matched =
				subcommand === "check" ||
				subcommand === "clippy" ||
				subcommand === "build" ||
				// `cargo insta test` writes only pending `.snap.new` files beside a red; its accept forms are writers (SF-2).
				(subcommand === "insta" && args[1] === "test") ||
				(subcommand === "fmt" && args.includes("--check"));
			break;
		case "go":
			matched = subcommand === "vet" || subcommand === "build";
			break;
		case "gofmt":
			matched = has(/^-[ld]$/u);
			break;
		case "mypy":
			matched = !has(/^--install-types/u);
			break;
		case "pylint":
		case "flake8":
		case "staticcheck":
			matched = true;
			break;
		case "golangci-lint":
			matched = subcommand === "run";
			break;
		case "pyright":
			matched = !has(/^--(?:createstub|writebaseline)/u);
			break;
		case "ruff":
			matched = (subcommand === "check" && !has(/^--add-noqa/u)) || (subcommand === "format" && args.includes("--check"));
			break;
		case "black":
		case "rustfmt":
			matched = args.includes("--check");
			break;
		case "isort":
			matched = args.some(isortCheckFlag);
			break;
		case "prettier":
			matched = has(/^(?:--check|-c|--list-different|-l)$/u);
			break;
		case "biome":
			matched = (subcommand === "check" || subcommand === "lint") && !has(/^--apply/u);
			break;
		case "dotnet":
		case "composer":
		case "hatch":
		case "playwright":
			matched = subcommand === "test";
			break;
		case "rspec":
			matched = !args.includes("--init");
			break;
		case "phpunit":
			matched = !has(/^--(?:generate|migrate)-/u);
			break;
		case "deno":
			matched = subcommand === "test" || subcommand === "check" || subcommand === "lint";
			break;
		case "cypress":
			matched = subcommand === "run";
			break;
		case "tox":
		case "nox":
			// An environment or session named as a writer (`-e format`, `-s lint_fix`) is excluded by checkWritesTree below.
			matched = true;
			break;
		case "rake":
			matched = subcommand === "test";
			break;
		case "make":
			matched = makeCheckMatch(args);
			break;
		default:
			matched =
				((isPythonExecutable(executable) && basenameToken(args[0]) === "manage.py") ||
					(executable === "php" && basenameToken(args[0]) === "artisan")) &&
				args[1] === "test";
	}
	return matched && !args.some(writesSnapshots) && !checkWritesTree([executable, ...args]);
}

/**
 * The closed read-only half of the check vocabulary (x5-1): `tsc --noEmit`, `node --check`, `node --test`, and
 * vitest, jest, mocha or eslint, bare or behind `npx`, `npm|pnpm|yarn|bun exec` or `pnpm|yarn <bin>`, the other
 * ecosystems' read-only checks ({@link ecosystemCheckMatch}), also as `python -m <tool>`, and any check behind `uv
 * run`, `poetry run` or `bundle exec`. A snapshot update,
 * `--fix`, `node -e` and a bare `tsc` that emits stay outside it, so they remain changes that retire earlier passes.
 */
function readOnlyCheckMatch(executable: string, args: ReadonlyArray<string>): boolean {
	const wrapped = environmentRunnerInvocation(executable, args);
	if (wrapped !== null) return checkStepMatch(wrapped.executable, wrapped.args);
	const module = pythonToolModule(executable, args);
	if (module !== null) return readOnlyCheckMatch(module.executable, module.args);
	if (ecosystemCheckMatch(executable, args)) return true;
	if (executable === "npx") {
		if (args.some((arg) => arg === "-c" || arg === "--call" || arg.startsWith("--call="))) return false;
		const inner = npxInvocation(args);
		return inner !== null && inner.executable !== "node" && readOnlyCheckMatch(inner.executable, inner.args);
	}
	const exec = packageExecInvocation(executable, args) ?? packageBinInvocation(executable, args);
	if (exec !== null) return exec.executable !== "node" && readOnlyCheckMatch(exec.executable, exec.args);
	if (executable === "tsc") return args.some((arg) => arg.toLowerCase() === "--noemit");
	if (executable === "node")
		return (
			args.some((arg) => arg === "--test" || arg === "--check" || arg === "-c") &&
			!args.some((arg) => isRuntimeLoaderFlag(arg) || arg === "-p" || arg.startsWith("--print") || writesSnapshots(arg))
		);
	if (!READ_ONLY_RUNNERS.has(executable)) return false;
	return !args.some((arg) => writesSnapshots(arg) || arg.startsWith("--fix"));
}

/** Runtime options that load or evaluate code of their own beside the check they ride on. */
const RUNTIME_LOADER_FLAGS: ReadonlyArray<string> = [
	"--import",
	"--require",
	"--loader",
	"--experimental-loader",
	"--eval",
];

function isRuntimeLoaderFlag(arg: string): boolean {
	return arg === "-r" || arg === "-e" || RUNTIME_LOADER_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

/** Options that make a test runner rewrite its own snapshots or goldens instead of comparing against them (x7-2). */
const SNAPSHOT_WRITE_FLAGS: ReadonlySet<string> = new Set([
	"-u",
	"--test-update-snapshots",
	"--snapshot-update",
	"--force-regen",
	"--regen-all",
]);

/**
 * A test runner's option that rewrites its snapshots or goldens: `-u`, `--update*` (`--update-goldens` included), Go's
 * single-dash `-update`, node's `--test-update-snapshots`, syrupy's `--snapshot-update`, pytest-regressions'
 * `--force-regen` and `--regen-all`.
 */
function writesSnapshots(arg: string): boolean {
	return SNAPSHOT_WRITE_FLAGS.has(arg) || arg.startsWith("--update") || /^-update(?:=|$)/u.test(arg);
}

/** Runners whose `test` subcommand runs the tests, with the runner's own options after it. */
const TEST_SUBCOMMAND_RUNNERS: ReadonlySet<string> = new Set(["go", "bun", "deno", "playwright"]);

/**
 * The arguments a validated test runner reads its own options from, or null for any other command: `go test`,
 * `pytest`, `python -m pytest`, `bun test`, `deno test`, `playwright test` and `cargo insta` (x7-2, x8-2);
 * {@link checkWritesTree} unwraps `uv run` first.
 */
function testRunnerArgs(executable: string, args: ReadonlyArray<string>): ReadonlyArray<string> | null {
	if (executable === "pytest" || executable === "py.test") return args;
	if (isPythonExecutable(executable) && moduleArg(args) === "pytest") return args;
	if (TEST_SUBCOMMAND_RUNNERS.has(executable) && args[0] === "test") return args.slice(1);
	return null;
}

/**
 * `isOutput` says a redirect or `tee` target is a log the check's output lands in, not part of the tree (x4-2), so
 * `npm test 2>&1 | tee test.log` stays pure; it is asked only of commands that run a check. `declaredSteps` are the
 * indices of steps that run a declared check (x7-5), which count as check steps. `stepWritesTree` reads a writer step
 * other than a check by its own text, so one that writes only named targets outside the workspace (`cp lcov.info
 * /tmp/`) changes no tree, as the same mutation alone does not (x7-1, x8-5).
 */
export function checkCommandShape(
	command: string,
	gitHelpersConfigured: boolean,
	isOutput: (target: string) => boolean = () => false,
	declaredSteps: ReadonlySet<number> = new Set(),
	stepWritesTree: (step: string) => boolean = () => true,
	/** The directory the check runs in ({@link checkLogTargets}). */
	directory = "",
	recorderCwd?: string,
): CheckCommandShape | null {
	const tokens = scanShellLike(command, true);
	const parsed = shellSteps(tokens);
	const gitCwd = shellGitCwd(parsed, recorderCwd);
	const isCheck = (step: ShellStep, index: number) => isCheckStep(step) || declaredSteps.has(index);
	if (!parsed.some(isCheck)) return null;
	const steps = parsed.map((step, index) => {
		const writes: string[] = [];
		collectRedirectTargets(step.tokens, writes);
		const check = isCheck(step, index);
		const argv = step.index === null ? [] : step.argv.slice(step.index);
		// A report, coverage directory or binary the check writes by its own options is judged as its logs are (SF-2).
		if (check) writes.push(...checkReportTargets(argv, directory));
		const readOnly =
			step.index === null ||
			(check && !checkWritesTree(argv) && !updatesGoldensByEnv(step.argv.slice(0, step.index))) ||
			SHELL_SETUP_STEPS.has(argv[0] ?? "") ||
			(basenameToken(argv[0]) === "tee" && pathArgs(argv, 0).every(isOutput)) ||
			readOnlyInspectionStep(argv, gitHelpersConfigured, stepGitCwd(step, gitCwd));
		const changes = readOnly
			? writes.some((target) => isInterestingWriteTarget(target) && !isOutput(target))
			: check || stepWritesTree(command.slice(step.tokens[0]?.start ?? 0, step.tokens.at(-1)?.end ?? 0));
		return { check, changes, joinedBy: step.joinedBy };
	});
	const opaque =
		tokens.some((token) => token.substitutions !== undefined || token.hiddenContent === true || token.unterminated) ||
		hasUnparsedShellScript(command);
	if (opaque) return "mixed";
	let lastChange = steps.length - 1;
	while (lastChange >= 0 && steps[lastChange]?.changes !== true) lastChange -= 1;
	if (lastChange === -1) return "pure";
	const sequential = (joinedBy: string | null | undefined) => joinedBy === "&&" || joinedBy === ";";
	const handsOver =
		sequential(steps[lastChange]?.joinedBy) &&
		steps.every((step) => step.joinedBy === null || step.joinedBy === "|" || sequential(step.joinedBy)) &&
		!steps.slice(0, lastChange + 1).some((step) => step.check);
	return handsOver ? "after-change" : "mixed";
}

/**
 * The targets only a check pipeline's own output stream writes (x5-4): a `tee` stage after the check and the last
 * stage's redirects, so `npm test 2>&1 | tee out.txt` and `npm test > out.txt 2>&1` name `out.txt`. Whether such a
 * target is output and not a change is the caller's call. `declaredSteps` count as check steps, as in
 * {@link checkCommandShape}.
 */
export function checkLogTargets(
	command: string,
	declaredSteps: ReadonlySet<number> = new Set(),
	/** The directory the check runs in, which names the binary `go build` leaves there ({@link checkReportTargets}). */
	directory = "",
): ReadonlySet<string> {
	const logs = new Set<string>();
	let checked = false;
	for (const [index, step] of shellSteps(scanShellLike(command, true)).entries()) {
		const check = isCheckStep(step) || declaredSteps.has(index);
		checked ||= check;
		const argv = step.index === null ? [] : step.argv.slice(step.index);
		if (check) for (const target of checkReportTargets(argv, directory)) logs.add(target);
		if (checked && basenameToken(argv[0]) === "tee") for (const target of pathArgs(argv, 0)) logs.add(target);
		if (step.joinedBy === "|") continue;
		if (checked) {
			const writes: string[] = [];
			collectRedirectTargets(step.tokens, writes);
			for (const target of writes) logs.add(target);
		}
		checked = false;
	}
	return logs;
}

/** Default files pytest-cov writes for a `--cov-report` kind named without a destination. */
const COV_REPORT_DEFAULTS: ReadonlyMap<string, string> = new Map([
	["html", "htmlcov"],
	["xml", "coverage.xml"],
	["json", "coverage.json"],
	["lcov", "coverage.lcov"],
]);

/** `go build` options that take the next word as their value. */
const GO_BUILD_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-o",
	"-p",
	"-C",
	"-tags",
	"-ldflags",
	"-gcflags",
	"-asmflags",
	"-mod",
	"-modfile",
	"-overlay",
	"-pkgdir",
	"-buildmode",
	"-compiler",
	"-installsuffix",
	"-toolexec",
	"-pgo",
	"-coverpkg",
	"-covermode",
]);

/**
 * The files a check step writes through its own options (SF-2), for the caller's output reader to judge as it judges a
 * log: a gitignored or newly made untracked target stays output, a tracked or older one is a change. They are an ESLint
 * report (`-o`, `--output-file`), a coverage directory (`--coverage` in any spelling, jest's `--coverageDirectory`,
 * vitest's `--coverage.reportsDirectory`), pytest-cov's `.coverage` and `--cov-report` files, `go test -coverprofile`
 * and `-o`, and the binary `go build` leaves unless it builds several packages: its `-o`, its one package's or `.go`
 * file's name, or for the package in `directory` that directory's name. Without a `directory` that last binary is `.`,
 * the tree itself, so it is a change.
 */
function checkReportTargets(argv: ReadonlyArray<string>, directory: string): string[] {
	const targets: string[] = [];
	const valueAt = (index: number, name: string): string | undefined => {
		const arg = argv[index];
		return arg === name ? argv[index + 1] : arg?.startsWith(`${name}=`) === true ? arg.slice(name.length + 1) : undefined;
	};
	const eslint = argv.findIndex((word) => basenameToken(word) === "eslint");
	let coverage = false;
	let coverageDirectory: string | undefined;
	for (const [index, arg] of argv.entries()) {
		if (/^--(?:coverage(?:\.enabled)?|collectCoverage)(?:=true)?$/u.test(arg)) coverage = true;
		coverageDirectory =
			valueAt(index, "--coverageDirectory") ?? valueAt(index, "--coverage.reportsDirectory") ?? coverageDirectory;
		const report = eslint >= 0 && index > eslint ? (valueAt(index, "-o") ?? valueAt(index, "--output-file")) : undefined;
		if (report !== undefined) targets.push(report);
		if (arg === "--cov" || arg.startsWith("--cov=")) targets.push(".coverage");
		const covReport = valueAt(index, "--cov-report");
		if (covReport !== undefined) {
			const [kind = "", destination] = covReport.split(":");
			const target = destination || COV_REPORT_DEFAULTS.get(kind);
			if (target !== undefined) targets.push(target);
		}
	}
	if (coverage) targets.push(coverageDirectory ?? "coverage");
	const go = argv.findIndex((word) => basenameToken(word) === "go");
	const subcommand = go >= 0 ? argv[go + 1] : undefined;
	if (subcommand === "test")
		for (let index = go + 2; index < argv.length; index += 1) {
			const target = valueAt(index, "-coverprofile") ?? valueAt(index, "-o");
			if (target !== undefined) targets.push(target);
		}
	if (subcommand === "build") {
		const operands: string[] = [];
		let output: string | undefined;
		for (let index = go + 2; index < argv.length; index += 1) {
			const arg = argv[index] ?? "";
			if (!arg.startsWith("-")) {
				operands.push(arg);
				continue;
			}
			const name = arg.replace(/^--/u, "-").split("=")[0] ?? "";
			if (name === "-o") output = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1];
			if (!arg.includes("=") && GO_BUILD_VALUE_OPTIONS.has(name)) index += 1;
		}
		const [first] = operands;
		const files = operands.length > 0 && operands.every((operand) => operand.endsWith(".go"));
		if (output !== undefined) targets.push(output);
		else if (first !== undefined && files) targets.push(path.basename(first, ".go"));
		else if (first === undefined || first === "." || first === "./")
			targets.push(operands.length > 1 || directory === "" ? "." : path.basename(directory));
		else if (operands.length === 1 && !first.includes("...")) targets.push(path.basename(first));
	}
	return targets;
}

/**
 * Environment settings that make a test run rewrite its snapshots or goldens instead of comparing against them
 * (`UPDATE_GOLDEN=1 go test`, `INSTA_UPDATE=always cargo test`, `UPDATE_SNAPSHOTS=1 npm test`, SF-2): a name with an
 * update word and a snapshot word set to anything but an off value, insta's `always`/`unseen` and its force-pass, and
 * trybuild's `overwrite`. `NO_UPDATE_NOTIFIER` and the like name no snapshot, so they stay setup.
 */
function updatesGoldensByEnv(prefix: ReadonlyArray<string>): boolean {
	return prefix.some((word) => {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(word);
		if (match === null) return false;
		const name = (match[1] ?? "").toUpperCase();
		const value = (match[2] ?? "").replace(/^["']|["']$/gu, "");
		if (/^(?:|0|false|no|off)$/iu.test(value)) return false;
		if (name === "INSTA_UPDATE") return value === "always" || value === "unseen";
		if (name === "INSTA_FORCE_PASS") return true;
		if (name === "TRYBUILD") return value === "overwrite";
		const parts = name.split("_");
		return (
			parts.some((part) => /^(?:UPDATE|REGEN|REGENERATE|BLESS|ACCEPT|OVERWRITE|RECORD)$/u.test(part)) &&
			parts.some((part) =>
				/^(?:SNAPSHOTS?|SNAPS?|GOLDENS?|GOLD|EXPECT|EXPECTED|EXPECTATIONS?|FIXTURES?|BASELINES?)$/u.test(part),
			)
		);
	});
}

/** {@link isWriteCapableScriptName} with `_` read as a separator too, so `nox -s lint_fix` names a writer (SF-2). */
function isWriterName(name: string): boolean {
	return isWriteCapableScriptName(name.replace(/_/gu, "-"));
}

/** Flags that turn a linter or formatter into a writer of the files it checks. */
const TREE_WRITING_FLAGS: ReadonlySet<string> = new Set(["--fix", "--write"]);
/** Formatters whose `-w` writes the files back; elsewhere `-w` names a workspace or a warning filter. */
const W_FLAG_WRITERS: ReadonlySet<string> = new Set(["prettier", "gofmt", "goimports"]);

/**
 * Whether a check command may rewrite the tree it checks (x3-3): a package script, make or just target named as a
 * writer ({@link isWriteCapableScriptName}), `--fix` or `--write`, a formatter's `-w`, or a snapshot update passed to a
 * package script, `node --test` or a validated test runner ({@link testRunnerArgs}), or a `cargo insta` accept, also
 * behind `uv run`, `poetry run` or `bundle exec`. A heuristic on names and flags: a writer spelled otherwise reads as a check, and a
 * read-only script named `format` reads as a change, which only clears passes the run must then earn again.
 */
export function checkWritesTree(argv: ReadonlyArray<string>): boolean {
	const index = commandTokenIndex(argv);
	if (index === null) return false;
	const executable = basenameToken(argv[index]);
	const args = argv.slice(index + 1);
	if (args.some((arg) => TREE_WRITING_FLAGS.has(arg) || arg.startsWith("--fix="))) return true;
	if (W_FLAG_WRITERS.has(executable) && args.includes("-w")) return true;
	const wrapped = environmentRunnerInvocation(executable, args);
	if (wrapped !== null) return checkWritesTree([wrapped.executable, ...wrapped.args]);
	if (executable === "node") return args.includes("--test-update-snapshots");
	// `go test -update`, `pytest --snapshot-update` and `bun test -u` rewrite the goldens they compare against (x7-2).
	if (testRunnerArgs(executable, args)?.some(writesSnapshots) === true) return true;
	if (executable === "cargo" && args[0] === "insta")
		return (
			args[1] === "accept" ||
			args[1] === "review" ||
			args.some(
				(arg, index) =>
					/^--(?:accept|review|force-update-snapshots)/u.test(arg) ||
					/^--unreferenced=(?:delete|auto)$/u.test(arg) ||
					(arg === "--unreferenced" && /^(?:delete|auto)$/u.test(args[index + 1] ?? "")) ||
					writesSnapshots(arg),
			)
		);
	if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "bun") {
		const run = packageScriptRun(executable, args);
		const script = run?.script ?? (args[0] === "run" ? args[1] : args[0]);
		const separator = args.indexOf("--");
		// `npm test -- -u` is a check that rewrites its snapshots (x5-2); pnpm and yarn hand `pnpm test -u` the flag too.
		if (separator >= 0 && args.slice(separator + 1).some(writesSnapshots)) return true;
		if ((executable === "pnpm" || executable === "yarn") && run?.forwarded.some(writesSnapshots) === true) return true;
		return script !== undefined && isWriterName(script);
	}
	if (executable === "make" || executable === "just")
		return args.some((arg) => !arg.startsWith("-") && !arg.includes("=") && isWriterName(arg));
	// A tox environment or nox session named as a writer rewrites the tree (`nox -s lint_fix`, `tox -e format`, SF-2).
	if (executable === "tox" || executable === "nox") return args.flatMap((arg) => arg.split(/[=,]/u)).some(isWriterName);
	return false;
}

/** Pipeline stages that read their input to its end and exit 0, so the pipeline's status is the stage feeding them. */
function drainsInput(step: ShellStep): boolean {
	if (step.index === null) return false;
	const [executable, ...args] = step.argv.slice(step.index);
	if (executable === "cat" || executable === "tee") return true;
	return (
		executable === "tail" &&
		!args.some((arg) => /^-[^-]*[fF]/u.test(arg) || arg.startsWith("--follow") || arg === "--retry")
	);
}

/**
 * Whether a red exit of a command running a recognized check is the check's own red (x3-2). Under `pipefail` a stage
 * after the check fails a green check: `head` closes the pipe so the check dies of SIGPIPE or EPIPE, and `grep`
 * exits 1 when a clean run prints no match. So a check piped onward into anything but `tail`, `cat` or `tee`, which read to
 * the end and exit 0, settles no failure. Its clean exit still speaks for it, since every stage then exited 0.
 * `declaredSteps` count as check steps, as in {@link checkCommandShape}.
 */
export function checkFailureAttributable(command: string, declaredSteps: ReadonlySet<number> = new Set()): boolean {
	const steps = shellSteps(scanShellLike(command, true));
	return steps.every((step, position) => {
		if (!isCheckStep(step) && !declaredSteps.has(position)) return true;
		for (let next = position; ; next += 1) {
			const joinedBy = steps[next]?.joinedBy;
			if (joinedBy !== "|") return joinedBy !== "";
			const stage = steps[next + 1];
			if (stage === undefined || !drainsInput(stage)) return false;
		}
	});
}

/**
 * Whether a step of the command bends a pipeline's exit status away from its commands' own (x4-5): a `!` that inverts
 * a pipeline, a `set` that switches an option off with `+o` (`set +o "pipefail"`), or a `shopt -u` naming pipefail or
 * an expansion. Quoting is read the way the shell reads it, so a quoted option name still counts.
 */
export function shellStatusMasked(command: string): boolean {
	return shellSteps(scanShellLike(command, true)).some((step) => {
		if (step.argv.slice(0, step.index ?? step.argv.length).includes("!")) return true;
		if (step.index === null) return false;
		const [executable, ...args] = step.argv.slice(step.index);
		if (executable === "set") return args.some((arg) => /^\+[A-Za-z]*o/u.test(arg));
		if (executable !== "shopt") return false;
		return args.some((arg) => /^-[A-Za-z]*u/u.test(arg)) && args.some((arg) => arg === "pipefail" || /[$`]/u.test(arg));
	});
}

/**
 * Builtins that end, replace, reconfigure or move the shell, so the status or directory of a later list may not be the
 * one it reads: after a failed `cd pkg;` the check runs where the shell already was.
 */
const LIST_BENDING_BUILTINS: ReadonlySet<string> = new Set([
	"cd",
	"pushd",
	"popd",
	"exit",
	"exec",
	"return",
	"logout",
	"trap",
	"set",
	"shopt",
	"eval",
	"alias",
	"enable",
	"hash",
	"source",
	".",
	"kill",
	"wait",
]);

/**
 * Builtins that set what a later list runs or waits on (variables, functions, jobs) without changing the tree; an
 * unknown step spelled as one is not plain ({@link finalListAfterPlainSteps}).
 */
const SHELL_STATE_BUILTINS: ReadonlySet<string> = new Set([
	"declare",
	"typeset",
	"readonly",
	"local",
	"unset",
	"let",
	"read",
	"readarray",
	"mapfile",
	"printf",
	"getopts",
	"fg",
	"bg",
	"disown",
	"coproc",
	"function",
	"ulimit",
	"umask",
]);

/** Words that open or close a compound command or a function body; a list holding one is not plain. */
const COMPOUND_COMMAND_WORDS: ReadonlySet<string> = new Set([
	"{",
	"}",
	"function",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"while",
	"until",
	"for",
	"select",
	"do",
	"done",
	"case",
	"esac",
	"[[",
]);

/**
 * The text of a command's last `;` or newline list when the steps before it cannot touch its exit status (bt-46 S2):
 * none runs a check (`declaredSteps` count as checks), none is grouped or backgrounded, and each is a plain command, so
 * a write by redirect, heredoc, a known writer or a program the step reader cannot place (`./gen.sh; npm test`, SF-2)
 * may come first: a child process cannot end the shell or change what the next list runs. An `exit`, a `trap`, a
 * `set`, a function or alias definition, a builtin that sets variables or jobs, a nested shell or a hidden word returns
 * null, as does a command with no such list.
 */
export function finalListAfterPlainSteps(
	command: string,
	declaredSteps: ReadonlySet<number> = new Set(),
): string | null {
	const steps = shellSteps(scanShellLike(command, true));
	let last = -1;
	for (let position = 1; position < steps.length; position += 1)
		if (steps[position - 1]?.joinedBy === ";") last = position;
	const tail = steps[last]?.tokens[0];
	if (tail === undefined) return null;
	const plain = (step: ShellStep, position: number): boolean => {
		if (step.opens > 0 || step.closes > 0 || step.index === null) return false;
		if (position < last && (step.joinedBy === "&" || step.joinedBy === "")) return false;
		if (position >= last) return true;
		if (isCheckStep(step) || declaredSteps.has(position)) return false;
		if (step.tokens.some((token) => token.hiddenContent === true || token.unterminated === true)) return false;
		const argv = step.argv.slice(step.index);
		if (step.argv.slice(0, step.index + 1).some((word) => COMPOUND_COMMAND_WORDS.has(word))) return false;
		if (LIST_BENDING_BUILTINS.has(argv[0] ?? "") || segmentShellScript(step.argv) !== null) return false;
		return (
			(inlinePythonVerdict(command, step) ?? stepVerdict(argv, false)) !== "unknown" ||
			!SHELL_STATE_BUILTINS.has(argv[0] ?? "")
		);
	};
	return steps.every(plain) ? command.slice(tail.start) : null;
}

/**
 * Whether a recognized check in the command runs outside `root` (x3-5). Its directory starts at `base` and follows
 * each `cd` and `pushd` before it, back out of a subshell at its `)` and back along the stack at a `popd` (x4-7). A
 * directory this cannot resolve (home, `-`, a variable, an unbalanced `)` or `popd`) is unknown, which counts as
 * outside, so a sibling checkout's green never stands for this workspace.
 */
export function checkRunsOutside(command: string, base: string, root: string): boolean {
	return someCheckStep(
		command,
		base,
		(argv, directory) =>
			directory === null || !isSameOrDescendant(directory, root) || checkReachesOutside(argv, directory, root),
	);
}

/**
 * Whether a Python test step runs on a bare interpreter (`python3 -m pytest`, `pytest`, `python -m unittest`) rather
 * than through `uv run`, in a directory `unprovisioned` names: there it judged whatever environment that interpreter
 * carries, not the project's locked one, so its pass is not this project's (FL-2). An unknown directory answers false;
 * {@link checkRunsOutside} already reads it.
 */
export function checkRunsBareInterpreter(
	command: string,
	base: string,
	unprovisioned: (directory: string) => boolean,
): boolean {
	return someCheckStep(command, base, (argv, directory) => {
		const label = validationMatch(basenameToken(argv[0]), argv.slice(1));
		return (
			directory !== null &&
			(label === "pytest" || label === "python -m pytest" || label === "python -m unittest") &&
			unprovisioned(directory)
		);
	});
}

/** Whether some check step of `command` passes `test`, given its argv and the directory it runs in (null when unknown). */
function someCheckStep(
	command: string,
	base: string,
	test: (argv: ReadonlyArray<string>, directory: string | null) => boolean,
): boolean {
	let directory: string | null = base;
	let pushed: Array<string | null> = [];
	const subshells: Array<{ directory: string | null; pushed: Array<string | null> }> = [];
	for (const step of shellSteps(scanShellLike(command, true))) {
		for (let open = 0; open < step.opens; open += 1) subshells.push({ directory, pushed: [...pushed] });
		const executable = step.index === null ? "" : basenameToken(step.argv[step.index]);
		const target = cdTarget(step.argv);
		if (isCheckStep(step)) {
			const prefix = step.argv.slice(0, step.index ?? 0);
			if (test(step.argv.slice(step.index ?? 0), wrapperMovesDirectory(prefix) ? null : directory)) return true;
		} else if (executable === "popd")
			directory = step.argv.length > (step.index ?? 0) + 1 ? null : (pushed.pop() ?? null);
		else if (target !== null) {
			if (executable === "pushd") pushed.push(directory);
			directory = directory === null || /^[~+]|[$`]/u.test(target) ? null : path.resolve(directory, target);
		}
		for (let close = 0; close < step.closes; close += 1) {
			const outer = subshells.pop();
			directory = outer?.directory ?? null;
			pushed = outer?.pushed ?? [];
		}
	}
	return false;
}

/**
 * Whether the wrappers before a command run it in another directory or from a re-split string (`env -C dir`,
 * `env -S '...'`, `sudo -D dir`), so where the check ran is unknown (SF-2).
 */
function wrapperMovesDirectory(prefix: ReadonlyArray<string>): boolean {
	let wrapper = "";
	for (const word of prefix) {
		if (word === "env" || word === "sudo" || word === "doas") wrapper = word;
		else if (/^--(?:chdir|split-string)(?:=|$)/u.test(word)) return true;
		else if (wrapper === "env" && /^-[a-zA-Z]*[CS]/u.test(word)) return true;
		else if (wrapper === "sudo" && /^-[a-zA-Z]*D/u.test(word)) return true;
	}
	return false;
}

/** A check's own options that run it in, or read its project from, another directory; `--manifest-path` names a file. */
const CHECK_DIRECTORY_OPTIONS: ReadonlySet<string> = new Set([
	"--prefix",
	"-C",
	"--dir",
	"--cwd",
	"--directory",
	"--working-directory",
	"--manifest-path",
	"--test-dir",
	"--rootdir",
	"--rootDir",
	"--root",
]);

/** Runners whose positional operands are the paths they collect tests from. */
const PATH_OPERAND_RUNNERS: ReadonlySet<string> = new Set(["pytest", "py.test", "jest", "vitest", "mocha", "go"]);

const GO_VALUE_OPTIONS = ["-run", "-bench", "-skip", "-tags", "-timeout", "-count", "-cpu", "-parallel", "-p"];
const JEST_VALUE_OPTIONS = ["-t", "--testNamePattern"];
const PYTEST_VALUE_OPTIONS = ["-k", "-m", "-p", "-o", "-W"];

/** Each runner's options whose separate next argument is a value (a test name, a regex), not a path operand (x5-3). */
const RUNNER_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["go", new Set([...GO_VALUE_OPTIONS, "-coverprofile", "-covermode", "-o"])],
	["jest", new Set(JEST_VALUE_OPTIONS)],
	["vitest", new Set(JEST_VALUE_OPTIONS)],
	["pytest", new Set(PYTEST_VALUE_OPTIONS)],
	["py.test", new Set(PYTEST_VALUE_OPTIONS)],
]);

/**
 * Whether a check step's own directory options (`npm test --prefix ../x`, `make -C ../x`, `cargo test --manifest-path
 * ../x/Cargo.toml`) or a test runner's path operands (`pytest ../x`) reach outside `root` from `directory` (x4-4). The
 * test is root containment, so `npm test --prefix packages/a` stays this workspace's check. An operand this cannot
 * resolve (home, a variable) counts as outside.
 */
function checkReachesOutside(argv: ReadonlyArray<string>, directory: string, root: string): boolean {
	const [executable, ...args] = argv;
	const module = args.indexOf("-m");
	const runner = module >= 0 && args[module + 1] === "pytest" ? "pytest" : basenameToken(executable);
	const operands = PATH_OPERAND_RUNNERS.has(runner);
	const values = RUNNER_VALUE_OPTIONS.get(runner);
	const targets: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		const equals = arg.indexOf("=");
		const option = equals > 0 ? arg.slice(0, equals) : arg;
		let target: string | undefined;
		if (CHECK_DIRECTORY_OPTIONS.has(option)) {
			target = equals > 0 ? arg.slice(equals + 1) : args[index + 1];
			if (equals < 0) index += 1;
			if (option === "--manifest-path" && target !== undefined) target = path.dirname(target);
		} else if (/^-C[^-]/u.test(arg)) target = arg.slice(2);
		else if (values?.has(arg)) index += 1;
		else if (operands && !arg.startsWith("-") && equals < 0) target = arg.split("::")[0];
		if (target !== undefined) targets.push(target);
	}
	return targets.some((target) => /^~|[$`]/u.test(target) || !isSameOrDescendant(path.resolve(directory, target), root));
}

/**
 * Roots of the `find -delete` calls in a command whose expression filters
 * what goes. The operator's yolo judges such a root by what lies under it, so
 * the authority rails treat it as a write there rather than a delete of the
 * root and every tree above (#419).
 */
export function extractFilteredFindDeleteRoots(command: string): string[] {
	const roots: string[] = [];
	for (const tokens of expandedShellSegments(command)) {
		const segment = shellCommandArguments(tokens);
		const commandIndex = commandTokenIndex(segment);
		if (commandIndex === null || basenameToken(segment[commandIndex]) !== "find" || !segment.includes("-delete"))
			continue;
		const args = segment.slice(commandIndex + 1);
		if (findExpressionFilters(args)) roots.push(...findRoots(args));
	}
	return roots.filter(isInterestingWriteTarget);
}

/** Recognizable operator CLI installation paths invoked through a model shell.
 * This is command inspection, not confinement of arbitrary scripts or aliases.
 * `excludeLibrary` keeps only the hard-blocked verbs. Without it the result also
 * covers the verbs that ask the operator under the default posture: the Library,
 * a share import and the extension authoring verbs that execute package code.
 */
export function invokesClioSkillMutation(command: string, excludeLibrary = false): boolean {
	for (const segment of expandedShellSegments(command)) {
		const argv = shellCommandArguments(segment);
		const index = commandTokenIndex(argv);
		if (index === null) continue;
		let args = argv.slice(index);
		const executable = basenameToken(args[0]);
		if (executable === "npx" || (executable === "npm" && args[1] === "exec")) {
			args = args.slice(executable === "npm" ? 2 : 1);
			while (args[0]?.startsWith("-")) args = args.slice(1);
		}
		const program = args[0] ?? "";
		if (basenameToken(program) === "node" || basenameToken(program) === "tsx") {
			// The checked-in and built entry points are also operator CLIs.
			if (!/(?:^|\/)(?:src|dist)\/cli\/index\.(?:js|ts)$/.test(args[1] ?? "")) continue;
			args = args.slice(2);
		} else if (/^(?:@iowarp\/)?clio-coder(?:@[^/]+)?$/.test(program) || basenameToken(program) === "clio-coder") {
			args = args.slice(1);
		} else continue;
		if (args.includes("--version") || args.includes("-v")) continue;
		let rootHelp = false;
		let firstRootFlag: string | undefined;
		while (args[0]?.startsWith("-")) {
			const flag = args[0];
			// Startup flags are consumed before dispatch. Help is terminal only
			// when it is the first flag left in the root dispatcher's argv.
			if (flag === "--all" || flag === "--help" || flag === "-h") firstRootFlag ??= flag;
			rootHelp = firstRootFlag === "--help" || firstRootFlag === "-h";
			args = args.slice(flag === "--skill" || flag === "--api-key" ? 2 : 1);
		}
		if (rootHelp) continue;
		// `clio-coder dev share` dispatches to `clio-coder share`.
		if (args[0] === "dev" && args[1] === "share") args = args.slice(1);
		// `clio-coder import` is the alias of `clio-coder share import`, and
		// `clio-coder ext` runs the `clio-coder extensions` handler.
		if (args[0] === "import") args = ["share", ...args];
		if (args[0] === "ext") args = ["extensions", ...args.slice(1)];
		if (
			args[0] !== "skills" &&
			args[0] !== "library" &&
			args[0] !== "plugins" &&
			args[0] !== "extensions" &&
			args[0] !== "interop" &&
			args[0] !== "share"
		)
			continue;
		if (excludeLibrary && args[0] === "library") continue;
		if (resourceCliMutatesSkills(args[0], args.slice(1), !excludeLibrary)) return true;
	}
	return false;
}

function shellCommandArguments(segment: ReadonlyArray<ShellToken>): string[] {
	return shellCommandWords(segment).map((token) => token.value);
}

/** {@link shellCommandArguments} with the tokens kept, for a reader that needs more than the text. */
export function shellCommandWords(segment: ReadonlyArray<ShellToken>): ShellToken[] {
	const args: ShellToken[] = [];
	for (let index = 0; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (token.operator && SHELL_REDIRECTIONS.has(token.value)) {
			// A redirection target is consumed by the shell, not passed to Clio.
			// Only an adjacent, unquoted number is its optional file descriptor.
			const previous = args.at(-1);
			if (previous && previous.end === token.start && !previous.quoted && /^\d+$/.test(previous.value)) args.pop();
			if (segment[index + 1]?.operator === false) index += 1;
			continue;
		}
		args.push(token);
	}
	return args;
}

/** A word with its leading home reference replaced by `home`, when the shell would expand it. */
function homeExpanded(token: ShellToken, home: string | undefined): string {
	if (home === undefined || token.homeRelative !== true) return token.value;
	const reference = /^(?:\$\{HOME\}|\$HOME|~)/u.exec(token.value)?.[0] ?? "";
	// HOME=/ leaves an empty base, and `~` alone would then expand to nothing.
	return `${home.replace(/\/+$/u, "")}${token.value.slice(reference.length)}` || "/";
}

function resourceCliMutatesSkills(
	resource: "skills" | "library" | "plugins" | "extensions" | "interop" | "share",
	args: ReadonlyArray<string>,
	confirmable: boolean,
): boolean {
	// Both resource parsers accept flags before the verb. Consume their value
	// options so a catalog path called --yes or --help is not treated as a flag.
	const valueOptions =
		resource === "skills"
			? ["--name", "--category", "--scenario", "--target", "--workspace", "--timeout"]
			: resource === "share"
				? ["--out"]
				: ["--kind", "--from"];
	let verb: string | undefined;
	let confirmed = false;
	let dryRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (valueOptions.includes(arg)) {
			index += 1;
			continue;
		}
		if (arg === "--help" || arg === "-h") return false;
		if (arg === "--yes") confirmed = true;
		if (arg === "--dry-run") dryRun = true;
		if (!arg.startsWith("-")) verb ??= arg;
	}
	if (resource === "skills") return verb === "install" || verb === "update" || verb === "sync";
	// A share import installs packages and writes resources from an archive the
	// model may have authored; its dry run only plans.
	if (resource === "share") return confirmable && verb === "import" && !dryRun;
	if (resource === "plugins" || resource === "extensions") {
		if (["install", "update", "remove", "enable", "disable", "pin"].includes(verb ?? "")) return true;
		// Both authoring verbs run package code (startup registration, `*.test.ts`),
		// so they need the operator the way an install does.
		return resource === "extensions" && confirmable && (verb === "test" || verb === "validate");
	}
	if (resource === "interop") return verb === "adopt" && confirmed && !dryRun;
	// A package of any kind may carry skills or require a skill dependency.
	// A dry run builds the plan and writes nothing, so it never needs a confirmation.
	if (dryRun && LIBRARY_DRY_RUN_VERBS.includes(verb ?? "")) return false;
	return LIBRARY_MUTATION_VERBS.includes(verb ?? "");
}

/** The library verbs that implement --dry-run (src/cli/library.ts, src/cli/library-import.ts). */
const LIBRARY_DRY_RUN_VERBS = ["install", "import", "update", "enable", "disable", "remove", "package"];

const LIBRARY_MUTATION_VERBS = [
	"install",
	"import",
	"update",
	"remove",
	"enable",
	"disable",
	"pin",
	"register",
	"package",
	"sync",
	"push",
	"remote",
];

const STANDARD_DEV_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

function collectRedirectTargets(segment: ReadonlyArray<ShellToken>, out: string[]): void {
	for (let index = 0; index < segment.length - 1; index += 1) {
		const target = redirectWriteTarget(segment[index], segment[index + 1]);
		if (target !== null) out.push(target);
	}
}

function redirectWriteTarget(operator: ShellToken | undefined, target: ShellToken | undefined): string | null {
	if (!operator?.operator || target === undefined || target.operator || !SHELL_WRITE_REDIRECTIONS.has(operator.value))
		return null;
	// >& duplicates or closes a descriptor when its operand is a number or -;
	// Bash also accepts a filename here, redirecting stdout and stderr to it.
	if (operator.value === ">&" && /^(?:\d+-?|-)$/u.test(target.value)) return null;
	return target.value;
}

function collectInvokedWriteTargets(segment: ReadonlyArray<string>, out: string[]): void {
	const cmdIndex = commandTokenIndex(segment);
	if (cmdIndex === null) return;
	const executable = basenameToken(segment[cmdIndex]);
	if (executable === "tee") {
		for (const arg of pathArgs(segment, cmdIndex)) out.push(arg);
		return;
	}
	// mkdir and touch create filesystem entries at every path operand. The
	// recorded workspace escape (`mkdir -p /abs/outside && cd ...` in the
	// skill-mastery app-idea battery) rode exactly this blind spot: redirects
	// and tee were classified, directory creation was not.
	if (executable === "mkdir" || executable === "touch") {
		for (const arg of pathArgs(segment, cmdIndex)) out.push(arg);
		return;
	}
	if (executable === "ln") {
		const args = pathArgs(segment, cmdIndex);
		const destination = args.at(-1);
		if (args.length >= 2 && destination !== undefined) out.push(destination);
		return;
	}
	if (executable === "cp" || executable === "mv" || executable === "install") {
		const args = pathArgs(segment, cmdIndex);
		const targetDir = targetDirectoryOption(segment, cmdIndex);
		if (targetDir !== null) {
			out.push(targetDir);
			for (const source of args) {
				if (source !== targetDir) out.push(path.posix.join(targetDir, path.posix.basename(source)));
			}
			return;
		}
		const destination = args.at(-1);
		if (args.length >= 2 && destination !== undefined) out.push(destination);
		return;
	}
	if (executable === "dd") {
		for (const arg of segment.slice(cmdIndex + 1)) {
			if (arg.startsWith("of=") && arg.length > 3) out.push(arg.slice(3));
		}
	}
}

/** The directory of `-t DIR`, `-tDIR` or `--target-directory[=]DIR`, when the command names one. */
function targetDirectoryOption(segment: ReadonlyArray<string>, commandIndex: number): string | null {
	for (let index = commandIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (token === "--") break;
		if (token === "-t" || token === "--target-directory") return segment[index + 1] ?? null;
		if (token.startsWith("--target-directory=")) return token.slice("--target-directory=".length);
		if (/^-[^-]*t/u.test(token)) {
			const rest = token.slice(token.indexOf("t") + 1);
			return rest.length > 0 ? rest : (segment[index + 1] ?? null);
		}
	}
	return null;
}

/**
 * In-place stream-editor writes: `sed -i` (GNU `-iSUFFIX` / `--in-place` and
 * BSD `-i ''` forms) rewrites its file operands in place, which the redirect and
 * tee/cp/mv detectors miss. Weak models reach for `sed -i` constantly, so
 * recognizing it here lets both the classifier and the finish-contract treat it
 * as the write it is. The sed script operand is dropped (it is not a file), so
 * an address-form script such as `/pat/d` cannot be mistaken for an out-of-cwd
 * write target.
 */
function collectInPlaceEditTargets(segment: ReadonlyArray<string>, out: string[]): void {
	const cmdIndex = commandTokenIndex(segment);
	if (cmdIndex === null) return;
	collectScriptWriteTargets(basenameToken(segment[cmdIndex]), segment.slice(cmdIndex + 1), out);
	if (basenameToken(segment[cmdIndex]) !== "sed") return;
	if (!hasSedInPlaceFlag(segment, cmdIndex)) return;
	for (const operand of sedFileOperands(segment, cmdIndex)) out.push(operand);
}

function hasSedInPlaceFlag(segment: ReadonlyArray<string>, cmdIndex: number): boolean {
	for (let index = cmdIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (token === "--") break;
		if (token === "--in-place" || token.startsWith("--in-place=")) return true;
		if (token.startsWith("--")) continue;
		// A short-option cluster carrying `i` (`-i`, `-i.bak`, `-ni`) requests
		// in-place editing; sed's other short flags (`-n`, `-e`, `-r`, ...) do not.
		if (token.startsWith("-") && token.length > 1 && token.slice(1).includes("i")) return true;
	}
	return false;
}

/**
 * File operands of a sed invocation, with the inline script dropped. `-e`/`-f`/
 * `--expression`/`--file` supply the script explicitly, so when one is present
 * every bare operand is a file; otherwise the first bare operand is the script.
 */
function sedFileOperands(segment: ReadonlyArray<string>, cmdIndex: number): string[] {
	const operands: string[] = [];
	let sawScriptFlag = false;
	let endOfOptions = false;
	for (let index = cmdIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("-") && token.length > 1) {
			if (token === "-e" || token === "-f") {
				sawScriptFlag = true;
				index += 1;
				continue;
			}
			if (token === "-l") {
				index += 1;
				continue;
			}
			if (token === "--expression" || token === "--file") {
				sawScriptFlag = true;
				index += 1;
				continue;
			}
			if (token.startsWith("--expression=") || token.startsWith("--file=")) {
				sawScriptFlag = true;
				continue;
			}
			continue;
		}
		operands.push(token);
	}
	if (!sawScriptFlag && operands.length > 0) operands.shift();
	return operands;
}

function isInterestingWriteTarget(target: string): boolean {
	if (target.length === 0) return false;
	if (STANDARD_DEV_TARGETS.has(target)) return false;
	if (target.startsWith("/dev/fd/")) return false;
	return true;
}

function classifyRedirect(
	segment: ReadonlyArray<ShellToken>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	for (let index = 0; index < segment.length; index += 1) {
		// Keep the existing distinction between overwriting and appending here.
		if (segment[index]?.value === ">>" || segment[index]?.value === "&>>") continue;
		const target = redirectWriteTarget(segment[index], segment[index + 1]);
		if (target === null) continue;
		const matches = matchesForPaths([target], artifacts, "target", "redirect can overwrite protected artifacts");
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "redirect",
				matches,
			};
		}
	}
	return { kind: "benign", matches: [] };
}

function classifyGitOperation(
	args: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	const subcommand = args[0];
	if (subcommand === "reset" && args.includes("--hard")) {
		return {
			kind: "destructive",
			operation: "git_reset_hard",
			matches: artifacts.map(({ artifact }) => ({
				artifactPath: artifact.path,
				commandPath: ".",
				reason: "git reset --hard can overwrite protected artifacts",
			})),
		};
	}

	if (subcommand === "checkout" && args.includes("--")) {
		const paths = args.slice(args.indexOf("--") + 1);
		const matches = matchesForPaths(paths, artifacts, "intersects", "git checkout -- can overwrite protected artifacts");
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "git_checkout",
				matches,
			};
		}
		return { kind: "benign", matches: [] };
	}

	if (subcommand === "restore") {
		const matches = matchesForPaths(
			pathArgs(args.slice(1), -1),
			artifacts,
			"intersects",
			"git restore can overwrite protected artifacts",
		);
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "git_restore",
				matches,
			};
		}
	}

	return { kind: "benign", matches: [] };
}

function classifyFindDelete(
	args: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	if (!args.includes("-delete")) return { kind: "benign", matches: [] };
	const roots = findRoots(args);
	const matches = matchesForPaths(
		roots.length === 0 ? ["."] : roots,
		artifacts,
		"intersects",
		"find -delete can remove protected artifacts",
	);
	if (matches.length > 0) {
		return {
			kind: "destructive",
			operation: "find_delete",
			matches,
		};
	}
	return { kind: "benign", matches: [] };
}

/**
 * Tests that narrow which entries a find expression reaches. `-type`, depth
 * and traversal options do not: `find . -type f -delete` still removes every
 * file.
 */
const FIND_FILTER_TESTS = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-lname",
	"-ilname",
	"-newer",
	"-anewer",
	"-cnewer",
	"-mtime",
	"-mmin",
	"-atime",
	"-amin",
	"-ctime",
	"-cmin",
	"-size",
	"-empty",
	"-user",
	"-group",
	"-uid",
	"-gid",
	"-nouser",
	"-nogroup",
	"-perm",
	"-links",
	"-inum",
	"-samefile",
]);

/**
 * A find expression filters its delete when a narrowing test comes before the
 * first action and nothing can route around it: `-o`, `,` or a negation lets
 * entries the test rejects reach the action (`find . -name x -o -delete`).
 */
function findExpressionFilters(args: ReadonlyArray<string>): boolean {
	let filtered = false;
	for (const [index, token] of args.entries()) {
		if (/^-(?:delete|exec|execdir|ok|okdir)$/u.test(token)) return filtered;
		if (token === "-o" || token === "-or" || token === "," || token === "!" || token === "-not") return false;
		if (findTestMatchesAll(token, args[index + 1])) continue;
		if (FIND_FILTER_TESTS.has(token) || /^-newer[aBcmt][aBcmt]$/u.test(token)) filtered = true;
	}
	return filtered;
}

/** `-name '*'` and `-regex '.*'` name a test that rejects nothing. */
function findTestMatchesAll(test: string, value: string | undefined): boolean {
	if (value === undefined) return false;
	if (/^-i?(?:name|path|wholename)$/u.test(test)) return /^\**$/u.test(value);
	if (/^-i?regex$/u.test(test)) return /^(?:\.\*)*$/u.test(value);
	return false;
}

function findRootDeletes(args: ReadonlyArray<string>): CommandPathEvent[] {
	const findRoot: FindRootFilter = findExpressionFilters(args) ? "filtered" : "unfiltered";
	return findRoots(args).map((target) => ({ kind: "delete", target, scope: "children", findRoot }));
}

function findRoots(args: ReadonlyArray<string>): string[] {
	const roots: string[] = [];
	// find's own leading options (`-L`, `-D tree`, `-O3`) come before the roots;
	// stopping at them judged `find -L /x -delete` by `.` instead of `/x`.
	let start = 0;
	while (start < args.length && /^-(?:[HLP]|O\d*|D)$/u.test(args[start] ?? "")) start += args[start] === "-D" ? 2 : 1;
	for (const token of args.slice(start)) {
		if (token === "-delete" || token.startsWith("-") || token === "(" || token === "!" || token === "not") break;
		if (token === "--") continue;
		roots.push(token);
	}
	return roots.length === 0 ? ["."] : roots;
}

function classifyPathOperation(
	operation: DestructiveCommandOperation,
	reason: string,
	paths: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	const matches = matchesForPaths(paths, artifacts, "intersects", reason);
	if (matches.length === 0) return { kind: "benign", matches: [] };
	return {
		kind: "destructive",
		operation,
		matches,
	};
}

function matchesForPaths(
	commandPaths: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
	mode: "target" | "intersects",
	reason: string,
): ProtectedArtifactCommandMatch[] {
	const matches: ProtectedArtifactCommandMatch[] = [];
	const seen = new Set<string>();
	for (const commandPath of commandPaths) {
		for (const artifact of artifacts) {
			if (!pathMatchesArtifact(commandPath, artifact.key, mode)) continue;
			const key = `${artifact.key}\0${commandPath}\0${reason}`;
			if (seen.has(key)) continue;
			seen.add(key);
			matches.push({
				artifactPath: artifact.artifact.path,
				commandPath,
				reason,
			});
		}
	}
	matches.sort(compareMatches);
	return matches;
}

function pathMatchesArtifact(commandPath: string, artifactKey: string, mode: "target" | "intersects"): boolean {
	const wildcardRoot = wildcardRootKey(commandPath);
	if (wildcardRoot !== null) {
		return isSameOrDescendant(artifactKey, wildcardRoot, path.posix);
	}
	const commandKey = normalizePathKey(commandPath);
	if (commandKey === null) return false;
	if (mode === "target") return isSameOrDescendant(commandKey, artifactKey, path.posix);
	return (
		isSameOrDescendant(commandKey, artifactKey, path.posix) || isSameOrDescendant(artifactKey, commandKey, path.posix)
	);
}

/**
 * Validation vocabulary shared with unattended test runners (#377). Labels
 * with `<name>` describe script families; `validationMatch` preserves the
 * actual script name so one script cannot ground a claim about another.
 * `tests/contracts/test-runner-vocabulary.test.ts` prevents admission drift.
 */
export const VALIDATION_COMMAND_LABELS = [
	"npm test",
	"pnpm test",
	"yarn test",
	"bun test",
	"npm run test:<name>",
	"pnpm run test:<name>",
	"yarn run test:<name>",
	"bun run test:<name>",
	"uv run pytest",
	"uv run python -m pytest",
	"node --test",
	"pytest",
	"python -m pytest",
	"python -m unittest",
	"cargo test",
	"go test",
	"ctest",
	"make test",
	"make check",
	"ninja test",
	"meson test",
	"mvn test",
	"gradle test",
] as const;

export type ValidationCommandLabel = (typeof VALIDATION_COMMAND_LABELS)[number];

function validationMatch(
	executable: string,
	args: ReadonlyArray<string>,
): ValidationCommandLabel | PackageScriptLabel | null {
	// A runtime loader (`--import`, `--require`) runs code beside the check, so wherever it appears the run is not the
	// project's check (x6-5).
	if (executable === "node") return args[0] === "--test" && !args.some(isRuntimeLoaderFlag) ? "node --test" : null;
	const script = packageScriptMatch(executable, args);
	if (script !== null) {
		// The same holds for one handed to the script; a runner's own flag (`--run`, `-t name`) is filed under its
		// full command (x5-2).
		return packageScriptRun(executable, args)?.forwarded.some(isRuntimeLoaderFlag) === true ? null : script;
	}
	if (executable === "uv") {
		const invocation = args.join(" ");
		if (/^run(?:\s+--(?:no-sync|frozen|locked))*\s+pytest(?:\s+[\w=./:-]+)*$/.test(invocation)) {
			return "uv run pytest";
		}
		if (/^run(?:\s+--(?:no-sync|frozen|locked))*\s+python\s+-m\s+pytest(?:\s+[\w=./:-]+)*$/.test(invocation)) {
			return "uv run python -m pytest";
		}
	}
	if (executable === "pytest") return "pytest";
	if (isPythonExecutable(executable) && moduleArg(args) === "pytest") return "python -m pytest";
	if (isPythonExecutable(executable) && moduleArg(args) === "unittest") return "python -m unittest";
	// nextest runs the same cargo tests, so it carries their label (x10-3).
	if (executable === "cargo" && (args[0] === "test" || (args[0] === "nextest" && args[1] === "run")))
		return "cargo test";
	if (executable === "go" && args[0] === "test") return "go test";
	if (executable === "ctest") return "ctest";
	if (executable === "make" && args[0] === "test") return "make test";
	if (executable === "make" && args[0] === "check") return "make check";
	if (executable === "ninja" && args[0] === "test") return "ninja test";
	if (executable === "meson" && args[0] === "test") return "meson test";
	if (executable === "mvn" && args[0] === "test") return "mvn test";
	if ((executable === "gradle" || executable === "gradlew") && args[0] === "test") return "gradle test";
	return null;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** A package-script check's identity: `<pm> test` or `<pm> run <script>`, with any workspace selectors before it. */
type PackageScriptLabel = `${PackageManager} ${string}`;

function packageScriptMatch(executable: string, args: ReadonlyArray<string>): PackageScriptLabel | null {
	const run = packageScriptRun(executable, args);
	if (run === null) return null;
	// A selected workspace's run is not the root's check, so its selectors stay in its identity.
	const scope = run.selectors.map((selector) => `${selector} `).join("");
	if (run.script === "test") return `${run.manager} ${scope}test`;
	if (isVerificationScriptName(run.script)) return `${run.manager} ${scope}run ${run.script}`;
	return null;
}

/**
 * pnpm and yarn commands that a bare word names before any package script of that name (x6-4), so `pnpm ci` or
 * `yarn check` is never read as the project's `ci` or `check` script.
 */
const PACKAGE_MANAGER_BUILTINS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	[
		"pnpm",
		new Set([
			...PACKAGE_WRITES,
			"exec",
			"dlx",
			"publish",
			"pack",
			"store",
			"why",
			"outdated",
			"audit",
			"config",
			"set",
			"env",
			"list",
			"ls",
			"root",
			"bin",
			"licenses",
			"deploy",
			"fetch",
			"setup",
			"server",
			"doctor",
		]),
	],
	[
		"yarn",
		new Set([
			...PACKAGE_WRITES,
			"exec",
			"dlx",
			"publish",
			"pack",
			"why",
			"outdated",
			"audit",
			"config",
			"set",
			"env",
			"list",
			"info",
			"bin",
			"cache",
			"global",
			"licenses",
			"workspaces",
			"check",
			"node",
			"constraints",
			"plugin",
		]),
	],
]);

/** pnpm workspace selectors before a script that take no value. */
const PNPM_SELECTOR_FLAGS: ReadonlySet<string> = new Set(["-r", "--recursive", "-w", "--workspace-root"]);

/** Selectors before a script that take a value: pnpm's `--filter` and each manager's project directory. */
const PACKAGE_VALUE_SELECTORS: Readonly<Record<PackageManager, ReadonlySet<string>>> = {
	npm: new Set(["--prefix"]),
	pnpm: new Set(["--filter", "-F", "-C", "--dir"]),
	yarn: new Set(["--cwd"]),
	bun: new Set(["--cwd"]),
};

/**
 * The package script a package manager runs: `<pm> test`, `<pm> run <script>`, or for pnpm and yarn a bare script
 * name, past pnpm's `--filter <v>`, `-F <v>`, `-r` and `-w` or yarn's `workspace <name>` (x6-4), and past the project
 * directory (`npm --prefix <dir>`, `pnpm -C <dir>`, `yarn --cwd <dir>`), which stays in the check's identity.
 * `forwarded` are the arguments after the script name. Null for anything else.
 */
function packageScriptRun(
	executable: string,
	args: ReadonlyArray<string>,
): { manager: PackageManager; selectors: string[]; script: string; forwarded: ReadonlyArray<string> } | null {
	if (executable !== "npm" && executable !== "pnpm" && executable !== "yarn" && executable !== "bun") return null;
	const selected = packageSelectors(executable, args);
	if (selected === null) return null;
	const { selectors, index } = selected;
	const first = args[index];
	if (first === undefined) return null;
	if (first === "test") return { manager: executable, selectors, script: first, forwarded: args.slice(index + 1) };
	if (first === "run") {
		const script = args[index + 1];
		return script === undefined ? null : { manager: executable, selectors, script, forwarded: args.slice(index + 2) };
	}
	if (executable !== "pnpm" && executable !== "yarn") return null;
	if (first.startsWith("-") || PACKAGE_MANAGER_BUILTINS.get(executable)?.has(first) === true) return null;
	return { manager: executable, selectors, script: first, forwarded: args.slice(index + 1) };
}

/** The workspace selectors and project directory before a package manager's command, and the index past them. */
function packageSelectors(
	executable: PackageManager,
	args: ReadonlyArray<string>,
): { selectors: string[]; index: number } | null {
	const selectors: string[] = [];
	const valued = PACKAGE_VALUE_SELECTORS[executable];
	let index = 0;
	for (let arg = args[index]; arg !== undefined; arg = args[index]) {
		const equals = arg.indexOf("=");
		if (valued.has(equals > 0 ? arg.slice(0, equals) : arg)) {
			const value = equals > 0 ? arg.slice(equals + 1) : args[index + 1];
			if (value === undefined) return null;
			selectors.push(...(equals > 0 ? [arg] : [arg, value]));
			index += equals > 0 ? 1 : 2;
		} else if (executable === "pnpm" && PNPM_SELECTOR_FLAGS.has(arg)) {
			selectors.push(arg);
			index += 1;
		} else break;
	}
	if (executable === "yarn" && args[index] === "workspace" && args[index + 1]?.startsWith("-") === false) {
		selectors.push("workspace", args[index + 1] as string);
		index += 2;
	}
	return { selectors, index };
}

/**
 * The `grounding`-only half of the vocabulary. Every rule here is an exact
 * leading-command match on a canonicalized executable, never a substring guess,
 * so a command that merely mentions `tsc` or `diff` in an argument stays
 * unrecognized. Failing to match is the safe direction for this scope.
 */
function groundingMatch(executable: string, args: ReadonlyArray<string>): string | null {
	if (executable === "git") {
		const subcommand = gitSubcommand(args)?.subcommand;
		if (subcommand === "diff") return "git diff";
		if (subcommand === "status") return "git status";
		return null;
	}
	if (executable === "node") {
		if (args.includes("--test")) return "node --test";
		if (args.includes("-e") || args.includes("--eval")) return "node -e";
		if (args.includes("--check") || args.includes("-c")) return "node --check";
		return null;
	}
	if (executable === "tsc") return typescriptCheckMatch(args);
	if (executable === "npx") {
		const inner = npxInvocation(args);
		return inner === null ? null : npxRunnerMatch(inner.executable, inner.args);
	}
	return null;
}

/** Test runners recognized behind `npx`, where the runner name is the whole claim. */
const NPX_TEST_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest", "mocha"]);

function npxRunnerMatch(executable: string, args: ReadonlyArray<string>): string | null {
	if (NPX_TEST_RUNNERS.has(executable)) return `npx ${executable}`;
	if (executable === "tsx" && args.includes("--test")) return "npx tsx --test";
	if (executable === "tsc") return typescriptCheckMatch(args);
	return null;
}

/** `tsc --noEmit` is a typecheck; a bare `tsc` is a build that also typechecks. */
function typescriptCheckMatch(args: ReadonlyArray<string>): string {
	return args.some((arg) => arg.toLowerCase() === "--noemit") ? "tsc --noEmit" : "tsc";
}

/**
 * The command `npx` would run, with npx's own flags consumed. Flags that take a
 * separate value (`-p react`, `--package=x` is self-contained) must not be
 * mistaken for the command name.
 */
function npxInvocation(args: ReadonlyArray<string>): { executable: string; args: ReadonlyArray<string> } | null {
	const VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--shell"]);
	let index = 0;
	while (index < args.length) {
		const token = args[index];
		if (token === undefined) return null;
		if (VALUE_FLAGS.has(token)) {
			index += 2;
			continue;
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		return { executable: basenameToken(token), args: args.slice(index + 1) };
	}
	return null;
}

function moduleArg(args: ReadonlyArray<string>): string | null {
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === "-m") return args[index + 1] ?? null;
	}
	return null;
}

/** Python tools that `python -m <tool>` runs as the bare tool of that name. */
const PYTHON_TOOL_MODULES: ReadonlySet<string> = new Set([
	"mypy",
	"ruff",
	"pylint",
	"flake8",
	"black",
	"isort",
	"autopep8",
]);

/** The tool `python -m <tool>` runs, past the interpreter's own options, when it is one of {@link PYTHON_TOOL_MODULES}. */
function pythonToolModule(
	executable: string,
	args: ReadonlyArray<string>,
): { executable: string; args: ReadonlyArray<string> } | null {
	if (!isPythonExecutable(executable)) return null;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-m") {
			const module = args[index + 1];
			return module !== undefined && PYTHON_TOOL_MODULES.has(module)
				? { executable: module, args: args.slice(index + 2) }
				: null;
		}
		if (arg === "-W" || arg === "-X") index += 1;
		else if (!arg.startsWith("-") || arg === "-" || arg === "-c") return null;
	}
	return null;
}

/** The binary `npm exec`, `pnpm exec`, `yarn exec` or `bun exec` runs, past an optional `--`; null for anything else. */
function packageExecInvocation(
	executable: string,
	args: ReadonlyArray<string>,
): { executable: string; args: ReadonlyArray<string> } | null {
	if (args[0] !== "exec" || !["npm", "pnpm", "yarn", "bun"].includes(executable)) return null;
	const at = args[1] === "--" ? 2 : 1;
	const bin = args[at];
	return bin === undefined || bin.startsWith("-") ? null : { executable: basenameToken(bin), args: args.slice(at + 1) };
}

/** Package-manager commands that run a package script, never a binary. */
const SCRIPT_RUNNING_COMMANDS: ReadonlySet<string> = new Set(["run", "test", "start"]);

/**
 * The binary `pnpm <bin>` or `yarn <bin>` runs when the first word is no builtin of theirs (`pnpm vitest run`) and
 * none of the commands that run a package script (`run`, `test`, `start`), past workspace selectors and the project
 * directory (`pnpm --filter web vitest run`, SF-2), which {@link checkReachesOutside} still holds to the workspace.
 */
function packageBinInvocation(
	executable: string,
	args: ReadonlyArray<string>,
): { executable: string; args: ReadonlyArray<string> } | null {
	const at = executable === "pnpm" || executable === "yarn" ? packageSelectors(executable, args)?.index : 0;
	const bin = at === undefined ? undefined : args[at];
	if (
		bin === undefined ||
		bin.startsWith("-") ||
		SCRIPT_RUNNING_COMMANDS.has(bin) ||
		PACKAGE_MANAGER_BUILTINS.get(executable)?.has(bin) !== false
	)
		return null;
	return { executable: basenameToken(bin), args: args.slice((at ?? 0) + 1) };
}

function isPythonExecutable(executable: string): boolean {
	return executable === "python" || executable === "python3" || /^python3\.\d+$/.test(executable);
}

/** Input is one command's argv. Literal words must never be reparsed as shell syntax. */
function pathArgs(segment: ReadonlyArray<string>, commandIndex: number): string[] {
	const args: string[] = [];
	let endOfOptions = false;
	for (let index = commandIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("-")) continue;
		args.push(token);
	}
	return args;
}

/** Literal argv by command, with actual operators and redirections removed. */
export function commandArgumentSegments(command: string): string[][] {
	return splitSegments(scanShellLike(command)).map(shellCommandArguments);
}

/** The raw start of a word the shell expands to the home directory; see {@link ShellToken.homeRelative}. */
const HOME_REFERENCE_START = /^(?:~(?=\/|$)|"?\$(?:HOME|\{HOME\})(?=\/|"|$))/u;

function decodeAnsiCQuote(command: string, open: number): { value: string; end: number; hidden: boolean } {
	const bytes: number[] = [];
	let hidden = false;
	let end = open + 1;
	const escapes: Record<string, number> = {
		a: 7,
		b: 8,
		e: 27,
		E: 27,
		f: 12,
		n: 10,
		r: 13,
		t: 9,
		v: 11,
		"\\": 92,
		"'": 39,
		'"': 34,
		"?": 63,
	};
	for (; end < command.length && command[end] !== "'"; end += 1) {
		const char = command[end] ?? "";
		if (char !== "\\") {
			const point = command.codePointAt(end) ?? 0;
			bytes.push(...Buffer.from(String.fromCodePoint(point)));
			if (point > 0xffff) end += 1;
			continue;
		}
		const escapeCode = command[++end] ?? "";
		const simple = escapes[escapeCode];
		if (simple !== undefined) bytes.push(simple);
		else if (/[0-7]/u.test(escapeCode) && escapeCode.length === 1) {
			let digits = escapeCode;
			while (digits.length < 3 && /[0-7]/u.test(command[end + 1] ?? "!")) digits += command[++end];
			bytes.push(Number.parseInt(digits, 8) & 0xff);
		} else if (escapeCode === "x" || escapeCode === "u" || escapeCode === "U") {
			const limit = escapeCode === "x" ? 2 : escapeCode === "u" ? 4 : 8;
			let digits = "";
			while (digits.length < limit && /[a-fA-F0-9]/u.test(command[end + 1] ?? "!")) digits += command[++end];
			const point = Number.parseInt(digits, 16);
			if (digits.length === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) hidden = true;
			else if (escapeCode === "x") bytes.push(point);
			else bytes.push(...Buffer.from(String.fromCodePoint(point)));
		} else if (escapeCode === "c") {
			const control = command[++end];
			if (control === undefined || control === "'" || control.charCodeAt(0) > 0x7f) {
				hidden = true;
				if (control === "'") break;
			} else {
				bytes.push(control === "?" ? 127 : control.charCodeAt(0) & 31);
				if (control === "\\" && command[end + 1] === "\\") end += 1;
			}
		} else hidden = true;
	}
	if (end >= command.length || bytes.includes(0)) hidden = true;
	let value = "";
	try {
		value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
	} catch {
		// Invalid byte sequences cannot be represented faithfully by the string-based path scanners.
		hidden = true;
	}
	return { value: hidden ? command.slice(open + 1, end) : value, end, hidden };
}

/**
 * A here-document body in the command text, from the line after its head through its terminator line and that line's
 * newline, with the `$(...)` and backtick substitutions an unquoted body still runs, each at its offset.
 */
interface HeredocBody {
	start: number;
	end: number;
	substitutions: ReadonlyArray<{ start: number; text: string }>;
}

interface ShellScan {
	tokens: ReadonlyArray<ShellToken>;
	bodies: ReadonlyArray<HeredocBody>;
}

/** The most recent scans, each keyed by its mode and text, so the many readers of one call's command tokenize it once (x6-7). */
const recentScans = new Map<string, ShellScan>();
const RECENT_SCAN_LIMIT = 16;

/**
 * Literal shell words and operators only; no expansion or script execution. A scan is a pure function of the text, so
 * the last few are kept and each caller gets its own array over the shared tokens, which no reader writes to. With
 * `skipHeredocBodies`, a here-document's body is data, not commands: its `<<WORD` head and body yield no tokens but the
 * substitutions an unquoted body runs, and every other token keeps its offset in `command` (S2, S3).
 */
export function scanShellLike(command: string, skipHeredocBodies = false): ShellToken[] {
	return [...cachedShellScan(command, skipHeredocBodies).tokens];
}

function cachedShellScan(command: string, skipHeredocBodies: boolean): ShellScan {
	if (skipHeredocBodies && !command.includes("<<")) return cachedShellScan(command, false);
	const key = `${skipHeredocBodies ? "b" : "t"}${command}`;
	let scan = recentScans.get(key);
	if (scan === undefined) {
		scan = skipHeredocBodies ? scanSkippingHeredocBodies(command) : { tokens: scanShellText(command), bodies: [] };
		if (recentScans.size >= RECENT_SCAN_LIMIT) recentScans.delete(recentScans.keys().next().value as string);
	} else recentScans.delete(key);
	recentScans.set(key, scan);
	return scan;
}

/** Commands that read a here-document as shell commands, so its body stays commands to every reader. */
const HEREDOC_SHELL_READERS: ReadonlySet<string> = new Set([
	...BARE_WRAPPER_SHELLS,
	"ksh",
	"mksh",
	"ash",
	"busybox",
	"source",
	".",
	"eval",
	"exec",
	"xargs",
]);

/**
 * Whether the here-document at `operatorIndex` may be read as shell: a stage of its pipeline is a shell, a word no
 * literal names, or carries a substitution (`> >(sh)`).
 */
function heredocFeedsShell(tokens: ReadonlyArray<ShellToken>, operatorIndex: number): boolean {
	const ends = (token: ShellToken | undefined, previous: ShellToken | undefined) =>
		token?.operator === true &&
		COMMAND_SEPARATORS.has(token.value) &&
		token.value !== "|" &&
		!(token.value === "&" && previous?.value === "|" && previous.end === token.start);
	let start = operatorIndex;
	while (start > 0 && !ends(tokens[start - 1], tokens[start - 2])) start -= 1;
	let end = operatorIndex;
	while (end < tokens.length && !ends(tokens[end], tokens[end - 1])) end += 1;
	const pipeline = tokens.slice(start, end);
	if (pipeline.some((token) => (token.substitutions?.length ?? 0) > 0 || token.hiddenContent === true)) return true;
	return splitSegments(pipeline).some((stage) => {
		const argv = shellCommandArguments(stage);
		const index = commandTokenIndex(argv);
		if (index === null) return false;
		const word = argv[index] ?? "";
		return /[$`]/u.test(word) || HEREDOC_SHELL_READERS.has(basenameToken(word));
	});
}

/** An arithmetic `(( x << 2 ))` shifts; it opens no here-document. */
function insideArithmetic(tokens: ReadonlyArray<ShellToken>, operatorIndex: number): boolean {
	for (let index = operatorIndex - 1; index > 0; index -= 1) {
		const token = tokens[index] as ShellToken;
		const previous = tokens[index - 1] as ShellToken;
		if (token.value === "(" && previous.value === "(" && previous.operator && previous.end === token.start) return true;
		if (token.operator && COMMAND_SEPARATORS.has(token.value) && token.value !== "(") return false;
	}
	return false;
}

/**
 * {@link scanShellLike} with here-document bodies skipped. A body starts on the line after its head and ends at the
 * line that is exactly its word (tabs stripped first for `<<-`), or at the end of the command, as in bash; an unquoted
 * word's body joins its backslash-newlines before that comparison, a quoted one's never does. Several here-documents
 * on one line take their bodies in order. A head bash rejects, one whose pipeline may read it as shell
 * ({@link heredocFeedsShell}), or a command that may redefine what reads it (a function, alias or PATH change) leaves
 * that body and every later one read as commands.
 */
function scanSkippingHeredocBodies(command: string): ShellScan {
	const bodies: HeredocBody[] = [];
	const heads = new Set<number>();
	const shifts = new Set<number>();
	for (let pass = 0; pass < MAX_HEREDOCS; pass += 1) {
		const tokens = scanShellText(command, bodies);
		const first = tokens.findIndex(
			(token) => token.operator && token.value === "<<" && !heads.has(token.start) && !shifts.has(token.start),
		);
		if (first === -1) break;
		const lineEnd = tokens.findIndex(
			(token, index) => index > first && token.operator && token.value === ";" && command[token.start] === "\n",
		);
		const docs: Array<{ word: string; stripTabs: boolean; quoted: boolean; head: number[] }> = [];
		let readable = true;
		for (let index = first; index < (lineEnd === -1 ? tokens.length : lineEnd); index += 1) {
			const operator = tokens[index];
			if (operator === undefined || !operator.operator || operator.value !== "<<") continue;
			if (insideArithmetic(tokens, index)) {
				shifts.add(operator.start);
				continue;
			}
			const head = [operator.start];
			let word = tokens[index + 1];
			let stripTabs = false;
			if (word !== undefined && !word.operator && word.start === operator.end && command[word.start] === "-") {
				stripTabs = true;
				if (word.value === "-") {
					head.push(word.start);
					word = tokens[index + 2];
				}
			}
			if (word === undefined || word.operator || heredocFeedsShell(tokens, index)) {
				readable = false;
				break;
			}
			head.push(word.start);
			const delimiter = stripTabs && command[word.start] === "-" ? word.value.slice(1) : word.value;
			docs.push({ word: delimiter, stripTabs, quoted: word.quoted, head });
		}
		if (!readable) break;
		for (const doc of docs) for (const start of doc.head) heads.add(start);
		const newline = lineEnd === -1 ? undefined : tokens[lineEnd];
		if (newline === undefined || docs.length === 0) continue;
		const start = newline.start + 1;
		let cursor = start;
		const substitutions: Array<{ start: number; text: string }> = [];
		for (const doc of docs) {
			const bodyStart = cursor;
			let bodyEnd = cursor;
			while (cursor < command.length) {
				bodyEnd = cursor;
				let line = "";
				for (;;) {
					const lineBreak = command.indexOf("\n", cursor);
					const physical = command.slice(cursor, lineBreak === -1 ? command.length : lineBreak);
					cursor = lineBreak === -1 ? command.length : lineBreak + 1;
					const continued = !doc.quoted && lineBreak !== -1 && /(?:^|[^\\])(?:\\\\)*\\$/u.test(physical);
					line += continued ? physical.slice(0, -1) : physical;
					if (!continued) break;
				}
				if ((doc.stripTabs ? line.replace(/^\t+/u, "") : line) === doc.word) break;
				bodyEnd = cursor;
			}
			if (!doc.quoted)
				for (const found of heredocSubstitutions(command.slice(bodyStart, bodyEnd)))
					substitutions.push({ start: bodyStart + found.start, text: found.text });
		}
		bodies.push({ start, end: cursor, substitutions });
	}
	// A function, alias or PATH change outside the bodies may turn `cat` into a shell, so nothing there is data.
	let outside = "";
	let cursor = 0;
	for (const body of bodies) {
		outside += command.slice(cursor, body.start);
		cursor = body.end;
	}
	outside += command.slice(cursor);
	if (/\bPATH=|\balias\b|\bfunction\b|\(\s*\)/u.test(outside)) return cachedShellScan(command, false);
	return { tokens: scanShellText(command, bodies).filter((token) => !heads.has(token.start)), bodies };
}

function scanShellText(command: string, bodies: ReadonlyArray<HeredocBody> = []): ShellToken[] {
	const tokens: ShellToken[] = [];
	let current = "";
	let wordStart: number | null = null;
	let quoted = false;
	let hiddenContent = false;
	let ansiCQuoted = false;
	let quote: "'" | '"' | null = null;
	let nextBody = 0;

	let substitutions: string[] = [];
	const pushCurrent = (end: number): void => {
		if (wordStart === null) return;
		const token: ShellToken = { value: current, operator: false, quoted, start: wordStart, end };
		if (substitutions.length > 0) token.substitutions = substitutions;
		if (HOME_REFERENCE_START.test(command.slice(wordStart, end))) token.homeRelative = true;
		if (hiddenContent) token.hiddenContent = true;
		if (ansiCQuoted) token.ansiCQuoted = true;
		tokens.push(token);
		current = "";
		wordStart = null;
		quoted = false;
		hiddenContent = false;
		ansiCQuoted = false;
		substitutions = [];
	};
	const appendBacktick = (open: number): number | null => {
		const close = matchingBacktick(command, open);
		if (close === null) return null;
		wordStart ??= open;
		current += command.slice(open, close + 1);
		// ORCH-006: escaped ticks inside a backtick script become nested delimiters.
		substitutions.push(command.slice(open + 1, close).replace(/\\`/gu, "`"));
		return close;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (char === undefined) continue;
		while ((bodies[nextBody]?.start ?? command.length) < index) nextBody += 1;
		const body = quote === null && bodies[nextBody]?.start === index ? bodies[nextBody] : undefined;
		if (body !== undefined) {
			pushCurrent(index);
			for (const substitution of body.substitutions) {
				for (const token of scanShellText(substitution.text))
					tokens.push({ ...token, start: token.start + substitution.start, end: token.end + substitution.start });
				tokens.push({ value: ";", operator: true, quoted: false, start: substitution.start, end: substitution.start });
			}
			nextBody += 1;
			index = body.end - 1;
			continue;
		}
		if (quote !== null) {
			if (char === quote) {
				quote = null;
				continue;
			}
			if (quote === '"' && char === "\\" && index + 1 < command.length) {
				const next = command[index + 1] ?? "";
				if (next === "\n" || '$`"\\'.includes(next)) {
					index += 1;
					if (next !== "\n") current += next;
					continue;
				}
			}
			if (quote === '"' && char === "`") {
				const close = appendBacktick(index);
				if (close !== null) {
					index = close;
					continue;
				}
			}
			if (quote === '"' && char === "$" && command[index + 1] === "(") {
				// ORCH-005: double quotes preserve the word but still execute $(...).
				const close = matchingParen(command, index + 1);
				current += command.slice(index, close + 1);
				substitutions.push(command.slice(index + 2, close));
				index = close;
				continue;
			}
			current += char;
			continue;
		}

		if (char === "$" && (command[index + 1] === "'" || command[index + 1] === '"')) {
			wordStart ??= index;
			quoted = true;
			if (command[index + 1] === "'") {
				const decoded = decodeAnsiCQuote(command, index + 1);
				current += decoded.value;
				hiddenContent ||= decoded.hidden;
				ansiCQuoted = true;
				index = decoded.end;
			} else {
				hiddenContent = true;
				quote = '"';
				index += 1;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			wordStart ??= index;
			quoted = true;
			quote = char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			// Backslash-newline joins lines before tokenization, even between words.
			if (command[index + 1] !== "\n") {
				wordStart ??= index;
				quoted = true;
				current += command[index + 1] ?? "";
			}
			index += 1;
			continue;
		}
		if (char === "`") {
			const close = appendBacktick(index);
			if (close !== null) {
				index = close;
				continue;
			}
		}
		if (char === "#" && wordStart === null) {
			// A comment starts only at an unquoted word boundary. Leave its newline
			// for normal separation so a following command is still inspected.
			while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
			continue;
		}
		if (/\s/.test(char)) {
			pushCurrent(index);
			if (char === "\n") tokens.push({ value: ";", operator: true, quoted: false, start: index, end: index + 1 });
			continue;
		}
		if (char === "(") {
			// `$(`, `<(`, and `>(` open a substitution that belongs to the word it
			// sits in, so `$(echo)/../x` stays one path; its script is kept for
			// the scanners that read it as a child command.
			const previous = tokens.at(-1);
			const dollar = wordStart !== null && command[index - 1] === "$" && current.endsWith("$");
			const processSubstitution =
				wordStart === null &&
				previous?.operator === true &&
				previous.end === index &&
				(previous.value === "<" || previous.value === ">");
			if (dollar || processSubstitution) {
				const close = matchingParen(command, index);
				if (processSubstitution) {
					tokens.pop();
					wordStart = index - 1;
					current = previous.value;
				}
				current += command.slice(index, close + 1);
				substitutions.push(command.slice(index + 1, close));
				index = close;
				continue;
			}
		}
		if (";&|><()".includes(char)) {
			pushCurrent(index);
			const three = command.slice(index, index + 3);
			const two = command.slice(index, index + 2);
			const value =
				SHELL_REDIRECTIONS.has(three) || COMMAND_SEPARATORS.has(three)
					? three
					: SHELL_REDIRECTIONS.has(two) || COMMAND_SEPARATORS.has(two)
						? two
						: char;
			tokens.push({ value, operator: true, quoted: false, start: index, end: index + value.length });
			index += value.length - 1;
			continue;
		}
		wordStart ??= index;
		current += char;
	}
	const unterminated = quote !== null;
	pushCurrent(command.length);
	const last = tokens.at(-1);
	if (unterminated && last !== undefined) last.unterminated = true;
	return tokens;
}

/** ORCH-006: backticks delimit a child script outside single quotes unless escaped. */
function matchingBacktick(command: string, open: number): number | null {
	for (let index = open + 1; index < command.length; index += 1) {
		if (command[index] === "\\") index += 1;
		else if (command[index] === "`") return index;
	}
	return null;
}

/**
 * The index of the `)` that closes the `(` at `open`, skipping quoted text and
 * escapes, or the last index when the substitution is never closed.
 */
function matchingParen(command: string, open: number): number {
	let depth = 0;
	let quote: "'" | '"' | null = null;
	for (let index = open; index < command.length; index += 1) {
		const char = command[index];
		if (quote !== null) {
			if (char === "\\" && quote === '"') index += 1;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "\\") index += 1;
		else if (char === "'" || char === '"') quote = char;
		else if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return command.length - 1;
}

/**
 * The segments of the substitutions a segment's words carry, read as child
 * commands; they run before the segment's own command does.
 */
function substitutionSegments(
	tokens: ReadonlyArray<ShellToken>,
	depth: number,
	skipHeredocBodies = false,
): ShellToken[][] {
	if (depth >= INNER_SHELL_MAX_DEPTH) return [];
	return tokens.flatMap((token) =>
		(token.substitutions ?? []).flatMap((script) => expandedShellSegments(script, depth + 1, skipHeredocBodies)),
	);
}

/** scanShellLike with each substitution's tokens appended after a `;`, for scans that read every word. */
/**
 * A command with its locale quotes (`$"..."`) read as the plain double quotes
 * bash runs them as when no message catalog translates them, or null (#419).
 * Every `$"` is rewritten, so the result is accepted only when it scans to the
 * same words and operators as the original and hides nothing: a `$"` that was
 * not a locale opener (inside single quotes, after a backslash) changes a word
 * and is refused, as is an ANSI-C escape that cannot be decoded.
 */
export function decodedLocaleQuoting(command: string): string | null {
	const decoded = command.replaceAll('$"', '"');
	if (decoded === command) return null;
	const before = scanShellLikeDeep(command);
	const after = scanShellLikeDeep(decoded);
	if (after.some((token) => token.hiddenContent) || before.length !== after.length) return null;
	const same = before.every(
		(token, index) => token.value === after[index]?.value && token.operator === after[index]?.operator,
	);
	return same ? decoded : null;
}

export function scanShellLikeDeep(command: string, depth = 0): ShellToken[] {
	const tokens = scanShellLike(command);
	if (depth >= INNER_SHELL_MAX_DEPTH) return tokens;
	const inner = tokens.flatMap((token) =>
		(token.substitutions ?? []).flatMap((script) => [
			{ value: ";", operator: true, quoted: false, start: token.start, end: token.start },
			...scanShellLikeDeep(script, depth + 1),
		]),
	);
	for (const segment of splitSegments(tokens)) {
		const script = segmentShellScript(shellCommandArguments(segment));
		if (typeof script === "string") {
			inner.push({ value: ";", operator: true, quoted: false, start: 0, end: 0 }, ...scanShellLikeDeep(script, depth + 1));
		}
	}
	return [...tokens, ...inner];
}

/** The simple commands of a token run: split at `;`, `&`, `&&`, `||`, `|` and parentheses, redirections kept. */
export function splitSegments(tokens: ReadonlyArray<ShellToken>): ShellToken[][] {
	const segments: ShellToken[][] = [];
	let current: ShellToken[] = [];
	for (const token of tokens) {
		if (token.operator && COMMAND_SEPARATORS.has(token.value)) {
			if (current.length > 0) segments.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

/**
 * Reserved words that can stand before a command in the same segment: a brace
 * group, a negation, and the heads of if, loop, and else bodies. Without them
 * `if true; then cd /x; fi` read `then` as the command and hid the cd.
 */
const SHELL_RESERVED_PREFIXES: ReadonlySet<string> = new Set([
	"{",
	"!",
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"do",
	"time",
]);

function commandTokenIndex(segment: ReadonlyArray<string>): number | null {
	let index = 0;
	while (index < segment.length) {
		const token = segment[index];
		if (token === undefined) return null;
		if (SHELL_RESERVED_PREFIXES.has(token)) {
			index += 1;
			continue;
		}
		if (isEnvAssignment(token)) {
			index += 1;
			continue;
		}
		if (token === "env") {
			index += 1;
			for (let option = segment[index]; option !== undefined; option = segment[index]) {
				if (option.startsWith("-")) index += ENV_VALUE_OPTIONS.has(option) ? 2 : 1;
				else if (isEnvAssignment(option)) index += 1;
				else break;
			}
			continue;
		}
		if (SHELL_WRAPPERS.has(token)) {
			index += 1;
			const valued = token === "sudo" || token === "doas" ? PRIVILEGE_VALUE_OPTIONS : undefined;
			for (let option = segment[index]; option?.startsWith("-") === true; option = segment[index]) {
				index += valued?.has(option) === true ? 2 : 1;
				if (option === "--") break;
			}
			continue;
		}
		const past = pastTransparentWrapper(segment, index);
		if (past !== index) {
			index = past;
			continue;
		}
		return index;
	}
	return null;
}

/** The index past a transparent wrapper standing at `index` and its options, or `index` when none stands there. */
function pastTransparentWrapper(segment: ReadonlyArray<string>, index: number): number {
	const token = segment[index];
	const valued = token === undefined ? undefined : TRANSPARENT_WRAPPERS.get(token);
	if (valued === undefined) return index;
	let next = index + 1;
	for (let option = segment[next]; option?.startsWith("-") === true; option = segment[next]) {
		next += valued.has(option) ? 2 : 1;
		if (option === "--") break;
	}
	// timeout's duration stands between its options and the command it runs.
	return token === "timeout" ? next + 1 : next;
}

/**
 * `env` options that take the next word as their value. `-C`/`--chdir` move the command elsewhere and `-S` re-splits a
 * string, which {@link wrapperMovesDirectory} holds against a check.
 */
const ENV_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
/** `sudo` and `doas` options that take the next word as their value (`sudo -u bob npm test` runs npm). */
const PRIVILEGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-u",
	"--user",
	"-g",
	"--group",
	"-C",
	"--close-from",
	"-D",
	"--chdir",
	"-h",
	"--host",
	"-p",
	"--prompt",
	"-r",
	"--role",
	"-t",
	"--type",
	"-T",
	"--command-timeout",
	"-U",
	"--other-user",
]);

/**
 * Commands that run the rest of their segment unchanged, each with its options that take the next word as a value:
 * `timeout [opts] DURATION`, `nice [-n N | -N]`, `xvfb-run [opts]`, `stdbuf [-i|-o|-e MODE]`, `ionice [-c C] [-n N]`
 * and `nohup` (SF-2). The command after them is the one every reader judges, so `timeout 300 npm test` runs a check
 * and `timeout 5 rm -rf x` deletes.
 */
const TRANSPARENT_WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
	["nice", new Set(["-n", "--adjustment"])],
	["stdbuf", new Set(["-i", "-o", "-e"])],
	["ionice", new Set(["-c", "--class", "-n", "--classdata"])],
	["nohup", new Set<string>()],
	[
		"xvfb-run",
		new Set([
			"-e",
			"--error-file",
			"-f",
			"--auth-file",
			"-n",
			"--server-num",
			"-p",
			"--xauth-protocol",
			"-s",
			"--server-args",
			"-w",
			"--wait",
		]),
	],
]);

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** True for a command word that names a file by a relative path (`./x`, `bin/x`), not a bare name or absolute path. */
export function isRelativeCommandPath(token: string | undefined): boolean {
	if (token === undefined) return false;
	const normalized = token.replace(/\\/g, "/");
	return (
		normalized.includes("/") &&
		!normalized.startsWith("/") &&
		!normalized.startsWith("~") &&
		!/^[A-Za-z]:\//u.test(normalized)
	);
}

function basenameToken(token: string | undefined): string {
	if (token === undefined) return "";
	const normalized = token.replace(/\\/g, "/");
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	return basename.toLowerCase();
}

function artifactMap(artifacts: ReadonlyArray<ProtectedArtifact>): Map<string, ProtectedArtifact> {
	const out = new Map<string, ProtectedArtifact>();
	for (const artifact of artifacts) {
		const key = normalizePathKey(artifact.path);
		if (key !== null) out.set(key, cloneArtifact(artifact));
	}
	return out;
}

function stateFromMap(artifacts: ReadonlyMap<string, ProtectedArtifact>): ProtectedArtifactState {
	return {
		artifacts: Array.from(artifacts.entries())
			.sort(([left], [right]) => compareStrings(left, right))
			.map(([, artifact]) => cloneArtifact(artifact)),
	};
}

function normalizedArtifacts(artifacts: ReadonlyArray<ProtectedArtifact>): NormalizedArtifact[] {
	const out = Array.from(artifactMap(artifacts).entries()).map(([key, artifact]) => ({ key, artifact }));
	out.sort((left, right) => compareStrings(left.key, right.key));
	return out;
}

function cloneArtifact(artifact: ProtectedArtifact): ProtectedArtifact {
	const cloned: ProtectedArtifact = {
		path: artifact.path,
		protectedAt: artifact.protectedAt,
		reason: artifact.reason,
		source: artifact.source,
	};
	if (artifact.validationCommand !== undefined) cloned.validationCommand = artifact.validationCommand;
	if (artifact.validationExitCode !== undefined) cloned.validationExitCode = artifact.validationExitCode;
	return cloned;
}

function normalizePathKey(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;
	if (isWindowsAbsolutePath(trimmed) && path.sep !== "\\") {
		return toSlashKey(path.win32.normalize(trimmed));
	}
	// Physical, as the kernel resolves `link/..` in a command's path argument.
	const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
	return toSlashKey(canonicalizeRawPath(trimmed, process.cwd()) ?? canonicalizeExistingPath(resolved));
}

function wildcardRootKey(input: string): string | null {
	const normalizedInput = toSlashKey(input.trim());
	const firstWildcard = firstWildcardIndex(normalizedInput);
	if (firstWildcard === null) return null;
	const prefix = normalizedInput.slice(0, firstWildcard);
	const slash = prefix.lastIndexOf("/");
	const root = slash >= 0 ? prefix.slice(0, slash + 1) : ".";
	return normalizePathKey(root);
}

function firstWildcardIndex(input: string): number | null {
	const indexes = ["*", "?", "["].map((char) => input.indexOf(char)).filter((index) => index >= 0);
	if (indexes.length === 0) return null;
	return Math.min(...indexes);
}

function isWindowsAbsolutePath(input: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(input);
}

function toSlashKey(input: string): string {
	return input.replace(/\\/g, "/");
}

function compareMatches(left: ProtectedArtifactCommandMatch, right: ProtectedArtifactCommandMatch): number {
	return (
		compareStrings(left.artifactPath, right.artifactPath) ||
		compareStrings(left.commandPath, right.commandPath) ||
		compareStrings(left.reason, right.reason)
	);
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
