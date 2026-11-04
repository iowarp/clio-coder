/**
 * What System One will do under these settings, in the words every surface
 * shows. Pure, and it sends nothing.
 */

import type { ClioSettings } from "../../core/config.js";
import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";
import type { ChoiceResolution } from "./selection.js";
import { effectiveSystemOne, resolveChoice, routeNames } from "./selection.js";

export interface RuntimeLookup {
	get(id: string): { readonly id: string; readonly decide?: unknown } | null;
}

export interface StatusInput {
	readonly settings: Readonly<ClioSettings>;
	readonly settingsOrigin?: string;
	readonly runtimes?: RuntimeLookup;
	/** Whether a runtime's key is available. Absent reads every key as present. */
	readonly hasCredential?: (runtimeId: string, envVar: string) => boolean;
	/** What this process's engines have refused to serve; a separate process cannot know. */
	readonly refusedEngines?: ReadonlyMap<string, string>;
}

export interface SystemOneStatus {
	/** The named routes as the operator wrote them, or null when none is chosen. */
	readonly use: string | null;
	readonly scope: string;
	readonly headline: string;
}

function costNote(resolution: ChoiceResolution): string | null {
	if (resolution.kind !== "engine" || resolution.engine.kind !== "llm") return null;
	const where = `${resolution.engine.target}/${resolution.engine.model ?? "target default"}`;
	return `${resolution.name} adds separate completions on ${where}. Requests pass paid-request admission and count against the session's cost ceiling.`;
}

/** The destination one route reaches, or why it cannot be used. */
function routeReading(input: StatusInput, resolved: ChoiceResolution): { active: string } | { problem: string } {
	if (resolved.kind === "unavailable") return { problem: resolved.problem };
	if (resolved.kind !== "engine") return { problem: "it is not a route" };
	const refusal = input.refusedEngines?.get(resolved.name);
	if (refusal !== undefined) return { problem: refusal };
	const effective = effectiveSystemOne(input.settings, [resolved.name]);
	const target = effective.targets.find((entry) => entry.id === resolved.engine.target);
	const runtimeId = target?.runtime ?? "";
	const required = findBuiltinRuntimeBootMetadata(runtimeId)?.credentialsEnvVar;
	if (required !== undefined && input.hasCredential?.(runtimeId, required) === false) {
		return { problem: `${required} is not set` };
	}
	const destination = `${resolved.engine.target}/${resolved.engine.model ?? target?.defaultModel ?? "target default"}`;
	return { active: `${resolved.name} → ${destination}` };
}

export function describeStatus(input: StatusInput): SystemOneStatus {
	const { use } = input.settings.systemOne;
	const scope = input.settingsOrigin ?? "settings";
	const shown = use === null || use === undefined ? null : typeof use === "string" ? use : use.join(", ");
	const names = routeNames(use);
	if (names.length === 0) return { use: shown, scope, headline: shown === null ? "off: no engine is chosen" : "off" };
	const resolutions = names.map((name) => resolveChoice(input.settings, name));
	const readings = resolutions.map((resolved) => routeReading(input, resolved));
	const active = readings.flatMap((reading) => ("active" in reading ? [reading.active] : []));
	const problems = readings.flatMap((reading, index) =>
		"problem" in reading ? [names.length > 1 ? `${names[index]}: ${reading.problem}` : reading.problem] : [],
	);
	const unusable = problems.join("; ");
	const headline =
		active.length === 0
			? `unavailable: ${unusable}; nothing is sent`
			: `active: the consult tool is bound to ${active.join(", then ")}${unusable.length > 0 ? `; unavailable: ${unusable}` : ""}`;
	const costs = resolutions.flatMap((resolved) => costNote(resolved) ?? []);
	return { use: shown, scope, headline: [headline, ...costs].join(". ") };
}

/** The lines `/systemone` and `clio-coder systemone status` print. */
export function formatStatus(status: SystemOneStatus): string[] {
	return [`system one (experimental): ${status.headline}`, `choice: ${status.use ?? "unset"} (${status.scope})`];
}
