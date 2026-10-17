/**
 * Literal argv for a command string that a POSIX shell would run as exactly
 * one simple command, or an Error naming the first construct that makes the
 * reading ambiguous. Nothing is expanded or executed: operators, substitution,
 * redirection, background launches and multi-line scripts are refused rather
 * than interpreted.
 *
 * Verify uses it for project-declared scripts; memory uses it to decide
 * whether one successful shell receipt can vouch for the program it names.
 * `shellLikeChain` reads the one compound form whose exit status still
 * speaks for every part: `a && b` exits 0 only when `a` and then `b` both
 * ran to completion and exited 0.
 */
export interface ShellArgvOptions {
	/** Refuse an unquoted `#` that starts a word: the shell would drop the rest of the line as a comment. */
	readonly rejectComments?: boolean;
	/** Allow leading `NAME=value` words, returned separately instead of refused. */
	readonly allowAssignments?: boolean;
}

export interface ShellInvocation {
	assignments: string[];
	argv: string[];
}

/** One segment of an `&&` chain, with the exact text the shell would run for it. */
export interface ShellChainSegment extends ShellInvocation {
	text: string;
}

export function shellLikeArgv(command: string, options: ShellArgvOptions = {}): string[] | Error {
	const parsed = shellLikeInvocation(command, options);
	return parsed instanceof Error ? parsed : parsed.argv;
}

export function shellLikeInvocation(command: string, options: ShellArgvOptions = {}): ShellInvocation | Error {
	const chain = shellLikeChain(command, options, false);
	if (chain instanceof Error) return chain;
	const [segment] = chain;
	if (segment === undefined || chain.length !== 1) return new Error("empty command");
	return { assignments: segment.assignments, argv: segment.argv };
}

/**
 * The simple commands of a pure `&&` chain, in order. Any other operator,
 * substitution, comment (when refused), background launch or multi-line
 * script is an Error, as is an empty segment.
 */
export function shellLikeChain(
	command: string,
	options: ShellArgvOptions = {},
	allowAnd = true,
): ShellChainSegment[] | Error {
	const segments: ShellChainSegment[] = [];
	let words: string[] = [];
	let token = "";
	let quote: "single" | "double" | null = null;
	let tokenStarted = false;
	let segmentStart = 0;
	const closeSegment = (end: number): Error | null => {
		if (tokenStarted) words.push(token);
		token = "";
		tokenStarted = false;
		const segment = buildSegment(words, command.slice(segmentStart, end).trim(), options);
		words = [];
		if (segment instanceof Error) return segment;
		segments.push(segment);
		return null;
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index] ?? "";
		if (quote === "single") {
			if (character === "'") quote = null;
			else token += character;
			tokenStarted = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = null;
				continue;
			}
			if (character === "\\") {
				const next = command[index + 1];
				if (next === undefined) return new Error("trailing escape");
				token += next;
				index += 1;
			} else if (character === "$" || character === "`") {
				return new Error(`shell expansion '${character}' is ambiguous`);
			} else {
				token += character;
			}
			tokenStarted = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (tokenStarted) {
				words.push(token);
				token = "";
				tokenStarted = false;
			}
			continue;
		}
		if (character === "'") {
			quote = "single";
			tokenStarted = true;
			continue;
		}
		if (character === '"') {
			quote = "double";
			tokenStarted = true;
			continue;
		}
		if (character === "\\") {
			const next = command[index + 1];
			if (next === undefined) return new Error("trailing escape");
			token += next;
			tokenStarted = true;
			index += 1;
			continue;
		}
		if (character === "#" && !tokenStarted && options.rejectComments === true) {
			return new Error("shell comment '#' is ambiguous");
		}
		if (allowAnd && character === "&" && command[index + 1] === "&") {
			const closed = closeSegment(index);
			if (closed !== null) return closed;
			index += 1;
			segmentStart = index + 1;
			continue;
		}
		if ("|&;<>()`$\n\r".includes(character)) {
			return new Error(`shell operator or expansion '${character}' is ambiguous`);
		}
		token += character;
		tokenStarted = true;
	}
	if (quote !== null) return new Error(`unterminated ${quote}-quoted argument`);
	const closed = closeSegment(command.length);
	if (closed !== null) return closed;
	return segments;
}

function buildSegment(words: string[], text: string, options: ShellArgvOptions): ShellChainSegment | Error {
	const assignments: string[] = [];
	if (options.allowAssignments === true) {
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) assignments.push(words.shift() ?? "");
	}
	if (words.length === 0) return new Error("empty command");
	if ((words[0] ?? "").includes("=")) return new Error("environment assignments are not argv executables");
	return { assignments, argv: words, text };
}
