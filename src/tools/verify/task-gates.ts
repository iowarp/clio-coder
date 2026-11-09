import { SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES, SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../core/safe-exec.js";
import { shellLikeArgv } from "../../core/shell-argv.js";
import type { DeclaredCheck } from "./catalog.js";

/**
 * Gate commands a verifier's dispatched task names, run through verify. A
 * verifier has no shell, so before these existed a task that said "run
 * `python3 bench/heat_check.py --plain` and report the gate" could only be
 * reported unverified unless the repository happened to declare that exact
 * command. The task text is the dispatcher's declaration: each inline code
 * span that reads as one plain command becomes a check the verifier runs by
 * id or by its exact text, with no extra args, from the workspace root, under
 * the same safe-exec bounds and safety scan as every other verify check.
 *
 * Only a worker whose result contract is a verifier report configures gates,
 * so no other role and no main session gains a command it did not have.
 */

export interface TaskGate {
	id: string;
	/** The span as the task wrote it, whitespace collapsed. */
	text: string;
	command: string[];
}

export interface RejectedTaskGate {
	text: string;
	reason: string;
}

interface TaskGateState {
	/** True in a verifier worker, which has no shell to fall back to. */
	active: boolean;
	gates: TaskGate[];
	rejected: RejectedTaskGate[];
	/** True when every command this worker spawns runs under bubblewrap with no writable roots. */
	confined: boolean;
}

export const TASK_GATE_LIMIT = 8;
const SPAN_LIMIT = 400;
/** The ceiling a model-supplied timeout_ms meets for a task gate. */
export const TASK_GATE_MAX_TIMEOUT_MS = 600_000;
/** The policy engine recognizes only bare argv words; a gate outside them would ask and so never run headless. */
const BARE_WORD = /^[\w=./:-]+$/u;
/** One-word spans that still name a whole gate; any other one-word span is a file, flag or identifier. */
const SINGLE_WORD_RUNNERS = new Set(["pytest", "tox", "nox", "make", "ctest", "ninja", "just", "mypy", "ruff"]);
/**
 * Programs a gate never starts with: they reach outside the workspace, change
 * Git or the file tree as their purpose, or wrap another command the scan
 * would then judge only by its wrapper.
 */
const REFUSED_PROGRAMS = new Set([
	"git",
	"sudo",
	"doas",
	"su",
	"env",
	"xargs",
	"nohup",
	"setsid",
	"exec",
	"eval",
	"rm",
	"rmdir",
	"mv",
	"cp",
	"dd",
	"ln",
	"chmod",
	"chown",
	"curl",
	"wget",
	"ssh",
	"scp",
	"rsync",
	"nc",
	"kill",
	"pkill",
	"bash",
	"sh",
	"dash",
	"zsh",
	"fish",
	"ksh",
	"pwsh",
	"powershell",
]);

let state: TaskGateState = { active: false, gates: [], rejected: [], confined: false };

function collapse(text: string): string {
	return text.trim().replace(/\s+/gu, " ");
}

/** Inline code spans (single backticks) on one line; fenced blocks are prose examples, not gates. */
function inlineSpans(task: string): string[] {
	const spans: string[] = [];
	const withoutFences = task.replace(/```[\s\S]*?```/gu, " ");
	for (const match of withoutFences.matchAll(/`([^`\n]+)`/gu)) {
		const span = match[1];
		if (span !== undefined) spans.push(collapse(span));
	}
	return spans;
}

/** The argv a span declares, a reason it is refused, or null when it does not read as a command at all. */
function spanArgv(span: string): { argv: string[] } | { reason: string } | null {
	if (span.length === 0) return null;
	const words = span.split(" ");
	const program = words[0] ?? "";
	if (words.length === 1 && !SINGLE_WORD_RUNNERS.has(program)) return null;
	if (/^[A-Za-z_]\w*=/u.test(program)) return { reason: "environment assignments are not part of a gate" };
	// A command starts with a program name or a path to one. A bare file name
	// (`calc.py --plain`) is prose about the file: it would not run as written.
	if (!/^(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*$/u.test(program) || program.startsWith("-")) return null;
	if (!program.includes("/") && /\.[A-Za-z]\w*$/u.test(program)) return null;
	if (span.length > SPAN_LIMIT) return { reason: `longer than ${SPAN_LIMIT} characters` };
	const argv = shellLikeArgv(span, { rejectComments: true });
	if (argv instanceof Error) return { reason: `not one plain command (${argv.message})` };
	if (argv.length === 0) return null;
	const first = argv[0] ?? "";
	const base = first.split("/").pop() ?? first;
	if (REFUSED_PROGRAMS.has(base)) return { reason: `'${base}' is not a verification command` };
	const odd = argv.find((word) => !BARE_WORD.test(word));
	if (odd !== undefined) {
		return { reason: `'${odd}' is not a bare word (letters, digits, and _ = . / : - only)` };
	}
	return { argv };
}

/** The gates one task text declares, in order, at most TASK_GATE_LIMIT of them. */
export function extractTaskGates(task: string): { gates: TaskGate[]; rejected: RejectedTaskGate[] } {
	const gates: TaskGate[] = [];
	const rejected: RejectedTaskGate[] = [];
	const seen = new Set<string>();
	for (const span of inlineSpans(task)) {
		if (seen.has(span)) continue;
		seen.add(span);
		const parsed = spanArgv(span);
		if (parsed === null) continue;
		if ("reason" in parsed) {
			rejected.push({ text: span, reason: parsed.reason });
			continue;
		}
		if (gates.length >= TASK_GATE_LIMIT) {
			rejected.push({ text: span, reason: `the task already declares ${TASK_GATE_LIMIT} gates` });
			continue;
		}
		gates.push({ id: `gate-${gates.length + 1}`, text: span, command: parsed.argv });
	}
	return { gates, rejected };
}

/** Set once at a verifier worker's start from its dispatched task. */
export function configureTaskGates(task: string, options: { confined: boolean }): void {
	state = { active: true, ...extractTaskGates(task), confined: options.confined };
}

/** Back to no gates: a process that is not a verifier worker. */
export function clearTaskGates(): void {
	state = { active: false, gates: [], rejected: [], confined: false };
}

/**
 * What an unresolved verify call tells a verifier in place of "use bash",
 * which it does not have. Empty outside a verifier worker.
 */
export function taskGateFallbackHint(): string {
	if (!state.active) return "";
	const named = state.gates.map((gate) => `${gate.id} (${gate.text})`).join(", ");
	return (
		(named.length > 0 ? ` Gates the task declares: ${named}.` : "") +
		" This role has no shell: a command that is neither a listed check nor written in backticks in the task cannot run here, so report it unverified and say why."
	);
}

export function taskGates(): { gates: ReadonlyArray<TaskGate>; rejected: ReadonlyArray<RejectedTaskGate> } {
	return { gates: state.gates, rejected: state.rejected };
}

export function taskGatesConfined(): boolean {
	return state.confined;
}

/** A gate named by its id or by its exact command text, backticks tolerated. */
export function findTaskGate(check: string): TaskGate | RejectedTaskGate | null {
	const wanted = collapse(check.replace(/^`+|`+$/gu, ""));
	if (wanted.length === 0) return null;
	return (
		state.gates.find((gate) => gate.id === wanted || gate.text === wanted) ??
		state.rejected.find((entry) => entry.text === wanted) ??
		null
	);
}

/** The check projection a gate runs as; its evidence names the task as its source. */
export function taskGateCheck(gate: TaskGate): DeclaredCheck {
	return {
		id: gate.id,
		description: `declared by the dispatched task: ${gate.text}`,
		command: [...gate.command],
		cwd: ".",
		timeoutMs: SAFE_EXEC_DEFAULT_TIMEOUT_MS,
		tags: ["task"],
		source: { kind: "task", path: "dispatched task" },
		kind: "command",
	};
}

/** The bounds a gate runs under: the model may shorten them, never lift them past the ceilings. */
export function taskGateBounds(args: Record<string, unknown>): { timeout_ms: number; max_output_bytes: number } {
	const timeout =
		typeof args.timeout_ms === "number" && args.timeout_ms > 0
			? Math.min(Math.floor(args.timeout_ms), TASK_GATE_MAX_TIMEOUT_MS)
			: SAFE_EXEC_DEFAULT_TIMEOUT_MS;
	const output =
		typeof args.max_output_bytes === "number" && args.max_output_bytes > 0
			? Math.min(Math.floor(args.max_output_bytes), SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES)
			: SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
	return { timeout_ms: timeout, max_output_bytes: output };
}
