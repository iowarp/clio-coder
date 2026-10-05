import type { JobPredicate, JobRecord } from "../core/job-types.js";
import { jobIsComplete } from "../domains/scheduling/job-model.js";
import type { JobOperations } from "../tools/job-types.js";
import type { ToolResult } from "../tools/registry.js";
import type { NoticeLevel } from "./notice-source.js";

/**
 * Operator grammar for `/loop`.
 *
 * Pure: no I/O, no clock, no registry import. The parser turns operator text or
 * typed argv into the argument record the shared `job` control takes, so the
 * slash command, the ACP command and the model's `job` tool create jobs through
 * one admission path and none of them can mint a second execution authority.
 *
 *   /loop <every> [--count N] [--for DUR] [--timeout DUR] <task...>
 *   /loop <every> [--count N] [--for DUR] [--timeout DUR] [--until PRED]
 *         [--on-match notice|main_turn] [--follow-up TEXT] --command <program> [args...]
 *   /loop list | status [id] | pause <id> | resume <id> | stop <id> | cancel <id>
 *
 * Three rules keep the grammar honest:
 *
 *   - Flags end at the first task word or at `--command`. The words after
 *     `--command` are argv elements, never a shell line, so nothing here
 *     expands, pipes or substitutes. A single quoted element holding spaces is
 *     refused with the spelling that works instead of being split behind the
 *     operator's back.
 *   - A predicate is data: one comparison of a path into the command's JSON
 *     output against a scalar. No expression is evaluated.
 *   - Limits stay with the controller. This file checks that a number or
 *     duration is well formed and says nothing about whether one second is too
 *     short, so the grammar cannot drift from the admission that enforces it.
 */

/** The typed `until` predicate the job control revalidates: a comparison over the command's JSON result. */
export type LoopPredicate = JobPredicate;

/** The arguments of `job` action=create, as this grammar can express them. */
export type LoopCreateArgs = {
	action: "create";
	runner: "main" | "command";
	every_ms: number;
	count?: number;
	timeout_ms?: number;
	for_ms?: number;
	prompt?: string;
	argv?: string[];
	until?: LoopPredicate;
	on_match?: "notice" | "main_turn";
	follow_up?: string;
};

export const LOOP_CONTROL_ACTIONS = ["pause", "resume", "stop", "cancel"] as const;
/** First words that read or control existing jobs and never create one. */
export const LOOP_OBSERVE_VERBS: ReadonlyArray<string> = ["list", "status", ...LOOP_CONTROL_ACTIONS];
export type LoopControlAction = (typeof LOOP_CONTROL_ACTIONS)[number];

export type LoopCommand =
	| { kind: "create"; args: LoopCreateArgs }
	| { kind: "list" }
	| { kind: "status"; id: string | undefined }
	| { kind: "control"; action: LoopControlAction; id: string };

export type LoopParseResult = { ok: true; command: LoopCommand } | { ok: false; reason: string };

/** One line per spelling, in the order the usage line shows them. */
export const LOOP_SUBCOMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
	list: "List this session's jobs",
	status: "Show one job, or every job",
	pause: "Hold a job; resume restarts its schedule",
	resume: "Resume a paused job",
	stop: "Stop new runs and let the current run finish",
	cancel: "Stop new runs and abort the current run",
};

const MAX_TOKEN_BYTES = 4096;
const MAX_TOKENS = 64;
const MAX_PATH_SEGMENTS = 16;
const MAX_LITERAL_CHARS = 512;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DURATION = /^(\d{1,9})(ms|s|m|h|d)$/u;
const DURATION_UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function fail(reason: string): LoopParseResult {
	return { ok: false, reason };
}

/**
 * Split an operator line into words. Whitespace separates; single quotes keep
 * everything literal; double quotes keep it literal except `\"` and `\\`.
 * Adjacent quoted and bare pieces join (`a"b c"` is one word). This groups
 * words and nothing else: there is no variable, glob or command expansion, and
 * an unterminated quote is an error rather than a guess.
 */
export function tokenizeLoopLine(line: string): { tokens: string[] } | { error: string } {
	const tokens: string[] = [];
	let current = "";
	let open = false;
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < line.length; index++) {
		const char = line[index] as string;
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else if (char === "\\" && (line[index + 1] === '"' || line[index + 1] === "\\")) {
				current += line[index + 1] as string;
				index++;
			} else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			open = true;
			continue;
		}
		if (/\s/u.test(char)) {
			if (open || current.length > 0) tokens.push(current);
			current = "";
			open = false;
			continue;
		}
		current += char;
		open = true;
	}
	if (quote !== null) return { error: `Unterminated ${quote === '"' ? "double" : "single"} quote` };
	if (open || current.length > 0) tokens.push(current);
	return { tokens };
}

/** `30s`, `5m`, `2h`, `1d`, `1500ms` as milliseconds; null when the text is not one positive duration. */
export function parseLoopDuration(text: string): number | null {
	const match = DURATION.exec(text.trim());
	if (match === null) return null;
	const amount = Number(match[1]);
	const unit = match[2] as keyof typeof DURATION_UNIT_MS;
	const ms = amount * DURATION_UNIT_MS[unit];
	return amount > 0 && Number.isSafeInteger(ms) ? ms : null;
}

const PREDICATE_OPERATORS = { "==": "eq", "!=": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" } as const;
const PREDICATE_PATTERN = /^json((?:\.[A-Za-z0-9_-]+)+)\s*(==|!=|<=|>=|<|>)\s*([\s\S]+)$/u;
const EXISTS_PATTERN = /^json((?:\.[A-Za-z0-9_-]+)+)\s+exists$/u;

function parseScalar(text: string): { value: string | number | boolean | null } | { error: string } {
	const trimmed = text.trim();
	if (trimmed.length > MAX_LITERAL_CHARS) return { error: `the value is longer than ${MAX_LITERAL_CHARS} characters` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// JSON.parse failing means the text is not a JSON literal; the hint names the usual cause.
		return { error: `the value ${trimmed} is not JSON. Quote strings with double quotes, for example "completed"` };
	}
	if (parsed !== null && typeof parsed === "object") {
		return { error: "compare against a string, number, true, false or null" };
	}
	return { value: parsed as string | number | boolean | null };
}

/**
 * `json.<path> <op> <value>` with op `==`, `!=`, `<`, `<=`, `>`, `>=`, or
 * `json.<path> exists`. The path walks the command's JSON result by dotted
 * names (array positions are their digits, `json.runs.0.status`) and the value
 * is one JSON scalar. Nothing is evaluated: a string that looks like code is
 * just a string to compare against. The job control revalidates the result.
 */
export function parseLoopPredicate(text: string): { predicate: LoopPredicate } | { error: string } {
	const trimmed = text.trim();
	const exists = EXISTS_PATTERN.exec(trimmed);
	const comparison = exists === null ? PREDICATE_PATTERN.exec(trimmed) : null;
	const pathText = exists?.[1] ?? comparison?.[1];
	if (pathText === undefined) {
		return {
			error: `--until needs json.<path> == <value> (also !=, <, <=, >, >=) or json.<path> exists, for example --until 'json.status == "completed"'`,
		};
	}
	const path = pathText.slice(1).split(".");
	if (path.length > MAX_PATH_SEGMENTS) return { error: `the path is deeper than ${MAX_PATH_SEGMENTS} names` };
	if (path.some((name) => name === "__proto__" || name === "prototype" || name === "constructor")) {
		return { error: "the path names a reserved property" };
	}
	if (exists !== null) return { predicate: { path, op: "exists" } };
	const op = PREDICATE_OPERATORS[(comparison?.[2] ?? "==") as keyof typeof PREDICATE_OPERATORS];
	const scalar = parseScalar(comparison?.[3] ?? "");
	if ("error" in scalar) return { error: `--until: ${scalar.error}` };
	if (op !== "eq" && op !== "ne" && typeof scalar.value !== "number") {
		return { error: `--until: ${comparison?.[2]} compares numbers; got ${JSON.stringify(scalar.value)}` };
	}
	return { predicate: { path, op, value: scalar.value } };
}

function parseCount(text: string): number | null {
	return /^\d{1,6}$/u.test(text) && Number(text) > 0 ? Number(text) : null;
}

type DurationFlag = { flag: "--for" | "--timeout"; field: "for_ms" | "timeout_ms" };
const DURATION_FLAGS: ReadonlyArray<DurationFlag> = [
	{ flag: "--for", field: "for_ms" },
	{ flag: "--timeout", field: "timeout_ms" },
];

/** The flags this grammar knows, for the "unknown option" refusal. */
const VALUE_FLAGS = ["--count", "--for", "--timeout", "--until", "--on-match", "--follow-up"] as const;

/**
 * The words of a task as one prompt. A prompt-typed ACP line reaches here split on
 * whitespace with its quotes still on, so a task written as `"check the build"`
 * arrives as several words wrapped in a quote pair; that pair is the operator's
 * grouping and not part of the task. A lone word, or a quote that closes early,
 * is left exactly as written.
 */
function taskText(words: ReadonlyArray<string>): string {
	const joined = words.join(" ");
	const quote = joined[0];
	if (
		words.length > 1 &&
		(quote === '"' || quote === "'") &&
		joined.endsWith(quote) &&
		!joined.slice(1, -1).includes(quote)
	) {
		return joined.slice(1, -1);
	}
	return joined;
}

function parseCreate(tokens: ReadonlyArray<string>): LoopParseResult {
	const args: LoopCreateArgs = { action: "create", runner: "main", every_ms: 0 };
	let every: number | null = null;
	let index = 0;
	let command: string[] | undefined;
	let task: string | undefined;
	const seen = new Set<string>();
	while (index < tokens.length) {
		const token = tokens[index] as string;
		if (token === "--command") {
			// The words after it are argv, so an interval written after them would be swallowed.
			if (every === null)
				return fail("Write the interval before --command, for example /loop 1m --command gh run view 123");
			command = tokens.slice(index + 1);
			break;
		}
		if (token === "--") {
			task = taskText(tokens.slice(index + 1));
			break;
		}
		if (!token.startsWith("--")) {
			// Options may come before or after the interval, and both end at the first task word.
			if (every !== null) {
				task = taskText(tokens.slice(index));
				break;
			}
			every = parseLoopDuration(token);
			if (every === null) {
				return fail(
					`Unrecognized interval "${token}". Write one duration such as 30s, 5m or 2h, or one of ${["list", "status", ...LOOP_CONTROL_ACTIONS].join(", ")}`,
				);
			}
			index++;
			continue;
		}
		if (!(VALUE_FLAGS as ReadonlyArray<string>).includes(token)) {
			return fail(`Unknown option ${token}. Options are ${[...VALUE_FLAGS, "--command"].join(", ")}`);
		}
		if (seen.has(token)) return fail(`${token} was given twice`);
		seen.add(token);
		const value = tokens[index + 1];
		if (value === undefined) return fail(`${token} needs a value`);
		index += 2;
		const durationFlag = DURATION_FLAGS.find((entry) => entry.flag === token);
		if (durationFlag !== undefined) {
			const ms = parseLoopDuration(value);
			if (ms === null) return fail(`${token} needs a duration such as 30s, 5m or 2h; got "${value}"`);
			args[durationFlag.field] = ms;
		} else if (token === "--count") {
			const count = parseCount(value);
			if (count === null) return fail(`--count needs a whole number of runs, at least 1; got "${value}"`);
			args.count = count;
		} else if (token === "--until") {
			const parsed = parseLoopPredicate(value);
			if ("error" in parsed) return fail(parsed.error);
			args.until = parsed.predicate;
		} else if (token === "--on-match") {
			if (value !== "notice" && value !== "main_turn") return fail(`--on-match is notice or main_turn; got "${value}"`);
			args.on_match = value;
		} else if (token === "--follow-up") {
			if (value.trim().length === 0) return fail("--follow-up needs the text to send when the condition matches");
			args.follow_up = value;
		}
	}
	if (every === null) return fail('Give the interval, for example /loop 5m "check the build"');
	args.every_ms = every;
	if (command !== undefined) {
		if (task !== undefined) return fail("Give either a task or --command, not both");
		const [program] = command;
		if (program === undefined) return fail("--command needs a program, for example --command gh run view 123");
		if (command.length === 1 && /\s/u.test(program)) {
			return fail(
				`--command takes the program and each argument as separate words, not one quoted line. Write --command ${program.split(/\s+/u).join(" ")}`,
			);
		}
		if ((args.on_match !== undefined || args.follow_up !== undefined) && args.until === undefined) {
			return fail("--on-match and --follow-up act when --until matches, so give --until too");
		}
		if (args.on_match === "main_turn" && args.follow_up === undefined) {
			return fail("--on-match main_turn needs --follow-up with the text to send when the condition matches");
		}
		if (args.follow_up !== undefined && args.on_match !== "main_turn") {
			return fail("--follow-up needs --on-match main_turn");
		}
		args.runner = "command";
		args.argv = command;
		return { ok: true, command: { kind: "create", args } };
	}
	if (args.until !== undefined) return fail("--until reads a command's output, so it needs --command");
	if (task === undefined || task.trim().length === 0) {
		return fail("Give the task to run each time, or --command <program> [args...]");
	}
	if (args.on_match !== undefined || args.follow_up !== undefined) {
		return fail("--on-match and --follow-up belong to --command polling");
	}
	args.prompt = task;
	return { ok: true, command: { kind: "create", args } };
}

function parseId(verb: string, tokens: ReadonlyArray<string>): { id: string } | { error: string } {
	const id = tokens[1];
	if (id === undefined) return { error: `/loop ${verb} needs a job id. Run /loop list to see them` };
	if (tokens.length > 2) return { error: `/loop ${verb} takes one job id` };
	if (!JOB_ID.test(id)) return { error: `"${id}" is not a job id. Run /loop list to see them` };
	return { id };
}

/**
 * Parse the words after `/loop`. The ACP command passes typed argv straight
 * here, so an element with spaces stays one element; the slash command gets
 * the same words from {@link tokenizeLoopLine}.
 */
export function parseLoopArgv(tokens: ReadonlyArray<string>): LoopParseResult {
	if (tokens.length === 0) return fail("Give an interval and a task, or a control verb");
	if (tokens.length > MAX_TOKENS) return fail(`Too many words (limit ${MAX_TOKENS})`);
	if (tokens.some((token) => Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES)) {
		return fail(`A word is longer than ${MAX_TOKEN_BYTES} bytes`);
	}
	const verb = tokens[0] as string;
	if (verb === "list") {
		return tokens.length === 1 ? { ok: true, command: { kind: "list" } } : fail("/loop list takes no arguments");
	}
	if (verb === "status") {
		if (tokens.length === 1) return { ok: true, command: { kind: "status", id: undefined } };
		const parsed = parseId("status", tokens);
		return "error" in parsed ? fail(parsed.error) : { ok: true, command: { kind: "status", id: parsed.id } };
	}
	if ((LOOP_CONTROL_ACTIONS as ReadonlyArray<string>).includes(verb)) {
		const parsed = parseId(verb, tokens);
		return "error" in parsed
			? fail(parsed.error)
			: { ok: true, command: { kind: "control", action: verb as LoopControlAction, id: parsed.id } };
	}
	return parseCreate(tokens);
}

/** The words of a typed `/loop` line, or the reason it cannot be split. */
export function parseLoopLine(text: string): LoopParseResult {
	const split = tokenizeLoopLine(text);
	return "error" in split ? fail(split.error) : parseLoopArgv(split.tokens);
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

const OPERATOR_SYMBOLS: Readonly<Record<JobPredicate["op"], string>> = {
	eq: "==",
	ne: "!=",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
	exists: "exists",
};
const SUMMARY_CHARS = 160;
const TASK_PREVIEW_CHARS = 48;
/** An active job this far past its due time with nothing running or waiting is reported stale. */
const STALE_MIN_MS = 30_000;

/** `90000` as `1m30s`; at most two units, so a status line stays short. */
export function formatLoopDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	let seconds = Math.round(ms / 1_000);
	const parts: string[] = [];
	for (const [unit, size] of [
		["d", 86_400],
		["h", 3_600],
		["m", 60],
		["s", 1],
	] as const) {
		if (seconds >= size) {
			parts.push(`${Math.floor(seconds / size)}${unit}`);
			seconds %= size;
		}
		if (parts.length === 2) break;
	}
	return parts.join("");
}

function preview(text: string, limit: number): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function predicateText(predicate: JobPredicate): string {
	const path = `json.${predicate.path.join(".")}`;
	return predicate.op === "exists"
		? `${path} exists`
		: `${path} ${OPERATOR_SYMBOLS[predicate.op]} ${JSON.stringify(predicate.value)}`;
}

function runnerText(job: JobRecord): string {
	const runner = job.spec.runner;
	if (runner.kind === "main") return `main turn "${preview(runner.prompt, TASK_PREVIEW_CHARS)}"`;
	const [program = "", ...rest] = runner.argv;
	const name = program.split("/").pop() ?? program;
	return `command ${preview([name, ...rest].join(" "), 72)}`;
}

function runsText(job: JobRecord): string {
	const limit = job.spec.count;
	if (limit === null) return `${job.starts} run${job.starts === 1 ? "" : "s"} so far (until deadline)`;
	return `${job.starts}/${limit} runs`;
}

function dueText(job: JobRecord, now: number): string {
	if (job.state !== "active" || job.nextDueAt === null) return "no next run";
	const delta = job.nextDueAt - now;
	return delta >= 0 ? `next in ${formatLoopDuration(delta)}` : `due ${formatLoopDuration(-delta)} ago`;
}

function lastOutcomeText(job: JobRecord): string | null {
	const last = job.history[job.history.length - 1] ?? null;
	return last?.evidence ? last.evidence.outcome : null;
}

/**
 * The state word, carrying the end reason or the live qualifier. A terminal job
 * is `ended` only once nothing of it is still running: a cancel waiting on its
 * current run or a follow-up still being delivered is said so, never rounded up.
 */
function stateText(job: JobRecord): string {
	if (job.state === "terminal") {
		const ended = `ended (${job.reason ?? "unknown"})`;
		if (jobIsComplete(job)) return ended;
		const delivery = job.delivery;
		if (delivery !== null && (delivery.state === "pending" || delivery.state === "running")) {
			return `${ended}, ${delivery.kind === "main_turn" ? "follow-up" : "notice"} ${delivery.state}`;
		}
		return `${ended}, settling`;
	}
	if (job.cancelRequested) return "cancel requested";
	return job.state;
}

/** An active job whose next run is long overdue with nothing running or waiting, which a live host would not leave. */
export function isStaleLoopJob(job: JobRecord, now: number): boolean {
	if (job.state !== "active" || job.active !== null || job.pendingReason !== null || job.nextDueAt === null)
		return false;
	return now - job.nextDueAt > Math.max(STALE_MIN_MS, 2 * job.spec.intervalMs);
}

function jobWarnings(job: JobRecord, now: number): string[] {
	const warnings: string[] = [];
	if (job.state === "paused") warnings.push(`paused; /loop resume ${job.id} restarts its schedule`);
	if (isStaleLoopJob(job, now))
		warnings.push("stale: the next run is overdue and nothing is running; the job host may be gone");
	if (job.persistenceError !== null) warnings.push(`not saved: ${preview(job.persistenceError, SUMMARY_CHARS)}`);
	if (job.state === "terminal" && job.reason === "failure") warnings.push("ended after repeated failures");
	return warnings;
}

/** One row of `/loop list`: what the job is, how far it got, when it runs next, how the last run ended. */
export function loopJobRow(job: JobRecord, now: number): string {
	const parts = [
		job.id,
		stateText(job),
		`every ${formatLoopDuration(job.spec.intervalMs)}`,
		runnerText(job),
		runsText(job),
		job.active !== null ? "running now" : dueText(job, now),
	];
	const last = lastOutcomeText(job);
	if (last !== null) parts.push(`last ${last}`);
	if (job.pendingReason !== null) parts.push(`waiting: ${preview(job.pendingReason, 60)}`);
	return parts.join(" · ");
}

/** The level a job's row is reported at: a held, stale, unsaved or failed job is a warning. */
export function loopJobLevel(job: JobRecord, now: number): NoticeLevel {
	return jobWarnings(job, now).length > 0 ? "warn" : "info";
}

/** `/loop status <id>`: every canonical fact the record holds, and nothing it does not. */
export function loopJobDetail(job: JobRecord, now: number): string[] {
	const lines = [`${job.id} · ${stateText(job)} · ${runnerText(job)}`];
	lines.push(
		`every ${formatLoopDuration(job.spec.intervalMs)} · ${runsText(job)} · ${job.settled} settled · ${dueText(job, now)}`,
	);
	lines.push(
		`timeout ${formatLoopDuration(job.spec.timeoutMs)} · ${
			job.spec.deadlineAt === null
				? "no deadline"
				: job.spec.deadlineAt > now
					? `deadline in ${formatLoopDuration(job.spec.deadlineAt - now)}`
					: "deadline reached"
		}`,
	);
	if (job.spec.until !== null) {
		lines.push(
			`until ${predicateText(job.spec.until)} · on match ${job.spec.onMatch.kind === "notice" ? "notice" : `main turn "${preview(job.spec.onMatch.prompt, TASK_PREVIEW_CHARS)}"`}`,
		);
	}
	if (job.active !== null) lines.push("running now");
	if (job.pendingReason !== null) lines.push(`waiting: ${preview(job.pendingReason, SUMMARY_CHARS)}`);
	const last = job.history[job.history.length - 1] ?? null;
	if (last?.evidence) {
		lines.push(
			`last run ${last.evidence.outcome}${last.evidence.summary ? `: ${preview(last.evidence.summary, SUMMARY_CHARS)}` : ""}${last.evidence.truncated ? " (output truncated)" : ""}`,
		);
	}
	if (job.consecutiveFailures > 0)
		lines.push(`${job.consecutiveFailures} consecutive failure${job.consecutiveFailures === 1 ? "" : "s"}`);
	if (job.delivery !== null) {
		lines.push(
			`${job.delivery.kind === "main_turn" ? "follow-up turn" : "notice"} ${job.delivery.state}${job.delivery.reason ? `: ${preview(job.delivery.reason, SUMMARY_CHARS)}` : ""}`,
		);
	}
	if (job.costUsd !== null) lines.push(`cost $${job.costUsd.toFixed(4)}`);
	for (const warning of jobWarnings(job, now)) lines.push(`warning: ${warning}`);
	return lines;
}

/** The creation report: one headline with the job id and every bound the schedule runs under, applied defaults marked. */
export function loopCreatedLines(job: JobRecord, args: LoopCreateArgs, now: number): string[] {
	const countDefault = args.count === undefined && args.for_ms === undefined;
	const bounds = [
		job.nextDueAt === null ? "first run pending" : `first run in ${formatLoopDuration(Math.max(0, job.nextDueAt - now))}`,
		job.spec.count === null
			? "runs until the deadline"
			: `${job.spec.count} run${job.spec.count === 1 ? "" : "s"}${countDefault ? " (default)" : ""}`,
		`timeout ${formatLoopDuration(job.spec.timeoutMs)}${args.timeout_ms === undefined ? " (default)" : ""}`,
		job.spec.deadlineAt === null
			? "no deadline"
			: `deadline in ${formatLoopDuration(Math.max(0, job.spec.deadlineAt - now))}`,
	];
	const lines = [
		`loop ${job.id} created: ${runnerText(job)} every ${formatLoopDuration(job.spec.intervalMs)} · ${bounds.join(" · ")}`,
	];
	if (job.spec.until !== null) {
		lines.push(
			`until ${predicateText(job.spec.until)} · on match ${job.spec.onMatch.kind === "notice" ? "notice" : "main turn follow-up"}`,
		);
	}
	lines.push(
		`/loop status ${job.id} · /loop stop ${job.id} finishes the current run · /loop cancel ${job.id} aborts it`,
	);
	return lines;
}

/** What `/loop` needs from its host. The slash context and the ACP command host both supply it. */
export interface LoopHost {
	jobs: JobOperations | undefined;
	/** One line at a level. The terminal collapses newlines in a notice, so a report's body goes through `output`. */
	notice: (level: NoticeLevel, text: string) => void;
	/** Body lines under the headline, kept one per row. */
	output: (lines: ReadonlyArray<string>) => void;
	now: () => number;
}

function report(host: LoopHost, level: NoticeLevel, lines: ReadonlyArray<string>): void {
	const [headline = "", ...body] = lines;
	host.notice(level, headline);
	if (body.length > 0) host.output(body);
}

export const LOOP_NO_HOST_NOTICE =
	"/loop needs a session-owned job host, and this session has none (headless runs and older hosts do not provide one). Nothing was scheduled";

function isJobRecord(value: unknown): value is JobRecord {
	if (typeof value !== "object" || value === null) return false;
	const job = value as Partial<JobRecord>;
	return (
		typeof job.id === "string" && typeof job.state === "string" && typeof job.spec === "object" && job.spec !== null
	);
}

function jobFromResult(result: ToolResult): JobRecord | null {
	if (result.kind !== "ok") return null;
	const job = result.details?.job;
	return isJobRecord(job) ? job : null;
}

function controlVerbText(action: LoopControlAction, job: JobRecord): string {
	if (action === "pause") return `loop ${job.id} paused`;
	if (action === "resume") return `loop ${job.id} resumed`;
	if (jobIsComplete(job)) return `loop ${job.id} ${action === "stop" ? "stopped" : "canceled"}`;
	return action === "stop"
		? `loop ${job.id} stopping: the current run finishes and no new run starts`
		: `loop ${job.id} cancel requested: waiting for the current run to settle`;
}

/**
 * Run one parsed `/loop` command against the host's shared job control.
 *
 * Creation and control go through `jobs.invoke`, the same admission the model's
 * `job` tool uses, and settle when the job is accepted or refused, not when its
 * runs finish. Observation reads the typed records. A refusal is the control's
 * own actionable message, printed as written. Never throws: a host failure is a
 * notice, because a command handler that rejects would leave the operator with
 * a silent line and, over ACP, a protocol fault for an ordinary mistake.
 */
export async function runLoopCommand(command: LoopCommand, host: LoopHost): Promise<void> {
	const jobs = host.jobs;
	if (jobs === undefined) {
		host.notice("warn", LOOP_NO_HOST_NOTICE);
		return;
	}
	try {
		const now = host.now();
		if (command.kind === "list") {
			const all = jobs.list();
			if (all.length === 0) {
				host.notice("info", 'No loop jobs in this session. Start one with /loop 1m "task"');
				return;
			}
			report(host, all.some((job) => loopJobLevel(job, now) === "warn") ? "warn" : "info", [
				`loop jobs (${all.length}):`,
				...all.map((job) => loopJobRow(job, now)),
			]);
			return;
		}
		if (command.kind === "status") {
			if (command.id === undefined) {
				await runLoopCommand({ kind: "list" }, host);
				return;
			}
			const job = jobs.status(command.id);
			if (job === null) {
				host.notice("error", `No loop job ${command.id} in this session. Run /loop list to see the ids`);
				return;
			}
			report(host, loopJobLevel(job, now), loopJobDetail(job, now));
			return;
		}
		const args: Record<string, unknown> =
			command.kind === "create" ? command.args : { action: command.action, job_id: command.id };
		const result = await jobs.invoke(args);
		if (result.kind === "error") {
			host.notice("error", result.message);
			return;
		}
		const job = jobFromResult(result);
		if (job === null) {
			report(host, "success", result.output.split("\n"));
			return;
		}
		const after = host.now();
		if (command.kind === "create") {
			report(host, loopJobLevel(job, after) === "warn" ? "warn" : "success", loopCreatedLines(job, command.args, after));
		} else {
			host.notice("success", controlVerbText(command.action, job));
		}
	} catch (error) {
		host.notice("error", `loop failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/* -------------------------------------------------------------------------- */
/* Change reporting                                                            */
/* -------------------------------------------------------------------------- */

/** What a surface already told the operator about one job, so a notice fires on a transition and never on a tick. */
interface ReportedJob {
	revision: number;
	state: JobRecord["state"];
	complete: boolean;
	reason: JobRecord["reason"];
	deliveryId: string | null;
	deliveryState: string | null;
	persistenceError: string | null;
}

export interface LoopNotice {
	level: NoticeLevel;
	text: string;
}

function reportedOf(job: JobRecord): ReportedJob {
	return {
		revision: job.revision,
		state: job.state,
		complete: jobIsComplete(job),
		reason: job.reason,
		deliveryId: job.delivery?.id ?? null,
		deliveryState: job.delivery?.state ?? null,
		persistenceError: job.persistenceError,
	};
}

function endedNotice(job: JobRecord): LoopNotice {
	const runs = `${job.starts} run${job.starts === 1 ? "" : "s"}`;
	switch (job.reason) {
		case "count":
			return { level: "success", text: `loop ${job.id} finished: ${runs} done` };
		case "condition":
			return { level: "success", text: `loop ${job.id} ended: condition met after ${runs}` };
		case "deadline":
			return { level: "warn", text: `loop ${job.id} ended at its deadline after ${runs}` };
		case "failure": {
			const last = job.history[job.history.length - 1]?.evidence?.summary;
			return {
				level: "warn",
				text: `loop ${job.id} ended after repeated failures${last ? `: ${preview(last, SUMMARY_CHARS)}` : ""}`,
			};
		}
		case "canceled":
			return { level: "info", text: `loop ${job.id} canceled after ${runs}` };
		default:
			return { level: "info", text: `loop ${job.id} stopped after ${runs}` };
	}
}

/**
 * The notices one job change earns, given what was already reported. A job seen
 * for the first time is silent unless it arrives paused (a recovered job the
 * operator must resume): its creation was reported by whoever created it.
 */
export function loopTransitionNotices(previous: ReportedJob | undefined, job: JobRecord): LoopNotice[] {
	const notices: LoopNotice[] = [];
	const pausedText = `loop ${job.id} is paused${job.pendingReason ? `: ${preview(job.pendingReason, SUMMARY_CHARS)}` : ""}. /loop resume ${job.id} restarts its schedule`;
	if (previous === undefined) {
		if (job.state === "paused") notices.push({ level: "warn", text: pausedText });
		return notices;
	}
	if (job.persistenceError !== null && previous.persistenceError === null) {
		notices.push({
			level: "warn",
			text: `loop ${job.id} could not be saved: ${preview(job.persistenceError, SUMMARY_CHARS)}`,
		});
	}
	if (job.state !== previous.state && job.state === "paused") notices.push({ level: "warn", text: pausedText });
	// An end is reported once everything of the job has settled, not when recurrence stops.
	if (jobIsComplete(job) && !previous.complete) notices.push(endedNotice(job));
	const delivery = job.delivery;
	if (delivery !== null && (delivery.id !== previous.deliveryId || delivery.state !== previous.deliveryState)) {
		const summary = delivery.evidence?.summary ? `: ${preview(delivery.evidence.summary, SUMMARY_CHARS)}` : "";
		if (delivery.kind === "notice" && delivery.state === "delivered") {
			notices.push({ level: "success", text: `loop ${job.id} matched${summary}` });
		} else if (delivery.state === "failed" || delivery.state === "dropped") {
			const why = delivery.reason ? `: ${preview(delivery.reason, SUMMARY_CHARS)}` : summary;
			notices.push({
				level: "warn",
				text: `loop ${job.id} ${delivery.kind === "main_turn" ? "follow-up turn" : "notice"} ${delivery.state}${why}`,
			});
		}
	}
	return notices;
}

export interface LoopChangeReporting {
	/** The shared job control, with operator commands reported once by the command and not again as a change. */
	jobs: JobOperations;
	dispose(): void;
}

/**
 * Report job transitions to one surface, and nothing per tick.
 *
 * The controller publishes a change before the command that caused it has
 * answered, so a pause typed by the operator would be reported by the change
 * and then again by the command. Changes seen while an operator command is in
 * flight are held, the command's own result is recorded as already reported,
 * and the held changes are replayed against that record, so only transitions
 * the command did not itself report reach the operator.
 */
export function reportLoopChanges(jobs: JobOperations, emit: (notice: LoopNotice) => void): LoopChangeReporting {
	const reported = new Map<string, ReportedJob>();
	const held = new Map<string, JobRecord>();
	let inFlight = 0;
	const settle = (job: JobRecord): void => {
		// A view older than what was already reported is a late delivery, not a transition.
		if (job.revision < (reported.get(job.id)?.revision ?? 0)) return;
		for (const notice of loopTransitionNotices(reported.get(job.id), job)) emit(notice);
		reported.set(job.id, reportedOf(job));
	};
	const unsubscribe = jobs.subscribe((job) => {
		if (inFlight > 0) held.set(job.id, job);
		else settle(job);
	});
	for (const job of jobs.list()) reported.set(job.id, reportedOf(job));
	return {
		jobs: {
			list: () => jobs.list(),
			status: (id) => jobs.status(id),
			subscribe: (listener) => jobs.subscribe(listener),
			async invoke(args, options) {
				inFlight++;
				try {
					const result = await jobs.invoke(args, options);
					const job = jobFromResult(result);
					if (job !== null) {
						reported.set(job.id, reportedOf(job));
					}
					return result;
				} finally {
					inFlight--;
					if (inFlight === 0) {
						const pending = [...held.values()];
						held.clear();
						for (const job of pending) settle(job);
					}
				}
			},
		},
		dispose: unsubscribe,
	};
}
