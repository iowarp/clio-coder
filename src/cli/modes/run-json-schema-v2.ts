/**
 * Headless run output, schema v2 (`run --output-format text|json|stream-json`).
 *
 * v1 (`--json`, `--json-events`) stays frozen in `run-json-schema.ts`. v2 adds a
 * typed result envelope as the last frame, a `causes[]` list in place of one
 * failure string, per-check verify states, and an exit code chosen by one
 * precedence function. An absent value is an absent key: v2 never sends `null`
 * for an optional field.
 */
import type { RunCallUsage } from "../../domains/dispatch/run-call-usage.js";
import type { RunResult } from "../../domains/dispatch/types.js";
import { EXIT_CODES } from "../kit/exit-codes.js";
import type { RunJsonDispatchedRunOutcome, RunJsonVerifyResult } from "./run-json-schema.js";

export const RUN_RESULT_SCHEMA_VERSION = 2;

/**
 * Every cause code, in precedence order. The first fact present sets the exit code; `causes[]` lists every fact,
 * winner first. `not_started` covers a request refused before any work (usage, configuration, admission), and
 * `run_failed` a failure no narrower code names.
 */
const CAUSE_ORDER = [
	"interrupted",
	"deadline",
	"reader_closed",
	"not_started",
	"unscripted",
	"permission_required",
	"judge_streak",
	"session_cost_ceiling",
	"max_cost_usd",
	"autonomous_cap",
	"max_requests",
	"max_tool_calls",
	"provider_error",
	"no_answer",
	"output_limit",
	"schema_mismatch",
	"verify_failed",
	"quality_failed",
	"verdict_failed",
	"noop",
	"limitation",
	"dispatched_worker_failed",
	"worker_failed",
	"output_write_failed",
	"run_failed",
] as const;

export type RunCauseCode = (typeof CAUSE_ORDER)[number];

/** One fact about how the run ended: its code, an optional message, and the payload its code names. */
export type RunCause = { readonly code: RunCauseCode; readonly message?: string } & Readonly<Record<string, unknown>>;

/** A second signal forced the exit: its code wins and no payload is written. */
export interface RunForcedExitFact {
	readonly code: "forced_exit";
	readonly exitCode: number;
}

export type RunExitFact = RunCause | RunForcedExitFact;

export type RunOutcomeV2 = "succeeded" | "failed" | "canceled" | "timed_out" | "previewed" | "displayed";

export interface RunExitResolution {
	exitCode: number;
	outcome: RunOutcomeV2;
	causes: RunCause[];
}

const SIGNAL_EXIT: Readonly<Record<string, number>> = {
	SIGHUP: EXIT_CODES.sighup,
	SIGINT: EXIT_CODES.sigint,
	SIGTERM: EXIT_CODES.sigterm,
};

/** The signal name a coordinated shutdown's exit code stands for; null for any other code. */
export function signalForExitCode(code: number): "SIGHUP" | "SIGINT" | "SIGTERM" | null {
	if (code === EXIT_CODES.sighup) return "SIGHUP";
	if (code === EXIT_CODES.sigint) return "SIGINT";
	if (code === EXIT_CODES.sigterm) return "SIGTERM";
	return null;
}

function exitCodeFor(cause: RunCause): number {
	switch (cause.code) {
		case "interrupted":
			return SIGNAL_EXIT[String(cause.signal)] ?? EXIT_CODES.sigterm;
		case "deadline":
			return EXIT_CODES.deadline;
		case "reader_closed":
			return EXIT_CODES.readerClosed;
		case "not_started":
			return EXIT_CODES.notStarted;
		case "unscripted":
			return EXIT_CODES.inputRequired;
		case "permission_required":
		case "judge_streak":
			return EXIT_CODES.approvalRequired;
		case "session_cost_ceiling":
		case "max_cost_usd":
		case "autonomous_cap":
		case "max_requests":
		case "max_tool_calls":
			return EXIT_CODES.limitReached;
		default:
			return EXIT_CODES.failed;
	}
}

/**
 * The 6.5 precedence table as one function: every fact that holds goes in, the exit code of the highest row and the
 * causes ordered winner first come out. A display-only run with no fact ends `displayed`.
 */
export function resolveRunExit(
	facts: ReadonlyArray<RunExitFact>,
	options: { displayed?: boolean } = {},
): RunExitResolution {
	const rank = (code: RunCauseCode): number => CAUSE_ORDER.indexOf(code);
	const causes = facts
		.filter((fact): fact is RunCause => fact.code !== "forced_exit")
		.map((cause, index) => ({ cause, index }))
		.sort((a, b) => rank(a.cause.code) - rank(b.cause.code) || a.index - b.index)
		.map(({ cause }) => cause);
	const forced = facts.find((fact): fact is RunForcedExitFact => fact.code === "forced_exit");
	const winner = causes[0];
	const exitCode = forced?.exitCode ?? (winner === undefined ? EXIT_CODES.success : exitCodeFor(winner));
	const outcome: RunOutcomeV2 =
		winner === undefined
			? forced !== undefined
				? "canceled"
				: options.displayed === true
					? "displayed"
					: "succeeded"
			: winner.code === "interrupted"
				? "canceled"
				: winner.code === "deadline"
					? "timed_out"
					: "failed";
	return { exitCode, outcome, causes };
}

export type RunVerifyStatus = "passed" | "failed" | "timed_out" | "skipped";
export type RunVerifySkipReason = "interrupted" | "deadline" | "turn_failed";

export interface RunVerifyCheckV2 {
	id?: string;
	command: string;
	status: RunVerifyStatus;
	reason?: RunVerifySkipReason;
	exitCode?: number;
	durationMs?: number;
	ranAfterLastEdit?: boolean;
}

/**
 * One entry per requested check, in flag order. Checks run in that order and stop at a shutdown, so the results are a
 * prefix of the requested list; a check past it never ran and is `skipped` with the reason it did not.
 */
export function verifyChecksV2(
	requested: ReadonlyArray<string>,
	ran: ReadonlyArray<RunJsonVerifyResult> | undefined,
	skipReason: RunVerifySkipReason,
): RunVerifyCheckV2[] {
	return requested.map((command, index) => {
		const result = ran?.[index];
		if (result === undefined) return { command, status: "skipped", reason: skipReason };
		return {
			id: result.id,
			command: result.command,
			status: result.passed ? "passed" : result.timedOut ? "timed_out" : "failed",
			...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
			durationMs: result.durationMs,
			ranAfterLastEdit: result.ranAfterLastEdit,
		};
	});
}

/** `stream-json` only: one frame per steer-channel line read before the turn settled. */
export interface RunSteerFrameV2 {
	type: "steer";
	line: number;
	status: "accepted" | "refused";
	reason?: string;
}

/** What a main run hands the v2 writer once its turn settled, or once a shutdown sealed it. */
export interface MainRunSettlementV2 {
	runId: string;
	startedAt: string;
	endedAt: string;
	sessionId?: string;
	route?: { target?: string; model?: string };
	/** The answer exactly as text mode prints it, without the trailing newline; empty when there is none. */
	text: string;
	facts: RunExitFact[];
	verify: { requested: number; checks: RunVerifyCheckV2[] };
	tools?: { calls: number; refused: number; writes: number };
	safety: {
		decisions: { allowed: number; blocked: number; guardBlocked: number; permissionRequested: number };
		blockedAttempts: unknown[];
	};
	usage?: RunCallUsage;
	dispatch: { live: RunJsonDispatchedRunOutcome[]; undelivered: RunJsonDispatchedRunOutcome[] };
}

/** What a `run --agent` hands the v2 writer: the sealed receipt, or the failure that left none. */
export interface AgentRunSettlementV2 {
	receipt?: RunResult;
	answer?: string;
	facts: RunExitFact[];
}

/**
 * A run's spend, each part folded from the session telemetry the way the run ledger folds it: `main` is the run's own
 * turn and compaction calls, `children` the dispatched workers' calls (absent when none were recorded), `total` both.
 */
export interface RunUsageV2 {
	main: RunCallUsage;
	children?: RunCallUsage;
	/** Absent only when a fold over both parts could not be read beside the children's own. */
	total?: RunCallUsage;
}

export interface RunResultEnvelopeV2 {
	type: "run_end";
	schemaVersion: typeof RUN_RESULT_SCHEMA_VERSION;
	mode: "main" | "agent";
	runId?: string;
	sessionId?: string;
	agentId?: string;
	pid: number;
	cwd: string;
	clioCoderVersion: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	exitCode: number;
	outcome: RunOutcomeV2;
	outcomeDetail?: RunCauseCode;
	causes: RunCause[];
	result: { text: string; artifacts: string[] };
	route?: { target?: string; model?: string };
	usage?: RunUsageV2;
	tools?: { calls: number; refused: number; writes: number };
	safety?: MainRunSettlementV2["safety"];
	verify: MainRunSettlementV2["verify"];
	dispatch: {
		runs: RunResult[];
		live: RunJsonDispatchedRunOutcome[];
		undelivered: RunJsonDispatchedRunOutcome[];
	};
	timings: { sessionReadyMs?: number; firstRequestMs?: number; firstTokenMs?: number };
}
