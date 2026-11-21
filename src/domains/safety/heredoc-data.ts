import path from "node:path";
import {
	commandHasPart,
	parseShellScript,
	type ShellRedirect,
	type ShellScript,
	type ShellSimpleCommand,
	staticCommandName,
	staticWordValue,
} from "./shell-syntax.js";

/**
 * Quoted here-documents the protected-artifact rail (C-7) and the secret-path
 * rail (C-22) read as data, proven on the parsed command (row 287). A body is
 * data only when the whole call is read by {@link parseShellScript} and nothing
 * in it can run the body or a file it lands in:
 *
 * - every step is a plain simple command: no assignment, no expansion of any kind,
 *   no background job, a command name the text fixes (so no alias, function, PATH
 *   change or spelled-out builtin can stand in for it);
 * - each here-document is quoted, alone on its step, not piped and not negated,
 *   and its step is `cat` or `tee` copying it into files, `git commit -F -`
 *   reading it as the message, or a step that never reads its input;
 * - every other step runs nothing: a fixed set of readers and plain writers,
 *   `git add`/`status`/`diff`/`log`/`show` (only when nothing is copied, since git
 *   runs hooks and configured programs a copy could be), or an interpreter
 *   that reads no project file asked only for its version;
 * - no file any step writes (a copy, a redirect, a tee operand) lands in a device, in `.git*` or in `.husky`, or is
 *   named like a command the call runs.
 *
 * Anything else keeps the rail's older reading, which reads the body as
 * commands. The command line itself, redirect targets included, stays judged.
 */

/**
 * Steps that run no file, execute nothing they read and open no file their input or a file names: `wc` is not one,
 * since GNU `wc --files0-from` opens the names a copied body holds.
 */
const INERT_STEPS: ReadonlySet<string> = new Set([
	"cat",
	"tee",
	"echo",
	"printf",
	"ls",
	"head",
	"tail",
	"grep",
	"diff",
	"cmp",
	"stat",
	"true",
	"false",
	":",
	"pwd",
	"test",
	"[",
	"mkdir",
	"touch",
]);
/** Steps that never read their standard input, so a here-document on them is unread. */
const STDIN_NON_READERS: ReadonlySet<string> = new Set([":", "true", "false", "echo", "printf", "pwd"]);
const GIT_INERT_SUBCOMMANDS: ReadonlySet<string> = new Set(["add", "commit", "status", "diff", "log", "show"]);
const TEE_OPTIONS: ReadonlySet<string> = new Set(["-a", "--append", "-i", "--ignore-interrupts", "-p"]);
const VERSION_ONLY: ReadonlySet<string> = new Set(["--version", "-V"]);
/** Programs whose version query reads no project file: a package manager or build tool may load config from the cwd. */
const VERSION_PROGRAMS: ReadonlySet<string> = new Set([
	"node",
	"python3",
	"python",
	"git",
	"bash",
	"sh",
	"go",
	"rustc",
]);
const PLAIN_REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">|", "<", "<<<", "&>", "&>>", ">&", "<&"]);
const STDOUT_REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<>"]);
const DESCRIPTOR = /^(?:\d+-?|-)$/u;

/** Every file a step's standard output or error lands in (a descriptor duplication names none), or null when one is unread. */
function writeTargets(command: ShellSimpleCommand): string[] | null {
	const targets: string[] = [];
	for (const redirect of command.redirects) {
		if (!STDOUT_REDIRECTS.has(redirect.op)) continue;
		const both = redirect.op === "&>" || redirect.op === "&>>";
		const fd = redirect.fd ?? (redirect.op === "<>" ? 0 : 1);
		if (!both && fd !== 1 && fd !== 2) continue;
		const target = staticWordValue(redirect.target);
		if (target === null) return null;
		if ((redirect.op === ">&" || redirect.op === "<&") && DESCRIPTOR.test(target)) continue;
		targets.push(target);
	}
	return targets;
}

/** `git commit` flags that take no value and read nothing (`-p`, `-e` and `--interactive` read the terminal). */
const COMMIT_FLAGS: ReadonlySet<string> = new Set([
	"--all",
	"--quiet",
	"--verbose",
	"--signoff",
	"--no-signoff",
	"--no-verify",
	"--allow-empty",
	"--allow-empty-message",
	"--no-edit",
	"--amend",
	"--no-post-rewrite",
	"--no-gpg-sign",
	"--reset-author",
	"--only",
	"--include",
	"--status",
	"--no-status",
]);
const COMMIT_SHORT_FLAGS = /^[aqvsnoi]$/u;
/** `git commit` options whose value is the next word or follows `=`; `--file` is the message source. */
const COMMIT_VALUES: ReadonlySet<string> = new Set(["--file", "--author", "--date", "--cleanup", "--trailer"]);

/**
 * Whether `git commit` arguments (after `commit`) read standard input only as the message: one `-F`/`--file` whose
 * value is `-`, every other option known and its value consumed, so `-m --file=-` or `--author=-F-` is a value, not
 * a message source. Any other option (`--pathspec-from-file`, `-p`, an abbreviation) fails the reading.
 */
export function gitCommitReadsStdinAsMessage(args: ReadonlyArray<string>): boolean {
	let files = 0;
	let stdin = false;
	const take = (option: string, value: string | undefined): boolean => {
		if (value === undefined) return false;
		if (option === "--file") {
			files += 1;
			stdin = value === "-";
		}
		return true;
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] as string;
		if (arg === "--") break;
		if (!arg.startsWith("-") || arg === "-") continue;
		if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			const option = equals === -1 ? arg : arg.slice(0, equals);
			if (COMMIT_FLAGS.has(arg)) continue;
			if (!COMMIT_VALUES.has(option)) return false;
			if (equals === -1) index += 1;
			if (!take(option, equals === -1 ? args[index] : arg.slice(equals + 1))) return false;
			continue;
		}
		// A short cluster: flags, then at most one `F` whose value is the rest of the word or the next one.
		for (let at = 1; at < arg.length; at += 1) {
			const flag = arg[at] as string;
			if (COMMIT_SHORT_FLAGS.test(flag)) continue;
			if (flag !== "F") return false;
			const attached = at + 1 < arg.length;
			if (!attached) index += 1;
			if (!take("--file", attached ? arg.slice(at + 1) : args[index])) return false;
			break;
		}
	}
	return files === 1 && stdin;
}

function readsAsMessage(args: ReadonlyArray<string>): boolean {
	return args[0] === "commit" && gitCommitReadsStdinAsMessage(args.slice(1));
}

interface DataReading {
	/** Every file a step writes, here-document copies and plain redirects alike. */
	copies: string[];
	git: boolean;
	names: string[];
}

/** One step's part in the proof, or null when the step breaks it. */
function readStep(command: ShellSimpleCommand, alone: boolean, negated: boolean, reading: DataReading): boolean {
	if (command.assignments.length > 0 || commandHasPart(command, ["param", "command", "opaque"])) return false;
	const name = staticCommandName(command);
	if (name === null) return false;
	const args = command.words.slice(1).map((word) => staticWordValue(word));
	if (args.some((arg) => arg === null)) return false;
	const words = args as string[];
	const docs: ShellRedirect[] = [];
	for (const redirect of command.redirects) {
		if (redirect.heredoc !== undefined) {
			docs.push(redirect);
			continue;
		}
		const target = staticWordValue(redirect.target);
		if (!PLAIN_REDIRECTS.has(redirect.op) || target === null) return false;
		// A duplicated or numbered descriptor can carry a body anywhere (`3>.git/config 1>&3`): only stderr to stdout or a
		// file is read.
		if (redirect.op === ">&" || redirect.op === "<&") {
			if (redirect.fd !== 2 || target !== "1") return false;
		} else if (redirect.fd !== null && redirect.fd !== 1 && redirect.fd !== 2) return false;
	}
	reading.names.push(name);
	if (name === "printf" && words.some((word) => word.startsWith("-v"))) return false;
	// Neon finding 6: every file any step writes (a redirect on stdout or stderr, a tee operand) is checked like a copy,
	// since `cat tmpfile > ls` carries the body as far as the here-document's own step does.
	const outputs = writeTargets(command);
	if (outputs === null) return false;
	if (name === "tee") {
		for (const word of words) {
			if (word.startsWith("-") && word !== "-") {
				if (!TEE_OPTIONS.has(word)) return false;
			} else outputs.push(word);
		}
	}
	reading.copies.push(...outputs);
	if (docs.length > 1) return false;
	const doc = docs[0];
	if (doc !== undefined) {
		if (doc.heredoc?.quoted !== true || (doc.fd !== null && doc.fd !== 0) || !alone || negated) return false;
		if (STDIN_NON_READERS.has(name)) return true;
		if (name === "git" && readsAsMessage(words)) {
			reading.git = true;
			return true;
		}
		return name === "cat" || name === "tee";
	}
	if (INERT_STEPS.has(name)) return true;
	if (name === "git" && GIT_INERT_SUBCOMMANDS.has(words[0] ?? "")) {
		reading.git = true;
		return true;
	}
	return words.length === 1 && VERSION_ONLY.has(words[0] ?? "") && VERSION_PROGRAMS.has(name);
}

function proven(script: ShellScript): boolean {
	const reading: DataReading = { copies: [], git: false, names: [] };
	for (const item of script.items) {
		if (item.background) return false;
		for (const pipeline of item.andOr.pipelines) {
			for (const command of pipeline.commands) {
				if (!readStep(command, pipeline.commands.length === 1, pipeline.negated, reading)) return false;
			}
		}
	}
	if (reading.git && reading.copies.length > 0) return false;
	const names = new Set(reading.names);
	for (const copy of reading.copies) {
		if (copy === "/dev/null") continue;
		if (copy.startsWith("/dev/") || copy === "" || copy.endsWith("/")) return false;
		const parts = copy.split("/");
		if (parts.some((part) => part.startsWith(".git") || part === ".husky")) return false;
		if (names.has(path.posix.basename(copy))) return false;
	}
	return true;
}

/**
 * The command with each proven-data here-document removed (its operator and word blanked, its body and delimiter line
 * dropped), or null when the call is not proven: then the rail keeps its own reading.
 */
export function heredocDataText(command: string): string | null {
	if (!command.includes("<<")) return null;
	const script = parseShellScript(command);
	if (script === null || script.heredocs.length === 0 || !proven(script)) return null;
	const spans: Array<{ start: number; end: number; text: string }> = [];
	for (const item of script.items) {
		for (const pipeline of item.andOr.pipelines) {
			for (const step of pipeline.commands) {
				for (const redirect of step.redirects) {
					const doc = redirect.heredoc;
					if (doc === undefined) continue;
					spans.push({ start: redirect.start, end: redirect.end, text: " ".repeat(redirect.end - redirect.start) });
					spans.push({ start: doc.bodyStart, end: doc.bodyEnd, text: "" });
				}
			}
		}
	}
	let text = command;
	for (const span of spans.sort((left, right) => right.start - left.start))
		text = `${text.slice(0, span.start)}${span.text}${text.slice(span.end)}`;
	return text;
}
