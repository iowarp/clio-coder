/**
 * Pure grading, ported from clio-researcher's grader: the median relative delta between base and candidate, a
 * bootstrap 95% percentile interval over whole trials resampled within each side, and the classification against the
 * objective's direction and minimum improvement. The resampler is seeded, and the seed is recorded with every grade,
 * so `research report` recomputes the identical interval from the raw samples.
 */
import type { ResearchDirection, ResearchGrade } from "./types.js";

const CI_LOW = 0.025;
const CI_HIGH = 0.975;

/** Linear interpolation between order statistics of an ascending, non-empty array. */
export function percentile(sorted: ReadonlyArray<number>, q: number): number {
	const rank = (sorted.length - 1) * q;
	const low = Math.floor(rank);
	const fraction = rank - low;
	const at = sorted[low] as number;
	if (fraction === 0 || low + 1 >= sorted.length) return at;
	return at + fraction * ((sorted[low + 1] as number) - at);
}

export function median(values: ReadonlyArray<number>): number | null {
	if (values.length === 0) return null;
	return percentile(
		[...values].sort((a, b) => a - b),
		0.5,
	);
}

/** `(candidate - base) / |base|`; zero over zero is no change, and anything else over zero is undefined. */
export function relativeDelta(base: number, candidate: number): number | null {
	if (base === 0) return candidate === 0 ? 0 : null;
	return (candidate - base) / Math.abs(base);
}

export function classify(
	direction: ResearchDirection,
	minImprovement: number,
	base: number,
	candidate: number,
): "improved" | "unchanged" | "regressed" {
	const delta = relativeDelta(base, candidate);
	if (delta === null) {
		const better = direction === "min" ? candidate < base : candidate > base;
		return better ? "improved" : "regressed";
	}
	const gain = direction === "min" ? -delta : delta;
	if (gain >= minImprovement) return "improved";
	if (gain <= -minImprovement) return "regressed";
	return "unchanged";
}

/** mulberry32: a small, well-mixed 32-bit generator, reproducible on every platform for an integer seed. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function bootstrapInterval(
	base: ReadonlyArray<number>,
	candidate: ReadonlyArray<number>,
	seed: number,
	resamples: number,
): { low: number; high: number } | null {
	if (base.length === 0 || candidate.length === 0) return null;
	const draw = seededRandom(seed);
	const resample = (pool: ReadonlyArray<number>): number => {
		const drawn: number[] = [];
		for (let index = 0; index < pool.length; index++) drawn.push(pool[Math.floor(draw() * pool.length)] as number);
		return median(drawn) as number;
	};
	const deltas: number[] = [];
	for (let index = 0; index < resamples; index++) {
		const delta = relativeDelta(resample(base), resample(candidate));
		if (delta === null) return null;
		deltas.push(delta);
	}
	deltas.sort((a, b) => a - b);
	return { low: percentile(deltas, CI_LOW), high: percentile(deltas, CI_HIGH) };
}

/** Whether an interval excludes zero on the side the direction calls better. */
function intervalSupports(direction: ResearchDirection, ci: { low: number; high: number }): boolean {
	return direction === "min" ? ci.high < 0 : ci.low > 0;
}

/** Whether an interval excludes zero on either side. */
export function intervalExcludesZero(ci: { low: number; high: number } | null): boolean {
	return ci !== null && (ci.high < 0 || ci.low > 0);
}

export interface GradeInput {
	direction: ResearchDirection;
	minImprovement: number;
	base: ReadonlyArray<number>;
	candidate: ReadonlyArray<number>;
	seed: number;
	resamples: number;
}

/**
 * Grade a candidate against its base. `improved` needs both the median delta to clear `minImprovement` and the
 * interval to exclude zero on the improving side; `regressed` is the mirror. A delta that clears the threshold
 * without an interval to back it is `inconclusive`, never a win.
 */
export function grade(input: GradeInput): ResearchGrade {
	const baseMedian = median(input.base);
	const candidateMedian = median(input.candidate);
	const common = { seed: input.seed, resamples: input.resamples };
	if (baseMedian === null || candidateMedian === null) {
		return {
			verdict: "inconclusive",
			classification: "undefined",
			baseMedian,
			candidateMedian,
			delta: null,
			ci: null,
			...common,
		};
	}
	const classification = classify(input.direction, input.minImprovement, baseMedian, candidateMedian);
	const ci = bootstrapInterval(input.base, input.candidate, input.seed, input.resamples);
	const delta = relativeDelta(baseMedian, candidateMedian);
	let verdict: ResearchGrade["verdict"] = classification === "unchanged" ? "unchanged" : "inconclusive";
	if (classification === "improved" && ci !== null && intervalSupports(input.direction, ci)) verdict = "improved";
	if (classification === "regressed" && ci !== null && intervalSupports(input.direction === "min" ? "max" : "min", ci))
		verdict = "regressed";
	return { verdict, classification, baseMedian, candidateMedian, delta, ci, ...common };
}

/**
 * The A/A check: base measured against base. The objective is too noisy when this already calls a change, that is
 * when the medians differ by at least `minImprovement` and the interval excludes zero.
 */
export function aaIsNoisy(aa: ResearchGrade): boolean {
	return aa.classification !== "unchanged" && intervalExcludesZero(aa.ci);
}
