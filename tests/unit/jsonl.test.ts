import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { serializeJsonLine } from "../../src/cli/modes/jsonl.js";

describe("cli/modes/jsonl", () => {
	it("serializes one LF-framed JSON record without splitting Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\nb\u2028c\u2029d" });

		strictEqual(line.endsWith("\n"), true);
		strictEqual(line.slice(0, -1).includes("\n"), false);
		deepStrictEqual(JSON.parse(line), { text: "a\nb\u2028c\u2029d" });
	});
});
