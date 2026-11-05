import type { HintEntry } from "./overlay-frame.js";

/**
 * One rule for Esc on every surface that owns the keyboard: it backs out of the
 * innermost open layer, and only that one. A details view, a terms fold, a typed
 * filter, a text field or a submenu is a layer; the surface itself is the last.
 *
 * Every overlay used to keep two hand-written lists that had to agree, one for
 * what Esc did and one for what the rail said it did, and they drifted: the
 * permission card's terms fold said `[Esc] deny` and a press denied the call
 * from inside a view the operator had only opened to read. A surface now lists
 * its layers once, innermost first, and both the key and the rail read that list,
 * so the word on the rail is always the move the key makes.
 *
 * Backing out of a layer never commits anything. Only the outermost layer of a
 * decision card may answer, and its verb then names the answer (`deny`,
 * `cancel interview`) so the operator reads what the press decides before it.
 */
export interface EscapeLayer {
	/** What Esc does while this is the innermost open layer, in the rail's words. */
	readonly verb: string;
	/** A shorter spelling for a narrow rail. */
	readonly short?: string;
	/** Back out of this layer. */
	readonly back: () => void;
}

/** A surface's layers, innermost first. A falsy entry is a layer that is not open right now. */
export type EscapeLayers = ReadonlyArray<EscapeLayer | false | null | undefined>;

/** The layer the next Esc backs out of. */
export function innermostEscapeLayer(layers: EscapeLayers): EscapeLayer | null {
	for (const layer of layers) if (layer) return layer;
	return null;
}

/** Back out of the innermost open layer; false when nothing is open. */
export function backOutOneLayer(layers: EscapeLayers): boolean {
	const layer = innermostEscapeLayer(layers);
	if (layer === null) return false;
	layer.back();
	return true;
}

/** The rail entry for Esc, worded from the same layer the key backs out of. */
export function escapeHintEntry(layers: EscapeLayers, critical?: boolean): HintEntry | null {
	const layer = innermostEscapeLayer(layers);
	if (layer === null) return null;
	return {
		key: "Esc",
		verb: layer.verb,
		...(layer.short !== undefined ? { short: layer.short } : {}),
		...(critical !== undefined ? { critical } : {}),
	};
}
