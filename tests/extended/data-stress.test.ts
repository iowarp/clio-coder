import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { inspectData, isDataRefusal, selectData, validateData } from "../../src/tools/data/index.js";

/**
 * Bounded-memory contract on files far larger than any sensible in-memory
 * read: a 200 MB CSV and a 100 MB JSON array. Every scan below must keep the
 * peak growth of V8-visible memory (heap plus external allocations, which is
 * where buffers and Node's large external strings live) under a bound that
 * whole-file retention would break, stop at maxRows with an honest sampled
 * view, and land a deep selection on exactly the right rows. The peak is
 * sampled on a timer while the scan runs, so a spike freed before the call
 * returns still counts. RSS is not used: freed pages stay resident, so it
 * under-reports retention.
 *
 * The bound is 96 MB. A streaming scan cannot get arbitrarily low: V8 lets
 * young-generation garbage pile up to the semi-space capacity (64 MB on
 * Node 24) before a scavenge, and the five scans measured peaks of 10 to
 * 58 MB with old space growing 5 MB. Retaining the 100 MB JSON file costs
 * about 200 MB (its buffer and its string), which the last case demonstrates
 * against the same guard with a 1.5x margin.
 */

const CSV_TARGET_BYTES = 200 * 1024 * 1024;
const JSON_TARGET_BYTES = 100 * 1024 * 1024;
const GROWTH_BOUND = 96 * 1024 * 1024;
const CSV_PAD = "p".repeat(120);
const JSON_PAD = "q".repeat(120);

// Garbage collection on demand gives every measurement a clean baseline, so
// leftovers of an earlier case freed mid-scan cannot mask growth.
v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;

/** Heap plus external memory: every byte a scan can hold that V8 accounts for. */
function v8Memory(): number {
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.external;
}

/** Run a scan while sampling V8 memory every few milliseconds; returns the result and the peak growth seen. */
async function withPeakMemory<T>(run: () => Promise<T>): Promise<{ result: T; peakGrowth: number }> {
	collectGarbage();
	const baseline = v8Memory();
	let peak = baseline;
	const sample = (): void => {
		const now = v8Memory();
		if (now > peak) peak = now;
	};
	const timer = setInterval(sample, 2);
	try {
		const result = await run();
		sample();
		return { result, peakGrowth: peak - baseline };
	} finally {
		clearInterval(timer);
	}
}

function mb(bytes: number): string {
	return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Write rows in blocks so the generator itself never holds the file. */
function generateCsv(path: string): number {
	const fd = openSync(path, "w");
	let rows = 0;
	let bytes = 0;
	try {
		bytes += writeSync(fd, "id,name,value,flag,pad\n");
		while (bytes < CSV_TARGET_BYTES) {
			const lines: string[] = [];
			for (let index = 0; index < 20_000; index += 1) {
				const id = rows + index;
				lines.push(`${id},name-${id % 997},${(id * 0.25).toFixed(2)},${id % 2 === 0 ? "true" : "false"},${CSV_PAD}`);
			}
			rows += 20_000;
			bytes += writeSync(fd, `${lines.join("\n")}\n`);
		}
	} finally {
		closeSync(fd);
	}
	return rows;
}

function generateJsonArray(path: string): number {
	const fd = openSync(path, "w");
	let elements = 0;
	let bytes = 0;
	try {
		bytes += writeSync(fd, "[");
		while (bytes < JSON_TARGET_BYTES) {
			const parts: string[] = [];
			for (let index = 0; index < 20_000; index += 1) {
				const id = elements + index;
				parts.push(
					`${id === 0 ? "" : ","}{"id":${id},"name":"item-${id}","value":${(id * 0.5).toFixed(1)},"tags":["a","b"],"pad":"${JSON_PAD}"}`,
				);
			}
			elements += 20_000;
			bytes += writeSync(fd, parts.join(""));
		}
		bytes += writeSync(fd, "]");
	} finally {
		closeSync(fd);
	}
	return elements;
}

describe("extended/data-stress", () => {
	let dir = "";
	let csvPath = "";
	let jsonPath = "";
	let csvRows = 0;
	let jsonElements = 0;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-coder-data-stress-"));
		csvPath = join(dir, "big.csv");
		jsonPath = join(dir, "big.json");
		csvRows = generateCsv(csvPath);
		jsonElements = generateJsonArray(jsonPath);
		ok(statSync(csvPath).size >= CSV_TARGET_BYTES);
		ok(statSync(jsonPath).size >= JSON_TARGET_BYTES);
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("inspects a 200 MB CSV within the row bound, reporting a sampled view and bounded memory", async () => {
		const { result, peakGrowth } = await withPeakMemory(() => inspectData(csvPath));
		ok(!isDataRefusal(result), JSON.stringify(result));
		ok(result.format === "csv");
		strictEqual(result.rowCount, null);
		strictEqual(result.rowsScanned, 100_000);
		deepStrictEqual(result.view, { exact: false, sampled: true, converted: false });
		ok(result.bytesScanned < result.bytes / 4, `scan stopped early: ${result.bytesScanned} of ${result.bytes}`);
		deepStrictEqual(result.header, ["id", "name", "value", "flag", "pad"]);
		strictEqual(result.columns[0]?.inferredType, "integer");
		strictEqual(result.columns[2]?.inferredType, "float");
		strictEqual(result.columns[3]?.inferredType, "boolean");
		ok(peakGrowth < GROWTH_BOUND, `peak memory growth ${mb(peakGrowth)} for a ${mb(result.bytes)} file`);
	});

	it("selects rows deep inside the CSV verbatim without loading the prefix", async () => {
		const offset = Math.floor(csvRows * 0.6);
		const { result, peakGrowth } = await withPeakMemory(() =>
			selectData(csvPath, { offset, limit: 3, columns: ["id", "flag"] }),
		);
		ok(!isDataRefusal(result), JSON.stringify(result));
		ok(result.format === "csv");
		deepStrictEqual(result.rows, [
			[String(offset), offset % 2 === 0 ? "true" : "false"],
			[String(offset + 1), (offset + 1) % 2 === 0 ? "true" : "false"],
			[String(offset + 2), (offset + 2) % 2 === 0 ? "true" : "false"],
		]);
		strictEqual(result.hasMore, true);
		strictEqual(result.rowsScanned, offset + 4);
		ok(peakGrowth < GROWTH_BOUND, `peak memory growth ${mb(peakGrowth)} for a ${mb(result.bytes)} file`);
	});

	it("validates the CSV up to a row bound with a null verdict and bounded memory", async () => {
		const { result, peakGrowth } = await withPeakMemory(() => validateData(csvPath, { maxRows: 250_000 }));
		ok(!isDataRefusal(result), JSON.stringify(result));
		ok(result.format === "csv");
		strictEqual(result.valid, null);
		strictEqual(result.complete, false);
		strictEqual(result.rowsScanned, 250_000);
		strictEqual(result.raggedRows.count, 0);
		ok(peakGrowth < GROWTH_BOUND, `peak memory growth ${mb(peakGrowth)} for a ${mb(result.bytes)} file`);
	});

	it("inspects a 100 MB JSON array within the element bound with bounded memory", async () => {
		const { result, peakGrowth } = await withPeakMemory(() => inspectData(jsonPath, { sampleRows: 2 }));
		ok(!isDataRefusal(result), JSON.stringify(result));
		ok(result.format === "json");
		strictEqual(result.root, "array");
		strictEqual(result.rowCount, null);
		strictEqual(result.rowsScanned, 100_000);
		strictEqual(result.view.sampled, true);
		deepStrictEqual(result.elementTypes, { object: 100_000 });
		deepStrictEqual(result.sample[0], { id: 0, name: "item-0", value: 0, tags: ["a", "b"], pad: JSON_PAD });
		ok(result.bytesScanned < result.bytes / 2);
		ok(peakGrowth < GROWTH_BOUND, `peak memory growth ${mb(peakGrowth)} for a ${mb(result.bytes)} file`);
	});

	it("selects a deep element window from the JSON array and stops reading afterwards", async () => {
		const offset = Math.floor(jsonElements * 0.5);
		const { result, peakGrowth } = await withPeakMemory(() => selectData(jsonPath, { pointer: "", offset, limit: 2 }));
		ok(!isDataRefusal(result), JSON.stringify(result));
		ok(result.format === "json");
		deepStrictEqual(result.elements, [
			{ id: offset, name: `item-${offset}`, value: offset * 0.5, tags: ["a", "b"], pad: JSON_PAD },
			{ id: offset + 1, name: `item-${offset + 1}`, value: (offset + 1) * 0.5, tags: ["a", "b"], pad: JSON_PAD },
		]);
		strictEqual(result.hasMore, true);
		ok(result.bytesScanned < result.bytes, "the scan stopped before the end of the file");
		const pointed = await selectData(jsonPath, { pointer: `/${offset + 5}/name` });
		ok(!isDataRefusal(pointed), JSON.stringify(pointed));
		ok(pointed.format === "json");
		strictEqual(pointed.value, `item-${offset + 5}`);
		ok(peakGrowth < GROWTH_BOUND, `peak memory growth ${mb(peakGrowth)} for a ${mb(result.bytes)} file`);
	});

	it("detects whole-file retention: the bound fails when a scan holds the file", async () => {
		// The guard the other cases rely on must itself be able to fail, by a
		// wide margin: holding the file as a buffer and as a string costs twice
		// its size. The hold spans an await so the sampler sees it.
		const { result, peakGrowth } = await withPeakMemory(async () => {
			const bytes = readFileSync(jsonPath);
			const text = bytes.toString("utf8");
			await new Promise((resolve) => setTimeout(resolve, 20));
			return bytes.length + text.length;
		});
		strictEqual(result, 2 * statSync(jsonPath).size);
		ok(peakGrowth >= 1.5 * GROWTH_BOUND, `holding the file whole grew memory by only ${mb(peakGrowth)}`);
	});
});
