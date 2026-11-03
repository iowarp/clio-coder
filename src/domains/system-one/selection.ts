/**
 * The one setting that opts in to System One.
 *
 * `systemOne.use` names what answers: `jev`, `memory`, `main`, a declared engine
 * or a target. Unset is off, except for sites bound one by one under
 * `systemOne.sites`; `off` masks everything, per-site entries included. A task
 * or session override and `clio-coder run --systemone` set the same choice, so
 * no second way of opting in exists. Nothing here constructs an engine, reads a
 * credential or sends a request.
 */

import type { ClioSettings } from "../../core/config.js";
import { getRuntimeRegistry } from "../providers/registry.js";
import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";
import { TYPESAFE_DEFAULT_MODEL } from "../providers/runtimes/typesafe-model.js";
import type { SiteId } from "./types.js";

/**
 * What the one setting binds. The record-only sites stay out because they spend requests without changing behavior.
 * `consult` stays out because its tool sends agent-supplied state and file excerpts, which takes its own
 * `systemOne.sites.consult` entry on every engine.
 */
export const ACTIVE_PROFILE: ReadonlyArray<SiteId> = ["turn", "workerPrepare", "toolCall", "relevance", "drafts"];

/** Asked only for the dataset: no reader takes these answers, so `use` never binds them. */
export const RECORD_ONLY_SITES: ReadonlyArray<SiteId> = ["toolResult", "turnEnd", "steer"];

export const SYSTEM_ONE_OFF = "off";

type EngineSettings = ClioSettings["systemOne"]["engines"][string];

const DECISION_RUNTIMES: ReadonlySet<string> = new Set(["typesafe-jev", "systemone", "inception"]);

export type ChoiceResolution =
	| { readonly kind: "off" }
	| { readonly kind: "none" }
	| {
			readonly kind: "engine";
			readonly name: string;
			readonly engine: EngineSettings;
			/** A target the choice brings with it: Jev needs only its key, not a `targets` entry. */
			readonly impliedTarget?: ClioSettings["targets"][number];
	  }
	| { readonly kind: "unavailable"; readonly name: string; readonly problem: string };

/** What `name` means under these settings. A choice that cannot run says why, and nothing borrows another route. */
export function resolveChoice(settings: Readonly<ClioSettings>, name: string | null | undefined): ChoiceResolution {
	if (name === null || name === undefined) return { kind: "none" };
	if (name === SYSTEM_ONE_OFF) return { kind: "off" };
	const declared = Object.hasOwn(settings.systemOne.engines, name) ? settings.systemOne.engines[name] : undefined;
	if (declared !== undefined) return { kind: "engine", name, engine: declared };
	if (name === "jev") {
		const target = settings.targets.find((entry) => entry.runtime === "typesafe-jev");
		const model = target?.defaultModel ?? TYPESAFE_DEFAULT_MODEL;
		const engine: EngineSettings = { kind: "systemone", target: target?.id ?? "jev", model, profile: "jev" };
		return target !== undefined
			? { kind: "engine", name, engine }
			: { kind: "engine", name, engine, impliedTarget: { id: "jev", runtime: "typesafe-jev" } };
	}
	if (name === "main") {
		const { target, model } = settings.chat;
		if (!target) return { kind: "unavailable", name, problem: "no chat route is configured" };
		return { kind: "engine", name, engine: { kind: "llm", target, mode: "batch", ...(model ? { model } : {}) } };
	}
	if (name === "memory") {
		const { target, model } = settings.context.memory;
		if (!target || !model) {
			return {
				kind: "unavailable",
				name,
				problem: "context.memory names no target and model, and memory never falls back to the chat route",
			};
		}
		return { kind: "engine", name, engine: { kind: "llm", target, model, mode: "batch" } };
	}
	const target = settings.targets.find((entry) => entry.id === name);
	if (target === undefined) {
		return { kind: "unavailable", name, problem: `'${name}' is not jev, memory, main, an engine or a target` };
	}
	const runtime = getRuntimeRegistry().get(target.runtime) ?? findBuiltinRuntimeBootMetadata(target.runtime);
	const decides = DECISION_RUNTIMES.has(runtime?.id ?? target.runtime);
	return {
		kind: "engine",
		name,
		engine: decides ? { kind: "systemone", target: name } : { kind: "llm", target: name, mode: "batch" },
	};
}

/** The settings System One resolves bindings from: the choice expanded, a site's own entry winning over it. */
export function effectiveSystemOne(
	settings: Readonly<ClioSettings>,
	choice: string | null | undefined = settings.systemOne.use,
): Readonly<ClioSettings> {
	const resolved = resolveChoice(settings, choice);
	const explicit = Object.fromEntries(
		Object.entries(settings.systemOne.sites).filter(([, binding]) => binding !== null),
	) as ClioSettings["systemOne"]["sites"];
	if (resolved.kind === "off") return { ...settings, systemOne: { ...settings.systemOne, sites: {} } };
	if (resolved.kind === "none") return { ...settings, systemOne: { ...settings.systemOne, sites: explicit } };
	const sites: ClioSettings["systemOne"]["sites"] = {};
	for (const site of ACTIVE_PROFILE) sites[site] = resolved.name;
	// A later entry for a site overrides the one setting, and a null turns that site off.
	for (const [site, binding] of Object.entries(settings.systemOne.sites)) {
		if (binding === null) delete sites[site as SiteId];
		else if (binding !== undefined) sites[site as SiteId] = binding;
	}
	return {
		...settings,
		targets:
			resolved.kind === "engine" && resolved.impliedTarget !== undefined
				? [...settings.targets, resolved.impliedTarget]
				: settings.targets,
		systemOne: {
			...settings.systemOne,
			engines:
				resolved.kind === "engine"
					? { ...settings.systemOne.engines, [resolved.name]: resolved.engine }
					: settings.systemOne.engines,
			sites,
		},
	};
}
