import type { TelemetryContext } from "../../core/telemetry/context.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { latestCrashSince } from "./crash.js";
import {
	crashCandidate,
	createOfferTriggers,
	type OfferCandidate,
	offerRefusal,
	type ReportOffersSetting,
	readOfferLedger,
	recordAnswer,
	recordOfferShown,
	recordSessionStart,
	WAITING_REFUSALS,
} from "./offers.js";

/**
 * The report offer watcher. It only observes: it reads typed bus facts, keeps per-session counters, and when the
 * host's budget allows shows one quiet notification. A candidate that arrives while a turn runs or while the operator
 * is away waits for the next idle, attended moment in the same session and is dropped when the session ends.
 */

export interface ReportOfferWatcherDeps {
	stateDir: string;
	version: string;
	/** The current session id, or null before the first prompt creates one. */
	sessionId(): string | null;
	offers(): ReportOffersSetting;
	turnRunning(): boolean;
	/** False when the operator is away at yolo. */
	attended(): boolean;
	/** Show the offer: one notification keyed `report-offer`. */
	show(candidate: OfferCandidate): void;
	now?: () => Date;
	hub?: Pick<ReturnType<typeof telemetryHub>, "subscribe">;
	/** How often a waiting candidate is re-checked. */
	retryMs?: number;
}

export interface ReportOfferWatcher {
	/** Re-check a waiting candidate now, e.g. on an operator keypress. */
	poke(): void;
	/** The offer on screen, which `/report` consumes to pre-fill its draft. */
	take(): OfferCandidate | null;
	/** The operator dismissed the offer: its fingerprint is never offered again. */
	decline(): void;
	dispose(): void;
}

export const REPORT_OFFER_KEY = "report-offer";
/** How long a shown offer stays takeable: its notice stands 60 s, and `/report` typed soon after still inherits it. */
export const REPORT_OFFER_TAKE_MS = 2 * 60_000;

function mainAgentFact(context: TelemetryContext | undefined): boolean {
	return context?.agent.role === "main";
}

export function startReportOfferWatcher(deps: ReportOfferWatcherDeps): ReportOfferWatcher {
	const now = deps.now ?? (() => new Date());
	const hub = deps.hub ?? telemetryHub();
	const processSession = `process-${process.pid}-${now().getTime()}`;
	let start: { firstSession: boolean; previousStartAt: string | null };
	try {
		start = recordSessionStart(deps.stateDir, now());
	} catch {
		// Without a ledger there is no budget to honor, so nothing is offered.
		start = { firstSession: true, previousStartAt: null };
	}
	let triggers = createOfferTriggers(deps.version);
	let triggerSession = deps.sessionId();
	/** Counters are per session: a switch to another session starts them again. */
	const sessionTriggers = () => {
		const current = deps.sessionId();
		if (current !== triggerSession && triggerSession !== null) triggers = createOfferTriggers(deps.version);
		triggerSession = current;
		return triggers;
	};
	let pending: { candidate: OfferCandidate; session: string | null } | null = null;
	let shown: { candidate: OfferCandidate; session: string | null; at: number } | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopTimer = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};

	const attempt = (): void => {
		if (pending === null) {
			stopTimer();
			return;
		}
		const current = deps.sessionId();
		// A candidate belongs to its session; one raised before any session (the boot crash) waits for the first.
		if (pending.session !== null && current !== pending.session) {
			pending = null;
			stopTimer();
			return;
		}
		let refusal: ReturnType<typeof offerRefusal>;
		try {
			refusal = offerRefusal(pending.candidate, now().getTime(), {
				id: current ?? processSession,
				offers: deps.offers(),
				ledger: readOfferLedger(deps.stateDir),
				turnRunning: deps.turnRunning(),
				attended: deps.attended(),
				firstSession: start.firstSession,
			});
		} catch {
			refusal = "setting-off";
		}
		if (refusal !== null && WAITING_REFUSALS.has(refusal)) {
			if (timer === undefined) {
				timer = setInterval(attempt, deps.retryMs ?? 1000);
				timer.unref?.();
			}
			return;
		}
		const candidate = pending.candidate;
		pending = null;
		stopTimer();
		if (refusal !== null) return;
		try {
			recordOfferShown(deps.stateDir, current ?? processSession, now());
		} catch {
			return;
		}
		shown = { candidate, session: current, at: now().getTime() };
		deps.show(candidate);
	};

	/** The shown offer while it still belongs to this moment; a later session or a stale offer is dropped. */
	const shownNow = (): OfferCandidate | null => {
		if (shown === null) return null;
		const current = deps.sessionId();
		const moved = shown.session !== null && current !== shown.session;
		if (moved || now().getTime() - shown.at > REPORT_OFFER_TAKE_MS) shown = null;
		return shown?.candidate ?? null;
	};

	const consider = (candidate: OfferCandidate | null): void => {
		if (candidate === null || pending !== null || shownNow() !== null) return;
		pending = { candidate, session: deps.sessionId() };
		attempt();
	};

	if (start.previousStartAt !== null) {
		const crash = latestCrashSince(deps.stateDir, Date.parse(start.previousStartAt));
		if (crash !== null) pending = { candidate: crashCandidate(crash), session: null };
	}

	const unsubscribe = [
		hub.subscribe("turn.settled", (payload, context) => {
			if (!mainAgentFact(context)) return;
			consider(sessionTriggers().turnSettled(payload.terminal.cause));
		}),
		hub.subscribe("compaction.settled", (payload, context) => {
			if (!mainAgentFact(context)) return;
			consider(sessionTriggers().compactionSettled(payload.outcome));
		}),
		hub.subscribe("domain.failed", (payload) => consider(sessionTriggers().domainFailed(payload.name))),
	];
	if (pending !== null) queueMicrotask(attempt);

	return {
		poke: attempt,
		take() {
			const offer = shownNow();
			shown = null;
			return offer;
		},
		decline() {
			const offer = shownNow();
			shown = null;
			if (offer === null) return;
			try {
				recordAnswer(deps.stateDir, offer.fingerprint, "declined", { now: now() });
			} catch {
				// A decline that cannot be written still clears the offer; the seven-day gap bounds a repeat.
			}
		},
		dispose() {
			stopTimer();
			pending = null;
			for (const stop of unsubscribe) stop();
		},
	};
}
