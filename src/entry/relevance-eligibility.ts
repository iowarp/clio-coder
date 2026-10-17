/**
 * Whether optional relevance ranking may start an engine call now.
 *
 * Ranking only reorders a listing, so it must not take capacity the foreground
 * turn needs. Every engine the relevance binding can send to counts, the routed
 * ones included: a cluster selection routed to the chat model competes with the
 * turn exactly as a primary binding would. Destinations are compared by the
 * endpoint and model a request would actually reach, so two target aliases for
 * one server and model are the same destination. Pure: the caller supplies the
 * effective capability settings, the capacities and the live stream usage.
 */

import type { ClioSettings } from "../core/config.js";
import type { EndpointCapacity, TargetDescriptor } from "../domains/providers/index.js";
import { canonicalEndpointKey, modelEndpointKey, modelStreamUsage } from "../domains/providers/index.js";

export interface RelevanceEligibilityInput {
	/** The effective capability settings, as System One resolves its bindings from them. */
	readonly settings: Readonly<ClioSettings>;
	readonly getTarget: (targetId: string) => TargetDescriptor | null;
	readonly capacities: Readonly<Record<string, EndpointCapacity>>;
	/** Streams in flight by endpoint key, foreground and background together. */
	readonly usage: Readonly<Record<string, number>>;
}

/**
 * The slot key optional work admits against. Behind a model-routed gateway that
 * nothing bounds, the request's own model is the scheduler it competes with;
 * once the gateway carries a bound, every model behind it counts.
 */
export function backgroundSlotKey(
	target: TargetDescriptor,
	wireModelId: string,
	bounded: (gatewayKey: string) => boolean,
): string | null {
	const gateway = canonicalEndpointKey(target);
	const model = modelEndpointKey(target, wireModelId);
	if (gateway === null || model === gateway) return gateway;
	return bounded(gateway) ? gateway : model;
}

/** Where a request lands: the canonical endpoint, or the target itself when it has no URL, and the wire model. */
function destinationOf(target: TargetDescriptor, model: string | null): string {
	return JSON.stringify([canonicalEndpointKey(target) ?? `target:${target.id}`, model]);
}

/** Why optional ranking must not start now, or null when it may. */
export function relevanceStartRefusal(input: RelevanceEligibilityInput): string | null {
	const { systemOne, chat } = input.settings;
	const binding = systemOne.sites.relevance;
	if (binding === undefined) return null;
	const primary = typeof binding === "string" ? binding : binding.engine;
	const routed = typeof binding === "string" ? [] : Object.values(binding.tasks ?? {});
	const names = [...new Set([primary, ...routed].filter((name): name is string => typeof name === "string"))];
	const chatTarget = chat.target !== null ? input.getTarget(chat.target) : null;
	const foreground =
		chatTarget === null ? null : destinationOf(chatTarget, chat.model ?? chatTarget.defaultModel ?? null);
	for (const name of names) {
		// An undefined engine or target makes its route abstain in the runner; it sends nothing.
		const cfg = Object.hasOwn(systemOne.engines, name) ? systemOne.engines[name] : undefined;
		if (cfg === undefined) continue;
		const target = input.getTarget(cfg.target);
		if (target === null) continue;
		// An engine with no model asks its target's default, as a chat route does.
		const model = cfg.model ?? target.defaultModel ?? null;
		if (cfg.kind === "llm" && foreground !== null && destinationOf(target, model) === foreground) {
			return `engine '${name}' would ask the chat's own model`;
		}
		const key = backgroundSlotKey(target, model ?? "", (gateway) => input.capacities[gateway] !== undefined);
		const limit = key === null ? undefined : input.capacities[key]?.limit;
		// An endpoint with no fixed slot count stays eligible, as System One's engines treat it.
		if (key !== null && limit !== undefined && modelStreamUsage(input.usage, key) >= limit) {
			return `engine '${name}' endpoint has all ${limit} declared slots in use`;
		}
	}
	return null;
}
