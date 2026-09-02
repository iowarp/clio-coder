/**
 * Deterministic, balanced AB/BA scheduling.
 *
 * A trial's result depends on which arm ran first: the second arm of a pair
 * meets a warmer server, a fuller page cache, and a slightly different machine.
 * Counterbalancing is what removes that from the comparison, so the schedule is
 * built as *blocks* — one block is the same scenario, stratum, and repetition
 * run once per arm — and half the blocks run AB while half run BA.
 *
 * Everything here is a pure function of `(seed, experimentId, corpus, ...)`, so
 * two machines that agree on the configuration produce byte-identical plans.
 * That is what makes a resumed run safe: the plan is recomputed, not reloaded.
 */
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";
import type { PromptAbArmId, PromptAbScenario, PromptAbStratum } from "./contract.js";

/** One arm's execution slot inside a block. */
export interface PromptAbPlannedTrial {
	trialId: string;
	blockId: string;
	scenarioId: string;
	stratum: PromptAbStratum;
	repetition: number;
	armId: PromptAbArmId;
	/** 0 for the arm that runs first in this block, 1 for the second. */
	pairIndex: number;
}

export interface PromptAbPlannedBlock {
	blockId: string;
	scenarioId: string;
	stratum: PromptAbStratum;
	repetition: number;
	/** "AB" runs the first configured arm first; "BA" reverses it. */
	order: "AB" | "BA";
	trials: readonly PromptAbPlannedTrial[];
}

export interface PromptAbPlan {
	/** Blocks in execution order. */
	blocks: readonly PromptAbPlannedBlock[];
	/** Every trial, flattened in execution order. */
	trials: readonly PromptAbPlannedTrial[];
}

export interface BuildPromptAbPlanInput {
	experimentId: string;
	seed: number;
	repetitions: number;
	strata: readonly PromptAbStratum[];
	scenarios: readonly PromptAbScenario[];
	/** Exactly two arm ids, in configured order. The first is the "A" position of an AB block. */
	arms: readonly PromptAbArmId[];
}

/**
 * A small deterministic PRNG.
 *
 * `Math.random` is unusable here because a plan has to be reproducible from the
 * seed alone. SplitMix64 folded into 32 bits is enough for shuffling a few
 * hundred blocks and has no dependency to pin.
 */
export function createSeededRandom(seedText: string): () => number {
	const digest = sha256(seedText);
	let state = BigInt(`0x${digest.slice(0, 16)}`);
	const mask = (1n << 64n) - 1n;
	return () => {
		state = (state + 0x9e3779b97f4a7c15n) & mask;
		let z = state;
		z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
		z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
		z = z ^ (z >> 31n);
		// 53 bits is exactly what a double represents without loss.
		return Number(z >> 11n) / 2 ** 53;
	};
}

/** Fisher-Yates against a seeded generator. Returns a new array; the input is untouched. */
export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
	const shuffled = [...items];
	for (let index = shuffled.length - 1; index > 0; index--) {
		const swap = Math.floor(random() * (index + 1));
		const left = shuffled[index] as T;
		const right = shuffled[swap] as T;
		shuffled[index] = right;
		shuffled[swap] = left;
	}
	return shuffled;
}

/**
 * Build the full plan.
 *
 * Order assignment is balanced *within* each (scenario, stratum) cell before it
 * is shuffled, rather than drawn independently per block. An independent coin
 * flip per block would leave a cell at 7 AB and 1 BA often enough to matter at
 * five repetitions; constructing the balanced multiset first makes the
 * imbalance at most one block per cell by construction, which is the property
 * the comparison actually needs.
 */
export function buildPromptAbPlan(input: BuildPromptAbPlanInput): PromptAbPlan {
	if (input.arms.length !== 2) throw new Error("prompt-ab scheduling needs exactly two arms");
	if (input.repetitions < 1) throw new Error("prompt-ab scheduling needs at least one repetition");
	const [firstArm, secondArm] = input.arms as [PromptAbArmId, PromptAbArmId];
	if (firstArm === secondArm) throw new Error("prompt-ab scheduling needs two distinct arms");

	const blocks: PromptAbPlannedBlock[] = [];
	for (const scenario of input.scenarios) {
		for (const stratum of input.strata) {
			const cellRandom = createSeededRandom(canonicalJson([input.experimentId, input.seed, "cell", scenario.id, stratum]));
			const orders = balancedOrders(input.repetitions, cellRandom);
			for (let repetition = 0; repetition < input.repetitions; repetition++) {
				const order = orders[repetition] as "AB" | "BA";
				const blockId = `${scenario.id}|${stratum}|r${repetition}`;
				const armOrder: PromptAbArmId[] = order === "AB" ? [firstArm, secondArm] : [secondArm, firstArm];
				blocks.push({
					blockId,
					scenarioId: scenario.id,
					stratum,
					repetition,
					order,
					trials: armOrder.map((armId, pairIndex) => ({
						trialId: `${scenario.id}|${stratum}|r${repetition}|${armId}`,
						blockId,
						scenarioId: scenario.id,
						stratum,
						repetition,
						armId,
						pairIndex,
					})),
				});
			}
		}
	}

	// Blocks are shuffled so a slow drift in the server over the run does not
	// land entirely on one scenario. The two trials inside a block always stay
	// adjacent: that adjacency is the pairing the comparison relies on.
	const runRandom = createSeededRandom(canonicalJson([input.experimentId, input.seed, "blocks"]));
	const ordered = seededShuffle(blocks, runRandom);
	return { blocks: ordered, trials: ordered.flatMap((block) => block.trials) };
}

/**
 * A balanced multiset of AB/BA orders for one cell, then shuffled.
 *
 * With an odd repetition count the extra block's order is drawn from the cell's
 * own generator, so the leftover leans AB in some cells and BA in others rather
 * than always the same way.
 */
function balancedOrders(repetitions: number, random: () => number): Array<"AB" | "BA"> {
	const half = Math.floor(repetitions / 2);
	const orders: Array<"AB" | "BA"> = [
		...Array.from({ length: half }, () => "AB" as const),
		...Array.from({ length: half }, () => "BA" as const),
	];
	if (repetitions % 2 === 1) orders.push(random() < 0.5 ? "AB" : "BA");
	return seededShuffle(orders, random);
}

/** Per-cell AB/BA counts, used by the scheduling contract test and the run summary. */
export function promptAbOrderBalance(plan: PromptAbPlan): Map<string, { ab: number; ba: number }> {
	const balance = new Map<string, { ab: number; ba: number }>();
	for (const block of plan.blocks) {
		const key = `${block.scenarioId}|${block.stratum}`;
		const cell = balance.get(key) ?? { ab: 0, ba: 0 };
		if (block.order === "AB") cell.ab += 1;
		else cell.ba += 1;
		balance.set(key, cell);
	}
	return balance;
}
