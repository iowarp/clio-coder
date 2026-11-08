import { contenderForLabel } from "./blind.js";
import { ARENA_SCORE_MIN_VOTES, type ArenaChoice, type ArenaLabel, type ArenaMatch, type ArenaVote } from "./types.js";

export interface ArenaStanding {
	identity: string;
	target: string;
	model: string;
	votes: number;
	wins: number;
	losses: number;
	ties: number;
	bad: number;
	/** Elo rating (start 1000, K 32), null below `ARENA_SCORE_MIN_VOTES` votes. */
	score: number | null;
}

export interface ArenaStandings {
	suite: string | null;
	matches: number;
	votedMatches: number;
	minVotesForScore: number;
	standings: ArenaStanding[];
}

function contenderIdentity(contender: { target: string; model: string }): string {
	return `${contender.target}/${contender.model}`;
}

/** Every identity starts here. */
export const ARENA_ELO_START = 1000;
/** Rating points at stake in a two-contender match. */
export const ARENA_ELO_K = 32;

const expected = (rating: number, opponent: number): number => 1 / (1 + 10 ** ((opponent - rating) / 400));

/** One voted match as pairwise results: 1 for a win, 0.5 for a tie, from the first identity's side. */
type Result = { a: string; b: string; score: number };

/**
 * Elo ratings, replayed over the voted matches in match order (match ids begin
 * with their start time), so the same records always give the same ratings and
 * a replaced vote keeps its match's place. Every pair in a match is updated at
 * once from the ratings before it, and K is split across a contender's
 * opponents, so one match moves no rating by more than K however many
 * contenders it has.
 */
function elo(
	ids: readonly string[],
	matches: ReadonlyArray<{ opponents: number; results: Result[] }>,
): Map<string, number> {
	const ratings = new Map(ids.map((id) => [id, ARENA_ELO_START]));
	for (const { opponents, results } of matches) {
		const k = ARENA_ELO_K / Math.max(1, opponents);
		const delta = new Map<string, number>();
		for (const { a, b, score } of results) {
			const change = k * (score - expected(ratings.get(a) ?? ARENA_ELO_START, ratings.get(b) ?? ARENA_ELO_START));
			delta.set(a, (delta.get(a) ?? 0) + change);
			delta.set(b, (delta.get(b) ?? 0) - change);
		}
		for (const [id, change] of delta) ratings.set(id, (ratings.get(id) ?? ARENA_ELO_START) + change);
	}
	return ratings;
}

/**
 * Standings over every voted match, recomputed from the records each time and
 * never stored. A labeled vote is a win over every other contender in that
 * match; tie is a draw for each pair; both-bad counts against everyone and
 * leaves ratings alone, since it ranks no one above anyone.
 */
export function computeStandings(
	entries: ReadonlyArray<{ match: ArenaMatch; vote: ArenaVote | null }>,
	suite: string | null = null,
): ArenaStandings {
	const rows = new Map<string, ArenaStanding>();
	const rated: Array<{ id: string; opponents: number; results: Result[] }> = [];
	let matches = 0;
	let votedMatches = 0;
	const row = (contender: { target: string; model: string }): ArenaStanding => {
		const identity = contenderIdentity(contender);
		let found = rows.get(identity);
		if (found === undefined) {
			found = {
				identity,
				target: contender.target,
				model: contender.model,
				votes: 0,
				wins: 0,
				losses: 0,
				ties: 0,
				bad: 0,
				score: null,
			};
			rows.set(identity, found);
		}
		return found;
	};
	for (const { match, vote } of entries) {
		if (suite !== null && match.suite !== suite) continue;
		matches += 1;
		if (vote === null) continue;
		const identities = new Set(match.contenders.map(contenderIdentity));
		// A match that pits an identity against itself says nothing about either side.
		if (identities.size < 2) continue;
		// A label naming no contender (a hand-edited or foreign record) is no vote at all.
		if (vote.choice !== "tie" && vote.choice !== "both-bad" && winnerOf(match, vote.choice) === undefined) continue;
		votedMatches += 1;
		for (const contender of uniqueContenders(match)) row(contender).votes += 1;
		const results = applyVote(match, vote.choice, row);
		if (results.length > 0) rated.push({ id: match.id, opponents: identities.size - 1, results });
	}
	const standings = [...rows.values()];
	rated.sort((a, b) => a.id.localeCompare(b.id));
	const ratings = elo(
		standings.map((s) => s.identity),
		rated,
	);
	for (const standing of standings) {
		const rating = ratings.get(standing.identity) ?? ARENA_ELO_START;
		standing.score = standing.votes >= ARENA_SCORE_MIN_VOTES ? Math.round(rating) : null;
	}
	standings.sort(
		(a, b) =>
			(b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY) ||
			b.wins - a.wins ||
			a.losses - b.losses ||
			a.identity.localeCompare(b.identity),
	);
	return { suite, matches, votedMatches, minVotesForScore: ARENA_SCORE_MIN_VOTES, standings };
}

/** One entry per identity: the same route entered twice is one participant in the tally. */
function uniqueContenders(match: ArenaMatch): ArenaMatch["contenders"] {
	return [...new Map(match.contenders.map((c) => [contenderIdentity(c), c])).values()];
}

function winnerOf(match: ArenaMatch, label: ArenaLabel): ArenaMatch["contenders"][number] | undefined {
	const index = contenderForLabel(match, label);
	return index === null ? undefined : match.contenders.find((c) => c.index === index);
}

function applyVote(
	match: ArenaMatch,
	choice: ArenaChoice,
	row: (contender: { target: string; model: string }) => ArenaStanding,
): Result[] {
	const contenders = uniqueContenders(match);
	const results: Result[] = [];
	if (choice === "both-bad") {
		for (const contender of contenders) row(contender).bad += 1;
		return results;
	}
	if (choice === "tie") {
		for (const contender of contenders) row(contender).ties += 1;
		const ids = contenders.map(contenderIdentity);
		for (const [i, a] of ids.entries()) for (const b of ids.slice(i + 1)) results.push({ a, b, score: 0.5 });
		return results;
	}
	const winner = winnerOf(match, choice);
	if (winner === undefined) return results;
	const winnerId = contenderIdentity(winner);
	let beatSomeone = false;
	for (const contender of contenders) {
		const id = contenderIdentity(contender);
		if (id === winnerId) continue;
		row(contender).losses += 1;
		results.push({ a: winnerId, b: id, score: 1 });
		beatSomeone = true;
	}
	if (beatSomeone) row(winner).wins += 1;
	return results;
}
