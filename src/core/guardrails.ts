/**
 * Guardrail policy values: the numeric backstops that bound runaway agent
 * behavior (tool-call budgets, tool output byte caps, dispatch ledger size).
 *
 * These are durable operator policy, so their only configurable home is the
 * canonical version 2 settings tree. Composition roots project that tree into
 * this process through {@link configureGuardrails}; hot-path consumers resolve
 * the current projection through {@link resolveGuardrail} without reading
 * settings.yaml themselves.
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

/** Project canonical v2 settings leaves onto the process-local guardrail registry. */
export function guardrailValuesFromSettings(settings: {
	safety: {
		limits: {
			chatToolCallsPerTurn: number;
			readBytesPerCall: number;
			observationBytesPerTurn: number;
		};
	};
	fleet: {
		limits: { toolCallsPerRun: number; internalRunTimeoutMs: number };
		history: { maxRuns: number };
	};
}): GuardrailValues {
	return {
		turnToolCallBudget: settings.safety.limits.chatToolCallsPerTurn,
		workerToolCallCap: settings.fleet.limits.toolCallsPerRun,
		maxDispatchRuns: settings.fleet.history.maxRuns,
		readMaxBytes: settings.safety.limits.readBytesPerCall,
		observationTurnBudgetBytes: settings.safety.limits.observationBytesPerTurn,
		internalDispatchTimeoutMs: settings.fleet.limits.internalRunTimeoutMs,
	};
}

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
 * Install the effective settings projection. Later calls replace the whole
 * layer when a session override or configuration reload changes the view.
 */
export function configureGuardrails(values: Partial<GuardrailValues> | undefined): void {
	configured = { ...(values ?? {}) };
}

/** Resolve one guardrail from the effective settings projection or its default. */
export function resolveGuardrail(key: keyof GuardrailValues): number {
	return configured[key] ?? GUARDRAIL_DEFAULTS[key];
}
