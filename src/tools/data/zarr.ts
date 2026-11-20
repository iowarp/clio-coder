import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import {
	ATTRIBUTE_LIMIT,
	capCount,
	cfBlock,
	chunkTiles,
	DEFAULT_SELECT_ELEMENTS,
	DEFAULT_STATS_BYTES,
	type EncodedValue,
	encodeAttribute,
	encodeValue,
	type Hyperslab,
	INSPECT_MAX_OBJECTS,
	INSPECT_MAX_VARIABLES,
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
 * Native Zarr v2 and v3 reader for the data tool. A store is a directory of
 * JSON metadata documents and one file per chunk, so everything here is plain
 * file reads: the metadata is parsed directly and chunks are decoded with
 * Node's own zlib (zlib, gzip and zstd) or read raw. A codec Node cannot run
 * (blosc, lz4, sharding, filters) is named and refused with the run_script
 * route instead of being guessed at. Read-only; nothing writes the store.
 */

const METADATA_CAP = 16 * 1024 * 1024;
const ROUTE =
	"use run_script with the zarr Python package (for example zarr.open(store)[path][...]) to read it with the full codec registry";

type Scalar = number | bigint | boolean | null;

interface Dtype {
	/** Normalized numpy-style name: float32, int64, bool, ... */
	name: string;
	/** Declared name in the metadata, for the report. */
	declared: string;
	size: number;
	kind: "float" | "int" | "uint" | "bool" | "other";
	little: boolean;
}

interface ZarrArray {
	path: string;
	dir: string;
	version: 2 | 3;
	shape: number[];
	chunks: number[];
	dtype: Dtype;
	order: "C" | "F";
	fillValue: Scalar;
	fillDeclared: unknown;
	/** Codec names in pipeline order, as reported. */
	codecs: string[];
	/** Why chunks cannot be decoded here; null when they can. */
	blocked: string | null;
	/** Byte stage decoders applied to a stored chunk, in decode order. */
	decoders: Array<(bytes: Buffer) => Buffer>;
	keyOf: (coords: ReadonlyArray<number>) => string;
	attributes: Record<string, unknown>;
	dims: string[] | null;
}

interface ZarrGroup {
	path: string;
	attributes: Record<string, unknown>;
}

interface ZarrTree {
	version: 2 | 3;
	groups: ZarrGroup[];
	arrays: ZarrArray[];
	/** Nodes not visited because the walk hit INSPECT_MAX_OBJECTS. */
	truncated: boolean;
}

function readJson(file: string): Record<string, unknown> {
	let size: number;
	try {
		size = statSync(file).size;
	} catch {
		refuse("read-error", `cannot stat ${file}`);
	}
	if (size > METADATA_CAP) refuse("read-error", `${file} is ${size} bytes; metadata documents are read up to 16 MiB`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		refuse("unsupported-format", `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		refuse("unsupported-format", `${file} is not a JSON object`);
	return parsed as Record<string, unknown>;
}

function optionalJson(file: string): Record<string, unknown> {
	return existsSync(file) ? readJson(file) : {};
}

/** Which Zarr version a directory holds, or null when it is not a Zarr node. */
function zarrNodeVersion(dir: string): 2 | 3 | null {
	if (existsSync(join(dir, "zarr.json"))) return 3;
	if (existsSync(join(dir, ".zgroup")) || existsSync(join(dir, ".zarray"))) return 2;
	return null;
}

function integers(value: unknown, what: string): number[] {
	if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item) && (item as number) >= 0))
		refuse("unsupported-format", `${what} is not a list of non-negative integers`);
	return value as number[];
}

const V3_TYPES: Record<string, Pick<Dtype, "size" | "kind">> = {
	bool: { size: 1, kind: "bool" },
	int8: { size: 1, kind: "int" },
	int16: { size: 2, kind: "int" },
	int32: { size: 4, kind: "int" },
	int64: { size: 8, kind: "int" },
	uint8: { size: 1, kind: "uint" },
	uint16: { size: 2, kind: "uint" },
	uint32: { size: 4, kind: "uint" },
	uint64: { size: 8, kind: "uint" },
	float32: { size: 4, kind: "float" },
	float64: { size: 8, kind: "float" },
};

function v2Dtype(declared: unknown): Dtype {
	if (typeof declared !== "string") {
		return { name: "structured", declared: JSON.stringify(declared), size: 0, kind: "other", little: true };
	}
	const match = /^([<>|=])([biufcmMSUVO])(\d+)/u.exec(declared);
	if (match === null) return { name: declared, declared, size: 0, kind: "other", little: true };
	const [, order, code, digits] = match as unknown as [string, string, string, string];
	const size = Number(digits);
	const little = order !== ">";
	const names: Record<string, string> = { b: "bool", i: "int", u: "uint", f: "float" };
	const base = names[code];
	if (base === undefined || (code === "f" && size === 2))
		return { name: declared, declared, size, kind: "other", little };
	const name = base === "bool" ? "bool" : `${base}${size * 8}`;
	const known = V3_TYPES[name];
	if (known === undefined) return { name: declared, declared, size, kind: "other", little };
	return { name, declared, size, kind: known.kind, little };
}

function v3Dtype(declared: unknown, little: boolean): Dtype {
	const name =
		typeof declared === "string"
			? declared
			: declared !== null && typeof declared === "object" && typeof (declared as { name?: unknown }).name === "string"
				? (declared as { name: string }).name
				: JSON.stringify(declared);
	const known = V3_TYPES[name];
	if (known === undefined) return { name, declared: name, size: 0, kind: "other", little };
	return { name, declared: name, ...known, little };
}

function hexFill(text: string, dtype: Dtype): Scalar {
	const bytes = Buffer.from(text.slice(2).padStart(dtype.size * 2, "0"), "hex");
	if (bytes.length !== dtype.size) return null;
	return elementAt(bytes, 0, { ...dtype, little: false });
}

function fillOf(value: unknown, dtype: Dtype): Scalar {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return dtype.kind === "bool" ? value : Number(value);
	if (typeof value === "number") {
		if (dtype.kind === "bool") return value !== 0;
		if (dtype.size === 8 && (dtype.kind === "int" || dtype.kind === "uint") && Number.isInteger(value))
			return BigInt(value);
		return value;
	}
	if (typeof value === "string") {
		if (value === "NaN") return Number.NaN;
		if (value === "Infinity") return Number.POSITIVE_INFINITY;
		if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
		if (/^0x[0-9a-f]+$/iu.test(value) && dtype.kind !== "other") return hexFill(value, dtype);
	}
	return null;
}

function zstdDecoder(): ((bytes: Buffer) => Buffer) | null {
	const decompress = (zlib as unknown as { zstdDecompressSync?: (bytes: Buffer) => Buffer }).zstdDecompressSync;
	return typeof decompress === "function" ? (bytes) => decompress(bytes) : null;
}

/** The decode step for one compressor name, or a reason it cannot run here. */
function compressorStep(id: string): ((bytes: Buffer) => Buffer) | string {
	if (id === "zlib") return (bytes) => zlib.inflateSync(bytes);
	if (id === "gzip") return (bytes) => zlib.gunzipSync(bytes);
	if (id === "zstd") return zstdDecoder() ?? "zstd needs Node 22.15 or later";
	return `the ${id} codec is not built into Node`;
}

function v2Array(
	dir: string,
	path: string,
	meta: Record<string, unknown>,
	attributes: Record<string, unknown>,
): ZarrArray {
	const shape = integers(meta.shape, `${path}/.zarray shape`);
	const chunks = integers(meta.chunks, `${path}/.zarray chunks`);
	const dtype = v2Dtype(meta.dtype);
	const codecs: string[] = [];
	const decoders: Array<(bytes: Buffer) => Buffer> = [];
	let blocked: string | null = dtype.kind === "other" ? `dtype ${dtype.declared} is not decoded here` : null;
	const filters = Array.isArray(meta.filters) ? meta.filters : [];
	for (const filter of filters) {
		const id = String((filter as { id?: unknown })?.id ?? "unknown");
		codecs.push(`filter:${id}`);
		blocked ??= `the ${id} filter is not decoded here`;
	}
	const compressor = meta.compressor as { id?: unknown } | null | undefined;
	if (compressor !== null && compressor !== undefined) {
		const id = String(compressor.id ?? "unknown");
		codecs.push(id);
		const step = compressorStep(id);
		if (typeof step === "string") blocked ??= step;
		else decoders.unshift(step);
	}
	const separator = meta.dimension_separator === "/" ? "/" : ".";
	const dims = attributes._ARRAY_DIMENSIONS;
	const { _ARRAY_DIMENSIONS: _, ...rest } = attributes;
	return {
		path,
		dir,
		version: 2,
		shape,
		chunks,
		dtype,
		order: meta.order === "F" ? "F" : "C",
		fillValue: fillOf(meta.fill_value, dtype),
		fillDeclared: meta.fill_value ?? null,
		codecs,
		blocked,
		decoders,
		keyOf: (coords) => (coords.length === 0 ? "0" : coords.join(separator)),
		attributes: Array.isArray(dims) ? rest : attributes,
		dims: Array.isArray(dims) && dims.every((item) => typeof item === "string") ? (dims as string[]) : null,
	};
}

function v3Array(dir: string, path: string, meta: Record<string, unknown>): ZarrArray {
	const shape = integers(meta.shape, `${path}/zarr.json shape`);
	const grid = meta.chunk_grid as { name?: unknown; configuration?: { chunk_shape?: unknown } } | undefined;
	if (grid?.name !== "regular") refuse("unsupported-format", `${path} uses chunk grid ${String(grid?.name)}; ${ROUTE}`);
	const chunks = integers(grid.configuration?.chunk_shape, `${path}/zarr.json chunk_shape`);
	const codecs: string[] = [];
	const decoders: Array<(bytes: Buffer) => Buffer> = [];
	let blocked: string | null = null;
	let little = true;
	let sawBytes = false;
	for (const codec of Array.isArray(meta.codecs) ? meta.codecs : []) {
		const name = String((codec as { name?: unknown })?.name ?? "unknown");
		const config = ((codec as { configuration?: unknown })?.configuration ?? {}) as Record<string, unknown>;
		codecs.push(name);
		if (name === "bytes") {
			sawBytes = true;
			little = config.endian !== "big";
			continue;
		}
		if (name === "transpose") {
			const order = Array.isArray(config.order) ? config.order : [];
			if (order.some((axis, index) => axis !== index)) blocked ??= "the transpose codec with a non-identity order";
			continue;
		}
		if (name === "crc32c") {
			decoders.unshift((bytes) => bytes.subarray(0, Math.max(0, bytes.length - 4)));
			continue;
		}
		const step = name === "sharding_indexed" ? "sharded chunks are not decoded here" : compressorStep(name);
		if (typeof step === "string") blocked ??= step;
		else decoders.unshift(step);
	}
	if (!sawBytes) blocked ??= "the array-to-bytes codec is not bytes";
	const dtype = v3Dtype(meta.data_type, little);
	if (dtype.kind === "other") blocked ??= `data type ${dtype.declared} is not decoded here`;
	const encoding = meta.chunk_key_encoding as { name?: unknown; configuration?: { separator?: unknown } } | undefined;
	const v2Keys = encoding?.name === "v2";
	const separator =
		typeof encoding?.configuration?.separator === "string" ? encoding.configuration.separator : v2Keys ? "." : "/";
	const names = meta.dimension_names;
	return {
		path,
		dir,
		version: 3,
		shape,
		chunks,
		dtype,
		order: "C",
		fillValue: fillOf(meta.fill_value, dtype),
		fillDeclared: meta.fill_value ?? null,
		codecs,
		blocked,
		decoders,
		keyOf: (coords) =>
			v2Keys
				? coords.length === 0
					? "0"
					: coords.join(separator)
				: ["c", ...coords.map(String)].join(coords.length === 0 ? "" : separator),
		attributes: (meta.attributes ?? {}) as Record<string, unknown>,
		dims:
			Array.isArray(names) && names.every((item) => typeof item === "string" || item === null)
				? (names as Array<string | null>).map((item, index) => item ?? `dim_${index}`)
				: null,
	};
}

function childPath(parent: string, name: string): string {
	return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function subdirectories(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function loadTree(root: string): ZarrTree {
	const version = zarrNodeVersion(root);
	if (version === null)
		refuse("unsupported-format", `${root} is not a Zarr store: it has no zarr.json, .zgroup or .zarray`);
	const tree: ZarrTree = { version, groups: [], arrays: [], truncated: false };
	const queue: Array<[string, string]> = [[root, "/"]];
	while (queue.length > 0) {
		const [dir, path] = queue.shift() as [string, string];
		if (tree.groups.length + tree.arrays.length >= INSPECT_MAX_OBJECTS) {
			tree.truncated = true;
			break;
		}
		if (version === 3) {
			const file = join(dir, "zarr.json");
			if (!existsSync(file)) continue;
			const meta = readJson(file);
			if (meta.zarr_format !== 3) refuse("unsupported-format", `${file} declares zarr_format ${String(meta.zarr_format)}`);
			if (meta.node_type === "array") {
				tree.arrays.push(v3Array(dir, path, meta));
				continue;
			}
			tree.groups.push({ path, attributes: (meta.attributes ?? {}) as Record<string, unknown> });
		} else {
			const attributes = optionalJson(join(dir, ".zattrs"));
			if (existsSync(join(dir, ".zarray"))) {
				tree.arrays.push(v2Array(dir, path, readJson(join(dir, ".zarray")), attributes));
				continue;
			}
			if (!existsSync(join(dir, ".zgroup"))) continue;
			tree.groups.push({ path, attributes });
		}
		for (const name of subdirectories(dir)) queue.push([join(dir, name), childPath(path, name)]);
	}
	return tree;
}

function findArray(root: string, variable: string): ZarrArray {
	const tree = loadTree(root);
	const wanted = variable.startsWith("/") ? variable : `/${variable}`;
	const found = tree.arrays.find((array) => array.path === wanted);
	if (found !== undefined) return found;
	const group = tree.groups.find((entry) => entry.path === wanted);
	if (group !== undefined)
		refuse("invalid-argument", `${wanted} is a group; op=select and op=stats read an array inside it`);
	const names = tree.arrays.slice(0, 20).map((array) => array.path);
	refuse("unknown-variable", `no array ${wanted} in the store; arrays include ${names.join(", ") || "none"}`);
}

function elementAt(bytes: Buffer, offset: number, dtype: Dtype): Scalar {
	const { size, kind, little } = dtype;
	if (kind === "bool") return bytes[offset] !== 0;
	if (kind === "float")
		return size === 4
			? little
				? bytes.readFloatLE(offset)
				: bytes.readFloatBE(offset)
			: little
				? bytes.readDoubleLE(offset)
				: bytes.readDoubleBE(offset);
	if (kind === "int") {
		if (size === 1) return bytes.readInt8(offset);
		if (size === 2) return little ? bytes.readInt16LE(offset) : bytes.readInt16BE(offset);
		if (size === 4) return little ? bytes.readInt32LE(offset) : bytes.readInt32BE(offset);
		return little ? bytes.readBigInt64LE(offset) : bytes.readBigInt64BE(offset);
	}
	if (kind === "uint") {
		if (size === 1) return bytes.readUInt8(offset);
		if (size === 2) return little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
		if (size === 4) return little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
		return little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
	}
	return null;
}

/** One decoded chunk, or null when the chunk file is absent and every element is the fill value. */
function decodeChunk(array: ZarrArray, coords: ReadonlyArray<number>): Buffer | null {
	const file = join(array.dir, ...array.keyOf(coords).split("/"));
	if (!existsSync(file)) return null;
	let bytes: Buffer = readFileSync(file);
	for (const decode of array.decoders) {
		try {
			bytes = decode(bytes);
		} catch (error) {
			refuse(
				"read-error",
				`chunk ${array.keyOf(coords)} of ${array.path} did not decode with ${array.codecs.join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const expected = product(array.chunks) * array.dtype.size;
	if (bytes.length !== expected)
		refuse(
			"read-error",
			`chunk ${array.keyOf(coords)} of ${array.path} decoded to ${bytes.length} bytes; a ${array.chunks.join("x")} ${array.dtype.name} chunk holds ${expected}`,
		);
	return bytes;
}

function assertReadable(array: ZarrArray, op: string): void {
	if (array.blocked !== null)
		refuse(
			"unsupported-format",
			`${array.path} cannot be read by op=${op} here: ${array.blocked} (codecs: ${array.codecs.join(", ") || "none"}); ${ROUTE}`,
		);
}

/** Read one hyperslab in row-major order, decoding each chunk it touches once. */
function readSlab(array: ZarrArray, slab: Hyperslab): Scalar[] {
	const rank = array.shape.length;
	if (rank === 0) {
		const bytes = decodeChunk(array, []);
		return [bytes === null ? array.fillValue : elementAt(bytes, 0, array.dtype)];
	}
	const total = product(slab.count);
	const out = new Array<Scalar>(total);
	const outStrides = new Array<number>(rank).fill(1);
	for (let dim = rank - 2; dim >= 0; dim -= 1)
		outStrides[dim] = (outStrides[dim + 1] as number) * (slab.count[dim + 1] as number);
	const chunkStrides = new Array<number>(rank).fill(1);
	if (array.order === "C") {
		for (let dim = rank - 2; dim >= 0; dim -= 1)
			chunkStrides[dim] = (chunkStrides[dim + 1] as number) * (array.chunks[dim + 1] as number);
	} else {
		for (let dim = 1; dim < rank; dim += 1)
			chunkStrides[dim] = (chunkStrides[dim - 1] as number) * (array.chunks[dim - 1] as number);
	}
	// Per dimension: the chunks touched, each with its (output index, index inside the chunk) pairs.
	const perDim = slab.count.map((count, dim) => {
		const groups = new Map<number, Array<[number, number]>>();
		const edge = array.chunks[dim] as number;
		for (let k = 0; k < count; k += 1) {
			const at = (slab.start[dim] as number) + k * (slab.stride[dim] as number);
			const chunk = Math.floor(at / edge);
			const list = groups.get(chunk) ?? [];
			list.push([k * (outStrides[dim] as number), (at - chunk * edge) * (chunkStrides[dim] as number)]);
			groups.set(chunk, list);
		}
		return [...groups.entries()];
	});
	if (perDim.some((list) => list.length === 0)) return out;
	const which = new Array<number>(rank).fill(0);
	for (;;) {
		const coords = which.map((at, dim) => (perDim[dim]?.[at] as [number, Array<[number, number]>])[0]);
		const lists = which.map((at, dim) => (perDim[dim]?.[at] as [number, Array<[number, number]>])[1]);
		const bytes = decodeChunk(array, coords);
		const inner = new Array<number>(rank).fill(0);
		for (;;) {
			let outAt = 0;
			let chunkAt = 0;
			for (let dim = 0; dim < rank; dim += 1) {
				const pair = (lists[dim] as Array<[number, number]>)[inner[dim] as number] as [number, number];
				outAt += pair[0];
				chunkAt += pair[1];
			}
			out[outAt] = bytes === null ? array.fillValue : elementAt(bytes, chunkAt * array.dtype.size, array.dtype);
			let dim = rank - 1;
			while (dim >= 0) {
				inner[dim] = (inner[dim] as number) + 1;
				if ((inner[dim] as number) < (lists[dim] as unknown[]).length) break;
				inner[dim] = 0;
				dim -= 1;
			}
			if (dim < 0) break;
		}
		let dim = rank - 1;
		while (dim >= 0) {
			which[dim] = (which[dim] as number) + 1;
			if ((which[dim] as number) < (perDim[dim] as unknown[]).length) break;
			which[dim] = 0;
			dim -= 1;
		}
		if (dim < 0) return out;
	}
}

function encodedAttributes(attributes: Record<string, unknown>): {
	values: Record<string, EncodedValue>;
	total: number;
} {
	const entries = Object.entries(attributes);
	const values: Record<string, EncodedValue> = {};
	for (const [key, value] of entries.slice(0, ATTRIBUTE_LIMIT)) values[key] = encodeAttribute(value);
	return { values, total: entries.length };
}

function describe(array: ZarrArray, detail: "full" | "compact"): Record<string, unknown> {
	const attributes = encodedAttributes(array.attributes);
	const cf = cfBlock(attributes.values);
	const entry: Record<string, unknown> = {
		path: array.path,
		dtype: array.dtype.name,
		...(array.dtype.declared !== array.dtype.name ? { declaredDtype: array.dtype.declared } : {}),
		shape: array.shape,
		dims: array.dims,
		chunks: array.chunks,
		...(array.version === 2 ? { order: array.order } : {}),
		codecs: array.codecs,
		compression: array.codecs.filter((name) => !["bytes", "transpose", "crc32c"].includes(name)).join("+") || "none",
		fillValue: encodeValue(array.fillValue),
		uncompressedBytes: product(array.shape) * array.dtype.size,
		readable: array.blocked === null,
		...(array.blocked !== null ? { unreadable: `${array.blocked}; ${ROUTE}` } : {}),
	};
	if (cf !== undefined) entry.cf = cf;
	if (detail === "full") {
		if (attributes.total > 0) entry.attributes = attributes.values;
		if (attributes.total > ATTRIBUTE_LIMIT) entry.attributesOmitted = attributes.total - ATTRIBUTE_LIMIT;
	} else entry.attributeCount = attributes.total;
	return entry;
}

const FILL_NOTE =
	"stats counts as fill only the _FillValue attribute and as missing only missing_value; the store's fill_value fills unwritten chunks and is reported apart";

function base(version: 2 | 3): Pick<ScientificResult, "format"> & Record<string, unknown> {
	return { format: "zarr", variant: `Zarr v${version}` };
}

export function inspectZarr(request: ScientificRequest): ScientificResult {
	const tree = loadTree(request.path);
	if (request.variable !== undefined) {
		const array = findArray(request.path, request.variable);
		return {
			...base(tree.version),
			view: viewFor(true, false),
			path: request.path,
			variable: describe(array, "full"),
			notes: [FILL_NOTE],
		};
	}
	const root = tree.groups.find((group) => group.path === "/");
	const globals = encodedAttributes(root?.attributes ?? {});
	const build = (count: number, detail: "full" | "compact"): ScientificResult => ({
		...base(tree.version),
		view: viewFor(!tree.truncated, count < tree.arrays.length || detail === "compact"),
		path: request.path,
		groups: tree.groups.map((group) => group.path),
		attributes: globals.values,
		...(globals.total > ATTRIBUTE_LIMIT ? { attributesOmitted: globals.total - ATTRIBUTE_LIMIT } : {}),
		variables: tree.arrays.slice(0, count).map((array) => describe(array, detail)),
		listing: { variablesShown: count, variablesFound: tree.arrays.length, attributes: detail },
		notes: [
			...(tree.truncated ? [`the walk stopped at ${INSPECT_MAX_OBJECTS} nodes; inspect a subgroup path directly`] : []),
			...(detail === "compact"
				? ["attributes are reduced to CF fields and a count to fit the result; inspect one variable for all of them"]
				: []),
			...(count < tree.arrays.length
				? [`${tree.arrays.length - count} arrays are not listed; inspect one by path in variable`]
				: []),
			"chunk files are not counted; storage size is not reported",
			FILL_NOTE,
		],
	});
	let count = Math.min(tree.arrays.length, INSPECT_MAX_VARIABLES);
	let result = build(count, "full");
	if (jsonBytes(result) > INSPECT_RESULT_BYTES) result = build(count, "compact");
	while (jsonBytes(result) > INSPECT_RESULT_BYTES && count > 1) {
		count = Math.max(1, Math.floor(count * 0.75));
		result = build(count, "compact");
	}
	return result;
}

function header(array: ZarrArray): Record<string, unknown> {
	return { variable: array.path, dtype: array.dtype.name, shape: array.shape, dims: array.dims };
}

export function selectZarr(request: ScientificRequest): ScientificResult {
	if (request.variable === undefined)
		refuse("invalid-argument", "select on Zarr needs variable: the array path to read");
	const array = findArray(request.path, request.variable);
	assertReadable(array, "select");
	const { slab, explicitCount } = resolveHyperslab(array.shape, request);
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
		const flat = readSlab(array, { ...slab, count });
		const rendered = renderValues(flat, array.shape.length === 0 ? [] : count, array.dtype.name === "float32");
		const returned = product(count);
		if (rendered === null) {
			if (explicitCount || returned <= 1)
				refuse(
					"selection-too-large",
					`the ${returned} selected elements render past ${SELECT_VALUE_BYTES / 1024} KiB; narrow count`,
				);
			budget = Math.max(1, Math.floor(returned / 2));
			continue;
		}
		const truncated = returned < requested;
		return {
			...base(array.version),
			view: viewFor(true, truncated),
			path: request.path,
			...header(array),
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
				"values are raw as stored: scale_factor and add_offset are not applied and fill values are not masked; elements of unwritten chunks read as the store's fill_value",
			],
		};
	}
}

export function statsZarr(request: ScientificRequest): ScientificResult {
	if (request.variable === undefined)
		refuse("invalid-argument", "stats on Zarr needs variable: the array path to summarize");
	const array = findArray(request.path, request.variable);
	assertReadable(array, "stats");
	if (array.dtype.kind === "bool")
		refuse("invalid-argument", `${array.path} is bool; op=stats summarizes integer and float arrays`);
	const size = array.dtype.size;
	const { slab } = resolveHyperslab(array.shape, request);
	const fillRaw = array.attributes._FillValue;
	const missingRaw = array.attributes.missing_value;
	const fill = sentinelOf(fillRaw);
	const accumulator = new StatsAccumulator(fill, sentinelsOf(missingRaw));
	const maxBytes = Math.min(MAX_STATS_BYTES, Math.max(size, request.maxBytes ?? DEFAULT_STATS_BYTES));
	const slabElements = Math.max(1, Math.floor(Math.min(SLAB_BYTES, maxBytes) / size));
	const deadline = performance.now() + STATS_DEADLINE_MS;
	const selected = product(slab.count);
	let scanned = 0;
	let stoppedBy: "byte-cap" | "deadline" | null = null;
	const parts =
		array.shape.length === 0 ? [slab] : (chunkTiles(slab, array.chunks, slabElements) ?? slabsOf(slab, slabElements));
	for (const part of parts) {
		const elements = product(part.count);
		if ((scanned + elements) * size > maxBytes) {
			stoppedBy = "byte-cap";
			break;
		}
		if (performance.now() > deadline) {
			stoppedBy = "deadline";
			break;
		}
		accumulator.add(readSlab(array, part) as ReadonlyArray<number | bigint | null>, part);
		scanned += elements;
	}
	const scale = sentinelOf(array.attributes.scale_factor);
	const offset = sentinelOf(array.attributes.add_offset);
	const unpacked =
		scale !== null || offset !== null ? accumulator.unpacked(Number(scale ?? 1), Number(offset ?? 0)) : null;
	const complete = stoppedBy === null;
	return {
		...base(array.version),
		view: viewFor(complete, false),
		path: request.path,
		...header(array),
		start: slab.start,
		count: slab.count,
		stride: slab.stride,
		elementsSelected: selected,
		elementsScanned: scanned,
		bytesRead: scanned * size,
		maxBytes,
		complete,
		...(stoppedBy !== null
			? {
					stoppedBy,
					note:
						stoppedBy === "byte-cap"
							? `the pass stopped at the ${maxBytes}-byte cap after ${scanned} of ${selected} elements; every figure covers only those elements. Raise max_bytes (up to ${MAX_STATS_BYTES}) or narrow the selection`
							: `the pass stopped after ${STATS_DEADLINE_MS / 1000} s at ${scanned} of ${selected} elements; every figure covers only those elements. Narrow the selection`,
				}
			: {}),
		fillValue: fill === null ? null : encodeAttribute(fillRaw),
		missingValue: missingRaw === undefined ? null : encodeAttribute(missingRaw),
		storeFillValue: encodeValue(array.fillValue),
		...accumulator.summary(array.dtype.name === "float32"),
		...(unpacked !== null
			? { unpacked: { scaleFactor: Number(scale ?? 1), addOffset: Number(offset ?? 0), ...unpacked } }
			: {}),
		stdDefinition: "population (ddof=0) over valid values",
		bytesDefinition: "bytes counts decoded element bytes, not compressed bytes read from disk",
		notes: [FILL_NOTE],
	};
}
