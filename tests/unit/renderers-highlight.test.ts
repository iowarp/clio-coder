import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { highlightCode } from "../../src/interactive/renderers/highlight.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

describe("renderers/highlight", () => {
	it("colors common language tokens while preserving stripped source", () => {
		const line = highlightCode('const answer = "yes"; // note', "ts")[0] ?? "";
		ok(line.includes(String.fromCharCode(27)), line);
		ok(stripAnsi(line).includes('const answer = "yes"; // note'), stripAnsi(line));
	});

	it("delegates json fences to the structured renderer", () => {
		const lines = highlightCode('{"a":1,"b":true}', "json").map(stripAnsi);
		ok(
			lines.some((line) => line.includes('"a": 1')),
			lines.join("\n"),
		);
		ok(lines.length > 1, lines.join("\n"));
	});
});
