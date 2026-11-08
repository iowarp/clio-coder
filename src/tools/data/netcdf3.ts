import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
	ATTRIBUTE_LIMIT,
	capCount,
	cfBlock,
	DEFAULT_SELECT_ELEMENTS,
	DEFAULT_STATS_BYTES,
	type EncodedValue,
	encodeAttribute,
	type Hyperslab,
	INSPECT_RESULT_BYTES,
	jsonBytes,
	MAX_SELECT_ELEMENTS,
	MAX_STATS_BYTES,
	product,
	refuse,
	renderValues,
	resolveHyperslab,
	type ScientificRequest,
	type ScientificResult,
	SELECT_VALUE_BYTES,
	SLAB_BYTES,
	STATS_DEADLINE_MS,
	StatsAccumulator,
	sentinelOf,
	sentinelsOf,
	slabsOf,
	viewFor,
} from "./scientific-shared.js";

/**
 * Classic NetCDF (CDF-1), 64-bit offset (CDF-2) and 64-bit data (CDF-5,
 * written by PnetCDF) read natively. The header grammar is small and fixed, so
 * it is parsed here from bounded positional reads rather than through a
 * fetched library, and every count read from the header is checked against
 * the bytes that remain before anything is allocated for it. Data never
 * passes through the header reader: a variable's values sit at fixed offsets
 * (contiguous for fixed-size variables, interleaved by record for those on the
 * unlimited dimension), and a hyperslab reads only the runs it names. The file
 * is opened read-only.
 */

const NC_DIMENSION = 0x0a;
const NC_VARIABLE = 0x0b;
const NC_ATTRIBUTE = 0x0c;
const STREAMING = 0xffffffff;
const HEADER_CAP = 64 * 1024 * 1024;
const NAME_CAP = 64 * 1024;
const READ_CHUNK = 64 * 1024;

interface NcType {
	name: string;
	size: number;
}

const NC_TYPES: Record<number, NcType> = {
	1: { name: "int8", size: 1 },
	2: { name: "char", size: 1 },
	3: { name: "int16", size: 2 },
	4: { name: "int32", size: 4 },
	5: { name: "float32", size: 4 },
	6: { name: "float64", size: 8 },
	7: { name: "uint8", size: 1 },
	8: { name: "uint16", size: 2 },
	9: { name: "uint32", size: 4 },
	10: { name: "int64", size: 8 },
	11: { name: "uint64", size: 8 },
};

interface Dimension {
	name: string;
	length: number;
	unlimited: boolean;
}

interface Variable {
	name: string;
	dimIds: number[];
	attributes: Array<[string, unknown]>;
	type: number;
	begin: number;
	record: boolean;
}

interface Header {
	version: 1 | 2 | 5;
	numrecs: number;
	streaming: boolean;
	dimensions: Dimension[];
	attributes: Array<[string, unknown]>;
	variables: Variable[];
	recordBytes: number;
}

const VARIANT: Record<1 | 2 | 5, string> = {
	1: "classic (CDF-1)",
	2: "64-bit offset (CDF-2)",
	5: "64-bit data (CDF-5)",
};

/** Positional reads over an open descriptor, buffered for the header walk. */
class Cursor {
	pos = 0;
	private buffer = Buffer.alloc(0);
	private bufferStart = 0;

	constructor(
		private readonly fd: number,
		readonly fileSize: number,
	) {}

	private ensure(bytes: number): void {
		if (this.pos + bytes > this.fileSize) truncated(this.pos, bytes);
		if (this.pos + bytes > HEADER_CAP) {
			refuse("read-error", `the NetCDF header runs past ${HEADER_CAP / 1024 / 1024} MiB; this reader stops there`);
		}
		if (this.pos >= this.bufferStart && this.pos + bytes <= this.bufferStart + this.buffer.length) return;
		const length = Math.min(this.fileSize - this.pos, Math.max(bytes, READ_CHUNK));
		const next = Buffer.alloc(length);
		readSync(this.fd, next, 0, length, this.pos);
		this.buffer = next;
		this.bufferStart = this.pos;
	}

	private view(bytes: number): Buffer {
		this.ensure(bytes);
		const at = this.pos - this.bufferStart;
		this.pos += bytes;
		return this.buffer.subarray(at, at + bytes);
	}

	u32(): number {
		return this.view(4).readUInt32BE(0);
	}

	u64(): number {
		const value = this.view(8).readBigUInt64BE(0);
		if (value > BigInt(Number.MAX_SAFE_INTEGER))
			refuse("read-error", `a header count at byte ${this.pos - 8} is ${value}, beyond what this reader addresses`);
		return Number(value);
	}

	bytes(count: number): Buffer {
		return Buffer.from(this.view(count));
	}

	pad(): void {
		const rest = this.pos % 4;
		if (rest !== 0) this.view(4 - rest);
	}

	/** A header count that must leave room for `count * minBytes` more header bytes. */
	bounded(count: number, minBytes: number, what: string): number {
		if (count * minBytes > this.fileSize - this.pos) {
			refuse(
				"read-error",
				`the header declares ${count} ${what} at byte ${this.pos}, more than the remaining ${this.fileSize - this.pos} bytes can hold; the file is truncated or not NetCDF`,
			);
		}
		return count;
	}
}

function truncated(at: number, bytes: number): never {
	refuse("read-error", `the NetCDF header is truncated: ${bytes} bytes needed at byte ${at}, past the end of the file`);
}

function parseHeader(cursor: Cursor): Header {
	const magic = cursor.bytes(4);
	if (magic.toString("latin1", 0, 3) !== "CDF")
		refuse("unsupported-format", "not a NetCDF classic file: it does not start with CDF");
	const version = magic[3] as number;
	if (version !== 1 && version !== 2 && version !== 5) {
		refuse("unsupported-format", `CDF version byte ${version} is not 1, 2 or 5`);
	}
	const wide = version === 5;
	const count = (): number => (wide ? cursor.u64() : cursor.u32());
	const numrecsRaw = wide ? cursor.u64() : cursor.u32();
	const streaming = !wide && numrecsRaw === STREAMING;
	const name = (): string => {
		const length = count();
		if (length > NAME_CAP)
			refuse("read-error", `a name at byte ${cursor.pos} claims ${length} bytes; the header is corrupt`);
		const text = cursor.bytes(cursor.bounded(length, 1, "name bytes")).toString("utf8");
		cursor.pad();
		return text;
	};
	const listTag = (expected: number, what: string): number => {
		const tag = cursor.u32();
		const elements = count();
		if (tag === 0) {
			if (elements !== 0)
				refuse("read-error", `an absent ${what} list carries ${elements} elements; the header is corrupt`);
			return 0;
		}
		if (tag !== expected)
			refuse("read-error", `expected the ${what} list tag at byte ${cursor.pos - (wide ? 12 : 8)}, found ${tag}`);
		return elements;
	};
	const attributes = (): Array<[string, unknown]> => {
		const total = cursor.bounded(listTag(NC_ATTRIBUTE, "attribute"), 12, "attributes");
		const out: Array<[string, unknown]> = [];
		for (let index = 0; index < total; index += 1) {
			const key = name();
			const typeCode = cursor.u32();
			const type = NC_TYPES[typeCode];
			if (type === undefined || (typeCode > 6 && !wide))
				refuse("read-error", `attribute ${key} has type ${typeCode}, not valid in CDF-${version}`);
			const items = count();
			const raw = cursor.bytes(cursor.bounded(items, type.size, `values for attribute ${key}`) * type.size);
			cursor.pad();
			out.push([key, decode(raw, typeCode, items, true)]);
		}
		return out;
	};
	const dimTotal = cursor.bounded(listTag(NC_DIMENSION, "dimension"), 8, "dimensions");
	const dimensions: Dimension[] = [];
	for (let index = 0; index < dimTotal; index += 1) {
		const key = name();
		const length = count();
		dimensions.push({ name: key, length, unlimited: length === 0 });
	}
	const recordDims = dimensions.filter((dim) => dim.unlimited);
	if (recordDims.length > 1) refuse("read-error", "the header declares more than one unlimited dimension");
	const globals = attributes();
	const varTotal = cursor.bounded(listTag(NC_VARIABLE, "variable"), 20, "variables");
	const variables: Variable[] = [];
	for (let index = 0; index < varTotal; index += 1) {
		const key = name();
		const rank = cursor.bounded(count(), wide ? 8 : 4, `dimensions of ${key}`);
		const dimIds: number[] = [];
		for (let dim = 0; dim < rank; dim += 1) {
			const id = count();
			if (id >= dimensions.length)
				refuse("read-error", `variable ${key} names dimension id ${id}; only ${dimensions.length} exist`);
			dimIds.push(id);
		}
		const attrs = attributes();
		const type = cursor.u32();
		if (NC_TYPES[type] === undefined || (type > 6 && !wide))
			refuse("read-error", `variable ${key} has type ${type}, not valid in CDF-${version}`);
		if (wide) cursor.u64();
		else cursor.u32();
		const begin = version === 1 ? cursor.u32() : cursor.u64();
		const record = dimIds.length > 0 && (dimensions[dimIds[0] as number] as Dimension).unlimited;
		if (dimIds.slice(1).some((id) => (dimensions[id] as Dimension).unlimited)) {
			refuse("read-error", `variable ${key} uses the unlimited dimension past its first position`);
		}
		variables.push({ name: key, dimIds, attributes: attrs, type, begin, record });
	}
	const records = variables.filter((variable) => variable.record);
	const recordSlice = (variable: Variable): number =>
		product(variable.dimIds.slice(1).map((id) => (dimensions[id] as Dimension).length)) *
		(NC_TYPES[variable.type] as NcType).size;
	// One record variable is stored unpadded; with several, each slice pads to four bytes.
	const recordBytes =
		records.length === 1
			? recordSlice(records[0] as Variable)
			: records.reduce((total, variable) => total + Math.ceil(recordSlice(variable) / 4) * 4, 0);
	let numrecs = numrecsRaw;
	if (streaming) {
		const first = Math.min(...records.map((variable) => variable.begin));
		numrecs = records.length > 0 && recordBytes > 0 ? Math.floor((cursor.fileSize - first) / recordBytes) : 0;
	}
	for (const dim of recordDims) dim.length = numrecs;
	return { version, numrecs, streaming, dimensions, attributes: globals, variables, recordBytes };
}

/** Big-endian values into a typed array (or text for char). */
function decode(raw: Buffer, type: number, items: number, asText: boolean): unknown {
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	switch (type) {
		case 1:
			return Int8Array.from({ length: items }, (_, index) => view.getInt8(index));
		case 2:
			return asText
				? raw.subarray(0, items).toString("utf8").replace(/\0+$/u, "")
				: Array.from(raw.subarray(0, items), (byte) => String.fromCharCode(byte));
		case 3:
			return Int16Array.from({ length: items }, (_, index) => view.getInt16(index * 2));
		case 4:
			return Int32Array.from({ length: items }, (_, index) => view.getInt32(index * 4));
		case 5:
			return Float32Array.from({ length: items }, (_, index) => view.getFloat32(index * 4));
		case 6:
			return Float64Array.from({ length: items }, (_, index) => view.getFloat64(index * 8));
		case 7:
			return Uint8Array.from({ length: items }, (_, index) => view.getUint8(index));
		case 8:
			return Uint16Array.from({ length: items }, (_, index) => view.getUint16(index * 2));
		case 9:
			return Uint32Array.from({ length: items }, (_, index) => view.getUint32(index * 4));
		case 10:
			return BigInt64Array.from({ length: items }, (_, index) => view.getBigInt64(index * 8));
		case 11:
			return BigUint64Array.from({ length: items }, (_, index) => view.getBigUint64(index * 8));
		default:
			return null;
	}
}

class Netcdf3File {
	readonly header: Header;
	private readonly fd: number;
	readonly fileSize: number;

	constructor(readonly path: string) {
		this.fd = openSync(path, "r");
		try {
			this.fileSize = fstatSync(this.fd).size;
			this.header = parseHeader(new Cursor(this.fd, this.fileSize));
		} catch (error) {
			closeSync(this.fd);
			throw error;
		}
	}

	close(): void {
		closeSync(this.fd);
	}

	shape(variable: Variable): number[] {
		return variable.dimIds.map((id) => (this.header.dimensions[id] as Dimension).length);
	}

	variable(name: string): Variable {
		const key = name.trim().replace(/^\//u, "");
		const found = this.header.variables.find((variable) => variable.name === key);
		if (found === undefined) {
			refuse(
				"unknown-variable",
				`no variable ${JSON.stringify(key)} in ${this.path}; variables are ${this.header.variables
					.slice(0, 50)
					.map((variable) => variable.name)
					.join(", ")}`,
			);
		}
		return found;
	}

	/**
	 * The values of one hyperslab in row-major order. Each run along the
	 * innermost dimensions the slab covers whole with stride 1 is one read; a
	 * record variable's records are never merged, since other variables'
	 * slices sit between them.
	 */
	read(variable: Variable, slab: Hyperslab): unknown {
		const type = NC_TYPES[variable.type] as NcType;
		const shape = this.shape(variable);
		const rank = shape.length;
		const total = product(slab.count);
		if (rank === 0) return decode(this.readBytes(variable.begin, type.size), variable.type, 1, false);
		// Fold trailing dimensions that are read whole into one contiguous run.
		let runDims = 1;
		while (
			runDims < rank &&
			(slab.stride[rank - runDims] as number) === 1 &&
			(slab.count[rank - runDims] as number) === shape[rank - runDims] &&
			(slab.start[rank - runDims] as number) === 0 &&
			!(variable.record && rank - runDims - 1 === 0)
		) {
			runDims += 1;
		}
		const runDim = rank - runDims;
		const innerElements = product(shape.slice(runDim + 1));
		const runStride = slab.stride[runDim] as number;
		const runCount = (slab.count[runDim] as number) * innerElements;
		const linearStrides = shape.map((_, dim) => product(shape.slice(dim + 1)));
		const out = Buffer.alloc(total * type.size);
		let written = 0;
		const outerDims = runDim;
		const index = new Array<number>(outerDims).fill(0);
		for (;;) {
			let element = 0;
			let recordOffset = 0;
			for (let dim = 0; dim < outerDims; dim += 1) {
				const at = (slab.start[dim] as number) + (index[dim] as number) * (slab.stride[dim] as number);
				if (variable.record && dim === 0) recordOffset = at * this.header.recordBytes;
				else element += at * (linearStrides[dim] as number);
			}
			const runStart = (slab.start[runDim] as number) * innerElements;
			if (variable.record && runDim === 0) {
				// The record dimension itself is the run: one read per record.
				for (let step = 0; step < (slab.count[0] as number); step += 1) {
					const recordIndex = (slab.start[0] as number) + step * runStride;
					const bytes = this.readBytes(variable.begin + recordIndex * this.header.recordBytes, innerElements * type.size);
					bytes.copy(out, written);
					written += bytes.length;
				}
			} else if (runStride === 1 || innerElements > 1) {
				const span = runStride === 1 ? runCount : innerElements;
				const steps = runStride === 1 ? 1 : (slab.count[runDim] as number);
				for (let step = 0; step < steps; step += 1) {
					const first = element + runStart + step * runStride * innerElements;
					const bytes = this.readBytes(variable.begin + recordOffset + first * type.size, span * type.size);
					bytes.copy(out, written);
					written += bytes.length;
				}
			} else {
				const count = slab.count[runDim] as number;
				const spanElements = (count - 1) * runStride + 1;
				const first = element + runStart;
				if (spanElements * type.size <= 1024 * 1024) {
					const bytes = this.readBytes(variable.begin + recordOffset + first * type.size, spanElements * type.size);
					for (let step = 0; step < count; step += 1) {
						bytes.copy(out, written, step * runStride * type.size, (step * runStride + 1) * type.size);
						written += type.size;
					}
				} else {
					for (let step = 0; step < count; step += 1) {
						this.readBytes(variable.begin + recordOffset + (first + step * runStride) * type.size, type.size).copy(
							out,
							written,
						);
						written += type.size;
					}
				}
			}
			let dim = outerDims - 1;
			while (dim >= 0) {
				index[dim] = (index[dim] as number) + 1;
				if ((index[dim] as number) < (slab.count[dim] as number)) break;
				index[dim] = 0;
				dim -= 1;
			}
			if (dim < 0) break;
		}
		return decode(out, variable.type, total, false);
	}

	private readBytes(position: number, length: number): Buffer {
		if (position + length > this.fileSize) {
			refuse(
				"read-error",
				`${length} bytes at byte ${position} lie past the end of the file (${this.fileSize} bytes); the file is truncated`,
			);
		}
		const buffer = Buffer.alloc(length);
		let done = 0;
		while (done < length) {
			const got = readSync(this.fd, buffer, done, length - done, position + done);
			if (got === 0) refuse("read-error", `unexpected end of file at byte ${position + done}`);
			done += got;
		}
		return buffer;
	}
}

function encodedAttributes(pairs: ReadonlyArray<[string, unknown]>): {
	values: Record<string, EncodedValue>;
	total: number;
} {
	const values: Record<string, EncodedValue> = {};
	for (const [key, value] of pairs.slice(0, ATTRIBUTE_LIMIT)) values[key] = encodeAttribute(value);
	return { values, total: pairs.length };
}

function attributeOf(variable: Variable, key: string): unknown {
	return variable.attributes.find(([name]) => name === key)?.[1];
}

function describe(file: Netcdf3File, variable: Variable, detail: "full" | "compact"): Record<string, unknown> {
	const type = NC_TYPES[variable.type] as NcType;
	const shape = file.shape(variable);
	const attributes = encodedAttributes(variable.attributes);
	const cf = cfBlock(attributes.values);
	const bytes = product(shape) * type.size;
	const entry: Record<string, unknown> = {
		path: `/${variable.name}`,
		dtype: type.name,
		shape,
		dims: variable.dimIds.map((id) => (file.header.dimensions[id] as Dimension).name),
		layout: variable.record ? "record (one slice per record, interleaved with other record variables)" : "contiguous",
		chunks: null,
		filters: [],
		compression: "none",
		uncompressedBytes: bytes,
		storageBytes: bytes,
		begin: variable.begin,
	};
	if (
		variable.dimIds.length === 1 &&
		(file.header.dimensions[variable.dimIds[0] as number] as Dimension).name === variable.name
	)
		entry.coordinate = true;
	if (cf !== undefined) entry.cf = cf;
	if (detail === "full") {
		if (attributes.total > 0) entry.attributes = attributes.values;
		if (attributes.total > ATTRIBUTE_LIMIT) entry.attributesOmitted = attributes.total - ATTRIBUTE_LIMIT;
	} else entry.attributeCount = attributes.total;
	return entry;
}

const FILL_NOTE =
	"fill and missing values come from the _FillValue and missing_value attributes only; netCDF's default fill for a variable without _FillValue is not counted";

function base(file: Netcdf3File): Pick<ScientificResult, "format"> & Record<string, unknown> {
	return { format: "netcdf", variant: VARIANT[file.header.version] };
}

export function inspectNetcdf3(request: ScientificRequest): ScientificResult {
	const file = new Netcdf3File(request.path);
	try {
		const { header } = file;
		if (request.variable !== undefined) {
			return {
				...base(file),
				view: viewFor(true, false),
				path: request.path,
				variable: describe(file, file.variable(request.variable), "full"),
				notes: [FILL_NOTE],
			};
		}
		const globals = encodedAttributes(header.attributes);
		const build = (count: number, detail: "full" | "compact"): ScientificResult => ({
			...base(file),
			view: viewFor(true, count < header.variables.length || detail === "compact"),
			path: request.path,
			fileBytes: file.fileSize,
			records: header.numrecs,
			...(header.streaming
				? { streaming: "numrecs was not finalized by the writer; the record count is derived from the file size" }
				: {}),
			dimensions: header.dimensions,
			attributes: globals.values,
			...(globals.total > ATTRIBUTE_LIMIT ? { attributesOmitted: globals.total - ATTRIBUTE_LIMIT } : {}),
			variables: header.variables.slice(0, count).map((variable) => describe(file, variable, detail)),
			listing: { variablesShown: count, variablesFound: header.variables.length, attributes: detail },
			notes: [
				...(detail === "compact"
					? ["attributes are reduced to CF fields and a count to fit the result; inspect one variable for all of them"]
					: []),
				...(count < header.variables.length
					? [`${header.variables.length - count} variables are not listed; inspect one by name in variable`]
					: []),
				FILL_NOTE,
			],
		});
		let count = Math.min(header.variables.length, 200);
		let result = build(count, "full");
		if (jsonBytes(result) > INSPECT_RESULT_BYTES) result = build(count, "compact");
		while (jsonBytes(result) > INSPECT_RESULT_BYTES && count > 1) {
			count = Math.max(1, Math.floor(count * 0.75));
			result = build(count, "compact");
		}
		return result;
	} finally {
		file.close();
	}
}

function header(file: Netcdf3File, variable: Variable): Record<string, unknown> {
	return {
		variable: `/${variable.name}`,
		dtype: (NC_TYPES[variable.type] as NcType).name,
		shape: file.shape(variable),
		dims: variable.dimIds.map((id) => (file.header.dimensions[id] as Dimension).name),
	};
}

export function selectNetcdf3(request: ScientificRequest): ScientificResult {
	if (request.variable === undefined)
		refuse("invalid-argument", "select on NetCDF needs variable: the variable name to read");
	const file = new Netcdf3File(request.path);
	try {
		const variable = file.variable(request.variable);
		const shape = file.shape(variable);
		const { slab, explicitCount } = resolveHyperslab(shape, request);
		const requested = product(slab.count);
		if (explicitCount && requested > MAX_SELECT_ELEMENTS) {
			refuse(
				"selection-too-large",
				`the selection names ${requested} elements; op=select returns at most ${MAX_SELECT_ELEMENTS}. Narrow count, or use op=stats for a summary of the whole selection`,
			);
		}
		let budget = Math.min(requested, DEFAULT_SELECT_ELEMENTS);
		for (;;) {
			const count = explicitCount ? slab.count : capCount(slab.count, budget);
			const raw = file.read(variable, { ...slab, count });
			let flat = Array.isArray(raw) ? raw : Array.from(raw as ArrayLike<unknown>);
			let shapeOut = shape.length === 0 ? [] : count;
			// A char variable's last dimension is a string length: rejoin it, trailing NULs dropped, the way ncdump prints it.
			const joined = variable.type === 2 && count.length > 0;
			if (joined) {
				const width = count[count.length - 1] as number;
				const strings: string[] = [];
				for (let at = 0; at < flat.length; at += width)
					strings.push((flat.slice(at, at + width) as string[]).join("").replace(/\0+$/u, ""));
				flat = strings;
				shapeOut = count.length === 1 ? [1] : count.slice(0, -1);
			}
			const rendered = renderValues(flat, shapeOut, variable.type === 5);
			const returned = product(count);
			if (rendered === null) {
				if (explicitCount || returned <= 1) {
					refuse(
						"selection-too-large",
						`the ${returned} selected elements render past ${SELECT_VALUE_BYTES / 1024} KiB; narrow count`,
					);
				}
				budget = Math.max(1, Math.floor(returned / 2));
				continue;
			}
			const truncated = returned < requested;
			return {
				...base(file),
				view: viewFor(true, truncated),
				path: request.path,
				...header(file, variable),
				start: slab.start,
				count,
				stride: slab.stride,
				returned,
				total: requested,
				hasMore: truncated,
				...(truncated
					? {
							truncated: {
								reason: budget < Math.min(requested, DEFAULT_SELECT_ELEMENTS) ? "byte-cap" : "element-cap",
								requestedCount: slab.count,
								note: `count was omitted, so the first ${returned} of ${requested} elements in row-major order are returned; pass an explicit count (up to ${MAX_SELECT_ELEMENTS} elements) for a different window`,
							},
						}
					: {}),
				values: rendered.values,
				notes: [
					...(joined ? ["char values are joined along the last dimension into strings, trailing NULs dropped"] : []),
					"values are raw as stored: scale_factor and add_offset are not applied and fill values are not masked",
				],
			};
		}
	} finally {
		file.close();
	}
}

export function statsNetcdf3(request: ScientificRequest): ScientificResult {
	if (request.variable === undefined)
		refuse("invalid-argument", "stats on NetCDF needs variable: the variable name to summarize");
	const file = new Netcdf3File(request.path);
	try {
		const variable = file.variable(request.variable);
		if (variable.type === 2)
			refuse("invalid-argument", `${variable.name} is char; op=stats summarizes integer and float variables`);
		const type = NC_TYPES[variable.type] as NcType;
		const { slab } = resolveHyperslab(file.shape(variable), request);
		const fillRaw = attributeOf(variable, "_FillValue");
		const missingRaw = attributeOf(variable, "missing_value");
		const fill = sentinelOf(fillRaw);
		const accumulator = new StatsAccumulator(fill, sentinelsOf(missingRaw));
		const maxBytes = Math.min(MAX_STATS_BYTES, Math.max(type.size, request.maxBytes ?? DEFAULT_STATS_BYTES));
		const slabElements = Math.max(1, Math.floor(Math.min(SLAB_BYTES, maxBytes) / type.size));
		const deadline = performance.now() + STATS_DEADLINE_MS;
		const selected = product(slab.count);
		let scanned = 0;
		let stoppedBy: "byte-cap" | "deadline" | null = null;
		for (const part of slabsOf(slab, slabElements)) {
			const elements = product(part.count);
			if ((scanned + elements) * type.size > maxBytes) {
				stoppedBy = "byte-cap";
				break;
			}
			if (performance.now() > deadline) {
				stoppedBy = "deadline";
				break;
			}
			accumulator.add(file.read(variable, part) as Float64Array, part);
			scanned += elements;
		}
		const scale = sentinelOf(attributeOf(variable, "scale_factor"));
		const offset = sentinelOf(attributeOf(variable, "add_offset"));
		const unpacked =
			scale !== null || offset !== null ? accumulator.unpacked(Number(scale ?? 1), Number(offset ?? 0)) : null;
		const complete = stoppedBy === null;
		return {
			...base(file),
			view: viewFor(complete, false),
			path: request.path,
			...header(file, variable),
			start: slab.start,
			count: slab.count,
			stride: slab.stride,
			elementsSelected: selected,
			elementsScanned: scanned,
			bytesRead: scanned * type.size,
			maxBytes,
			complete,
			...(stoppedBy !== null
				? {
						stoppedBy,
						note:
							stoppedBy === "byte-cap"
								? `the pass stopped at the ${maxBytes}-byte cap after ${scanned} of ${selected} elements in row-major order; every figure covers only those elements. Raise max_bytes (up to ${MAX_STATS_BYTES}) or narrow the selection`
								: `the pass stopped after ${STATS_DEADLINE_MS / 1000} s at ${scanned} of ${selected} elements; every figure covers only those elements. Narrow the selection`,
					}
				: {}),
			fillValue: fill === null ? null : encodeAttribute(fillRaw),
			missingValue: missingRaw === undefined ? null : encodeAttribute(missingRaw),
			...accumulator.summary(variable.type === 5),
			...(unpacked !== null
				? { unpacked: { scaleFactor: Number(scale ?? 1), addOffset: Number(offset ?? 0), ...unpacked } }
				: {}),
			stdDefinition: "population (ddof=0) over valid values",
			notes: [FILL_NOTE],
		};
	} finally {
		file.close();
	}
}
