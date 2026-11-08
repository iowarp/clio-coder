import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { isDataRefusal, selectData, statsData } from "../../src/tools/data/index.js";
import { chunkTiles, StatsAccumulator } from "../../src/tools/data/scientific-shared.js";
import { extractPackageTarball } from "../../src/tools/data/tar-extract.js";

/**
 * The scientific readers that run without a download: the native classic
 * NetCDF reader, whose record interleave and padding are pure offset
 * arithmetic, the tarball extractor's refusals, and the chunk tile walk that
 * stats relies on to cover a selection exactly once. Files are written byte
 * by byte here; HDF5 and Parquet need their fetched readers and are checked
 * live instead.
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
