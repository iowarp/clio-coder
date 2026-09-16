import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import {
	CSV_MAX_FIELD_CHARS,
	CSV_MAX_RECORD_CHARS,
	CsvParser,
	detectCsvDelimiter,
	headerLooksLikeNames,
} from "../../src/tools/data/csv.js";
import {
	type CsvInspectResult,
	type CsvSelectResult,
	type CsvValidateResult,
	detectDataFormat,
	inspectData,
	isDataRefusal,
	selectData,
	validateData,
} from "../../src/tools/data/index.js";

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

function parseAll(text: string, delimiter = ","): { records: string[][]; issues: string[]; blank: number } {
	const records: string[][] = [];
	const issues: string[] = [];
	const parser = new CsvParser(delimiter.charCodeAt(0), {
		onRecord(fields) {
			records.push(fields);
			return true;
		},
		onIssue(issue) {
			issues.push(`${issue.kind}@${issue.record}:${issue.line}`);
		},
	});
	parser.push(text);
	parser.end();
	return { records, issues, blank: parser.blankLines };
}

describe("contracts/data-csv", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-coder-data-csv-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function file(name: string, content: string | Buffer): string {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	}

	async function inspect(path: string, options: Parameters<typeof inspectData>[1] = {}): Promise<CsvInspectResult> {
		const result = await inspectData(path, options);
		ok(!isDataRefusal(result), `inspect refused: ${JSON.stringify(result)}`);
		ok(result.format === "csv" || result.format === "tsv");
		return result;
	}

	async function select(path: string, options: Parameters<typeof selectData>[1] = {}): Promise<CsvSelectResult> {
		const result = await selectData(path, options);
		ok(!isDataRefusal(result), `select refused: ${JSON.stringify(result)}`);
		ok(result.format === "csv" || result.format === "tsv");
		return result;
	}

	async function validate(path: string, options: Parameters<typeof validateData>[1] = {}): Promise<CsvValidateResult> {
		const result = await validateData(path, options);
		ok(!isDataRefusal(result), `validate refused: ${JSON.stringify(result)}`);
		ok(result.format === "csv" || result.format === "tsv");
		return result;
	}

	describe("parser", () => {
		it("handles quoted delimiters, doubled quotes, embedded line breaks, and CRLF", () => {
			const text = 'a,b,c\r\n"x, y","he said ""hi""","line1\r\nline2"\r\n1,2,3\r\n';
			const { records, issues, blank } = parseAll(text);
			deepStrictEqual(records, [
				["a", "b", "c"],
				["x, y", 'he said "hi"', "line1\r\nline2"],
				["1", "2", "3"],
			]);
			deepStrictEqual(issues, []);
			strictEqual(blank, 0);
		});

		it("keeps empty trailing fields, counts blank lines, and reads a final record without a terminator", () => {
			const { records, blank } = parseAll("a,b,\n\n,\nlast,row");
			deepStrictEqual(records, [
				["a", "b", ""],
				["", ""],
				["last", "row"],
			]);
			strictEqual(blank, 1);
		});

		it("survives a chunk boundary inside a field, a quoted field, and a CRLF pair", () => {
			const text = 'id,text\r\n1,"multi\r\nline"\r\n2,plain value\r\n';
			const whole = parseAll(text).records;
			for (let split = 1; split < text.length; split += 1) {
				const records: string[][] = [];
				const parser = new CsvParser(0x2c, {
					onRecord(fields) {
						records.push(fields);
						return true;
					},
					onIssue() {},
				});
				parser.push(text.slice(0, split));
				parser.push(text.slice(split));
				parser.end();
				deepStrictEqual(records, whole, `split at ${split}`);
			}
		});

		it("recovers from quoting faults and names the record", () => {
			const { records, issues } = parseAll('a,b\n"x"y,2\nna"ive,3\n"open,4');
			deepStrictEqual(records, [["a", "b"], ["xy", "2"], ['na"ive', "3"], ["open,4"]]);
			deepStrictEqual(issues, ["text-after-quote@2:2", "bare-quote@3:3", "unterminated-quote@4:4"]);
		});

		it("cuts a field at the field cap and closes the record at the next line break", () => {
			const runaway = `a,b\n1,"oops${"x".repeat(CSV_MAX_FIELD_CHARS + 100)}\n2,fine\n3,also fine\n`;
			const { records, issues } = parseAll(runaway);
			strictEqual(records.length, 4);
			deepStrictEqual(records[0], ["a", "b"]);
			strictEqual(records[1]?.length, 2);
			strictEqual(records[1]?.[1]?.length, CSV_MAX_FIELD_CHARS);
			ok(records[1]?.[1]?.startsWith("oopsxxxx"));
			deepStrictEqual(records[2], ["2", "fine"]);
			deepStrictEqual(records[3], ["3", "also fine"]);
			deepStrictEqual(issues, ["field-too-large@2:2"]);
			// The same cap holds for an unquoted run and across chunk boundaries.
			const unquoted = `h\n${"y".repeat(CSV_MAX_FIELD_CHARS + 5)}\nnext\n`;
			const parser = new CsvParser(0x2c, {
				onRecord(fields) {
					chunked.push(fields.map((field) => field.length));
					return true;
				},
				onIssue(issue) {
					chunkedIssues.push(issue.kind);
				},
			});
			const chunked: number[][] = [];
			const chunkedIssues: string[] = [];
			for (let at = 0; at < unquoted.length; at += 65_536) parser.push(unquoted.slice(at, at + 65_536));
			parser.end();
			deepStrictEqual(chunked, [[1], [CSV_MAX_FIELD_CHARS], [4]]);
			deepStrictEqual(chunkedIssues, ["field-too-large"]);
		});

		it("cuts a record at the record cap and closes it at the next line break", () => {
			// Seventeen fields at the field cap overrun the record cap inside the sixteenth.
			const wide = Array.from({ length: 17 }, () => "f".repeat(CSV_MAX_FIELD_CHARS)).join(",");
			const { records, issues } = parseAll(`${wide}\nz\n`);
			strictEqual(records.length, 2);
			strictEqual(records[0]?.length, 16);
			strictEqual(records[0]?.[15]?.length, CSV_MAX_RECORD_CHARS - 15 * (CSV_MAX_FIELD_CHARS + 1));
			deepStrictEqual(records[1], ["z"]);
			deepStrictEqual(issues, ["record-too-large@1:1"]);
		});

		it("holds no more than the field cap while a runaway quote streams through", () => {
			// 64 MB of rows behind an unterminated quote, pushed in 64 KiB chunks.
			// Every 4 MB the heap is collected and measured: with the cap the
			// parser holds at most one capped field, without it the field grows
			// with the input and the check fails at the fourth checkpoint.
			const row = `12345,name-12345,${"n".repeat(40)}\n`;
			const chunk = row.repeat(Math.ceil(65_536 / row.length));
			const chunksTotal = Math.ceil((64 * 1024 * 1024) / chunk.length);
			let records = 0;
			const issues: string[] = [];
			const parser = new CsvParser(0x2c, {
				onRecord() {
					records += 1;
					return true;
				},
				onIssue(issue) {
					issues.push(issue.kind);
				},
			});
			const baseline = retainedMemory();
			let worst = 0;
			parser.push('id,name,note\n1,"oops,first\n');
			for (let index = 1; index <= chunksTotal; index += 1) {
				parser.push(chunk);
				if (index % 64 === 0) worst = Math.max(worst, retainedMemory() - baseline);
			}
			parser.end();
			ok(worst < 16 * 1024 * 1024, `retained ${Math.round(worst / 1024 / 1024)} MB at a checkpoint`);
			deepStrictEqual(issues, ["field-too-large"]);
			ok(records > chunksTotal * 1000, `rows after the recovery point parse: ${records}`);
		});

		it("detects the delimiter by field-count consistency and treats an unsplit sample as one column", () => {
			strictEqual(detectCsvDelimiter("a;b;c\n1;2;3\n4;5;6\n", true).delimiter, ";");
			strictEqual(detectCsvDelimiter("a\tb\n1\t2\n", true).delimiter, "\t");
			strictEqual(detectCsvDelimiter('a,b\n"1,5",2\n"3,5",4\n', true).delimiter, ",");
			const single = detectCsvDelimiter("just one column\nanother line\n", true);
			strictEqual(single.delimiter, ",");
			strictEqual(single.confidence, 0);
		});

		it("recognizes a header row only when every cell is non-numeric text", () => {
			strictEqual(headerLooksLikeNames(["id", "name", "value"]), true);
			strictEqual(headerLooksLikeNames(["1", "name"]), false);
			strictEqual(headerLooksLikeNames(["", "name"]), false);
			strictEqual(headerLooksLikeNames(["2024-01-01", "x"]), false);
		});
	});

	describe("inspect", () => {
		it("reports an exact view with typed columns, sentinels counted and never converted", async () => {
			const path = file(
				"measurements.csv",
				[
					"id,temperature,valid,taken,note",
					"1,20.5,true,2024-01-02,ok",
					"2,NA,false,2024-01-03,",
					"3,-3.25e1,true,2024-01-04,cold",
					"4,,true,2024-01-05,N/A",
					"",
				].join("\n"),
			);
			const result = await inspect(path);
			deepStrictEqual(result.view, { exact: true, sampled: false, converted: false });
			strictEqual(result.rowCount, 4);
			strictEqual(result.rowsScanned, 4);
			deepStrictEqual(result.header, ["id", "temperature", "valid", "taken", "note"]);
			strictEqual(result.headerSource, "detected");
			strictEqual(result.delimiter, ",");
			strictEqual(result.delimiterSource, "detected");
			strictEqual(result.lineEnding, "lf");
			strictEqual(result.fieldCount, 5);
			const [id, temperature, valid, taken, note] = result.columns;
			strictEqual(id?.inferredType, "integer");
			deepStrictEqual(id?.numericRange, { min: "1", max: "4", approximate: false });
			strictEqual(temperature?.inferredType, "float");
			strictEqual(temperature?.nonEmpty, 3);
			strictEqual(temperature?.empty, 1);
			deepStrictEqual(temperature?.sentinels, { NA: 1 });
			deepStrictEqual(temperature?.numericRange, { min: "-3.25e1", max: "20.5", approximate: false });
			deepStrictEqual(temperature?.sampleValues, ["20.5", "-3.25e1"]);
			strictEqual(valid?.inferredType, "boolean");
			strictEqual(taken?.inferredType, "date");
			strictEqual(note?.inferredType, "string");
			deepStrictEqual(note?.sentinels, { "N/A": 1 });
			strictEqual(note?.empty, 1);
			deepStrictEqual(result.sample[1], ["2", "NA", "false", "2024-01-03", ""]);
			strictEqual(result.raggedRows.count, 0);
			strictEqual(result.quotingIssues.count, 0);
			strictEqual(result.bytesScanned, result.bytes);
		});

		it("keeps large integers and long float literals as text and counts the precision risk", async () => {
			const path = file(
				"ids.csv",
				[
					"id,ratio",
					"9007199254740993,0.1000000000000000055511151231257827",
					"18446744073709551615,0.5",
					"7,1.0000000000000001",
					"9007199254740993.0,0.30000000000000004",
					"",
				].join("\n"),
			);
			const result = await inspect(path);
			const [id, ratio] = result.columns;
			strictEqual(id?.inferredType, "float", "integers plus one float-formatted cell read as a float column");
			strictEqual(id?.precisionIssues, 3);
			strictEqual(ratio?.inferredType, "float");
			strictEqual(ratio?.precisionIssues, 2);
			strictEqual(ratio?.numericRange?.approximate, true);
			strictEqual(ratio?.numericRange?.min, "0.1000000000000000055511151231257827");
			deepStrictEqual(result.sample[0], ["9007199254740993", "0.1000000000000000055511151231257827"]);
			strictEqual(result.precision.count, 5);
			deepStrictEqual(
				result.precision.first.map((issue) => [issue.row, issue.column, issue.kind, issue.literal]),
				[
					[1, 0, "unsafe-integer", "9007199254740993"],
					[1, 1, "excess-digits", "0.1000000000000000055511151231257827"],
					[2, 0, "unsafe-integer", "18446744073709551615"],
					[3, 1, "inexact", "1.0000000000000001"],
					[4, 0, "unsafe-integer", "9007199254740993.0"],
				],
			);
			ok(result.notes.some((note) => note.includes("would lose precision")));
		});

		it("strips a byte-order mark, reads CRLF, and reports ragged rows by row and line", async () => {
			const path = file("ragged.csv", `﻿a,b,c\r\n1,2,3\r\n4,5\r\n6,7,8,9\r\n"multi\r\nline",x,y\r\n`);
			const result = await inspect(path);
			strictEqual(result.bom, true);
			deepStrictEqual(result.header, ["a", "b", "c"]);
			strictEqual(result.lineEnding, "crlf");
			strictEqual(result.rowCount, 4);
			strictEqual(result.raggedRows.count, 2);
			deepStrictEqual(result.raggedRows.first, [
				{ row: 2, line: 3, fields: 2 },
				{ row: 3, line: 4, fields: 4 },
			]);
			strictEqual(result.columns.length, 4);
			strictEqual(result.columns[3]?.name, "column_4");
			strictEqual(result.columns[3]?.nonEmpty, 1);
			deepStrictEqual(result.sample[3], ["multi\r\nline", "x", "y"]);
			ok(result.notes.some((note) => note.includes("byte-order mark")));
		});

		it("honors explicit header and delimiter choices and the tsv extension", async () => {
			const semicolon = file("semi.csv", "x;y\n1;2\n3;4\n");
			const auto = await inspect(semicolon);
			strictEqual(auto.delimiter, ";");
			deepStrictEqual(auto.header, ["x", "y"]);
			const noHeader = await inspect(semicolon, { header: false, delimiter: ";" });
			strictEqual(noHeader.header, null);
			strictEqual(noHeader.headerSource, "none");
			strictEqual(noHeader.rowCount, 3);
			strictEqual(noHeader.columns[0]?.name, "column_1");
			strictEqual(noHeader.columns[0]?.inferredType, "mixed");
			const forcedHeader = file("numbers.csv", "1,2\n3,4\n");
			const explicit = await inspect(forcedHeader, { header: true });
			deepStrictEqual(explicit.header, ["1", "2"]);
			strictEqual(explicit.headerSource, "explicit");
			strictEqual(explicit.rowCount, 1);
			const tsv = file("tabs.tsv", "a\tb\n1\t2\n");
			const tab = await inspect(tsv);
			strictEqual(tab.format, "tsv");
			strictEqual(tab.delimiter, "\t");
			strictEqual(tab.delimiterSource, "explicit");
			strictEqual((await inspect(tsv, { delimiter: "\\t" })).delimiter, "\t");
		});

		it("marks a scan that stopped at maxRows as sampled with an unknown total", async () => {
			const lines = ["n,sq"];
			for (let n = 1; n <= 50; n += 1) lines.push(`${n},${n * n}`);
			const path = file("sampled.csv", `${lines.join("\n")}\n`);
			const result = await inspect(path, { maxRows: 20, sampleRows: 3 });
			deepStrictEqual(result.view, { exact: false, sampled: true, converted: false });
			strictEqual(result.rowCount, null);
			strictEqual(result.rowsScanned, 20);
			strictEqual(result.sample.length, 3);
			strictEqual(result.columns[0]?.nonEmpty, 20);
			ok(result.notes.some((note) => note.startsWith("sampled: 20 rows scanned of an unknown total")));
			const exact = await inspect(path, { maxRows: 50 });
			strictEqual(exact.rowCount, 50);
			strictEqual(exact.view.exact, true);
		});

		it("reads an empty file, a header-only file, and a lone CR file honestly", async () => {
			const empty = await inspect(file("empty.csv", ""));
			strictEqual(empty.rowCount, 0);
			deepStrictEqual(empty.columns, []);
			strictEqual(empty.header, null);
			strictEqual(empty.lineEnding, "none");
			const headerOnly = await inspect(file("header-only.csv", "id,name\n"));
			strictEqual(headerOnly.header, null, "one record under auto is data, since no second row exists");
			strictEqual(headerOnly.rowCount, 1);
			const explicitHeaderOnly = await inspect(join(dir, "header-only.csv"), { header: true });
			deepStrictEqual(explicitHeaderOnly.header, ["id", "name"]);
			strictEqual(explicitHeaderOnly.rowCount, 0);
			strictEqual(explicitHeaderOnly.columns.length, 2);
			const cr = await inspect(file("cr.csv", "a,b\r1,2\r3,4\r"));
			strictEqual(cr.lineEnding, "cr");
			strictEqual(cr.rowCount, 2);
		});

		it("retains nothing from a stray quote that would otherwise swallow the file", async () => {
			// 64 MB of rows behind an unterminated quote in row 1. The cap cuts the
			// field at 1 MiB and the scan recovers on the next line; afterwards a
			// forced collection shows the scan kept nothing of the file, and the
			// structural facts (cut length, rows parsed, bytes read) pin the cap.
			const path = join(dir, "runaway.csv");
			const fd = openSync(path, "w");
			let rows = 0;
			try {
				writeSync(fd, 'id,name,note\n1,"oops,first\n');
				let bytes = 0;
				while (bytes < 64 * 1024 * 1024) {
					const block: string[] = [];
					for (let index = 0; index < 10_000; index += 1, rows += 1)
						block.push(`${rows + 2},name-${rows},${"n".repeat(40)}`);
					const text = `${block.join("\n")}\n`;
					bytes += text.length;
					writeSync(fd, text);
				}
			} finally {
				closeSync(fd);
			}
			const baseline = retainedMemory();
			const result = await inspect(path, { maxRows: 200_000, sampleRows: 2 });
			const retained = retainedMemory() - baseline;
			ok(retained < 16 * 1024 * 1024, `retained ${Math.round(retained / 1024 / 1024)} MB after the scan`);
			deepStrictEqual(result.header, ["id", "name", "note"]);
			strictEqual(result.quotingIssues.count, 1);
			deepStrictEqual(result.quotingIssues.first[0]?.kind, "field-too-large");
			match(result.quotingIssues.first[0]?.message ?? "", /likely an unterminated quote/u);
			strictEqual(result.columns[1]?.maxLength, CSV_MAX_FIELD_CHARS);
			strictEqual(result.rowsScanned, 200_000, "rows after the fault still parse");
			ok(result.rowsScanned < rows, "the scan stopped at maxRows instead of reading the file");
			strictEqual(result.columns[2]?.maxLength, 40, "rows after the recovery point parse normally");
			ok(result.bytesScanned < result.bytes / 4, `read ${result.bytesScanned} of ${result.bytes} bytes`);
		});

		it("lists quoting issues with their records and keeps parsing", async () => {
			const result = await inspect(file("quotes.csv", 'a,b\n"x"y,2\n"open,4\n'));
			strictEqual(result.quotingIssues.count, 2);
			deepStrictEqual(
				result.quotingIssues.first.map((issue) => issue.kind),
				["text-after-quote", "unterminated-quote"],
			);
			strictEqual(result.rowCount, 2);
		});
	});

	describe("select", () => {
		const content = ["id,name,score", "1,ann,9.5", "2,bob,NA", "3,cid,7", "4,dee,", "5,eve,8"].join("\n");

		it("returns a verbatim window with offset, limit, and hasMore", async () => {
			const path = file("people.csv", content);
			const window = await select(path, { offset: 1, limit: 2 });
			deepStrictEqual(window.header, ["id", "name", "score"]);
			deepStrictEqual(window.rows, [
				["2", "bob", "NA"],
				["3", "cid", "7"],
			]);
			strictEqual(window.returned, 2);
			strictEqual(window.hasMore, true);
			strictEqual(window.rowsScanned, 4, "one row past the window proves hasMore");
			deepStrictEqual(window.view, { exact: true, sampled: false, converted: false });
			const tail = await select(path, { offset: 4, limit: 10 });
			deepStrictEqual(tail.rows, [["5", "eve", "8"]]);
			strictEqual(tail.hasMore, false);
			const beyond = await select(path, { offset: 99 });
			deepStrictEqual(beyond.rows, []);
			strictEqual(beyond.hasMore, false);
		});

		it("projects columns by name or index and refuses an unknown name", async () => {
			const path = file("people.csv", content);
			const byName = await select(path, { columns: ["score", "id"], limit: 2 });
			deepStrictEqual(byName.header, ["score", "id"]);
			deepStrictEqual(byName.columnIndexes, [2, 0]);
			deepStrictEqual(byName.rows, [
				["9.5", "1"],
				["NA", "2"],
			]);
			const byIndex = await select(path, { columns: [1, 7], limit: 1 });
			deepStrictEqual(byIndex.rows, [["ann", null]]);
			const unknown = await selectData(path, { columns: ["nope"] });
			ok(isDataRefusal(unknown));
			strictEqual(unknown.reason, "unknown-column");
			match(unknown.message, /header columns are "id", "name", "score"/u);
			const noHeader = await selectData(path, { header: false, columns: ["id"] });
			ok(isDataRefusal(noHeader));
			strictEqual(noHeader.reason, "unknown-column");
			match(noHeader.message, /no header/u);
		});

		it("clamps the limit and never converts values", async () => {
			const path = file("big.csv", "n\n18446744073709551615\n0.1000000000000000055511151231257827\n");
			const result = await select(path, { limit: 5000 });
			strictEqual(result.limit, 1000);
			deepStrictEqual(result.rows, [["18446744073709551615"], ["0.1000000000000000055511151231257827"]]);
		});
	});

	describe("validate", () => {
		it("passes a well-formed file and fails ragged or badly quoted ones", async () => {
			const clean = await validate(file("clean.csv", "a,b\n1,2\n3,4\n"));
			strictEqual(clean.valid, true);
			strictEqual(clean.complete, true);
			strictEqual(clean.rowCount, 2);
			const ragged = await validate(file("ragged.csv", "a,b\n1,2,3\n"));
			strictEqual(ragged.valid, false);
			deepStrictEqual(ragged.raggedRows.first, [{ row: 1, line: 2, fields: 3 }]);
			const quoted = await validate(file("quoted.csv", 'a,b\n"x,2\n'));
			strictEqual(quoted.valid, false);
			strictEqual(quoted.quotingIssues.first[0]?.kind, "unterminated-quote");
		});

		it("returns a null verdict when the scan stopped before the end", async () => {
			const lines = ["a"];
			for (let n = 0; n < 30; n += 1) lines.push(String(n));
			const partial = await validate(file("partial.csv", lines.join("\n")), { maxRows: 10 });
			strictEqual(partial.valid, null);
			strictEqual(partial.complete, false);
			strictEqual(partial.rowCount, null);
			strictEqual(partial.rowsScanned, 10);
			ok(partial.notes.some((note) => note.startsWith("validation incomplete")));
			const whole = await validate(join(dir, "partial.csv"), { maxRows: null });
			strictEqual(whole.valid, true);
			strictEqual(whole.rowCount, 30);
		});
	});

	describe("refusals", () => {
		it("refuses invalid UTF-8 at its byte offset instead of decoding replacement characters", async () => {
			const path = file("latin1.csv", Buffer.concat([Buffer.from("a,b\n1,caf"), Buffer.from([0xe9]), Buffer.from("\n")]));
			for (const call of [inspectData, selectData, validateData]) {
				const result = await call(path, {});
				ok(isDataRefusal(result));
				strictEqual(result.reason, "invalid-utf8");
				strictEqual(result.byteOffset, 9);
				strictEqual(result.path, path);
			}
		});

		it("refuses a binary file, a missing file, a directory, and an unsupported format", async () => {
			const binary = await inspectData(file("blob.csv", Buffer.from([0x61, 0x2c, 0x00, 0x62])));
			ok(isDataRefusal(binary));
			strictEqual(binary.reason, "binary");
			strictEqual(binary.byteOffset, 2);
			const missing = await inspectData(join(dir, "absent.csv"));
			ok(isDataRefusal(missing));
			strictEqual(missing.reason, "not-found");
			mkdirSync(join(dir, "folder.csv"));
			const folder = await inspectData(join(dir, "folder.csv"));
			ok(isDataRefusal(folder));
			strictEqual(folder.reason, "not-a-file");
			const unsupported = await inspectData(file("notes.txt", "just prose here\nno delimiter\n"));
			ok(isDataRefusal(unsupported));
			strictEqual(unsupported.reason, "unsupported-format");
			deepStrictEqual(unsupported.supported, ["csv", "tsv", "json", "jsonl"]);
			match(unsupported.message, /run_script/u);
			const explicitBad = await inspectData(join(dir, "notes.txt"), { format: "parquet" });
			ok(isDataRefusal(explicitBad));
			strictEqual(explicitBad.reason, "unsupported-format");
			match(explicitBad.message, /"parquet"/u);
		});

		it("refuses an already aborted scan and a bad delimiter argument", async () => {
			const path = file("ok.csv", "a,b\n1,2\n");
			const controller = new AbortController();
			controller.abort();
			const aborted = await inspectData(path, { signal: controller.signal });
			ok(isDataRefusal(aborted));
			strictEqual(aborted.reason, "aborted");
			const badDelimiter = await inspectData(path, { delimiter: ",," });
			ok(isDataRefusal(badDelimiter));
			strictEqual(badDelimiter.reason, "invalid-argument");
		});
	});

	describe("format detection", () => {
		it("prefers the explicit format, then the extension, then a bounded sniff", async () => {
			strictEqual(await detectDataFormat(file("x.csv", "{}"), "json"), "json");
			strictEqual(await detectDataFormat(join(dir, "x.csv")), "csv");
			strictEqual(await detectDataFormat(join(dir, "x.csv"), "yaml"), null);
			strictEqual(await detectDataFormat(file("tabs.txt", "a\tb\n1\t2\n")), "tsv");
			strictEqual(await detectDataFormat(file("commas.txt", "a,b\n1,2\n")), "csv");
			strictEqual(await detectDataFormat(file("doc.txt", '{"a": 1}\n')), "json");
			strictEqual(await detectDataFormat(file("lines.txt", '{"a": 1}\n{"a": 2}\n')), "jsonl");
			strictEqual(await detectDataFormat(file("prose.txt", "hello world\n")), null);
			strictEqual(await detectDataFormat(join(dir, "nowhere.txt")), null);
		});
	});
});
