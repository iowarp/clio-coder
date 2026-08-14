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

export const RUN_OVERRIDES_ENV = "CLIO_CODER_RUN_OVERRIDES";

export interface RunOverrides {
	/** One-run context-window override for supported local runtimes. */
	maxContextTokens?: number;
	/** One-run KV-cache quantization mode; the consuming runtime validates it. */
	kvCacheMode?: string;
	/**
	 * One-run sampling parameter overrides. Kept as a loose numeric record
	 * here (undefined fields are dropped at serialization);
	 * engine/apis/sampling-overrides.ts narrows it to the known keys.
	 */
	sampling?: Record<string, number | undefined>;
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
	if (typeof record.kvCacheMode === "string" && record.kvCacheMode.length > 0) {
		out.kvCacheMode = record.kvCacheMode;
	}
	const sampling = record.sampling;
	if (sampling !== null && typeof sampling === "object" && !Array.isArray(sampling)) {
		const numeric: Record<string, number> = {};
		for (const [key, value] of Object.entries(sampling as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isFinite(value)) numeric[key] = value;
		}
		if (Object.keys(numeric).length > 0) out.sampling = numeric;
	}
	return out;
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
