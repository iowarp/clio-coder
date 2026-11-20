import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
	ATTRIBUTE_ARRAY_ITEMS,
	ATTRIBUTE_LIMIT,
	type EncodedValue,
	encodeAttribute,
	encodeValue,
	INSPECT_MAX_VARIABLES,
	INSPECT_RESULT_BYTES,
	jsonBytes,
	refuse,
	type ScientificRequest,
	type ScientificResult,
	viewFor,
} from "./scientific-shared.js";

/**
 * Native ADIOS2 BP4 and BP5 metadata reader for the data tool's inspect. A BP
 * output is a directory: md.idx indexes the steps, md.0 holds each step's
 * metadata (BP4 as characteristic lists, BP5 as FFS-encoded records whose
 * layouts live in mmd.0), and data.N the payload. Only metadata is read, so
 * inspect reports variables, types, shapes, steps, block counts, min/max and
 * attributes; select and stats are refused with the run_script route, since
 * payloads may be compressed by ADIOS2 operators and spread over subfiles.
 * Big-endian outputs, BP3 files and older BP5 metadata layouts are refused.
 */

const METADATA_CAP = 256 * 1024 * 1024;
const ROUTE =
	"use run_script with the adios2 Python package (adios2.FileReader(path), then inquire_variable and read) or bpls -d";
/** Shape entries at or above this mark ADIOS2's LocalValueDim and JoinedDim sentinels. */
const DIM_SENTINEL = 2n ** 63n;

type Scalar = number | bigint | string | null;

interface BpVariable {
	name: string;
	dtype: string;
	kind: "global array" | "local array" | "joined array" | "global value" | "local value";
	shape: number[] | null;
	shapeChanges: boolean;
	steps: number[];
	blocks: number;
	min: Scalar;
	max: Scalar;
	/** Per-step values of a global or local value, first writer's block. */
	values: Array<[number, Scalar]>;
	operator: string | null;
}

interface BpFile {
	engine: "BP4" | "BP5";
	steps: number;
	writers: number | null;
	variables: Map<string, BpVariable>;
	attributes: Map<string, { dtype: string; value: unknown }>;
	notes: string[];
}

function readFile(path: string, cap: number): Buffer {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		refuse("read-error", `cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const size = fstatSync(fd).size;
		if (size > cap)
			refuse(
				"selection-too-large",
				`${path} is ${size} bytes; BP metadata is read here up to ${cap / 1024 / 1024} MiB. ${ROUTE}`,
			);
		const buffer = Buffer.alloc(size);
		let at = 0;
		while (at < size) {
			const got = readSync(fd, buffer, at, size - at, at);
			if (got === 0) break;
			at += got;
		}
		return buffer.subarray(0, at);
	} finally {
		closeSync(fd);
	}
}

/** Bounds-checked little-endian reader: every overrun is a corrupt-metadata refusal, never a garbage value. */
class Cursor {
	constructor(
		readonly buffer: Buffer,
		public at: number,
		readonly what: string,
	) {}
	need(bytes: number, at = this.at): number {
		if (at < 0 || at + bytes > this.buffer.length)
			refuse("read-error", `${this.what} is truncated or corrupt: ${bytes} bytes needed at offset ${at}`);
		return at;
	}
	u8(): number {
		const at = this.need(1);
		this.at += 1;
		return this.buffer.readUInt8(at);
	}
	u16(): number {
		const at = this.need(2);
		this.at += 2;
		return this.buffer.readUInt16LE(at);
	}
	u32(): number {
		const at = this.need(4);
		this.at += 4;
		return this.buffer.readUInt32LE(at);
	}
	u64(): number {
		const at = this.need(8);
		this.at += 8;
		const value = this.buffer.readBigUInt64LE(at);
		return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
	}
	big(): bigint {
		const at = this.need(8);
		this.at += 8;
		return this.buffer.readBigUInt64LE(at);
	}
	bytes(length: number): Buffer {
		const at = this.need(length);
		this.at += length;
		return this.buffer.subarray(at, at + length);
	}
	bpString(): string {
		return this.bytes(this.u16()).toString("utf8");
	}
}

interface NumericType {
	name: string;
	size: number;
	read: ((buffer: Buffer, at: number) => Scalar) | null;
}

const numeric = (name: string, size: number, read: NumericType["read"]): NumericType => ({ name, size, read });
const READERS = {
	int8: numeric("int8", 1, (b, at) => b.readInt8(at)),
	int16: numeric("int16", 2, (b, at) => b.readInt16LE(at)),
	int32: numeric("int32", 4, (b, at) => b.readInt32LE(at)),
	int64: numeric("int64", 8, (b, at) => b.readBigInt64LE(at)),
	uint8: numeric("uint8", 1, (b, at) => b.readUInt8(at)),
	uint16: numeric("uint16", 2, (b, at) => b.readUInt16LE(at)),
	uint32: numeric("uint32", 4, (b, at) => b.readUInt32LE(at)),
	uint64: numeric("uint64", 8, (b, at) => b.readBigUInt64LE(at)),
	float32: numeric("float32", 4, (b, at) => b.readFloatLE(at)),
	float64: numeric("float64", 8, (b, at) => b.readDoubleLE(at)),
	longdouble: numeric("long double", 16, null),
	complex64: numeric("complex64", 8, null),
	complex128: numeric("complex128", 16, null),
	char: numeric("char", 1, (b, at) => b.readInt8(at)),
} as const;

/** BP4 (adios1 legacy) type codes. */
const BP4_TYPES: Record<number, NumericType | "string" | "string array"> = {
	0: READERS.int8,
	1: READERS.int16,
	2: READERS.int32,
	4: READERS.int64,
	50: READERS.uint8,
	51: READERS.uint16,
	52: READERS.uint32,
	54: READERS.uint64,
	5: READERS.float32,
	6: READERS.float64,
	7: READERS.longdouble,
	9: "string",
	10: READERS.complex64,
	11: READERS.complex128,
	12: "string array",
	55: READERS.char,
};

/** ADIOS2 DataType enum values, which BP5 writes into names. */
const BP5_TYPES: Record<number, NumericType | "string" | "struct"> = {
	1: READERS.int8,
	2: READERS.int16,
	3: READERS.int32,
	4: READERS.int64,
	5: READERS.uint8,
	6: READERS.uint16,
	7: READERS.uint32,
	8: READERS.uint64,
	9: READERS.float32,
	10: READERS.float64,
	11: READERS.longdouble,
	12: READERS.complex64,
	13: READERS.complex128,
	14: "string",
	15: READERS.char,
	16: "struct",
};

function typeName(type: NumericType | string | undefined, code: number): string {
	if (type === undefined) return `unknown type ${code}`;
	return typeof type === "string" ? type : type.name;
}

function variableEntry(variables: Map<string, BpVariable>, name: string, dtype: string): BpVariable {
	let entry = variables.get(name);
	if (entry === undefined) {
		entry = {
			name,
			dtype,
			kind: "global value",
			shape: null,
			shapeChanges: false,
			steps: [],
			blocks: 0,
			min: null,
			max: null,
			values: [],
			operator: null,
		};
		variables.set(name, entry);
	}
	return entry;
}

function less(a: Scalar, b: Scalar): boolean {
	if (a === null || b === null || typeof a === "string" || typeof b === "string") return false;
	if (typeof a === "number" && Number.isNaN(a)) return false;
	// biome-ignore lint/suspicious/noDoubleEquals: number and bigint compare by value
	return a < b && !(a == b);
}

function record(
	entry: BpVariable,
	step: number,
	block: { shape: number[] | null; min: Scalar; max: Scalar; value?: Scalar },
): void {
	if (entry.steps[entry.steps.length - 1] !== step) entry.steps.push(step);
	entry.blocks += 1;
	if (block.shape !== null) {
		if (entry.shape !== null && entry.shape.join(",") !== block.shape.join(",")) entry.shapeChanges = true;
		entry.shape = block.shape;
	}
	if (block.min !== null && (entry.min === null || less(block.min, entry.min))) entry.min = block.min;
	if (block.max !== null && (entry.max === null || less(entry.max, block.max))) entry.max = block.max;
	if (block.value !== undefined && entry.values[entry.values.length - 1]?.[0] !== step)
		entry.values.push([step, block.value]);
}

// ---------------------------------------------------------------- BP4

interface Bp4Characteristics {
	step: number | null;
	count: number[];
	shape: number[];
	start: number[];
	hugeShape: boolean;
	value: unknown;
	min: Scalar;
	max: Scalar;
	operator: string | null;
}

function bp4Characteristics(cursor: Cursor, type: NumericType | "string" | "string array"): Bp4Characteristics {
	const out: Bp4Characteristics = {
		step: null,
		count: [],
		shape: [],
		start: [],
		hugeShape: false,
		value: undefined,
		min: null,
		max: null,
		operator: null,
	};
	cursor.u8();
	const length = cursor.u32();
	const start = cursor.at;
	const end = start + length;
	cursor.need(length);
	const value = (): Scalar => {
		if (typeof type === "string") return null;
		const at = cursor.need(type.size);
		cursor.at += type.size;
		return type.read === null ? null : type.read(cursor.buffer, at);
	};
	let dims = 0;
	while (cursor.at < end) {
		const id = cursor.u8();
		switch (id) {
			case 8:
				out.step = cursor.u32();
				break;
			case 7:
				cursor.u32();
				break;
			case 0:
				if (type === "string") out.value = cursor.bpString();
				else if (type === "string array") {
					const items: string[] = [];
					for (let index = 0; index < (out.count[0] ?? 1); index += 1) items.push(cursor.bpString());
					out.value = items;
				} else if (out.count.length === 0 || out.count[0] === 1) out.value = value();
				else {
					const items: Scalar[] = [];
					for (let index = 0; index < (out.count[0] as number); index += 1) items.push(value());
					out.value = items;
				}
				break;
			case 1:
				out.min = value();
				break;
			case 2:
				out.max = value();
				break;
			case 12: {
				const subBlocks = cursor.u16();
				out.min = value();
				out.max = value();
				if (subBlocks > 1) {
					cursor.u8();
					cursor.u64();
					cursor.bytes(2 * dims);
					for (let index = 0; index < 2 * subBlocks; index += 1) value();
				}
				break;
			}
			case 3:
			case 6:
				cursor.u64();
				break;
			case 4: {
				dims = cursor.u8();
				cursor.u16();
				for (let dim = 0; dim < dims; dim += 1) {
					out.count.push(cursor.u64());
					const shape = cursor.big();
					if (shape >= DIM_SENTINEL) out.hugeShape = true;
					out.shape.push(shape >= DIM_SENTINEL ? -1 : Number(shape));
					out.start.push(cursor.u64());
				}
				break;
			}
			case 9: {
				const bitmap = cursor.u32();
				const stat = cursor.at < end ? cursor.buffer[cursor.at] : undefined;
				if (stat === 10) {
					cursor.u8();
					for (let bit = 0; bit <= 6; bit += 1) {
						if ((bitmap & (1 << bit)) === 0) continue;
						if (bit === 0) out.min = value();
						else if (bit === 1) out.max = value();
						else if (bit === 2) cursor.u32();
						else if (bit === 3 || bit === 4) cursor.u64();
						else if (bit === 6) cursor.u8();
						else {
							cursor.at = end;
							break;
						}
					}
				}
				break;
			}
			case 11: {
				out.operator = cursor.bytes(cursor.u8()).toString("latin1");
				cursor.u8();
				const opDims = cursor.u8();
				cursor.u16();
				cursor.bytes(opDims * 24);
				cursor.bytes(cursor.u16());
				break;
			}
			default:
				// An unknown characteristic: the set length still bounds it, so skip the rest.
				cursor.at = end;
		}
	}
	cursor.at = end;
	return out;
}

interface Bp4Element {
	name: string;
	typeCode: number;
	sets: Bp4Characteristics[];
}

function bp4Elements(md: Buffer, position: number, what: string): Bp4Element[] {
	const cursor = new Cursor(md, position, what);
	cursor.u32();
	const length = cursor.u64();
	const end = cursor.at + length;
	cursor.need(length);
	const out: Bp4Element[] = [];
	while (cursor.at < end) {
		const elementStart = cursor.at;
		const elementLength = cursor.u32();
		cursor.u32();
		cursor.bpString();
		const name = cursor.bpString();
		cursor.u8();
		cursor.u8();
		const typeCode = cursor.buffer.readInt8(cursor.need(1));
		cursor.at += 1;
		const setCount = cursor.u64();
		const type = BP4_TYPES[typeCode];
		const sets: Bp4Characteristics[] = [];
		if (type !== undefined) for (let set = 0; set < setCount; set += 1) sets.push(bp4Characteristics(cursor, type));
		out.push({ name, typeCode, sets });
		cursor.at = elementStart + 4 + elementLength;
	}
	return out;
}

function readBp4(dir: string): BpFile {
	const index = readFile(join(dir, "md.idx"), METADATA_CAP);
	const md = readFile(join(dir, "md.0"), METADATA_CAP);
	if (index.length < 64) refuse("read-error", `${dir}/md.idx is shorter than its 64-byte header`);
	if (index[36] !== 0) refuse("unsupported-format", `${dir} was written big-endian; ${ROUTE}`);
	const file: BpFile = {
		engine: "BP4",
		steps: 0,
		writers: null,
		variables: new Map(),
		attributes: new Map(),
		notes: [],
	};
	const ranks = new Set<number>();
	const steps = new Set<number>();
	for (let at = 64; at + 64 <= index.length; at += 64) {
		const row = new Cursor(index, at, `${dir}/md.idx`);
		const step = row.u64();
		ranks.add(row.u64());
		row.u64();
		const variables = row.u64();
		const attributes = row.u64();
		steps.add(step);
		for (const element of bp4Elements(md, variables, `${dir}/md.0`)) {
			const type = BP4_TYPES[element.typeCode];
			const entry = variableEntry(file.variables, element.name, typeName(type, element.typeCode));
			for (const set of element.sets) {
				const local = set.shape.length > 0 && set.shape.every((extent) => extent === 0);
				if (set.hugeShape && set.shape.length === 1) entry.kind = "local value";
				else if (set.hugeShape) entry.kind = "joined array";
				else if (set.count.length === 0 || (set.count.every((n) => n === 0) && set.shape.length === 0))
					entry.kind = "global value";
				else entry.kind = local ? "local array" : "global array";
				if (set.operator !== null) entry.operator = set.operator;
				const isArray = entry.kind.endsWith("array");
				const shape = isArray ? (entry.kind === "local array" ? set.count : set.shape) : null;
				const scalar = isArray ? undefined : ((set.value ?? set.min) as Scalar);
				record(entry, (set.step ?? step) - 1, {
					shape,
					min: set.min ?? (isArray ? null : (scalar ?? null)),
					max: set.max ?? (isArray ? null : (scalar ?? null)),
					...(scalar !== undefined ? { value: scalar } : {}),
				});
			}
		}
		for (const element of bp4Elements(md, attributes, `${dir}/md.0`)) {
			const set = element.sets[0];
			if (set === undefined || file.attributes.has(element.name)) continue;
			file.attributes.set(element.name, {
				dtype: typeName(BP4_TYPES[element.typeCode], element.typeCode),
				value: set.value,
			});
		}
	}
	file.steps = steps.size;
	if (ranks.size > 1) file.notes.push(`md.idx indexes ${ranks.size} metadata ranks; their variables are merged`);
	return file;
}

// ---------------------------------------------------------------- BP5 (FFS)

interface FfsField {
	name: string;
	type: string;
	size: number;
	offset: number;
}

interface FfsFormat {
	name: string;
	fields: FfsField[];
	/** IOversion 4 (server_rep_version 2) puts an 8-byte length after the format ID, older ones 4. */
	lengthBytes: number;
	little: boolean;
}

function cString(buffer: Buffer, at: number, what: string): string {
	if (at < 0 || at >= buffer.length) refuse("read-error", `${what} is corrupt: a string offset ${at} is out of range`);
	const end = buffer.indexOf(0, at);
	return buffer.toString("utf8", at, end < 0 ? buffer.length : end);
}

/** Parse one FFS format representation (fm_formats.c expand_format_from_rep): the top subformat only. */
function ffsFormat(rep: Buffer, what: string): FfsFormat {
	if (rep.length < 8 + 28) refuse("read-error", `${what} holds a format shorter than its header`);
	const sub = rep.subarray(8);
	const version = sub[2] as number;
	const little = ((sub[3] as number) & 1) === 0;
	if (!little) refuse("unsupported-format", `${what} was written big-endian; ${ROUTE}`);
	if (version === 0) refuse("unsupported-format", `${what} uses FFS format version 0, which is not read here; ${ROUTE}`);
	const name = cString(sub, sub.readUInt32LE(4), what);
	const count = sub.readUInt32LE(8);
	const header = sub[17] as number;
	const fields: FfsField[] = [];
	for (let index = 0; index < count; index += 1) {
		const at = header + index * 16;
		if (at + 16 > sub.length) refuse("read-error", `${what} is corrupt: field ${index} runs past its format`);
		fields.push({
			name: cString(sub, sub.readUInt32LE(at), what),
			type: cString(sub, sub.readUInt32LE(at + 4), what),
			size: sub.readInt32LE(at + 8),
			offset: sub.readInt32LE(at + 12),
		});
	}
	return { name, fields, lengthBytes: version >= 2 ? 8 : 4, little };
}

function bp5Formats(mmd: Buffer, what: string): Map<string, FfsFormat> {
	const formats = new Map<string, FfsFormat>();
	const cursor = new Cursor(mmd, 0, what);
	while (cursor.at < mmd.length) {
		const idLength = cursor.u64();
		const infoLength = cursor.u64();
		const id = cursor.bytes(idLength);
		formats.set(id.toString("hex"), ffsFormat(cursor.bytes(infoLength), what));
	}
	return formats;
}

/** An FFS-encoded record: its format and the offset its pointers are relative to. */
function ffsRecord(
	block: Buffer,
	formats: Map<string, FfsFormat>,
	what: string,
): { format: FfsFormat; base: Cursor } | null {
	for (const idLength of [12, 10, 8]) {
		if (block.length < idLength) continue;
		const format = formats.get(block.subarray(0, idLength).toString("hex"));
		if (format === undefined) continue;
		const header = idLength + format.lengthBytes;
		const base = header + ((8 - (header % 8)) % 8);
		return { format, base: new Cursor(block.subarray(base), 0, what) };
	}
	return null;
}

function u64At(cursor: Cursor, at: number): number {
	cursor.at = at;
	return cursor.u64();
}

function u64List(cursor: Cursor, pointer: number, count: number): number[] {
	const out: number[] = [];
	if (pointer === 0) return out;
	cursor.at = pointer;
	for (let index = 0; index < count; index += 1) out.push(cursor.u64());
	return out;
}

function ffsValue(cursor: Cursor, field: FfsField): Scalar {
	const at = cursor.need(field.size, field.offset);
	const buffer = cursor.buffer;
	if (field.type === "string") {
		const pointer = Number(buffer.readBigUInt64LE(at));
		return pointer === 0 ? null : cString(buffer, pointer, cursor.what);
	}
	const unsigned = field.type.startsWith("unsigned");
	if (field.type.includes("integer") || field.type === "char" || field.type === "enumeration") {
		if (field.size === 1) return unsigned ? buffer.readUInt8(at) : buffer.readInt8(at);
		if (field.size === 2) return unsigned ? buffer.readUInt16LE(at) : buffer.readInt16LE(at);
		if (field.size === 4) return unsigned ? buffer.readUInt32LE(at) : buffer.readInt32LE(at);
		if (field.size === 8) return unsigned ? buffer.readBigUInt64LE(at) : buffer.readBigInt64LE(at);
	}
	if (field.type === "float" || field.type === "double") {
		if (field.size === 4) return buffer.readFloatLE(at);
		if (field.size === 8) return buffer.readDoubleLE(at);
	}
	return null;
}

function ffsTypeName(field: FfsField): string {
	if (field.type === "string") return "string";
	if (field.type === "float" || field.type === "double") return field.size === 4 ? "float32" : "float64";
	const unsigned = field.type.startsWith("unsigned");
	if (field.type.includes("integer")) return `${unsigned ? "uint" : "int"}${field.size * 8}`;
	if (field.type === "char") return "char";
	return field.type;
}

const KINDS: Record<string, BpVariable["kind"]> = {
	g: "global value",
	G: "global array",
	J: "joined array",
	l: "local value",
	L: "local array",
};

/** Split a BP5 field name: BP<kind>_<name> for values, BP<kind>_<elemsize>_<type>_<name> for arrays. */
function bp5Name(field: string): { kind: BpVariable["kind"]; rest: string; derived: boolean } | null {
	if (!field.startsWith("BP") || field.length < 4) return null;
	const kind = KINDS[field[2] as string];
	if (kind === undefined) return null;
	if (field[3] === "_") return { kind, rest: field.slice(4), derived: false };
	// A derived variable carries a base64 expression: BP<kind>-<len>-<expr>-<rest>.
	const match = /^-(\d+)-/u.exec(field.slice(3));
	if (match === null) return null;
	const skip = 3 + match[0].length + Number(match[1]) + 1;
	return { kind, rest: field.slice(skip), derived: true };
}

function bp5Variables(file: BpFile, block: Buffer, formats: Map<string, FfsFormat>, step: number, what: string): void {
	const parsed = ffsRecord(block, formats, what);
	if (parsed === null) refuse("read-error", `${what}: a step's metadata names a format that mmd.0 does not hold`);
	const { format, base } = parsed;
	const fields = format.fields;
	if (fields[0]?.name !== "BitFieldCount" || fields[1]?.name !== "BitField")
		refuse("unsupported-format", `${what} uses a BP5 metadata layout that is not read here; ${ROUTE}`);
	const bitCount = u64At(base, 0);
	const bits = u64List(base, u64At(base, 8), bitCount).map((word) => BigInt(word));
	let index = -1;
	for (const field of fields.slice(3)) {
		index += 1;
		const word = bits[Math.floor(index / 64)] ?? 0n;
		if (((word >> BigInt(index % 64)) & 1n) === 0n) continue;
		const name = bp5Name(field.name);
		if (name === null) continue;
		if (!name.kind.endsWith("array")) {
			const entry = variableEntry(file.variables, name.rest, ffsTypeName(field));
			entry.kind = name.kind;
			const value = ffsValue(base, field);
			record(entry, step, { shape: null, min: value, max: value, value });
			continue;
		}
		if (!field.type.startsWith("MetaArray"))
			refuse("unsupported-format", `${what} uses the older BP5 array metadata layout; ${ROUTE}`);
		const match = /^(\d+)_(\d+)_(.*)$/su.exec(name.rest);
		if (match === null) continue;
		const typeCode = Number(match[2]);
		const type = BP5_TYPES[typeCode];
		let varName = match[3] as string;
		// A struct array carries its format ID in hex before the name.
		if (type === "struct") varName = varName.slice(varName.indexOf("_") + 1);
		const entry = variableEntry(file.variables, varName, typeName(type, typeCode));
		entry.kind = name.kind;
		const at = field.offset;
		const dims = u64At(base, at);
		const blockCount = u64At(base, at + 8);
		const dbCount = u64At(base, at + 16);
		const shape = u64List(base, u64At(base, at + 24), dims);
		const counts = u64List(base, u64At(base, at + 32), dbCount);
		const operator = field.type.includes("Op");
		if (operator) entry.operator = "operator";
		let min: Scalar = null;
		let max: Scalar = null;
		const mm = /MM(\d+)$/u.exec(field.type);
		if (mm !== null && typeof type === "object" && type.read !== null) {
			const pointer = u64At(base, at + (operator ? 64 : 56));
			const size = Number(mm[1]);
			for (let blockIndex = 0; blockIndex < blockCount && pointer !== 0; blockIndex += 1) {
				const lo = type.read(base.buffer, base.need(size * 2, pointer + blockIndex * size * 2));
				const hi = type.read(base.buffer, pointer + blockIndex * size * 2 + size);
				if (min === null || less(lo, min)) min = lo;
				if (max === null || less(max, hi)) max = hi;
			}
		}
		const blockShape = name.kind === "local array" ? counts.slice(0, dims) : shape;
		record(entry, step, { shape: blockShape.length > 0 ? blockShape : null, min, max });
		entry.blocks += Math.max(0, blockCount - 1);
	}
}

function bp5Attributes(file: BpFile, block: Buffer, formats: Map<string, FfsFormat>, what: string): void {
	const parsed = ffsRecord(block, formats, what);
	if (parsed === null) return;
	const { format, base } = parsed;
	if (format.name !== "GenericAttributes") {
		file.notes.push(`attributes in the older ${format.name} layout are not listed`);
		return;
	}
	const kind = (name: string): { code: number; array: boolean; name: string } => {
		let code = name.charCodeAt(0) - 48;
		const array = code > 18;
		if (array) code -= 18;
		return { code, array, name: name.slice(1) };
	};
	const primCount = u64At(base, 0);
	const prims = u64At(base, 8);
	for (let index = 0; index < primCount; index += 1) {
		const at = prims + index * 24;
		const label = kind(cString(base.buffer, u64At(base, at), what));
		const total = u64At(base, at + 8);
		const values = u64At(base, at + 16);
		const type = BP5_TYPES[label.code];
		let value: unknown = null;
		if (typeof type === "object" && type.read !== null) {
			const items: Scalar[] = [];
			base.need(total, values);
			for (let offset = 0; offset + type.size <= total; offset += type.size)
				items.push(type.read(base.buffer, values + offset));
			value = label.array ? items : items[0];
		}
		file.attributes.set(label.name, { dtype: typeName(type, label.code), value });
	}
	const strCount = u64At(base, 16);
	const strs = u64At(base, 24);
	for (let index = 0; index < strCount; index += 1) {
		const at = strs + index * 24;
		const label = kind(cString(base.buffer, u64At(base, at), what));
		const count = u64At(base, at + 8);
		const items = u64List(base, u64At(base, at + 16), count).map((pointer) => cString(base.buffer, pointer, what));
		file.attributes.set(label.name, { dtype: "string", value: label.array ? items : (items[0] ?? "") });
	}
}

function readBp5(dir: string): BpFile {
	const index = readFile(join(dir, "md.idx"), METADATA_CAP);
	if (index.length < 64) refuse("read-error", `${dir}/md.idx is shorter than its 64-byte header`);
	if (index[36] !== 0) refuse("unsupported-format", `${dir} was written big-endian; ${ROUTE}`);
	const formats = bp5Formats(readFile(join(dir, "mmd.0"), METADATA_CAP), `${dir}/mmd.0`);
	const md = readFile(join(dir, "md.0"), METADATA_CAP);
	const file: BpFile = {
		engine: "BP5",
		steps: 0,
		writers: null,
		variables: new Map(),
		attributes: new Map(),
		notes: [],
	};
	// Header bytes 40 and 41 (BP5IndexTableHeader): columnMajor ('y' or 'n') and flattenSteps.
	if (index[40] === 0x79)
		file.notes.push("the writer was column-major (Fortran); shapes are listed in the writer's dimension order");
	if (index[41] !== 0 && index[41] !== undefined)
		file.notes.push("the writer asked for its steps to be flattened into one on read; steps are listed as written");
	const cursor = new Cursor(index, 64, `${dir}/md.idx`);
	let writers = 1;
	const what = `${dir}/md.0`;
	while (cursor.at < index.length) {
		const id = String.fromCharCode(cursor.u8());
		const length = cursor.u64();
		const end = cursor.at + length;
		cursor.need(length);
		if (id === "w") {
			writers = cursor.u64();
			file.writers = Math.max(file.writers ?? 0, writers);
		} else if (id === "s") {
			const position = cursor.u64();
			const step = file.steps;
			file.steps += 1;
			const block = new Cursor(md, position + 8, what);
			const sizes: number[] = [];
			for (let writer = 0; writer < 2 * writers; writer += 1) sizes.push(block.u64());
			let at = block.at;
			for (let writer = 0; writer < writers; writer += 1) {
				const size = sizes[writer] as number;
				bp5Variables(file, md.subarray(block.need(size, at), at + size), formats, step, what);
				at += size;
			}
			for (let writer = 0; writer < writers; writer += 1) {
				const size = sizes[writers + writer] as number;
				if (size > 0) bp5Attributes(file, md.subarray(block.need(size, at), at + size), formats, what);
				at += size;
			}
		}
		cursor.at = end;
	}
	return file;
}

// ---------------------------------------------------------------- results

function load(request: ScientificRequest): BpFile {
	return request.container === "bp5" ? readBp5(request.path) : readBp4(request.path);
}

function stepsSummary(steps: number[]): Record<string, unknown> {
	const contiguous = steps.every((step, index) => index === 0 || step === (steps[index - 1] as number) + 1);
	return contiguous && steps.length > 0
		? { count: steps.length, first: steps[0], last: steps[steps.length - 1] }
		: {
				count: steps.length,
				list: steps.slice(0, ATTRIBUTE_ARRAY_ITEMS),
				...(steps.length > ATTRIBUTE_ARRAY_ITEMS ? { listOmitted: steps.length - ATTRIBUTE_ARRAY_ITEMS } : {}),
			};
}

function attributesOf(file: BpFile, prefix: string | null): { values: Record<string, EncodedValue>; total: number } {
	const entries = [...file.attributes.entries()].filter(([name]) =>
		prefix === null
			? !name.includes("/") || !file.variables.has(name.slice(0, name.lastIndexOf("/")))
			: name.startsWith(`${prefix}/`),
	);
	const values: Record<string, EncodedValue> = {};
	for (const [name, attribute] of entries.slice(0, ATTRIBUTE_LIMIT))
		values[prefix === null ? name : name.slice(prefix.length + 1)] = encodeAttribute(attribute.value);
	return { values, total: entries.length };
}

function describe(file: BpFile, variable: BpVariable, detail: "full" | "compact"): Record<string, unknown> {
	const attributes = attributesOf(file, variable.name);
	const scalar = !variable.kind.endsWith("array");
	const entry: Record<string, unknown> = {
		path: variable.name,
		dtype: variable.dtype,
		kind: variable.kind,
		shape: variable.shape,
		...(variable.shapeChanges ? { shapeChanges: "the shape differs between steps; shape is the last step's" } : {}),
		steps: stepsSummary(variable.steps),
		blocks: variable.blocks,
		min: encodeValue(variable.min, variable.dtype === "float32"),
		max: encodeValue(variable.max, variable.dtype === "float32"),
		...(variable.operator !== null ? { operator: variable.operator } : {}),
	};
	if (scalar && detail === "full") {
		entry.values = variable.values
			.slice(0, ATTRIBUTE_ARRAY_ITEMS)
			.map(([step, value]) => ({ step, value: encodeValue(value, variable.dtype === "float32") }));
		if (variable.values.length > ATTRIBUTE_ARRAY_ITEMS)
			entry.valuesOmitted = variable.values.length - ATTRIBUTE_ARRAY_ITEMS;
	}
	if (detail === "full") {
		if (attributes.total > 0) entry.attributes = attributes.values;
	} else if (attributes.total > 0) entry.attributeCount = attributes.total;
	return entry;
}

const NOTES = [
	"steps are 0-based; min and max come from the writer's per-block metadata, not from reading data, and are null when the writer stored none",
	"values of scalar variables are the first writer's per step",
	`op=select and op=stats do not read ADIOS2 payloads here; ${ROUTE}`,
];

export function inspectAdios2(request: ScientificRequest): ScientificResult {
	const file = load(request);
	const base = {
		format: "adios2" as const,
		variant: `ADIOS2 ${file.engine}`,
		path: request.path,
	};
	if (request.variable !== undefined) {
		const variable = file.variables.get(request.variable) ?? file.variables.get(request.variable.replace(/^\//u, ""));
		if (variable === undefined) {
			const names = [...file.variables.keys()].slice(0, 20);
			refuse(
				"unknown-variable",
				`no variable ${JSON.stringify(request.variable)} in ${request.path}; variables include ${names.join(", ") || "none"}`,
			);
		}
		return {
			...base,
			view: viewFor(true, false),
			steps: file.steps,
			variable: describe(file, variable, "full"),
			notes: NOTES,
		};
	}
	const variables = [...file.variables.values()];
	const globals = attributesOf(file, null);
	const build = (count: number, detail: "full" | "compact"): ScientificResult => ({
		...base,
		view: viewFor(true, count < variables.length || detail === "compact"),
		steps: file.steps,
		...(file.writers !== null ? { writers: file.writers } : {}),
		attributes: globals.values,
		...(globals.total > ATTRIBUTE_LIMIT ? { attributesOmitted: globals.total - ATTRIBUTE_LIMIT } : {}),
		variables: variables.slice(0, count).map((variable) => describe(file, variable, detail)),
		listing: { variablesShown: count, variablesFound: variables.length, attributes: detail },
		notes: [
			...file.notes,
			...(detail === "compact"
				? ["per-step values and attributes are reduced to counts to fit the result; inspect one variable for them"]
				: []),
			...(count < variables.length
				? [`${variables.length - count} variables are not listed; inspect one by name in variable`]
				: []),
			...NOTES,
		],
	});
	let count = Math.min(variables.length, INSPECT_MAX_VARIABLES);
	let result = build(count, "full");
	if (jsonBytes(result) > INSPECT_RESULT_BYTES) result = build(count, "compact");
	while (jsonBytes(result) > INSPECT_RESULT_BYTES && count > 1) {
		count = Math.max(1, Math.floor(count * 0.75));
		result = build(count, "compact");
	}
	return result;
}

export function selectAdios2(request: ScientificRequest): ScientificResult {
	refuse(
		"unsupported-format",
		`op=select does not read ADIOS2 payloads (${request.path}); op=inspect lists variables, shapes, steps and attributes; ${ROUTE}`,
	);
}

export function statsAdios2(request: ScientificRequest): ScientificResult {
	refuse(
		"unsupported-format",
		`op=stats does not read ADIOS2 payloads (${request.path}); op=inspect reports per-block min and max from metadata; ${ROUTE}`,
	);
}
