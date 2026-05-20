import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunCliArgs } from "../../src/cli/args.js";

describe("cli/args run parser", () => {
	it("parses main-agent run overrides and JSON mode", () => {
		const parsed = parseRunCliArgs(["prompt", "--target", "mini", "--model", "m", "--thinking", "low", "--json"]);
		strictEqual(parsed.json, true);
		strictEqual(parsed.target, "mini");
		strictEqual(parsed.model, "m");
		strictEqual(parsed.thinking, "low");
		deepStrictEqual(parsed.messages, ["prompt"]);
		deepStrictEqual(parsed.fileArgs, []);
		deepStrictEqual(parsed.diagnostics, []);
	});

	it("splits @file positional arguments from run messages", () => {
		const parsed = parseRunCliArgs(["@README.md", "summarize"]);
		deepStrictEqual(parsed.fileArgs, ["README.md"]);
		deepStrictEqual(parsed.messages, ["summarize"]);
	});

	it("parses explicit fleet dispatch", () => {
		const parsed = parseRunCliArgs(["task", "--agent", "reviewer", "--target", "mini"]);
		strictEqual(parsed.agentId, "reviewer");
		strictEqual(parsed.target, "mini");
		deepStrictEqual(parsed.messages, ["task"]);
		deepStrictEqual(parsed.diagnostics, []);
	});

	it("reports invalid thinking values", () => {
		const parsed = parseRunCliArgs(["task", "--thinking", "huge"]);
		strictEqual(parsed.diagnostics[0]?.type, "error");
	});
});
