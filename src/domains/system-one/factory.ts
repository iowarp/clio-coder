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
import type { RuntimeDescriptor } from "../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../providers/types/target-descriptor.js";
import { cutsFor } from "./calibration.js";
import { createLlmEngine, llmEngineProblem } from "./engines/llm.js";
import type { EngineHost } from "./engines/shared.js";
import { createSystemOneEngine } from "./engines/systemone.js";
import { createRunner } from "./runner.js";
import type {
	DecisionEngine,
	DecisionRecorder,
	EngineKind,
	RunOptions,
	SiteBindingInfo,
	SiteDefinition,
	SiteId,
	SystemOne,
	Verdict,
} from "./types.js";
import { SITE_IDS } from "./types.js";

/**
 * One tool-free completion through a runtime that has no chat-completions
 * wire (subscription and CLI-backed ones). The composition root supplies it
 * because only the engine layer may speak to those runtimes, and the answer
 * is text: an LLM engine behind a port can vote but cannot read logprobs.
 */
export type OneShotPort = (request: {
	targetId: string;
	model: string | null;
	system: string;
	user: string;
	schema?: object;
	maxTokens: number;
	signal: AbortSignal;
}) => Promise<{ text: string; usage?: { input: number; output: number } }>;

export interface SystemOneDeps {
	settings: () => Readonly<ClioSettings>;
	providers: Pick<ProvidersContract, "getTarget" | "getRuntime"> & Partial<Pick<ProvidersContract, "auth">>;
	credentialsPresent: () => ReadonlySet<string>;
	oneShot?: OneShotPort;
	/** Concurrent requests the endpoint behind a target serves; absent means 4. */
	endpointCapacity?: (targetId: string) => number;
	recorder?: () => DecisionRecorder | null;
	/** The session current now. Read when a call starts, so a late answer is filed under the session that asked. */
	currentSession?: () => string | null;
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

interface Resolution {
	readonly info: SiteBindingInfo;
	/** Present only for a binding that can answer. */
	readonly usable?: {
		readonly name: string;
		readonly cfg: EngineSettings;
		readonly target: TargetDescriptor;
		readonly runtime: RuntimeDescriptor;
		readonly timeoutMs: number | undefined;
	};
}

function kindOf(cfg: EngineSettings): EngineKind {
	return cfg.kind;
}

export function createSystemOne(deps: SystemOneDeps): SystemOneInstance {
	const host: EngineHost = { auth: deps.providers.auth, credentialsPresent: deps.credentialsPresent };
	const runner = createRunner({
		...(deps.recorder ? { recorder: deps.recorder } : {}),
		...(deps.currentSession ? { currentSession: deps.currentSession } : {}),
		cutOverrides: () => deps.settings().systemOne.cuts,
	});
	// One engine per configured name, replaced when its configuration digest moves.
	const engines = new Map<string, { digest: string; engine: DecisionEngine }>();

	function resolve(site: SiteId): Resolution {
		const config = deps.settings().systemOne;
		const binding = config.sites[site];
		if (binding === undefined) return { info: { site, engine: null } };
		const name = typeof binding === "string" ? binding : binding.engine;
		const timeoutMs = typeof binding === "string" ? undefined : binding.timeoutMs;
		const timeout = timeoutMs === undefined ? {} : { deadlineMs: timeoutMs };
		const cfg = Object.hasOwn(config.engines, name) ? config.engines[name] : undefined;
		if (cfg === undefined) {
			return { info: { site, engine: name, ...timeout, problem: `engine '${name}' is not defined in systemOne.engines` } };
		}
		const base = { site, engine: name, kind: kindOf(cfg), target: cfg.target, model: cfg.model ?? null, ...timeout };
		const target = deps.providers.getTarget(cfg.target);
		if (!target) return { info: { ...base, problem: `target '${cfg.target}' is not configured` } };
		const runtime = deps.providers.getRuntime(target.runtime);
		if (!runtime) return { info: { ...base, problem: `runtime '${target.runtime}' is not registered` } };
		let problem: string | null = null;
		if (cfg.kind === "systemone") {
			// Declaring the capability and implementing the verb are separate claims,
			// and a target bound here by mistake is likelier an ordinary chat model.
			if (!runtime.decide) problem = `runtime '${runtime.id}' does not answer typed decisions`;
		} else {
			problem = llmEngineProblem({
				target,
				runtime,
				model: cfg.model ?? null,
				oneShot: deps.oneShot !== undefined,
			});
		}
		if (problem !== null) return { info: { ...base, problem } };
		return { info: base, usable: { name, cfg, target, runtime, timeoutMs } };
	}

	function digestOf(usable: NonNullable<Resolution["usable"]>): string {
		const { name, cfg, target, runtime } = usable;
		return createHash("sha256")
			.update(JSON.stringify({ name, cfg, target, runtime: runtime.id, port: deps.oneShot !== undefined }))
			.digest("hex");
	}

	function engineFor(usable: NonNullable<Resolution["usable"]>): { digest: string; engine: DecisionEngine } {
		const { name, cfg, target, runtime } = usable;
		const digest = digestOf(usable);
		const held = engines.get(name);
		if (held !== undefined && held.digest === digest) return held;
		const model = cfg.model ?? null;
		const engine =
			cfg.kind === "systemone"
				? createSystemOneEngine({ name, target, runtime, model, host })
				: createLlmEngine({
						name,
						target,
						runtime,
						model,
						mode: cfg.mode ?? "auto",
						host,
						oneShot: deps.oneShot,
						endpointCapacity: deps.endpointCapacity,
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
				const { usable } = resolve(site.id);
				if (usable === undefined) return null;
				const { engine, digest } = engineFor(usable);
				return await runner.run(
					{ name: usable.name, engine, digest, ...(usable.timeoutMs !== undefined ? { timeoutMs: usable.timeoutMs } : {}) },
					site,
					object,
					options,
				);
			} catch {
				// Nothing that goes wrong in System One may reach the caller's turn.
				return null;
			}
		},
		shadowed(site: SiteId): boolean {
			try {
				const { usable } = resolve(site);
				if (usable === undefined) return false;
				const build = runner.answeredBuild(digestOf(usable));
				return build !== null && !cutsFor(build, site, deps.settings().systemOne.cuts).fitted;
			} catch {
				// Unknown is not shadow: the caller waits exactly as it did before this existed.
				return false;
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
	};
}
