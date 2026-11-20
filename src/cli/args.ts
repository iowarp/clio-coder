import { THINKING_LEVELS } from "../core/defaults.js";
import { MAX_TIMER_DELAY_MS } from "../core/timers.js";
import { parseToolLimitList, toolLimitConflict, toolLimitConstraints } from "../core/tool-limit-flags.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import { type AutonomyLevel, autonomyFromUserInput } from "../domains/safety/autonomy.js";
import { globalFlagPositionHint, parseMaxContextTokens } from "./argv.js";
import { parseDuration } from "./kit/duration.js";
import type { ErrorSlug } from "./kit/slugs.js";
import type { RunLimitsV2 } from "./modes/run-json-schema-v2.js";

export interface CliArgDiagnostic {
	type: "warning" | "error";
	message: string;
	/** The C17 slug of an error, when it is more specific than `usage`. */
	slug?: ErrorSlug;
}

/** `--output-format`: the schema v2 headless surfaces. Without the flag every v1 surface stays as it was. */
export type RunOutputFormat = "text" | "json" | "stream-json";

const OUTPUT_FORMATS: ReadonlyArray<RunOutputFormat> = ["text", "json", "stream-json"];

function isRunOutputFormat(value: string): value is RunOutputFormat {
	return (OUTPUT_FORMATS as ReadonlyArray<string>).includes(value);
}

export interface RunSamplingArgs {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repeatPenalty?: number;
}

export interface RunCliArgs {
	/** Explicit display capture for --agent dispatch; omitted preserves the default. */
	record?: boolean;
	constraints?: TurnConstraints;
	help: boolean;
	/**
	 * The run writes JSON (`--output-format json|stream-json`). The parser leaves it false: runClioRun sets it for schema
	 * v2, whose writer reframes the JSON stream underneath. `--json` and `--json-events` were removed in 0.8.5.
	 */
	json: boolean;
	target?: string;
	model?: string;
	thinking?: JobThinkingLevel;
	autonomy?: AutonomyLevel;
	/** The one System One setting for this run: an engine name or `off`. */
	systemOne?: string;
	/** A bare `-`: read the task text from stdin until it ends, beside any prompt words. */
	stdin?: boolean;
	readOnly: boolean;
	sampling?: RunSamplingArgs;
	agentId?: string;
	agentProfile?: string;
	agentRuntime?: string;
	toolProfile?: string;
	required: string[];
	noSkills: boolean;
	skillPaths: string[];
	maxContextTokens?: number;
	steerChannel?: string;
	/** `--resume <id|prefix|name>` (or the deprecated `--session`): resume this session and append the turn to it. */
	sessionId?: string;
	/** Resume the most recent session for this workspace. */
	continueSession: boolean;
	/** `--fork`: branch a new session from the resumed one, which is read and never written (SPEC L3). */
	forkSession: boolean;
	/** `--name <text>`: the session's name, set when the run's session is created, forked or resumed. */
	sessionName?: string;
	/** Directory the run enters before it resolves anything against the working directory. */
	cwd?: string;
	/** Fail a main-agent run whose receipt records a no-op. */
	failOnNoop: boolean;
	/** `--fail-on-verify`: a failed or timed-out `--verify` check fails the run. */
	failOnVerify?: boolean;
	/** `--on-permission`: `fail` ends the run with exit 3 at the first ask a headless run refuses. */
	onPermission?: "deny" | "fail";
	/** `--dry-run`: print what the run would do, with no session, model call or `--verify` command. */
	dryRun?: boolean;
	/** Priced spend this run may add, in US dollars; with `--agent`, the bound on that one worker run. */
	maxCostUsd?: number;
	/** `--max-requests`: main-loop provider requests this run may send. */
	maxRequests?: number;
	/** `--sandbox required`: tighten-only one-run `safety.sandbox` (main and `--agent`). */
	sandboxRequired?: true;
	/** `--require-priced`: refuse unpriced routes the run can reach, at preflight and at each dispatch admission. */
	requirePriced?: true;
	/** `--max-tool-calls`: tool calls the main agent may make or have refused in this run. */
	maxToolCalls?: number;
	/** `--worktree` (`--agent` only): run the worker in a task worktree kept for review. */
	worktree?: boolean;
	/** Wall-clock limit for the whole run, in seconds. */
	timeoutSeconds?: number;
	/** `--verify`: shell commands the run declares as its acceptance checks, in flag order. */
	verify: string[];
	/** `--verify-timeout`: the limit for each `--verify` check, in seconds. */
	verifyTimeoutSeconds?: number;
	/** `--answers`: the file that scripts the author's answers for a headless run. */
	answersFile?: string;
	/** `--output-format`: schema v2 output; absent keeps text output unchanged. */
	outputFormat?: RunOutputFormat;
	/** `-o/--output-last-message`: the file that receives the final answer when the run exits 0. */
	outputLastMessage?: string;
	/**
	 * `--output-schema <file.json>`: the JSON Schema the final answer must validate against (SPEC 6.8), or the task
	 * envelope's inline `output.schema` object, checked with the same refusals.
	 */
	outputSchema?: string | InlineOutputSchema;
	/** `--task-file <path|->`: the task envelope (SPEC 6.3); `-` reads it from stdin. Set, the run never reads stdin for task text. */
	taskFile?: string;
	/** `--trust-task-file`: accept envelope keys that widen what the host does (`verify`, yolo, `cwd`). */
	trustTaskFile?: boolean;
	fileArgs: string[];
	messages: string[];
	diagnostics: CliArgDiagnostic[];
}

/** A task envelope's `output.schema`: the object itself, and the dotted path that names it in diagnostics. */
export interface InlineOutputSchema {
	readonly inline: unknown;
	readonly label: string;
}

const VALID_THINKING: ReadonlyArray<JobThinkingLevel> = THINKING_LEVELS;

const IMAGE_ATTACHMENT = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * The run leaf/mode matrix, checked by the light parser so a refusal exits 2 before `run.js` loads.
 * Main mode is no `--agent`; agent mode is `--agent <recipe>` dispatch to a worker.
 *
 * | input                                                          | main  | agent |
 * | -------------------------------------------------------------- | ----- | ----- |
 * | --record, --agent-profile, --agent-runtime, --tool-profile, --require, --worktree | usage | ok |
 * | --turn-mode, --allow-tools, --deny-tools, --delegate-tools, --no-delegate | ok | usage |
 * | --resume, --session, --continue, --fork, --name                | ok    | usage |
 * | --fail-on-noop, --verify, --answers                            | ok    | usage |
 * | --systemone                                                    | ok    | usage |
 * | @<image> (png, jpeg, gif, webp)                                | ok    | usage |
 * | --autonomy                                                     | ok    | usage |
 * | --resume with --continue                                       | usage | usage |
 * | --fork without --resume or --continue                          | usage | usage |
 */
function runModeMatrixErrors(parsed: RunCliArgs): string[] {
	const errors: string[] = [];
	if (parsed.sessionId !== undefined && parsed.continueSession) {
		errors.push("--resume and --continue name different sessions; pass one");
	}
	if (parsed.forkSession && parsed.sessionId === undefined && !parsed.continueSession) {
		errors.push("--fork branches the session --resume <id> or --continue names; pass one of them");
	}
	if (parsed.agentId === undefined) {
		const dispatchOnly =
			parsed.record === true ||
			parsed.agentProfile !== undefined ||
			parsed.agentRuntime !== undefined ||
			parsed.toolProfile !== undefined ||
			parsed.worktree === true ||
			parsed.required.length > 0;
		if (dispatchOnly) errors.push("fleet dispatch flags require --agent <recipe-id>");
		return errors;
	}
	if (parsed.constraints) {
		errors.push(
			"--turn-mode, --allow-tools, --deny-tools, --delegate-tools, and --no-delegate apply to the main-agent task",
		);
	}
	if (
		parsed.sessionId !== undefined ||
		parsed.continueSession ||
		parsed.forkSession ||
		parsed.sessionName !== undefined
	) {
		errors.push("--resume, --continue, --fork and --name apply to the main agent; a worker has its own transcript");
	}
	const mainOnly: Array<[boolean, string]> = [
		[parsed.failOnNoop, "--fail-on-noop"],
		[parsed.failOnVerify === true, "--fail-on-verify"],
		[parsed.onPermission !== undefined, "--on-permission"],
		[parsed.dryRun === true, "--dry-run"],
		[parsed.maxRequests !== undefined, "--max-requests"],
		[parsed.maxToolCalls !== undefined, "--max-tool-calls"],
		[parsed.verify.length > 0, "--verify"],
		[parsed.answersFile !== undefined, "--answers"],
		[parsed.systemOne !== undefined, "--systemone"],
	];
	for (const [present, flag] of mainOnly) {
		if (present) errors.push(`${flag} applies to the main agent, not --agent dispatch`);
	}
	for (const file of parsed.fileArgs) {
		if (IMAGE_ATTACHMENT.test(file)) {
			errors.push(`@${file}: image attachments go to the main agent, not --agent dispatch`);
		}
	}
	return errors;
}

/**
 * The `--trust-task-file` gate (SPEC 6.3, review H06). A task envelope is data a
 * supervisor may have got from elsewhere; `verify` (host bash outside the agent's
 * permissions and sandbox), `permissions.autonomy: "yolo"` and `cwd` widen what
 * the host does. Returns the refusal (exit 2 `task_authority`) when the envelope
 * carries any of them untrusted, else undefined. The same for a file and stdin.
 */
export function taskFileAuthorityRefusal(
	envelope: Readonly<Record<string, unknown>>,
	trusted: boolean,
): string | undefined {
	if (trusted) return undefined;
	const permissions = envelope.permissions;
	const yolo =
		typeof permissions === "object" &&
		permissions !== null &&
		(permissions as Record<string, unknown>).autonomy === "yolo";
	const widening = [
		...(envelope.verify !== undefined ? ["verify"] : []),
		...(yolo ? ["permissions.autonomy yolo"] : []),
		...(envelope.cwd !== undefined ? ["cwd"] : []),
	];
	if (widening.length === 0) return undefined;
	return `task file carries ${widening.join(", ")}, which widen what the host does; pass --trust-task-file to accept ${widening.length === 1 ? "it" : "them"}`;
}

/** `--sandbox required` on a host with no OS sandbox: the exit-2 refusal before boot, else undefined. */
export function sandboxRequiredRefusal(availability: {
	available: boolean;
	reason: string | null;
}): string | undefined {
	if (availability.available) return undefined;
	return `--sandbox required, but no OS sandbox is available on this host (${availability.reason ?? "no backend"}); install bubblewrap or drop --sandbox required`;
}

/** SPEC 6.9: the limits this run was given, as the v2 envelope and `--dry-run` list them under `limits.requested`. */
export function requestedRunLimits(parsed: RunCliArgs): RunLimitsV2["requested"] {
	return {
		...(parsed.maxCostUsd !== undefined ? { maxCostUsd: parsed.maxCostUsd } : {}),
		...(parsed.maxRequests !== undefined ? { maxRequests: parsed.maxRequests } : {}),
		...(parsed.maxToolCalls !== undefined ? { maxToolCalls: parsed.maxToolCalls } : {}),
		...(parsed.timeoutSeconds !== undefined ? { timeoutSeconds: parsed.timeoutSeconds } : {}),
		...(parsed.requirePriced === true ? { requirePriced: true as const } : {}),
	};
}

export function parseRunCliArgs(argv: ReadonlyArray<string>): RunCliArgs {
	const parsed: RunCliArgs = {
		help: false,
		readOnly: false,
		json: false,
		required: [],
		noSkills: false,
		continueSession: false,
		forkSession: false,
		failOnNoop: false,
		verify: [],
		skillPaths: [],
		fileArgs: [],
		messages: [],
		diagnostics: [],
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const need = (flag: string): string | null => {
			const value = argv[i + 1];
			if (value === undefined || (value.startsWith("-") && !isNumericLiteral(value))) {
				parsed.diagnostics.push({ type: "error", message: `${flag} requires a value` });
				return null;
			}
			i += 1;
			return value;
		};
		// End of options: everything after "--" is message text, verbatim, so a prompt
		// that starts with a dash or an "@" is never read as a flag or a file.
		if (arg === "--") {
			parsed.messages.push(...argv.slice(i + 1));
			break;
		}
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--record") {
			parsed.record = true;
			continue;
		}
		if (arg === "--worktree") {
			parsed.worktree = true;
			continue;
		}
		// Removed in 0.8.5 (maintainer ruling): an unknown option (C17 `unknown_flag`) that names its replacement. A
		// `--json-events` value is taken with it so the refusal names the flag alone.
		if (arg === "--json" || arg === "--json-events" || arg?.startsWith("--json-events=")) {
			if (arg === "--json-events" && (argv[i + 1] === "full" || argv[i + 1] === "terminal")) i += 1;
			parsed.diagnostics.push({
				type: "error",
				slug: "unknown_flag",
				message: `unknown option: ${arg === "--json" ? arg : "--json-events"} (removed in 0.8.5; use --output-format json|stream-json)`,
			});
			continue;
		}
		// Read where it stands, before any other flag is judged, so a run whose other flags fail still frames that
		// failure in the format it asked for.
		if (arg === "--output-format" || arg?.startsWith("--output-format=")) {
			const value = arg === "--output-format" ? need(arg) : arg.slice("--output-format=".length);
			if (value !== null) {
				if (isRunOutputFormat(value)) parsed.outputFormat = value;
				else parsed.diagnostics.push({ type: "error", message: "--output-format must be one of: text|json|stream-json" });
			}
			continue;
		}
		if (arg === "--output-last-message" || arg === "-o" || arg?.startsWith("--output-last-message=")) {
			const value = arg.startsWith("--output-last-message=") ? arg.slice("--output-last-message=".length) : need(arg);
			if (value !== null && value.length > 0) parsed.outputLastMessage = value;
			else if (value !== null) parsed.diagnostics.push({ type: "error", message: `${arg} requires a path` });
			continue;
		}
		if (arg === "--output-schema" || arg?.startsWith("--output-schema=")) {
			const value = arg === "--output-schema" ? need(arg) : arg.slice("--output-schema=".length);
			if (value !== null && value.length > 0) parsed.outputSchema = value;
			else if (value !== null) parsed.diagnostics.push({ type: "error", message: "--output-schema requires a path" });
			continue;
		}
		// `-` is a value here (the envelope from stdin), so this flag reads its value itself rather than through need().
		if (arg === "--task-file" || arg?.startsWith("--task-file=")) {
			const value = arg === "--task-file" ? argv[i + 1] : arg.slice("--task-file=".length);
			if (arg === "--task-file" && value !== undefined && (value === "-" || !value.startsWith("-"))) i += 1;
			if (value === undefined || value.length === 0 || (value !== "-" && value.startsWith("-")))
				parsed.diagnostics.push({ type: "error", message: "--task-file requires a path, or - for stdin" });
			else if (parsed.taskFile !== undefined)
				parsed.diagnostics.push({ type: "error", message: "--task-file names one envelope; pass it once" });
			else parsed.taskFile = value;
			continue;
		}
		if (arg === "--trust-task-file") {
			parsed.trustTaskFile = true;
			continue;
		}
		if (arg === "--target") {
			const value = need(arg);
			if (value !== null) parsed.target = value;
			continue;
		}
		if (arg === "--model") {
			const value = need(arg);
			if (value !== null) parsed.model = value;
			continue;
		}
		if (arg === "--thinking") {
			const value = need(arg);
			if (value !== null) {
				if (VALID_THINKING.includes(value as JobThinkingLevel)) parsed.thinking = value as JobThinkingLevel;
				else
					parsed.diagnostics.push({
						type: "error",
						message: "--thinking must be one of: off|minimal|low|medium|high|xhigh|max",
					});
			}
			continue;
		}
		if (arg === "--read-only") {
			parsed.readOnly = true;
			continue;
		}
		if (arg === "--autonomy") {
			const value = need(arg);
			if (value !== null) {
				const autonomy = autonomyFromUserInput(value);
				if (autonomy) parsed.autonomy = autonomy;
				else
					parsed.diagnostics.push({
						type: "error",
						message: "--autonomy must be default|yolo",
					});
			}
			continue;
		}
		if (arg === "--systemone") {
			const value = need(arg);
			if (value !== null) parsed.systemOne = value;
			continue;
		}
		if (arg === "--temperature") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "temperature", value, { min: 0 });
			continue;
		}
		if (arg === "--top-p") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "topP", value, { min: 0, max: 1 });
			continue;
		}
		if (arg === "--top-k") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "topK", value, { min: 0, integer: true });
			continue;
		}
		if (arg === "--min-p") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "minP", value, { min: 0, max: 1 });
			continue;
		}
		if (arg === "--presence-penalty") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "presencePenalty", value);
			continue;
		}
		if (arg === "--frequency-penalty") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "frequencyPenalty", value);
			continue;
		}
		if (arg === "--repeat-penalty") {
			const value = need(arg);
			if (value !== null) setNumberOption(parsed, "repeatPenalty", value);
			continue;
		}
		if (arg === "--agent") {
			const value = need(arg);
			if (value !== null) parsed.agentId = value;
			continue;
		}
		if (arg === "--agent-profile") {
			const value = need(arg);
			if (value !== null) parsed.agentProfile = value;
			continue;
		}
		if (arg === "--agent-runtime") {
			const value = need(arg);
			if (value !== null) parsed.agentRuntime = value;
			continue;
		}
		if (arg === "--tool-profile") {
			const value = need(arg);
			if (value !== null) parsed.toolProfile = value;
			continue;
		}
		if (arg === "--require") {
			const value = need(arg);
			if (value !== null) parsed.required.push(value);
			continue;
		}
		if (arg === "--no-skills") {
			parsed.noSkills = true;
			continue;
		}
		if (arg === "--turn-mode") {
			const value = need(arg);
			if (value === "answer" || value === "proposal" || value === "change")
				parsed.constraints = { ...parsed.constraints, mode: value };
			else if (value !== null)
				parsed.diagnostics.push({ type: "error", message: "--turn-mode must be answer, proposal, or change" });
			continue;
		}
		if (arg === "--no-delegate") {
			parsed.constraints = { ...parsed.constraints, delegation: "forbidden" };
			continue;
		}
		if (arg === "--allow-tools" || arg === "--delegate-tools" || arg === "--deny-tools") {
			const value = need(arg);
			if (value !== null) {
				const names = parseToolLimitList(arg, value);
				if ("error" in names) parsed.diagnostics.push({ type: "error", message: names.error });
				else
					parsed.constraints = {
						...parsed.constraints,
						...toolLimitConstraints(arg, names),
					};
			}
			continue;
		}
		if (arg === "--skill") {
			const value = need(arg);
			if (value !== null) parsed.skillPaths.push(value);
			continue;
		}
		if (arg === "--max-context-tokens" || arg?.startsWith("--max-context-tokens=")) {
			const value = arg === "--max-context-tokens" ? need(arg) : arg.slice("--max-context-tokens=".length);
			const n = value === null ? null : parseMaxContextTokens(value);
			if (typeof n === "number") parsed.maxContextTokens = n;
			else if (n !== null) parsed.diagnostics.push({ type: "error", message: n.error });
			continue;
		}
		if (arg === "--resume" || arg === "-r" || arg?.startsWith("--resume=") || arg === "--session") {
			const value = arg.startsWith("--resume=") ? arg.slice("--resume=".length) : need(arg);
			if (value === "") parsed.diagnostics.push({ type: "error", message: "--resume requires a session" });
			else if (value !== null) parsed.sessionId = value;
			// One release of the old spelling (SPEC D6): it still resumes, and says what replaces it.
			if (arg === "--session")
				parsed.diagnostics.push({ type: "warning", message: "--session is deprecated; use --resume <id|prefix|name>" });
			continue;
		}
		if (arg === "--fork") {
			parsed.forkSession = true;
			continue;
		}
		if (arg === "--name" || arg?.startsWith("--name=")) {
			const value = arg === "--name" ? need(arg) : arg.slice("--name=".length);
			if (value !== null && value.trim() === "")
				parsed.diagnostics.push({ type: "error", message: "--name requires a non-empty name" });
			else if (value !== null) parsed.sessionName = value.trim();
			continue;
		}
		if (arg === "--continue") {
			parsed.continueSession = true;
			continue;
		}
		if (arg === "--answers") {
			const value = need(arg);
			if (value !== null) parsed.answersFile = value;
			continue;
		}
		if (arg === "--steer-channel") {
			const value = need(arg);
			if (value !== null) {
				parsed.steerChannel = value;
			}
			continue;
		}
		if (arg === "--timeout" || arg?.startsWith("--timeout=")) {
			const value = arg === "--timeout" ? need(arg) : arg.slice("--timeout=".length);
			if (value !== null) {
				const seconds = durationSeconds("--timeout", value, parsed);
				if (seconds !== null) parsed.timeoutSeconds = seconds;
			}
			continue;
		}
		if (arg === "--verify") {
			const value = argv[i + 1];
			// The command is shell text, so it may start with a dash; only its absence or a blank is an error.
			if (value === undefined || value.trim().length === 0) {
				parsed.diagnostics.push({ type: "error", message: "--verify requires a shell command" });
			} else {
				i += 1;
				parsed.verify.push(value);
			}
			continue;
		}
		if (arg === "--verify-timeout" || arg?.startsWith("--verify-timeout=")) {
			const value = arg === "--verify-timeout" ? need(arg) : arg.slice("--verify-timeout=".length);
			if (value !== null) {
				const seconds = durationSeconds("--verify-timeout", value, parsed);
				if (seconds !== null) parsed.verifyTimeoutSeconds = seconds;
			}
			continue;
		}
		if (arg === "--fail-on-noop") {
			parsed.failOnNoop = true;
			continue;
		}
		if (arg === "--fail-on-verify") {
			parsed.failOnVerify = true;
			continue;
		}
		if (arg === "--on-permission" || arg?.startsWith("--on-permission=")) {
			const value = arg === "--on-permission" ? need(arg) : arg.slice("--on-permission=".length);
			if (value === "deny" || value === "fail") parsed.onPermission = value;
			else if (value !== null)
				parsed.diagnostics.push({ type: "error", message: `--on-permission must be deny or fail, not ${value}` });
			continue;
		}
		if (arg === "--dry-run") {
			parsed.dryRun = true;
			continue;
		}
		if (arg === "--require-priced") {
			parsed.requirePriced = true;
			continue;
		}
		if (arg === "--sandbox") {
			const value = need(arg);
			if (value === "required") parsed.sandboxRequired = true;
			else if (value !== null)
				parsed.diagnostics.push({
					type: "error",
					message: `--sandbox accepts only required (a one-run tightening of safety.sandbox), not ${value}`,
				});
			continue;
		}
		if (arg === "--max-requests" || arg === "--max-tool-calls") {
			const value = need(arg);
			if (value !== null) {
				const count = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
				if (!Number.isSafeInteger(count) || count < 1)
					parsed.diagnostics.push({ type: "error", message: `${arg} must be a positive whole number, not ${value}` });
				else if (arg === "--max-requests") parsed.maxRequests = count;
				else parsed.maxToolCalls = count;
			}
			continue;
		}
		if (arg === "--max-cost-usd") {
			const value = need(arg);
			if (value !== null) {
				const usd = Number(value);
				if (Number.isFinite(usd) && usd > 0) parsed.maxCostUsd = usd;
				else parsed.diagnostics.push({ type: "error", message: "--max-cost-usd must be a positive number of US dollars" });
			}
			continue;
		}
		if (arg === "--cwd") {
			const value = need(arg);
			if (value !== null) parsed.cwd = value;
			continue;
		}
		if (arg === "-") {
			parsed.stdin = true;
			continue;
		}
		if (arg?.startsWith("-")) {
			parsed.diagnostics.push({
				type: "error",
				message: globalFlagPositionHint(arg, "run") ?? `unknown option: ${arg}`,
			});
			continue;
		}
		if (arg !== undefined) {
			if (arg.startsWith("@") && arg.length > 1) parsed.fileArgs.push(arg.slice(1));
			else parsed.messages.push(arg);
		}
	}

	// SPEC 6.2: the envelope carries the task and its attachments, so argv may carry neither.
	if (
		parsed.taskFile !== undefined &&
		(parsed.messages.length > 0 || parsed.fileArgs.length > 0 || parsed.stdin === true)
	) {
		parsed.diagnostics.push({
			type: "error",
			slug: "task_file_conflict",
			message: "--task-file carries the task and its attachments; drop the task text, @file and - from the command line",
		});
	}
	if (parsed.trustTaskFile === true && parsed.taskFile === undefined) {
		parsed.diagnostics.push({ type: "error", message: "--trust-task-file applies only with --task-file" });
	}
	// With --task-file the cross-flag checks run once, on the command line merged with the envelope (task-envelope.ts),
	// so a flag here and its partner in the envelope are judged together.
	if (parsed.taskFile !== undefined) return parsed;
	for (const message of runModeMatrixErrors(parsed)) parsed.diagnostics.push({ type: "error", message });
	if (parsed.agentId !== undefined && parsed.autonomy !== undefined) {
		parsed.diagnostics.push({
			type: "error",
			message: "--autonomy applies to the main agent; use --read-only to restrict --agent dispatch",
		});
	}
	if (parsed.verifyTimeoutSeconds !== undefined && parsed.verify.length === 0) {
		parsed.diagnostics.push({ type: "error", message: "--verify-timeout applies only with --verify" });
	}
	if (parsed.failOnVerify === true && parsed.verify.length === 0) {
		parsed.diagnostics.push({ type: "error", message: "--fail-on-verify applies only with --verify" });
	}
	const toolConflict = parsed.constraints === undefined ? undefined : toolLimitConflict(parsed.constraints);
	if (toolConflict !== undefined)
		parsed.diagnostics.push({ type: "error", slug: "flag_conflict", message: toolConflict });
	return parsed;
}

/**
 * A `--timeout`-style value (C11): `90`, `90s`, `15m`, `2h` or `500ms`; a bare number stays seconds. The run's
 * timers cap what a value may be, so a larger one is refused rather than clamped.
 */
function durationSeconds(flag: string, value: string, parsed: RunCliArgs): number | null {
	const duration = parseDuration(value, { bareUnit: "s" });
	if (duration.ok && duration.ms <= MAX_TIMER_DELAY_MS) return duration.ms / 1000;
	parsed.diagnostics.push({
		type: "error",
		message: duration.ok
			? `${flag} must be no longer than ${Math.floor(MAX_TIMER_DELAY_MS / 1000)} seconds`
			: `${flag}: ${duration.message}`,
	});
	return null;
}

function setNumberOption(
	parsed: RunCliArgs,
	key: keyof NonNullable<RunCliArgs["sampling"]>,
	raw: string,
	limits: { min?: number; max?: number; integer?: boolean } = {},
): void {
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		parsed.diagnostics.push({ type: "error", message: `--${kebab(key)} must be a number` });
		return;
	}
	if (limits.min !== undefined && value < limits.min) {
		parsed.diagnostics.push({ type: "error", message: `--${kebab(key)} must be >= ${limits.min}` });
		return;
	}
	if (limits.max !== undefined && value > limits.max) {
		parsed.diagnostics.push({ type: "error", message: `--${kebab(key)} must be <= ${limits.max}` });
		return;
	}
	const normalized = limits.integer === true ? Math.floor(value) : value;
	parsed.sampling = { ...(parsed.sampling ?? {}), [key]: normalized };
}

function kebab(value: string): string {
	return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function isNumericLiteral(value: string): boolean {
	return value.startsWith("-") && !value.startsWith("--") && Number.isFinite(Number(value));
}
