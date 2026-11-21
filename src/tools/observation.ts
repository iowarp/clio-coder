import {
	GUARDRAIL_DEFAULTS,
	resolveGuardrail,
	resolveTemplateCeiling,
	templateBudgetLimit,
} from "../core/guardrails.js";
import { OBSERVATION_WIDTH_SCALE_CEILING } from "../core/turn-budget-width.js";
import { createSafetyPolicyEngine } from "../domains/safety/policy-engine.js";
import type { ImageContent } from "../engine/types.js";
import type { ObservationPoolEvent, ToolInvokeOptions, ToolResult } from "./registry.js";
import { toolResultContextText } from "./result-disposition.js";
import { offloadPointer, writeToolOffload } from "./result-shaping.js";
import { formatSize } from "./truncate.js";
import { byteLength } from "./truncate-utf8.js";

/**
 * Shared observation envelope for the OBSERVE plane (read, grep, find, ls,
 * code_nav, context). One result layer owns what every one of those tools
 * used to hand-roll separately:
 *
 *   - offload-on-truncation: any truncated observation spills its FULL
 *     rendering to the per-session scratch file and reports the path, so no
 *     collected match/path/line is ever unrecoverable;
 *   - exactly one notice line in one format, with an exact continuation call
 *     (`next: limit=200`), never prose;
 *   - a valid-JSON guarantee for format:"json" tools: an oversize payload is
 *     replaced by a parseable stub instead of being cut mid-document;
 *   - the per-turn observation budget (one pool per sessionId:turnId across
 *     all six tools) that used to live in read.ts and covered only read;
 *   - one details schema (`details.observation`) for the TUI ledger, session
 *     turns, and observers.
 */

export type ObservationUnit = "lines" | "matches" | "paths" | "entries" | "results" | "sections";
export type ObservationFormat = "text" | "json";

export interface ObservationBudgetDetails {
	limitBytes: number;
	usedBeforeBytes: number;
	exhausted: boolean;
}

export interface Observation {
	tool: string;
	unit: ObservationUnit;
	shownCount: number;
	/** null = unknown (search killed early at the limit); rendered as "N+". */
	totalCount: number | null;
	shownBytes: number;
	totalBytes: number;
	truncated: boolean;
	format: ObservationFormat;
	/** Exact continuation call fragment, e.g. `limit=200` or `offset=451`. */
	next?: string;
	offloadPath?: string;
	budget?: ObservationBudgetDetails;
}

// Per-tool self-caps, the single source the bootstrap metadata table derives
// its policy caps from (policy cap = self cap + OBSERVATION_POLICY_SLACK so a
// tool's own notice survives the registry backstop instead of being cut again).
export const OBSERVATION_POLICY_SLACK_BYTES = 2 * 1024;
export const OBSERVE_SELF_CAPS = {
	grepContent: 16 * 1024,
	grepFilesCount: 8 * 1024,
	find: 8 * 1024,
	ls: 8 * 1024,
	codeNav: 16 * 1024,
	contextDocs: 16 * 1024,
	contextSkills: 50 * 1024,
	contextWorkspace: 50 * 1024,
	// Library rows are metadata: name, owner, origin, availability, invocation.
	// A full page of 50 stays well inside this, and a smaller cap than the
	// skills catalog is what keeps a catalog read from crowding out the turn.
	contextLibrary: 16 * 1024,
} as const;

const MIN_BUDGET_SLICE_BYTES = 1024;
const BUDGET_TRACK_LIMIT = 256;

/**
 * How many exhausted-pool notices one turn gets before the next such call fails
 * terminally instead of returning a retryable notice.
 *
 * Smoke pass 2 (G2) watched a 9B local model re-issue the identical read about
 * twenty times against the same 208-byte notice, until the unrelated tool-call
 * budget stopped it. The notice cannot become un-retryable by wording alone: a
 * `kind:"ok"` result is an invitation to try again.
 *
 * Three is the smallest count that still lets a model learn the shape from the
 * notice itself. The pool is shared by six OBSERVE tools, so a model that reads,
 * then greps narrower, then lists, has spent three honest attempts at the advice
 * the notice gives. A fourth consecutive exhausted call is evidence the advice
 * is not landing, and it fails. Waste is bounded at four calls out of the 60-call
 * turn budget instead of twenty.
 */
const MAX_EXHAUSTED_NOTICES_PER_TURN = 3;

/**
 * `details.notExecuted` on an observation call the spent turn pool stopped before it ran (C-17). The result stays
 * `kind:"ok"` so the model reads the notice as it always has; `ToolFinishEvent.notExecuted` carries the type to
 * tool stats, which count the call withheld.
 */
export const OBSERVATION_BUDGET_NOT_EXECUTED = "observation_budget" as const;

interface TurnBudgetState {
	/** Bytes settled calls actually returned this turn. */
	usedBytes: number;
	/** Bytes in-flight sibling calls hold until they settle; never counted as returned. */
	reservedBytes: number;
	lastSeenAt: number;
	/** Consecutive tool batches with an exhausted-pool short-circuit; reset by any call that got a slice. */
	exhaustedStreak: number;
	/** The model response whose short-circuit last counted toward the streak, so its siblings count once (C-17). */
	exhaustedBatch: string | null;
}

const turnBudgets = new Map<string, TurnBudgetState>();

export interface ObservationReservation {
	/** null when the invocation carries no turn id (no budget tracking). */
	key: string | null;
	limitBytes: number;
	usedBeforeBytes: number;
	/** Bytes in-flight siblings held when this call reserved, apart from `usedBeforeBytes`. */
	reservedBeforeBytes: number;
	selfCapBytes: number;
	/** Effective byte cap for this call: min(self cap, requested range, remaining budget). */
	callCapBytes: number;
	/** True when the pool reduced this call's cap below what it asked for. */
	limited: boolean;
	exhausted: boolean;
	/**
	 * True once the call has charged its full cap to the pool up front (async
	 * tools, via commitObservationReservation) so concurrent siblings see it.
	 */
	committed: boolean;
	/** True once the charge has been reconciled or refunded exactly once. */
	settled: boolean;
	/** The prompt template whose `budget.observationBytes` set `limitBytes`, when one did. */
	template?: string;
	/** Which bound set `limitBytes` under a template budget, as notice text. */
	boundNote?: string;
	/**
	 * An exhausted pool in a turn a continuation follows: rolls the turn at its tool boundary (XR-6). In a headless run it
	 * marks the pool spent, so it rolls at the next tool batch while the turn runs on (CLI-P42).
	 */
	roll?: () => void;
	/**
	 * A headless run's tracker for this call (CLI-P42): told when the call returns and when that drains the pool. On an
	 * exhausted reservation it is present only when it did the rolling, and it counts that tool call's refusals.
	 */
	poolEvent?: (event: ObservationPoolEvent) => void;
	/** The model response this call belongs to (`ToolInvokeOptions.correlationId`); its siblings share one refusal count. */
	batch?: string;
}

/**
 * Refusals per headless tool call (CLI-P42). Each model tool call gets its own pool tracker, which a gateway chain passes
 * to every step it runs in turn, so a chain's sequential refusals escalate as one call's would; parallel siblings each
 * hold their own and are refused once.
 */
const callRefusals = new WeakMap<(event: ObservationPoolEvent) => void, number>();

// A `next` continuation is a compact call fragment (`limit=200`, `offset=451`).
// A tool that folds an input argument into it (`mode=path query=<arg>`) can grow
// it without bound when the argument is huge, and the JSON cap stub echoes it
// verbatim — turning a "result exceeded 16KB" placeholder into a 256KB payload.
// Bound the fragment so the stub, the notice line, and the observation envelope
// stay small; the offloaded full result is where the untruncated data lives.
const MAX_CONTINUATION_CHARS = 200;

function boundContinuation(next: string | undefined): string | undefined {
	if (next === undefined || next.length <= MAX_CONTINUATION_CHARS) return next;
	return `${Array.from(next).slice(0, MAX_CONTINUATION_CHARS).join("")}…`;
}

// The default pool follows the active window at 1.5 bytes per window token,
// about 37% of the window at four bytes a token. 128K is the smallest window
// real work assumes, so the pool never drops below the 192 KB that window gets,
// and it stops at 1 MB. A configured value other than the default is the
// operator's own choice and applies exactly. A wide-parallel route's default
// pool grows with its measured width, at most 1.5 times and still under 1 MB
// (`turn-budget-width.ts`).
const OBSERVATION_POOL_BYTES_PER_WINDOW_TOKEN = 1.5;
const OBSERVATION_POOL_CEILING_BYTES = 1024 * 1024;

function operatorObservationLimit(options?: ToolInvokeOptions): number {
	const configured = Math.max(MIN_BUDGET_SLICE_BYTES, resolveGuardrail("observationTurnBudgetBytes"));
	const window = options?.contextWindow;
	if (configured !== GUARDRAIL_DEFAULTS.observationTurnBudgetBytes || window === undefined || !(window > 0)) {
		return configured;
	}
	const width = Math.min(OBSERVATION_WIDTH_SCALE_CEILING, Math.max(1, options?.turnBudgetScale ?? 1));
	const scaled = Math.floor(window * OBSERVATION_POOL_BYTES_PER_WINDOW_TOKEN * width);
	return Math.min(OBSERVATION_POOL_CEILING_BYTES, Math.max(configured, scaled));
}

/**
 * The turn's pool under a prompt template's `budget.observationBytes`: the
 * smaller of that value and the larger of the operator's pool and
 * `safety.limits.templateObservationBytesPerTurnMax`, so a template lowers
 * the pool always and raises it only up to that ceiling. `bound` names what
 * set a template-bounded pool, for the budget notices (WTF-P 0.8.3 B4).
 */
function observationTurnBudgetLimit(options?: ToolInvokeOptions): {
	limitBytes: number;
	template?: string;
	boundNote?: string;
} {
	const operator = operatorObservationLimit(options);
	const budget = options?.turnConstraints?.budget;
	const templateBytes = budget?.observationBytes;
	if (templateBytes === undefined) return { limitBytes: operator };
	const ceiling = resolveTemplateCeiling("templateObservationTurnCeilingBytes");
	const { limit, bound } = templateBudgetLimit(templateBytes, operator, ceiling);
	const template = budget?.template && budget.template.length > 0 ? budget.template : "unnamed";
	if (bound === "operator")
		return {
			limitBytes: operator,
			boundNote: `, safety.limits.observationBytesPerTurn; prompt template "${template}" asked for ${templateBytes} bytes and safety.limits.templateObservationBytesPerTurnMax is unset`,
		};
	return {
		limitBytes: Math.max(MIN_BUDGET_SLICE_BYTES, limit),
		template,
		boundNote:
			bound === "ceiling"
				? `, safety.limits.templateObservationBytesPerTurnMax; prompt template "${template}" asked for ${templateBytes} bytes`
				: limit > operator
					? `, the budget.observationBytes of prompt template "${template}", raised within safety.limits.templateObservationBytesPerTurnMax`
					: `, the budget.observationBytes of prompt template "${template}"`,
	};
}

function budgetKey(options: ToolInvokeOptions | undefined): string | null {
	const turnId = options?.turnId?.trim();
	if (!turnId) return null;
	const sessionId = options?.sessionId?.trim() || "no-session";
	const epoch = options?.observationPoolEpoch ?? 0;
	return epoch > 0 ? `${sessionId}:${turnId}#${epoch}` : `${sessionId}:${turnId}`;
}

/**
 * A headless run's observation pool (CLI-P42). A headless `run` is one operator prompt that no next turn follows, so a
 * per-turn pool was a hard cap on what the whole run could read. Here a spent pool rolls to a fresh one at the next
 * tool batch: the refused calls are told to run again there, and the post-tool context guard and compaction still
 * bound the window. Attended turns never build one, so their per-turn pool is unchanged.
 */
export interface HeadlessObservationPool {
	/**
	 * The pool options for one tool call of the model response `batchId` names. A call outside any model response (a
	 * host or internal call) charges the current pool and never rolls it, so its refusals escalate as in any turn.
	 */
	invokeOptions(batchId: string | undefined): Pick<ToolInvokeOptions, "observationPoolEpoch" | "observationPoolEvent">;
	/**
	 * A new operator prompt: nothing pending from an earlier one. A later submit of the same host run (`runId`), such as
	 * an `--output-schema` repair turn, keeps the run's state, so its seal keeps the fact.
	 */
	reset(runId?: string): void;
	/** Whether the run's last observation calls were refused with no later call returning: what the run could not read. */
	stopped(): boolean;
}

export function createHeadlessObservationPool(): HeadlessObservationPool {
	let epoch = 0;
	// The batch whose calls spent the pool (a refusal, or a return that left less than a slice); a later batch rolls it.
	let spentIn: string | null = null;
	// The batch a refusal landed in: a sibling of that batch returning does not clear it.
	let refusedIn: string | null = null;
	let refused = false;
	let run: string | undefined;
	return {
		invokeOptions(batchId) {
			if (batchId === undefined) return epoch > 0 ? { observationPoolEpoch: epoch } : {};
			if (spentIn !== null && batchId !== spentIn) {
				epoch += 1;
				spentIn = null;
			}
			const callEpoch = epoch;
			return {
				...(epoch > 0 ? { observationPoolEpoch: epoch } : {}),
				observationPoolEvent: (event) => {
					if (event === "delivered") {
						if (refusedIn !== batchId) refused = false;
						return;
					}
					if (event === "refused") {
						refused = true;
						refusedIn = batchId;
					}
					if (spentIn === null && callEpoch === epoch) spentIn = batchId;
				},
			};
		},
		reset(runId) {
			if (runId !== undefined && runId === run) return;
			// A submit that names no host run (a steer or triage interrupt) leaves the run it interrupted tracked, so that
			// run's later repair turn still keeps what this one sets.
			if (runId !== undefined) run = runId;
			epoch = 0;
			spentIn = null;
			refusedIn = null;
			refused = false;
		},
		stopped: () => refused,
	};
}

function pruneBudgetMap(): void {
	while (turnBudgets.size > BUDGET_TRACK_LIMIT) {
		let oldestKey: string | null = null;
		let oldestSeen = Number.POSITIVE_INFINITY;
		for (const [key, state] of turnBudgets) {
			if (state.lastSeenAt >= oldestSeen) continue;
			oldestKey = key;
			oldestSeen = state.lastSeenAt;
		}
		if (oldestKey === null) break;
		turnBudgets.delete(oldestKey);
	}
}

/**
 * Reserve this call's slice of the turn pool. Call before doing the work so
 * an exhausted pool short-circuits via `observationBudgetExhausted` instead
 * of paying for a search whose output cannot be returned.
 *
 * `requestedBytes` lets a call that asked for a narrow range (a read with a
 * small line limit) hold only that much, so parallel siblings are not refused
 * against a worst-case reservation it can never fill.
 */
export function reserveObservation(
	selfCapBytes: number,
	options?: ToolInvokeOptions,
	requestedBytes?: number,
): ObservationReservation {
	const askBytes =
		requestedBytes !== undefined && requestedBytes > 0 ? Math.min(selfCapBytes, requestedBytes) : selfCapBytes;
	const key = budgetKey(options);
	const { limitBytes, template, boundNote } = observationTurnBudgetLimit(options);
	const bound = {
		...(template === undefined ? {} : { template }),
		...(boundNote === undefined ? {} : { boundNote }),
	};
	const poolEvent = options?.observationPoolEvent;
	const tracked = poolEvent === undefined ? {} : { poolEvent };
	if (key === null) {
		return {
			key,
			limitBytes,
			usedBeforeBytes: 0,
			reservedBeforeBytes: 0,
			selfCapBytes,
			callCapBytes: askBytes,
			limited: false,
			exhausted: false,
			committed: false,
			settled: false,
			...bound,
			...tracked,
		};
	}
	const state = turnBudgets.get(key) ?? {
		usedBytes: 0,
		reservedBytes: 0,
		lastSeenAt: Date.now(),
		exhaustedStreak: 0,
		exhaustedBatch: null,
	};
	state.lastSeenAt = Date.now();
	turnBudgets.set(key, state);
	pruneBudgetMap();
	const remaining = Math.max(0, limitBytes - state.usedBytes - state.reservedBytes);
	if (remaining < MIN_BUDGET_SLICE_BYTES) {
		const pooled = options?.turnBudgetContinues !== true && poolEvent !== undefined;
		const roll =
			options?.turnBudgetContinues === true
				? options.observationBudgetRoll
				: pooled
					? () => poolEvent("refused")
					: undefined;
		const batch = options?.correlationId;
		return {
			key,
			limitBytes,
			usedBeforeBytes: state.usedBytes,
			reservedBeforeBytes: state.reservedBytes,
			selfCapBytes,
			callCapBytes: 0,
			limited: true,
			exhausted: true,
			committed: false,
			settled: false,
			...bound,
			...(roll === undefined ? {} : { roll }),
			...(pooled ? { poolEvent } : {}),
			...(batch === undefined ? {} : { batch }),
		};
	}
	// A call that got a slice is progress, so the exhausted streak starts over.
	// Only an unbroken run of short-circuits reaches the terminal failure.
	state.exhaustedStreak = 0;
	state.exhaustedBatch = null;
	const callCapBytes = Math.min(askBytes, remaining);
	return {
		key,
		limitBytes,
		usedBeforeBytes: state.usedBytes,
		reservedBeforeBytes: state.reservedBytes,
		selfCapBytes,
		callCapBytes,
		limited: callCapBytes < askBytes,
		exhausted: false,
		committed: false,
		settled: false,
		...bound,
		...tracked,
	};
}

/**
 * Hold this call's cap in the shared pool up front so concurrent OBSERVE
 * siblings that reserve during an async call's in-flight window see it instead
 * of an empty pool. The hold is reserved, not returned: finalizeObservation
 * releases it and charges the bytes actually returned; releaseObservation
 * releases it on an error path. Only tools that await between reserving and
 * finalizing need this; synchronous tools settle within one microtask and
 * charge at finalize.
 */
export function commitObservationReservation(reservation: ObservationReservation): void {
	if (reservation.key === null || reservation.committed || reservation.settled) return;
	if (reservation.callCapBytes <= 0) return;
	reservation.committed = true;
	const state = turnBudgets.get(reservation.key) ?? {
		usedBytes: reservation.usedBeforeBytes,
		reservedBytes: reservation.reservedBeforeBytes,
		lastSeenAt: Date.now(),
		exhaustedStreak: 0,
		exhaustedBatch: null,
	};
	state.reservedBytes += reservation.callCapBytes;
	state.lastSeenAt = Date.now();
	turnBudgets.set(reservation.key, state);
}

/**
 * Grow a granted reservation toward `bytes` (never past its self cap) from what the pool has left (C-17). A read sized
 * from its file's stat learns only after opening the file that it renders an image, a document or a bundled doc's
 * index, whose size the stat does not bound. A pool short of the growth leaves the call limited, as at reservation.
 */
export function widenObservationReservation(reservation: ObservationReservation, bytes: number): void {
	if (reservation.exhausted || reservation.settled) return;
	const target = Math.min(reservation.selfCapBytes, bytes);
	if (target <= reservation.callCapBytes) return;
	if (reservation.key === null) {
		reservation.callCapBytes = target;
		return;
	}
	const state = turnBudgets.get(reservation.key);
	if (state === undefined) return;
	const remaining = Math.max(0, reservation.limitBytes - state.usedBytes - state.reservedBytes);
	const extra = Math.min(target - reservation.callCapBytes, remaining);
	reservation.callCapBytes += extra;
	if (reservation.committed) state.reservedBytes += extra;
	reservation.limited = reservation.callCapBytes < target;
	state.lastSeenAt = Date.now();
}

/**
 * Refund a committed reservation whose call bailed out before finalizing (an
 * error return between commit and finalize). A no-op once the call has settled
 * through finalizeObservation/observationBudgetExhausted, so a tool can call it
 * unconditionally from a finally block.
 */
export function releaseObservation(reservation: ObservationReservation): void {
	if (reservation.key === null || reservation.settled) return;
	reservation.settled = true;
	if (!reservation.committed) return;
	const state = turnBudgets.get(reservation.key);
	if (state === undefined) return;
	state.reservedBytes = Math.max(0, state.reservedBytes - reservation.callCapBytes);
	state.lastSeenAt = Date.now();
	turnBudgets.set(reservation.key, state);
}

function recordSpentBytes(reservation: ObservationReservation, bytes: number): void {
	if (reservation.key === null || reservation.settled) return;
	reservation.settled = true;
	// A committed call held its cap as a reservation so concurrent siblings could
	// see it; release the whole hold and charge only the bytes actually returned.
	// An uncommitted (synchronous) call charges its spend now, having touched the
	// pool nowhere else.
	const heldBytes = reservation.committed ? reservation.callCapBytes : 0;
	const state = turnBudgets.get(reservation.key) ?? {
		usedBytes: reservation.usedBeforeBytes,
		reservedBytes: reservation.reservedBeforeBytes + heldBytes,
		lastSeenAt: Date.now(),
		exhaustedStreak: 0,
		exhaustedBatch: null,
	};
	state.reservedBytes = Math.max(0, state.reservedBytes - heldBytes);
	state.usedBytes += bytes;
	state.lastSeenAt = Date.now();
	turnBudgets.set(reservation.key, state);
}

/**
 * What each tracked observation charged its turn pool, by the envelope its result carries, until the registry has
 * shaped the result for the model (C-17). A session cap (`context.toolResultMaxBytes`) or a disposition can cut a
 * result after its tool finalized it; the pool must pay for what the model received, not for what the tool rendered.
 */
const pendingCharges = new WeakMap<object, { reservation: ObservationReservation; chargedBytes: number }>();

function trackCharge(observation: Observation, reservation: ObservationReservation, chargedBytes: number): void {
	if (reservation.key !== null) pendingCharges.set(observation, { reservation, chargedBytes });
}

/**
 * Settle an observation's pool charge to the bytes of the shaped result the model receives (C-17): its context text
 * and any images it still carries. Called on every shaped result; one that carries no tracked envelope is left alone.
 * A charge only ever falls, so a result shaped twice (a gateway call's inner and outer pass) settles at the smaller.
 */
export function settleObservationCharge(result: ToolResult): void {
	const observation = result.details?.observation;
	if (observation === null || typeof observation !== "object") return;
	const pending = pendingCharges.get(observation);
	if (pending === undefined || pending.reservation.key === null) return;
	const images = result.kind === "ok" ? (result.images ?? []) : [];
	const delivered =
		byteLength(toolResultContextText(result)) + images.reduce((bytes, image) => bytes + byteLength(image.data), 0);
	if (delivered >= pending.chargedBytes) return;
	const state = turnBudgets.get(pending.reservation.key);
	if (state === undefined) return;
	state.usedBytes = Math.max(0, state.usedBytes - (pending.chargedBytes - delivered));
	state.lastSeenAt = Date.now();
	pending.chargedBytes = delivered;
}

function budgetDetails(reservation: ObservationReservation): ObservationBudgetDetails | null {
	if (reservation.key === null) return null;
	return {
		limitBytes: reservation.limitBytes,
		usedBeforeBytes: reservation.usedBeforeBytes,
		exhausted: reservation.exhausted,
	};
}

/**
 * Count this short-circuit against the turn's run of them. Siblings of one model response count once, so a wide batch
 * that meets a spent pool is one attempt, not four (C-17). Untracked calls never escalate.
 */
function bumpExhaustedStreak(key: string | null, batch: string | undefined): number {
	if (key === null) return 1;
	const state = turnBudgets.get(key);
	if (state === undefined) return 1;
	state.lastSeenAt = Date.now();
	if (batch !== undefined && batch === state.exhaustedBatch) return state.exhaustedStreak;
	state.exhaustedStreak += 1;
	state.exhaustedBatch = batch ?? null;
	turnBudgets.set(key, state);
	return state.exhaustedStreak;
}

function bumpCallRefusals(poolEvent: (event: ObservationPoolEvent) => void): number {
	const count = (callRefusals.get(poolEvent) ?? 0) + 1;
	callRefusals.set(poolEvent, count);
	return count;
}

/**
 * Structured result for a call that found the turn pool already spent.
 * `subject` names what the call was about (a path, a pattern); `hint` names
 * the narrowing arguments the tool supports.
 *
 * The first few such calls get the notice, which states the numbers and the
 * narrowing advice. Past MAX_EXHAUSTED_NOTICES_PER_TURN the call fails instead:
 * nothing this turn can return content, so an `ok` result is an invitation to a
 * retry loop the pool can never satisfy.
 */
export function observationBudgetExhausted(input: {
	tool: string;
	unit: ObservationUnit;
	/** Preserve parseable JSON for structured inspection tools, without offloading. */
	format?: ObservationFormat;
	reservation: ObservationReservation;
	subject: string;
	hint: string;
}): ToolResult {
	const { tool, unit, reservation, subject, hint } = input;
	const spent = `${poolSpent(reservation)} of ${formatSize(reservation.limitBytes)}${templateBound(reservation)}`;
	// A continuation follows: the turn rolls at this batch's tool boundary and the next turn has a fresh pool, so
	// the model is told the call waits for it instead of being asked to re-plan or summarize (XR-6).
	const rolled = reservation.roll !== undefined;
	reservation.roll?.();
	const streak = !rolled
		? bumpExhaustedStreak(reservation.key, reservation.batch)
		: reservation.poolEvent !== undefined
			? bumpCallRefusals(reservation.poolEvent)
			: 1;
	if (streak > MAX_EXHAUSTED_NOTICES_PER_TURN) {
		const attempt = !rolled && reservation.batch !== undefined ? "tool batch" : "call";
		const message =
			`observation budget exhausted for this turn before ${tool} ${subject}: ${spent}. ` +
			`This is the ${streak}th ${attempt} to hit it, so no observation tool can return content until the ` +
			`next turn. Do not retry this call and do not substitute another one. Re-plan with what you ` +
			`already have: say what you found, name what is still unread, and propose the next step.`;
		recordSpentBytes(reservation, byteLength(message));
		return { kind: "error", message };
	}
	const message = rolled
		? `observation budget for this turn is spent before ${tool} ${subject} (${spent}), so this call did not run. ` +
			`The turn continues automatically after this batch with a fresh budget; make this call again there.`
		: `observation budget exhausted for this turn before ${tool} ${subject}: ${spent}. ${hint}`;
	const output =
		input.format === "json"
			? JSON.stringify({ status: "unavailable", reason: "observation-budget-exhausted", message })
			: `[${message}]`;
	const shownBytes = byteLength(output);
	recordSpentBytes(reservation, shownBytes);
	const budget = budgetDetails(reservation);
	const observation: Observation = {
		tool,
		unit,
		shownCount: 0,
		totalCount: null,
		shownBytes,
		// The notice message is the whole rendering here (the search never ran), so
		// the full size is the message itself; keep totalBytes >= shownBytes.
		totalBytes: shownBytes,
		truncated: true,
		format: input.format ?? "text",
		...(budget !== null ? { budget } : {}),
	};
	trackCharge(observation, reservation, shownBytes);
	// The notice reaches the model as text, but the call did no work: tool stats count it withheld, not ok (C-17).
	return { kind: "ok", output, details: { observation, notExecuted: OBSERVATION_BUDGET_NOT_EXECUTED } };
}

export interface ObservationInput {
	images?: ImageContent[];
	withheldPaths?: number;
	tool: string;
	unit: ObservationUnit;
	format?: ObservationFormat;
	/** Shown body: item-limited and byte-capped by the tool, no notice yet. */
	output: string;
	/**
	 * Complete rendering, the offload source when truncated. Omit when the
	 * shown body already covers everything, or when the source is directly
	 * re-addressable (read continues via offset into the original file).
	 */
	fullOutput?: string;
	shownCount: number;
	totalCount: number | null;
	/** Bytes of the complete rendering; defaults to fullOutput/output size. */
	totalBytes?: number;
	truncated: boolean;
	next?: string;
	/**
	 * Suppress the appended notice when the body already carries its own
	 * explanation (read's oversized-line edge). The observation details still
	 * record the truncation; "exactly one notice line" stays true.
	 */
	omitNotice?: boolean;
	/** Extra details merged beside `observation` (the skill-activation contract). */
	details?: Record<string, unknown>;
	reservation: ObservationReservation;
	options?: ToolInvokeOptions;
}

function noticeLine(
	input: ObservationInput,
	bodyBytes: number,
	totalBytes: number,
	offloadPath: string | null,
	next: string | undefined,
): string {
	const totalSegment = input.totalCount === null ? `${input.shownCount}+` : String(input.totalCount);
	const parts = [
		`${input.tool}: ${input.shownCount}/${totalSegment} ${input.unit} shown (${formatSize(bodyBytes)} of ${formatSize(totalBytes)})`,
	];
	if (offloadPath !== null) parts.push(offloadPointer(offloadPath));
	if (next !== undefined && next.length > 0) parts.push(`next: ${next}`);
	return `[${parts.join(" | ")}]`;
}

/** Names the bound that set the pool under a template budget, so the refusal says where the limit came from. */
function templateBound(reservation: ObservationReservation): string {
	return reservation.boundNote ?? "";
}

/** Bytes already returned, and apart from them any bytes in-flight siblings still hold. */
function poolSpent(reservation: ObservationReservation): string {
	const returned = `${formatSize(reservation.usedBeforeBytes)} already returned`;
	return reservation.reservedBeforeBytes > 0
		? `${returned} and ${formatSize(reservation.reservedBeforeBytes)} reserved by sibling calls`
		: returned;
}

function limitedBudgetNote(reservation: ObservationReservation): string {
	return `[Per-turn observation budget: ${poolSpent(reservation)} of ${formatSize(
		reservation.limitBytes,
	)}${templateBound(reservation)} before this call. Use narrower arguments or continue in a follow-up turn for more content.]`;
}

/**
 * Budget directive carried inside the JSON cap stub when the shared pool (not
 * the tool's self cap) bounded this call. Retrying cannot succeed: every
 * further call this turn gets an equal or smaller cap, so the only productive
 * moves are answering from gathered content or continuing next turn. Without
 * this the stub reads as a transient size error and invites a retry spiral.
 */
function jsonStubBudgetNote(reservation: ObservationReservation): string {
	return (
		`per-turn observation budget nearly exhausted: ${poolSpent(reservation)} of ` +
		`${formatSize(reservation.limitBytes)} this turn. Do not retry this call; answer from ` +
		"what you have gathered, or continue in a follow-up turn."
	);
}

/**
 * A headless run's call that returned its result (CLI-P42): the run read something, and when what it returned left the
 * pool under one slice, the pool is spent and rolls at the next tool batch without waiting for a refusal. A call whose
 * reservation is refunded rather than finalized (consult's evidence files) reports here itself, after the refund.
 */
export function reportPoolDelivery(reservation: ObservationReservation): void {
	const poolEvent = reservation.poolEvent;
	if (poolEvent === undefined || reservation.exhausted) return;
	// A call that got its result breaks the run of refusals, as a granted slice resets a turn's streak.
	callRefusals.delete(poolEvent);
	poolEvent("delivered");
	if (reservation.key === null) return;
	const state = turnBudgets.get(reservation.key);
	if (state === undefined) return;
	if (reservation.limitBytes - state.usedBytes - state.reservedBytes < MIN_BUDGET_SLICE_BYTES) poolEvent("drained");
}

/**
 * Close out an observation: offload the full rendering when truncated, append
 * exactly one notice line (text) or substitute the parseable stub (json), and
 * charge the turn pool. Untruncated results get no notice.
 */
export function finalizeObservation(input: ObservationInput): ToolResult {
	const format = input.format ?? "text";
	let output = input.output;
	let truncated = input.truncated;
	let shownCount = input.shownCount;
	let offloadPath: string | null = null;
	const bodyBytes = byteLength(output);
	const totalBytes = input.totalBytes ?? byteLength(input.fullOutput ?? input.output);
	const next = boundContinuation(input.next);

	if (format === "json" && bodyBytes > input.reservation.callCapBytes) {
		// A JSON payload must parse or be replaced whole; never cut mid-document.
		// The stub shows nothing of the payload, so the envelope must say so
		// (shownCount 0), and when the shared pool bounded the call, the stub
		// carries the budget directive instead of a continuation that can never
		// fit this turn.
		truncated = true;
		shownCount = 0;
		offloadPath = writeToolOffload(input.fullOutput ?? output, input.options);
		const poolBound = input.reservation.limited;
		output = JSON.stringify({
			error: `result exceeded ${formatSize(input.reservation.callCapBytes)}`,
			...(poolBound ? { budget: jsonStubBudgetNote(input.reservation) } : {}),
			...(offloadPath !== null ? { offloadPath } : {}),
			...(!poolBound && next !== undefined && next.length > 0 ? { next } : {}),
		});
	} else if (truncated && input.fullOutput !== undefined) {
		offloadPath = writeToolOffload(input.fullOutput, input.options);
	}

	if (format === "text") {
		if (truncated && input.omitNotice !== true)
			output += `\n\n${noticeLine(input, bodyBytes, totalBytes, offloadPath, next)}`;
		if (input.reservation.limited && !input.reservation.exhausted) {
			output += `\n\n${limitedBudgetNote(input.reservation)}`;
		}
	}

	if ((input.withheldPaths ?? 0) > 0 && format === "text")
		output += `\n\n[${input.withheldPaths} protected paths withheld by zero-access policy]`;
	const shownBytes =
		byteLength(output) + (input.images ?? []).reduce((bytes, image) => bytes + byteLength(image.data), 0);
	recordSpentBytes(input.reservation, shownBytes);
	reportPoolDelivery(input.reservation);
	const budget = budgetDetails(input.reservation);
	const observation: Observation = {
		tool: input.tool,
		unit: input.unit,
		shownCount,
		totalCount: input.totalCount,
		shownBytes,
		// shownBytes counts the appended notice/limited-budget lines; totalBytes
		// measured only the pre-notice rendering (and equals it when a count-limited
		// tool like ls offloads nothing). Floor the full-rendering size at the bytes
		// actually returned so the envelope invariant totalBytes >= shownBytes holds.
		totalBytes: Math.max(totalBytes, shownBytes),
		truncated,
		format,
		...(next !== undefined && next.length > 0 ? { next } : {}),
		...(offloadPath !== null ? { offloadPath } : {}),
		...(budget !== null ? { budget } : {}),
	};
	trackCharge(observation, input.reservation, shownBytes);
	return {
		kind: "ok",
		output,
		...(input.images?.length ? { images: input.images } : {}),
		details: { ...(input.details ?? {}), observation },
	};
}

/** Producers pass structured paths before rendering or offloading any content. */
export function createObservationPathFilter(
	cwd = process.cwd(),
	allowsPath?: (path: string) => boolean,
): {
	allows(path: string): boolean;
	readonly withheldPaths: number;
} {
	const policy = allowsPath ? undefined : createSafetyPolicyEngine({ cwd });
	const allows = allowsPath ?? ((path: string) => policy?.readablePath(path) !== false);
	const withheld = new Set<string>();
	return {
		allows(path) {
			if (allows(path)) return true;
			withheld.add(path);
			return false;
		},
		get withheldPaths() {
			return withheld.size;
		},
	};
}
