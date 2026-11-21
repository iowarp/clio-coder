/**
 * Per-entry row regions of the transcript. A run is a stretch of settled entries whose rows were joined once into one
 * array, with the row each entry starts at, so a frame hands the run on by identity instead of walking its entries,
 * and a change to one entry gives up only that entry's rows. Runs end at every entry still changing (a streaming turn,
 * a running worker card, a queued prompt), so a live entry anywhere in a long session costs a frame its own rows and
 * nothing behind it.
 */
export interface EntryRun {
	/** The run covers transcript entries `[from, to)`. */
	readonly from: number;
	readonly to: number;
	/** Every row of the covered entries, each entry's leading gap included. Never mutated. */
	readonly rows: readonly string[];
	/** The row of `rows` each covered entry starts at; `starts[0]` is 0. */
	readonly starts: readonly number[];
	/** The layout key the rows were rendered at. */
	readonly key: string;
}

/** `rows` joined into one new array of `total` rows, sized once: a long session joins tens of thousands. */
export function joinRows(parts: readonly (readonly string[])[], total: number): string[] {
	const out = new Array<string>(total);
	let row = 0;
	for (const part of parts) for (let index = 0; index < part.length; index += 1) out[row++] = part[index] as string;
	out.length = row;
	return out;
}

/** The part of `run` that covers entries `[from, to)`, or null when that is none of it. */
function cut(run: EntryRun, from: number, to: number): EntryRun | null {
	const first = Math.max(from, run.from);
	const last = Math.min(to, run.to);
	if (first >= last) return null;
	if (first === run.from && last === run.to) return run;
	const startRow = run.starts[first - run.from] as number;
	const endRow = last === run.to ? run.rows.length : (run.starts[last - run.from] as number);
	const starts: number[] = [];
	for (let index = first; index < last; index += 1) starts.push((run.starts[index - run.from] as number) - startRow);
	return { from: first, to: last, rows: run.rows.slice(startRow, endRow), starts, key: run.key };
}

/** The runs of one transcript, in entry order and never overlapping. */
export class EntryRuns {
	private runs: EntryRun[] = [];

	get list(): readonly EntryRun[] {
		return this.runs;
	}

	replace(runs: EntryRun[]): void {
		this.runs = runs;
	}

	clear(): void {
		this.runs = [];
	}

	/** The index in `list` of the run covering entry `index`, or -1. */
	private find(index: number): number {
		let low = 0;
		let high = this.runs.length - 1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			const run = this.runs[middle] as EntryRun;
			if (index < run.from) high = middle - 1;
			else if (index >= run.to) low = middle + 1;
			else return middle;
		}
		return -1;
	}

	/** Entry `index` changed: its run gives up that entry's rows and keeps the entries on either side as two runs. */
	release(index: number): void {
		const at = this.find(index);
		if (at < 0) return;
		const run = this.runs[at] as EntryRun;
		const parts = [cut(run, run.from, index), cut(run, index + 1, run.to)].filter((part) => part !== null);
		this.runs.splice(at, 1, ...parts);
	}

	/**
	 * An entry was inserted at `at`: every run behind it covers the next index, and a run it lands inside splits
	 * there. The entry after the new one has a new predecessor, which its owner releases.
	 */
	insert(at: number): void {
		const next: EntryRun[] = [];
		for (const run of this.runs) {
			if (run.to <= at) {
				next.push(run);
				continue;
			}
			const before = cut(run, run.from, at);
			if (before !== null) next.push(before);
			const behind = cut(run, at, run.to);
			if (behind !== null) next.push({ ...behind, from: behind.from + 1, to: behind.to + 1 });
		}
		this.runs = next;
	}

	/** Runs meet at entry `index` from now on: a run covering both sides of it splits there, keeping all its rows. */
	splitAt(index: number): void {
		const at = this.find(index);
		const run = this.runs[at];
		if (run === undefined || run.from === index) return;
		this.runs.splice(at, 1, cut(run, run.from, index) as EntryRun, cut(run, index, run.to) as EntryRun);
	}

	/** The transcript is `length` entries long now: the rows of entries past its end go. */
	truncate(length: number): void {
		if ((this.runs.at(-1)?.to ?? 0) <= length) return;
		this.runs = this.runs.flatMap((run) => {
			const part = cut(run, run.from, length);
			return part === null ? [] : [part];
		});
	}
}

/** Where a piece of a frame sits: its first row, its row count and the first entry it holds rows of. */
export interface PlacedPiece {
	readonly start: number;
	readonly rows: number;
	/** The entry the piece belongs to; a run's first entry. */
	readonly from: number;
	readonly run?: EntryRun;
}

/** The entry a frame's row belongs to and the row that entry starts at, its leading gap included. */
function entryAtRow(layout: readonly PlacedPiece[], row: number): { entry: number; start: number } | null {
	let low = 0;
	let high = layout.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const piece = layout[middle] as PlacedPiece;
		if (row < piece.start) high = middle - 1;
		else if (row >= piece.start + piece.rows) low = middle + 1;
		else if (piece.run !== undefined) {
			const offset = row - piece.start;
			let first = 0;
			let last = piece.run.starts.length - 1;
			while (first < last) {
				const mid = (first + last + 1) >> 1;
				if ((piece.run.starts[mid] as number) <= offset) first = mid;
				else last = mid - 1;
			}
			return { entry: piece.run.from + first, start: piece.start + (piece.run.starts[first] as number) };
		} else {
			let lead = middle;
			while (lead > 0 && layout[lead - 1]?.run === undefined && layout[lead - 1]?.from === piece.from) lead -= 1;
			return { entry: piece.from, start: (layout[lead] as PlacedPiece).start };
		}
	}
	return null;
}

/** The rows `[start, end)` entry `index` spans in a frame, or null when the frame drew none of it. */
export function entryRows(layout: readonly PlacedPiece[], index: number): { start: number; end: number } | null {
	let low = 0;
	let high = layout.length - 1;
	let found = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if ((layout[middle] as PlacedPiece).from <= index) {
			found = middle;
			low = middle + 1;
		} else high = middle - 1;
	}
	const piece = layout[found];
	if (piece === undefined) return null;
	if (piece.run !== undefined) {
		if (index >= piece.run.to) return null;
		const at = index - piece.run.from;
		const next = piece.run.starts[at + 1];
		return {
			start: piece.start + (piece.run.starts[at] as number),
			end: piece.start + (next === undefined ? piece.rows : next),
		};
	}
	if (piece.from !== index) return null;
	let lead = found;
	while (lead > 0 && layout[lead - 1]?.run === undefined && layout[lead - 1]?.from === index) lead -= 1;
	return { start: (layout[lead] as PlacedPiece).start, end: piece.start + piece.rows };
}

/** Where the operator's viewport sits over the transcript, in transcript rows from its end; 0 follows the end. */
export interface TranscriptViewport {
	fromEnd: number;
	rows: number;
}

/**
 * What a re-layout renders first, read off the frame before it: the entries `[lo, hi)` within a screen of the
 * viewport, and the entry its top row sits in, with how far into it, so the viewport can stay on that row.
 */
export function viewportWindow(
	layout: readonly PlacedPiece[],
	total: number,
	entries: number,
	viewport: TranscriptViewport,
): { lo: number; hi: number; anchor: { entry: number; offset: number; top: number } | null } {
	if (total === 0) return { lo: 0, hi: entries, anchor: null };
	const bottom = Math.max(0, total - Math.max(0, viewport.fromEnd));
	const top = Math.max(0, bottom - viewport.rows);
	const lo = entryAtRow(layout, Math.max(0, top - viewport.rows))?.entry ?? 0;
	const below = bottom + viewport.rows;
	const hi = below >= total ? entries : (entryAtRow(layout, below)?.entry ?? entries - 1) + 1;
	const at = entryAtRow(layout, top);
	return { lo, hi, anchor: at === null ? null : { entry: at.entry, offset: top - at.start, top } };
}
