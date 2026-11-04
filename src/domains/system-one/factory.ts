/**
 * The System One instance a composition root builds once: settings in,
 * bindings resolved per call, engines memoized, every call through the runner.
 *
 * Bindings are resolved from live settings on each call rather than captured,
 * so an edited `systemOne` block applies to the next question without a
 * restart, and an engine is rebuilt only when its own configuration changed.
 */

import { createHash } from "node:crypto";
import type { ClioSettings } from "../../core/config.js";
import type { ProvidersContract } from "../providers/contract.js";
import type { LlmRequestAdmission, OneShotPort } from "../providers/one-shot.js";
import type { RuntimeDescriptor } from "../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../providers/types/target-descriptor.js";
import { createLlmEngine, llmEngineProblem } from "./engines/llm.js";
import type { EngineHost } from "./engines/shared.js";
import { createSystemOneEngine } from "./engines/systemone.js";
import type { DecisionFlowCheck, RunnerRoute } from "./runner.js";
import { createRunner } from "./runner.js";
import { effectiveSystemOne, resolveChoice } from "./selection.js";
import type {
	DecisionEngine,
	EngineKind,
	RunOptions,
	SiteBindingInfo,
	SiteDefinition,
	SiteId,
	SystemOne,
	Verdict,
} from "./types.js";
import { SITE_IDS } from "./types.js";

export interface SystemOneDeps {
	settings: () => Readonly<ClioSettings>;
	providers: Pick<ProvidersContract, "getTarget" | "getRuntime"> & Partial<Pick<ProvidersContract, "auth">>;
	credentialsPresent: () => ReadonlySet<string>;
	oneShot?: OneShotPort;
	admitLlmRequest?: LlmRequestAdmission;
	/** The session current now. Read when a call starts, so a late answer is filed under the session that asked. */
	currentSession?: () => string | null;
	/** The safety domain's information-flow check, applied to every outgoing engine request. */
	flowCheck?: DecisionFlowCheck;
}

/**
 * What a composition root holds: the `SystemOne` every caller sees, plus the
 * shutdown wait only the root uses. It is not on `SystemOne` so a caller's test
 * double does not have to implement it.
 */
export interface SystemOneInstance extends SystemOne {
	/**
	 * Resolves when no call is in flight, or after `maxWaitMs`, whichever is first.
	 * Shutdown awaits it before the final flush, so an answer that beat its own
	 * deadline but not the turn's shorter wait still leaves its row.
	 */
	settled(maxWaitMs: number): Promise<void>;
}

type EngineSettings = ClioSettings["systemOne"]["engines"][string];

interface Usable {
	readonly name: string;
	readonly cfg: EngineSettings;
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
}

interface Resolution {
	readonly info: SiteBindingInfo;
	/** Present only for a binding that can answer. */
	readonly usable?: Usable;
}

const CREDENTIAL_CHECK_MS = 5_000;

function kindOf(cfg: EngineSettings): EngineKind {
	return cfg.kind;
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
	});
	// One engine per configured name, replaced when its configuration digest moves.
	const engines = new Map<string, { digest: string; engine: DecisionEngine }>();

	function resolve(site: SiteId): Resolution {
		const settings = deps.settings();
		const resolved = resolveChoice(settings, settings.systemOne.use);
		if (resolved.kind === "off" || resolved.kind === "none") return { info: { site, engine: null } };
		if (resolved.kind === "unavailable") return { info: { site, engine: resolved.name, problem: resolved.problem } };
		const cfg = resolved.engine;
		const base = { site, engine: resolved.name, kind: kindOf(cfg), target: cfg.target, model: cfg.model ?? null };
		const own = usableEngine(resolved.name);
		return "problem" in own ? { info: { ...base, problem: own.problem } } : { info: base, usable: own.usable };
	}

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

	function usableEngine(name: string): { usable: Usable } | { problem: string } {
		const settings = effectiveSystemOne(deps.settings());
		const config = settings.systemOne;
		const cfg = Object.hasOwn(config.engines, name) ? config.engines[name] : undefined;
		if (cfg === undefined) return { problem: `engine '${name}' is not defined in systemOne.engines` };
		// `systemOne.use: jev` brings its own target, which only the effective settings carry.
		const target =
			deps.providers.getTarget(cfg.target) ??
			settings.targets.find((entry) => entry.id === cfg.target && entry.runtime === "typesafe-jev");
		if (!target) return { problem: `target '${cfg.target}' is not configured` };
		const runtime = deps.providers.getRuntime(target.runtime);
		if (!runtime) return { problem: `runtime '${target.runtime}' is not registered` };
		let problem: string | null = null;
		if (cfg.kind === "systemone") {
			// Declaring the capability and implementing the verb are separate claims,
			// and a target bound here by mistake is likelier an ordinary chat model.
			if (!runtime.decide) problem = `runtime '${runtime.id}' does not answer typed decisions`;
			else problem = missingKey(runtime);
		} else {
			problem = llmEngineProblem({
				target,
				runtime,
				model: cfg.model ?? null,
				oneShot: deps.oneShot !== undefined,
			});
		}
		return problem !== null ? { problem } : { usable: { name, cfg, target, runtime } };
	}

	function routesOf(resolution: Resolution): RunnerRoute[] | null {
		const { usable } = resolution;
		if (usable === undefined) return null;
		const own = engineFor(usable);
		return [{ name: usable.name, engine: own.engine, digest: own.digest, tasks: null }];
	}

	function digestOf(usable: Usable): string {
		const { name, cfg, target, runtime } = usable;
		return createHash("sha256")
			.update(JSON.stringify({ name, cfg, target, runtime: runtime.id, port: deps.oneShot !== undefined }))
			.digest("hex");
	}

	function engineFor(usable: Usable): { digest: string; engine: DecisionEngine } {
		const { name, cfg, target, runtime } = usable;
		const digest = digestOf(usable);
		const held = engines.get(name);
		if (held !== undefined && held.digest === digest) return held;
		const model = cfg.model ?? null;
		const engine =
			cfg.kind === "systemone"
				? createSystemOneEngine({ name, target, runtime, model, host, profile: cfg.profile })
				: createLlmEngine({
						name,
						target,
						runtime,
						model,
						host,
						oneShot: deps.oneShot,
					});
		const built = { digest, engine };
		engines.set(name, built);
		return built;
	}

	return {
		bound(site: SiteId): boolean {
			try {
				return resolve(site).usable !== undefined;
			} catch {
				return false;
			}
		},
		async run<O, V>(site: SiteDefinition<O, V>, object: O, options: RunOptions = {}): Promise<Verdict<V> | null> {
			try {
				const resolution = resolve(site.id);
				const routes = routesOf(resolution);
				if (routes === null) {
					options.onFailure?.(resolution.info.problem ?? `System One site '${site.id}' is not bound`);
					return null;
				}
				return await runner.run({ routes }, site, object, options);
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
		describe(): ReadonlyArray<SiteBindingInfo> {
			return SITE_IDS.map((site) => {
				try {
					return resolve(site).info;
				} catch (err) {
					return { site, engine: null, problem: err instanceof Error ? err.message : String(err) };
				}
			});
		},
		settled: (maxWaitMs) => runner.settled(maxWaitMs),
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
