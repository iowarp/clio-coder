import type { RelevanceRanker } from "../system-one/rank.js";

export type CapabilityKind = "skills" | "capabilities" | "agents";

export interface CapabilityCandidate {
	readonly id: string;
	readonly description: string;
	readonly triggers?: ReadonlyArray<string>;
}

export interface CapabilityRequest {
	readonly kind: CapabilityKind;
	readonly task: string;
	readonly workspace?: string;
	readonly candidates: ReadonlyArray<CapabilityCandidate>;
	readonly limit?: number;
}

export interface CapabilityMatch extends CapabilityCandidate {
	readonly score: number;
}

export interface CapabilityGate {
	rank(request: CapabilityRequest): ReadonlyArray<CapabilityMatch>;
	used(kind: CapabilityKind, id: string): void;
}

export interface CapabilityGateOptions {
	relevance?: RelevanceRanker;
	allowRelevance?: () => boolean;
	relevanceCandidateLimit?: () => number;
}

const STOP = new Set(
	"a an the and or to of in on for from with by at as is are was be been being it its this that these those i me my we our you your can could would should please help want need use using skill skills task work do does not only when then than into about through have has had will some any how what".split(
		" ",
	),
);

function terms(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
		.filter((word) => word.length > 1 && !STOP.has(word))
		.map((word) => (word.length > 5 ? word.replace(/(?:ing|ed|es|s)$/u, "") : word));
}

/** BM25 with weighted name/trigger fields and a bounded usage prior. No task-specific routing rules. */
function rankCapabilitiesLexically(
	request: CapabilityRequest,
	history: ReadonlyMap<string, number> = new Map(),
): CapabilityMatch[] {
	const query = [...new Set(terms(request.task.slice(0, 8000)))];
	if (query.length === 0) return [];
	const facts = new Set(terms(request.workspace?.slice(0, 2000) ?? ""));
	const docs = request.candidates.map((candidate) => {
		const words = terms(`${candidate.id} ${candidate.description} ${(candidate.triggers ?? []).join(" ")}`);
		const weights = new Map<string, number>();
		for (const [text, weight] of [
			[candidate.description, 1],
			[(candidate.triggers ?? []).join(" "), 2],
			[candidate.id, 3],
		] as const) {
			for (const term of terms(text)) weights.set(term, (weights.get(term) ?? 0) + weight);
		}
		return { candidate, words, weights };
	});
	const df = new Map<string, number>();
	for (const doc of docs) for (const term of doc.weights.keys()) df.set(term, (df.get(term) ?? 0) + 1);
	const average = docs.reduce((sum, doc) => sum + doc.words.length, 0) / Math.max(1, docs.length);
	const idf = (term: string): number =>
		Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
	return docs
		.flatMap(({ candidate, words, weights }) => {
			const bm25 = (term: string): number => {
				const tf = weights.get(term) ?? 0;
				return (idf(term) * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * words.length) / Math.max(1, average)));
			};
			const taskScore = query.reduce((sum, term) => sum + bm25(term), 0);
			if (taskScore <= 0) return [];
			const workspaceScore = [...facts].reduce((sum, term) => sum + bm25(term), 0);
			const prior = Math.min(0.1, Math.log1p(history.get(candidate.id) ?? 0) * 0.025);
			const score = taskScore * (1 + prior) + Math.min(taskScore * 0.15, workspaceScore * 0.1);
			return [{ ...candidate, score }];
		})
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** One session-owned gate: synchronous lexical advice, opportunistic cached inference, no awaited model pass. */
export function createCapabilityGate(options: CapabilityGateOptions = {}): CapabilityGate {
	const history = new Map<CapabilityKind, Map<string, number>>();
	return {
		used(kind, id) {
			const counts = history.get(kind) ?? new Map<string, number>();
			counts.set(id, Math.min(100, (counts.get(id) ?? 0) + 1));
			history.set(kind, counts);
		},
		rank(request) {
			const lexical = rankCapabilitiesLexically(request, history.get(request.kind));
			const limit = Math.max(0, Math.min(10, request.limit ?? 5));
			const candidates = [...lexical, ...request.candidates.filter((c) => !lexical.some((hit) => hit.id === c.id))].slice(
				0,
				options.relevanceCandidateLimit?.() ?? 64,
			);
			const semantic: Record<string, number> = {};
			const relevance =
				request.task.trim() && options.allowRelevance?.() !== false && options.relevance?.asks()
					? options.relevance({
							use: request.kind === "agents" ? "capabilities" : request.kind,
							need: request.task,
							candidates: candidates.map((c) => ({ id: c.id, summary: c.description })),
						})
					: null;
			if (relevance) Object.assign(semantic, relevance.scores);
			const best = lexical[0]?.score ?? 0;
			const ordered = new Map(
				lexical
					.filter((hit) => hit.score >= best * 0.22)
					.map((hit) => [hit.id, { ...hit, score: hit.score / Math.max(1, best) }]),
			);
			for (const candidate of candidates) {
				const score = semantic[candidate.id];
				if (score === undefined || !Number.isFinite(score) || score < 0.5 || score > 1) continue;
				const local = ordered.get(candidate.id);
				const base = local?.score ?? 0;
				// FW-1: a calibrated paraphrase match must be able to beat a lexical-only leader.
				ordered.set(candidate.id, { ...candidate, ...local, score: base + 2 * score });
			}
			return [...ordered.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
		},
	};
}
