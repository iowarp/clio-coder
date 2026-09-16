import { closeSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
	captureFileRef,
	captureOutputRef,
	createRunRecord,
	observeFileHash,
	RUN_RECORDS_DEFAULT_KEEP,
	type RunFileRef,
	type RunManifest,
	type RunOutcome,
	type RunOutputRef,
	type RunRecordPaths,
	sweepRunRecords,
	workspaceRelativePath,
	writeRunManifest,
} from "../core/run-records.js";
import {
	createRetainedStreamWindow,
	resolveSafeCwd,
	runCommandVector,
	SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS,
	type SafeCommandResult,
} from "../core/safe-exec.js";
import type { DynamicToolName } from "../core/tool-names.js";
import { isSecretArgKey } from "../domains/safety/redaction.js";
import { findExecutableOnPath } from "../domains/toolchain/resolve.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { formatSize } from "./truncate.js";
import { byteLength } from "./truncate-utf8.js";

/**
 * The run_script tool: observable scientific processing. One explicit
 * interpreter runs one script from the workspace with explicit arguments and
 * working directory. The complete stdout and stderr stream to log files under
 * `.clio-coder/runs/<runId>/`, a manifest records what ran (script hash,
 * argv, cwd, declared environment keys, timing, outcome, declared inputs and
 * outputs with their observed state), and the model receives a bounded
 * summary with the tails of both streams. Nothing is installed, retried, or
 * changed in the environment beyond the declared variables and the recorded
 * interpreter defaults.
 *
 * Declared inputs and outputs are provenance, not isolation: they say what the
 * caller expected the script to read and write so the result can report what
 * actually appeared. The safety policy still admits the run as a shell
 * execution through the `safetyCall` projection, and the operating system is
 * the only thing bounding what the script itself touches.
 */

/** Interpreters run_script will resolve on PATH. Anything else is refused by name. */
export const RUN_SCRIPT_INTERPRETERS = [
	"python3",
	"python",
	"node",
	"bash",
	"sh",
	"Rscript",
	"julia",
	"perl",
	"ruby",
	"octave",
] as const;

export type RunScriptInterpreter = (typeof RUN_SCRIPT_INTERPRETERS)[number];

export const RUN_SCRIPT_CAPS = Object.freeze({
	argEntries: 64,
	argBytes: 4096,
	declaredRefs: 64,
	envEntries: 32,
	envValueBytes: 4096,
	defaultTimeoutMs: 600_000,
	maxTimeoutMs: 21_600_000,
	/** Bytes of each stream kept in memory for the result tail. */
	resultTailBytes: 8 * 1024,
	/** Bytes of each stream shown in a live progress snapshot. */
	progressTailBytes: 2 * 1024,
	progressThrottleMs: 250,
});

/**
 * Interpreter arguments applied when the caller names none. Recorded in the
 * manifest's argv so the run never carries an invisible flag; `-u` keeps
 * Python's streams unbuffered so the live tail and the logs reflect progress
 * as it happens rather than at exit.
 */
export const RUN_SCRIPT_DEFAULT_INTERPRETER_ARGS: Readonly<Record<RunScriptInterpreter, ReadonlyArray<string>>> = {
	python3: ["-u"],
	python: ["-u"],
	node: [],
	bash: [],
	sh: [],
	Rscript: [],
	julia: [],
	perl: [],
	ruby: [],
	octave: [],
};

/**
 * The canonical name. Widened through `string` because the branded dynamic
 * name is the only ToolName a module outside core/tool-names.ts can mint; the
 * bootstrap replaces it with the builtin constant when it registers the tool.
 */
export const RUN_SCRIPT_TOOL_NAME = "run_script" as string as DynamicToolName;

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

function parseStringArray(value: unknown): string[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return null;
		out.push(entry);
	}
	return out;
}

/**
 * Tolerate the weak-model shapes: an array argument sent as a JSON string, and
 * a single string where an array was expected. Pure and idempotent; wired as
 * the registry `prepareArguments` hook and repeated at the top of `run` so
 * direct callers get the same normalization.
 */
export function prepareRunScriptArguments(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const next: Record<string, unknown> = { ...args };
	for (const key of ["args", "interpreter_args", "inputs", "outputs"] as const) {
		const value = next[key];
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (Array.isArray(parsed)) {
					next[key] = parsed;
					continue;
				}
			} catch {
				// Not JSON; fall through to the single-entry reading.
			}
		}
		next[key] = trimmed.length === 0 ? [] : [value];
	}
	if (typeof next.env === "string") {
		try {
			const parsed = JSON.parse(next.env) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) next.env = parsed;
		} catch {
			// Leave the malformed string; run() reports the shape error.
		}
	}
	return next;
}

interface DeclaredRef {
	/** The argument exactly as declared. */
	declared: string;
	/** Workspace-relative rendering for the manifest and the result. */
	relative: string;
}

interface RunScriptRequest {
	/** The canonical (symlink-resolved) workspace root every later path is confined to and rendered against. */
	workspaceRoot: string;
	interpreter: RunScriptInterpreter;
	interpreterPath: string;
	interpreterArgs: string[];
	scriptDeclared: string;
	scriptRelative: string;
	scriptRealPath: string;
	scriptBytes: number;
	args: string[];
	cwdRelative: string;
	cwdExecution: string;
	timeoutMs: number;
	inputs: DeclaredRef[];
	outputs: DeclaredRef[];
	env: Record<string, string>;
}

type Validation = { ok: true; request: RunScriptRequest } | { ok: false; message: string };

function invalid(message: string): Validation {
	return { ok: false, message: `run_script: ${message}` };
}

function isInterpreter(value: string): value is RunScriptInterpreter {
	return (RUN_SCRIPT_INTERPRETERS as ReadonlyArray<string>).includes(value);
}

function validateArgVector(value: unknown, field: string): string[] | string {
	const entries = parseStringArray(value);
	if (entries === null) return `${field} must be an array of strings`;
	if (entries.length > RUN_SCRIPT_CAPS.argEntries) {
		return `${field} exceeds the ${RUN_SCRIPT_CAPS.argEntries}-entry cap`;
	}
	for (const [index, entry] of entries.entries()) {
		if (entry.includes("\0")) return `${field}[${index}] must not contain a NUL byte`;
		if (byteLength(entry) > RUN_SCRIPT_CAPS.argBytes) {
			return `${field}[${index}] exceeds the ${RUN_SCRIPT_CAPS.argBytes}-byte cap`;
		}
	}
	return entries;
}

function validateDeclaredRefs(value: unknown, field: string, workspaceRoot: string): DeclaredRef[] | string {
	const entries = parseStringArray(value);
	if (entries === null) return `${field} must be an array of workspace-relative path strings`;
	if (entries.length > RUN_SCRIPT_CAPS.declaredRefs) {
		return `${field} exceeds the ${RUN_SCRIPT_CAPS.declaredRefs}-entry cap`;
	}
	const refs: DeclaredRef[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		const location = `${field}[${index}]`;
		if (entry.trim().length === 0) return `${location} must be a non-empty path`;
		if (entry.includes("\0")) return `${location} must not contain a NUL byte`;
		if (path.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
			return `${location} must be workspace-relative; absolute path '${entry}' is not allowed`;
		}
		const relative = workspaceRelativePath(workspaceRoot, entry);
		if (relative === null) return `${location} escapes the workspace root: '${entry}'`;
		if (seen.has(relative)) continue;
		seen.add(relative);
		refs.push({ declared: entry, relative });
	}
	return refs;
}

function validateEnv(value: unknown): Record<string, string> | string {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) return "env must be an object of string values";
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > RUN_SCRIPT_CAPS.envEntries) return `env exceeds the ${RUN_SCRIPT_CAPS.envEntries}-entry cap`;
	const env: Record<string, string> = {};
	for (const [key, raw] of entries) {
		if (!ENV_KEY_PATTERN.test(key)) return `env key '${key}' must match /^[A-Z_][A-Z0-9_]*$/`;
		if (typeof raw !== "string") return `env.${key} must be a string`;
		if (raw.includes("\0")) return `env.${key} must not contain a NUL byte`;
		if (byteLength(raw) > RUN_SCRIPT_CAPS.envValueBytes) {
			return `env.${key} exceeds the ${RUN_SCRIPT_CAPS.envValueBytes}-byte cap`;
		}
		env[key] = raw;
	}
	return env;
}

function insideRoot(realRoot: string, candidate: string): boolean {
	const relative = path.relative(realRoot, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateRequest(args: Record<string, unknown>, workspaceRoot: string): Validation {
	const interpreterArg = typeof args.interpreter === "string" ? args.interpreter.trim() : "";
	if (interpreterArg.length === 0) return invalid("missing interpreter argument");
	if (!isInterpreter(interpreterArg)) {
		return invalid(
			`interpreter must be one of ${RUN_SCRIPT_INTERPRETERS.join(", ")}; got '${interpreterArg}'. Paths and other executables are not accepted.`,
		);
	}
	const interpreter = interpreterArg;
	const interpreterPath = findExecutableOnPath(interpreter);
	if (interpreterPath === null) return invalid(`interpreter '${interpreter}' was not found on PATH`);

	const scriptArg = typeof args.script === "string" ? args.script.trim() : "";
	if (scriptArg.length === 0) return invalid("missing script argument");
	if (scriptArg.includes("\0")) return invalid("script must not contain a NUL byte");
	// One root for everything that follows. The configured root may reach the
	// workspace through a symbolic link; confinement checks and the runner's
	// own cwd check compare canonical paths, so the root must be canonical too.
	let realRoot: string;
	try {
		realRoot = realpathSync(workspaceRoot);
	} catch (error) {
		return invalid(`workspace root cannot be resolved (${error instanceof Error ? error.message : String(error)})`);
	}
	const scriptAbsolute = path.isAbsolute(scriptArg) ? path.resolve(scriptArg) : path.resolve(realRoot, scriptArg);
	let scriptRealPath: string;
	let scriptBytes: number;
	try {
		scriptRealPath = realpathSync(scriptAbsolute);
		const stat = statSync(scriptRealPath);
		if (!stat.isFile()) return invalid(`script is not a regular file: ${scriptArg}`);
		scriptBytes = stat.size;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return invalid(`script not found: ${scriptArg}`);
		return invalid(`script cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!insideRoot(realRoot, scriptRealPath)) {
		return invalid(`script resolves outside the workspace root: ${scriptArg} -> ${scriptRealPath}`);
	}
	const scriptRelative = workspaceRelativePath(realRoot, scriptRealPath) ?? scriptArg;

	const scriptArgs = validateArgVector(args.args, "args");
	if (typeof scriptArgs === "string") return invalid(scriptArgs);
	let interpreterArgs: string[];
	if (args.interpreter_args === undefined || args.interpreter_args === null) {
		interpreterArgs = [...RUN_SCRIPT_DEFAULT_INTERPRETER_ARGS[interpreter]];
	} else {
		const explicit = validateArgVector(args.interpreter_args, "interpreter_args");
		if (typeof explicit === "string") return invalid(explicit);
		interpreterArgs = explicit;
	}

	const cwdArg = typeof args.cwd === "string" && args.cwd.trim().length > 0 ? args.cwd.trim() : undefined;
	let cwdExecution: string;
	try {
		const resolved = resolveSafeCwd(cwdArg, realRoot);
		const stat = statSync(resolved);
		if (!stat.isDirectory()) return invalid(`cwd is not a directory: ${cwdArg ?? "."}`);
		cwdExecution = realpathSync(resolved);
		if (!insideRoot(realRoot, cwdExecution)) {
			return invalid(`cwd escapes the workspace root through a symbolic link: ${cwdArg ?? "."}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("escapes workspace root")) return invalid(`cwd escapes the workspace root: ${cwdArg ?? "."}`);
		return invalid(`cwd cannot be resolved: ${cwdArg ?? "."} (${message})`);
	}
	const cwdRelative = workspaceRelativePath(realRoot, cwdExecution) ?? ".";

	// A fractional value would floor to zero, which the runner reads as no
	// limit at all; only whole milliseconds from 1 up are accepted.
	let timeoutMs: number = RUN_SCRIPT_CAPS.defaultTimeoutMs;
	if (args.timeout_ms !== undefined && args.timeout_ms !== null) {
		if (typeof args.timeout_ms !== "number" || !Number.isInteger(args.timeout_ms) || args.timeout_ms < 1) {
			return invalid("timeout_ms must be a positive integer number of milliseconds");
		}
		timeoutMs = Math.min(Math.max(1, args.timeout_ms), RUN_SCRIPT_CAPS.maxTimeoutMs);
	}

	const inputs = validateDeclaredRefs(args.inputs, "inputs", realRoot);
	if (typeof inputs === "string") return invalid(inputs);
	const outputs = validateDeclaredRefs(args.outputs, "outputs", realRoot);
	if (typeof outputs === "string") return invalid(outputs);
	const env = validateEnv(args.env);
	if (typeof env === "string") return invalid(env);

	return {
		ok: true,
		request: {
			workspaceRoot: realRoot,
			interpreter,
			interpreterPath,
			interpreterArgs,
			scriptDeclared: scriptArg,
			scriptRelative,
			scriptRealPath,
			scriptBytes,
			args: scriptArgs,
			cwdRelative,
			cwdExecution,
			timeoutMs,
			inputs,
			outputs,
			env,
		},
	};
}

/** Serialize a fixed argv vector for the shell safety classifier only. No shell executes this text. */
function quoted(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The shell-shaped projection the policy engine scans: the same interpreter,
 * flags, script, and arguments, quoted as one command. Built from the request
 * arguments without touching the filesystem, so admission sees the run the
 * caller asked for whether or not it later validates.
 */
export function runScriptSafetyProjection(args: Record<string, unknown>): { command: string; cwd?: string } {
	const prepared = prepareRunScriptArguments(args);
	const interpreter = typeof prepared.interpreter === "string" ? prepared.interpreter.trim() : "";
	const script = typeof prepared.script === "string" ? prepared.script.trim() : "";
	const interpreterArgs =
		prepared.interpreter_args === undefined || prepared.interpreter_args === null
			? isInterpreter(interpreter)
				? [...RUN_SCRIPT_DEFAULT_INTERPRETER_ARGS[interpreter]]
				: []
			: (parseStringArray(prepared.interpreter_args) ?? []);
	const scriptArgs = parseStringArray(prepared.args) ?? [];
	// Arguments are kept verbatim, empty ones included, so the command the
	// policy inspects has exactly the argv shape execution spawns. Only the
	// two positions a valid request cannot leave empty are dropped when empty.
	const vector = [
		...(interpreter.length > 0 ? [interpreter] : []),
		...interpreterArgs,
		...(script.length > 0 ? [script] : []),
		...scriptArgs,
	];
	const command = vector.map(quoted).join(" ");
	const cwd = typeof prepared.cwd === "string" && prepared.cwd.trim().length > 0 ? prepared.cwd.trim() : undefined;
	return cwd === undefined ? { command } : { command, cwd };
}

export interface RunScriptScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}

const SYSTEM_SCHEDULER: RunScriptScheduler = {
	now: Date.now,
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface RunScriptProgressController {
	/** Publish the initial snapshot. */
	start(): void;
	/** Fold one chunk of a stream into the live tails and schedule a bounded update. */
	append(target: "stdout" | "stderr", chunk: Buffer): void;
	/** Publish the final snapshot when one is pending and stop scheduling. */
	settle(): void;
}

export interface RunScriptProgressInput {
	onUpdate: (partial: ToolResult) => void;
	/** One line naming the run, for example `python3 -u scripts/fit.py`. */
	label: string;
	scheduler?: RunScriptScheduler;
	throttleMs?: number;
	tailBytes?: number;
}

/**
 * Live progress for a running script: elapsed time, exact byte counts, and
 * the last few kilobytes of each stream, separately. Snapshots are advisory
 * and throttled; the terminal result never depends on them. The scheduler is
 * injectable so the throttle can be tested without wall-clock timing.
 */
export function createRunScriptProgressController(input: RunScriptProgressInput): RunScriptProgressController {
	const scheduler = input.scheduler ?? SYSTEM_SCHEDULER;
	const throttleMs = input.throttleMs ?? RUN_SCRIPT_CAPS.progressThrottleMs;
	const tailBytes = input.tailBytes ?? RUN_SCRIPT_CAPS.progressTailBytes;
	const stdoutTail = createRetainedStreamWindow(0, tailBytes);
	const stderrTail = createRetainedStreamWindow(0, tailBytes);
	let phase: "idle" | "active" | "settled" = "idle";
	let startedAt = 0;
	let lastEmitAt = Number.NEGATIVE_INFINITY;
	let dirty = false;
	let timer: unknown = null;

	const snapshot = (): ToolResult => {
		const elapsedMs = Math.max(0, scheduler.now() - startedAt);
		const out = stdoutTail.render();
		const err = stderrTail.render();
		const lines = [
			`run_script: running ${input.label} (${formatElapsed(elapsedMs)} elapsed)`,
			`stdout: ${out.totalBytes} bytes | stderr: ${err.totalBytes} bytes`,
			"--- stdout tail ---",
			out.text.length > 0 ? out.text : "(no output yet)",
			"--- stderr tail ---",
			err.text.length > 0 ? err.text : "(no output yet)",
		];
		return {
			kind: "ok",
			output: lines.join("\n"),
			details: { progress: { elapsedMs, stdoutBytes: out.totalBytes, stderrBytes: err.totalBytes } },
		};
	};

	const emit = (): void => {
		if (!dirty) return;
		dirty = false;
		lastEmitAt = scheduler.now();
		try {
			input.onUpdate(snapshot());
		} catch {
			// Rendering progress is advisory and must never change the run.
		}
	};

	const clearTimer = (): void => {
		if (timer === null) return;
		scheduler.clearTimeout(timer);
		timer = null;
	};

	const schedule = (): void => {
		if (phase !== "active") return;
		dirty = true;
		const delay = throttleMs - (scheduler.now() - lastEmitAt);
		if (delay <= 0) {
			clearTimer();
			emit();
			return;
		}
		timer ??= scheduler.setTimeout(() => {
			timer = null;
			// A timer the event loop already queued can still fire after
			// clearTimeout; the phase check makes that callback inert.
			if (phase === "active") emit();
		}, delay);
	};

	return {
		start() {
			if (phase !== "idle") return;
			phase = "active";
			startedAt = scheduler.now();
			dirty = true;
			emit();
		},
		append(target, chunk) {
			if (phase !== "active") return;
			(target === "stdout" ? stdoutTail : stderrTail).append(chunk);
			schedule();
		},
		settle() {
			if (phase !== "active") return;
			clearTimer();
			emit();
			phase = "settled";
		},
	};
}

function formatElapsed(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

function classifyOutcome(result: {
	aborted: boolean;
	timedOut: boolean;
	exitCode: number | null;
	signal: string | null;
	sinkError?: string;
	cleanupIncomplete?: boolean;
	pipeDrainIncomplete?: boolean;
	leaderExit?: { code: number | null; signal: NodeJS.Signals | null } | null;
}): RunOutcome {
	if (result.aborted) return "aborted";
	if (result.timedOut) return "timed-out";
	if (result.pipeDrainIncomplete) return "pipe-drain-incomplete";
	if (result.sinkError !== undefined) return "failed";
	if (result.exitCode === null && result.signal === null) return "spawn-failed";
	if (result.cleanupIncomplete && result.leaderExit?.code === 0) return "cleanup-incomplete";
	if (result.exitCode !== 0) return "failed";
	// The script exited 0, but the run is only over when its process group is
	// gone; survivors after SIGKILL and the bounded wait make it unsuccessful.
	return result.cleanupIncomplete === true ? "cleanup-incomplete" : "succeeded";
}

/**
 * The result shape for a runner that threw or rejected instead of resolving:
 * no process outcome exists, so the run is recorded as never started, with
 * whatever bytes reached the logs before the failure.
 */
function runnerFailureResult(
	file: string,
	args: string[],
	cwd: string,
	startedAt: Date,
	written: { stdout: number; stderr: number },
	aborted: boolean,
): SafeCommandResult {
	return {
		file,
		args,
		cwd,
		stdout: "",
		stderr: "",
		exitCode: null,
		signal: null,
		aborted,
		timedOut: false,
		outputCapped: false,
		durationMs: Math.max(0, Date.now() - startedAt.getTime()),
		startedAt: startedAt.getTime(),
		stdoutBytes: written.stdout,
		stderrBytes: written.stderr,
		stdoutRetained: written.stdout === 0,
		stderrRetained: written.stderr === 0,
		descendantsCleaned: false,
		cleanupIncomplete: false,
		failure: null,
	};
}

function streamLine(
	name: "stdout" | "stderr",
	bytes: number,
	retained: boolean,
	logRelative: string,
	tailBytes: number,
): string {
	if (bytes === 0) return `${name}: 0 bytes (empty)`;
	if (retained) return `${name}: ${bytes} bytes (complete below)`;
	return `${name}: ${bytes} bytes (last ${formatSize(tailBytes)} below; full log: ${logRelative})`;
}

function refsTable(heading: string, refs: ReadonlyArray<RunFileRef | RunOutputRef>): string[] {
	if (refs.length === 0) return [];
	const lines = [`${heading}:`];
	for (const ref of refs) {
		const status = "status" in ref ? ref.status : ref.exists ? "present" : "absent";
		const size = ref.bytes === undefined ? "" : ` ${ref.bytes} bytes`;
		const omission = ref.hashOmitted === undefined ? "" : ` (hash omitted: ${ref.hashOmitted})`;
		lines.push(`  ${ref.path}  ${status}${size}${omission}`);
	}
	return lines;
}

/**
 * The retained window already holds at most `resultTailBytes` of the stream
 * plus its own omission marker, so the text goes out as rendered: cutting it
 * again from the front would drop the stream's final bytes, which are the
 * ones a tail exists to show.
 */
function tailSection(name: "stdout" | "stderr", text: string): string[] {
	return [`--- ${name} tail ---`, text.length > 0 ? text : "(empty)"];
}

export interface RunScriptToolDeps {
	/** The workspace root every path resolves against; defaults to the process working directory. */
	getWorkspaceRoot?: () => string;
	scheduler?: RunScriptScheduler;
	now?: () => Date;
	/** Run directories kept after each run's sweep. */
	keepRuns?: number;
	/** The process runner; defaults to `runCommandVector`. Tests inject one that fails to start. */
	runCommand?: typeof runCommandVector;
}

const DESCRIPTION =
	"Run one script from the workspace with an explicit interpreter, arguments, and working directory, as an observable scientific step. " +
	"Complete stdout and stderr stream to .clio-coder/runs/<runId>/stdout.log and stderr.log and a run.json manifest records the script hash, exact argv, cwd, declared env keys, timing, outcome, and the observed state of declared inputs and outputs; the result carries bounded tails of both streams and names the run directory. " +
	"Declared inputs and outputs are provenance only and do not restrict what the script may touch. No dependency installation, no retries, no hidden environment changes. " +
	`Default timeout ${RUN_SCRIPT_CAPS.defaultTimeoutMs}ms; a nonzero exit, timeout, or cancellation returns an error that still names the logs and any partial outputs.`;

export const runScriptToolSurface = {
	name: RUN_SCRIPT_TOOL_NAME,
	description: DESCRIPTION,
	parameters: Type.Object({
		interpreter: StringEnum(RUN_SCRIPT_INTERPRETERS, {
			description: "Interpreter resolved on PATH. Only these names are accepted; never a path.",
		}),
		script: Type.String({
			description: "Script file inside the workspace (relative to the workspace root or absolute).",
		}),
		args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the script, in order." })),
		interpreter_args: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Flags placed before the script. Omit for the recorded default (-u for python/python3, none otherwise).",
			}),
		),
		cwd: Type.Optional(
			Type.String({ description: "Working directory, relative to the workspace root (default: the root)." }),
		),
		timeout_ms: Type.Optional(
			Type.Number({ description: `Wall-clock limit in ms (default ${RUN_SCRIPT_CAPS.defaultTimeoutMs}).` }),
		),
		inputs: Type.Optional(
			Type.Array(Type.String(), {
				description: "Workspace-relative files the script reads; recorded with size and hash before the run.",
			}),
		),
		outputs: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Workspace-relative files the script should produce; reported as created, modified, unchanged, or absent after the run.",
			}),
		),
		env: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Extra environment variables for the script; keys are recorded, values never are.",
			}),
		),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	prepareArguments: prepareRunScriptArguments,
	safetyCall(args) {
		const projection = runScriptSafetyProjection(args);
		return {
			tool: "bash",
			args: { command: projection.command, ...(projection.cwd === undefined ? {} : { cwd: projection.cwd }) },
		};
	},
} satisfies ToolSurface;

interface OpenLog {
	fd: number;
	path: string;
}

function openLogs(paths: RunRecordPaths): { stdout: OpenLog; stderr: OpenLog } {
	const stdout: OpenLog = { fd: openSync(paths.stdoutPath, "w"), path: paths.stdoutPath };
	let stderr: OpenLog;
	try {
		stderr = { fd: openSync(paths.stderrPath, "w"), path: paths.stderrPath };
	} catch (error) {
		closeSync(stdout.fd);
		throw error;
	}
	return { stdout, stderr };
}

function writeAll(fd: number, chunk: Buffer): void {
	let offset = 0;
	while (offset < chunk.byteLength) {
		offset += writeSync(fd, chunk, offset, chunk.byteLength - offset, null);
	}
}

function closeQuietly(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// The descriptor is already gone; the log holds whatever reached it.
	}
}

export function createRunScriptTool(deps: RunScriptToolDeps = {}): ToolSpec {
	const getWorkspaceRoot = deps.getWorkspaceRoot ?? (() => process.cwd());
	const now = deps.now ?? (() => new Date());
	const runCommand = deps.runCommand ?? runCommandVector;
	return {
		...runScriptToolSurface,
		async run(rawArgs, options): Promise<ToolResult> {
			const args = prepareRunScriptArguments(rawArgs);
			const validation = validateRequest(args, path.resolve(getWorkspaceRoot()));
			if (!validation.ok) return { kind: "error", message: validation.message };
			const request = validation.request;
			const workspaceRoot = request.workspaceRoot;
			const signal = options?.signal;
			const abortedBeforeExecution = (): ToolResult => ({
				kind: "error",
				message: "run_script: aborted before execution",
			});
			if (signal?.aborted) return abortedBeforeExecution();

			// Pre-run provenance. Reads are bounded and asynchronous, and a
			// cancellation here ends the run before any record exists.
			const scriptHash = await observeFileHash(request.scriptRealPath, request.scriptBytes, signal);
			if (scriptHash.hashOmitted === "cancelled") return abortedBeforeExecution();
			if (scriptHash.hashOmitted === "unreadable") {
				return { kind: "error", message: `run_script: script cannot be read: ${request.scriptDeclared}` };
			}
			const inputRefs: RunFileRef[] = [];
			for (const ref of request.inputs) inputRefs.push(await captureFileRef(workspaceRoot, ref.declared, { signal }));
			const outputsBefore: RunFileRef[] = [];
			for (const ref of request.outputs) {
				outputsBefore.push(await captureFileRef(workspaceRoot, ref.declared, { signal }));
			}
			if (signal?.aborted) return abortedBeforeExecution();

			let paths: RunRecordPaths;
			let logs: { stdout: OpenLog; stderr: OpenLog };
			try {
				paths = createRunRecord(workspaceRoot);
				logs = openLogs(paths);
			} catch (error) {
				return {
					kind: "error",
					message: `run_script: cannot create the run record: ${error instanceof Error ? error.message : String(error)}`,
				};
			}

			const label = [request.interpreter, ...request.interpreterArgs, request.scriptRelative, ...request.args].join(" ");
			const progress =
				options?.onUpdate === undefined
					? null
					: createRunScriptProgressController({
							onUpdate: options.onUpdate,
							label,
							...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
						});
			const vector = [...request.interpreterArgs, request.scriptRealPath, ...request.args];
			const written = { stdout: 0, stderr: 0 };
			const startedAt = now();
			let result: SafeCommandResult;
			let failure: string | null = null;
			progress?.start();
			try {
				result = await runCommand(request.interpreterPath, vector, {
					cwd: request.cwdExecution,
					workspaceRoot,
					timeoutMs: request.timeoutMs,
					env: request.env,
					...(signal ? { signal } : {}),
					output: {
						retainHeadBytes: 0,
						retainTailBytes: RUN_SCRIPT_CAPS.resultTailBytes,
						onStdout(chunk) {
							writeAll(logs.stdout.fd, chunk);
							written.stdout += chunk.byteLength;
							progress?.append("stdout", chunk);
						},
						onStderr(chunk) {
							writeAll(logs.stderr.fd, chunk);
							written.stderr += chunk.byteLength;
							progress?.append("stderr", chunk);
						},
					},
				});
			} catch (error) {
				// The runner threw or rejected instead of resolving: the run never
				// produced a process outcome, but its directory exists and the
				// manifest below says so instead of leaving an unexplained gap.
				failure = error instanceof Error ? error.message : String(error);
				result = runnerFailureResult(
					request.interpreterPath,
					vector,
					request.cwdExecution,
					startedAt,
					written,
					signal?.aborted === true,
				);
			} finally {
				// Whatever happened above, the descriptors close exactly once here.
				progress?.settle();
				closeQuietly(logs.stdout.fd);
				closeQuietly(logs.stderr.fd);
			}

			const finishedAt = now();
			const outcome = classifyOutcome(result);
			const outputRefs: RunOutputRef[] = [];
			for (const [index, ref] of request.outputs.entries()) {
				outputRefs.push(
					await captureOutputRef(workspaceRoot, ref.declared, outputsBefore[index] as RunFileRef, { signal }),
				);
			}
			const declaredKeys = Object.keys(request.env).sort();
			const manifest: RunManifest = {
				version: 1,
				runId: paths.runId,
				tool: "run_script",
				startedAt: startedAt.toISOString(),
				finishedAt: finishedAt.toISOString(),
				durationMs: result.durationMs,
				script: {
					path: request.scriptRelative,
					realPath: request.scriptRealPath,
					sha256: scriptHash.sha256,
					...(scriptHash.hashOmitted === undefined ? {} : { hashOmitted: scriptHash.hashOmitted }),
					bytes: request.scriptBytes,
				},
				interpreter: {
					name: request.interpreter,
					resolvedPath: request.interpreterPath,
					args: [...request.interpreterArgs],
				},
				argv: [result.file, ...result.args],
				cwd: request.cwdRelative,
				env: { declaredKeys, redactedKeys: declaredKeys.filter((key) => isSecretArgKey(key)) },
				timeoutMs: request.timeoutMs,
				outcome,
				exitCode: result.exitCode,
				leaderExit: result.leaderExit ?? null,
				pipeDrainIncomplete: result.pipeDrainIncomplete === true,
				signal: result.signal,
				stdoutBytes: result.stdoutBytes ?? 0,
				stderrBytes: result.stderrBytes ?? 0,
				logs: { stdout: path.basename(paths.stdoutPath), stderr: path.basename(paths.stderrPath) },
				inputs: inputRefs,
				outputs: outputRefs,
				cleanup: {
					descendantsCleaned: result.descendantsCleaned === true,
					incomplete: result.cleanupIncomplete === true,
				},
				...(failure === null ? {} : { failure }),
			};
			let manifestError: string | null = null;
			try {
				writeRunManifest(paths, manifest);
			} catch (error) {
				manifestError = error instanceof Error ? error.message : String(error);
			}
			const sweep = sweepRunRecords(workspaceRoot, { keep: deps.keepRuns ?? RUN_RECORDS_DEFAULT_KEEP });

			const runRelative = workspaceRelativePath(workspaceRoot, paths.dir) ?? paths.dir;
			const stdoutRelative = workspaceRelativePath(workspaceRoot, paths.stdoutPath) ?? paths.stdoutPath;
			const stderrRelative = workspaceRelativePath(workspaceRoot, paths.stderrPath) ?? paths.stderrPath;
			const reportedExit = result.leaderExit ?? { code: result.exitCode, signal: result.signal };
			const ending =
				reportedExit.code !== null
					? `exit ${reportedExit.code}`
					: reportedExit.signal !== null
						? `signal ${reportedExit.signal}`
						: "did not start";
			const headline = `run_script ${outcome}: ${label} (${ending}, ${formatElapsed(result.durationMs)})`;
			const lines = [
				headline,
				`run: ${runRelative}`,
				streamLine(
					"stdout",
					manifest.stdoutBytes,
					result.stdoutRetained === true,
					stdoutRelative,
					RUN_SCRIPT_CAPS.resultTailBytes,
				),
				streamLine(
					"stderr",
					manifest.stderrBytes,
					result.stderrRetained === true,
					stderrRelative,
					RUN_SCRIPT_CAPS.resultTailBytes,
				),
				...refsTable("inputs", inputRefs),
				...refsTable("outputs", outputRefs),
				...tailSection("stdout", result.stdout),
				...tailSection("stderr", result.stderr),
			];
			if (outcome === "timed-out") {
				lines.push(
					`the run timed out after ${request.timeoutMs}ms (SIGTERM, then SIGKILL); the logs end where the script was stopped`,
				);
			} else if (outcome === "aborted") {
				lines.push("the run was cancelled; the logs end where the script was stopped");
			} else if (outcome === "spawn-failed") {
				lines.push(`the interpreter did not start: ${failure ?? (result.stderr.trim() || "unknown spawn failure")}`);
			}
			if (result.sinkError !== undefined) {
				lines.push(`log write failed (${result.sinkError}); the script was stopped and the logs are incomplete`);
			}
			if (manifest.cleanup.descendantsCleaned) {
				lines.push(
					"processes the script started were still running in its process group after it ended; they were sent SIGTERM, then SIGKILL",
				);
			}
			if (result.pipeDrainIncomplete) {
				lines.push(
					"output pipe draining incomplete after leader exit; logs may be incomplete and escaped processes are not contained",
				);
			}
			if (manifest.cleanup.incomplete) {
				lines.push(
					`${result.failure ?? `process group cleanup incomplete: members were still present ${SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS}ms after SIGKILL`}; check for stuck processes before trusting the outputs`,
				);
			}
			if ((outcome === "cleanup-incomplete" || result.pipeDrainIncomplete) && outputRefs.length > 0) {
				lines.push(
					result.pipeDrainIncomplete
						? "outputs listed above may still change; processes outside the original group may still be running"
						: "outputs listed above may still change; processes the script started are still present",
				);
			} else if (outcome !== "succeeded" && outputRefs.length > 0) {
				lines.push(
					reportedExit.code === 0
						? "outputs listed above may be partial; the run did not complete successfully"
						: "outputs listed above may be partial; the script did not exit 0",
				);
			}
			if (manifestError !== null) lines.push(`manifest write failed: ${manifestError}`);
			const text = lines.join("\n");

			const details = {
				runId: paths.runId,
				runDir: paths.dir,
				manifestPath: paths.manifestPath,
				outcome,
				exitCode: result.exitCode,
				leaderExit: result.leaderExit ?? null,
				pipeDrainIncomplete: result.pipeDrainIncomplete === true,
				signal: result.signal,
				timedOut: result.timedOut,
				aborted: result.aborted,
				durationMs: result.durationMs,
				stdoutBytes: manifest.stdoutBytes,
				stderrBytes: manifest.stderrBytes,
				stdoutPath: paths.stdoutPath,
				stderrPath: paths.stderrPath,
				script: { path: request.scriptRelative, sha256: scriptHash.sha256 },
				argv: manifest.argv,
				cwd: request.cwdRelative,
				inputs: inputRefs,
				outputs: outputRefs,
				cleanup: manifest.cleanup,
				sweep,
				...(failure === null ? {} : { failure }),
				...(manifestError === null ? {} : { manifestError }),
			};
			if (outcome === "succeeded" && manifestError === null) return { kind: "ok", output: text, details };
			return { kind: "error", message: text, details };
		},
	};
}

export const runScriptTool: ToolSpec = createRunScriptTool();

/** Exported for the bootstrap: the options a wrapped runner forwards unchanged. */
export type RunScriptInvokeOptions = ToolInvokeOptions;
