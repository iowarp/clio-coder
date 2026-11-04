/**
 * The System One instance a composition root builds once: settings in, routes
 * resolved per ask, engines memoized, every ask through the runner.
 *
 * Which routes exist is fixed at startup, because `use` also decides whether the tool
 * registers at all. What each named route means is resolved from live settings on each
 * ask, so an edited engine applies to the next question and is rebuilt only when its own
 * configuration changed. A route the settings stop naming is dropped at once: never use
 * a route nobody names.
 */

import { createHash } from "node:crypto";
import type { ClioSettings } from "../../core/config.js";
import type { ProvidersContract } from "../providers/contract.js";
import {
	backgroundMemoryAdmissionLimit,
	endpointCapacityFor,
	foregroundStreamUsage,
	modelEndpointKey,
	modelStreamUsage,
} from "../providers/endpoint-capacity.js";
import type { LlmRequestAdmission, OneShotPort } from "../providers/one-shot.js";
import type { RuntimeDescriptor } from "../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../providers/types/target-descriptor.js";
import { ENGINE_KINDS } from "./engine-kinds.js";
import type { EngineHost } from "./engines/shared.js";
import type { DecisionFlowCheck, RunnerRoute } from "./runner.js";
import { createRunner } from "./runner.js";
import { effectiveSystemOne, resolveChoice, routeNames } from "./selection.js";
import type {
	AskOptions,
	DecisionEngine,
	DecisionPoint,
	EngineDestination,
	RouteInfo,
	SystemOne,
	Verdict,
} from "./types.js";

export interface SystemOneDeps {
	settings: () => Readonly<ClioSettings>;
	providers: Pick<ProvidersContract, "getTarget" | "getRuntime"> & Partial<Pick<ProvidersContract, "auth">>;
	credentialsPresent: () => ReadonlySet<string>;
	oneShot?: OneShotPort;
	admitLlmRequest?: LlmRequestAdmission;
	/** The session current now. Read when an ask starts, so a late answer names the session that asked. */
	currentSession?: () => string | null;
	/** The safety domain's information-flow check, applied to every outgoing engine request. */
	flowCheck?: DecisionFlowCheck;
}

export type SystemOneInstance = SystemOne;

interface Usable {
	readonly name: string;
	readonly cfg: ClioSettings["systemOne"]["engines"][string];
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
}

const CREDENTIAL_CHECK_MS = 5_000;

/** Whether an optional ask would wait behind work already on this endpoint. It counts as background memory counts. */
function slotsFullOn(providers: SystemOneDeps["providers"], destination: EngineDestination): boolean {
	const target = providers.getTarget(destination.targetId);
	if (target === null) return false;
	const endpointKey = modelEndpointKey(target, destination.wireModelId);
	if (endpointKey === null) return false;
	const capacity = endpointCapacityFor({ target, runtime: providers.getRuntime(target.runtime) });
	return modelStreamUsage(foregroundStreamUsage(), endpointKey) >= backgroundMemoryAdmissionLimit(capacity);
}

export function createSystemOne(deps: SystemOneDeps): SystemOneInstance {
	const host: EngineHost = {
		auth: deps.providers.auth,
		credentialsPresent: deps.credentialsPresent,
		...(deps.admitLlmRequest ? { admitLlmRequest: deps.admitLlmRequest } : {}),
	};
	const runner = createRunner({
		...(deps.currentSession ? { currentSession: deps.currentSession } : {}),
		...(deps.flowCheck ? { flowCheck: deps.flowCheck } : {}),
		slotsFull: (destination) => slotsFullOn(deps.providers, destination),
	});
	let startupRoutes: ReadonlyArray<string> | null = null;
	/** The routes fixed at startup that the settings still name, in startup order. */
	function namedRoutes(settings: Readonly<ClioSettings>): ReadonlyArray<string> {
		const live = routeNames(settings.systemOne.use);
		startupRoutes ??= live;
		return startupRoutes.filter((name) => live.includes(name));
	}
	// One engine per configured name, replaced when its configuration digest moves.
	const engines = new Map<string, { digest: string; engine: DecisionEngine }>();

	let credentialCheck: { at: number; present: ReadonlySet<string> } | null = null;

	/** Which declared runtime key is absent. Sampled every few seconds: building the set reparses the auth store. */
	function missingKey(runtime: RuntimeDescriptor): string | null {
		const required = runtime.credentialsEnvVar;
		if (required === undefined) return null;
		const now = performance.now();
		if (credentialCheck === null || now - credentialCheck.at > CREDENTIAL_CHECK_MS) {
			credentialCheck = { at: now, present: deps.credentialsPresent() };
		}
		return credentialCheck.present.has(required) ? null : `${required} is not set, so nothing is sent`;
	}

	function usableRoute(
		settings: Readonly<ClioSettings>,
		name: string,
	): { usable: Usable } | { problem: string; cfg?: Usable["cfg"] } {
		const resolved = resolveChoice(settings, name);
		if (resolved.kind === "unavailable") return { problem: resolved.problem };
		if (resolved.kind !== "engine") return { problem: `'${name}' is not a route` };
		const cfg = resolved.engine;
		const effective = effectiveSystemOne(settings, [name]);
		const target = deps.providers.getTarget(cfg.target) ?? effective.targets.find((entry) => entry.id === cfg.target);
		if (!target) return { problem: `target '${cfg.target}' is not configured`, cfg };
		const runtime = deps.providers.getRuntime(target.runtime);
		if (!runtime) return { problem: `runtime '${target.runtime}' is not registered`, cfg };
		const problem = ENGINE_KINDS[cfg.kind].problem(
			{ name, cfg, target, runtime, ...(deps.oneShot !== undefined ? { oneShot: deps.oneShot } : {}) },
			missingKey,
		);
		return problem !== null ? { problem, cfg } : { usable: { name, cfg, target, runtime } };
	}

	function digestOf(usable: Usable): string {
		const { name, cfg, target, runtime } = usable;
		return createHash("sha256")
			.update(JSON.stringify({ name, cfg, target, runtime: runtime.id, port: deps.oneShot !== undefined }))
			.digest("hex");
	}

	function engineFor(usable: Usable): { digest: string; engine: DecisionEngine } {
		const digest = digestOf(usable);
		const held = engines.get(usable.name);
		if (held !== undefined && held.digest === digest) return held;
		const engine = ENGINE_KINDS[usable.cfg.kind].create({
			...usable,
			host,
			...(deps.oneShot !== undefined ? { oneShot: deps.oneShot } : {}),
		});
		const built = { digest, engine };
		engines.set(usable.name, built);
		return built;
	}

	function usableRoutes(): { routes: RunnerRoute[]; problems: string[] } {
		const settings = deps.settings();
		const routes: RunnerRoute[] = [];
		const problems: string[] = [];
		for (const name of namedRoutes(settings)) {
			const route = usableRoute(settings, name);
			if ("problem" in route) {
				problems.push(route.problem);
				continue;
			}
			const built = engineFor(route.usable);
			routes.push({
				name,
				engine: built.engine,
				digest: built.digest,
				timeoutMs: ENGINE_KINDS[route.usable.cfg.kind].routeTimeoutMs,
			});
		}
		return { routes, problems };
	}

	return {
		bound(): boolean {
			try {
				const settings = deps.settings();
				return namedRoutes(settings).some((name) => "usable" in usableRoute(settings, name));
			} catch {
				return false;
			}
		},
		async ask<O, V>(point: DecisionPoint<O, V>, object: O, options: AskOptions = {}): Promise<Verdict<V> | null> {
			try {
				const { routes, problems } = usableRoutes();
				if (routes.length === 0) {
					options.onFailure?.(problems[0] ?? "System One has no route");
					return null;
				}
				return await runner.ask(routes, point, object, options);
			} catch (error) {
				// Nothing that goes wrong in System One may reach the caller's turn.
				try {
					options.onFailure?.(error instanceof Error ? error.message : String(error));
				} catch {
					// A caller's diagnostic observer cannot change the fallback.
				}
				return null;
			}
		},
		routes(): ReadonlyArray<RouteInfo> {
			const settings = deps.settings();
			return namedRoutes(settings).map((name): RouteInfo => {
				try {
					const route = usableRoute(settings, name);
					if ("problem" in route) {
						return {
							name,
							problem: route.problem,
							...(route.cfg !== undefined
								? { kind: route.cfg.kind, target: route.cfg.target, model: route.cfg.model ?? null }
								: {}),
						};
					}
					const { engine } = engineFor(route.usable);
					return {
						name,
						kind: engine.kind,
						profile: engine.profile,
						target: route.usable.cfg.target,
						model: route.usable.cfg.model ?? null,
						windowTokens: engine.capabilities.windowTokens,
						windowCounts: engine.capabilities.windowCounts,
					};
				} catch (err) {
					return { name, problem: err instanceof Error ? err.message : String(err) };
				}
			});
		},
		breakers: () => runner.breakers(),
		// A changed pin is a new configuration, so a refusal of the old one no longer describes the engine.
		refusedEngines: () =>
			new Map(
				runner
					.refused()
					.filter((entry) => engines.get(entry.engine)?.digest === entry.digest)
					.map((entry) => [entry.engine, entry.reason]),
			),
	};
}
