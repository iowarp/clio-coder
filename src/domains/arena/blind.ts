import { ARENA_LABELS, type ArenaChoice, type ArenaLabel, type ArenaMatch } from "./types.js";

/** mulberry32: a small seeded generator, so a match's order is reproducible from its stored seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The display order for `count` contenders: `order[k]` is the contender index under label k. */
export function blindOrder(count: number, seed: number): number[] {
	const order = Array.from({ length: count }, (_, index) => index);
	const next = mulberry32(seed);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[order[i], order[j]] = [order[j] as number, order[i] as number];
	}
	return order;
}

export function newArenaSeed(): number {
	return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

export function matchLabels(match: Pick<ArenaMatch, "order">): ArenaLabel[] {
	return ARENA_LABELS.slice(0, match.order.length);
}

/** The contender a label names in this match, or null when the label is past the match's size. */
export function contenderForLabel(match: Pick<ArenaMatch, "order">, label: ArenaLabel): number | null {
	const index = ARENA_LABELS.indexOf(label);
	const contender = match.order[index];
	return contender === undefined ? null : contender;
}

/** The blind label a contender shows under; progress names this, never the contender's input position. */
export function labelForContender(match: Pick<ArenaMatch, "order">, index: number): ArenaLabel {
	return ARENA_LABELS[match.order.indexOf(index)] as ArenaLabel;
}

export function isArenaChoice(value: string): value is ArenaChoice {
	return value === "tie" || value === "both-bad" || (ARENA_LABELS as ReadonlyArray<string>).includes(value);
}

/** A choice is valid for a match when it is tie, both-bad, or a label the match shows. */
export function choiceFitsMatch(match: Pick<ArenaMatch, "order">, choice: ArenaChoice): boolean {
	if (choice === "tie" || choice === "both-bad") return true;
	return contenderForLabel(match, choice) !== null;
}
