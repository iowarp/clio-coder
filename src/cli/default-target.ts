import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ClioSettings } from "../core/config.js";
import { readSettings } from "../core/config.js";
import { resolveClioDirs } from "../core/xdg.js";
import {
	describeMissing,
	type Missing,
	type SetupFacts,
	type SetupTargetFacts,
	setupStatus,
} from "../domains/lifecycle/setup-status.js";
import { bootAuthStatus } from "../domains/providers/auth/boot-status.js";
import { retiredRuntimeReplacement } from "../domains/providers/retired-runtimes.js";
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
 * Whether a user has made a route choice in this home before the current launch.
 *
 * The file's existence cannot say so: the installer's post-install step,
 * `doctor --fix` and a non-TTY first boot all write the scaffold. A choice
 * leaves a target or a chat route behind, so the raw file is read for either;
 * adopting a detected route adds a target, so a home that adopted once stays
 * returning. Call this before `initializeClioHome()`, which writes the file.
 */
export function homeIsReturning(): boolean {
	let raw: { targets?: unknown; chat?: { target?: unknown } } | null;
	try {
		raw = parseYaml(readFileSync(join(resolveClioDirs().config, "settings.yaml"), "utf8"));
	} catch {
		return false;
	}
	if (!raw || typeof raw !== "object") return false;
	return (Array.isArray(raw.targets) && raw.targets.length > 0) || (raw.chat?.target ?? null) !== null;
}

/**
 * The facts `setupStatus` reads for the saved chat route, gathered cheaply: the runtime's metadata and
 * credential presence, never a probe. Only an unusable answer loads route discovery.
 */
function setupFactsFor(settings: Readonly<ClioSettings>): SetupFacts {
	const targetId = settings.chat.target;
	// A chat target naming an id that is not in `targets` cannot arrive here: the schema normalizes dangling
	// routing references to null, so deleting a target reaches `setupStatus` as an unchosen route.
	const target = targetId ? settings.targets.find((entry) => entry.id === targetId) : undefined;
	if (!target) return { chat: settings.chat };
	const runtime = findBuiltinRuntimeBootMetadata(target.runtime);
	const facts: SetupTargetFacts = {
		id: target.id,
		runtime: target.runtime,
		...(target.url !== undefined ? { url: target.url } : {}),
		...(target.defaultModel !== undefined ? { defaultModel: target.defaultModel } : {}),
		drivesChat: runtime?.kind === "http",
	};
	if (runtime?.kind !== "http") {
		const replacement = retiredRuntimeReplacement(target.runtime);
		return { chat: settings.chat, target: { ...facts, ...(replacement !== null ? { replacement } : {}) } };
	}
	const auth = bootAuthStatus(target, runtime);
	const envVariable = target.auth?.apiKeyEnvVar?.trim();
	if (auth.required) {
		facts.credential = {
			available: auth.available,
			provider: auth.providerId,
			...(envVariable ? { envVariable } : {}),
		};
	}
	return { chat: settings.chat, target: facts };
}

export function classifyDefaultTarget(settings: Readonly<ClioSettings> = readSettings()): DefaultTargetVerdict {
	const facts = setupFactsFor(settings);
	const status = setupStatus(facts);
	if (status.stage === "choose") return { kind: "no-target" };
	if (status.stage === "ready") return { kind: "usable" };
	const first = status.missing[0];
	switch (first?.kind) {
		case "runtime":
			return { kind: "ineligible-runtime", targetId: first.target, runtime: first.runtime };
		case "model":
			return { kind: "no-model", targetId: first.target };
		default:
			return {
				kind: "missing-credential",
				targetId: status.route.target,
				store: facts.target?.credential?.provider ?? status.route.target,
			};
	}
}

/** The first thing the saved chat route lacks, for a verdict that is not usable and names a target. */
export function firstMissing(settings: Readonly<ClioSettings>): Missing | null {
	const status = setupStatus(setupFactsFor(settings));
	return status.stage === "needs" ? (status.missing[0] ?? null) : null;
}

/** One sentence naming what is wrong, for the causes target selection can fix. */
export function describeVerdict(verdict: DefaultTargetVerdict): string {
	switch (verdict.kind) {
		case "no-target":
			return "No model target is configured.";
		case "ineligible-runtime": {
			const replacement = retiredRuntimeReplacement(verdict.runtime);
			return describeMissing({
				kind: "runtime",
				target: verdict.targetId,
				runtime: verdict.runtime,
				...(replacement !== null ? { replacement } : {}),
			}).sentence;
		}
		case "no-model":
			return describeMissing({ kind: "model", target: verdict.targetId }).sentence;
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
	const missing = firstMissing(settings) ?? { kind: "credential", target: verdict.targetId, provider: verdict.store };
	return `Chat: ${verdict.targetId}${model ? ` / ${model}` : ""} is unavailable. ${describeMissing(missing).sentence} Your saved chat route is kept.`;
}
