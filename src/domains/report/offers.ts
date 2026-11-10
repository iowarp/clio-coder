import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import type { FailureCause } from "../../core/telemetry/enums.js";
import { type CrashRecord, crashFingerprint, crashSite } from "./crash.js";
import { reportFingerprint } from "./fingerprint.js";
import { reportsDirectory } from "./store.js";

/**
 * When Clio may suggest a report. The host keeps the budget, never the model: one offer a session, one a week, never
 * again for a fingerprint the operator declined, never in the install's first session, and only to an attended
 * operator between turns.
 */

export type ReportOffersSetting = "ask" | "off";

export interface OfferLedger {
	version: 1;
	lastOfferAt: string | null;
	/** The session the last offer was made in, so a second candidate in it is refused. */
	lastOfferSession: string | null;
	declined: Record<string, string>;
	/** When the previous interactive session started; a crash written after it is offered at the next boot. */
	lastStartAt: string | null;
}

export interface OfferCandidate {
	trigger: "internal" | "crash" | "repeated";
	cause: string;
	fingerprint: string;
	/** The notification text. */
	text: string;
	crash?: CrashRecord;
}

export interface OfferSession {
	id: string;
	offers: ReportOffersSetting;
	ledger: OfferLedger;
	turnRunning: boolean;
	/** False when the operator is away at yolo, or the surface is headless. */
	attended: boolean;
	firstSession: boolean;
}

export type OfferRefusal =
	| "setting-off"
	| "first-session"
	| "offered-this-session"
	| "within-seven-days"
	| "declined"
	| "turn-running"
	| "away";

/** Refusals a candidate can outlive: it waits for the next idle, attended moment in the same session. */
export const WAITING_REFUSALS: ReadonlySet<OfferRefusal> = new Set(["turn-running", "away"]);

export const OFFER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** The first rule a candidate fails, or null when it may be offered now. The waiting rules are checked last. */
export function offerRefusal(candidate: Pick<OfferCandidate, "fingerprint">, now: number, session: OfferSession) {
	const { ledger } = session;
	let refusal: OfferRefusal | null = null;
	if (session.offers !== "ask") refusal = "setting-off";
	else if (session.firstSession) refusal = "first-session";
	else if (ledger.lastOfferSession === session.id) refusal = "offered-this-session";
	else if (ledger.lastOfferAt !== null && now - Date.parse(ledger.lastOfferAt) < OFFER_INTERVAL_MS)
		refusal = "within-seven-days";
	else if (Object.hasOwn(ledger.declined, candidate.fingerprint)) refusal = "declined";
	else if (session.turnRunning) refusal = "turn-running";
	else if (!session.attended) refusal = "away";
	return refusal;
}

export function mayOffer(candidate: Pick<OfferCandidate, "fingerprint">, now: number, session: OfferSession): boolean {
	return offerRefusal(candidate, now, session) === null;
}

function offerLedgerPath(stateDir: string): string {
	return join(reportsDirectory(stateDir), "offers.json");
}

export function emptyOfferLedger(): OfferLedger {
	return { version: 1, lastOfferAt: null, lastOfferSession: null, declined: {}, lastStartAt: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** The ledger on disk, or null when it was never written. A damaged ledger reads as a fresh one. */
function readLedgerFile(path: string): OfferLedger | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (!isRecord(value) || value.version !== 1) return emptyOfferLedger();
		const declined: Record<string, string> = {};
		if (isRecord(value.declined))
			for (const [fingerprint, at] of Object.entries(value.declined))
				if (typeof at === "string") declined[fingerprint] = at;
		return {
			version: 1,
			lastOfferAt: stringOrNull(value.lastOfferAt),
			lastOfferSession: typeof value.lastOfferSession === "string" ? value.lastOfferSession : null,
			declined,
			lastStartAt: stringOrNull(value.lastStartAt),
		};
	} catch {
		return emptyOfferLedger();
	}
}

export function readOfferLedger(stateDir: string): OfferLedger {
	return readLedgerFile(offerLedgerPath(stateDir)) ?? emptyOfferLedger();
}

function updateLedger<T>(stateDir: string, change: (ledger: OfferLedger, existed: boolean) => T): T {
	const path = offerLedgerPath(stateDir);
	return withStateFileLockSync(path, () => {
		const stored = readLedgerFile(path);
		const ledger = stored ?? emptyOfferLedger();
		const result = change(ledger, stored !== null);
		safeResourceWrite(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
		return result;
	});
}

let processFirstSession = false;

/** Whether this process's interactive session is the install's first; false until a start was recorded. */
export function isFirstSession(): boolean {
	return processFirstSession;
}

/**
 * Note an interactive session's start. Returns whether it is the install's first (no ledger yet) and when the
 * previous one started, which bounds the crash records the boot check reads.
 */
export function recordSessionStart(
	stateDir: string,
	now: Date,
): { firstSession: boolean; previousStartAt: string | null } {
	const start = updateLedger(stateDir, (ledger, existed) => {
		const previousStartAt = ledger.lastStartAt;
		ledger.lastStartAt = now.toISOString();
		return { firstSession: !existed, previousStartAt };
	});
	processFirstSession = start.firstSession;
	return start;
}

/** An offer was shown: it spends the week's and the session's budget. */
export function recordOfferShown(stateDir: string, sessionId: string, now: Date): void {
	updateLedger(stateDir, (ledger) => {
		ledger.lastOfferAt = now.toISOString();
		ledger.lastOfferSession = sessionId;
	});
}

/**
 * The operator's no. `declined` keeps the fingerprint from ever being offered again; `never` also writes
 * `report.offers: off` through `writeOffersOff`, which the caller supplies so this module never loads settings.
 */
export function recordAnswer(
	stateDir: string,
	fingerprint: string,
	answer: "declined" | "never",
	options: { now?: Date; writeOffersOff?: () => void } = {},
): void {
	const at = (options.now ?? new Date()).toISOString();
	updateLedger(stateDir, (ledger) => {
		ledger.declined[fingerprint] = at;
	});
	if (answer === "never") options.writeOffersOff?.();
}

/** Failure causes that are never Clio's own fault to report: the provider's, the network's, the operator's. */
export const NEVER_OFFER_CAUSES: ReadonlySet<FailureCause> = new Set<FailureCause>([
	"auth_rejected",
	"auth_refresh_failed",
	"transport_connect",
	"transport_dropped",
	"provider_4xx",
	"provider_5xx",
	"rate_limited",
	"usage_limit_reached",
	"context_overflow",
	"tool_choice_rejected",
	"operator_cancel",
	"parent_cancel",
	"route_moved",
	"budget_wait_aborted",
	"admission_refused",
]);

const REPEAT_THRESHOLD = 3;
const COMPACTION_FAILURE_LIMIT = 3;
const OFFER_TAIL = "/report shows exactly what a report would send, and nothing leaves without your say.";

/** A crash's error name becomes the report block's `cause` unscrubbed, so only a plain word passes. */
const CRASH_CAUSE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u;

/** The candidate for a crash written since the previous start. */
export function crashCandidate(record: CrashRecord): OfferCandidate {
	const cause = CRASH_CAUSE.test(record.name) ? record.name : "unknown";
	return {
		trigger: "crash",
		cause,
		fingerprint: crashFingerprint(record),
		text: `Clio crashed last time (${cause} in ${crashSite(record)}). If you'd like to help fix it, ${OFFER_TAIL}`,
		crash: record,
	};
}

/**
 * The per-session trigger table. Each method takes one bus fact and returns a candidate the first time that fact
 * qualifies, else null. Tool failures and failing checks in the workspace never reach it.
 */
export function createOfferTriggers(version: string) {
	const causes = new Map<string, number>();
	let domainOffered = false;
	let compactionFailures = 0;
	let compactionOffered = false;
	return {
		turnSettled(cause: FailureCause | null): OfferCandidate | null {
			if (cause === null) return null;
			const seen = (causes.get(cause) ?? 0) + 1;
			causes.set(cause, seen);
			if (cause === "internal")
				return seen === 1
					? {
							trigger: "internal",
							cause,
							fingerprint: reportFingerprint({ trigger: "internal", cause, version }),
							text: `Clio stopped on an internal error (that one is on Clio, not you). If you'd like to help fix it, ${OFFER_TAIL}`,
						}
					: null;
			if (NEVER_OFFER_CAUSES.has(cause) || seen !== REPEAT_THRESHOLD) return null;
			return {
				trigger: "repeated",
				cause,
				fingerprint: reportFingerprint({ trigger: "repeated", cause, version }),
				text: `${REPEAT_THRESHOLD} turns this session ended on ${cause}. If that looks like Clio's fault, ${OFFER_TAIL}`,
			};
		},
		domainFailed(name: string): OfferCandidate | null {
			if (domainOffered) return null;
			domainOffered = true;
			const cause = `domain_failed_${name.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 24)}`;
			return {
				trigger: "internal",
				cause,
				fingerprint: reportFingerprint({ trigger: "internal", cause, version }),
				text: `Part of Clio (${name}) failed to start. If you'd like to help fix it, ${OFFER_TAIL}`,
			};
		},
		compactionSettled(outcome: string): OfferCandidate | null {
			if (outcome === "committed") compactionFailures = 0;
			if (outcome !== "failed") return null;
			if (++compactionFailures < COMPACTION_FAILURE_LIMIT || compactionOffered) return null;
			compactionOffered = true;
			const cause = "compaction_paused";
			return {
				trigger: "internal",
				cause,
				fingerprint: reportFingerprint({ trigger: "internal", cause, version }),
				text: `Automatic compaction failed ${COMPACTION_FAILURE_LIMIT} times in a row. If you'd like to help fix it, ${OFFER_TAIL}`,
			};
		},
	};
}

export type OfferTriggers = ReturnType<typeof createOfferTriggers>;

/** The one stderr line a headless run prints after a turn ended on Clio Coder's own fault. */
export const HEADLESS_OFFER_LINE =
	"clio-coder: this looks like a Clio Coder fault; `clio-coder report --last` shows what a report would send";

export interface HeadlessOfferInput {
	stateDir: string;
	sessionId: string | null;
	offers: ReportOffersSetting;
	mode: "json" | "text";
	env: NodeJS.ProcessEnv;
	now: Date;
}

/**
 * Whether a headless run that hit an internal fault prints the offer line, and records it when it does. CI, JSON
 * output, the setting off, or an offer inside the last seven days keep the run quiet.
 */
export function takeHeadlessOffer(input: HeadlessOfferInput): boolean {
	if (input.offers !== "ask" || input.mode === "json") return false;
	if (input.env.CI !== undefined && input.env.CI !== "" && input.env.CI !== "false") return false;
	const last = readOfferLedger(input.stateDir).lastOfferAt;
	const lastMs = last === null ? Number.NaN : Date.parse(last);
	if (Number.isFinite(lastMs) && input.now.getTime() - lastMs < OFFER_INTERVAL_MS) return false;
	recordOfferShown(input.stateDir, input.sessionId ?? "headless", input.now);
	return true;
}
