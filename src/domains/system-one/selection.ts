/**
 * The one setting that opts in to System One.
 *
 * `systemOne.use` names what answers: `jev`, `memory`, `main`, a declared engine
 * or a target. Unset and `off` both send nothing. `clio-coder run --systemone`
 * sets the same choice for one run, so no second way of opting in exists.
 * Nothing here constructs an engine, reads a credential or sends a request.
 */

import type { ClioSettings } from "../../core/config.js";
import { getRuntimeRegistry } from "../providers/registry.js";
import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";
import { TYPESAFE_DEFAULT_MODEL } from "../providers/runtimes/typesafe-model.js";

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

/** The settings System One resolves its engine from: the choice expanded into a declared engine and any target it brings. */
export function effectiveSystemOne(
	settings: Readonly<ClioSettings>,
	choice: string | null | undefined = settings.systemOne.use,
): Readonly<ClioSettings> {
	const resolved = resolveChoice(settings, choice);
	if (resolved.kind !== "engine") return settings;
	return {
		...settings,
		targets: resolved.impliedTarget !== undefined ? [...settings.targets, resolved.impliedTarget] : settings.targets,
		systemOne: {
			...settings.systemOne,
			engines: { ...settings.systemOne.engines, [resolved.name]: resolved.engine },
		},
	};
}
