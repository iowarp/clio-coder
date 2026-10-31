import type { CallRowV1, FactMetric, Quantity } from "../../core/telemetry/dto.js";
import { factRef } from "../../core/telemetry/dto.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import { renderCompactCount, renderCount } from "../../core/telemetry/render.js";
import type { TelemetryView } from "../../domains/telemetry/contract.js";
import { type ReasoningUsageView, reasoningFromQuantity } from "../status/reasoning.js";

/**
 * What the footer shows of the session's spend, read from the telemetry read model's live view (#434 §11.3): the
 * whole session's tokens and cost across every branch, the newest turn's tokens, and the newest main call's prompt
 * cache. Every string is the canonical renderer's, so an unknown cache read reads `?`, never `0`.
 */
export interface FooterSpend {
	/** Whole-session tokens, compact; null before the session made any call. */
	tokens: string | null;
	/** Whole-session cost; null before anything could be charged. */
	cost: string | null;
	/** Calls that never reached a provider, or null when there are none. */
	neverSent: string | null;
	/** The newest turn's tokens across every call it made, workers included, and the reasoning those calls journaled. */
	turn: { input: string; output: string; cacheRead: string; cacheWrite: string; reasoning: ReasoningUsageView } | null;
	/** The newest main call's prompt-cache split and verdict. */
	promptCache: { read: string; write: string; uncached: string; verdict: string } | null;
	/** The newest main call's speed once it settles; the streaming turn's live rate is the footer's own. */
	speed: FooterSpeed | null;
}
/**
 * Output over the call's generation time (first token to settle) and its TTFT (send to first token), both journaled
 * facts of one call (#434). The rate is null unless both facts are known and the generation took time.
 */
export interface FooterSpeed {
	tokensPerSecond: number | null;
	estimated: boolean;
	/** The read model's TTFT display; null when the call has none to show. */
	ttft: string | null;
}
/** `unavailable` means no read model; `reading` means the live view is still merging its cold read. */
export type FooterTelemetry = { kind: "unavailable" } | { kind: "reading" } | ({ kind: "ready" } & FooterSpend);

const contributed = (quantity: Quantity): boolean =>
	"kind" in quantity.fact
		? quantity.fact.kind !== "absent"
		: quantity.fact.coverage.measured + quantity.fact.coverage.estimated + quantity.fact.unknownCount > 0;
const zero = (quantity: Quantity): boolean =>
	"kind" in quantity.fact
		? quantity.fact.kind === "measured" && quantity.fact.value === 0
		: quantity.fact.unknownCount === 0 && factKnownValue(quantity.fact) === 0;

const spends = new WeakMap<TelemetryView, FooterTelemetry>();

const knownValue = (quantity: Quantity): { value: number; estimated: boolean } | null =>
	"kind" in quantity.fact && (quantity.fact.kind === "measured" || quantity.fact.kind === "estimated")
		? { value: quantity.fact.value, estimated: quantity.fact.kind === "estimated" }
		: null;

function footerSpeed(call: CallRowV1): FooterSpeed {
	const output = call.usage ? knownValue(call.usage.output) : null;
	const generation = knownValue(call.timing.modelTime);
	const ttft = knownValue(call.timing.ttft);
	return {
		tokensPerSecond: output && generation && generation.value > 0 ? output.value / (generation.value / 1000) : null,
		estimated: output?.estimated === true || generation?.estimated === true,
		ttft: ttft ? call.timing.ttft.display : null,
	};
}

export function footerTelemetry(view: TelemetryView | null | undefined): FooterTelemetry {
	if (!view) return { kind: "unavailable" };
	if (view.seeding) return { kind: "reading" };
	const cached = spends.get(view);
	if (cached) return cached;
	const session = view.session();
	const neverSent = session.own.counts.dispositions.neverSent;
	const main = view.calls({ roles: ["main"], limit: 1 }).calls[0];
	const turnId = main?.owner.turnId;
	const turnQuantity = (metric: FactMetric): Quantity | null =>
		turnId === undefined
			? null
			: view.quantity(factRef({ scope: "session", owner: view.sessionId, metric, group: { by: "turn", key: turnId } }));
	const turnCount = (metric: FactMetric): string => {
		const quantity = turnQuantity(metric);
		return quantity ? renderCompactCount(quantity.fact) : "?";
	};
	const spend: FooterTelemetry = {
		kind: "ready",
		tokens: contributed(session.totals.tokens) ? renderCompactCount(session.totals.tokens.fact) : null,
		cost: contributed(session.totals.usd) ? session.totals.usd.display : null,
		neverSent:
			contributed(neverSent) && !zero(neverSent) && !("kind" in neverSent.fact)
				? `${renderCount(neverSent.fact.measured)} never sent`
				: null,
		turn:
			turnId === undefined
				? null
				: {
						input: turnCount("input"),
						output: turnCount("output"),
						cacheRead: turnCount("cacheRead"),
						cacheWrite: turnCount("cacheWrite"),
						reasoning: reasoningFromQuantity(turnQuantity("reasoning")),
					},
		promptCache: main?.usage
			? {
					read: renderCompactCount(main.usage.cacheRead.fact),
					write: renderCompactCount(main.usage.cacheWrite.fact),
					uncached: renderCompactCount(main.usage.input.fact),
					verdict: main.cache.verdict,
				}
			: null,
		speed: main ? footerSpeed(main) : null,
	};
	spends.set(view, spend);
	return spend;
}
