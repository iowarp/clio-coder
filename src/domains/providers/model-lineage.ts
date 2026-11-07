/**
 * Model lineage: which training family a model id belongs to, so a second
 * opinion can be asked of a model that does not share the main model's
 * blind spots. Two models from one family (two Qwen sizes, a Claude and its
 * distilled sibling) tend to agree for the same reasons, so their agreement
 * corroborates less than agreement across families does.
 *
 * Read from the model id alone: gateway prefixes (`openrouter/`,
 * `bedrock/us.`, a LiteLLM alias group such as `mini/`) are looked through,
 * and an id that names no known family is `unknown`, never guessed. An alias
 * a gateway invents (`smart`, `fast`) is therefore unknown, and unknown never
 * counts as independent.
 *
 * Pure: no I/O.
 */

export type ModelLineage =
	| "anthropic"
	| "openai"
	| "google"
	| "alibaba"
	| "meta"
	| "mistral"
	| "deepseek"
	| "xai"
	| "zhipu"
	| "moonshot"
	| "microsoft"
	| "nvidia"
	| "cohere"
	| "minimax"
	| "ibm"
	| "unknown";

const FAMILY_PATTERNS: ReadonlyArray<readonly [Exclude<ModelLineage, "unknown">, RegExp]> = [
	["anthropic", /(?:^|[^a-z])(?:claude|anthropic)/u],
	["openai", /(?:^|[^a-z])(?:gpt|chatgpt|codex|openai|davinci)|(?:^|[^a-z0-9])o[134](?:-|$)/u],
	["google", /(?:^|[^a-z])(?:gemini|gemma|palm|google)/u],
	["alibaba", /(?:^|[^a-z])(?:qwen|qwq|qvq)/u],
	["deepseek", /(?:^|[^a-z])deepseek/u],
	["meta", /(?:^|[^a-z])(?:code)?llama|(?:^|[^a-z])meta-llama/u],
	["mistral", /(?:^|[^a-z])(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)/u],
	["xai", /(?:^|[^a-z])(?:grok|x-ai|xai)/u],
	["zhipu", /(?:^|[^a-z])(?:glm|chatglm|zai-org|thudm)/u],
	["moonshot", /(?:^|[^a-z])(?:kimi|moonshot)/u],
	["microsoft", /(?:^|[^a-z])phi-?\d/u],
	["nvidia", /(?:^|[^a-z])nemotron/u],
	["cohere", /(?:^|[^a-z])(?:command-r|command-a|cohere|aya-)/u],
	["minimax", /(?:^|[^a-z])minimax/u],
	["ibm", /(?:^|[^a-z])granite/u],
];

function familyOf(text: string): ModelLineage {
	let best: { lineage: ModelLineage; at: number } | null = null;
	for (const [lineage, pattern] of FAMILY_PATTERNS) {
		const match = pattern.exec(text);
		if (match && (best === null || match.index < best.at)) best = { lineage, at: match.index };
	}
	return best?.lineage ?? "unknown";
}

/**
 * The family a model id belongs to. The model's own name (the last path
 * segment) decides first, so `bedrock/anthropic.claude-x` and
 * `openrouter/qwen/qwen3-coder` resolve by the model rather than the gateway;
 * a vendor-only prefix decides when the name itself is opaque. Within one
 * segment the earliest family named wins, so a distillation such as
 * `deepseek-r1-distill-qwen` reads as the family it was trained by.
 */
export function modelLineage(modelId: string | null | undefined): ModelLineage {
	if (!modelId) return "unknown";
	const lowered = modelId.trim().toLowerCase();
	const segments = lowered.split("/").filter((segment) => segment.length > 0);
	for (let index = segments.length - 1; index >= 0; index--) {
		const lineage = familyOf(segments[index] ?? "");
		if (lineage !== "unknown") return lineage;
	}
	return "unknown";
}

/** Whether a second opinion from `advisorModel` is independent of `mainModel`. */
export type SecondOpinionIndependence = "independent" | "same-lineage" | "unknown";

export function secondOpinionIndependence(
	mainModel: string | null | undefined,
	advisorModel: string | null | undefined,
): SecondOpinionIndependence {
	const main = modelLineage(mainModel);
	const advisor = modelLineage(advisorModel);
	if (main === "unknown" || advisor === "unknown") return "unknown";
	return main === advisor ? "same-lineage" : "independent";
}

export interface SecondOpinionCandidate {
	target: string;
	model: string;
	/** Probe health; a `down` or unavailable target is never chosen. */
	health: "healthy" | "degraded" | "unknown" | "down";
	available: boolean;
}

export interface SecondOpinionRoute {
	target: string;
	model: string;
	lineage: ModelLineage;
	mainLineage: ModelLineage;
}

/**
 * The route a second opinion should take: a reachable model whose family
 * differs from the main model's. A healthy target is preferred over one whose
 * health is unknown or degraded, and another target over another model on the
 * main target, so the advisor shares as little with the main model as the
 * configuration allows. Null when the main model's family is unknown (nothing
 * to differ from) or when every reachable model shares it.
 */
export function chooseSecondOpinionRoute(
	main: { target: string | null | undefined; model: string | null | undefined },
	candidates: ReadonlyArray<SecondOpinionCandidate>,
): SecondOpinionRoute | null {
	const mainLineage = modelLineage(main.model);
	if (mainLineage === "unknown") return null;
	const healthRank = (health: SecondOpinionCandidate["health"]): number => (health === "healthy" ? 0 : 1);
	const ranked = candidates
		.map((candidate, order) => ({ candidate, order, lineage: modelLineage(candidate.model) }))
		.filter(
			({ candidate, lineage }) =>
				candidate.available && candidate.health !== "down" && lineage !== "unknown" && lineage !== mainLineage,
		)
		.sort(
			(a, b) =>
				healthRank(a.candidate.health) - healthRank(b.candidate.health) ||
				Number(a.candidate.target === main.target) - Number(b.candidate.target === main.target) ||
				a.order - b.order,
		);
	const chosen = ranked[0];
	if (!chosen) return null;
	return { target: chosen.candidate.target, model: chosen.candidate.model, lineage: chosen.lineage, mainLineage };
}
