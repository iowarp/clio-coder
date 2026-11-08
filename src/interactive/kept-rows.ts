/**
 * What a row producer knows, without comparing, about the rows it returns: how many leading rows are the very
 * strings of the rows it returned before. A streaming reply changes only its last rows, yet each layer between the
 * Markdown tail and the terminal renderer used to find that out by scanning every row of the reply, every frame.
 *
 * A record names the array it was taken against, so a consumer only trusts it against the array it holds itself:
 * a producer called again in between (another width, a prerender) leaves a record no consumer matches.
 */
type KeptRecord = { base: readonly string[]; count: number };
/** Two layers may hand on the same array, each against the array it returned before, so a list holds both records. */
const kept = new WeakMap<readonly string[], KeptRecord[]>();
const RECORDS_PER_ROWS = 2;

/** Record that the first `count` rows of `rows` are the very strings of the first `count` rows of `base`. */
export function keepRows(rows: readonly string[], base: readonly string[] | undefined, count: number): void {
	if (base === undefined || rows === base) return;
	const bounded = Math.min(count, rows.length, base.length);
	const records = (kept.get(rows) ?? []).filter((record) => record.base !== base);
	if (bounded > 0) records.unshift({ base, count: bounded });
	if (records.length > RECORDS_PER_ROWS) records.length = RECORDS_PER_ROWS;
	kept.set(rows, records);
}

/** How many leading rows of `rows` are known to be the very strings of `base`'s, without comparing them. */
export function keptRows(rows: readonly string[], base: readonly string[] | undefined): number {
	if (base === undefined) return 0;
	if (rows === base) return rows.length;
	return kept.get(rows)?.find((record) => record.base === base)?.count ?? 0;
}

/** One stretch of a joined row list: `rows[start, end)`. */
export interface RowPiece {
	rows: readonly string[];
	start: number;
	end: number;
}

/**
 * How many leading rows two joins of pieces share, from what is known about each piece: whole pieces that are the
 * same stretch of the same array, then as much of the first differing piece as its producer vouches for.
 */
export function keptPieceRows(pieces: readonly RowPiece[], previous: readonly RowPiece[]): number {
	let count = 0;
	for (let index = 0; index < pieces.length; index += 1) {
		const piece = pieces[index] as RowPiece;
		const before = previous[index];
		if (before === undefined || piece.start !== before.start) return count;
		if (piece.rows === before.rows && piece.end === before.end) {
			count += piece.end - piece.start;
			continue;
		}
		// A short piece rebuilt each frame (a notice row, a gap) is compared, so it does not end what is kept.
		if (piece.end - piece.start <= SHORT_PIECE_ROWS && samePieceRows(piece, before)) {
			count += piece.end - piece.start;
			continue;
		}
		const shared = Math.min(keptRows(piece.rows, before.rows), piece.end, before.end);
		return count + Math.max(0, shared - piece.start);
	}
	return count;
}

const SHORT_PIECE_ROWS = 8;

function samePieceRows(piece: RowPiece, before: RowPiece): boolean {
	if (piece.end - piece.start !== before.end - before.start) return false;
	for (let offset = 0; offset < piece.end - piece.start; offset += 1)
		if (piece.rows[piece.start + offset] !== before.rows[before.start + offset]) return false;
	return true;
}
