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
 * - no copy lands in a device, in `.git*` or in `.husky`, or is named like a
 *   command the call runs.
 *
 * Anything else keeps the rail's older reading, which reads the body as
 * commands. The command line itself, redirect targets included, stays judged.
 */

/** Steps that run no file and execute nothing they read. */
const INERT_STEPS: ReadonlySet<string> = new Set([
	"cat",
	"tee",
	"echo",
	"printf",
	"ls",
	"wc",
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

/** The files a step's standard output lands in (a descriptor duplication names none), or null when one is unread. */
function stdoutTargets(command: ShellSimpleCommand): string[] | null {
	const targets: string[] = [];
	for (const redirect of command.redirects) {
		if (!STDOUT_REDIRECTS.has(redirect.op)) continue;
		const both = redirect.op === "&>" || redirect.op === "&>>";
		const fd = redirect.fd ?? (redirect.op === "<>" ? 0 : 1);
		if (!both && fd !== 1) continue;
		const target = staticWordValue(redirect.target);
		if (target === null) return null;
		if ((redirect.op === ">&" || redirect.op === "<&") && DESCRIPTOR.test(target)) continue;
		targets.push(target);
	}
	return targets;
}

function readsAsMessage(args: ReadonlyArray<string>): boolean {
	if (args[0] !== "commit") return false;
	const options = args.indexOf("--") === -1 ? args : args.slice(0, args.indexOf("--"));
	return options.some(
		(arg, index) =>
			arg === "--file=-" || arg === "-F-" || ((arg === "-F" || arg === "--file") && options[index + 1] === "-"),
	);
}

interface DataReading {
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
	if (docs.length > 1) return false;
	const doc = docs[0];
	if (doc !== undefined) {
		if (doc.heredoc?.quoted !== true || (doc.fd !== null && doc.fd !== 0) || !alone || negated) return false;
		if (STDIN_NON_READERS.has(name)) return true;
		if (name === "git" && readsAsMessage(words)) {
			reading.git = true;
			return true;
		}
		if (name !== "cat" && name !== "tee") return false;
		const outputs = stdoutTargets(command);
		if (outputs === null) return false;
		if (name === "tee") {
			for (const word of words) {
				if (word.startsWith("-") && word !== "-") {
					if (!TEE_OPTIONS.has(word)) return false;
				} else outputs.push(word);
			}
		}
		reading.copies.push(...outputs);
		return true;
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
