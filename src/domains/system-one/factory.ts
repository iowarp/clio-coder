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
import type { DecisionTask } from "./contract.js";
import { SITE_TASKS } from "./contract.js";
import { createLlmEngine, llmEngineProblem } from "./engines/llm.js";
import type { EngineHost, LlmRequestAdmission } from "./engines/shared.js";
import { createSystemOneEngine } from "./engines/systemone.js";
import { profileFor } from "./profiles.js";
import { MAX_CHOICE_OPTIONS } from "./questions.js";
import type { DecisionFlowCheck, RunnerRoute } from "./runner.js";
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
	admitLlmRequest?: LlmRequestAdmission;
	/** Concurrent requests the endpoint behind a target serves; absent means 4. */
	endpointCapacity?: (targetId: string) => number;
	recorder?: () => DecisionRecorder | null;
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
	readonly usable?: Usable & { readonly timeoutMs: number | undefined };
	/** Task routes to other engines, each usable or with the reason it is not. */
	readonly routes?: ReadonlyArray<{
		readonly name: string;
		readonly tasks: ReadonlyArray<DecisionTask>;
		readonly usable?: Usable;
		readonly problem?: string;
	}>;
}

function kindOf(cfg: EngineSettings): EngineKind {
	return cfg.kind;
}

/**
 * A routed engine that cannot answer. Its tasks abstain under it instead of
 * falling back to the site's engine, which would silently answer a task the
 * operator routed elsewhere.
 */
function unavailableEngine(name: string, problem: string): DecisionEngine {
	return {
		name,
		kind: "systemone",
		target: "",
		model: null,
		windowTokens: null,
		runtime: "",
		url: null,
		profile: null,
		renderer: "systemone-v1",
		unsupported: () => problem,
		decide: () => Promise.reject(new Error(problem)),
	};
}

function maxOptionsOf(engine: DecisionEngine): number {
	return engine.profile === null ? MAX_CHOICE_OPTIONS : profileFor(engine.profile).maxOptions;
}

export function createSystemOne(deps: SystemOneDeps): SystemOneInstance {
	const host: EngineHost = {
		auth: deps.providers.auth,
		credentialsPresent: deps.credentialsPresent,
		...(deps.admitLlmRequest ? { admitLlmRequest: deps.admitLlmRequest } : {}),
	};
	const runner = createRunner({
		...(deps.recorder ? { recorder: deps.recorder } : {}),
		...(deps.currentSession ? { currentSession: deps.currentSession } : {}),
		...(deps.flowCheck ? { flowCheck: deps.flowCheck } : {}),
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
		const routed = typeof binding === "string" ? undefined : binding.tasks;
		const cfg = Object.hasOwn(config.engines, name) ? config.engines[name] : undefined;
		if (cfg === undefined) {
			return { info: { site, engine: name, ...timeout, problem: `engine '${name}' is not defined in systemOne.engines` } };
		}
		const base = {
			site,
			engine: name,
			kind: kindOf(cfg),
			target: cfg.target,
			model: cfg.model ?? null,
			...timeout,
			...(routed !== undefined && Object.keys(routed).length > 0 ? { routes: routed } : {}),
		};
		const own = usableEngine(name);
		if ("problem" in own) return { info: { ...base, problem: own.problem } };
		// One route per other engine, carrying every task routed to it. A task the
		// site does not ask is refused here as well as in settings, so it never runs.
		const byEngine = new Map<string, DecisionTask[]>();
		for (const [task, engine] of Object.entries(routed ?? {})) {
			if (engine === undefined || engine === name) continue;
			if (!SITE_TASKS[site].includes(task as DecisionTask)) {
				return { info: { ...base, problem: `task ${task} is not asked at site ${site}` } };
			}
			byEngine.set(engine, [...(byEngine.get(engine) ?? []), task as DecisionTask]);
		}
		const routes = [...byEngine].map(([engine, tasks]) => {
			const resolved = usableEngine(engine);
			return "problem" in resolved
				? { name: engine, tasks, problem: resolved.problem }
				: { name: engine, tasks, usable: resolved.usable };
		});
		return { info: base, usable: { ...own.usable, timeoutMs }, routes };
	}

	function usableEngine(name: string): { usable: Usable } | { problem: string } {
		const config = deps.settings().systemOne;
		const cfg = Object.hasOwn(config.engines, name) ? config.engines[name] : undefined;
		if (cfg === undefined) return { problem: `engine '${name}' is not defined in systemOne.engines` };
		const target = deps.providers.getTarget(cfg.target);
		if (!target) return { problem: `target '${cfg.target}' is not configured` };
		const runtime = deps.providers.getRuntime(target.runtime);
		if (!runtime) return { problem: `runtime '${target.runtime}' is not registered` };
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
		return problem !== null ? { problem } : { usable: { name, cfg, target, runtime } };
	}

	function routesOf(resolution: Resolution): RunnerRoute[] | null {
		const { usable } = resolution;
		if (usable === undefined) return null;
		const own = engineFor(usable);
		const routes: RunnerRoute[] = [{ name: usable.name, engine: own.engine, digest: own.digest, tasks: null }];
		for (const route of resolution.routes ?? []) {
			if (route.usable === undefined) {
				const problem = route.problem ?? "unusable";
				routes.push({
					name: route.name,
					engine: unavailableEngine(route.name, problem),
					digest: `unavailable:${route.name}`,
					tasks: route.tasks,
				});
				continue;
			}
			const built = engineFor(route.usable);
			routes.push({ name: route.name, engine: built.engine, digest: built.digest, tasks: route.tasks });
		}
		return routes;
	}

	function engineForTask(site: SiteId, task: DecisionTask): DecisionEngine | null {
		const resolution = resolve(site);
		const routes = routesOf(resolution);
		if (routes === null) return null;
		return (routes.find((route, index) => index > 0 && route.tasks?.includes(task)) ?? routes[0])?.engine ?? null;
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
				const resolution = resolve(site.id);
				const routes = routesOf(resolution);
				if (routes === null) return null;
				const timeoutMs = resolution.usable?.timeoutMs;
				return await runner.run({ routes, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, site, object, options);
			} catch {
				// Nothing that goes wrong in System One may reach the caller's turn.
				return null;
			}
		},
		shadowed(site: SiteId, moment?: string): boolean {
			try {
				const resolution = resolve(site);
				if (resolution.usable === undefined) return false;
				// Shadow only when every engine taking part last answered unfitted. One
				// validated route keeps the site live, and an engine not yet heard from
				// is unknown, which is never shadow.
				const usable = [resolution.usable, ...(resolution.routes ?? []).flatMap((route) => route.usable ?? [])];
				// Cuts are live settings, so fittedness is recomputed from the identity
				// each engine last answered under, never cached with the answer.
				const cuts = deps.settings().systemOne.cuts;
				return usable.every((engine) => {
					// The runner files each answer under the moment it was asked at; the bare
					// site key never matches a site that is only asked at named moments.
					const last = runner.answeredIdentity(digestOf(engine), site, moment);
					return last !== null && !cutsFor(last.identity, site, cuts, last.contract).fitted;
				});
			} catch {
				// Unknown is not shadow: the caller waits exactly as it did before this existed.
				return false;
			}
		},
		limits(site: SiteId, task: DecisionTask) {
			try {
				const engine = engineForTask(site, task);
				if (engine === null) return null;
				return { windowTokens: engine.windowTokens, maxOptions: maxOptionsOf(engine) };
			} catch {
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
	};
}
