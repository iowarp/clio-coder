import { renderCompactCount, renderUsdSum } from "../../core/telemetry/render.js";
import { matchLabels } from "./blind.js";
import { readContenderDiff } from "./store.js";
import type {
	ArenaCheckFact,
	ArenaChoice,
	ArenaContenderStatus,
	ArenaDiffStat,
	ArenaLabel,
	ArenaMatch,
	ArenaMatchStatus,
	ArenaVote,
} from "./types.js";

/** What a voter may see before voting: the work and its outcome, not who did it or what it cost. */
export interface ArenaEntryView {
	label: ArenaLabel;
	status: ArenaContenderStatus;
	exitCode: number | null;
	timedOut: boolean;
	turns: number | null;
	toolCalls: number | null;
	toolErrors: number | null;
	writes: number | null;
	blocks: number | null;
	diffStat: ArenaDiffStat | null;
	check: ArenaCheckFact | null;
	finalText: string;
	diff: string | null;
	diffTruncated: boolean;
	error: string | null;
	/** Present only once the match is revealed. */
	reveal: ArenaRevealView | null;
}

export interface ArenaRevealView {
	index: number;
	target: string;
	model: string;
	durationMs: number | null;
	sessionId: string | null;
	tokens: string;
	cost: string;
}

export interface ArenaMatchView {
	id: string;
	createdAt: string;
	completedAt: string | null;
	status: ArenaMatchStatus;
	prompt: string;
	suite: string | null;
	isolation: ArenaMatch["isolation"];
	check: string | null;
	error: string | null;
	revealed: boolean;
	vote: { choice: ArenaChoice; note: string | null; votedAt: string } | null;
	entries: ArenaEntryView[];
}

export class ArenaRevealRefused extends Error {}

/**
 * Project a match for a voter. Identity, duration, tokens and cost stay hidden
 * until the vote is in, because each can name the model. Asking to reveal
 * before voting is refused rather than silently honoured.
 */
export function arenaMatchView(
	root: string,
	match: ArenaMatch,
	vote: ArenaVote | null,
	options: { reveal?: boolean; diffs?: boolean } = {},
): ArenaMatchView {
	if (options.reveal === true && vote === null) {
		throw new ArenaRevealRefused(`match ${match.id} has no vote yet; vote before revealing who is who`);
	}
	const revealed = vote !== null;
	const entries = matchLabels(match).map((label, k): ArenaEntryView => {
		const index = match.order[k] as number;
		const contender = match.contenders.find((c) => c.index === index);
		const facts = contender?.facts ?? null;
		const diff = options.diffs === false ? null : readContenderDiff(root, match.id, index);
		return {
			label,
			status: contender?.status ?? "pending",
			exitCode: facts?.exitCode ?? null,
			timedOut: facts?.timedOut ?? false,
			turns: facts?.turns ?? null,
			toolCalls: facts?.toolCalls ?? null,
			toolErrors: facts?.toolErrors ?? null,
			writes: facts?.writes ?? null,
			blocks: facts?.blocks ?? null,
			diffStat: facts?.diff ?? null,
			check: facts?.check ?? null,
			finalText: facts?.finalText ?? "",
			diff: diff?.text ?? null,
			diffTruncated: diff?.truncated ?? false,
			error: facts?.error ?? null,
			reveal:
				revealed && contender !== undefined
					? {
							index,
							target: contender.target,
							model: contender.model,
							durationMs: facts?.durationMs ?? null,
							sessionId: facts?.sessionId ?? null,
							tokens: facts?.totalTokens ? renderCompactCount(facts.totalTokens) : "not measured",
							cost: facts?.cost ? renderUsdSum(facts.cost.usd, facts.cost.free, facts.cost.freeRule) : "not measured",
						}
					: null,
		};
	});
	return {
		id: match.id,
		createdAt: match.createdAt,
		completedAt: match.completedAt,
		status: match.status,
		prompt: match.prompt,
		suite: match.suite,
		isolation: match.isolation,
		check: match.check,
		error: match.error,
		revealed,
		vote: vote === null ? null : { choice: vote.choice, note: vote.note, votedAt: vote.votedAt },
		entries,
	};
}
