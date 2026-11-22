import { SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES, SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../core/safe-exec.js";
import { sandboxAvailability } from "../../core/sandbox/availability.js";
import { mainShellContained } from "../../core/sandbox/main-session.js";
import { workerSandboxConfinesWrites } from "../../core/sandbox/worker-process.js";
import { shellLikeArgv } from "../../core/shell-argv.js";
import { type DeclaredCheck, defaultVerifyTimeoutMs } from "./catalog.js";

/**
 * Gate commands a checker's dispatched task names, run through verify. A
 * checker (verifier or debugger) has no shell, so before these existed a task
 * that said "run `python3 bench/heat_check.py --plain` and report the gate"
 * could only be reported unverified unless the repository happened to declare
 * that exact command. The task text is the dispatcher's declaration: each
 * `check: <command>` line (an explicit marker, like `output: <path>`) and each
 * inline code span that reads as one plain command becomes a check the
 * checker runs by id or by its exact text, with no extra args, from the
 * workspace root, under the same safe-exec bounds and safety scan as every
 * other verify check. Prose is never scanned for commands.
 *
 * Only a worker whose result contract is a checker report configures gates,
 * so no other role and no main session gains a command it did not have.
 */

/** Result contracts of the checker role (DESIGN 4.4: "no shell; declared checks and task gates"). */
const CHECKER_CONTRACTS: ReadonlySet<string> = new Set(["verifier-report", "debugger-report"]);

/** True for a run whose result contract makes it a checker, the only role whose task declares gates. */
export function contractDeclaresTaskGates(kind: string | undefined): boolean {
	return kind !== undefined && CHECKER_CONTRACTS.has(kind);
}

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
	/** True in a checker worker, which has no shell to fall back to. */
	active: boolean;
	gates: TaskGate[];
	rejected: RejectedTaskGate[];
	/** True when every command this worker spawns runs under bubblewrap, writing only inside the worker's own write roots. */
	confined: boolean;
	/** True when this worker could run a gate in the main-session sandbox, as main bash at default would. */
	containable: boolean;
}

export const TASK_GATE_LIMIT = 8;
const SPAN_LIMIT = 400;
/** The ceiling a model-supplied timeout_ms meets for a task gate. */
export const TASK_GATE_MAX_TIMEOUT_MS = 600_000;
/** A gate word is shell-quoted when judged, so it never splits into another command; control characters never pass. */
const CONTROL_CHARACTER = /\p{Cc}/u;
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

let state: TaskGateState = { active: false, gates: [], rejected: [], confined: false, containable: false };

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

/** A task line `check: <command>`; the command is taken whole, a pair of enclosing backticks removed (M-42). */
const CHECK_LINE = /^check:[ \t]*(\S(?:.*\S)?)[ \t]*$/gmu;

function checkMarkerCommands(task: string): string[] {
	const commands: string[] = [];
	for (const match of task.matchAll(CHECK_LINE)) {
		const raw = match[1] ?? "";
		commands.push(collapse(/^`([^`]+)`$/u.exec(raw)?.[1] ?? raw));
	}
	return commands;
}

/**
 * The argv a span declares, a reason it is refused, or null when it does not read as a command at all. A `check:`
 * line is `explicit`: it always declares a command, so what would make an inline span prose is a refusal instead.
 */
function spanArgv(span: string, explicit = false): { argv: string[] } | { reason: string } | null {
	if (span.length === 0) return null;
	const words = span.split(" ");
	const program = words[0] ?? "";
	if (words.length === 1 && !SINGLE_WORD_RUNNERS.has(program) && !explicit) return null;
	if (/^[A-Za-z_]\w*=/u.test(program)) return { reason: "environment assignments are not part of a gate" };
	// A command starts with a program name or a path to one. A bare file name
	// (`calc.py --plain`) is prose about the file: it would not run as written.
	const named = /^(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*$/u.test(program) && !program.startsWith("-");
	if (!named || (!program.includes("/") && /\.[A-Za-z]\w*$/u.test(program))) {
		return explicit ? { reason: `'${program}' is not a program name or a path to one` } : null;
	}
	if (span.length > SPAN_LIMIT) return { reason: `longer than ${SPAN_LIMIT} characters` };
	const argv = shellLikeArgv(span, { rejectComments: true });
	if (argv instanceof Error) return { reason: `not one plain command (${argv.message})` };
	if (argv.length === 0) return null;
	const first = argv[0] ?? "";
	const base = first.split("/").pop() ?? first;
	if (REFUSED_PROGRAMS.has(base)) return { reason: `'${base}' is not a verification command` };
	if (argv.some((word) => CONTROL_CHARACTER.test(word))) return { reason: "a word holds a control character" };
	return { argv };
}

/** The gates one task text declares, in order, at most TASK_GATE_LIMIT of them. */
export function extractTaskGates(task: string): { gates: TaskGate[]; rejected: RejectedTaskGate[] } {
	const gates: TaskGate[] = [];
	const rejected: RejectedTaskGate[] = [];
	const seen = new Set<string>();
	const spans = [
		...checkMarkerCommands(task).map((span) => ({ span, explicit: true })),
		...inlineSpans(task).map((span) => ({ span, explicit: false })),
	];
	for (const { span, explicit } of spans) {
		if (seen.has(span)) continue;
		seen.add(span);
		const parsed = spanArgv(span, explicit);
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

/** Set once at a checker worker's start from its dispatched task. */
export function configureTaskGates(task: string, options: { confined: boolean; containable?: boolean }): void {
	state = {
		active: true,
		...extractTaskGates(task),
		confined: options.confined,
		containable: options.containable === true,
	};
}

/**
 * A checker worker's gates, judged by the OS sandbox its commands run in. A gate is confined when that sandbox confines
 * every write to the worker's own write roots, as main bash's sandbox at default confines it to the workspace (M-42).
 */
export function configureWorkerTaskGates(task: string): void {
	configureTaskGates(task, {
		confined: workerSandboxConfinesWrites(),
		// The main-session sandbox main bash would run an unrecognized gate in.
		containable: workerSandboxConfinesWrites() && mainShellContained("auto", sandboxAvailability()),
	});
}

/** Back to no gates: a process that is not a checker worker. */
export function clearTaskGates(): void {
	state = { active: false, gates: [], rejected: [], confined: false, containable: false };
}

/**
 * What an unresolved verify call tells a checker in place of "use bash",
 * which it does not have. Empty outside a checker worker.
 */
export function taskGateFallbackHint(): string {
	if (!state.active) return "";
	const named = state.gates.map((gate) => `${gate.id} (${gate.text})`).join(", ");
	return (
		(named.length > 0 ? ` Gates the task declares: ${named}.` : "") +
		" This role has no shell: a command that is neither a listed check nor on a `check:` line or in backticks in the task cannot run here, so report it unverified and say why."
	);
}

export function taskGates(): { gates: ReadonlyArray<TaskGate>; rejected: ReadonlyArray<RejectedTaskGate> } {
	return { gates: state.gates, rejected: state.rejected };
}

export function taskGatesConfined(): boolean {
	return state.confined;
}

export function taskGatesContainable(): boolean {
	return state.containable;
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

/** True for a verify call that names one of this worker's task gates, runnable or not. */
export function isTaskGateCall(tool: string, args: Record<string, unknown> | undefined): boolean {
	if (!state.active || tool !== "verify") return false;
	const check = args?.check;
	return typeof check === "string" && findTaskGate(check) !== null;
}

/** The check projection a gate runs as; its evidence names the task as its source. */
export function taskGateCheck(gate: TaskGate): DeclaredCheck {
	return {
		id: gate.id,
		description: `declared by the dispatched task: ${gate.text}`,
		command: [...gate.command],
		cwd: ".",
		timeoutMs: defaultVerifyTimeoutMs(gate.id, gate.command),
		tags: ["task"],
		source: { kind: "task", path: "dispatched task" },
		kind: "command",
	};
}

/**
 * The bounds a gate runs under: the model may shorten timeout_ms (never past
 * the gate ceiling), while max_output_bytes bounds only the returned text and
 * leaves the child under SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES.
 */
export function taskGateBounds(
	args: Record<string, unknown>,
	defaultTimeoutMs = SAFE_EXEC_DEFAULT_TIMEOUT_MS,
): { timeout_ms: number; max_output_bytes: number } {
	const timeout =
		typeof args.timeout_ms === "number" && args.timeout_ms > 0
			? Math.min(Math.floor(args.timeout_ms), TASK_GATE_MAX_TIMEOUT_MS)
			: defaultTimeoutMs;
	const output =
		typeof args.max_output_bytes === "number" && args.max_output_bytes > 0
			? Math.min(Math.floor(args.max_output_bytes), SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES)
			: SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
	return { timeout_ms: timeout, max_output_bytes: output };
}
