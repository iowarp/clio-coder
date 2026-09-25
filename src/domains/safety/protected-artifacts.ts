import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import { canonicalizeExistingPath, canonicalizeRawPath } from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import { isVerificationScriptName } from "../../core/verification-scripts.js";

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
		if (isSameOrDescendant(candidate, artifact.key)) return true;
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
	for (const tokens of splitSegments(scanShellLike(command))) {
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
	for (const segment of expandedShellSegments(command)) {
		collectRedirectTargets(segment, targets);
		const argv = shellCommandArguments(segment);
		collectInvokedWriteTargets(argv, targets);
		collectInPlaceEditTargets(argv, targets);
	}
	return targets.filter(isInterestingWriteTarget);
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
function segmentShellScript(segment: ReadonlyArray<string>): string | null {
	const commandIndex = commandTokenIndex(segment);
	if (commandIndex === null) return null;
	if (!INNER_SHELLS.has(basenameToken(segment[commandIndex]))) return null;
	for (let index = commandIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (token.startsWith("-") && token.length > 1) {
			if (!token.slice(1).includes("c")) continue;
			const script = segment[index + 1];
			return script !== undefined && script.length > 0 ? script : null;
		}
		// The first operand of a shell invocation without -c is a script file,
		// whose contents this scanner cannot see anyway.
		return null;
	}
	return null;
}

/**
 * A command's segments, with every `sh -c '<script>'` wrapper followed by the
 * segments of the script it runs. The wrapper segment itself is kept: a
 * scanner that reads its operands (`cp`, `tee`) must still see them.
 */
function expandedShellSegments(command: string, depth = 0): ShellToken[][] {
	const segments = splitSegments(scanShellLike(command));
	if (depth >= INNER_SHELL_MAX_DEPTH) return segments;
	const out: ShellToken[][] = [];
	for (const segment of segments) {
		out.push(segment, ...substitutionSegments(segment, depth));
		const script = segmentShellScript(shellCommandArguments(segment));
		if (script !== null) out.push(...expandedShellSegments(script, depth + 1));
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
	return segmentShellScript(shellCommandArguments(segment));
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
	| { kind: "subshell"; open: boolean };

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
 */
export function extractCommandPathWalks(command: string): CommandPathEvent[][] {
	const withoutBodies = withoutHeredocBodies(command);
	if (withoutBodies === command) return [extractCommandPathWalk(command)];
	const removedAll = !scanShellLike(withoutBodies).some((token) => token.operator && token.value === "<<");
	return [extractCommandPathWalk(command, !removedAll), extractCommandPathWalk(withoutBodies)];
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
function withoutHeredocBodies(command: string): string {
	let text = command;
	for (let pass = 0; pass < MAX_HEREDOCS; pass += 1) {
		const tokens = scanShellLike(text);
		const first = tokens.findIndex((token) => token.operator && token.value === "<<");
		if (first === -1) return text;
		const lineEnd = tokens.findIndex(
			(token, index) => index > first && token.operator && token.value === ";" && text[token.start] === "\n",
		);
		const docs: Array<{ start: number; end: number; word: string; stripTabs: boolean }> = [];
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
			if (word === undefined || word.operator) return text;
			const delimiter = stripTabs && text[word.start] === "-" ? word.value.slice(1) : word.value;
			docs.push({ start: operator.start, end: word.end, word: delimiter, stripTabs });
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
		for (const doc of docs) {
			while (cursor < text.length) {
				const newline = text.indexOf("\n", cursor);
				const line = text.slice(cursor, newline === -1 ? text.length : newline);
				cursor = newline === -1 ? text.length : newline + 1;
				if ((doc.stripTabs ? line.replace(/^\t+/u, "") : line) === doc.word) break;
			}
		}
		text = `${head.slice(0, bodyStart)}${text.slice(cursor)}`;
	}
	return text;
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
	const cd = cdTarget(argv);
	if (cd !== null) {
		walk.events.push({
			kind: "cd",
			target: cd,
			unmodeled: walk.loopDepth > 0 || walk.functionSeen || walk.cdpath || walk.heredocSeen,
		});
	}
	const script = segmentShellScript(argv);
	if (script !== null) collectChildScript(script, depth, walk);
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

/**
 * The index of the link command a wrapper runs, and whether its operands come
 * from input. A wrapper's own options and arguments are skipped by looking for
 * the next word that names a link command or another wrapper; `find` runs
 * what follows `-exec`, `-execdir`, `-ok`, or `-okdir`.
 */
function linkCommandIndex(argv: ReadonlyArray<string>): { index: number; fromInput: boolean } | null {
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
						(word, at) => at > from && (LINK_COMMANDS.has(basenameToken(word)) || LINK_WRAPPERS.has(basenameToken(word))),
					);
		index = next > from ? next : null;
	}
	return index === null ? null : { index, fromInput };
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
	const found = linkCommandIndex(argv);
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

/** Recognizable operator CLI installation paths invoked through a model shell.
 * This is command inspection, not confinement of arbitrary scripts or aliases.
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
		if (
			args[0] !== "skills" &&
			args[0] !== "library" &&
			args[0] !== "plugins" &&
			args[0] !== "extensions" &&
			args[0] !== "interop"
		)
			continue;
		if (excludeLibrary && args[0] === "library") continue;
		if (resourceCliMutatesSkills(args[0], args.slice(1))) return true;
	}
	return false;
}

function shellCommandArguments(segment: ReadonlyArray<ShellToken>): string[] {
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
	return args.map((token) => token.value);
}

function resourceCliMutatesSkills(
	resource: "skills" | "library" | "plugins" | "extensions" | "interop",
	args: ReadonlyArray<string>,
): boolean {
	// Both resource parsers accept flags before the verb. Consume their value
	// options so a catalog path called --yes or --help is not treated as a flag.
	const valueOptions =
		resource === "skills"
			? ["--name", "--category", "--scenario", "--target", "--workspace", "--timeout"]
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
	if (resource === "plugins" || resource === "extensions")
		return ["install", "update", "remove", "enable", "disable", "pin"].includes(verb ?? "");
	if (resource === "interop") return verb === "adopt" && confirmed && !dryRun;
	// A package of any kind may carry skills or require a skill dependency.
	// Only install/update implement a dry-run; other mutations cannot spend it.
	if ((verb === "install" || verb === "update") && dryRun) return false;
	return ["install", "update", "remove", "enable", "disable", "pin", "register", "sync"].includes(verb ?? "");
}

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
	if (executable === "cp" || executable === "mv") {
		const args = pathArgs(segment, cmdIndex);
		const destination = args.at(-1);
		if (args.length >= 2 && destination !== undefined) out.push(destination);
	}
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

function findRoots(args: ReadonlyArray<string>): string[] {
	const roots: string[] = [];
	for (const token of args) {
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
		return isSameOrDescendant(artifactKey, wildcardRoot);
	}
	const commandKey = normalizePathKey(commandPath);
	if (commandKey === null) return false;
	if (mode === "target") return isSameOrDescendant(commandKey, artifactKey);
	return isSameOrDescendant(commandKey, artifactKey) || isSameOrDescendant(artifactKey, commandKey);
}

/**
 * Every fixed label `validationMatch` returns. The only other label is the
 * `npm run <verification script>` family. The policy engine's
 * `TEST_RUNNER_COMMANDS` must run each of these without an ask in default;
 * `tests/contracts/test-runner-vocabulary.test.ts` fails when the two drift.
 */
export const VALIDATION_COMMAND_LABELS = [
	"npm test",
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
): ValidationCommandLabel | `npm run ${string}` | null {
	if (executable === "node" && args[0] === "--test") return "node --test";
	if (executable === "npm") {
		if (args[0] === "test") return "npm test";
		const script = args[0] === "run" && typeof args[1] === "string" ? args[1] : null;
		if (script !== null && isVerificationScriptName(script)) return `npm run ${script}`;
	}
	if (executable === "pytest") return "pytest";
	if (isPythonExecutable(executable) && moduleArg(args) === "pytest") return "python -m pytest";
	if (isPythonExecutable(executable) && moduleArg(args) === "unittest") return "python -m unittest";
	if (executable === "cargo" && args[0] === "test") return "cargo test";
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

/**
 * The `grounding`-only half of the vocabulary. Every rule here is an exact
 * leading-command match on a canonicalized executable, never a substring guess,
 * so a command that merely mentions `tsc` or `diff` in an argument stays
 * unrecognized. Failing to match is the safe direction for this scope.
 */
function groundingMatch(executable: string, args: ReadonlyArray<string>): string | null {
	if (executable === "git") {
		if (args[0] === "diff") return "git diff";
		if (args[0] === "status") return "git status";
		return null;
	}
	if (executable === "node") {
		if (args.includes("--test")) return "node --test";
		if (args.includes("-e") || args.includes("--eval")) return "node -e";
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

/** Flat compatibility values; use scanShellLike when operator identity matters. */
export function tokenizeShellLike(command: string): string[] {
	return scanShellLike(command).map((token) => token.value);
}

/** Literal argv by command, with actual operators and redirections removed. */
export function commandArgumentSegments(command: string): string[][] {
	return splitSegments(scanShellLike(command)).map(shellCommandArguments);
}

/** Literal shell words and operators only; no expansion or script execution. */
export function scanShellLike(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let current = "";
	let wordStart: number | null = null;
	let quoted = false;
	let quote: "'" | '"' | null = null;

	let substitutions: string[] = [];
	const pushCurrent = (end: number): void => {
		if (wordStart === null) return;
		const token: ShellToken = { value: current, operator: false, quoted, start: wordStart, end };
		if (substitutions.length > 0) token.substitutions = substitutions;
		tokens.push(token);
		current = "";
		wordStart = null;
		quoted = false;
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
	pushCurrent(command.length);
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
function substitutionSegments(tokens: ReadonlyArray<ShellToken>, depth: number): ShellToken[][] {
	if (depth >= INNER_SHELL_MAX_DEPTH) return [];
	return tokens.flatMap((token) =>
		(token.substitutions ?? []).flatMap((script) => expandedShellSegments(script, depth + 1)),
	);
}

/** scanShellLike with each substitution's tokens appended after a `;`, for scans that read every word. */
export function scanShellLikeDeep(command: string, depth = 0): ShellToken[] {
	const tokens = scanShellLike(command);
	if (depth >= INNER_SHELL_MAX_DEPTH) return tokens;
	const inner = tokens.flatMap((token) =>
		(token.substitutions ?? []).flatMap((script) => [
			{ value: ";", operator: true, quoted: false, start: token.start, end: token.start },
			...scanShellLikeDeep(script, depth + 1),
		]),
	);
	return [...tokens, ...inner];
}

function splitSegments(tokens: ReadonlyArray<ShellToken>): ShellToken[][] {
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
			while (
				index < segment.length &&
				(segment[index]?.startsWith("-") === true || isEnvAssignment(segment[index] ?? ""))
			) {
				index += 1;
			}
			continue;
		}
		if (SHELL_WRAPPERS.has(token)) {
			index += 1;
			while (index < segment.length && segment[index]?.startsWith("-") === true) index += 1;
			continue;
		}
		return index;
	}
	return null;
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
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

function isSameOrDescendant(candidate: string, parent: string): boolean {
	if (candidate === parent) return true;
	const relative = path.posix.relative(parent, candidate);
	return relative !== "" && !relative.startsWith("..") && !path.posix.isAbsolute(relative);
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
