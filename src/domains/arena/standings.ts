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

const sigmoid = (x: number): number => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));
/** log(1 + e^x) without overflow. */
const softplus = (x: number): number => (x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x)));

/** Solve A x = b for a small symmetric positive definite A by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] | null {
	const n = b.length;
	const m = a.map((row, i) => [...row, b[i] as number]);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++) if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = r;
		if (Math.abs(m[pivot]?.[col] ?? 0) < 1e-300) return null;
		[m[col], m[pivot]] = [m[pivot] as number[], m[col] as number[]];
		const head = m[col] as number[];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const row = m[r] as number[];
			const factor = (row[col] as number) / (head[col] as number);
			if (factor === 0) continue;
			for (let c = col; c <= n; c++) row[c] = (row[c] as number) - factor * (head[c] as number);
		}
	}
	return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

/**
 * Bradley-Terry strengths as log-strengths theta. Each identity also plays one
 * virtual drawn game against a fixed unit-strength anchor (theta 0): a weak
 * prior that keeps an unbeaten or winless record finite and pins the scale. The
 * resulting log-likelihood is strictly concave, so damped Newton steps reach its
 * one maximum; the fit is used only when the gradient is at zero within
 * tolerance, and otherwise no score is published.
 */
function bradleyTerry({ ids, wins }: Pairwise): number[] | null {
	const n = ids.length;
	if (n === 0) return [];
	const w = (i: number, j: number) => wins[i]?.[j] ?? 0;
	const objective = (theta: number[]): number => {
		let total = 0;
		for (let i = 0; i < n; i++) {
			const ti = theta[i] as number;
			total += 0.5 * ti - softplus(ti);
			for (let j = 0; j < n; j++) {
				if (j === i || w(i, j) === 0) continue;
				// log(e^ti / (e^ti + e^tj)) = -softplus(tj - ti)
				total -= w(i, j) * softplus((theta[j] as number) - ti);
			}
		}
		return total;
	};
	let theta = new Array<number>(n).fill(0);
	for (let iteration = 0; iteration < 200; iteration++) {
		const gradient = new Array<number>(n).fill(0);
		const curvature = Array.from({ length: n }, () => new Array<number>(n).fill(0));
		for (let i = 0; i < n; i++) {
			const ti = theta[i] as number;
			const pa = sigmoid(ti);
			gradient[i] = (gradient[i] as number) + 0.5 - pa;
			(curvature[i] as number[])[i] = ((curvature[i] as number[])[i] as number) + pa * (1 - pa);
			for (let j = 0; j < n; j++) {
				if (j === i) continue;
				const games = w(i, j) + w(j, i);
				if (games === 0) continue;
				const p = sigmoid(ti - (theta[j] as number));
				gradient[i] = (gradient[i] as number) + w(i, j) - games * p;
				const h = games * p * (1 - p);
				(curvature[i] as number[])[i] = ((curvature[i] as number[])[i] as number) + h;
				(curvature[i] as number[])[j] = ((curvature[i] as number[])[j] as number) - h;
			}
		}
		if (Math.max(...gradient.map(Math.abs)) < 1e-9) {
			return theta.map((t) => Math.round(1000 + (400 * t) / Math.LN10));
		}
		const step = solve(curvature, gradient);
		if (step === null) return null;
		const before = objective(theta);
		let scale = 1;
		let next = theta.map((t, i) => t + (step[i] as number));
		while (objective(next) < before && scale > 1e-12) {
			scale /= 2;
			next = theta.map((t, i) => t + scale * (step[i] as number));
		}
		theta = next;
	}
	return null;
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
		standing.score = scores !== null && standing.votes >= ARENA_SCORE_MIN_VOTES ? (scores[i] as number) : null;
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
