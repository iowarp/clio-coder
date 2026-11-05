import type { RetrySettings } from "../../core/defaults.js";
import type { TelemetryView } from "../../domains/telemetry/contract.js";
import type { AgentStatus } from "../../session-control/status-types.js";
import { computeWatchdogTier } from "../status/index.js";
import { formatCompactMs } from "../theme/index.js";

/** What this session's settled main calls say about how long a route takes to its first output. */
export interface RouteFirstOutput {
	calls: number;
	slowestMs: number;
}

/** One call is a data point. It takes two before Clio says what is usual for a route. */
const USUAL_MIN_CALLS = 2;

export function routeFirstOutput(
	view: TelemetryView | null | undefined,
	targetId: string | null | undefined,
	modelId: string | null | undefined,
): RouteFirstOutput | null {
	if (!view || view.seeding || !targetId || !modelId) return null;
	let calls = 0;
	let slowestMs = 0;
	for (const call of view.calls({ roles: ["main"] }).calls) {
		if (call.target.targetId !== targetId || call.target.requestedModel !== modelId) continue;
		const fact = call.timing.ttft.fact;
		if (!("kind" in fact) || (fact.kind !== "measured" && fact.kind !== "estimated")) continue;
		calls += 1;
		slowestMs = Math.max(slowestMs, fact.value);
	}
	return calls === 0 ? null : { calls, slowestMs };
}

/** `10m`, not the counter form `10m0s`: a limit reads as a round figure, and an age never lands exactly on one for long. */
function age(ms: number): string {
	return formatCompactMs(Math.floor(Math.max(0, ms) / 1000) * 1000).replace(/(?<=\d[mh])0s$/u, "");
}

/** Which of Clio's two silence limits governs the phase, read the way the stall timer in the turn runtime applies them. */
function silenceLimitMs(firstOutput: boolean, retry: RetrySettings): number | null {
	if (retry.streamStallMs <= 0) return null;
	if (!firstOutput) return retry.streamStallMs;
	return retry.firstTokenStallMs <= 0 ? null : Math.max(retry.firstTokenStallMs, retry.streamStallMs);
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
): readonly string[] | null {
	const phase = status.phase === "stuck" ? status.resumePhase : status.phase;
	const silentMs = Math.max(0, now - status.lastMeaningfulAt);
	if (computeWatchdogTier(silentMs) < 3) return null;
	const waiting = phase === "waiting_model" || (phase === "retrying" && status.retry?.stage === "attempt");
	if (!waiting && phase !== "thinking" && phase !== "writing") return null;
	const limit = silenceLimitMs(waiting, retry);
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
	const request = status.modelRequest;
	// The clock the rail beside this row counts, so the two never read a second apart. Only an admission moves the send.
	const waitingFrom = status.retry?.attemptStartedAt ?? status.waitingSince ?? status.since;
	const sentAt =
		request?.admissionBeganAt !== undefined && request.admissionBeganAt >= waitingFrom ? request.sentAt : waitingFrom;
	const evidenceMs = now - (request?.firstByteAt ?? sentAt);
	const silent = age(evidenceMs);
	const claim = request?.firstByteAt
		? `Response open ${silent} with no output`
		: request?.bytesObservable
			? `No bytes for ${silent}`
			: `No output for ${silent}`;
	const known = history !== null && history.calls >= USUAL_MIN_CALLS ? history : null;
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
