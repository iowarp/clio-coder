import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	renderToolCallHeader,
	renderToolExecution,
	renderToolResultOnly,
} from "../../src/interactive/renderers/tool-execution.js";

// Strip ANSI sequences. Biome bans literal control chars in regex source,
// so build the pattern from a constructor with the ESC byte injected.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

describe("renderers/tool-execution", () => {
	it("renders header with the most informative arg per tool", () => {
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "read", args: { path: "src/foo.ts" } }, 80);
		ok(
			lines.some((l) => stripAnsi(l).startsWith("tool: read(src/foo.ts)")),
			JSON.stringify(lines),
		);
	});

	it("falls back to full-args summary for unknown tools", () => {
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "mystery", args: { x: 1, y: "z" } }, 80);
		ok(stripAnsi(lines[0] ?? "").startsWith("tool: mystery("), JSON.stringify(lines));
	});

	it("renders header with no args parens when args missing", () => {
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "ls", args: undefined }, 80);
		strictEqual(stripAnsi(lines[0] ?? "").startsWith("tool: ls("), true);
	});

	it("renders result block with success prefix and indentation", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "read",
				args: { path: "a.ts" },
				result: "hello\nworld",
				isError: false,
			},
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(plain.includes("  result:"), JSON.stringify(plain));
		ok(
			plain.some((l) => l === "  hello"),
			JSON.stringify(plain),
		);
		ok(
			plain.some((l) => l === "  world"),
			JSON.stringify(plain),
		);
	});

	it("renders error block with error prefix", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "false" },
				result: "exit 1",
				isError: true,
			},
			80,
		);
		ok(lines.map(stripAnsi).includes("  error:"), JSON.stringify(lines));
	});

	it("emits (no output) marker for empty results", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "ls",
				args: { path: "." },
				result: "",
				isError: false,
			},
			80,
		);
		ok(lines.map(stripAnsi).includes("  (no output)"), JSON.stringify(lines));
	});

	it("truncates very long bash commands in the header", () => {
		const long = "x".repeat(200);
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "bash", args: { command: long } }, 120);
		const head = stripAnsi(lines[0] ?? "");
		ok(head.length <= 120, JSON.stringify(head));
		ok(head.includes("..."), JSON.stringify(head));
	});

	it("renderToolResultOnly emits result block without args body", () => {
		const lines = renderToolResultOnly({ toolCallId: "t1", toolName: "read", result: "abc", isError: false }, 80);
		const plain = lines.map(stripAnsi);
		ok(
			plain.some((l) => l.startsWith("tool: read")),
			JSON.stringify(plain),
		);
		ok(plain.includes("  result:"), JSON.stringify(plain));
		// No args section: there must be no JSON-args body line between header and result.
		const headerIdx = plain.findIndex((l) => l.startsWith("tool: read"));
		const resultIdx = plain.indexOf("  result:");
		strictEqual(resultIdx, headerIdx + 1, JSON.stringify(plain));
	});

	it("renders edit results as a unified diff between old_string and new_string", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "edit",
				args: { path: "src/foo.ts", old_string: "alpha\nbeta\n", new_string: "alpha\nGAMMA\n" },
				result: "edit applied",
				isError: false,
			},
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(
			plain.some((l) => l.startsWith("tool: edit(src/foo.ts)")),
			JSON.stringify(plain),
		);
		ok(
			plain.some((l) => l.includes("--- a/src/foo.ts")),
			JSON.stringify(plain),
		);
		ok(
			plain.some((l) => l.includes("+++ b/src/foo.ts")),
			JSON.stringify(plain),
		);
		ok(
			plain.some((l) => l.includes("-beta")),
			JSON.stringify(plain),
		);
		ok(
			plain.some((l) => l.includes("+GAMMA")),
			JSON.stringify(plain),
		);
	});

	it("wraps long result preview lines at the supplied width", () => {
		const long = "y".repeat(200);
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "read",
				args: { path: "a.ts" },
				result: long,
				isError: false,
			},
			40,
		);
		for (const line of lines) {
			ok(stripAnsi(line).length <= 40, `line too wide: ${line.length}`);
		}
	});

	it("suppresses the args body when the header captured the primary arg", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "read",
				args: { path: "README.md" },
				result: "hello",
				isError: false,
			},
			80,
		);
		const plain = lines.map(stripAnsi);
		const headerIdx = plain.findIndex((l) => l.startsWith("tool: read(README.md)"));
		const resultIdx = plain.indexOf("  result:");
		ok(headerIdx >= 0 && resultIdx >= 0, JSON.stringify(plain));
		strictEqual(resultIdx, headerIdx + 1, `expected result block immediately after header, got ${JSON.stringify(plain)}`);
		ok(!plain.some((l) => l.includes(`"path"`)), `args body leaked into output: ${JSON.stringify(plain)}`);
	});

	it("retains the args body for unknown tools so users see what was invoked", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "mystery",
				args: { x: 1, y: "z" },
				result: "ok",
				isError: false,
			},
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(
			plain.some((l) => l.includes(`"x": 1`)),
			`expected args body for unknown tool, got: ${JSON.stringify(plain)}`,
		);
	});

	it("unwraps pi-agent-core text-content envelopes before rendering", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "read",
				args: { path: "a.ts" },
				result: { content: [{ type: "text", text: "hello\nworld" }] },
				isError: false,
			},
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(plain.includes("  hello"), JSON.stringify(plain));
		ok(plain.includes("  world"), JSON.stringify(plain));
		ok(
			!plain.some((l) => l.includes(`"content"`) || l.includes(`"type"`)),
			`envelope leaked into output: ${JSON.stringify(plain)}`,
		);
	});

	it("unwraps bare text-content arrays as well as envelope objects", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "read",
				args: { path: "a.ts" },
				result: [
					{ type: "text", text: "first chunk" },
					{ type: "text", text: " second chunk" },
				],
				isError: false,
			},
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(plain.includes("  first chunk second chunk"), JSON.stringify(plain));
	});

	it("caps long results at 12 visible lines with a hidden-count marker", () => {
		const result = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "read",
				args: { path: "a.ts" },
				result,
				isError: false,
			},
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(plain.includes("  line1"), JSON.stringify(plain));
		ok(plain.includes("  line12"), JSON.stringify(plain));
		ok(!plain.some((l) => l.includes("line13")), `expected line13 to be hidden, got: ${JSON.stringify(plain)}`);
		ok(
			plain.some((l) => l.includes("18 more lines hidden")),
			`expected hidden-count marker, got: ${JSON.stringify(plain)}`,
		);
	});
});
