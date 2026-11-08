/**
 * The research hill climb: an operator names an objective metric printed by a declared verifier check and a budget,
 * and Clio repeatedly lets its own agent change an isolated worktree, measures the change against the current best
 * commit, and keeps it only when it beats noise. Everything a campaign decides is written under
 * `.clio-coder/research/<id>/` so `research report` can recompute every verdict from the raw samples.
 */

import type { DeclaredCheck } from "../../tools/verify/catalog.js";

export const RESEARCH_CAMPAIGN_VERSION = 1;
export const RESEARCH_REF_PREFIX = "refs/heads/clio/research/";
export const RESEARCH_DEFAULT_MIN_IMPROVEMENT = 0.05;
export const RESEARCH_DEFAULT_TRIALS = 5;
export const RESEARCH_BOOTSTRAP_RESAMPLES = 2000;
export const RESEARCH_COMMIT_IDENTITY = "clio-coder-research";

export type ResearchDirection = "min" | "max";

export interface ResearchObjective {
	/** Verifier check id from `.clio-coder/verifiers.yaml`. */
	check: string;
	/** Key of the JSON payload the check prints; `wall_ms` of a perf-budget check falls back to its measured duration. */
	metric: string;
	direction: ResearchDirection;
	/** Relative change the median must clear, as a fraction (0.05 is 5%). */
	minImprovement: number;
	/** Interleaved base/candidate pairs per measurement. */
	trials: number;
}

export interface ResearchBudget {
	maxIterations: number;
	maxWallMinutes?: number;
	maxCostUsd?: number;
	/** Keep going when a run's spend is unknown; the iteration and wall caps still bind. */
	allowUnpriced: boolean;
}

/** The immutable `campaign.json`. */
export interface ResearchCampaign {
	version: typeof RESEARCH_CAMPAIGN_VERSION;
	id: string;
	createdAt: string;
	/** Repository root the campaign belongs to. */
	project: string;
	objective: ResearchObjective;
	/** Check ids that must pass on every candidate. */
	gates: string[];
	/** Repository-relative globs a candidate may change; empty means anywhere not protected. */
	scope: string[];
	/** Repository-relative paths no candidate may change: the catalog and every file the checks name. */
	protected: string[];
	budget: ResearchBudget;
	allowNoisy: boolean;
	keep: boolean;
	agent: { target?: string; model?: string; autonomy: "default"; goal?: string };
	/** Commit the campaign started from; the research branch is created here. */
	base: string;
	/** Full ref name of the research branch, `refs/heads/clio/research/<id>`. */
	ref: string;
	/** The objective and gate checks exactly as declared when the campaign opened; every measurement runs these. */
	checks: DeclaredCheck[];
	/** SHA-256 of `checks` as JSON, so a reader can tell the campaign's checks from the catalog's current ones. */
	checkDigest: string;
	/** Seed of the bootstrap resampler; iteration N uses `seed + N`, the A/A check uses `seed`. */
	seed: number;
	resamples: number;
	clioVersion: string;
}

export type ResearchVerdict = "improved" | "unchanged" | "regressed" | "inconclusive";

/** Why an iteration was archived without a ratchet. */
export type ResearchArchiveReason =
	| "agent-failed"
	| "no-op"
	| "duplicate"
	| "out-of-scope"
	| "protected"
	| "measure-failed"
	| "gate-failed"
	| "not-improved"
	| "ratchet-lost";

export type ResearchStopReason =
	| "max-iterations"
	| "max-wall-minutes"
	| "max-cost-usd"
	| "budget-unenforceable"
	| "stopped"
	| "noisy"
	| "error";

/** Spend of one agent run, as its `Fact` cost reported it. Unknown spend is never read as zero. */
export type ResearchCost =
	| { kind: "measured"; usd: number }
	| { kind: "estimated"; usd: number }
	| { kind: "free" }
	| { kind: "unknown"; reason: string };

export interface ResearchGrade {
	/** `improved` only when the classification clears `minImprovement` and the interval excludes zero on that side. */
	verdict: ResearchVerdict;
	classification: "improved" | "unchanged" | "regressed" | "undefined";
	baseMedian: number | null;
	candidateMedian: number | null;
	/** Relative delta of the medians, `(candidate - base) / |base|`; null when base is zero and candidate is not. */
	delta: number | null;
	/** Bootstrap 95% percentile interval of the relative delta, or null when it is undefined. */
	ci: { low: number; high: number } | null;
	seed: number;
	resamples: number;
}

export interface ResearchGateResult {
	check: string;
	passed: boolean;
	execution: string;
	summary: string;
	/** Id of the claim the run recorded, when the check is a judged kind. */
	claim?: string;
}

/** One line of `journal.jsonl`. */
export type ResearchJournalEvent =
	| { type: "opened"; at: string; base: string; ref: string }
	| { type: "aa"; at: string; samples: string; grade: ResearchGrade; noisy: boolean; allowed: boolean }
	| { type: "iteration-started"; at: string; iteration: number; parent: string; worktree: string }
	| {
			type: "agent-finished";
			at: string;
			iteration: number;
			exitCode: number | null;
			sessionId: string | null;
			outcome: string | null;
			summary: string;
			cost: ResearchCost;
	  }
	| { type: "committed"; at: string; iteration: number; commit: string; tree: string; changed: string[] }
	| { type: "measured"; at: string; iteration: number; samples: string }
	| { type: "graded"; at: string; iteration: number; grade: ResearchGrade; gates: ResearchGateResult[] }
	| { type: "ratcheted"; at: string; iteration: number; from: string; to: string }
	| { type: "archived"; at: string; iteration: number; reason: ResearchArchiveReason; detail: string }
	| { type: "recorded"; at: string; iteration: number; hypothesis: string | null; claims: string[] }
	| { type: "stopped"; at: string; reason: ResearchStopReason; detail: string; best: string };

export type ResearchJournalEventType = ResearchJournalEvent["type"];

/** Raw `samples/<name>.json`: the objective values exactly as measured, in run order. */
export interface ResearchSamples {
	iteration: number | "aa";
	metric: string;
	baseCommit: string;
	candidateCommit: string;
	/** One base run then one candidate run per pair; both sides are the base for the A/A check. */
	pairs: Array<{ base: number; candidate: number }>;
}
