import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import {
	inspectData,
	isDataRefusal,
	type JsonlInspectResult,
	type JsonlSelectResult,
	type JsonlValidateResult,
	selectData,
	validateData,
} from "../../src/tools/data/index.js";
import { scanJsonText } from "../../src/tools/data/json.js";
import { JSONL_MAX_LINE_CHARS } from "../../src/tools/data/jsonl.js";

// Garbage collection on demand makes retained-memory assertions deterministic
// instead of depending on when a scavenge happens to run.
v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;

/** Heap plus external memory after a forced collection: what is really retained. */
function retainedMemory(): number {
	collectGarbage();
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.external;
}

describe("contracts/data-jsonl", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-coder-data-jsonl-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function file(name: string, content: string | Buffer): string {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	}

	async function inspect(path: string, options: Parameters<typeof inspectData>[1] = {}): Promise<JsonlInspectResult> {
		const result = await inspectData(path, options);
		ok(!isDataRefusal(result), `inspect refused: ${JSON.stringify(result)}`);
		ok(result.format === "jsonl");
		return result;
	}

	async function select(path: string, options: Parameters<typeof selectData>[1] = {}): Promise<JsonlSelectResult> {
		const result = await selectData(path, options);
		ok(!isDataRefusal(result), `select refused: ${JSON.stringify(result)}`);
		ok(result.format === "jsonl");
		return result;
	}

	async function validate(path: string, options: Parameters<typeof validateData>[1] = {}): Promise<JsonlValidateResult> {
		const result = await validateData(path, options);
		ok(!isDataRefusal(result), `validate refused: ${JSON.stringify(result)}`);
		ok(result.format === "jsonl");
		return result;
	}

	// Line 4 is blank, line 5 is broken, line 6 carries a large integer and a
	// duplicate key, line 7 is a bare array, and the file ends without a newline.
	const content = [
		'{"id": 1, "kind": "a", "value": 1.5, "tags": ["x"]}',
		'{"id": 2, "kind": "b", "value": null}',
		'{"id": 3, "kind": "a", "value": "text", "extra": true}',
		"",
		'{"id": 4, "kind": ',
		'{"id": 9007199254740993, "kind": "c", "kind": "d"}',
		"[1, 2, 3]",
		'{"id": 5, "kind": "e", "value": 1.0000000000000001, "ratio": 9007199254740993.0}',
	].join("\n");

	it("inspects records with key and type histograms, invalid lines, duplicates, and precision", async () => {
		const path = file("events.jsonl", content);
		const result = await inspect(path);
		deepStrictEqual(result.view, { exact: true, sampled: false, converted: false });
		strictEqual(result.linesScanned, 8);
		strictEqual(result.blankLines, 1);
		strictEqual(result.rowsScanned, 7);
		strictEqual(result.rowCount, 7);
		deepStrictEqual(result.invalid, {
			count: 1,
			first: [{ line: 5, message: "unexpected end of input at line 1 column 18 (byte offset 18)" }],
		});
		deepStrictEqual(result.rootTypes, { object: 5, array: 1 });
		deepStrictEqual(result.keys.histogram, { id: 5, kind: 5, value: 4, tags: 1, extra: 1, ratio: 1 });
		strictEqual(result.keys.truncated, false);
		deepStrictEqual(result.keyTypes.value, { number: 2, null: 1, string: 1 });
		deepStrictEqual(result.keyTypes.kind, { string: 5 });
		strictEqual(result.maxDepth, 1);
		deepStrictEqual(result.duplicateKeys, { count: 1, firstLine: 6 });
		strictEqual(result.precision.count, 3);
		deepStrictEqual(
			result.precision.first.map((issue) => [issue.line, issue.path, issue.kind, issue.literal]),
			[
				[6, "/id", "unsafe-integer", "9007199254740993"],
				[8, "/value", "inexact", "1.0000000000000001"],
				[8, "/ratio", "unsafe-integer", "9007199254740993.0"],
			],
		);
		strictEqual(result.sample.length, 6);
		deepStrictEqual(result.sample[0], { line: 1, value: { id: 1, kind: "a", value: 1.5, tags: ["x"] } });
		deepStrictEqual(result.sample[3], {
			line: 6,
			value: { id: { $literal: "9007199254740993", precision: "unsafe-integer" }, kind: "d" },
		});
		deepStrictEqual(result.sample[4], { line: 7, value: [1, 2, 3] });
		deepStrictEqual(result.sample[5], {
			line: 8,
			value: {
				id: 5,
				kind: "e",
				value: { $literal: "1.0000000000000001", precision: "inexact" },
				ratio: { $literal: "9007199254740993.0", precision: "unsafe-integer" },
			},
		});
		ok(result.notes.some((note) => note.includes("not valid JSON")));
	});

	it("marks a scan that stopped at maxRows as sampled", async () => {
		const lines = Array.from({ length: 30 }, (_, index) => JSON.stringify({ index }));
		const path = file("many.jsonl", `${lines.join("\n")}\n`);
		const result = await inspect(path, { maxRows: 12, sampleRows: 2 });
		strictEqual(result.rowCount, null);
		strictEqual(result.rowsScanned, 12);
		strictEqual(result.view.sampled, true);
		strictEqual(result.sample.length, 2);
		ok(result.notes.some((note) => note.startsWith("sampled: 12 records scanned of an unknown total")));
		ok(result.bytesScanned <= result.bytes);
	});

	it("reads CRLF lines and a byte-order mark", async () => {
		const path = file("crlf.jsonl", '﻿{"a": 1}\r\n{"a": 2}\r\n');
		const result = await inspect(path);
		strictEqual(result.rowCount, 2);
		strictEqual(result.invalid.count, 0);
		deepStrictEqual(
			result.sample.map((record) => record.value),
			[{ a: 1 }, { a: 2 }],
		);
		ok(result.notes.some((note) => note.includes("byte-order mark")));
	});

	it("selects a record window by offset and limit with invalid records reported in place", async () => {
		const path = file("events.jsonl", content);
		const window = await select(path, { offset: 2, limit: 3 });
		strictEqual(window.offset, 2);
		strictEqual(window.returned, 3);
		strictEqual(window.hasMore, true);
		strictEqual(window.rowsScanned, 6, "one record past the window proves hasMore");
		deepStrictEqual(window.duplicateKeys, { count: 1, firstLine: 6 });
		ok(window.notes.some((note) => note.includes("duplicate object key")));
		deepStrictEqual(window.records[0], {
			line: 3,
			value: { id: 3, kind: "a", value: "text", extra: true },
			truncated: false,
		});
		deepStrictEqual(window.records[1], {
			line: 5,
			error: "unexpected end of input at line 1 column 18 (byte offset 18)",
		});
		deepStrictEqual(window.records[2], {
			line: 6,
			value: { id: { $literal: "9007199254740993", precision: "unsafe-integer" }, kind: "d" },
			truncated: false,
		});
		strictEqual(window.precision.count, 1);
		strictEqual(window.precision.first[0]?.line, 6);
		const tail = await select(path, { offset: 5, limit: 10 });
		strictEqual(tail.records.length, 2);
		deepStrictEqual(tail.records[0], { line: 7, value: [1, 2, 3], truncated: false });
		strictEqual(tail.hasMore, false);
		deepStrictEqual(tail.duplicateKeys, { count: 0, firstLine: null });
		strictEqual(tail.view.exact, true);
		const pointer = await selectData(path, { pointer: "/a" });
		ok(isDataRefusal(pointer));
		strictEqual(pointer.reason, "invalid-argument");
	});

	it("validates: false with an invalid line, null when stopped early, true for a clean file", async () => {
		const broken = await validate(file("events.jsonl", content));
		strictEqual(broken.valid, false);
		strictEqual(broken.complete, true);
		strictEqual(broken.invalid.count, 1);
		strictEqual(broken.invalid.first[0]?.line, 5);
		deepStrictEqual(broken.duplicateKeys, { count: 1, firstLine: 6 });
		strictEqual(broken.precision.count, 3);
		const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify({ index }));
		const clean = file("clean.jsonl", `${lines.join("\n")}\n`);
		const partial = await validate(clean, { maxRows: 5 });
		strictEqual(partial.valid, null);
		strictEqual(partial.rowCount, null);
		ok(partial.notes.some((note) => note.startsWith("validation incomplete")));
		const whole = await validate(clean);
		strictEqual(whole.valid, true);
		strictEqual(whole.rowCount, 20);
		strictEqual(whole.linesScanned, 20);
	});

	it("reads an empty file and refuses invalid UTF-8 and binary bytes", async () => {
		const empty = await inspect(file("empty.jsonl", ""));
		strictEqual(empty.rowCount, 0);
		strictEqual(empty.linesScanned, 0);
		deepStrictEqual(empty.sample, []);
		const latin = await inspectData(
			file("latin.jsonl", Buffer.concat([Buffer.from('{"k": "caf'), Buffer.from([0xe9, 0x22, 0x7d, 0x0a])])),
		);
		ok(isDataRefusal(latin));
		strictEqual(latin.reason, "invalid-utf8");
		strictEqual(latin.byteOffset, 10);
		const binary = await inspectData(file("blob.ndjson", Buffer.from([0x7b, 0x7d, 0x0a, 0x00])));
		ok(isDataRefusal(binary));
		strictEqual(binary.reason, "binary");
		match(binary.message, /NUL byte at offset 3/u);
	});

	it("marks a record with a string cut at the capture cap and drops the exact view", async () => {
		const path = file("long.jsonl", `${JSON.stringify({ id: 1, text: "t".repeat(70_000) })}\n{"id": 2}\n`);
		const result = await select(path, { offset: 0, limit: 2 });
		deepStrictEqual(result.records[0], {
			line: 1,
			value: { id: 1, text: { $truncated: "string", length: 70_000, text: "t".repeat(65_536) } },
			truncated: true,
		});
		deepStrictEqual(result.records[1], { line: 2, value: { id: 2 }, truncated: false });
		deepStrictEqual(result.view, { exact: false, sampled: false, converted: false });
		ok(result.notes.some((note) => note.includes("$truncated")));
		const intact = await select(path, { offset: 1, limit: 1 });
		strictEqual(intact.view.exact, true);
		const inspected = await inspect(path);
		strictEqual(inspected.view.exact, true, "a cut sample is a preview; the counts stay exact");
		strictEqual(inspected.rowCount, 2);
		ok(inspected.notes.some((note) => note.includes("sample record(s) were cut")));
	});

	it("skips an oversized line without holding it and reports it by line number", async () => {
		// A whole 64 MB JSON array saved with a .jsonl name, followed by two real
		// records. The line is dropped as it streams; a forced collection after
		// the scan shows nothing of it was kept, and the report names it.
		const path = join(dir, "document.jsonl");
		const fd = openSync(path, "w");
		try {
			writeSync(fd, "[");
			let bytes = 1;
			let id = 0;
			while (bytes < 64 * 1024 * 1024) {
				const parts: string[] = [];
				for (let index = 0; index < 10_000; index += 1, id += 1) parts.push(`${id === 0 ? "" : ","}{"id":${id}}`);
				const text = parts.join("");
				bytes += text.length;
				writeSync(fd, text);
			}
			writeSync(fd, ']\n{"after": 1}\n\n{"after": 2}');
		} finally {
			closeSync(fd);
		}
		const baseline = retainedMemory();
		const result = await inspect(path);
		const retained = retainedMemory() - baseline;
		ok(retained < 16 * 1024 * 1024, `retained ${Math.round(retained / 1024 / 1024)} MB after the scan`);
		strictEqual(result.rowsScanned, 3);
		strictEqual(result.linesScanned, 4);
		strictEqual(result.blankLines, 1);
		strictEqual(result.invalid.count, 1);
		strictEqual(result.invalid.first[0]?.line, 1);
		match(result.invalid.first[0]?.message ?? "", new RegExp(`over the ${JSONL_MAX_LINE_CHARS}-character limit`, "u"));
		match(result.invalid.first[0]?.message ?? "", /format json/u);
		deepStrictEqual(result.rootTypes, { object: 2 });
		deepStrictEqual(
			result.sample.map((record) => record.line),
			[2, 4],
		);
		const selected = await select(path, { offset: 0, limit: 2 });
		deepStrictEqual(selected.records[0]?.line, 1);
		ok(selected.records[0] !== undefined && "error" in selected.records[0]);
		deepStrictEqual(selected.records[1], { line: 2, value: { after: 1 }, truncated: false });
		const verdict = await validate(path);
		strictEqual(verdict.valid, false);
		strictEqual(verdict.invalid.first[0]?.line, 1);
		strictEqual(verdict.rowCount, 3);
	});

	it("adds little over parsing when splitting many short lines", async () => {
		// The line splitter once recomputed a byte offset by rescanning the chunk
		// prefix for every line, which made 20-byte lines many times slower than
		// parsing them directly. Both timings run here, back to back, on the same
		// 200 000 lines, so the ratio does not depend on the machine.
		const lines: string[] = [];
		for (let index = 0; index < 200_000; index += 1) lines.push(`{"i":${100_000_000_000 + index}}`);
		const path = file("short.jsonl", `${lines.join("\n")}\n`);
		const parseDirectly = (): number => {
			const started = performance.now();
			for (const line of lines) scanJsonText(line);
			return performance.now() - started;
		};
		parseDirectly();
		const directMs = parseDirectly();
		const started = performance.now();
		const result = await validate(path, { maxRows: null });
		const streamedMs = performance.now() - started;
		strictEqual(result.valid, true);
		strictEqual(result.rowCount, 200_000);
		ok(
			streamedMs < 4 * directMs + 100,
			`streamed ${Math.round(streamedMs)} ms versus direct parse ${Math.round(directMs)} ms`,
		);
	});

	it("stops promptly on abort", async () => {
		const path = file(
			"abort.jsonl",
			`${Array.from({ length: 1000 }, (_, index) => JSON.stringify({ index })).join("\n")}\n`,
		);
		const controller = new AbortController();
		controller.abort();
		const result = await validateData(path, { signal: controller.signal });
		ok(isDataRefusal(result));
		strictEqual(result.reason, "aborted");
	});
});
