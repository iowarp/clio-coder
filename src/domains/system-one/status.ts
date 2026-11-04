/**
 * What System One will do under these settings, in the words every surface
 * shows. Pure, and it sends nothing.
 */

import type { ClioSettings } from "../../core/config.js";
import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";
import type { ChoiceResolution } from "./selection.js";
import { effectiveSystemOne, resolveChoice } from "./selection.js";

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
	readonly use: string | null;
	readonly scope: string;
	readonly headline: string;
}

function costNote(resolution: ChoiceResolution): string | null {
	if (resolution.kind !== "engine" || resolution.engine.kind !== "llm") return null;
	const where = `${resolution.engine.target}/${resolution.engine.model ?? "target default"}`;
	return `${resolution.name} adds separate completions on ${where}. Requests pass paid-request admission and count against the session's cost ceiling.`;
}

export function describeStatus(input: StatusInput): SystemOneStatus {
	const { use } = input.settings.systemOne;
	const scope = input.settingsOrigin ?? "settings";
	const resolved = resolveChoice(input.settings, use);
	const headline = ((): string => {
		if (resolved.kind === "off") return "off";
		if (resolved.kind === "none") return "off: no engine is chosen";
		if (resolved.kind === "unavailable") return `unavailable: ${resolved.problem}; nothing is sent`;
		const refusal = input.refusedEngines?.get(resolved.name);
		if (refusal !== undefined) return `unavailable: ${refusal}; nothing more is sent`;
		const effective = effectiveSystemOne(input.settings);
		const target = effective.targets.find((entry) => entry.id === resolved.engine.target);
		const required = findBuiltinRuntimeBootMetadata(target?.runtime ?? "")?.credentialsEnvVar;
		if (required !== undefined && input.hasCredential?.(target?.runtime ?? "", required) === false) {
			return `unavailable: ${required} is not set; nothing is sent`;
		}
		const destination = `${resolved.engine.target}/${resolved.engine.model ?? target?.defaultModel ?? "target default"}`;
		return `active: the consult tool is bound to ${resolved.name} → ${destination}`;
	})();
	const cost = costNote(resolved);
	return { use, scope, headline: cost === null ? headline : `${headline}. ${cost}` };
}

/** The lines `/systemone` and `clio-coder systemone status` print. */
export function formatStatus(status: SystemOneStatus): string[] {
	return [`system one (experimental): ${status.headline}`, `choice: ${status.use ?? "unset"} (${status.scope})`];
}
