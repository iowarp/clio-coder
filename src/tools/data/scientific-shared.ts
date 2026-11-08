import {
	cutView,
	type DataRefusal,
	DataRefusalError,
	type DataViewFlags,
	exactView,
	refusal,
	sampledView,
} from "./shared.js";

/**
 * Shared substrate for the HDF5, NetCDF and Parquet readers: the request and
 * result envelopes that cross the worker boundary, the caps every result
 * obeys, JSON-safe value encoding, hyperslab arithmetic, the slab walk that
 * keeps a stats pass bounded in memory, and the accumulator that computes the
 * summary. Runs inside the reader worker; it imports nothing that loads a
 * reader library.
 */

export type ScientificFormat = "hdf5" | "netcdf" | "parquet";
export type ScientificOp = "inspect" | "select" | "stats";

export interface ScientificRequest {
	op: ScientificOp;
	/** The container as sniffed: NetCDF-4 files arrive here as "hdf5". */
	container: "hdf5" | "netcdf3" | "parquet";
	path: string;
	/** HDF5/NetCDF variable or group path; Parquet column for stats. */
	variable?: string;
	start?: number[];
	count?: number[];
	stride?: number[];
	/** Parquet row window. */
	offset?: number;
	limit?: number;
	columns?: string[];
	/** stats: raw bytes read before the pass stops. */
	maxBytes?: number;
}

export type ScientificResult = Record<string, unknown> & { format: ScientificFormat; view: DataViewFlags };

export type ScientificReply = { ok: true; result: ScientificResult } | { ok: false; refusal: DataRefusal };

/** Elements returned by op=select when count is omitted. */
export const DEFAULT_SELECT_ELEMENTS = 200;
/** Elements op=select may return at all; an explicit count above it is refused. */
export const MAX_SELECT_ELEMENTS = 2000;
/** Bytes of rendered values in one select result, inside the tool's 32 KiB observation cap. */
export const SELECT_VALUE_BYTES = 24 * 1024;
/** Bytes of one rendered inspect result before it degrades to a compact listing. */
export const INSPECT_RESULT_BYTES = 28 * 1024;
/** Raw bytes one stats pass reads by default, and the most it may be given. */
export const DEFAULT_STATS_BYTES = 256 * 1024 * 1024;
export const MAX_STATS_BYTES = 8 * 1024 * 1024 * 1024;
/** Raw bytes per read inside a stats pass; the reader's heap never holds more than about this. */
export const SLAB_BYTES = 8 * 1024 * 1024;
/** A stats pass returns what it has after this long rather than run to the worker's hard timeout. */
export const STATS_DEADLINE_MS = 60_000;
/** Objects one inspect walk visits before it stops listing. */
export const INSPECT_MAX_OBJECTS = 5000;
/** Variables listed in one inspect result. */
export const INSPECT_MAX_VARIABLES = 200;
export const ATTRIBUTE_LIMIT = 64;
export const ATTRIBUTE_TEXT_CHARS = 256;
export const ATTRIBUTE_ARRAY_ITEMS = 16;
export const CELL_TEXT_CHARS = 256;

/** CF attributes surfaced in each variable's `cf` block when present. */
export const CF_ATTRIBUTES = [
	"units",
	"long_name",
	"standard_name",
	"_FillValue",
	"missing_value",
	"scale_factor",
	"add_offset",
	"calendar",
	"valid_min",
	"valid_max",
	"valid_range",
	"coordinates",
] as const;

export { cutView, exactView, sampledView };

export function refuse(reason: DataRefusal["reason"], message: string): never {
	throw new DataRefusalError(refusal(reason, message));
}

/** The shortest decimal that reads back as the same float32, so 285.44345 never prints as 285.4434509277344. */
function float32Text(value: number): number {
	if (!Number.isFinite(value) || value === 0) return value;
	for (let digits = 1; digits <= 9; digits += 1) {
		const candidate = Number(value.toPrecision(digits));
		if (Math.fround(candidate) === value) return candidate;
	}
	return value;
}

export type EncodedValue = number | string | boolean | null | { [key: string]: unknown } | EncodedValue[];

/**
 * One value made JSON-safe without changing what it says: an integer beyond
 * 2^53 and every non-finite float become a `$literal`, long text is cut with a
 * `$truncated` marker, bytes become hex, and float32 values print at their own
 * precision.
 */
export function encodeValue(value: unknown, float32 = false, depth = 0): EncodedValue {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		if (Number.isNaN(value)) return { $literal: "NaN" };
		if (!Number.isFinite(value)) return { $literal: value > 0 ? "Infinity" : "-Infinity" };
		return float32 ? float32Text(value) : value;
	}
	if (typeof value === "bigint") {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: { $literal: value.toString(), precision: "unsafe-integer" };
	}
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		return value.length <= CELL_TEXT_CHARS
			? value
			: { $truncated: "string", length: value.length, text: value.slice(0, CELL_TEXT_CHARS) };
	}
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? { $literal: "Invalid Date" } : value.toISOString();
	if (value instanceof Uint8Array) {
		const hex = Buffer.from(value.subarray(0, 32)).toString("hex");
		return value.length <= 32 ? { $bytes: value.length, hex } : { $bytes: value.length, hex, truncated: true };
	}
	if (depth > 8) return { $truncated: "nesting" };
	if (ArrayBuffer.isView(value)) {
		const items = Array.from(value as unknown as ArrayLike<number | bigint>);
		return items.map((item) => encodeValue(item, value instanceof Float32Array, depth + 1));
	}
	if (Array.isArray(value)) return value.map((item) => encodeValue(item, float32, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, EncodedValue> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>))
			out[key] = encodeValue(item, false, depth + 1);
		return out;
	}
	return String(value);
}

/** An attribute value cut to its budget: a length-1 array reads as its element, long arrays keep a prefix. */
export function encodeAttribute(value: unknown): EncodedValue {
	let items: unknown[] | null = null;
	if (ArrayBuffer.isView(value)) items = Array.from(value as unknown as ArrayLike<number | bigint>);
	else if (Array.isArray(value)) items = value;
	const float32 = value instanceof Float32Array;
	const scalar = (item: unknown): EncodedValue => {
		const encoded = encodeValue(item, float32);
		return typeof encoded === "string" && encoded.length > ATTRIBUTE_TEXT_CHARS
			? { $truncated: "string", length: encoded.length, text: encoded.slice(0, ATTRIBUTE_TEXT_CHARS) }
			: encoded;
	};
	if (items === null) return scalar(value);
	if (items.length === 1) return scalar(items[0]);
	const head = items.slice(0, ATTRIBUTE_ARRAY_ITEMS).map((item) => encodeValue(item, float32));
	return items.length <= ATTRIBUTE_ARRAY_ITEMS ? head : { $truncated: "array", length: items.length, items: head };
}

/** The CF block for a variable: the conventional attributes it carries, encoded as reported. */
export function cfBlock(attributes: Record<string, EncodedValue>): Record<string, EncodedValue> | undefined {
	const out: Record<string, EncodedValue> = {};
	for (const key of CF_ATTRIBUTES) if (key in attributes) out[key] = attributes[key] as EncodedValue;
	return Object.keys(out).length > 0 ? out : undefined;
}

export interface Hyperslab {
	start: number[];
	count: number[];
	stride: number[];
}

function nonNegativeIntegers(
	value: number[] | undefined,
	rank: number,
	name: string,
	min: number,
): number[] | undefined {
	if (value === undefined) return undefined;
	if (value.length !== rank)
		refuse("invalid-argument", `${name} has ${value.length} entries; the variable has ${rank} dimensions`);
	for (const entry of value) {
		if (!Number.isInteger(entry) || entry < min)
			refuse("invalid-argument", `${name} entries must be integers >= ${min}; got ${entry}`);
	}
	return value;
}

export function product(values: ReadonlyArray<number>): number {
	return values.reduce((total, value) => total * value, 1);
}

/**
 * Resolve a requested hyperslab against a shape. `count` omitted means "as
 * much as remains from start", which the caller may then cap; an explicit
 * count that runs past the extent is refused rather than clipped, so a
 * selection never silently returns less than it named.
 */
export function resolveHyperslab(
	shape: ReadonlyArray<number>,
	request: Pick<ScientificRequest, "start" | "count" | "stride">,
): {
	slab: Hyperslab;
	explicitCount: boolean;
} {
	const rank = shape.length;
	const start = nonNegativeIntegers(request.start, rank, "start", 0) ?? shape.map(() => 0);
	const stride = nonNegativeIntegers(request.stride, rank, "stride", 1) ?? shape.map(() => 1);
	const explicit = nonNegativeIntegers(request.count, rank, "count", 1);
	const count = shape.map((extent, dim) => {
		const first = start[dim] as number;
		if (first >= extent && extent > 0)
			refuse("invalid-argument", `start[${dim}] = ${first} is outside dimension ${dim} of length ${extent}`);
		const available = extent === 0 ? 0 : Math.floor((extent - 1 - first) / (stride[dim] as number)) + 1;
		const wanted = explicit?.[dim];
		if (wanted === undefined) return available;
		if (wanted > available) {
			refuse(
				"invalid-argument",
				`count[${dim}] = ${wanted} runs past dimension ${dim} (length ${extent}); at most ${available} fit from start ${first} with stride ${stride[dim]}`,
			);
		}
		return wanted;
	});
	return { slab: { start, count, stride }, explicitCount: explicit !== undefined };
}

/**
 * Shrink an implicit count to `budget` elements: whole trailing dimensions are
 * kept while they fit, the first one that does not is cut, and every leading
 * dimension collapses to one index. The result is a contiguous row-major
 * prefix of the requested hyperslab.
 */
export function capCount(count: ReadonlyArray<number>, budget: number): number[] {
	const out = [...count];
	let inner = 1;
	for (let dim = out.length - 1; dim >= 0; dim -= 1) {
		const extent = out[dim] as number;
		if (inner * extent <= budget) {
			inner *= extent;
			continue;
		}
		out[dim] = Math.max(1, Math.floor(budget / inner));
		for (let lead = dim - 1; lead >= 0; lead -= 1) out[lead] = Math.min(1, out[lead] as number);
		break;
	}
	return out;
}

/**
 * Walk a stride-1 hyperslab of a chunked variable tile by tile, each tile a
 * whole number of chunks cut at chunk boundaries in file coordinates, so every
 * chunk is decompressed once. HDF5's chunk cache (1 MB by default, and not
 * adjustable through the bundled reader) cannot hold a chunk row for a
 * row-major slab, which re-reads each chunk once per slab that crosses it.
 * Tiles are visited in row-major order of the tile grid. Returns null when
 * the walk does not apply (strided selection, or one chunk over budget).
 */
export function chunkTiles(
	selection: Hyperslab,
	chunks: ReadonlyArray<number>,
	maxElements: number,
): Generator<Hyperslab> | null {
	const rank = selection.count.length;
	if (rank === 0 || chunks.length !== rank || selection.stride.some((step) => step !== 1)) return null;
	if (product(chunks) > maxElements) return null;
	const tile = [...chunks];
	for (let dim = rank - 1; dim >= 0; dim -= 1) {
		const others = product(tile) / (tile[dim] as number);
		const fit = Math.floor(maxElements / others / (chunks[dim] as number)) * (chunks[dim] as number);
		const span = Math.ceil((selection.count[dim] as number) / (chunks[dim] as number) + 1) * (chunks[dim] as number);
		tile[dim] = Math.max(chunks[dim] as number, Math.min(fit, span));
		if ((tile[dim] as number) < span) break;
	}
	// Segments of each dimension's selected range, cut at multiples of the tile edge.
	const segments = selection.count.map((count, dim) => {
		const out: Array<[number, number]> = [];
		const first = selection.start[dim] as number;
		const end = first + count;
		const edge = tile[dim] as number;
		for (let at = first; at < end; ) {
			const next = Math.min(end, (Math.floor(at / edge) + 1) * edge);
			out.push([at, next - at]);
			at = next;
		}
		return out;
	});
	return (function* walk(): Generator<Hyperslab> {
		if (segments.some((list) => list.length === 0)) return;
		const index = new Array<number>(rank).fill(0);
		for (;;) {
			const start = index.map((at, dim) => (segments[dim]?.[at] as [number, number])[0]);
			const count = index.map((at, dim) => (segments[dim]?.[at] as [number, number])[1]);
			yield { start, count, stride: selection.stride };
			let dim = rank - 1;
			while (dim >= 0) {
				index[dim] = (index[dim] as number) + 1;
				if ((index[dim] as number) < (segments[dim] as unknown[]).length) break;
				index[dim] = 0;
				dim -= 1;
			}
			if (dim < 0) return;
		}
	})();
}

/**
 * Walk a hyperslab as row-major slabs of at most `maxElements` elements. Each
 * slab is itself a hyperslab in file coordinates, so every format reads it the
 * same way it reads a selection.
 */
export function* slabsOf(selection: Hyperslab, maxElements: number): Generator<Hyperslab> {
	const { start, count, stride } = selection;
	const rank = count.length;
	if (count.some((extent) => extent === 0)) return;
	if (rank === 0) {
		yield selection;
		return;
	}
	let split = rank - 1;
	let inner = 1;
	while (split > 0 && inner * (count[split] as number) <= maxElements) {
		inner *= count[split] as number;
		split -= 1;
	}
	const block = Math.max(1, Math.min(count[split] as number, Math.floor(maxElements / inner)));
	const outer = new Array<number>(split).fill(0);
	for (;;) {
		for (let offset = 0; offset < (count[split] as number); offset += block) {
			const slabStart = [...start];
			const slabCount = [...count];
			for (let dim = 0; dim < split; dim += 1) {
				slabStart[dim] = (start[dim] as number) + (outer[dim] as number) * (stride[dim] as number);
				slabCount[dim] = 1;
			}
			slabStart[split] = (start[split] as number) + offset * (stride[split] as number);
			slabCount[split] = Math.min(block, (count[split] as number) - offset);
			yield { start: slabStart, count: slabCount, stride };
		}
		let dim = split - 1;
		while (dim >= 0) {
			outer[dim] = (outer[dim] as number) + 1;
			if ((outer[dim] as number) < (count[dim] as number)) break;
			outer[dim] = 0;
			dim -= 1;
		}
		if (dim < 0) return;
	}
}

/** Nest a flat row-major block into arrays shaped by `count`. */
export function nest<T>(flat: ReadonlyArray<T>, count: ReadonlyArray<number>): unknown {
	if (count.length <= 1) return [...flat];
	const [head, ...rest] = count;
	const stride = product(rest);
	const out: unknown[] = [];
	for (let index = 0; index < (head as number); index += 1)
		out.push(nest(flat.slice(index * stride, (index + 1) * stride), rest));
	return out;
}

export type NumericBlock =
	| Float64Array
	| Float32Array
	| Int8Array
	| Uint8Array
	| Int16Array
	| Uint16Array
	| Int32Array
	| Uint32Array
	| BigInt64Array
	| BigUint64Array
	| ReadonlyArray<number | bigint | null>;

/** A value counted as fill or missing: compared exactly, NaN matching NaN. */
export type Sentinel = number | bigint;

function sentinelMatch(value: number | bigint, sentinel: Sentinel | null): boolean {
	if (sentinel === null) return false;
	if (typeof value === "number" && Number.isNaN(value)) return typeof sentinel === "number" && Number.isNaN(sentinel);
	// biome-ignore lint/suspicious/noDoubleEquals: number and bigint compare by value only with ==
	return value == sentinel;
}

/**
 * Streaming summary over numeric blocks: min, max, mean and population
 * standard deviation over valid values, with NaN, infinities, fill values,
 * missing values and nulls counted apart. Each block is reduced exactly
 * (two-pass mean and M2) and merged with Chan's pairwise update, so the
 * result does not drift with the number of blocks. Integers wider than 2^53
 * keep exact extrema; their mean and deviation are computed in doubles and the
 * result says so. Each extremum keeps the dataset index of its first
 * occurrence in traversal order, mapped through the block's hyperslab.
 */
export class StatsAccumulator {
	valid = 0;
	nan = 0;
	inf = 0;
	fill = 0;
	missing = 0;
	nulls = 0;
	private mean = 0;
	private m2 = 0;
	private min: number | bigint | null = null;
	private max: number | bigint | null = null;
	private argmin: number[] | null = null;
	private argmax: number[] | null = null;
	private wideIntegers = false;
	/**
	 * Integers are accumulated as exact offsets from the first one seen, so a
	 * column of int64 values near 2^63 keeps its spread instead of rounding
	 * every value to the double spacing at that magnitude.
	 */
	private pivot: bigint | null = null;

	constructor(
		private readonly fillValue: Sentinel | null,
		private readonly missingValues: ReadonlyArray<Sentinel>,
	) {}

	/** Valid values of the current block, reused across blocks so a pass allocates once. */
	private scratch = new Float64Array(0);

	/** `place` is the block's hyperslab in dataset coordinates; the block is its row-major flattening. */
	add(block: NumericBlock, place: Hyperslab): void {
		if (this.scratch.length < block.length) this.scratch = new Float64Array(block.length);
		const valid = this.scratch;
		let kept = 0;
		let blockSum = 0;
		// Extremes of this block alone, merged below: blocks need not arrive in
		// dataset row-major order (chunk tiles narrower than a row do not), so a
		// tie across blocks is settled by dataset position, not by arrival.
		let blockMin: number | bigint | null = null;
		let blockMax: number | bigint | null = null;
		let minAt = -1;
		let maxAt = -1;
		for (let index = 0; index < block.length; index += 1) {
			const value = block[index];
			if (value === null || value === undefined) {
				this.nulls += 1;
				continue;
			}
			if (sentinelMatch(value, this.fillValue)) {
				this.fill += 1;
				if (typeof value === "number" && Number.isNaN(value)) this.nan += 1;
				continue;
			}
			if (this.missingValues.some((sentinel) => sentinelMatch(value, sentinel))) {
				this.missing += 1;
				continue;
			}
			if (typeof value === "bigint") {
				if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) this.wideIntegers = true;
				if (blockMin === null || value < blockMin) {
					blockMin = value;
					minAt = index;
				}
				if (blockMax === null || value > blockMax) {
					blockMax = value;
					maxAt = index;
				}
				this.pivot ??= value;
				const offset = Number(value - this.pivot);
				valid[kept++] = offset;
				blockSum += offset;
				continue;
			}
			if (Number.isNaN(value)) {
				this.nan += 1;
				continue;
			}
			if (!Number.isFinite(value)) {
				this.inf += 1;
				continue;
			}
			if (blockMin === null || value < blockMin) {
				blockMin = value;
				minAt = index;
			}
			if (blockMax === null || value > blockMax) {
				blockMax = value;
				maxAt = index;
			}
			valid[kept++] = value;
			blockSum += value;
		}
		if (blockMin !== null) {
			const at = coordinatesOf(minAt, place);
			// biome-ignore lint/suspicious/noDoubleEquals: number and bigint compare by value only with ==
			if (this.min === null || blockMin < this.min || (blockMin == this.min && precedes(at, this.argmin))) {
				this.min = blockMin;
				this.argmin = at;
			}
		}
		if (blockMax !== null) {
			const at = coordinatesOf(maxAt, place);
			// biome-ignore lint/suspicious/noDoubleEquals: number and bigint compare by value only with ==
			if (this.max === null || blockMax > this.max || (blockMax == this.max && precedes(at, this.argmax))) {
				this.max = blockMax;
				this.argmax = at;
			}
		}
		if (kept === 0) return;
		const blockMean = blockSum / kept;
		let blockM2 = 0;
		for (let index = 0; index < kept; index += 1) {
			const deviation = (valid[index] as number) - blockMean;
			blockM2 += deviation * deviation;
		}
		const total = this.valid + kept;
		const delta = blockMean - this.mean;
		this.mean += (delta * kept) / total;
		this.m2 += blockM2 + (delta * delta * this.valid * kept) / total;
		this.valid = total;
	}

	/** The mean in value space: the pivot added back once, at the end. */
	private center(): number {
		return this.pivot === null ? this.mean : Number(this.pivot) + this.mean;
	}

	summary(float32: boolean): Record<string, unknown> {
		const out: Record<string, unknown> = {
			validCount: this.valid,
			nanCount: this.nan,
			infCount: this.inf,
			fillCount: this.fill,
			missingValueCount: this.missing,
			min: this.min === null ? null : encodeValue(this.min, float32),
			argmin: this.argmin,
			max: this.max === null ? null : encodeValue(this.max, float32),
			argmax: this.argmax,
			mean: this.valid > 0 ? this.center() : null,
			std: this.valid > 0 ? Math.sqrt(this.m2 / this.valid) : null,
		};
		if (this.nulls > 0) out.nullCount = this.nulls;
		if (this.wideIntegers) {
			out.precision =
				"integers beyond 2^53 are exact in min and max; the mean is rounded to the nearest double once, and std is computed from exact offsets";
		}
		return out;
	}

	/** The same summary through a CF linear unpacking, value * scale + offset. */
	unpacked(scale: number, offset: number): Record<string, number | null> | null {
		if (this.valid === 0 || this.min === null || this.max === null) return null;
		const low = Number(this.min) * scale + offset;
		const high = Number(this.max) * scale + offset;
		return {
			min: Math.min(low, high),
			max: Math.max(low, high),
			mean: this.center() * scale + offset,
			std: Math.sqrt(this.m2 / this.valid) * Math.abs(scale),
		};
	}
}

/** Whether dataset index `a` comes before `b` in row-major order. */
function precedes(a: number[], b: number[] | null): boolean {
	if (b === null) return true;
	for (let dim = 0; dim < a.length; dim += 1) {
		if ((a[dim] as number) !== (b[dim] as number)) return (a[dim] as number) < (b[dim] as number);
	}
	return false;
}

/** The dataset index of element `flat` of a row-major block read from `place`. */
function coordinatesOf(flat: number, place: Hyperslab): number[] {
	const out = new Array<number>(place.count.length);
	let rest = flat;
	for (let dim = place.count.length - 1; dim >= 0; dim -= 1) {
		const extent = place.count[dim] as number;
		out[dim] = (place.start[dim] as number) + (rest % extent) * (place.stride[dim] as number);
		rest = Math.floor(rest / extent);
	}
	return out;
}

/** A scalar number or bigint out of an encoded attribute, for use as a sentinel. */
export function sentinelOf(value: unknown): Sentinel | null {
	if (typeof value === "number" || typeof value === "bigint") return value;
	if (ArrayBuffer.isView(value) && (value as unknown as ArrayLike<unknown>).length >= 1) {
		const first = (value as unknown as ArrayLike<unknown>)[0];
		if (typeof first === "number" || typeof first === "bigint") return first;
	}
	if (Array.isArray(value) && value.length >= 1) return sentinelOf(value[0]);
	return null;
}

export function sentinelsOf(value: unknown): Sentinel[] {
	if (value === undefined || value === null) return [];
	if (ArrayBuffer.isView(value) || Array.isArray(value)) {
		const items = Array.from(value as unknown as ArrayLike<unknown>);
		return items.filter((item): item is Sentinel => typeof item === "number" || typeof item === "bigint");
	}
	const single = sentinelOf(value);
	return single === null ? [] : [single];
}

/** Render a selection's values under the byte cap; null when they do not fit. */
export function renderValues(
	flat: ReadonlyArray<unknown>,
	count: ReadonlyArray<number>,
	float32: boolean,
): { values: unknown; bytes: number } | null {
	const encoded = flat.map((value) => encodeValue(value, float32));
	const values = count.length === 0 ? encoded[0] : nest(encoded, count);
	const bytes = Buffer.byteLength(JSON.stringify(values));
	return bytes <= SELECT_VALUE_BYTES ? { values, bytes } : null;
}

/** JSON size of a candidate result, for the inspect degradation ladder. */
export function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

export function viewFor(complete: boolean, cut: boolean): DataViewFlags {
	if (!complete) return sampledView();
	return cut ? cutView() : exactView();
}
