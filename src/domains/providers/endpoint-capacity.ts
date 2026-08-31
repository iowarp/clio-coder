import { canonicalEndpointUrl } from "../../core/endpoint-key.js";
import type { TargetStatus } from "./contract.js";
import {
	type DiscoveredEndpointSlots,
	readDiscoveredEndpointSlots,
	recordDiscoveredEndpointSlots,
} from "./endpoint-slots-store.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

/**
 * Where an endpoint's slot bound came from, weakest first.
 *
 * `discovered-prior` is a slot count a previous process probed and persisted
 * (endpoint-slots-store.ts). It outranks the blind local default because it is
 * evidence, and it yields to a probe this process ran because that evidence is
 * newer.
 */
export type EndpointCapacitySource = "override" | "discovered" | "discovered-prior" | "local-native-default";

export interface EndpointCapacity {
	key: string;
	label: string;
	limit: number;
	source: EndpointCapacitySource;
}

/** Endpoint priors keyed by canonical endpoint key. */
export type EndpointSlotPriors = Readonly<Record<string, DiscoveredEndpointSlots>>;

/** Runtime ids whose request schedulers are intentionally not modeled as fixed local slots. */
const UNBOUNDED_LOCAL_NATIVE_RUNTIMES = new Set(["vllm", "sglang"]);

/**
 * Canonical identity of the inference scheduler behind a configured target.
 * Scheme, normalized host and port, and normalized base path participate. DNS
 * aliases do not collapse because Clio cannot prove they reach the same server.
 */
export function canonicalEndpointKey(value: TargetDescriptor | string): string | null {
	return canonicalEndpointUrl(typeof value === "string" ? value : value.url);
}

/** Compact operator-facing identity. A non-root base path remains visible. */
export function endpointLabel(endpointKey: string): string {
	try {
		const url = new URL(endpointKey);
		return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
	} catch {
		return endpointKey;
	}
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The runtime facts capacity resolution needs; a full descriptor satisfies it. */
export type EndpointRuntimeIdentity = Pick<RuntimeDescriptor, "id" | "tier">;

export interface EndpointCapacityInput {
	target: TargetDescriptor;
	/** Null when no runtime descriptor has resolved yet for `target.runtime`. */
	runtime: EndpointRuntimeIdentity | null;
	/** Slot count a probe in this process discovered, if one has landed. */
	discoveredSlots?: number | undefined;
}

/**
 * Resolve one endpoint's concurrency bound.
 *
 * The order is the whole contract, because it is what makes the answer
 * independent of when it is asked:
 *
 *   1. `maxConcurrentRequests` on the target. The operator said so.
 *   2. A probe this process ran.
 *   3. A probe a previous process ran and persisted, still inside its
 *      staleness bound and still describing the same runtime.
 *   4. The conservative local-native default of one slot.
 *
 * Steps 2 and 3 answer with the same number for the same server, so a dispatch
 * typed one second after boot and one typed a minute later resolve identically.
 * Runtimes whose schedulers are not fixed local slots stay unbounded (null).
 */
export function endpointCapacityFor(
	input: EndpointCapacityInput,
	priors: EndpointSlotPriors = readDiscoveredEndpointSlots(),
): EndpointCapacity | null {
	const key = canonicalEndpointKey(input.target);
	if (key === null) return null;
	const label = endpointLabel(key);
	const override = positiveInteger(input.target.maxConcurrentRequests);
	if (override !== undefined) return { key, label, limit: override, source: "override" };
	const discovered = positiveInteger(input.discoveredSlots);
	if (discovered !== undefined) return { key, label, limit: discovered, source: "discovered" };
	const prior = priors[key];
	// A record written by another runtime describes another server that once
	// answered on this host and port, which is not evidence about this one.
	if (prior !== undefined && prior.runtimeId === (input.runtime?.id ?? input.target.runtime)) {
		return { key, label, limit: prior.slots, source: "discovered-prior" };
	}
	if (input.runtime?.tier !== "local-native" || UNBOUNDED_LOCAL_NATIVE_RUNTIMES.has(input.runtime.id)) return null;
	return { key, label, limit: 1, source: "local-native-default" };
}

/** Resolve the endpoint bound from configuration, discovery, priors, or the local-native fallback. */
export function endpointCapacityForStatus(
	status: TargetStatus,
	priors: EndpointSlotPriors = readDiscoveredEndpointSlots(),
): EndpointCapacity | null {
	return endpointCapacityFor(
		{
			target: status.target,
			runtime: status.runtime ?? null,
			discoveredSlots: status.probeCapabilities?.parallelSlots,
		},
		priors,
	);
}

function sourceRank(source: EndpointCapacitySource): number {
	switch (source) {
		case "override":
			return 3;
		case "discovered":
			return 2;
		case "discovered-prior":
			return 1;
		default:
			return 0;
	}
}

/** Strongest evidence wins; among equals the smaller bound wins. */
function foldCapacity(capacities: Record<string, EndpointCapacity>, candidate: EndpointCapacity | null): void {
	if (candidate === null) return;
	const current = capacities[candidate.key];
	if (
		current === undefined ||
		sourceRank(candidate.source) > sourceRank(current.source) ||
		(sourceRank(candidate.source) === sourceRank(current.source) && candidate.limit < current.limit)
	) {
		capacities[candidate.key] = candidate;
	}
}

/** Resolve one conservative limit per scheduler, preferring an explicit override. */
export function endpointCapacitiesForStatuses(
	statuses: ReadonlyArray<TargetStatus>,
): Readonly<Record<string, EndpointCapacity>> {
	const priors = readDiscoveredEndpointSlots();
	const capacities: Record<string, EndpointCapacity> = {};
	for (const status of statuses) foldCapacity(capacities, endpointCapacityForStatus(status, priors));
	return capacities;
}

/**
 * Every endpoint the configured fleet can reach, whether or not a probe has
 * built a status for it yet.
 *
 * Resolving from `statuses` alone made the endpoint set depend on how far
 * provider startup had progressed. An endpoint missing from that set carries no
 * limit, and a capacity check with no limit is not a conservative check, it is
 * no check: a plan needing two slots on a one-slot server was admitted whole
 * when it was typed before the provider domain had finished building statuses,
 * and denied afterwards. Configured targets fill the gap so the set is the same
 * at both moments.
 */
export function resolveEndpointCapacities(input: {
	statuses: ReadonlyArray<TargetStatus>;
	targets?: ReadonlyArray<TargetDescriptor>;
	runtimeFor?: (runtimeId: string) => EndpointRuntimeIdentity | null | undefined;
}): Readonly<Record<string, EndpointCapacity>> {
	const priors = readDiscoveredEndpointSlots();
	const capacities: Record<string, EndpointCapacity> = {};
	const covered = new Set<string>();
	for (const status of input.statuses) {
		covered.add(status.target.id);
		foldCapacity(capacities, endpointCapacityForStatus(status, priors));
	}
	for (const target of input.targets ?? []) {
		if (covered.has(target.id)) continue;
		foldCapacity(
			capacities,
			endpointCapacityFor({ target, runtime: input.runtimeFor?.(target.runtime) ?? null }, priors),
		);
	}
	return capacities;
}

/**
 * Persist what a live probe just learned about this target's endpoint so the
 * next process starts with the count instead of the blind default. A status
 * with no probed slot count writes nothing: absence is not an observation, and
 * overwriting a good record with silence would lose the fact this exists to
 * keep.
 */
export function recordEndpointSlotsFromStatus(
	status: TargetStatus,
	options?: { nowMs?: number; onError?: (error: unknown) => void },
): Promise<void> {
	const key = canonicalEndpointKey(status.target);
	const slots = positiveInteger(status.probeCapabilities?.parallelSlots);
	const runtimeId = status.runtime?.id ?? status.target.runtime;
	if (key === null || slots === undefined || runtimeId === undefined) return Promise.resolve();
	return recordDiscoveredEndpointSlots({ endpointKey: key, runtimeId, slots }, options);
}

/**
 * The orchestrator's own request lives only in this process. It deliberately
 * never enters dispatch-admission.json because process exit releases it.
 */
const foregroundStreams = new Map<string, number>();

export function registerForegroundStream(endpointKey: string): () => void {
	foregroundStreams.set(endpointKey, (foregroundStreams.get(endpointKey) ?? 0) + 1);
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		const next = (foregroundStreams.get(endpointKey) ?? 1) - 1;
		if (next <= 0) foregroundStreams.delete(endpointKey);
		else foregroundStreams.set(endpointKey, next);
	};
}

export function foregroundStreamUsage(): Readonly<Record<string, number>> {
	return Object.fromEntries(foregroundStreams);
}
