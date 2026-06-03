import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { renderJson, renderXml, tryRenderJson } from "../../src/interactive/renderers/structured.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

describe("renderers/structured", () => {
	it("pretty-prints JSON with structure-aware color", () => {
		const lines = renderJson('{"name":"clio","count":2}', 80);
		const text = stripAnsi(lines.join("\n"));
		ok(lines.join("\n").includes(String.fromCharCode(27)), lines.join("\n"));
		ok(text.includes('"name": "clio"'), text);
		ok(text.includes('"count": 2'), text);
	});

	it("returns null for non-json strings in the try helper", () => {
		strictEqual(tryRenderJson("not json", 80), null);
	});

	it("collapses JSON past a line limit", () => {
		const lines = renderJson({ a: [1, 2, 3, 4, 5] }, 80, { lineLimit: 3 }).map(stripAnsi);
		ok(lines.at(-1)?.includes("lines hidden"), lines.join("\n"));
	});

	it("formats XML tags onto separate lines", () => {
		const lines = renderXml('<root><child id="1">value</child></root>', 80).map(stripAnsi);
		const text = lines.join("\n");
		ok(text.includes("<root>"), text);
		ok(text.includes('<child id="1">'), text);
	});
});
