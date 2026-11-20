import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { deflateSync, gzipSync } from "node:zlib";
import { inspectData, isDataRefusal, selectData, statsData } from "../../src/tools/data/index.js";
import { chunkTiles, StatsAccumulator } from "../../src/tools/data/scientific-shared.js";
import { extractPackageTarball } from "../../src/tools/data/tar-extract.js";

/**
 * The scientific readers that run without a download: the native classic
 * NetCDF reader, whose record interleave and padding are pure offset
 * arithmetic, the tarball extractor's refusals, and the chunk tile walk that
 * stats relies on to cover a selection exactly once. Files are written byte
 * by byte here; HDF5 and Parquet need their fetched readers and are checked
 * live instead. Zarr stores and ADIOS2 BP4/BP5 directories are hand-built
 * too, laid out as zarr 3 and adios2 2.13 write them.
 */

/** A minimal CDF writer: version 1 or 5, big-endian, every list present. */
function cdf(
	version: 1 | 5,
	numrecs: number,
	dims: Array<[string, number]>,
	vars: Array<{
		name: string;
		dims: number[];
		type: number;
		attrs?: Array<[string, number, number[]]>;
		data: Buffer;
		record: boolean;
	}>,
): Buffer {
	const wide = version === 5;
	const parts: Buffer[] = [];
	const u32 = (value: number): void => {
		const b = Buffer.alloc(4);
		b.writeUInt32BE(value);
		parts.push(b);
	};
	const count = (value: number): void => {
		if (!wide) {
			u32(value);
			return;
		}
		const b = Buffer.alloc(8);
		b.writeBigUInt64BE(BigInt(value));
		parts.push(b);
	};
	const name = (text: string): void => {
		count(text.length);
		parts.push(Buffer.from(text), Buffer.alloc((4 - (text.length % 4)) % 4));
	};
	parts.push(Buffer.from([0x43, 0x44, 0x46, version]));
	count(numrecs);
	u32(0x0a);
	count(dims.length);
	for (const [dim, length] of dims) {
		name(dim);
		count(length);
	}
	u32(0);
	count(0);
	u32(0x0b);
	count(vars.length);
	const begins: Buffer[] = [];
	for (const variable of vars) {
		name(variable.name);
		count(variable.dims.length);
		for (const id of variable.dims) count(id);
		const attrs = variable.attrs ?? [];
		u32(attrs.length > 0 ? 0x0c : 0);
		count(attrs.length);
		for (const [key, type, values] of attrs) {
			name(key);
			u32(type);
			count(values.length);
			const b = Buffer.alloc(values.length * 2);
			for (const [index, value] of values.entries()) b.writeInt16BE(value, index * 2);
			parts.push(b, Buffer.alloc((4 - (b.length % 4)) % 4));
		}
		u32(variable.type);
		count(variable.data.length);
		const begin = Buffer.alloc(version === 1 ? 4 : 8);
		begins.push(begin);
		parts.push(begin);
	}
	let offset = parts.reduce((total, part) => total + part.length, 0);
	const body: Buffer[] = [];
	for (const [index, variable] of vars.entries()) {
		if (variable.record) continue;
		const begin = begins[index] as Buffer;
		if (version === 1) begin.writeUInt32BE(offset);
		else begin.writeBigUInt64BE(BigInt(offset));
		body.push(variable.data);
		offset += variable.data.length;
	}
	// Record variables: each record holds every record variable's slice, each padded to 4 bytes.
	const records = vars.filter((variable) => variable.record);
	const slices = records.map((variable) => variable.data.length / numrecs);
	let within = 0;
	for (const [index, variable] of vars.entries()) {
		if (!variable.record) continue;
		const begin = begins[index] as Buffer;
		if (version === 1) begin.writeUInt32BE(offset + within);
		else begin.writeBigUInt64BE(BigInt(offset + within));
		within += Math.ceil((slices[records.indexOf(variable)] as number) / 4) * 4;
	}
	for (let record = 0; record < numrecs; record += 1) {
		for (const [index, variable] of records.entries()) {
			const slice = slices[index] as number;
			const chunk = variable.data.subarray(record * slice, (record + 1) * slice);
			body.push(chunk, Buffer.alloc((4 - (slice % 4)) % 4));
		}
	}
	return Buffer.concat([...parts, ...body]);
}

function f64(values: number[]): Buffer {
	const b = Buffer.alloc(values.length * 8);
	for (const [index, value] of values.entries()) b.writeDoubleBE(value, index * 8);
	return b;
}

function f32le(values: number[]): Buffer {
	const b = Buffer.alloc(values.length * 4);
	for (const [index, value] of values.entries()) b.writeFloatLE(value, index * 4);
	return b;
}

function f64le(value: number): Buffer {
	const b = Buffer.alloc(8);
	b.writeDoubleLE(value);
	return b;
}

function i32le(value: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeInt32LE(value);
	return b;
}

function u64le(...values: number[]): Buffer {
	const b = Buffer.alloc(values.length * 8);
	for (const [index, value] of values.entries()) b.writeBigUInt64LE(BigInt(value), index * 8);
	return b;
}

function writeTree(root: string, files: Record<string, Buffer | string | object>): void {
	for (const [name, body] of Object.entries(files)) {
		const file = join(root, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
	}
}

/** Little-endian byte builder whose slots can be patched once a pointer target is known. */
class Bytes {
	parts: number[] = [];
	get length(): number {
		return this.parts.length;
	}
	raw(buffer: Buffer | number[]): this {
		this.parts.push(...buffer);
		return this;
	}
	int(value: number, width: 2 | 4 | 8): this {
		const b = Buffer.alloc(width);
		if (width === 2) b.writeUInt16LE(value);
		else if (width === 4) b.writeUInt32LE(value);
		else b.writeBigUInt64LE(BigInt(value));
		return this.raw(b);
	}
	str(text: string): this {
		return this.int(text.length, 2).raw(Buffer.from(text));
	}
	patch(at: number, bytes: Buffer): void {
		this.parts.splice(at, bytes.length, ...bytes);
	}
	buffer(): Buffer {
		return Buffer.from(this.parts);
	}
}

/** A 64-byte BP index or metadata header: little-endian flag 0 at byte 36, version at byte 37. */
function bpHeader(version: 4 | 5): Bytes {
	const header = Buffer.alloc(64);
	header.write("ADIOS-BP v2.13.0 Index Table");
	header[37] = version;
	if (version === 5) header[40] = 0x6e;
	return new Bytes().raw(header);
}

/** One BP4 index element: header, then characteristic sets of [id, payload] pairs. */
function bp4Element(name: string, type: number, sets: Array<Array<[number, Buffer]>>): Buffer {
	const body = new Bytes().int(0, 4).str("").str(name).raw([0x4b, 0, type]).int(sets.length, 8);
	for (const set of sets) {
		const chars = new Bytes();
		for (const [id, payload] of set) chars.raw([id]).raw(payload);
		body.raw([set.length]).int(chars.length, 4).raw(chars.buffer());
	}
	return new Bytes().int(body.length, 4).raw(body.buffer()).buffer();
}

function bp4Index(elements: Buffer[]): Buffer {
	const all = Buffer.concat(elements);
	return new Bytes().int(elements.length, 4).int(all.length, 8).raw(all).buffer();
}

/** An FFS version-2 format representation holding one little-endian subformat. */
function ffsFormat(name: string, fields: Array<[string, string, number, number]>, recordLength: number): Buffer {
	const strings = new Bytes();
	const offsetOf = (text: string): number => {
		const at = 28 + fields.length * 16 + strings.length;
		strings.raw(Buffer.from(`${text}\0`));
		return at;
	};
	const nameAt = offsetOf(name);
	const table = new Bytes();
	for (const [field, type, size, offset] of fields)
		table.int(offsetOf(field), 4).int(offsetOf(type), 4).int(size, 4).int(offset, 4);
	const head = Buffer.alloc(28);
	head.writeUInt16BE(28 + table.length + strings.length, 0);
	head[2] = 2;
	head.writeUInt32LE(nameAt, 4);
	head.writeUInt32LE(fields.length, 8);
	head.writeUInt32LE(recordLength, 12);
	head[16] = 8;
	head[17] = 28;
	return Buffer.concat([Buffer.alloc(8), head, table.buffer(), strings.buffer()]);
}

/** An FFS-encoded record: 12-byte format ID, 8-byte length, padding to 8, then the record and its out-of-line data. */
function ffsRecord(id: Buffer, record: Bytes): Buffer {
	const body = record.buffer();
	return Buffer.concat([id, u64le(body.length), Buffer.alloc(4), body]);
}

function i16(values: number[]): Buffer {
	const b = Buffer.alloc(values.length * 2);
	for (const [index, value] of values.entries()) b.writeInt16BE(value, index * 2);
	return b;
}

describe("contracts/data-scientific", () => {
	const dir = mkdtempSync(join(tmpdir(), "clio-coder-data-sci-"));

	it("reads classic NetCDF record variables through their padded interleave", async () => {
		// Two record variables, so the int16 slice (2 bytes) pads to 4 inside each record.
		const path = join(dir, "classic.nc");
		writeFileSync(
			path,
			cdf(
				1,
				3,
				[
					["time", 0],
					["x", 2],
				],
				[
					{ name: "x", dims: [1], type: 6, data: f64([10, 20]), record: false },
					{ name: "rec", dims: [0, 1], type: 6, data: f64([0, 1, 2, 3, 4, 5]), record: true },
					{ name: "w", dims: [0], type: 3, attrs: [["_FillValue", 3, [-1]]], data: i16([7, -1, 9]), record: true },
				],
			),
		);
		const slab = await selectData(path, { variable: "rec", start: [0, 1], count: [2, 1], stride: [2, 1] });
		ok(!isDataRefusal(slab));
		deepStrictEqual((slab as Record<string, unknown>).values, [[1], [5]]);
		const stats = await statsData(path, { variable: "w" });
		ok(!isDataRefusal(stats));
		const summary = stats as Record<string, unknown>;
		strictEqual(summary.fillCount, 1);
		strictEqual(summary.validCount, 2);
		strictEqual(summary.mean, 8);
	});

	it("keeps CDF-5 64-bit counts and refuses an explicit selection over the element cap", async () => {
		const path = join(dir, "data64.nc");
		const big = Buffer.alloc(16);
		big.writeBigInt64BE(2n ** 53n + 1n, 0);
		big.writeBigInt64BE(-3n, 8);
		writeFileSync(
			path,
			cdf(
				5,
				0,
				[
					["n", 2],
					["m", 3000],
				],
				[
					{ name: "q", dims: [0], type: 10, data: big, record: false },
					{ name: "wide", dims: [1], type: 6, data: f64(new Array(3000).fill(1)), record: false },
				],
			),
		);
		const slab = await selectData(path, { variable: "q" });
		ok(!isDataRefusal(slab));
		deepStrictEqual((slab as Record<string, unknown>).values, [
			{ $literal: "9007199254740993", precision: "unsafe-integer" },
			-3,
		]);
		const refused = await selectData(path, { variable: "wide", count: [3000] });
		ok(isDataRefusal(refused));
		strictEqual(refused.reason, "selection-too-large");
	});

	it("refuses a tarball entry that escapes the target or is not a plain file", () => {
		const entry = (name: string, type: string): Buffer => {
			const header = Buffer.alloc(512);
			header.write(name, 0);
			header.write("0000644\0", 100);
			header.write("00000000000\0", 124);
			header.write(type, 156);
			header.write("ustar\0", 257);
			header.fill(0x20, 148, 156);
			let sum = 0;
			for (const byte of header) sum += byte;
			header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
			return Buffer.concat([header, Buffer.alloc(1024)]);
		};
		const target = join(dir, "unpacked");
		throws(() => extractPackageTarball(gzipSync(entry("package/../../evil", "0")), target), /escapes the target/u);
		throws(() => extractPackageTarball(gzipSync(entry("package/link", "2")), target), /only files and directories/u);
		ok(!existsSync(join(dir, "evil")));
	});

	it("reports where stats found min and max, in absolute indexes, skipping fill and missing values", async () => {
		// 3x4x5 int16 grid: value = 100*i + 10*j + k, with fill (9999) and missing (-9999) at the extremes.
		const grid: number[] = [];
		for (let i = 0; i < 3; i += 1)
			for (let j = 0; j < 4; j += 1) for (let k = 0; k < 5; k += 1) grid.push(100 * i + 10 * j + k);
		const at = (i: number, j: number, k: number): number => i * 20 + j * 5 + k;
		grid[at(2, 3, 4)] = 9999;
		grid[at(0, 0, 0)] = -9999;
		grid[at(1, 1, 3)] = 500;
		grid[at(2, 1, 1)] = 500;
		grid[at(0, 3, 4)] = -5;
		grid[at(2, 3, 3)] = -5;
		const path = join(dir, "grid.nc");
		writeFileSync(
			path,
			cdf(
				1,
				0,
				[
					["t", 3],
					["y", 4],
					["x", 5],
				],
				[
					{
						name: "v",
						dims: [0, 1, 2],
						type: 3,
						attrs: [
							["_FillValue", 3, [9999]],
							["missing_value", 3, [-9999]],
						],
						data: i16(grid),
						record: false,
					},
					{
						name: "blank",
						dims: [2],
						type: 3,
						attrs: [["_FillValue", 3, [7]]],
						data: i16([7, 7, 7, 7, 7]),
						record: false,
					},
				],
			),
		);
		const whole = (await statsData(path, { variable: "v" })) as Record<string, unknown>;
		ok(!isDataRefusal(whole));
		strictEqual(whole.max, 500);
		deepStrictEqual(whole.argmax, [1, 1, 3]);
		strictEqual(whole.min, -5);
		deepStrictEqual(whole.argmin, [0, 3, 4]);
		const window = (await statsData(path, {
			variable: "v",
			start: [1, 1, 1],
			count: [2, 2, 2],
			stride: [1, 2, 2],
		})) as Record<string, unknown>;
		ok(!isDataRefusal(window));
		strictEqual(window.max, 500);
		deepStrictEqual(window.argmax, [1, 1, 3]);
		strictEqual(window.min, -5);
		deepStrictEqual(window.argmin, [2, 3, 3]);
		const blank = (await statsData(path, { variable: "blank" })) as Record<string, unknown>;
		ok(!isDataRefusal(blank));
		strictEqual(blank.validCount, 0);
		strictEqual(blank.argmin, null);
		strictEqual(blank.argmax, null);
	});

	it("keeps the first extremum across blocks, past NaN, infinities, nulls and wide integers", () => {
		const floats = new StatsAccumulator(Number.NaN, []);
		floats.add(Float64Array.from([Number.NaN, 4, Number.POSITIVE_INFINITY, 1]), {
			start: [10, 0],
			count: [2, 2],
			stride: [3, 1],
		});
		floats.add([null, 4, 1, Number.NEGATIVE_INFINITY], { start: [16, 0], count: [2, 2], stride: [3, 1] });
		const flat = floats.summary(false);
		deepStrictEqual(
			[flat.argmin, flat.argmax],
			[
				[13, 1],
				[10, 1],
			],
		);
		const wide = new StatsAccumulator(null, []);
		const top = 2n ** 62n;
		wide.add(BigInt64Array.from([top, top + 1n, -top]), { start: [5], count: [3], stride: [2] });
		wide.add(BigInt64Array.from([top + 1n, -top - 1n]), { start: [100], count: [2], stride: [1] });
		const summary = wide.summary(false);
		deepStrictEqual([summary.argmin, summary.argmax], [[101], [7]]);
		const none = new StatsAccumulator(null, []);
		none.add(Float64Array.from([Number.NaN, Number.POSITIVE_INFINITY]), { start: [0], count: [2], stride: [1] });
		deepStrictEqual([none.summary(false).argmin, none.summary(false).argmax], [null, null]);
	});

	it("settles a tie across chunk tiles by dataset position, not arrival order", () => {
		// Tiles narrower than a row deliver row 1 of the left tile before row 0 of the right one.
		const stats = new StatsAccumulator(null, []);
		stats.add(Float64Array.from([5, 0, 9, -3]), { start: [0, 0], count: [2, 2], stride: [1, 1] });
		stats.add(Float64Array.from([9, -3, 1, 1]), { start: [0, 2], count: [2, 2], stride: [1, 1] });
		const summary = stats.summary(false);
		deepStrictEqual(
			[summary.argmin, summary.argmax],
			[
				[0, 3],
				[0, 2],
			],
		);
		const wide = new StatsAccumulator(null, []);
		wide.add(BigInt64Array.from([1n, 2n ** 62n]), { start: [1, 0], count: [1, 2], stride: [1, 1] });
		wide.add(BigInt64Array.from([2n ** 62n, 1n]), { start: [0, 4], count: [1, 2], stride: [1, 1] });
		deepStrictEqual(
			[wide.summary(false).argmin, wide.summary(false).argmax],
			[
				[0, 5],
				[0, 4],
			],
		);
	});

	it("reads a Zarr v3 store through gzip chunks, fills an unwritten chunk, and refuses blosc with the run_script route", async () => {
		const root = join(dir, "v3.zarr");
		const temp = {
			zarr_format: 3,
			node_type: "array",
			shape: [3, 4],
			data_type: "float32",
			chunk_grid: { name: "regular", configuration: { chunk_shape: [2, 3] } },
			chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
			fill_value: -999,
			codecs: [
				{ name: "bytes", configuration: { endian: "little" } },
				{ name: "gzip", configuration: { level: 5 } },
			],
			attributes: { units: "K", _FillValue: -999 },
			dimension_names: ["y", "x"],
		};
		writeTree(root, {
			"zarr.json": { zarr_format: 3, node_type: "group", attributes: { title: "demo" } },
			"temp/zarr.json": temp,
			// Chunk (1, 1) is never written, so element [2, 3] reads as fill_value.
			"temp/c/0/0": gzipSync(f32le([0, 1, 2, 4, 5, 6])),
			"temp/c/0/1": gzipSync(f32le([3, 0, 0, 7, 0, 0])),
			"temp/c/1/0": gzipSync(f32le([8, 9, 10, 0, 0, 0])),
			"packed/zarr.json": {
				...temp,
				shape: [4],
				chunk_grid: { name: "regular", configuration: { chunk_shape: [4] } },
				codecs: [
					{ name: "bytes", configuration: { endian: "little" } },
					{ name: "blosc", configuration: {} },
				],
				dimension_names: ["x"],
			},
		});
		const listing = (await inspectData(root)) as Record<string, unknown>;
		ok(!isDataRefusal(listing), JSON.stringify(listing));
		strictEqual(listing.variant, "Zarr v3");
		const arrays = listing.variables as Array<Record<string, unknown>>;
		deepStrictEqual(
			arrays.map((array) => [array.path, array.compression, array.readable]),
			[
				["/packed", "blosc", false],
				["/temp", "gzip", true],
			],
		);
		deepStrictEqual(arrays[1]?.dims, ["y", "x"]);
		const slab = (await selectData(root, { variable: "temp" })) as Record<string, unknown>;
		deepStrictEqual(slab.values, [
			[0, 1, 2, 3],
			[4, 5, 6, 7],
			[8, 9, 10, -999],
		]);
		const stats = (await statsData(root, { variable: "/temp", start: [1, 1], count: [2, 3] })) as Record<string, unknown>;
		strictEqual(stats.fillCount, 1);
		strictEqual(stats.validCount, 5);
		strictEqual(stats.max, 10);
		const refused = await selectData(root, { variable: "packed" });
		ok(isDataRefusal(refused));
		strictEqual(refused.reason, "unsupported-format");
		ok(refused.message.includes("blosc") && refused.message.includes("run_script"));
	});

	it("reads a Zarr v2 array through zlib, a big-endian dtype and Fortran order", async () => {
		const root = join(dir, "v2.zarr");
		const array = (dtype: string, order: "C" | "F", compressor: object | null): object => ({
			zarr_format: 2,
			shape: [2, 3],
			chunks: [2, 3],
			dtype,
			order,
			compressor,
			fill_value: 0,
			filters: null,
		});
		const fortran = Buffer.alloc(24);
		for (const [index, value] of [0, 3, 1, 4, 2, 5].entries()) fortran.writeInt32LE(value, index * 4);
		writeTree(root, {
			".zgroup": { zarr_format: 2 },
			".zattrs": { title: "demo2" },
			"big/.zarray": array(">i2", "C", { id: "zlib", level: 1 }),
			"big/.zattrs": { _ARRAY_DIMENSIONS: ["y", "x"] },
			"big/0.0": deflateSync(i16([1, 2, 3, -4, 5, 6])),
			"ford/.zarray": array("<i4", "F", null),
			"ford/0.0": fortran,
		});
		const big = (await selectData(root, { variable: "big" })) as Record<string, unknown>;
		ok(!isDataRefusal(big), JSON.stringify(big));
		deepStrictEqual(big.values, [
			[1, 2, 3],
			[-4, 5, 6],
		]);
		deepStrictEqual(big.dims, ["y", "x"]);
		const ford = (await selectData(root, { variable: "ford" })) as Record<string, unknown>;
		deepStrictEqual(ford.values, [
			[0, 1, 2],
			[3, 4, 5],
		]);
	});

	it("inspects an ADIOS2 BP4 directory's variables, steps, block min and max, and attributes, and refuses select", async () => {
		const root = join(dir, "out4.bp");
		const md = bpHeader(4);
		const index = bpHeader(4);
		for (const step of [1, 2]) {
			const stepTag: [number, Buffer] = [8, i32le(step)];
			// Dimensions: rank, byte length, then count, shape and start per dimension.
			const dims: [number, Buffer] = [4, Buffer.concat([Buffer.from([2, 48, 0]), u64le(2, 2, 0, 3, 3, 0)])];
			const minmax: [number, Buffer] = [12, Buffer.concat([Buffer.from([1, 0]), f64le(step - 1), f64le(step + 4)])];
			const variables = bp4Index([
				bp4Element("T", 6, [[stepTag, dims, minmax]]),
				bp4Element("n", 2, [[stepTag, [0, i32le(step * 10)]]]),
			]);
			const text = (value: string): Array<Array<[number, Buffer]>> => [[[0, new Bytes().str(value).buffer()]]];
			const attributes = bp4Index(
				step === 1 ? [bp4Element("T/units", 9, text("K")), bp4Element("desc", 9, text("probe"))] : [],
			);
			const variablesAt = md.length;
			md.raw(variables);
			const attributesAt = md.length;
			md.raw(attributes);
			index.raw(u64le(step, 0, 0, variablesAt, attributesAt, md.length, 0, 0));
		}
		writeTree(root, { "md.idx": index.buffer(), "md.0": md.buffer(), "data.0": Buffer.alloc(0) });
		const result = (await inspectData(root)) as Record<string, unknown>;
		ok(!isDataRefusal(result), JSON.stringify(result));
		strictEqual(result.variant, "ADIOS2 BP4");
		strictEqual(result.steps, 2);
		deepStrictEqual(result.attributes, { desc: "probe" });
		const [t, n] = result.variables as Array<Record<string, unknown>>;
		deepStrictEqual(
			[t?.path, t?.dtype, t?.kind, t?.shape, t?.blocks, t?.min, t?.max],
			["T", "float64", "global array", [2, 3], 2, 0, 6],
		);
		deepStrictEqual(t?.steps, { count: 2, first: 0, last: 1 });
		deepStrictEqual(t?.attributes, { units: "K" });
		deepStrictEqual(n?.values, [
			{ step: 0, value: 10 },
			{ step: 1, value: 20 },
		]);
		const refused = await selectData(root, { variable: "T" });
		ok(isDataRefusal(refused));
		ok(refused.message.includes("run_script"));
	});

	it("inspects an ADIOS2 BP5 directory through its FFS metadata formats", async () => {
		const root = join(dir, "out5.bp");
		const metaId = Buffer.from("02000107ce4f9c91491cb4a7", "hex");
		const attrId = Buffer.from("0200008d72b6d67f54032261", "hex");
		// MetaArrayMM8 holds Dims, BlockCount, DBCount, then Shape, Count, Offset, DataBlockLocation and MinMax pointers.
		const meta = ffsFormat(
			"MetaData",
			[
				["BitFieldCount", "integer", 8, 0],
				["BitField", "integer[BitFieldCount]", 8, 8],
				["DataBlockSize", "integer", 8, 16],
				["BPG_8_10_T", "MetaArrayMM8", 64, 24],
				["BPg_n", "integer", 4, 88],
			],
			96,
		);
		const mmd = new Bytes();
		for (const [id, rep] of [
			[metaId, meta],
			[attrId, ffsFormat("GenericAttributes", [], 32)],
		] as const)
			mmd.raw(u64le(id.length, rep.length)).raw(id).raw(rep);
		const md = new Bytes();
		// The writer map record: one writer, then its subfile.
		const index = bpHeader(5)
			.raw([0x77])
			.raw(u64le(16, 1, 0));
		for (const step of [0, 1]) {
			const record = new Bytes().raw(Buffer.alloc(96));
			record.patch(0, u64le(1));
			record.patch(8, u64le(record.length));
			// Bit 0 marks T present, bit 1 marks n present (step 0 only).
			record.raw(u64le(step === 0 ? 0b11 : 0b01));
			record.patch(24, u64le(2, 1, 2));
			record.patch(48, u64le(record.length));
			record.raw(u64le(2, 3));
			record.patch(56, u64le(record.length));
			record.raw(u64le(2, 3));
			record.patch(80, u64le(record.length));
			record.raw(f64le(step)).raw(f64le(step + 5));
			if (step === 0) record.patch(88, i32le(42));
			const metaBlock = ffsRecord(metaId, record);
			let attrBlock: Buffer = Buffer.alloc(0);
			if (step === 0) {
				// One string attribute: StrAttrCount, StrAttrs -> {Name, ElementCount, Values -> [char *]}.
				const generic = new Bytes().raw(Buffer.alloc(32));
				generic.patch(16, u64le(1, generic.length));
				const entry = generic.length;
				generic.raw(Buffer.alloc(24));
				generic.patch(entry, u64le(generic.length, 1));
				// '>' is '0' plus type 14 (string), not an array.
				generic.raw(Buffer.from(">T/units\0", "latin1"));
				generic.patch(entry + 16, u64le(generic.length));
				const values = generic.length;
				generic.raw(Buffer.alloc(8));
				generic.patch(values, u64le(generic.length));
				generic.raw(Buffer.from("K\0", "latin1"));
				attrBlock = ffsRecord(attrId, generic);
			}
			const position = md.length;
			md.raw(u64le(16 + metaBlock.length + attrBlock.length, metaBlock.length, attrBlock.length));
			md.raw(metaBlock).raw(attrBlock);
			index.raw([0x73]).raw(u64le(24, position, md.length - position, 0));
		}
		writeTree(root, { "md.idx": index.buffer(), "md.0": md.buffer(), "mmd.0": mmd.buffer(), "data.0": Buffer.alloc(0) });
		const result = (await inspectData(root)) as Record<string, unknown>;
		ok(!isDataRefusal(result), JSON.stringify(result));
		strictEqual(result.variant, "ADIOS2 BP5");
		strictEqual(result.steps, 2);
		strictEqual(result.writers, 1);
		const [t, n] = result.variables as Array<Record<string, unknown>>;
		deepStrictEqual(
			[t?.path, t?.dtype, t?.kind, t?.shape, t?.blocks, t?.min, t?.max],
			["T", "float64", "global array", [2, 3], 2, 0, 6],
		);
		deepStrictEqual(t?.attributes, { units: "K" });
		deepStrictEqual([n?.path, n?.dtype, n?.kind, n?.values], ["n", "int32", "global value", [{ step: 0, value: 42 }]]);
		const refused = await statsData(root, { variable: "T" });
		ok(isDataRefusal(refused));
		ok(refused.message.includes("run_script"));
	});

	it("walks chunk tiles that cover an unaligned selection exactly once", () => {
		const selection = { start: [3, 5], count: [17, 40], stride: [1, 1] };
		const tiles = chunkTiles(selection, [4, 8], 64);
		ok(tiles !== null);
		const seen = new Map<string, number>();
		for (const tile of tiles) {
			ok((tile.count[0] as number) * (tile.count[1] as number) <= 64);
			for (let i = 0; i < (tile.count[0] as number); i += 1) {
				for (let j = 0; j < (tile.count[1] as number); j += 1) {
					const key = `${(tile.start[0] as number) + i},${(tile.start[1] as number) + j}`;
					seen.set(key, (seen.get(key) ?? 0) + 1);
				}
			}
		}
		strictEqual(seen.size, 17 * 40);
		ok([...seen.values()].every((times) => times === 1));
	});
});
