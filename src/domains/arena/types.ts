import type { FactSum } from "../../core/telemetry/fact.js";
import type { PricingSum } from "../../core/telemetry/pricing.js";

/**
 * The arena records what each contender did and what the human preferred. It
 * never judges: no model scores a contender, and standings derive from votes alone.
 */
export const ARENA_SCHEMA_VERSION = 1;

export const ARENA_LABELS = ["A", "B", "C", "D"] as const;
export type ArenaLabel = (typeof ARENA_LABELS)[number];
export type ArenaChoice = ArenaLabel | "tie" | "both-bad";

export const ARENA_MIN_CONTENDERS = 2;
export const ARENA_MAX_CONTENDERS = 4;

/** Votes an identity needs before its Elo rating is shown; fewer is noise. */
export const ARENA_SCORE_MIN_VOTES = 5;

export interface ArenaContenderSpec {
	target: string;
	model: string;
}

export interface ArenaDiffStat {
	files: number;
	insertions: number;
	deletions: number;
}

export interface ArenaCheckFact {
	id: string;
	exitCode: number | null;
	/** The tail of the dry-run output, which states the verdict in its own words. */
	tail: string;
}

/** What the contender's own `run --json` stream and its worktree said. Raw counts, never a grade. */
export interface ArenaFacts {
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	sessionId: string | null;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	writes: number;
	blocks: number;
	totalTokens: FactSum | null;
	cost: PricingSum | null;
	finalText: string;
	diff: ArenaDiffStat | null;
	check: ArenaCheckFact | null;
	error: string | null;
}

export type ArenaContenderStatus = "pending" | "running" | "done" | "failed" | "timed-out";

export interface ArenaContender extends ArenaContenderSpec {
	index: number;
	status: ArenaContenderStatus;
	facts: ArenaFacts | null;
}

export type ArenaMatchStatus = "running" | "complete" | "failed";
export type ArenaIsolation = "worktree" | "read-only";

export interface ArenaMatch {
	schemaVersion: typeof ARENA_SCHEMA_VERSION;
	id: string;
	createdAt: string;
	completedAt: string | null;
	status: ArenaMatchStatus;
	prompt: string;
	suite: string | null;
	root: string;
	baselineSha: string | null;
	isolation: ArenaIsolation;
	seed: number;
	/** `order[k]` is the contender index shown under label `ARENA_LABELS[k]`. */
	order: number[];
	timeoutSeconds: number;
	maxCostUsd: number | null;
	check: string | null;
	contenders: ArenaContender[];
	error: string | null;
}

export interface ArenaVote {
	schemaVersion: typeof ARENA_SCHEMA_VERSION;
	matchId: string;
	choice: ArenaChoice;
	note: string | null;
	votedAt: string;
	/** True when this vote replaced an earlier one; the journal keeps both. */
	replaced: boolean;
}
