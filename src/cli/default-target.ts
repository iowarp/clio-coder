import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClioSettings } from "../core/config.js";
import { readSettings } from "../core/config.js";
import { resolveClioDirs } from "../core/xdg.js";
import { bootAuthStatus } from "../domains/providers/auth/boot-status.js";
import { findBuiltinRuntimeBootMetadata } from "../domains/providers/runtimes/boot-manifest.js";

/**
 * Why the configured chat target cannot be used, in the operator's terms
 * rather than as one boolean.
 *
 * This stays a cheap credential-presence check. Only an unusable verdict
 * loads route discovery; a configured user never pays for local probes.
 */
export type DefaultTargetVerdict =
	| { kind: "usable" }
	| { kind: "no-target" }
	| { kind: "no-model"; targetId: string }
	| { kind: "ineligible-runtime"; targetId: string; runtime: string }
	| { kind: "missing-credential"; targetId: string; store: string };

/**
 * Whether this home has written a settings file before the current launch.
 *
 * Directory existence cannot say so: `clioConfigDir()` and its siblings create
 * the directory they are asked about, and the graphical app's server asks on
 * boot, so opening the app once would make the terminal treat a first run as a
 * returning one. Call this before `initializeClioHome()`, which writes the file.
 */
export function homeIsReturning(): boolean {
	return existsSync(join(resolveClioDirs().config, "settings.yaml"));
}

export function classifyDefaultTarget(settings: Readonly<ClioSettings> = readSettings()): DefaultTargetVerdict {
	const targetId = settings.chat.target;
	if (!targetId) return { kind: "no-target" };
	// A chat target naming an id that is not in `targets` cannot arrive here:
	// the schema normalizes dangling routing references to null so that
	// deleting a target does not brick every session mentioning it. Deletion
	// therefore reaches this function as `no-target`, and a fourth verdict for
	// it would be a case no settings file can produce.
	const target = settings.targets.find((entry) => entry.id === targetId);
	if (!target) return { kind: "no-target" };
	const runtime = findBuiltinRuntimeBootMetadata(target.runtime);
	if (runtime?.kind !== "http") {
		return { kind: "ineligible-runtime", targetId, runtime: target.runtime };
	}
	if (!settings.chat.model && !target.defaultModel) return { kind: "no-model", targetId };
	const auth = bootAuthStatus(target, runtime);
	if (auth.available) return { kind: "usable" };
	return { kind: "missing-credential", targetId, store: auth.providerId };
}

/** One sentence naming what is wrong, for the causes target selection can fix. */
export function describeVerdict(verdict: DefaultTargetVerdict): string {
	switch (verdict.kind) {
		case "no-target":
			return "No model target is configured.";
		case "ineligible-runtime":
			return `Target '${verdict.targetId}' runs on '${verdict.runtime}', which cannot drive the main agent.`;
		case "no-model":
			return `Target '${verdict.targetId}' has no chat model configured.`;
		default:
			return "No usable default target is configured.";
	}
}

/**
 * The startup line for a saved chat route whose credential is missing.
 *
 * The route is the user's explicit choice, so startup keeps it and says what
 * is wrong with it. Discovery used to replace it for the session with the first
 * reachable target, which could be the endpoint dedicated to background memory.
 * Only names are printed: the target, its model, and where a credential is read.
 */
export function describeKeptChatRoute(
	settings: Readonly<ClioSettings>,
	verdict: Extract<DefaultTargetVerdict, { kind: "missing-credential" }>,
): string {
	const target = settings.targets.find((entry) => entry.id === verdict.targetId);
	const model = settings.chat.model ?? target?.defaultModel;
	const envVar = target?.auth?.apiKeyEnvVar?.trim();
	const source = envVar
		? `environment variable ${envVar} is not set and no credential is stored for '${verdict.store}'`
		: `no credential is stored for '${verdict.store}'`;
	return `Chat: ${verdict.targetId}${model ? ` / ${model}` : ""} is unavailable: ${source}. Your saved chat route is kept; fix the connection with /config.`;
}
