/**
 * Binds a harness decision site to the System One model configured for it.
 *
 * A decision model is a provider, not an agent, so it reaches the harness
 * through the fleet profile machinery that already validates a target and
 * model rather than through a namespace of its own:
 *
 *   fleet:
 *     profiles:
 *       system-one: { target: jev, model: jev-latest }
 *     decisionProfiles: { routing: system-one, toolRisk: system-one }
 *
 * A site with no binding resolves to null and its caller keeps its existing
 * behavior. That makes the whole capability opt-in by absence, with no flag to
 * retire when it leaves alpha, and it is why every call site must treat null as
 * ordinary rather than as a failure.
 */

import type { ClioSettings } from "../../core/config.js";
import type { DecisionSite } from "../../core/defaults.js";
import type { ProvidersContract } from "./contract.js";
import { createDecider, type Decider } from "./decisions.js";
import type { ProbeContext } from "./types/runtime-descriptor.js";

export type { DecisionSite } from "../../core/defaults.js";

export interface ResolveDeciderInput {
	settings: ClioSettings;
	providers: ProvidersContract;
	ctx: ProbeContext;
}

/** Why a site is not answering, for a caller that wants to say so once. */
export type DecisionSiteStatus =
	| { bound: false; reason: "unbound" }
	| { bound: false; reason: "profile-missing" | "target-unresolved" | "runtime-cannot-decide"; detail: string }
	| { bound: true; decider: Decider; targetId: string; model: string | null };

/**
 * Resolve a site to its decider, or explain why it has none. Callers that only
 * want the happy path should use `resolveDecider`; this variant exists so a
 * diagnostic surface can distinguish an operator who configured nothing from an
 * operator who configured something broken.
 */
export function inspectDecisionSite(site: DecisionSite, input: ResolveDeciderInput): DecisionSiteStatus {
	const profileName = input.settings.fleet.decisionProfiles[site];
	if (profileName === undefined) return { bound: false, reason: "unbound" };

	const profile = input.settings.fleet.profiles[profileName];
	if (!profile) {
		return { bound: false, reason: "profile-missing", detail: `fleet.profiles.${profileName} is not defined` };
	}

	// Resolved directly rather than through resolveRuntimeTarget, which is the
	// conversational target resolver: it rejects any target that does not
	// advertise chat, and a System One model advertises exactly the opposite.
	// Routing a decision binding through it made every Jev target unresolvable.
	const targetId = profile.target?.trim();
	const target = targetId ? input.providers.getTarget(targetId) : null;
	if (!target) {
		return {
			bound: false,
			reason: "target-unresolved",
			detail: `target '${profile.target ?? ""}' not found in settings.targets`,
		};
	}
	const runtime = input.providers.getRuntime(target.runtime);
	if (!runtime) {
		return {
			bound: false,
			reason: "target-unresolved",
			detail: `runtime '${target.runtime}' is not registered`,
		};
	}

	// Declaring the capability and implementing the verb are separate claims, and
	// a target bound here by mistake is likelier to be an ordinary chat model
	// than a broken decision runtime. Check the verb, which is what gets called.
	if (!runtime.decide) {
		return {
			bound: false,
			reason: "runtime-cannot-decide",
			detail: `runtime '${runtime.id}' does not answer typed decisions`,
		};
	}

	// The caller's context names which environment variables are set, which is
	// all a chat request needs. A decision target's key usually lives in the
	// credential store under `auth.apiKeyRef`, and without resolving it here
	// every request went out unauthenticated and every site fell back.
	const auth = input.providers.auth;
	const resolveAuthToken = auth
		? async (signal?: AbortSignal): Promise<string | undefined> => {
				try {
					const resolution = await auth.resolveForTarget(target, runtime, signal ? { signal } : undefined);
					return resolution.apiKey ?? undefined;
				} catch {
					return undefined;
				}
			}
		: undefined;
	return {
		bound: true,
		decider: createDecider(runtime, target, input.ctx, resolveAuthToken),
		targetId: target.id,
		model: profile.model ?? null,
	};
}

/**
 * The decider bound to a site, or null when the site is off or misconfigured.
 *
 * Null is the ordinary case, not an error: it is what every caller sees until
 * an operator binds the site. A caller must degrade to the behavior it had
 * before the site existed rather than reporting a failure.
 */
export function resolveDecider(site: DecisionSite, input: ResolveDeciderInput): Decider | null {
	const status = inspectDecisionSite(site, input);
	return status.bound ? status.decider : null;
}
