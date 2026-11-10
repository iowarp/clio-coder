import type { RetrySettings } from "../../core/defaults.js";
import type { RuntimeTier } from "../../domains/providers/index.js";
import type { TelemetryView } from "../../domains/telemetry/contract.js";
import { firstTokenStallLimitMs } from "../../session-control/chat-loop-policy.js";
import type { AgentStatus } from "../../session-control/status-types.js";
import { computeWatchdogTier } from "../status/index.js";
import { formatCompactMs } from "../theme/index.js";

/** What this session's settled calls of one role say about how long a route takes to its first output. */
export interface RouteFirstOutput {
	calls: number;
	slowestMs: number;
}

/** One call is a data point. It takes two before Clio says what is usual for a route. */
const USUAL_MIN_CALLS = 2;

/** The history when it is enough to say what is usual, else null. */
export function usualFirstOutput(history: RouteFirstOutput | null | undefined): RouteFirstOutput | null {
	return history !== null && history !== undefined && history.calls >= USUAL_MIN_CALLS ? history : null;
}

/** One fold of a view's calls per role, keyed by route, so a board of running workers reads it once per telemetry batch. */
const routeFolds = new WeakMap<TelemetryView, Map<string, ReadonlyMap<string, RouteFirstOutput>>>();

function routeFold(view: TelemetryView, role: "main" | "worker"): ReadonlyMap<string, RouteFirstOutput> {
	let byRole = routeFolds.get(view);
	if (!byRole) {
		byRole = new Map();
		routeFolds.set(view, byRole);
	}
	const cached = byRole.get(role);
	if (cached) return cached;
	const fold = new Map<string, RouteFirstOutput>();
	// The session's own journal holds the main agent's calls; each worker's calls are in the run journal it references.
	const calls =
		role === "main"
			? view.calls({ roles: ["main"] }).calls
			: view.runs().flatMap((run) => view.calls({ runId: run.runId, roles: ["worker"] }).calls);
	for (const call of calls) {
		const fact = call.timing.ttft.fact;
		if (!("kind" in fact) || (fact.kind !== "measured" && fact.kind !== "estimated")) continue;
		const key = `${call.target.targetId}\0${call.target.requestedModel}`;
		const seen = fold.get(key);
		fold.set(key, { calls: (seen?.calls ?? 0) + 1, slowestMs: Math.max(seen?.slowestMs ?? 0, fact.value) });
	}
	byRole.set(role, fold);
	return fold;
}

/**
 * How long this session's calls on a route took to their first output. The main agent's calls describe the main
 * agent's route and a worker's calls describe workers on theirs, because a worker's prompt and tools differ from the
 * main agent's even on the same model. Null while the view seeds or the route has no measured call.
 */
export function routeFirstOutput(
	view: TelemetryView | null | undefined,
	targetId: string | null | undefined,
	modelId: string | null | undefined,
	role: "main" | "worker" = "main",
): RouteFirstOutput | null {
	if (!view || view.seeding || !targetId || !modelId) return null;
	return routeFold(view, role).get(`${targetId}\0${modelId}`) ?? null;
}

/** `10m`, not the counter form `10m0s`: a limit reads as a round figure, and an age never lands exactly on one for long. */
function age(ms: number): string {
	return formatCompactMs(Math.floor(Math.max(0, ms) / 1000) * 1000).replace(/(?<=\d[mh])0s$/u, "");
}

/** Which of Clio's two silence limits governs the phase, read the way the stall timer in the turn runtime applies them. */
function silenceLimitMs(firstOutput: boolean, retry: RetrySettings, tier: RuntimeTier | undefined): number | null {
	if (retry.streamStallMs <= 0) return null;
	if (!firstOutput) return retry.streamStallMs;
	return firstTokenStallLimitMs(retry, tier);
}

/**
 * The sentence a long silence owes, widest form first, for the row under the footer to fit. It states the age of the
 * last evidence, whether that is unusual for the route, and the limit that will end the wait. The rail beside it keeps
 * the ways out. Null below the third watchdog tier, or while the wait is someone else's: a running tool is outside the
 * stall timer, and an admission reports what it is doing.
 */
export function silenceNoteForms(
	status: AgentStatus,
	now: number,
	retry: RetrySettings,
	history: RouteFirstOutput | null,
	tier?: RuntimeTier,
): readonly string[] | null {
	const phase = status.phase === "stuck" ? status.resumePhase : status.phase;
	const silentMs = Math.max(0, now - status.lastMeaningfulAt);
	if (computeWatchdogTier(silentMs) < 3) return null;
	const waiting = phase === "waiting_model" || (phase === "retrying" && status.retry?.stage === "attempt");
	if (!waiting && phase !== "thinking" && phase !== "writing") return null;
	const limit = silenceLimitMs(waiting, retry, tier);
	const ends =
		limit === null ? "Clio has no time limit on this call" : `Clio ends this call after ${age(limit)} of silence`;
	const endsShort = limit === null ? "No time limit" : `Clio ends this call at ${age(limit)}`;
	const endsTight = limit === null ? "no limit" : `ends at ${age(limit)}`;
	if (!waiting) {
		const silent = age(silentMs);
		return [
			`No new output for ${silent}, usual pauses for this route unknown. ${ends}.`,
			`Silent for ${silent}, usual pauses unknown. ${endsShort}.`,
			`Silent ${silent} · usual unknown · ${endsTight}`,
		];
	}
	// The clock the rail beside this row counts, so the two never read a second apart. Only an admission moves the send.
	const waitingFrom = status.retry?.attemptStartedAt ?? status.waitingSince ?? status.since;
	// A request sent before this wait began is the last call's, answered before its tools ran (the rail's own rule).
	const request = status.modelRequest && status.modelRequest.sentAt >= waitingFrom ? status.modelRequest : undefined;
	const sentAt =
		request?.admissionBeganAt !== undefined && request.admissionBeganAt >= waitingFrom ? request.sentAt : waitingFrom;
	const evidenceMs = now - (request?.firstByteAt ?? sentAt);
	const silent = age(evidenceMs);
	const claim = request?.firstByteAt
		? `Response open ${silent} with no output`
		: request?.bytesObservable
			? `No bytes for ${silent}`
			: `No output for ${silent}`;
	const known = usualFirstOutput(history);
	if (known === null) {
		return [
			`${claim}, usual time for this route unknown. ${ends}.`,
			`${claim}, usual time unknown. ${endsShort}.`,
			`${claim} · usual unknown · ${endsTight}`,
		];
	}
	const slowest = age(known.slowestMs);
	if (now - sentAt <= known.slowestMs) {
		return [
			`${claim}, and this route has taken up to ${slowest} this session. ${ends}.`,
			`${claim}, this route has taken up to ${slowest}. ${endsShort}.`,
			`${claim} · up to ${slowest} before · ${endsTight}`,
		];
	}
	return [
		`${claim}, longer than usual for this route (slowest this session ${slowest}). ${ends}.`,
		`${claim}, longer than usual for this route (slowest ${slowest}). ${endsShort}.`,
		`${claim}, longer than usual here. ${endsShort}.`,
		`${claim} · longer than usual · ${endsTight}`,
	];
}
