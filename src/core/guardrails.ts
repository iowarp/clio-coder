/**
 * Guardrail policy values: the numeric backstops that bound runaway agent
 * behavior (tool-call budgets, tool output byte caps, dispatch ledger size).
 *
 * These are durable operator policy, the same species as
 * `compaction.threshold`, so their primary home is the `guardrails:` section
 * of settings.yaml. The composition roots (orchestrator entry and worker
 * runtime) wire that section in via {@link configureGuardrails}; consumers
 * resolve values through {@link resolveGuardrail}, which layers a per-process
 * env override on top for CI and one-off experiments:
 *
 *   env var  >  settings.yaml guardrails  >  built-in default
 *
 * Every value is a positive safe integer; invalid overrides fall through to
 * the next layer rather than erroring.
 */

export interface GuardrailValues {
	/**
	 * Orchestrator per-turn soft tool-call budget. Crossing it blocks every
	 * further call in the turn with a stop-and-summarize directive; the hard
	 * interrupt ceiling sits a fixed margin above it (see engine/loop-guard.ts).
	 * Sized as a backstop against a model spraying distinct unproductive calls,
	 * not as a routine ceiling: verbatim retry spirals are the identical-call
	 * detector's job, and legitimate deep work (a repo-wide audit) runs dozens
	 * of productive calls in one turn.
	 */
	turnToolCallBudget: number;
	/**
	 * Lifetime cap on tool calls a dispatched worker may execute. It bounds
	 * admitted calls, not attempts: a call the harness refuses (a reserve-window
	 * steering block, a synthesis-lockout denial) never ran and never spends the
	 * cap, because a worker must not be killed by the harness's own refusals.
	 * Attempts stay bounded by the loop-block budget and the synthesis backstop.
	 *
	 * Sized so a recipe's declared budget is what actually binds. A writer that
	 * produces a dozen files spends a call per file before a single grounding
	 * read, so a ceiling tuned for a reporting agent silently made whole classes
	 * of work impossible: `min(declared, cap)` in dispatch means the smaller of
	 * the two always wins, and only the recipe knows the shape of its job.
	 */
	workerToolCallCap: number;
	/** Dispatch run-ledger retention cap. */
	maxDispatchRuns: number;
	/** Per-call byte cap for the read tool (clamped to a 1KB floor at use). */
	readMaxBytes: number;
	/** Shared per-turn byte pool across all observation-producing tools. */
	observationTurnBudgetBytes: number;
	/**
	 * Wall-clock cap in milliseconds for one internal generator dispatch (the
	 * wiki documenter and the bootstrap scout). Backstop for a degenerate model
	 * that keeps streaming without finishing: continuous output satisfies the
	 * heartbeat watchdog, and a run mid-generation spends no tool calls, so
	 * neither existing guard ends it. Healthy runs finish in minutes; this is
	 * not a routine ceiling.
	 */
	internalDispatchTimeoutMs: number;
}

export const GUARDRAIL_DEFAULTS: GuardrailValues = {
	turnToolCallBudget: 60,
	workerToolCallCap: 150,
	maxDispatchRuns: 1000,
	readMaxBytes: 50 * 1024,
	observationTurnBudgetBytes: 192 * 1024,
	internalDispatchTimeoutMs: 15 * 60 * 1000,
};

/** Per-process env overrides, one per guardrail. */
export const GUARDRAIL_ENV_VARS: Readonly<Record<keyof GuardrailValues, string>> = {
	turnToolCallBudget: "CLIO_CODER_TURN_TOOL_CALL_BUDGET",
	workerToolCallCap: "CLIO_CODER_WORKER_TOOL_CALL_CAP",
	maxDispatchRuns: "CLIO_CODER_MAX_DISPATCH_RUNS",
	readMaxBytes: "CLIO_CODER_READ_MAX_BYTES",
	observationTurnBudgetBytes: "CLIO_CODER_OBSERVATION_TURN_BUDGET_BYTES",
	internalDispatchTimeoutMs: "CLIO_CODER_INTERNAL_DISPATCH_TIMEOUT_MS",
};

/**
 * Older env spellings that still read. `CLIO_CODER_MAX_RUNS` was the only
 * guardrail whose variable was not the SCREAMING_SNAKE of its key, and CI
 * environments already set it, so it keeps working behind the canonical name.
 */
const GUARDRAIL_ENV_ALIASES: Readonly<Partial<Record<keyof GuardrailValues, string>>> = {
	maxDispatchRuns: "CLIO_CODER_MAX_RUNS",
};

/**
 * One-shot annotation attached to the first tool result inside the reserve
 * window. Advisory: the call that carried it still ran; only subsequent
 * non-read calls are blocked.
 */
export function workerSynthesisReserveDirective(remaining: number, cap: number): string {
	return (
		`budget reserve: only ${remaining} of your ${cap} tool calls remain, and they are reserved for verification ` +
		"reads and synthesis. Stop broad exploration now: re-read the locations you will cite, then answer in prose. " +
		"Calls that are not reads will be blocked."
	);
}

/**
 * Block reason for a non-read call inside the reserve window. Deliberately
 * does NOT start with the `workerToolCallCap reached (` machine prefix:
 * reserve blocks are steering, not cap exhaustion, and must never trip
 * {@link mentionsWorkerToolCallCap} or the worker abort predicates.
 */
export function workerSynthesisReserveBlockReason(tool: string, remaining: number, cap: number): string {
	return (
		`workerToolCallReserve: only ${remaining} of ${cap} tool calls remain and they are reserved for verification ` +
		`reads and synthesis; ${tool} is not a read. Re-read any locations you will cite, then answer in prose from ` +
		"what you have gathered."
	);
}

export function isWorkerSynthesisReserveBlockReason(reason: string): boolean {
	return /^workerToolCallReserve: only [1-9]\d* of [1-9]\d* tool calls remain/.test(reason);
}

export function workerToolCallCapExceededReason(cap: number): string {
	return `workerToolCallCap reached (${cap}); abort run`;
}

export function isWorkerToolCallCapExceededReason(reason: string): boolean {
	return /^workerToolCallCap reached \([1-9]\d*\); abort run$/.test(reason);
}

/**
 * Cap-exhaustion synthesis directive. Emitted instead of the abort reason when
 * the loop guard runs with the synthesis lockout (dispatched workers): the run
 * gets one bounded text-only opportunity to report from what it gathered
 * before the backstop ends it. The prefix keeps the cap telemetry recognizable
 * in receipts and stderr diagnostics.
 */
export function workerToolCallCapSynthesisReason(cap: number): string {
	return (
		`workerToolCallCap reached (${cap}); tool calls are now disabled for the rest of this run. ` +
		"Everything you retrieved is already in the conversation above. Answer the operator now, in plain prose, " +
		"from what you have gathered. Do not write tool-call markup such as <tool_call> blocks; tool calls are " +
		"disabled and will not run."
	);
}

export function isWorkerToolCallCapSynthesisReason(reason: string): boolean {
	return /^workerToolCallCap reached \([1-9]\d*\); tool calls are now disabled/.test(reason);
}

/**
 * True when a receipt diagnostic (failureMessage/outcomeDetail) embeds the
 * cap telemetry prefix. Unlike the anchored predicates above this matches
 * anywhere in the text, because worker diagnostics merge the reason into a
 * larger machine-written string. It is deliberately keyed on the guard's own
 * prefix, never on free-form worker prose.
 */
export function mentionsWorkerToolCallCap(text: string | null | undefined): boolean {
	return typeof text === "string" && /workerToolCallCap reached \([1-9]\d*\)/.test(text);
}

let configured: Partial<GuardrailValues> = {};

/**
 * Install the settings.yaml `guardrails:` section. Called once per process by
 * the composition roots; later calls replace the whole layer (used by tests).
 */
export function configureGuardrails(values: Partial<GuardrailValues> | undefined): void {
	configured = { ...(values ?? {}) };
}

function parsePositiveSafeInt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const normalized = raw.trim();
	if (!/^[1-9]\d*$/.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Resolve one guardrail: env override > configured settings > default. */
export function resolveGuardrail(key: keyof GuardrailValues, env: NodeJS.ProcessEnv = process.env): number {
	const alias = GUARDRAIL_ENV_ALIASES[key];
	return (
		parsePositiveSafeInt(env[GUARDRAIL_ENV_VARS[key]]) ??
		(alias ? parsePositiveSafeInt(env[alias]) : undefined) ??
		configured[key] ??
		GUARDRAIL_DEFAULTS[key]
	);
}
