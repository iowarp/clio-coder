import { GUARDRAIL_DEFAULTS, GUARDRAIL_ENV_VARS, resolveGuardrail } from "../core/guardrails.js";
import type { ToolInvokeOptions, ToolResult } from "./registry.js";
import { writeToolOffload } from "./result-shaping.js";
import { formatSize } from "./truncate.js";

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
} as const;

// Per-turn observation budget pool. One pool per sessionId:turnId shared by
// every OBSERVE tool; LRU-pruned so abandoned turns cannot grow the map.
// Value, settings key, and env override live in core/guardrails.ts.
export const DEFAULT_OBSERVATION_TURN_BUDGET_BYTES = GUARDRAIL_DEFAULTS.observationTurnBudgetBytes;
export const OBSERVATION_TURN_BUDGET_ENV = GUARDRAIL_ENV_VARS.observationTurnBudgetBytes;
const MIN_BUDGET_SLICE_BYTES = 1024;
const BUDGET_TRACK_LIMIT = 256;

interface TurnBudgetState {
	usedBytes: number;
	lastSeenAt: number;
}

const turnBudgets = new Map<string, TurnBudgetState>();

export interface ObservationReservation {
	/** null when the invocation carries no turn id (no budget tracking). */
	key: string | null;
	limitBytes: number;
	usedBeforeBytes: number;
	selfCapBytes: number;
	/** Effective byte cap for this call: min(self cap, remaining budget). */
	callCapBytes: number;
	/** True when the pool reduced this call's cap below the self cap. */
	limited: boolean;
	exhausted: boolean;
	/**
	 * True once the call has charged its full cap to the pool up front (async
	 * tools, via commitObservationReservation) so concurrent siblings see it.
	 */
	committed: boolean;
	/** True once the charge has been reconciled or refunded exactly once. */
	settled: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

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

export function observationTurnBudgetLimit(env: NodeJS.ProcessEnv = process.env): number {
	return Math.max(MIN_BUDGET_SLICE_BYTES, resolveGuardrail("observationTurnBudgetBytes", env));
}

function budgetKey(options: ToolInvokeOptions | undefined): string | null {
	const turnId = options?.turnId?.trim();
	if (!turnId) return null;
	const sessionId = options?.sessionId?.trim() || "no-session";
	return `${sessionId}:${turnId}`;
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
 */
export function reserveObservation(selfCapBytes: number, options?: ToolInvokeOptions): ObservationReservation {
	const key = budgetKey(options);
	if (key === null) {
		return {
			key,
			limitBytes: observationTurnBudgetLimit(),
			usedBeforeBytes: 0,
			selfCapBytes,
			callCapBytes: selfCapBytes,
			limited: false,
			exhausted: false,
			committed: false,
			settled: false,
		};
	}
	const limitBytes = observationTurnBudgetLimit();
	const state = turnBudgets.get(key) ?? { usedBytes: 0, lastSeenAt: Date.now() };
	state.lastSeenAt = Date.now();
	turnBudgets.set(key, state);
	pruneBudgetMap();
	const remaining = Math.max(0, limitBytes - state.usedBytes);
	if (remaining < MIN_BUDGET_SLICE_BYTES) {
		return {
			key,
			limitBytes,
			usedBeforeBytes: state.usedBytes,
			selfCapBytes,
			callCapBytes: 0,
			limited: true,
			exhausted: true,
			committed: false,
			settled: false,
		};
	}
	const callCapBytes = Math.min(selfCapBytes, remaining);
	return {
		key,
		limitBytes,
		usedBeforeBytes: state.usedBytes,
		selfCapBytes,
		callCapBytes,
		limited: callCapBytes < selfCapBytes,
		exhausted: false,
		committed: false,
		settled: false,
	};
}

/**
 * Charge this call's full cap to the shared pool up front so concurrent OBSERVE
 * siblings that reserve during an async call's in-flight window see the running
 * spend instead of an empty pool. finalizeObservation reconciles the charge down
 * to the bytes actually returned; releaseObservation refunds it on an error
 * path. Only tools that await between reserving and finalizing need this;
 * synchronous tools settle within one microtask and charge at finalize.
 */
export function commitObservationReservation(reservation: ObservationReservation): void {
	if (reservation.key === null || reservation.committed || reservation.settled) return;
	if (reservation.callCapBytes <= 0) return;
	reservation.committed = true;
	const state = turnBudgets.get(reservation.key) ?? {
		usedBytes: reservation.usedBeforeBytes,
		lastSeenAt: Date.now(),
	};
	state.usedBytes += reservation.callCapBytes;
	state.lastSeenAt = Date.now();
	turnBudgets.set(reservation.key, state);
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
	state.usedBytes = Math.max(0, state.usedBytes - reservation.callCapBytes);
	state.lastSeenAt = Date.now();
	turnBudgets.set(reservation.key, state);
}

function recordSpentBytes(reservation: ObservationReservation, bytes: number): void {
	if (reservation.key === null || reservation.settled) return;
	reservation.settled = true;
	// A committed call already charged its full cap to the pool at reserve time
	// so concurrent siblings could see it; reconcile that down (or up) to the
	// bytes actually returned. An uncommitted (synchronous) call charges its
	// spend now, having touched the pool nowhere else.
	const committedBytes = reservation.committed ? reservation.callCapBytes : 0;
	const state = turnBudgets.get(reservation.key) ?? {
		usedBytes: reservation.usedBeforeBytes + committedBytes,
		lastSeenAt: Date.now(),
	};
	state.usedBytes = Math.max(0, state.usedBytes + bytes - committedBytes);
	state.lastSeenAt = Date.now();
	turnBudgets.set(reservation.key, state);
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
 * Structured result for a call that found the turn pool already spent.
 * `subject` names what the call was about (a path, a pattern); `hint` names
 * the narrowing arguments the tool supports.
 */
export function observationBudgetExhausted(input: {
	tool: string;
	unit: ObservationUnit;
	reservation: ObservationReservation;
	subject: string;
	hint: string;
}): ToolResult {
	const { tool, unit, reservation, subject, hint } = input;
	const output = `[observation budget exhausted for this turn before ${tool} ${subject}: ${formatSize(
		reservation.usedBeforeBytes,
	)} already returned of ${formatSize(reservation.limitBytes)}. ${hint}]`;
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
		format: "text",
		...(budget !== null ? { budget } : {}),
	};
	return { kind: "ok", output, details: { observation } };
}

export interface ObservationInput {
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
	if (offloadPath !== null) parts.push(`full: ${offloadPath}`);
	if (next !== undefined && next.length > 0) parts.push(`next: ${next}`);
	return `[${parts.join(" | ")}]`;
}

function limitedBudgetNote(reservation: ObservationReservation): string {
	return `[Per-turn observation budget: ${formatSize(reservation.usedBeforeBytes)} already returned of ${formatSize(
		reservation.limitBytes,
	)} before this call. Use narrower arguments or continue in a follow-up turn for more content.]`;
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
		`per-turn observation budget nearly exhausted: ${formatSize(reservation.usedBeforeBytes)} of ` +
		`${formatSize(reservation.limitBytes)} already returned this turn. Do not retry this call; answer from ` +
		"what you have gathered, or continue in a follow-up turn."
	);
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

	const shownBytes = byteLength(output);
	recordSpentBytes(input.reservation, shownBytes);
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
	return { kind: "ok", output, details: { ...(input.details ?? {}), observation } };
}
