import type { HintEntry } from "../overlay-frame.js";

const LABEL_MAX = 32;

/**
 * The rail a destructive key shows after its first press: the same key again does it, any other key keeps
 * the row. One shape for every list, so a removal never happens on a single stray letter.
 */
export function confirmOnceRail(key: string, verb: string, label: string): HintEntry[] {
	const flat = label.replace(/\s+/gu, " ").trim();
	const short = flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
	return [
		{ key: `${key} again`, verb: `to ${verb} "${short}"`, short: verb, critical: true },
		{ key: "any other key", verb: "keeps it", short: "keep" },
	];
}
