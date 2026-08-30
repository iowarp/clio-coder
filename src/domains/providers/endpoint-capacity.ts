import { canonicalEndpointUrl } from "../../core/endpoint-key.js";
import type { TargetStatus } from "./contract.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

export type EndpointCapacitySource = "override" | "discovered" | "local-native-default";

export interface EndpointCapacity {
	key: string;
	label: string;
	limit: number;
	source: EndpointCapacitySource;
}

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

/** Resolve the endpoint bound from configuration, cached discovery, or the local-native fallback. */
export function endpointCapacityForStatus(status: TargetStatus): EndpointCapacity | null {
	const key = canonicalEndpointKey(status.target);
	if (key === null) return null;
	const override = positiveInteger(status.target.maxConcurrentRequests);
	if (override !== undefined) return { key, label: endpointLabel(key), limit: override, source: "override" };
	const discovered = positiveInteger(status.probeCapabilities?.parallelSlots);
	if (discovered !== undefined) return { key, label: endpointLabel(key), limit: discovered, source: "discovered" };
	if (status.runtime?.tier !== "local-native" || UNBOUNDED_LOCAL_NATIVE_RUNTIMES.has(status.runtime.id)) return null;
	return { key, label: endpointLabel(key), limit: 1, source: "local-native-default" };
}

function sourceRank(source: EndpointCapacitySource): number {
	return source === "override" ? 2 : source === "discovered" ? 1 : 0;
}

/** Resolve one conservative limit per scheduler, preferring an explicit override. */
export function endpointCapacitiesForStatuses(
	statuses: ReadonlyArray<TargetStatus>,
): Readonly<Record<string, EndpointCapacity>> {
	const capacities: Record<string, EndpointCapacity> = {};
	for (const status of statuses) {
		const candidate = endpointCapacityForStatus(status);
		if (candidate === null) continue;
		const current = capacities[candidate.key];
		if (
			current === undefined ||
			sourceRank(candidate.source) > sourceRank(current.source) ||
			(sourceRank(candidate.source) === sourceRank(current.source) && candidate.limit < current.limit)
		) {
			capacities[candidate.key] = candidate;
		}
	}
	return capacities;
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
