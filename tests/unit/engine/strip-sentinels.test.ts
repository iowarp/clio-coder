import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { createSentinelStripper, stripTokenizerSentinels } from "../../../src/engine/strip-tokenizer-sentinels.js";

describe("engine/strip-tokenizer-sentinels", () => {
	describe("stripTokenizerSentinels (one-shot)", () => {
		it("removes a single sentinel in the middle of text", () => {
			strictEqual(stripTokenizerSentinels("Hello<|endoftext|>world"), "Helloworld");
		});

		it("removes multiple sentinels of different families", () => {
			strictEqual(stripTokenizerSentinels("a<|im_start|>b<|im_end|>c<|eot_id|>d</s>e"), "abcde");
		});

		it("removes the Qwen end-of-text sentinel that motivated the fix", () => {
			const input = "The current date and time is Thursday.\nI've used the system's date command.\n<|endoftext|>";
			const expected = "The current date and time is Thursday.\nI've used the system's date command.\n";
			strictEqual(stripTokenizerSentinels(input), expected);
		});

		it("preserves lookalike strings that are not in the known list", () => {
			const input = "ref to <|something_random|> and <|made_up_token|>";
			strictEqual(stripTokenizerSentinels(input), input);
		});

		it("preserves an empty string and plain prose", () => {
			strictEqual(stripTokenizerSentinels(""), "");
			const plain = "no sentinels here at all <|fakeish|>";
			strictEqual(stripTokenizerSentinels(plain), plain);
		});

		it("handles fim and file_separator sentinels", () => {
			strictEqual(stripTokenizerSentinels("<|fim_prefix|>x<|fim_middle|>y<|fim_suffix|>z<|file_separator|>"), "xyz");
		});
	});

	describe("createSentinelStripper (streaming)", () => {
		it("returns the input verbatim when no sentinel appears", () => {
			const stripper = createSentinelStripper();
			strictEqual(stripper.push("hello "), "hello ");
			strictEqual(stripper.push("world"), "world");
			strictEqual(stripper.flush(), "");
		});

		it("strips a complete sentinel within a single chunk", () => {
			const stripper = createSentinelStripper();
			strictEqual(stripper.push("foo<|endoftext|>bar"), "foobar");
			strictEqual(stripper.flush(), "");
		});

		it("handles a sentinel split across two chunks", () => {
			const stripper = createSentinelStripper();
			// First chunk ends inside `<|endoftext|>`; the stripper must hold the
			// trailing fragment back since it could complete a sentinel.
			const first = stripper.push("hello<|endoftex");
			const second = stripper.push("t|>world");
			strictEqual(first + second, "helloworld");
			strictEqual(stripper.flush(), "");
		});

		it("handles a sentinel split across three chunks", () => {
			const stripper = createSentinelStripper();
			const a = stripper.push("text <|im_");
			const b = stripper.push("en");
			const c = stripper.push("d|> tail");
			strictEqual(a + b + c, "text  tail");
			strictEqual(stripper.flush(), "");
		});

		it("does not strip lookalikes that share a prefix with a sentinel", () => {
			const stripper = createSentinelStripper();
			// `<|endoftext_x|>` is NOT in the known list. The stripper must
			// hold while it looks like a candidate, then release the entire
			// run once the candidate is disproven.
			const out = stripper.push("a<|endoftext_x|>b");
			const tail = stripper.flush();
			strictEqual(out + tail, "a<|endoftext_x|>b");
		});

		it("preserves user-pasted documentation that mentions sentinel-shaped strings without exact match", () => {
			const stripper = createSentinelStripper();
			const out = stripper.push("docs say <|FAKE|> is unused.");
			const tail = stripper.flush();
			strictEqual(out + tail, "docs say <|FAKE|> is unused.");
		});

		it("strips a sentinel that arrives one byte at a time", () => {
			const stripper = createSentinelStripper();
			let collected = "";
			for (const ch of "before<|endoftext|>after") {
				collected += stripper.push(ch);
			}
			collected += stripper.flush();
			strictEqual(collected, "beforeafter");
		});

		it("flushes a held tail that turned out not to be a sentinel", () => {
			const stripper = createSentinelStripper();
			// Push only the prefix of a sentinel so it sits in the buffer.
			strictEqual(stripper.push("ok<|endof"), "ok");
			// At end-of-stream, the buffered tail must be released.
			strictEqual(stripper.flush(), "<|endof");
		});

		it("emits empty string when chunk is empty", () => {
			const stripper = createSentinelStripper();
			strictEqual(stripper.push(""), "");
			strictEqual(stripper.flush(), "");
		});

		it("does not strip user input that happens to contain a sentinel (caller responsibility)", () => {
			// This test documents the boundary: the helper is meant for
			// assistant-generated text. Callers must not pipe user-typed input
			// through it. Here we simply verify the helper has no awareness
			// of source: the same string in or out, sentinels removed either
			// way. The boundary is enforced by the call sites, not the helper.
			const stripper = createSentinelStripper();
			const out = stripper.push("user wrote <|endoftext|> here");
			strictEqual(out + stripper.flush(), "user wrote  here");
		});
	});
});
