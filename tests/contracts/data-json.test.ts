import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	inspectData,
	isDataRefusal,
	type JsonInspectResult,
	type JsonSelectResult,
	type JsonValidateResult,
	selectData,
	validateData,
} from "../../src/tools/data/index.js";
import {
	JSON_MAX_DEPTH,
	type JsonEventSink,
	type JsonScalarEvent,
	JsonStreamParser,
	parseJsonPointer,
	scanJsonText,
} from "../../src/tools/data/json.js";
import { DataRefusalError } from "../../src/tools/data/shared.js";

/** Replay a document through the parser as a flat event log. */
function events(text: string, chunk: number | null): string[] {
	const log: string[] = [];
	const sink: JsonEventSink = {
		onStartObject: (depth) => {
			log.push(`{${depth}`);
			return undefined;
		},
		onKey: (key, depth) => {
			log.push(`k${depth}:${key}`);
			return undefined;
		},
		onEndObject: (depth, count) => {
			log.push(`}${depth}:${count}`);
			return undefined;
		},
		onStartArray: (depth) => {
			log.push(`[${depth}`);
			return undefined;
		},
		onEndArray: (depth, length) => {
			log.push(`]${depth}:${length}`);
			return undefined;
		},
		onScalar: (scalar: JsonScalarEvent, depth) => {
			log.push(`${depth}:${scalar.type}=${scalar.type === "number" ? scalar.literal : JSON.stringify(scalar.value)}`);
			return undefined;
		},
		captureStrings: () => true,
	};
	const parser = new JsonStreamParser(sink);
	if (chunk === null) parser.push(text, 0);
	else {
		let offset = 0;
		for (let index = 0; index < text.length; index += chunk) {
			const piece = text.slice(index, index + chunk);
			parser.push(piece, offset);
			offset += Buffer.byteLength(piece, "utf8");
		}
	}
	parser.end();
	return log;
}

describe("contracts/data-json", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-coder-data-json-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function file(name: string, content: string | Buffer): string {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	}

	async function inspect(path: string, options: Parameters<typeof inspectData>[1] = {}): Promise<JsonInspectResult> {
		const result = await inspectData(path, options);
		ok(!isDataRefusal(result), `inspect refused: ${JSON.stringify(result)}`);
		ok(result.format === "json");
		return result;
	}

	async function select(path: string, options: Parameters<typeof selectData>[1] = {}): Promise<JsonSelectResult> {
		const result = await selectData(path, options);
		ok(!isDataRefusal(result), `select refused: ${JSON.stringify(result)}`);
		ok(result.format === "json");
		return result;
	}

	async function validate(path: string, options: Parameters<typeof validateData>[1] = {}): Promise<JsonValidateResult> {
		const result = await validateData(path, options);
		ok(!isDataRefusal(result), `validate refused: ${JSON.stringify(result)}`);
		ok(result.format === "json");
		return result;
	}

	describe("stream parser", () => {
		const document = ` {"name":"caf\\u00e9 \\"q\\"","n":[1,-2.5e3,0,true,null,false],"nested":{"deep":{"x":[[]]}},"t":"tab\\tline\\n","e":"\\ud83d\\ude00"} `;

		it("emits the same events whether pushed whole or one character at a time", () => {
			const whole = events(document, null);
			deepStrictEqual(events(document, 1), whole);
			deepStrictEqual(events(document, 3), whole);
			deepStrictEqual(events(document, 7), whole);
			ok(whole.includes('1:string="café \\"q\\""'));
			ok(whole.includes("2:number=-2.5e3"));
			ok(whole.includes('1:string="😀"'));
			ok(whole.includes("]1:6"));
			ok(whole.includes("}0:5"));
		});

		it("rejects every syntax fault with line, column, and byte offset", () => {
			const faults: Array<[string, RegExp]> = [
				["", /no JSON value/u],
				["{", /unexpected end of input/u],
				['{"a" 1}', /expected ':'/u],
				['{"a":1,}', /expected a string key/u],
				["[1,]", /expected a JSON value/u],
				["[1 2]", /expected ',' or '\]'/u],
				['{"a":1} x', /unexpected content after/u],
				["01", /invalid number literal/u],
				["1.", /invalid number literal/u],
				["tru", /unexpected literal/u],
				["nul", /unexpected literal/u],
				['"abc', /unterminated string/u],
				['"a\nb"', /unescaped control character/u],
				['"\\x"', /invalid escape/u],
				['"\\u12"', /invalid \\u escape|unterminated/u],
				["{'a':1}", /expected a string key/u],
				["['a']", /unexpected character "'"/u],
			];
			for (const [text, expected] of faults) {
				throws(
					() => scanJsonText(text),
					(error: unknown) => {
						ok(error instanceof DataRefusalError, `${JSON.stringify(text)} must throw a refusal`);
						strictEqual(error.refusal.reason, "invalid-json", text);
						match(error.refusal.message, expected, text);
						ok(typeof error.refusal.byteOffset === "number");
						ok(typeof error.refusal.line === "number");
						return true;
					},
				);
			}
		});

		it("locates a fault on a later line and past a multibyte prefix", () => {
			throws(
				() => scanJsonText('{\n  "k": "é",\n  "bad": tru\n}'),
				(error: unknown) => {
					ok(error instanceof DataRefusalError);
					strictEqual(error.refusal.line, 3);
					strictEqual(error.refusal.byteOffset, Buffer.byteLength('{\n  "k": "é",\n  "bad": tru'));
					return true;
				},
			);
		});

		it("points a control-character fault at the character, not at the start of the string run", () => {
			for (const [text, offset] of [
				['"abc\nd"', 4],
				['["ab", "cd\te"]', 10],
				['{"k": "v", "long key here": "x\u0001"}', 30],
			] as Array<[string, number]>) {
				throws(
					() => scanJsonText(text),
					(error: unknown) => {
						ok(error instanceof DataRefusalError);
						match(error.refusal.message, /unescaped control character/u, text);
						strictEqual(error.refusal.byteOffset, offset, text);
						strictEqual(error.refusal.line, 1, text);
						strictEqual(error.refusal.column, offset + 1, text);
						return true;
					},
				);
			}
		});

		it("refuses nesting past the depth cap", () => {
			const deep = `${"[".repeat(JSON_MAX_DEPTH + 1)}${"]".repeat(JSON_MAX_DEPTH + 1)}`;
			throws(
				() => scanJsonText(deep),
				(error: unknown) => {
					ok(error instanceof DataRefusalError);
					strictEqual(error.refusal.reason, "nesting-too-deep");
					return true;
				},
			);
			strictEqual(scanJsonText(`${"[".repeat(JSON_MAX_DEPTH)}${"]".repeat(JSON_MAX_DEPTH)}`).maxDepth, JSON_MAX_DEPTH - 1);
		});

		it("parses RFC 6901 pointers with escapes", () => {
			deepStrictEqual(parseJsonPointer(""), []);
			deepStrictEqual(parseJsonPointer("/a/0/b~1c/~0d"), ["a", "0", "b/c", "~d"]);
			ok(parseJsonPointer("a/b") instanceof Error);
		});
	});

	describe("inspect", () => {
		it("describes a root array exactly: element types, sample, depth, and precision", async () => {
			const path = file(
				"rows.json",
				JSON.stringify([
					{ id: 1, name: "a", tags: ["x"], nested: { k: [1, 2] } },
					{ id: 2, name: "b", tags: [], nested: null },
					"loose",
					42,
					null,
				]),
			);
			const result = await inspect(path);
			deepStrictEqual(result.view, { exact: true, sampled: false, converted: false });
			strictEqual(result.root, "array");
			strictEqual(result.rowCount, 5);
			strictEqual(result.rowsScanned, 5);
			deepStrictEqual(result.elementTypes, { object: 2, string: 1, number: 1, null: 1 });
			strictEqual(result.maxDepth, 3);
			deepStrictEqual(result.sample, [
				{ id: 1, name: "a", tags: ["x"], nested: { k: [1, 2] } },
				{ id: 2, name: "b", tags: [], nested: null },
				"loose",
				42,
				null,
			]);
			strictEqual(result.precision.count, 0);
			strictEqual(result.duplicateKeys.count, 0);
			strictEqual(result.keys, undefined);
		});

		it("describes a root object with its ordered keys and member types", async () => {
			const path = file("doc.json", '{"z": 1, "a": "text", "m": {"x": true}, "list": [1, 2, 3]}');
			const result = await inspect(path, { sampleRows: 2 });
			strictEqual(result.root, "object");
			deepStrictEqual(result.keys, { names: ["z", "a", "m", "list"], truncated: false });
			deepStrictEqual(result.memberTypes, { number: 1, string: 1, object: 1, array: 1 });
			strictEqual(result.rowCount, 4);
			deepStrictEqual(result.sample, [
				{ key: "z", value: 1 },
				{ key: "a", value: "text" },
			]);
		});

		it("keeps precision facts: unsafe integers, excess digits, overflow, and underflow", async () => {
			const path = file(
				"precision.json",
				'{"safe": 9007199254740991, "unsafe": 9007199254740993, "huge": 18446744073709551615, "digits": 0.1000000000000000055511151231257827, "over": 1e400, "under": 1e-400, "exp": 1.5e3, "inexact": 1.0000000000000001, "unsafeFloat": 9007199254740993.0, "big": 1e21, "sum": 0.30000000000000004, "tenth": 0.1, "zero": -0.0}',
			);
			const result = await inspect(path, { sampleRows: 20 });
			strictEqual(result.precision.count, 7);
			deepStrictEqual(
				result.precision.first.map((issue) => [issue.path, issue.kind, issue.literal]),
				[
					["/unsafe", "unsafe-integer", "9007199254740993"],
					["/huge", "unsafe-integer", "18446744073709551615"],
					["/digits", "excess-digits", "0.1000000000000000055511151231257827"],
					["/over", "overflow", "1e400"],
					["/under", "underflow", "1e-400"],
					["/inexact", "inexact", "1.0000000000000001"],
					["/unsafeFloat", "unsafe-integer", "9007199254740993.0"],
				],
			);
			deepStrictEqual(result.sample, [
				{ key: "safe", value: 9007199254740991 },
				{ key: "unsafe", value: { $literal: "9007199254740993", precision: "unsafe-integer" } },
				{ key: "huge", value: { $literal: "18446744073709551615", precision: "unsafe-integer" } },
				{ key: "digits", value: { $literal: "0.1000000000000000055511151231257827", precision: "excess-digits" } },
				{ key: "over", value: { $literal: "1e400", precision: "overflow" } },
				{ key: "under", value: { $literal: "1e-400", precision: "underflow" } },
				{ key: "exp", value: 1500 },
				{ key: "inexact", value: { $literal: "1.0000000000000001", precision: "inexact" } },
				{ key: "unsafeFloat", value: { $literal: "9007199254740993.0", precision: "unsafe-integer" } },
				{ key: "big", value: 1e21 },
				{ key: "sum", value: 0.30000000000000004 },
				{ key: "tenth", value: 0.1 },
				{ key: "zero", value: -0 },
			]);
		});

		it("counts duplicate keys at any depth and names the first", async () => {
			const path = file("dup.json", '{"a": 1, "b": {"c": 1, "c": 2, "d": [{"e": 1, "e": 2}]}, "a": 3}');
			const result = await inspect(path);
			strictEqual(result.duplicateKeys.count, 3);
			deepStrictEqual(result.duplicateKeys.first, { path: "/b", key: "c" });
			strictEqual(result.duplicateKeys.checkedFully, true);
		});

		it("stops at maxRows with a sampled view and an unknown length", async () => {
			const path = file("many.json", JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ index }))));
			const result = await inspect(path, { maxRows: 15, sampleRows: 2 });
			deepStrictEqual(result.view, { exact: false, sampled: true, converted: false });
			strictEqual(result.rowCount, null);
			strictEqual(result.rowsScanned, 15);
			deepStrictEqual(result.elementTypes, { object: 15 });
			deepStrictEqual(result.sample, [{ index: 0 }, { index: 1 }]);
			ok(result.notes.some((note) => note.startsWith("sampled: 15 elements scanned of an unknown total")));
			ok(result.bytesScanned <= result.bytes);
		});

		it("reports a scalar root, a BOM, and an over-budget sample element as a summary", async () => {
			const scalar = await inspect(file("scalar.json", "﻿18446744073709551615"));
			strictEqual(scalar.root, "number");
			deepStrictEqual(scalar.value, { $literal: "18446744073709551615", precision: "unsafe-integer" });
			strictEqual(scalar.rowCount, 1);
			ok(scalar.notes.some((note) => note.includes("byte-order mark")));
			const big = file("big-element.json", JSON.stringify([{ blob: "x".repeat(20_000), n: 1 }, { small: true }]));
			const result = await inspect(big);
			deepStrictEqual(result.sample[0], { $summary: { type: "object", members: 2, reason: "budget" } });
			deepStrictEqual(result.sample[1], { small: true });
			strictEqual(result.view.exact, true, "a cut sample is a preview; the counts stay exact");
			ok(result.notes.some((note) => note.includes("sample value(s) were cut")));
		});
	});

	describe("select", () => {
		// Written by hand: JSON.stringify would already round 9007199254740993.
		const text =
			'{"meta": {"a/b": {"~x": "escaped"}, "count": 3}, "items": [{"id": 0, "v": 10}, {"id": 1, "v": 9007199254740993}, {"id": 2, "v": 30}, {"id": 3, "v": 40}]}';
		const document = JSON.parse(text) as { meta: unknown };

		it("returns the value at a pointer, with escapes, and the whole document at the empty pointer", async () => {
			const path = file("doc.json", text);
			const nested = await select(path, { pointer: "/meta/a~1b/~0x" });
			strictEqual(nested.value, "escaped");
			deepStrictEqual(nested.view, { exact: true, sampled: false, converted: false });
			const element = await select(path, { pointer: "/items/1" });
			deepStrictEqual(element.value, { id: 1, v: { $literal: "9007199254740993", precision: "unsafe-integer" } });
			strictEqual(element.precision.count, 1);
			strictEqual(element.precision.first[0]?.path, "/items/1/v");
			const whole = await select(path, { pointer: "" });
			deepStrictEqual((whole.value as { meta: unknown }).meta, document.meta);
			ok(whole.bytesScanned <= whole.bytes);
		});

		it("windows an array target with offset, limit, and hasMore, and stops reading early", async () => {
			const path = file("doc.json", text);
			const window = await select(path, { pointer: "/items", offset: 1, limit: 2 });
			deepStrictEqual(window.elements, [
				{ id: 1, v: { $literal: "9007199254740993", precision: "unsafe-integer" } },
				{ id: 2, v: 30 },
			]);
			strictEqual(window.offset, 1);
			strictEqual(window.returned, 2);
			strictEqual(window.hasMore, true);
			const tail = await select(path, { pointer: "/items", offset: 3, limit: 5 });
			deepStrictEqual(tail.elements, [{ id: 3, v: 40 }]);
			strictEqual(tail.hasMore, false);
			const notArray = await selectData(path, { pointer: "/meta", offset: 0 });
			ok(isDataRefusal(notArray));
			strictEqual(notArray.reason, "invalid-argument");
		});

		it("marks a string cut at the capture cap with a placeholder and an inexact view", async () => {
			const long = "s".repeat(70_000);
			const path = file("long-string.json", JSON.stringify({ short: "ok", long, after: 1 }));
			const cut = await select(path, { pointer: "" });
			deepStrictEqual(cut.value, {
				short: "ok",
				long: { $truncated: "string", length: 70_000, text: "s".repeat(65_536) },
				after: 1,
			});
			deepStrictEqual(cut.view, { exact: false, sampled: false, converted: false });
			ok(cut.notes.some((note) => note.includes("$truncated")));
			const direct = await select(path, { pointer: "/long" });
			deepStrictEqual(direct.value, { $truncated: "string", length: 70_000, text: "s".repeat(65_536) });
			strictEqual(direct.view.exact, false);
			const intact = await select(path, { pointer: "/short" });
			strictEqual(intact.value, "ok");
			strictEqual(intact.view.exact, true);
			const inspected = await inspect(path);
			deepStrictEqual(inspected.sample[1], {
				key: "long",
				value: { $truncated: "string", length: 70_000, text: "s".repeat(65_536) },
			});
			deepStrictEqual(inspected.view, { exact: true, sampled: false, converted: false });
			ok(inspected.notes.some((note) => note.includes("sample value(s) were cut")));
		});

		it("reports duplicate keys inside the selection instead of keeping the last value silently", async () => {
			const path = file(
				"dup-select.json",
				'{"a": {"k": 1, "k": 2, "n": {"z": 1, "z": 2}}, "b": [{"q": 1, "q": 2}], "c": 3}',
			);
			const whole = await select(path, { pointer: "" });
			deepStrictEqual(whole.duplicateKeys, { count: 3, first: { path: "/a", key: "k" }, checkedFully: true });
			deepStrictEqual((whole.value as { a: unknown }).a, { k: 2, n: { z: 2 } });
			ok(whole.notes.some((note) => note.includes("duplicate object key")));
			const nested = await select(path, { pointer: "/a/n" });
			deepStrictEqual(nested.duplicateKeys, { count: 1, first: { path: "/a/n", key: "z" }, checkedFully: true });
			const window = await select(path, { pointer: "/b", offset: 0, limit: 5 });
			deepStrictEqual(window.duplicateKeys, { count: 1, first: { path: "/b/0", key: "q" }, checkedFully: true });
			const clean = await select(path, { pointer: "/c" });
			deepStrictEqual(clean.duplicateKeys, { count: 0, first: null, checkedFully: true });
		});

		it("refuses a missing pointer naming the deepest existing prefix, and an oversized selection", async () => {
			const path = file("doc.json", text);
			const missing = await selectData(path, { pointer: "/items/9/id" });
			ok(isDataRefusal(missing));
			strictEqual(missing.reason, "pointer-not-found");
			match(missing.message, /deepest existing prefix is \/items/u);
			const badPointer = await selectData(path, { pointer: "items" });
			ok(isDataRefusal(badPointer));
			strictEqual(badPointer.reason, "invalid-argument");
			const huge = file("huge.json", JSON.stringify({ blob: "y".repeat(1_100_000), ok: 1 }));
			const tooLarge = await selectData(huge, { pointer: "" });
			ok(isDataRefusal(tooLarge));
			strictEqual(tooLarge.reason, "selection-too-large");
			match(tooLarge.message, /array window with offset and limit/u);
			const hugeElement = file("huge-element.json", JSON.stringify([{ blob: "z".repeat(1_100_000) }, { ok: 1 }]));
			const windowedTooLarge = await selectData(hugeElement, { pointer: "", offset: 0, limit: 2 });
			ok(isDataRefusal(windowedTooLarge));
			strictEqual(windowedTooLarge.reason, "selection-too-large");
			match(windowedTooLarge.message, /an element of the array/u);
			ok(!/array window with offset and limit/u.test(windowedTooLarge.message));
			const stillFine = await select(huge, { pointer: "/ok" });
			strictEqual(stillFine.value, 1);
		});
	});

	describe("validate", () => {
		it("passes a well-formed document and reports a syntax fault with its location", async () => {
			const good = await validate(file("good.json", '[{"a": 1}, {"a": 2}]'));
			strictEqual(good.valid, true);
			strictEqual(good.complete, true);
			strictEqual(good.rowCount, 2);
			strictEqual(good.root, "array");
			const bad = await validate(file("bad.json", '[{"a": 1}, {"a": }]'));
			strictEqual(bad.valid, false);
			strictEqual(bad.rowCount, null);
			match(bad.syntaxError?.message ?? "", /expected a JSON value at line 1 column 18/u);
			strictEqual(bad.syntaxError?.byteOffset, 17);
			const empty = await validate(file("empty.json", ""));
			strictEqual(empty.valid, false);
			match(empty.syntaxError?.message ?? "", /no JSON value/u);
		});

		it("returns a null verdict when the scan stopped before the end, and flags duplicates", async () => {
			const path = file("many.json", JSON.stringify(Array.from({ length: 30 }, (_, index) => ({ index }))));
			const partial = await validate(path, { maxRows: 10 });
			strictEqual(partial.valid, null);
			strictEqual(partial.complete, false);
			strictEqual(partial.rowsScanned, 10);
			ok(partial.notes.some((note) => note.startsWith("validation incomplete")));
			const whole = await validate(path, { maxRows: null });
			strictEqual(whole.valid, true);
			strictEqual(whole.rowCount, 30);
			const dup = await validate(file("dup.json", '{"a": 1, "a": 2}'));
			strictEqual(dup.valid, true, "duplicate keys are legal JSON; they are reported, not failed");
			strictEqual(dup.duplicateKeys.count, 1);
		});
	});

	describe("refusals", () => {
		it("refuses invalid UTF-8, binary bytes, and an empty document through inspect", async () => {
			const latin = await inspectData(
				file("latin.json", Buffer.concat([Buffer.from('{"k": "caf'), Buffer.from([0xe9]), Buffer.from('"}')])),
			);
			ok(isDataRefusal(latin));
			strictEqual(latin.reason, "invalid-utf8");
			strictEqual(latin.byteOffset, 10);
			const binary = await inspectData(file("blob.json", Buffer.from([0x7b, 0x00, 0x7d])));
			ok(isDataRefusal(binary));
			strictEqual(binary.reason, "binary");
			const empty = await inspectData(file("empty.json", "   \n"));
			ok(isDataRefusal(empty));
			strictEqual(empty.reason, "invalid-json");
			match(empty.message, /no JSON value/u);
		});

		it("refuses a syntax fault at its location through inspect and a select that must read past it", async () => {
			const path = file("broken.json", '{"a": [1, 2,\n 3, }');
			const result = await inspectData(path);
			ok(isDataRefusal(result));
			strictEqual(result.reason, "invalid-json");
			strictEqual(result.line, 2);
			strictEqual(result.column, 5);
			const past = await selectData(path, { pointer: "/b" });
			ok(isDataRefusal(past), "a selection that reads through the fault reports it");
			strictEqual(past.reason, "invalid-json");
			const before = await selectData(path, { pointer: "/a/0" });
			ok(!isDataRefusal(before), "a selection satisfied before the fault returns and says the rest was not checked");
			ok(before.format === "json");
			strictEqual(before.value, 1);
			ok(before.notes.some((note) => note.includes("not checked for syntax")));
		});
	});
});
