/**
 * The semantic contract every engine is held to, kept apart from how any one
 * model is asked.
 *
 * A site's question is a semantic object: the task it serves, its answer
 * semantics (Boolean, exclusive choice, ordinal level, independent relevance),
 * its legal labels and the abstention every reader already treats as "behave
 * as without System One". A renderer turns that into what one model family
 * reads, and refuses rather than truncates. A capability profile says which
 * tasks and semantics a served model may be asked at all and how its numbers
 * are to be read. Nothing here claims accuracy: a readout type says what a
 * number is, never how well it was measured. Measurement lives in
 * `calibration.ts`, keyed by the identity this module defines.
 */

import type { QuestionType, SiteId } from "./types.js";

/** What a question is for. Routing, capability narrowing and cut binding all key on it. */
export const DECISION_TASKS = [
	"intent",
	"recipe",
	"toolRisk",
	"injection",
	"turnEnd",
	"relevance",
	"clusterSelect",
	"consult",
	"drafts",
	"steer",
] as const;
export type DecisionTask = (typeof DECISION_TASKS)[number];

/**
 * The source matrix of which tasks each site asks. The factory routes by it and
 * settings validation refuses a task route the site does not ask, so a typo
 * cannot quietly send a different task to the named engine.
 */
export const SITE_TASKS: Readonly<Record<SiteId, ReadonlyArray<DecisionTask>>> = {
	turn: ["intent", "recipe", "clusterSelect"],
	toolCall: ["toolRisk"],
	toolResult: ["injection"],
	turnEnd: ["turnEnd"],
	relevance: ["relevance", "clusterSelect"],
	consult: ["consult"],
	drafts: ["drafts"],
	steer: ["steer"],
};

/** The task a site asks when its definition names none. */
export function primaryTask(site: SiteId): DecisionTask {
	return SITE_TASKS[site][0] as DecisionTask;
}

/**
 * Answer semantics. `independent` is a yes/no per candidate whose numbers do
 * not compete with each other's, which is what relevance means and what a
 * multi-label sigmoid reads; `boolean` is one proposition about one state.
 */
export type SemanticKind = "boolean" | "exclusive" | "ordinal" | "independent";

export function semanticKind(task: DecisionTask, type: QuestionType): SemanticKind {
	if (type === "choice") return "exclusive";
	if (type === "score") return "ordinal";
	return task === "relevance" || task === "clusterSelect" ? "independent" : "boolean";
}

/**
 * What an answer's number is. `server` is the legacy wire's own value, whose
 * meaning is the serving build's; the rest name the readout a profile declares
 * for its family. None of them is a calibration claim.
 */
export type ReadoutKind =
	| "server"
	| "softmax-binary"
	| "softmax-exclusive"
	| "sigmoid-independent"
	| "ordinal-expectation"
	| "logprob"
	| "vote";

/** Renderer revisions. Bumping one changes every identity cuts are keyed by. */
export type RendererId = "systemone-v1" | "julia-compact-v1" | "gliner-label-v1" | "llm-prompt";

/** The renderer whose identity maps to the bare build, so Jev's measured table keeps applying. */
export const LEGACY_RENDERER: RendererId = "systemone-v1";

/**
 * What a threshold is bound to besides site and key: the answering build, the
 * renderer contract, the site version (wording, evidence projection and
 * policy) and the compact wording version when a bounded renderer used one.
 * Candidate ids and recipe options are values inside the contract and never
 * enter it, so a changing catalog cannot silence a validated ranking.
 *
 * The legacy wire and the LLM prompt map to the bare build, which keeps every
 * `systemOne.cuts.<build>` an operator already wrote. For the measured table
 * that mapping is not a blanket one: `cutsFor` applies a measured cut only
 * under the exact site versions `FITTED_CONTRACTS` lists for the build.
 */
export function thresholdIdentity(
	build: string,
	renderer: RendererId,
	siteVersion: string,
	compactVersion?: string,
): string {
	if (renderer === LEGACY_RENDERER || renderer === "llm-prompt") return build;
	return `${build}+${renderer}@${siteVersion}${compactVersion !== undefined ? `/${compactVersion}` : ""}`;
}
