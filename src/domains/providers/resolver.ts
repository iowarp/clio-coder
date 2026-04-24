import type { EndpointStatus, ProvidersContract } from "./contract.js";
import { listKnownModelsForRuntime } from "./support.js";
import { type ThinkingLevel, VALID_THINKING_LEVELS } from "./types/capability-flags.js";

export interface ResolvedModelRef {
	endpoint: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ResolveModelResult {
	ref: ResolvedModelRef | null;
	/** Set when the input was non-empty but no candidate could match. */
	error?: string;
	/** Set when multiple candidates matched; the first is returned. */
	warning?: string;
}

const GLOB_CHARS = /[*?[]/;

function isThinkingLevel(token: string): token is ThinkingLevel {
	return (VALID_THINKING_LEVELS as ReadonlyArray<string>).includes(token);
}

/**
 * Strip an optional `:thinkingLevel` suffix. Only `low`/`medium`/`high`/etc.
 * are recognised; anything else is considered part of the model id (which can
 * legitimately contain colons, e.g. OpenRouter's `model:exacto`).
 */
export function splitThinkingSuffix(pattern: string): { base: string; thinkingLevel?: ThinkingLevel } {
	const idx = pattern.lastIndexOf(":");
	if (idx === -1) return { base: pattern };
	const suffix = pattern.slice(idx + 1).trim();
	if (!isThinkingLevel(suffix)) return { base: pattern };
	const base = pattern.slice(0, idx).trim();
	return base ? { base, thinkingLevel: suffix } : { base: pattern };
}

/** Convert a `*`/`?`/`[…]` glob into an anchored case-insensitive regex. */
function globToRegExp(glob: string): RegExp {
	let body = "^";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] ?? "";
		if (ch === "*") {
			body += ".*";
		} else if (ch === "?") {
			body += ".";
		} else if (ch === "[") {
			const close = glob.indexOf("]", i + 1);
			if (close === -1) {
				body += "\\[";
				continue;
			}
			body += `[${glob.slice(i + 1, close)}]`;
			i = close;
		} else if (/[.+^${}()|\\]/.test(ch)) {
			body += `\\${ch}`;
		} else {
			body += ch;
		}
	}
	body += "$";
	return new RegExp(body, "i");
}

interface CandidateRef {
	endpoint: string;
	model: string;
	full: string;
}

function collectCandidates(providers: ProvidersContract): CandidateRef[] {
	const out: CandidateRef[] = [];
	const seen = new Set<string>();
	for (const status of providers.list()) {
		for (const model of modelsForStatus(status)) {
			const key = `${status.endpoint.id}/${model}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ endpoint: status.endpoint.id, model, full: key });
		}
	}
	return out;
}

function modelsForStatus(status: EndpointStatus): string[] {
	const wireModels = status.endpoint.wireModels ?? [];
	if (wireModels.length > 0) return [...wireModels];
	if (status.discoveredModels.length > 0) {
		const dedup = new Set<string>();
		if (status.endpoint.defaultModel) dedup.add(status.endpoint.defaultModel);
		for (const m of status.discoveredModels) dedup.add(m);
		return [...dedup];
	}
	const known = listKnownModelsForRuntime(status.runtime?.id ?? status.endpoint.runtime);
	if (known.length > 0) {
		const dedup = new Set<string>();
		if (status.endpoint.defaultModel) dedup.add(status.endpoint.defaultModel);
		for (const m of known) dedup.add(m);
		return [...dedup];
	}
	return status.endpoint.defaultModel ? [status.endpoint.defaultModel] : [];
}

function pickFirst(candidates: CandidateRef[]): { ref: CandidateRef; ambiguous: boolean } | null {
	if (candidates.length === 0) return null;
	const head = candidates[0];
	if (!head) return null;
	return { ref: head, ambiguous: candidates.length > 1 };
}

function buildResult(
	pattern: string,
	pick: { ref: CandidateRef; ambiguous: boolean } | null,
	thinkingLevel: ThinkingLevel | undefined,
): ResolveModelResult {
	if (!pick) {
		return { ref: null, error: `no models match pattern "${pattern}"` };
	}
	const ref: ResolvedModelRef = { endpoint: pick.ref.endpoint, model: pick.ref.model };
	if (thinkingLevel) ref.thinkingLevel = thinkingLevel;
	const result: ResolveModelResult = { ref };
	if (pick.ambiguous) {
		result.warning = `pattern "${pattern}" matched multiple models; using ${pick.ref.full}`;
	}
	return result;
}

/**
 * Resolve a user-supplied model pattern against the configured targets.
 * Order of attempts:
 *   1. Exact `target/model` reference (case-insensitive).
 *   2. Glob (`*`, `?`, `[…]`) against `target/model` and bare `model`.
 *   3. Bare model id, exact case-insensitive.
 *   4. Bare model id, case-insensitive substring.
 *
 * Trailing `:low`/`:medium`/`:high`/`:xhigh`/`:minimal`/`:off` is parsed off
 * before matching and surfaced on the returned ref so callers can apply it
 * to settings.orchestrator.thinkingLevel.
 */
export function resolveModelReference(rawPattern: string, providers: ProvidersContract): ResolveModelResult {
	const trimmed = rawPattern.trim();
	if (!trimmed) return { ref: null, error: "empty pattern" };

	const { base, thinkingLevel } = splitThinkingSuffix(trimmed);
	const candidates = collectCandidates(providers);
	if (candidates.length === 0) {
		return { ref: null, error: "no targets configured; add one with `clio configure` or `clio targets add`" };
	}

	const lower = base.toLowerCase();

	const exactFull = candidates.filter((c) => c.full.toLowerCase() === lower);
	if (exactFull.length > 0) return buildResult(base, pickFirst(exactFull), thinkingLevel);

	if (GLOB_CHARS.test(base)) {
		const re = globToRegExp(base);
		const globMatches = candidates.filter((c) => re.test(c.full) || re.test(c.model));
		return buildResult(base, pickFirst(globMatches), thinkingLevel);
	}

	const slashIdx = base.indexOf("/");
	if (slashIdx !== -1) {
		const ep = base.slice(0, slashIdx).toLowerCase();
		const mdl = base.slice(slashIdx + 1).toLowerCase();
		const epModel = candidates.filter((c) => c.endpoint.toLowerCase() === ep && c.model.toLowerCase() === mdl);
		if (epModel.length > 0) return buildResult(base, pickFirst(epModel), thinkingLevel);
	}

	const exactModel = candidates.filter((c) => c.model.toLowerCase() === lower);
	if (exactModel.length > 0) return buildResult(base, pickFirst(exactModel), thinkingLevel);

	const partial = candidates.filter((c) => c.model.toLowerCase().includes(lower));
	return buildResult(base, pickFirst(partial), thinkingLevel);
}
