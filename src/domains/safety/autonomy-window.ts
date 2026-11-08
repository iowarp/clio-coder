/**
 * The autonomous window (ob-yolo D6): how far yolo runs on its own before it
 * pauses for the operator. It counts tool calls, active turn time and tokens
 * since the operator last spoke, across every continuation Clio sends itself,
 * and latches a halt when one passes its cap or the safety judge escalates.
 * The latch holds until the operator speaks or resumes; until then every
 * automatic continuation is refused.
 *
 * Counting happens only while `caps()` is non-null, which the host makes true
 * at yolo alone. The window is in memory and per session: a new session, or a
 * new operator prompt, starts a fresh one.
 */

import { formatFooterTokens } from "../../core/display-units.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { ClassifierCall } from "./action-classifier.js";
import { describeCallTarget } from "./call-target.js";
import type { SafetyDecision } from "./contract.js";
import { redactSecretString } from "./redaction.js";

/** The `outcomeDetail` and abort reason prefix of a cap halt. */
export const AUTONOMOUS_CAP_REASON = "autonomous-cap";
/** The `outcomeDetail` and abort reason prefix of a judge-streak halt. */
export const JUDGE_STREAK_REASON = "judge-streak";
/** A headless run a cap paused exits as a spend ceiling does. */
export const AUTONOMOUS_CAP_EXIT_CODE = 4;
/** A headless run the judge's block streak ended exits as a permission refusal does. */
export const AUTONOMY_JUDGE_STREAK_EXIT_CODE = 3;

export type AutonomousCapKind = "calls" | "minutes" | "tokens";
export type AutonomyHaltKind = AutonomousCapKind | "judge";

/** Each cap is a positive limit or 0 for off. */
export interface AutonomousCaps {
	toolCalls: number;
	minutes: number;
	tokens: number;
}

export interface AutonomyUsage {
	toolCalls: number;
	activeMs: number;
	tokens: number;
}

export interface AutonomyHalt {
	kind: AutonomyHaltKind;
	/** The cap that tripped; absent for a judge streak. */
	limit?: number;
	/** One clause naming what stopped the run, for notices and summaries. */
	detail: string;
	usage: AutonomyUsage;
}

export type OpenDecisionKind = EventPayload<"autonomy.open_decision">["kind"];

/** A call yolo refused because it needed the operator (ob-yolo D7), kept for the end of the run. */
export interface OpenDecision {
	seq: number;
	tool: string;
	/** The command or target, clipped and with credentials scrubbed, as worker refusals name it. */
	command: string;
	kind: OpenDecisionKind;
	rule?: string;
}

/** Open decisions a session keeps; older ones are counted, not listed. */
export const OPEN_DECISION_LIMIT = 50;
const OPEN_DECISION_COMMAND_MAX_CHARS = 200;

/** The audit `run --json` and the exit summary read: the window, its halt and the open decisions. */
export interface AutonomyReport {
	confinement: "contained" | "unconfined";
	caps: AutonomousCaps;
	usage: AutonomyUsage;
	halted: { kind: AutonomyHaltKind; detail: string } | null;
	openDecisions: OpenDecision[];
	openDecisionsOmitted: number;
}

type AutonomyEventName =
	| "autonomy.entered"
	| "autonomy.open_decision"
	| "autonomy.cap_reached"
	| "autonomy.resumed"
	| "autonomy.ended";
export type AutonomyEmit = <K extends AutonomyEventName>(
	name: K,
	payload: EventPayload<K>,
	sessionId: string | null,
) => void;

/** What the footer shows of the window at yolo. */
export interface AutonomyStatus {
	usage: AutonomyUsage;
	caps: AutonomousCaps;
	halted: AutonomyHalt | null;
	/** Whether the main session's shell runs under an OS sandbox backend. */
	osSandbox: boolean;
}

export interface AutonomyWindow {
	/** One settled main-session tool call. */
	toolCall(): void;
	/** Tokens one settled main-session model call spent. */
	tokens(count: number): void;
	turnStarted(): void;
	turnSettled(): void;
	/** Halt for a reason outside the caps, the judge's escalation today. */
	haltFor(kind: "judge", detail: string): void;
	halted(): AutonomyHalt | null;
	/** The operator spoke or resumed: a fresh window, and the halt it cleared if any. */
	reopen(): AutonomyHalt | null;
	/** Usage so far, with the open turn's time included. */
	usage(): AutonomyUsage;
	/** The caps that apply now, or null when nothing is counted. */
	caps(): AutonomousCaps | null;
	/** A call refused because it needed the operator; ignored below yolo. */
	openDecision(entry: Omit<OpenDecision, "seq">): void;
	/** The session's open decisions; `sinceReopen` keeps those since the operator last spoke. */
	openDecisions(sinceReopen?: boolean): OpenDecision[];
	/** The audit so far, or null when yolo never ran in this session. */
	report(): AutonomyReport | null;
	/** The process is ending: journal how the yolo stretch ended. */
	end(): void;
}

export interface AutonomyWindowDeps {
	caps: () => AutonomousCaps | null;
	onHalt: (halt: AutonomyHalt) => void;
	/** The session the counts belong to; a change starts a fresh window. */
	session?: () => string | null;
	now?: () => number;
	confinement?: () => "contained" | "unconfined";
	/** Journals the `autonomy.*` events for the session they belong to. */
	emit?: AutonomyEmit;
}

const MINUTE_MS = 60_000;

export function createAutonomyWindow(deps: AutonomyWindowDeps): AutonomyWindow {
	const now = deps.now ?? (() => performance.now());
	let session: string | null = deps.session?.() ?? null;
	let toolCalls = 0;
	let tokens = 0;
	let activeMs = 0;
	let turnStart: number | null = null;
	let halt: AutonomyHalt | null = null;
	let entered = false;
	let seq = 0;
	let reopenedAt = 0;
	let omitted = 0;
	const decisions: OpenDecision[] = [];
	const emit: AutonomyEmit = (name, payload, sessionId) => deps.emit?.(name, payload, sessionId);
	const confinement = (): "contained" | "unconfined" => deps.confinement?.() ?? "contained";
	const ended = (reason: EventPayload<"autonomy.ended">["reason"], sessionId: string | null): void => {
		if (!entered) return;
		entered = false;
		emit("autonomy.ended", { reason, ...usage(), openDecisions: seq }, sessionId);
	};

	const clear = (): void => {
		toolCalls = 0;
		tokens = 0;
		activeMs = 0;
		turnStart = turnStart === null ? null : now();
		halt = null;
	};
	const follow = (): void => {
		if (deps.session === undefined) return;
		const current = deps.session();
		if (current === session) return;
		ended("session-changed", session);
		session = current;
		clear();
		decisions.length = 0;
		seq = reopenedAt = omitted = 0;
	};
	const usage = (): AutonomyUsage => ({
		toolCalls,
		tokens,
		activeMs: activeMs + (turnStart === null ? 0 : Math.max(0, now() - turnStart)),
	});
	const latch = (next: AutonomyHalt): void => {
		if (halt !== null) return;
		halt = next;
		emit(
			"autonomy.cap_reached",
			{
				kind: next.kind,
				...(next.limit !== undefined ? { limit: next.limit } : {}),
				...next.usage,
				openDecisions: seq,
			},
			session,
		);
		deps.onHalt(next);
	};
	const check = (caps: AutonomousCaps): void => {
		if (halt !== null) return;
		const used = usage();
		if (caps.toolCalls > 0 && used.toolCalls >= caps.toolCalls) {
			latch({ kind: "calls", limit: caps.toolCalls, detail: `${caps.toolCalls}-call cap`, usage: used });
		} else if (caps.tokens > 0 && used.tokens >= caps.tokens) {
			latch({ kind: "tokens", limit: caps.tokens, detail: `${formatFooterTokens(caps.tokens)}-token cap`, usage: used });
		} else if (caps.minutes > 0 && used.activeMs >= caps.minutes * MINUTE_MS) {
			latch({ kind: "minutes", limit: caps.minutes, detail: `${caps.minutes}-minute cap`, usage: used });
		}
	};
	const counting = (): AutonomousCaps | null => {
		follow();
		const caps = deps.caps();
		if (caps === null) ended("left-yolo", session);
		// Session-scoped events need their session; the first turn opens one.
		else if (!entered && session !== null) {
			entered = true;
			emit(
				"autonomy.entered",
				{ confinement: confinement(), capToolCalls: caps.toolCalls, capMinutes: caps.minutes, capTokens: caps.tokens },
				session,
			);
		}
		return caps;
	};

	return {
		toolCall() {
			const caps = counting();
			if (caps === null) return;
			toolCalls += 1;
			check(caps);
		},
		tokens(count) {
			const caps = counting();
			if (caps === null || !Number.isFinite(count) || count <= 0) return;
			tokens += count;
			check(caps);
		},
		turnStarted() {
			counting();
			if (turnStart === null) turnStart = now();
		},
		// Time accrues here but is checked at the next call event, so a pause
		// always cancels a running turn and never lands between turns.
		turnSettled() {
			follow();
			if (turnStart === null) return;
			if (deps.caps() !== null) activeMs += Math.max(0, now() - turnStart);
			turnStart = null;
		},
		haltFor(kind, detail) {
			if (counting() === null) return;
			latch({ kind, detail, usage: usage() });
		},
		halted() {
			follow();
			return deps.caps() === null ? null : halt;
		},
		reopen() {
			follow();
			const cleared = halt;
			clear();
			reopenedAt = seq;
			if (cleared !== null) emit("autonomy.resumed", { cleared: cleared.kind }, session);
			return cleared;
		},
		usage() {
			follow();
			return usage();
		},
		caps: () => counting(),
		openDecision(entry) {
			if (counting() === null) return;
			seq += 1;
			const recorded: OpenDecision = { ...entry, seq };
			decisions.push(recorded);
			if (decisions.length > OPEN_DECISION_LIMIT) {
				decisions.shift();
				omitted += 1;
			}
			emit(
				"autonomy.open_decision",
				{
					tool: recorded.tool,
					kind: recorded.kind,
					...(recorded.rule !== undefined ? { rule: recorded.rule } : {}),
					seq,
					command: recorded.command,
				},
				session,
			);
		},
		openDecisions(sinceReopen = false) {
			follow();
			return decisions.filter((entry) => !sinceReopen || entry.seq > reopenedAt);
		},
		report() {
			follow();
			const caps = deps.caps();
			if (caps === null && !entered && seq === 0) return null;
			return {
				confinement: confinement(),
				caps: caps ?? { toolCalls: 0, minutes: 0, tokens: 0 },
				usage: usage(),
				halted: halt === null ? null : { kind: halt.kind, detail: halt.detail },
				openDecisions: [...decisions],
				openDecisionsOmitted: omitted,
			};
		},
		end() {
			follow();
			ended(halt === null ? "shutdown" : halt.kind === "judge" ? "judge-streak" : "autonomous-cap", session);
		},
	};
}

/** Settings to caps: the window runs at yolo alone, contained or unconfined; all caps 0 still latches a judge halt. */
export function autonomousCaps(
	level: string,
	limits: { autonomousToolCalls: number; autonomousMinutes: number; autonomousTokens: number },
): AutonomousCaps | null {
	if (level !== "yolo") return null;
	return { toolCalls: limits.autonomousToolCalls, minutes: limits.autonomousMinutes, tokens: limits.autonomousTokens };
}

/** Tokens one settled call spent: the provider's total when it gave one, else input, cache and output. */
export function settledCallTokens(usage: unknown): number {
	if (usage === null || typeof usage !== "object") return 0;
	const value = (field: string): number => {
		const fact = (usage as Record<string, unknown>)[field];
		const n = fact !== null && typeof fact === "object" ? (fact as { value?: unknown }).value : undefined;
		return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
	};
	const total = value("total");
	return total > 0 ? total : value("input") + value("cacheRead") + value("cacheWrite") + value("output");
}

/** Name a refused call for the operator: clipped to 200 characters with credentials scrubbed, like a worker refusal. */
export function describeOpenDecision(
	call: ClassifierCall,
	decision: SafetyDecision,
	kind: OpenDecisionKind,
	rule?: string,
): Omit<OpenDecision, "seq"> {
	const raw = decision.policy?.command ?? describeCallTarget(call.tool, call.args);
	const scrubbed = redactSecretString(raw.trim());
	const clipped =
		scrubbed.length <= OPEN_DECISION_COMMAND_MAX_CHARS
			? scrubbed
			: `${scrubbed.slice(0, OPEN_DECISION_COMMAND_MAX_CHARS)}…`;
	const named =
		rule ??
		(decision.kind === "ask" ? decision.confirmationRuleId : undefined) ??
		decision.policy?.ruleId ??
		decision.policy?.reasonCode;
	return {
		tool: call.tool,
		command: clipped.length > 0 ? clipped : "(no command)",
		kind,
		...(named !== undefined ? { rule: named } : {}),
	};
}

/** One numbered line per open decision, for notices and summaries. */
function formatOpenDecision(entry: OpenDecision): string {
	return `${entry.seq}) ${entry.tool} \`${entry.command}\` (${entry.kind}${entry.rule !== undefined ? `, rule ${entry.rule}` : ""})`;
}

/** The decisions a halt notice lists, then how many it left out. */
function openDecisionsClause(open: ReadonlyArray<OpenDecision>, list: boolean): string {
	if (open.length === 0) return "";
	const noun = open.length === 1 ? "open decision" : "open decisions";
	if (!list) return ` ${open.length} ${noun} left for you.`;
	const shown = open.slice(-10);
	const more = open.length > shown.length ? `; ${open.length - shown.length} more` : "";
	return ` Left for you (${open.length} ${noun}): ${shown.map(formatOpenDecision).join("; ")}${more}.`;
}

/**
 * The pause notice: the interactive one names the keys, the headless one the command that resumes. A judge-streak
 * end lists the open decisions it leaves (ob-yolo D4); a cap counts them.
 */
export function autonomyHaltNotice(
	halt: AutonomyHalt,
	surface: "interactive" | "headless" = "interactive",
	open: ReadonlyArray<OpenDecision> = [],
): string {
	const left = openDecisionsClause(open, halt.kind === "judge");
	const used = halt.usage;
	const spent = `${used.toolCalls} tool calls, ${Math.round(used.activeMs / MINUTE_MS)} min, ${formatFooterTokens(used.tokens)} tokens`;
	if (surface === "headless") {
		const what =
			halt.kind === "judge"
				? `${JUDGE_STREAK_REASON}: the safety judge blocked too many calls (${halt.detail}), so yolo ended the run`
				: `${AUTONOMOUS_CAP_REASON}: yolo paused at the ${halt.detail}`;
		return `${what} after ${spent}; review it, then \`clio-coder run --continue "<prompt>"\` resumes with a fresh window${left === "" ? "" : `.${left}`}`;
	}
	if (halt.kind === "judge") {
		return `yolo paused: the safety judge blocked too many calls (${halt.detail}). Enter on an empty prompt continues and turns review back on; a new message also continues.${left}`;
	}
	const again =
		halt.kind === "calls"
			? `another ${halt.limit} calls`
			: halt.kind === "tokens"
				? `another ${formatFooterTokens(halt.limit ?? 0)} tokens`
				: `another ${halt.limit} minutes`;
	return `yolo paused: ${halt.detail} (${spent}). Enter on an empty prompt continues for ${again}; a new message also continues.${left}`;
}
