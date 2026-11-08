import { contenderForLabel } from "./blind.js";
import { ARENA_SCORE_MIN_VOTES, type ArenaChoice, type ArenaMatch, type ArenaVote } from "./types.js";

export interface ArenaStanding {
	identity: string;
	target: string;
	model: string;
	votes: number;
	wins: number;
	losses: number;
	ties: number;
	bad: number;
	/** Bradley-Terry strength on an Elo-like scale, null below `ARENA_SCORE_MIN_VOTES` votes. */
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

interface Pairwise {
	ids: string[];
	/** wins[i][j]: how often i beat j, a tie adding one half to each side. */
	wins: number[][];
}

/**
 * Bradley-Terry by minorization-maximization (Hunter 2004). Each identity also
 * plays one virtual drawn game against a fixed unit-strength anchor, which keeps
 * an unbeaten or winless identity finite and pins the scale without normalising.
 */
function bradleyTerry({ ids, wins }: Pairwise): number[] {
	const n = ids.length;
	let strength = new Array<number>(n).fill(1);
	for (let iteration = 0; iteration < 500; iteration++) {
		const next = strength.map((p, i) => {
			let won = 0.5;
			let denominator = 1 / (p + 1);
			for (let j = 0; j < n; j++) {
				if (j === i) continue;
				won += wins[i]?.[j] ?? 0;
				const games = (wins[i]?.[j] ?? 0) + (wins[j]?.[i] ?? 0);
				if (games > 0) denominator += games / (p + (strength[j] as number));
			}
			return won / denominator;
		});
		const delta = Math.max(...next.map((p, i) => Math.abs(p - (strength[i] as number))));
		strength = next;
		if (delta < 1e-9) break;
	}
	return strength.map((p) => Math.round(1000 + 400 * Math.log10(p)));
}

/**
 * Standings over every voted match, recomputed from the records each time and
 * never stored. A labeled vote is a win over every other contender in that
 * match; tie gives each pair half a win; both-bad counts against everyone and
 * stays out of the strength fit, since it ranks no one above anyone.
 */
export function computeStandings(
	entries: ReadonlyArray<{ match: ArenaMatch; vote: ArenaVote | null }>,
	suite: string | null = null,
): ArenaStandings {
	const rows = new Map<string, ArenaStanding>();
	const pairs = new Map<string, number>();
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
	const addWin = (winner: string, loser: string, amount: number): void => {
		const key = `${winner}\u0000${loser}`;
		pairs.set(key, (pairs.get(key) ?? 0) + amount);
	};
	for (const { match, vote } of entries) {
		if (suite !== null && match.suite !== suite) continue;
		matches += 1;
		if (vote === null) continue;
		const identities = new Set(match.contenders.map(contenderIdentity));
		// A match that pits an identity against itself says nothing about either side.
		if (identities.size < 2) continue;
		votedMatches += 1;
		for (const contender of uniqueContenders(match)) row(contender).votes += 1;
		applyVote(match, vote.choice, row, addWin);
	}
	const standings = [...rows.values()];
	const ids = standings.map((s) => s.identity);
	const wins = ids.map((a) => ids.map((b) => pairs.get(`${a}\u0000${b}`) ?? 0));
	const scores = bradleyTerry({ ids, wins });
	for (const [i, standing] of standings.entries()) {
		standing.score = standing.votes >= ARENA_SCORE_MIN_VOTES ? (scores[i] as number) : null;
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

function applyVote(
	match: ArenaMatch,
	choice: ArenaChoice,
	row: (contender: { target: string; model: string }) => ArenaStanding,
	addWin: (winner: string, loser: string, amount: number) => void,
): void {
	const contenders = uniqueContenders(match);
	if (choice === "both-bad") {
		for (const contender of contenders) row(contender).bad += 1;
		return;
	}
	if (choice === "tie") {
		for (const contender of contenders) row(contender).ties += 1;
		for (const a of contenders) {
			for (const b of contenders) {
				const ia = contenderIdentity(a);
				const ib = contenderIdentity(b);
				if (ia !== ib) addWin(ia, ib, 0.5);
			}
		}
		return;
	}
	const winnerIndex = contenderForLabel(match, choice);
	const winner = match.contenders.find((c) => c.index === winnerIndex);
	if (winner === undefined) return;
	const winnerId = contenderIdentity(winner);
	let beatSomeone = false;
	for (const contender of contenders) {
		const id = contenderIdentity(contender);
		if (id === winnerId) continue;
		row(contender).losses += 1;
		addWin(winnerId, id, 1);
		beatSomeone = true;
	}
	if (beatSomeone) row(winner).wins += 1;
}
