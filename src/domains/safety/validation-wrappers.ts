/**
 * What a `safety.validationWrappers` entry may name (FX-44). A declared wrapper only lets a check behind it count, so
 * no entry may name a command that writes or removes files, runs a shell or an interpreter, or runs no check of its own
 * words: settings validation refuses such an entry and the shell reader ignores one at match time, both from this one
 * list. It is a guard only: the shell reader reads every declared wrapper as a program that may write, whatever it is.
 */

/** Commands whose run writes, moves, removes or re-permissions files whatever their operands. */
export const FILE_WRITER_COMMANDS: ReadonlySet<string> = new Set([
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

/** Shells, which read their words as a script or a file to run rather than as a check. */
const SHELLS: ReadonlyArray<string> = ["sh", "bash", "dash", "zsh", "ksh", "mksh", "fish", "csh", "tcsh"];

/** Interpreters, by name with or without a version (`python3.12`), which run inline code an option carries. */
const INTERPRETER = /^(?:python|pypy|node|nodejs|bun|deno|perl|ruby|php|lua|luajit)(?:\d+(?:\.\d+)*)?$/u;

/** Filters and tools that write or run what their options say (`sed -i`, `awk 'BEGIN{system(...)}'`, `curl -o`). */
const WRITING_TOOLS: ReadonlyArray<string> = ["sed", "awk", "gawk", "mawk", "nawk", "sort", "uniq", "curl", "git"];

/** Read-only inspection commands, which print or test their operands and run none of them. */
const INSPECTION_WORDS: ReadonlyArray<string> = [
	"cat",
	"ls",
	"head",
	"tail",
	"wc",
	"pwd",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"stat",
	"cut",
	"tr",
	"file",
	"diff",
	"cmp",
	"du",
	"df",
	"tree",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"date",
	"sleep",
	"exit",
	"return",
	"jq",
];

/**
 * Words that print, test, resolve or reshuffle their arguments instead of running them as the check they spell
 * (`echo pnpm test`, `command -v pnpm`, `xargs pnpm test`), and builtins that replace or source what follows.
 */
const NON_RUNNING_WORDS: ReadonlyArray<string> = [
	"echo",
	"printf",
	"true",
	"false",
	":",
	"test",
	"[",
	"[[",
	"xargs",
	"which",
	"command",
	"type",
	"builtin",
	"eval",
	"exec",
	"nohup",
	"source",
	".",
	"find",
];

const REFUSED_WRAPPERS: ReadonlySet<string> = new Set([
	...FILE_WRITER_COMMANDS,
	...SHELLS,
	...NON_RUNNING_WORDS,
	...WRITING_TOOLS,
	...INSPECTION_WORDS,
]);

/** The name a wrapper word or entry is judged by: its basename, lower-cased. */
function wrapperName(word: string): string {
	const normalized = word.replace(/\\/gu, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

/** Whether a command word, by its basename, can never be a validation wrapper. */
export function isRefusedValidationWrapper(word: string): boolean {
	const name = wrapperName(word);
	return REFUSED_WRAPPERS.has(name) || INTERPRETER.test(name);
}

/** Why an entry cannot be a validation wrapper, or null when it can. */
export function validationWrapperProblem(entry: string): string | null {
	if (entry.length === 0 || entry !== entry.trim() || wrapperName(entry) === "") return "not a script path or name";
	if (isRefusedValidationWrapper(entry))
		return "writes files, runs a shell or an interpreter, or runs no check of its words, so it cannot be a validation wrapper";
	return null;
}
