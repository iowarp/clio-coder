import { getCatalogModelForRuntime } from "./catalog.js";
import type { ProvidersContract } from "./contract.js";
import { isOrchestratorEligibleRuntime } from "./eligibility.js";
import { modelCandidatesForStatus } from "./model-discovery.js";
import { modelDateMs, modelFamilyForId } from "./model-recency.js";
import type { ThinkingLevel } from "./types/capability-flags.js";
import { VALID_THINKING_LEVELS } from "./types/capability-flags.js";

export interface ResolveModelOptions {
	use?: "chat";
	preferTarget?: string;
}

export interface ResolvedModelRef {
	target: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ResolveModelResult {
	ref: ResolvedModelRef | null;
	/** Set when the input was non-empty but no candidate could match. */
	error?: string;
	/** Set when multiple candidates matched; explains which concrete id won. */
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
	target: string;
	model: string;
	full: string;
	chatEligible: boolean;
	dateMs: number | null;
}

function collectCandidates(providers: ProvidersContract): CandidateRef[] {
	const out: CandidateRef[] = [];
	const seen = new Set<string>();
	for (const status of providers.list()) {
		for (const candidate of modelCandidatesForStatus(status)) {
			const model = candidate.id;
			const key = `${status.target.id}/${model}`;
			if (seen.has(key)) continue;
			seen.add(key);
			// Pi catalogs without a release date retain their existing order (#416).
			const catalog = getCatalogModelForRuntime(status.runtime?.id ?? status.target.runtime, model) as
				| { releaseDate?: string; release_date?: string }
				| undefined;
			out.push({
				target: status.target.id,
				model,
				full: key,
				dateMs: modelDateMs(candidate.createdAt) ?? modelDateMs(catalog?.releaseDate ?? catalog?.release_date),
				chatEligible:
					!!status.runtime && isOrchestratorEligibleRuntime(status.runtime) && status.target.capabilities?.chat !== false,
			});
		}
	}
	return out;
}

function matchCandidates(base: string, candidates: CandidateRef[]): CandidateRef[] {
	const lower = base.toLowerCase();
	const exactFull = candidates.filter((c) => c.full.toLowerCase() === lower);
	if (exactFull.length > 0) return exactFull;

	if (GLOB_CHARS.test(base)) {
		const re = globToRegExp(base);
		return candidates.filter((c) => re.test(c.full) || re.test(c.model));
	}

	const exactModel = candidates.filter((c) => c.model.toLowerCase() === lower);
	if (exactModel.length > 0) return exactModel;

	return candidates.filter((c) => c.model.toLowerCase().includes(lower));
}

function buildResult(
	pattern: string,
	candidates: CandidateRef[],
	thinkingLevel: ThinkingLevel | undefined,
	options: ResolveModelOptions,
): ResolveModelResult {
	if (options.preferTarget !== undefined) {
		candidates = [
			...candidates.filter((candidate) => candidate.target === options.preferTarget),
			...candidates.filter((candidate) => candidate.target !== options.preferTarget),
		];
	}
	const first = candidates[0];
	if (!first) {
		return { ref: null, error: `no models match pattern "${pattern}"` };
	}
	// Preserve the active target and unrelated-family ordering when ranking dates (#416).
	const family = modelFamilyForId(first.model);
	const preferred = first.target === options.preferTarget ? options.preferTarget : undefined;
	const familyMatches = candidates.filter(
		(candidate) =>
			(preferred === undefined || candidate.target === preferred) &&
			family !== null &&
			modelFamilyForId(candidate.model) === family,
	);
	const chosen = familyMatches.reduce(
		(best, candidate) => (candidate.dateMs !== null && candidate.dateMs > (best.dateMs ?? -Infinity) ? candidate : best),
		first,
	);
	const newest = familyMatches.length > 1 && chosen.dateMs !== null;
	const ref: ResolvedModelRef = { target: chosen.target, model: chosen.model };
	if (thinkingLevel) ref.thinkingLevel = thinkingLevel;
	const result: ResolveModelResult = { ref };
	if (candidates.length > 1) {
		const listed = candidates
			.slice(0, 3)
			.map((candidate) => candidate.full)
			.join(" and ");
		const remaining = candidates.length > 3 ? ` and ${candidates.length - 3} more` : "";
		result.warning =
			options.use === "chat"
				? `pattern "${pattern}" matched ${listed}${remaining}; using ${chosen.full}`
				: `pattern "${pattern}" matched multiple models; using ${chosen.full}`;
		if (newest) result.warning += ` (newest of ${familyMatches.length} matches)`;
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
 * to settings.chat.thinkingLevel.
 */
export function resolveModelReference(
	rawPattern: string,
	providers: ProvidersContract,
	options: ResolveModelOptions = {},
): ResolveModelResult {
	const trimmed = rawPattern.trim();
	if (!trimmed) return { ref: null, error: "empty pattern" };

	const { base, thinkingLevel } = splitThinkingSuffix(trimmed);
	const candidates = collectCandidates(providers);
	if (candidates.length === 0) {
		return { ref: null, error: "no targets configured; add one with `clio-coder configure` or `clio-coder targets add`" };
	}

	// Preserve exact-id precedence before excluding worker-only targets (#416).
	const allMatches = matchCandidates(base, candidates);
	const matches = options.use === "chat" ? allMatches.filter((candidate) => candidate.chatEligible) : allMatches;
	if (options.use === "chat" && matches.length === 0) {
		const targets = [...new Set(allMatches.map((candidate) => candidate.target))];
		if (targets.length > 0) {
			return {
				ref: null,
				error: `pattern "${base}" matched ${targets.length === 1 ? "target" : "targets"} ${targets.join(", ")}, but ${targets.length === 1 ? "it is" : "they are"} not chat-eligible; chat needs a loaded HTTP runtime with chat enabled`,
			};
		}
	}
	return buildResult(base, matches, thinkingLevel, options);
}
