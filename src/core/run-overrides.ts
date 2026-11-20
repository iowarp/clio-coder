/**
 * Run-scoped option overrides: one-run settings a CLI invocation carries into
 * deep engine code (context-window override, KV-cache mode, sampling params).
 *
 * These ride a single JSON env var, `CLIO_CODER_RUN_OVERRIDES`, instead of one env
 * var per option. The env var is internal plumbing, not an operator surface:
 * operators set the CLI flags (`clio-coder run --max-context-tokens`, sampling
 * flags) or durable settings.yaml keys, and the CLI writes this var for the
 * scope of the run via {@link withRunOverrides}. Env is the transport, rather
 * than an in-process store, because dispatched worker subprocesses inherit
 * `process.env` and must see the same overrides. Keeping it to ONE var means
 * new run-scoped options extend the typed interface here instead of minting
 * another `CLIO_CODER_*` variable with its own ad-hoc parse/save/restore code.
 */

import type { ClioSettings } from "./config.js";

export const RUN_OVERRIDES_ENV = "CLIO_CODER_RUN_OVERRIDES";

export interface RunOverrides {
	/** One-run planning ceiling; cannot enlarge the server's context window. */
	maxContextTokens?: number;
	/**
	 * One-run sampling parameter overrides. Kept as a loose numeric record
	 * here (undefined fields are dropped at serialization);
	 * engine/apis/sampling-overrides.ts narrows it to the known keys.
	 */
	sampling?: Record<string, number | undefined>;
	/**
	 * `run --sandbox required`: tighten-only one-run `safety.sandbox`. Only
	 * `required` exists, the strictest mode, so the override never loosens.
	 */
	sandbox?: "required";
	/**
	 * `run --require-priced`: every dispatch this run admits, nested ones included, is refused when its
	 * resolved route has no known pricing (SPEC 6.9's admission recheck).
	 */
	requirePriced?: true;
}

/** Parse the current overrides. Malformed JSON or fields are dropped, never thrown. */
export function runOverrides(env: NodeJS.ProcessEnv = process.env): RunOverrides {
	const raw = env[RUN_OVERRIDES_ENV]?.trim();
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const record = parsed as Record<string, unknown>;
	const out: RunOverrides = {};
	const maxContextTokens = record.maxContextTokens;
	if (typeof maxContextTokens === "number" && Number.isInteger(maxContextTokens) && maxContextTokens > 0) {
		out.maxContextTokens = maxContextTokens;
	}
	const sampling = record.sampling;
	if (sampling !== null && typeof sampling === "object" && !Array.isArray(sampling)) {
		const numeric: Record<string, number> = {};
		for (const [key, value] of Object.entries(sampling as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isFinite(value)) numeric[key] = value;
		}
		if (Object.keys(numeric).length > 0) out.sampling = numeric;
	}
	if (record.sandbox === "required") out.sandbox = "required";
	if (record.requirePriced === true) out.requirePriced = true;
	return out;
}

/**
 * Why `--require-priced` refuses `route` (`<target>/<model>`), or undefined when the run does not require pricing or
 * the route is priced. `pricedBy` is the route's effective pricing source; only `none` is unpriced.
 */
export function requirePricedRefusal(
	pricedBy: string,
	route: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (pricedBy !== "none" || runOverrides(env).requirePriced !== true) return undefined;
	return `--require-priced: ${route} has no known pricing; declare targets[].pricing for it or choose a priced route`;
}

/**
 * The settings view a run sees under its overrides: `--sandbox required` pins
 * `safety.sandbox` whatever the files say, including after a reload. Mutates and
 * returns `settings`; the config domain applies it to its snapshot only, never to
 * a document it writes.
 */
export function pinRunSettings(settings: ClioSettings, env?: NodeJS.ProcessEnv): ClioSettings {
	if (runOverrides(env).sandbox === "required") settings.safety.sandbox = "required";
	return settings;
}

/**
 * Apply overrides for the duration of `fn`, merged over any overrides already
 * in scope, and restore the previous state afterwards even on throw.
 */
export async function withRunOverrides<T>(overrides: RunOverrides, fn: () => Promise<T>): Promise<T> {
	const entries = Object.entries(overrides).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return fn();
	const previous = process.env[RUN_OVERRIDES_ENV];
	process.env[RUN_OVERRIDES_ENV] = JSON.stringify({ ...runOverrides(), ...Object.fromEntries(entries) });
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[RUN_OVERRIDES_ENV];
		else process.env[RUN_OVERRIDES_ENV] = previous;
	}
}
