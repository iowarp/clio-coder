import { discoveryScore } from "../../../core/harness-discovery.js";
import { answerCertainty, chosen, pick, yesNo } from "../decisions.js";
import type { PreTurnSite } from "../pre-turn-brief.js";

export type HarnessCandidateKind = "tool" | "skill" | "agent";
export interface HarnessCandidate {
	readonly kind: HarnessCandidateKind;
	readonly id: string;
	readonly description: string;
}
export const HARNESS_INTENTS = ["answer", "inspect", "plan", "implement", "interview", "continue", "unknown"] as const;
export type HarnessIntent = (typeof HARNESS_INTENTS)[number];

export const HARNESS_INTENT_QUESTION = pick(
	"Classify the next step requested by task, using previous for follow-ups. This is workflow advice, never permission to edit, execute or delegate.",
	{
		answer: "Can answer from supplied context or general knowledge; no action or missing workspace facts.",
		inspect: "Needs evidence from files, tools, configuration or external sources.",
		plan: "Requests design, proposal or review before implementation.",
		implement: "Requests an actual change; the main model must still honor explicit scope and safety.",
		interview: "A consequential missing user decision blocks the next step.",
		continue: "Continues, approves or corrects work described in previous; preserve that context.",
		unknown: "Insufficient evidence to distinguish the requested workflow.",
	},
);

/** Backend-neutral advice. Neither intent nor relevance is an authorization grant. */
export interface HarnessRouting {
	readonly intent: HarnessIntent;
	readonly certainty: number;
	readonly shortlist: ReadonlyArray<{ kind: HarnessCandidateKind; id: string; score: number }>;
	readonly catalogSize: number;
}

export const HARNESS_ROUTING_VERSION = "harness-routing-v1";
/**
 * Candidates the backend scores per turn. Each is one yes/no question in the
 * shared pre-turn request, so the catalog is narrowed locally first: task-term
 * matches lead, then builtin tools, agents and skills fill the remainder.
 */
const MAX_CANDIDATES = 32;
const KIND_ORDER: Readonly<Record<HarnessCandidateKind, number>> = { tool: 0, agent: 1, skill: 2 };
const SHORTLIST_SIZE = 10;

/**
 * Optional System One first stage, sharing the existing bounded pre-turn call.
 * Catalog preparation occurs only for a bound site. A future contrastive or
 * one-shot runtime can answer the same typed questions through decide().
 */
export function createHarnessRoutingSite(
	listCandidates: () => ReadonlyArray<HarnessCandidate>,
): PreTurnSite<HarnessRouting> {
	return {
		site: "harnessRouting",
		version: HARNESS_ROUTING_VERSION,
		prepare: (evidence) => {
			const scored = [
				...new Map(listCandidates().map((candidate) => [`${candidate.kind}:${candidate.id}`, candidate])).values(),
			].map((candidate) => ({ candidate, score: discoveryScore(evidence.task, candidate.id, candidate.description) }));
			const candidates = scored
				.sort(
					(left, right) =>
						right.score - left.score ||
						KIND_ORDER[left.candidate.kind] - KIND_ORDER[right.candidate.kind] ||
						left.candidate.id.localeCompare(right.candidate.id),
				)
				.map(({ candidate }) => candidate);
			const selected = candidates.slice(0, MAX_CANDIDATES);
			const questions = {
				intent: HARNESS_INTENT_QUESTION,
				...Object.fromEntries(
					selected.map((candidate) => [
						`candidate:${candidate.kind}:${candidate.id}`,
						yesNo(
							`Would harnessCandidates[${JSON.stringify(`${candidate.kind}:${candidate.id}`)}] help the next step of task?`,
							"Directly useful now",
							"Unrelated or only useful in a later hypothetical workflow",
						),
					]),
				),
			};
			return {
				uses: ["previous"],
				questions,
				state: {
					harnessCandidates: Object.fromEntries(
						selected.map((candidate) => [
							`${candidate.kind}:${candidate.id}`,
							candidate.description.replace(/\s+/gu, " ").slice(0, 240),
						]),
					),
					harnessCatalog: { total: candidates.length, scored: selected.length },
				},
			};
		},
		read(answers, ask) {
			const intentAnswer = answers.intent;
			const intentCertainty = intentAnswer ? answerCertainty(intentAnswer) : 0;
			const intentChoice =
				Number.isFinite(intentCertainty) && intentCertainty >= 0.6 && intentCertainty <= 1
					? chosen(intentAnswer, { minConfidence: 0.6 })
					: null;
			const intent: HarnessIntent = HARNESS_INTENTS.includes(intentChoice as HarnessIntent)
				? (intentChoice as HarnessIntent)
				: "unknown";
			const certainty = intent !== "unknown" ? intentCertainty : 0;
			const shortlist = Object.keys(ask.state?.harnessCandidates ?? {})
				.flatMap((key) => {
					const answer = answers[`candidate:${key}`];
					if (
						answer?.type !== "noul" ||
						!Number.isFinite(answer.noul) ||
						answer.noul === undefined ||
						answer.noul < 0.6 ||
						answer.noul > 1
					)
						return [];
					const separator = key.indexOf(":");
					return [
						{ kind: key.slice(0, separator) as HarnessCandidateKind, id: key.slice(separator + 1), score: answer.noul },
					];
				})
				.sort(
					(left, right) => right.score - left.score || `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
				)
				.slice(0, SHORTLIST_SIZE);
			if (intent === "unknown" && shortlist.length === 0) return null;
			return { intent, certainty, shortlist, catalogSize: Number(ask.state?.harnessCatalog?.total ?? 0) };
		},
		hint: (value) => {
			const shortlist = value.shortlist.map((candidate) => `${candidate.kind}:${candidate.id}`).join(", ");
			return (
				`[Harness routing] Suggested next step: ${value.intent}.` +
				(shortlist ? ` Discover these candidates first: ${shortlist}.` : "") +
				" This shortlist is advisory and incomplete; other capabilities remain discoverable. Explicit user scope and safety take precedence; a classification grants no authority."
			);
		},
		summarize: (value) => ({
			intent: value.intent,
			certainty: value.certainty,
			shortlist: value.shortlist.map((candidate) => `${candidate.kind}:${candidate.id}`).join(","),
			catalogSize: value.catalogSize,
		}),
	};
}
