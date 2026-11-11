import type { BackendCompletionTimings, CacheRequestStructure } from "../../core/cache-telemetry.js";
import { firstChangedSection, uncachedPrefillTokens } from "../../core/cache-telemetry.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { pricedUsd } from "../../core/telemetry/pricing.js";
import type { CallSettled } from "../../core/telemetry/schemas.js";
import type { EffectivePricing } from "../providers/catalog.js";
import { calculatePricingCostUsd } from "../providers/catalog.js";

/** What the journal keeps of the last request sent on one cache key (#434). */
export interface CacheBaseline {
	structure: CacheRequestStructure;
	/** Prompt tokens (input + cacheRead + cacheWrite) its provider reported; null when any part went unreported. */
	promptTokens: number | null;
}

type CachePhysics = Pick<CallSettled["cache"], "firstDivergentSection" | "rePrefilledTokens" | "bill">;

const notApplicable = { kind: "absent", reason: "not-applicable" } as const;
const unobserved = { kind: "unknown", reason: "not-observed" } as const;
const counted = <T>(value: T) => ({ kind: "measured", value, source: "local-count" }) as const;
const measured = (fact: Fact<number> | undefined): number | null => (fact?.kind === "measured" ? fact.value : null);

/**
 * The usage a server that omits cache reads from its usage but reports them in its own timings (llama.cpp's cache_n)
 * is judged by: the prompt it evaluated is the uncached input and cache_n the read. Undefined when the provider
 * measured its own read or the timings report none, so the provider's usage facts stand (#434).
 */
export function serverTimedUsage(
	settlement: Pick<CallSettled, "disposition" | "usage">,
	backend: BackendCompletionTimings | null | undefined,
): NonNullable<CallSettled["usage"]> | undefined {
	const usage = settlement.usage;
	if (!usage || usage.cacheRead.kind === "measured" || settlement.disposition === "sent_unsettled") return undefined;
	const evaluated = uncachedPrefillTokens(backend);
	if (evaluated === null || !backend) return undefined;
	const server = (value: number) => ({ kind: "measured", value, source: "provider" }) as const;
	return {
		...usage,
		input: server(evaluated),
		cacheRead: server(backend.promptTokens - evaluated),
		cacheWrite: server(0),
	};
}

/** Request order is the leading prompt, its tools, then the transcript; a shorter transcript diverges where it ends. */
export function firstDivergentSection(previous: CacheRequestStructure, current: CacheRequestStructure): string | null {
	if (previous.system !== current.system) {
		const section =
			previous.sections && current.sections ? firstChangedSection(previous.sections, current.sections) : undefined;
		return section ?? "system-prompt";
	}
	if (previous.tools !== current.tools) return "tools";
	const shared = Math.min(previous.entries.length, current.entries.length);
	for (let index = 0; index < shared; index += 1) {
		if (previous.entries[index] !== current.entries[index]) return "messages";
	}
	return current.entries.length < previous.entries.length ? "messages" : null;
}

const short = (digest: string) => digest.slice(0, 16);

/**
 * What the journal keeps of a request's structure: short digests, all of the transcript's entries for the process's
 * first request on its route, then only those past where it parts from the previous one (`base`), so the journal
 * grows with the transcript rather than with every request.
 */
export function journaledStructure(
	structure: CacheRequestStructure,
	previous: CacheRequestStructure | undefined,
): NonNullable<CallSettled["cache"]["structure"]> {
	let base = 0;
	if (previous) {
		const shared = Math.min(previous.entries.length, structure.entries.length);
		while (base < shared && previous.entries[base] === structure.entries[base]) base += 1;
	}
	return {
		system: short(structure.system),
		tools: short(structure.tools),
		...(previous ? { base } : {}),
		entries: structure.entries
			.slice(base)
			.map((entry, index) => `${structure.roles?.[base + index] ?? "entry"}:${short(entry)}`),
	};
}

/**
 * rePrefilledTokens × (input rate − cache-read rate), labelled the way the call's own cost is (#434). Both sides keep
 * the whole prompt, so a tiered rate map prices them on one tier. The re-prefilled tokens are priced as input even when
 * the provider billed them as a cache write, so the figure never depends on a cache-write rate the target left out.
 */
function bill(
	rePrefilled: Fact<number>,
	pricing: EffectivePricing,
	promptTokens: number | null,
): NonNullable<CachePhysics["bill"]> {
	if (rePrefilled.kind !== "measured") return { usd: rePrefilled, pricedBy: "none" };
	if (pricing.pricedBy === "free")
		return {
			usd: counted(0),
			pricedBy: "free",
			...(pricing.freeRule !== undefined ? { freeRule: pricing.freeRule } : {}),
		};
	if (pricing.rates === null || pricing.pricedBy === "none" || promptTokens === null)
		return { usd: { kind: "unknown", reason: "provider-omitted" }, pricedBy: "none" };
	const actual = { input: rePrefilled.value, output: 0, cacheRead: promptTokens - rePrefilled.value };
	const cached = { input: 0, output: 0, cacheRead: promptTokens };
	const usd = Math.max(
		0,
		calculatePricingCostUsd(pricing.rates, actual) - calculatePricingCostUsd(pricing.rates, cached),
	);
	return pricedUsd(pricing.pricedBy, usd);
}

/**
 * The already-seen prefix charged again and its bill, observed against the previous request on the same cache key
 * and never predicted from a TTL (D7). With no earlier request in view, a request that carries no earlier reply had
 * nothing seen before it; one that does follows a call this process never saw, so both facts stay unknown (#434).
 */
export function cachePhysics(input: {
	settlement: Pick<CallSettled, "disposition" | "usage">;
	structure: CacheRequestStructure | undefined;
	previous: CacheBaseline | undefined;
	pricing: EffectivePricing;
}): { cache: CachePhysics; baseline: CacheBaseline | undefined } {
	const { settlement, structure, previous, pricing } = input;
	if (settlement.disposition === "never_sent") {
		return {
			cache: {
				firstDivergentSection: notApplicable,
				rePrefilledTokens: notApplicable,
				bill: { usd: notApplicable, pricedBy: "none" },
			},
			baseline: previous,
		};
	}
	const uncached = measured(settlement.usage?.input);
	const cacheRead = measured(settlement.usage?.cacheRead);
	const cacheWrite = measured(settlement.usage?.cacheWrite);
	const settled = settlement.disposition === "settled";
	const baseline = structure && {
		structure,
		promptTokens:
			settled && uncached !== null && cacheRead !== null && cacheWrite !== null ? uncached + cacheRead + cacheWrite : null,
	};
	let divergence: CachePhysics["firstDivergentSection"] = unobserved;
	let rePrefilled: Fact<number> = unobserved;
	if (structure && previous) {
		divergence = counted(firstDivergentSection(previous.structure, structure));
		if (!settled)
			rePrefilled = {
				kind: "unknown",
				reason: settlement.disposition === "sent_unsettled" ? "stream-dropped" : "provider-omitted",
			};
		else if (uncached === null || cacheRead === null) rePrefilled = { kind: "unknown", reason: "provider-omitted" };
		else if (previous.promptTokens !== null)
			// Anthropic bills a re-prefilled prefix as a cache write and reports only the tail past the last breakpoint as
			// input, so the prompt not read from cache is input plus cache write; OpenAI shapes report no write (#434).
			rePrefilled = counted(Math.max(0, Math.min(uncached + (cacheWrite ?? 0), previous.promptTokens - cacheRead)));
	} else if (structure && !structure.answered) {
		divergence = notApplicable;
		rePrefilled = counted(0);
	}
	return {
		cache: {
			firstDivergentSection: divergence,
			rePrefilledTokens: rePrefilled,
			bill: bill(
				rePrefilled,
				pricing,
				uncached === null || cacheRead === null ? null : uncached + cacheRead + (cacheWrite ?? 0),
			),
		},
		baseline,
	};
}
