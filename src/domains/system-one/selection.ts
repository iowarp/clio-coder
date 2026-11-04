/**
 * The one setting that opts in to System One.
 *
 * `systemOne.use` is an ordered route list, written as one name or a list: `jev`,
 * `memory`, `main`, a declared engine or a target. Unset and `off` send nothing, and
 * a route the operator did not name is never used. `clio-coder run --systemone` sets
 * the same list for one run. Nothing here constructs an engine, reads a credential
 * or sends a request.
 */

import type { ClioSettings } from "../../core/config.js";
import type { SystemOneUse } from "../../core/defaults.js";
import { getRuntimeRegistry } from "../providers/registry.js";
import { BUILTIN_RUNTIME_BOOT_MANIFEST, findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";

export const SYSTEM_ONE_OFF = "off";

type EngineSettings = ClioSettings["systemOne"]["engines"][string];

export type ChoiceResolution =
	| { readonly kind: "off" }
	| { readonly kind: "none" }
	| {
			readonly kind: "engine";
			readonly name: string;
			readonly engine: EngineSettings;
			/** A target the choice brings with it: a hosted decision service needs only its key, not a `targets` entry. */
			readonly impliedTarget?: ClioSettings["targets"][number];
	  }
	| { readonly kind: "unavailable"; readonly name: string; readonly problem: string };

/** The named routes in order. `off` anywhere in the list turns everything off. */
export function routeNames(use: SystemOneUse | undefined): ReadonlyArray<string> {
	if (use === null || use === undefined) return [];
	const names = typeof use === "string" ? [use] : use;
	return names.includes(SYSTEM_ONE_OFF) ? [] : [...new Set(names)];
}

/** A list as a flag or a CLI argument writes it: `jev,main`. One name stays one name. */
export function parseRouteList(text: string): string | string[] {
	const names = text
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	return names.length === 1 ? (names[0] as string) : names;
}

/**
 * The runtime that claims `name` as its route. Read from the registered descriptors and the boot manifest
 * (a process with no hydrated providers still has to resolve it), which a test keeps equal to the descriptors.
 */
function aliasedRuntime(name: string) {
	const claims = (runtime: { readonly decisionAlias?: { readonly name: string } }): boolean =>
		runtime.decisionAlias?.name === name;
	return getRuntimeRegistry().list().find(claims) ?? BUILTIN_RUNTIME_BOOT_MANIFEST.find(claims) ?? null;
}

/** Whether a runtime answers typed decisions. A boot entry says what its descriptor implements. */
function runtimeDecides(id: string): boolean {
	const registered = getRuntimeRegistry().get(id);
	return registered !== null ? registered.decide !== undefined : findBuiltinRuntimeBootMetadata(id)?.decides === true;
}

/** What `name` means under these settings. A choice that cannot run says why, and nothing borrows another route. */
export function resolveChoice(settings: Readonly<ClioSettings>, name: string | null | undefined): ChoiceResolution {
	if (name === null || name === undefined) return { kind: "none" };
	if (name === SYSTEM_ONE_OFF) return { kind: "off" };
	const declared = Object.hasOwn(settings.systemOne.engines, name) ? settings.systemOne.engines[name] : undefined;
	if (declared !== undefined) return { kind: "engine", name, engine: declared };
	const aliased = aliasedRuntime(name);
	if (aliased?.decisionAlias !== undefined) {
		const { defaultModel, profile } = aliased.decisionAlias;
		const target = settings.targets.find((entry) => entry.runtime === aliased.id);
		const engine: EngineSettings = {
			kind: "systemone",
			target: target?.id ?? name,
			model: target?.defaultModel ?? defaultModel,
			profile,
		};
		return target !== undefined
			? { kind: "engine", name, engine }
			: { kind: "engine", name, engine, impliedTarget: { id: name, runtime: aliased.id } };
	}
	if (name === "main") {
		const { target, model } = settings.chat;
		if (!target) return { kind: "unavailable", name, problem: "no chat route is configured" };
		return { kind: "engine", name, engine: { kind: "llm", target, ...(model ? { model } : {}) } };
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
		return { kind: "engine", name, engine: { kind: "llm", target, model } };
	}
	const target = settings.targets.find((entry) => entry.id === name);
	if (target === undefined) {
		return { kind: "unavailable", name, problem: `'${name}' is not a known route, engine or target` };
	}
	return {
		kind: "engine",
		name,
		engine: runtimeDecides(target.runtime) ? { kind: "systemone", target: name } : { kind: "llm", target: name },
	};
}

/** The settings System One resolves from: each named route expanded into an engine and any target it brings. */
export function effectiveSystemOne(
	settings: Readonly<ClioSettings>,
	use: SystemOneUse | undefined = settings.systemOne.use,
): Readonly<ClioSettings> {
	const engines = { ...settings.systemOne.engines };
	const targets = [...settings.targets];
	for (const name of routeNames(use)) {
		const resolved = resolveChoice(settings, name);
		if (resolved.kind !== "engine") continue;
		engines[resolved.name] = resolved.engine;
		if (resolved.impliedTarget !== undefined) targets.push(resolved.impliedTarget);
	}
	return { ...settings, targets, systemOne: { ...settings.systemOne, engines } };
}
