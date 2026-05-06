import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePrintCliArgs } from "../../src/cli/args.js";

describe("cli/args print parser", () => {
	it("parses --print messages", () => {
		const parsed = parsePrintCliArgs(["--print", "summarize", "this"]);
		strictEqual(parsed.print, true);
		strictEqual(parsed.mode, "text");
		deepStrictEqual(parsed.messages, ["summarize", "this"]);
		deepStrictEqual(parsed.fileArgs, []);
		deepStrictEqual(parsed.diagnostics, []);
	});

	it("splits @file positional arguments from print messages", () => {
		const parsed = parsePrintCliArgs(["--print", "@README.md", "summarize"]);
		strictEqual(parsed.print, true);
		deepStrictEqual(parsed.fileArgs, ["README.md"]);
		deepStrictEqual(parsed.messages, ["summarize"]);
	});

	it("treats --mode text as print mode", () => {
		const parsed = parsePrintCliArgs(["--mode", "text", "hello"]);
		strictEqual(parsed.print, true);
		strictEqual(parsed.mode, "text");
		deepStrictEqual(parsed.messages, ["hello"]);
	});

	it("treats --mode json as print mode", () => {
		const parsed = parsePrintCliArgs(["--mode", "json", "@image.png", "hello"]);
		strictEqual(parsed.print, true);
		strictEqual(parsed.mode, "json");
		deepStrictEqual(parsed.fileArgs, ["image.png"]);
		deepStrictEqual(parsed.messages, ["hello"]);
	});

	it("reports invalid mode values", () => {
		const parsed = parsePrintCliArgs(["--mode", "xml", "hello"]);
		strictEqual(parsed.print, true);
		strictEqual(parsed.diagnostics[0]?.type, "error");
	});
});
