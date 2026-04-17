import { supportsXhighModel } from "../../engine/ai.js";
import type { Model } from "../../engine/types.js";
import { PROVIDER_CATALOG, type ProviderId, isLocalEngineId } from "./catalog.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

const THINKING_LEVELS_WITHOUT_XHIGH: readonly ThinkingLevel[] = VALID_THINKING_LEVELS.filter(
	(level) => level !== "xhigh",
);

export function isValidThinkingLevel(value: string): value is ThinkingLevel {
	return (VALID_THINKING_LEVELS as readonly string[]).includes(value);
}

/** True when the model exposes pi-ai's `reasoning` capability flag. */
export function supportsThinking(model: Model<never> | undefined): boolean {
	return !!(model as { reasoning?: boolean } | undefined)?.reasoning;
}

/**
 * Delegates to pi-ai's canonical `supportsXhigh` helper via the engine wrapper
 * so the gate stays in sync with model registry updates. Returns false when no
 * model is supplied.
 */
export function supportsXhighThinking(model: Model<never> | undefined): boolean {
	return supportsXhighModel(model);
}

/**
 * Pure lookup of the thinking levels an active model accepts. Used by the
 * /thinking overlay and Shift+Tab cycling to clamp choices to model capability.
 */
export function getAvailableThinkingLevels(model: Model<never> | undefined): readonly ThinkingLevel[] {
	if (!supportsThinking(model)) return ["off"];
	return supportsXhighThinking(model) ? VALID_THINKING_LEVELS : THINKING_LEVELS_WITHOUT_XHIGH;
}

export interface ResolvedModelRef {
	providerId: ProviderId;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ResolveOptions {
	providerId?: ProviderId;
	fuzzy?: boolean;
}

export interface ResolveResult {
	matches: ResolvedModelRef[];
	diagnostic?: string;
}

export function parseModelPattern(pattern: string): {
	provider?: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
} | null {
	const trimmed = pattern.trim();
	if (!trimmed) return null;
	const slashIdx = trimmed.lastIndexOf("/");
	const providerPart = slashIdx === -1 ? undefined : trimmed.slice(0, slashIdx).trim();
	const remainder = slashIdx === -1 ? trimmed : trimmed.slice(slashIdx + 1).trim();
	if (!remainder) return null;
	const colonIdx = remainder.lastIndexOf(":");
	if (colonIdx !== -1) {
		const modelPart = remainder.slice(0, colonIdx).trim();
		const thinkingPart = remainder.slice(colonIdx + 1).trim();
		if (modelPart && isValidThinkingLevel(thinkingPart)) {
			return providerPart
				? { provider: providerPart, model: modelPart, thinkingLevel: thinkingPart }
				: { model: modelPart, thinkingLevel: thinkingPart };
		}
	}
	return providerPart ? { provider: providerPart, model: remainder } : { model: remainder };
}

function compileGlob(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|\\]/g, "\\$&");
	const compiled = escaped
		.replace(/\*\*/g, "__CLIO_DOUBLE_STAR__")
		.replace(/\*/g, "[^/]*")
		.replace(/__CLIO_DOUBLE_STAR__/g, ".*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${compiled}$`, "i");
}

function hasGlobSyntax(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function scoreModelMatch(
	pattern: string,
	modelId: string,
	opts: { fuzzy: boolean; hasGlob: boolean; glob: RegExp | null },
): number {
	if (modelId === pattern) return 0;
	if (modelId.toLowerCase() === pattern.toLowerCase()) return 1;
	if (modelId.toLowerCase().startsWith(pattern.toLowerCase())) return 2;
	if (opts.hasGlob && opts.glob?.test(modelId)) return 3;
	if (opts.fuzzy && modelId.toLowerCase().includes(pattern.toLowerCase())) return 4;
	return -1;
}

export function resolveModelPattern(pattern: string, options: ResolveOptions = {}): ResolveResult {
	const parsed = parseModelPattern(pattern);
	if (!parsed) {
		return { matches: [], diagnostic: "empty pattern" };
	}
	const providerFilter = parsed.provider ?? options.providerId;
	const providerMatcher = providerFilter ? (hasGlobSyntax(providerFilter) ? compileGlob(providerFilter) : null) : null;
	const candidates: Array<{ rank: number; ref: ResolvedModelRef }> = [];
	const modelGlob = hasGlobSyntax(parsed.model) ? compileGlob(parsed.model) : null;
	const fuzzy = options.fuzzy === true;

	for (const provider of PROVIDER_CATALOG) {
		if (providerFilter) {
			if (providerMatcher) {
				if (!providerMatcher.test(provider.id)) continue;
			} else if (provider.id !== providerFilter) {
				continue;
			}
		}
		if (provider.models.length === 0 && isLocalEngineId(provider.id)) {
			candidates.push({
				rank: 0,
				ref: {
					providerId: provider.id,
					modelId: parsed.model,
					...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
				},
			});
			continue;
		}
		for (const model of provider.models) {
			const rank = scoreModelMatch(parsed.model, model.id, { fuzzy, hasGlob: modelGlob !== null, glob: modelGlob });
			if (rank < 0) continue;
			candidates.push({
				rank,
				ref: {
					providerId: provider.id,
					modelId: model.id,
					...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
				},
			});
		}
	}

	candidates.sort((a, b) => a.rank - b.rank);
	const seen = new Set<string>();
	const matches: ResolvedModelRef[] = [];
	for (const { ref } of candidates) {
		const key = `${ref.providerId}::${ref.modelId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		matches.push(ref);
	}
	if (matches.length === 0) {
		return { matches: [], diagnostic: `no model matches '${pattern}'` };
	}
	return { matches };
}

export function resolveModelScope(patterns: readonly string[], options: ResolveOptions = {}): ResolveResult {
	const seen = new Set<string>();
	const matches: ResolvedModelRef[] = [];
	const missing: string[] = [];
	for (const pattern of patterns) {
		const { matches: inner, diagnostic } = resolveModelPattern(pattern, options);
		if (inner.length === 0 && diagnostic) missing.push(`${pattern}: ${diagnostic}`);
		for (const ref of inner) {
			const key = `${ref.providerId}::${ref.modelId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			matches.push(ref);
		}
	}
	if (matches.length === 0) {
		return { matches: [], diagnostic: missing.join("; ") || "empty scope" };
	}
	return missing.length ? { matches, diagnostic: missing.join("; ") } : { matches };
}
