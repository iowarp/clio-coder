import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInitialMessage } from "../../src/cli/initial-message.js";

describe("cli/initial-message", () => {
	it("merges piped stdin with the first CLI message into one prompt", () => {
		const result = buildInitialMessage({
			messages: ["Summarize the text given"],
			stdinContent: "README contents\n",
		});

		strictEqual(result.initialMessage, "README contents\nSummarize the text given");
		deepStrictEqual(result.remainingMessages, []);
	});

	it("uses stdin as the initial prompt when no CLI message is present", () => {
		const result = buildInitialMessage({ messages: [], stdinContent: "README contents" });
		strictEqual(result.initialMessage, "README contents");
		deepStrictEqual(result.remainingMessages, []);
	});

	it("keeps later messages separate for future multi-turn modes", () => {
		const result = buildInitialMessage({
			messages: ["Explain it", "Second message"],
			stdinContent: "stdin\n",
			fileText: "file\n",
		});

		strictEqual(result.initialMessage, "stdin\nfile\nExplain it");
		deepStrictEqual(result.remainingMessages, ["Second message"]);
	});
});
