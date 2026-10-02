import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { createBpeCounter } from "../../src/domains/system-one/julia-tokenizer.js";

// The real file is Julia-1's 34 MB tokenizer, checked against `tokenizers` 0.22.2 by hand;
// this pins the pipeline's mechanics on a vocabulary small enough to reason about.
const count = createBpeCounter({
	added_tokens: [{ content: "\n" }],
	model: {
		type: "BPE",
		vocab: { "▁": 0, a: 1, b: 2, c: 3, "▁a": 4, ab: 5, "▁ab": 6, "\n": 7, "<0xC3>": 8, "<0xA9>": 9 },
		merges: [
			["a", "b"],
			["▁", "a"],
			["▁", "ab"],
		],
	},
});

it("merges by rank, splits before each word marker, and counts added tokens alone", () => {
	strictEqual(count("ab"), 1);
	strictEqual(count("ab c"), 3);
	strictEqual(count("a\nb"), 4);
	strictEqual(count(" ab"), 1);
});

it("falls back to bytes for characters outside the vocabulary and counts nothing for empty text", () => {
	strictEqual(count("é"), 3);
	strictEqual(count(""), 0);
});
