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

const RAIL = "│ ";
const HEADER_PREFIX = "▸ ";
const STATUS_OK = "✓";
const STATUS_ERROR = "✗";

describe("renderers/tool-execution", () => {
	it("renders the header with the prefix glyph and the captured primary arg", () => {
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "read", args: { path: "src/foo.ts" } }, 80);
		const plain = lines.map(stripAnsi);
		ok(
			plain.some((l) => l.startsWith(`${HEADER_PREFIX}read(src/foo.ts)`)),
			JSON.stringify(plain),
		);
	});

	it("falls back to a JSON-dump summary in the header for unknown tools", () => {
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "mystery", args: { x: 1, y: "z" } }, 80);
		const plain = stripAnsi(lines[0] ?? "");
		ok(plain.startsWith(`${HEADER_PREFIX}mystery(`), JSON.stringify(plain));
	});

	it("renders the header with empty parens when args are absent", () => {
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "ls", args: undefined }, 80);
		const plain = stripAnsi(lines[0] ?? "");
		strictEqual(plain.startsWith(`${HEADER_PREFIX}ls(`), true);
		ok(plain.includes("()"), JSON.stringify(plain));
	});

	it("omits the status glyph for in-flight tool calls", () => {
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "read", args: { path: "a.ts" } }, 80);
		const plain = stripAnsi(lines[0] ?? "");
		ok(!plain.includes(STATUS_OK), `header should not carry ok glyph in flight: ${plain}`);
		ok(!plain.includes(STATUS_ERROR), `header should not carry error glyph in flight: ${plain}`);
	});

	it("appends a green check to the header on success", () => {
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "hi", isError: false },
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(
			plain.some((l) => l.startsWith(`${HEADER_PREFIX}read(a.ts)`) && l.endsWith(STATUS_OK)),
			JSON.stringify(plain),
		);
	});

	it("appends a red cross to the header on error", () => {
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "bash", args: { command: "false" }, result: "exit 1", isError: true },
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(
			plain.some((l) => l.startsWith(`${HEADER_PREFIX}bash(false)`) && l.endsWith(STATUS_ERROR)),
			JSON.stringify(plain),
		);
	});

	it("renders the result body using the rail prefix without a label line", () => {
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "hello\nworld", isError: false },
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(plain.includes(`${RAIL}hello`), JSON.stringify(plain));
		ok(plain.includes(`${RAIL}world`), JSON.stringify(plain));
		ok(
			!plain.some((l) => l.includes("result:") || l.includes("error:")),
			`expected no label line, got: ${JSON.stringify(plain)}`,
		);
	});

	it("emits the (no output) marker on the rail when result is empty", () => {
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "ls", args: { path: "." }, result: "", isError: false },
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(plain.includes(`${RAIL}(no output)`), JSON.stringify(plain));
	});

	it("truncates a very long bash command in the header preview", () => {
		const long = "x".repeat(200);
		const lines = renderToolCallHeader({ toolCallId: "t1", toolName: "bash", args: { command: long } }, 120);
		const head = stripAnsi(lines[0] ?? "");
		ok(head.length <= 120, JSON.stringify(head));
		ok(head.includes("..."), JSON.stringify(head));
	});

	it("renderToolResultOnly emits result block without an args body", () => {
		const lines = renderToolResultOnly({ toolCallId: "t1", toolName: "read", result: "abc", isError: false }, 80);
		const plain = lines.map(stripAnsi);
		const headerIdx = plain.findIndex((l) => l.startsWith(`${HEADER_PREFIX}read`));
		const bodyIdx = plain.indexOf(`${RAIL}abc`);
		ok(headerIdx >= 0 && bodyIdx >= 0, JSON.stringify(plain));
		strictEqual(bodyIdx, headerIdx + 1, JSON.stringify(plain));
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
			plain.some((l) => l.startsWith(`${HEADER_PREFIX}edit(src/foo.ts)`)),
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

	it("wraps long result preview lines to the supplied width", () => {
		const long = "y".repeat(200);
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: long, isError: false },
			40,
		);
		for (const line of lines) {
			ok(stripAnsi(line).length <= 40, `line too wide: ${line.length}`);
		}
	});

	it("suppresses the args body when the header already encodes the primary arg", () => {
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "read", args: { path: "README.md" }, result: "hello", isError: false },
			80,
		);
		const plain = lines.map(stripAnsi);
		const headerIdx = plain.findIndex((l) => l.startsWith(`${HEADER_PREFIX}read(README.md)`));
		const bodyIdx = plain.indexOf(`${RAIL}hello`);
		ok(headerIdx >= 0 && bodyIdx >= 0, JSON.stringify(plain));
		strictEqual(bodyIdx, headerIdx + 1, `expected body to immediately follow header, got ${JSON.stringify(plain)}`);
		ok(!plain.some((l) => l.includes(`"path"`)), `args body leaked into output: ${JSON.stringify(plain)}`);
	});

	it("retains the args body for unknown tools so users see what was invoked", () => {
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "mystery", args: { x: 1, y: "z" }, result: "ok", isError: false },
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
		ok(plain.includes(`${RAIL}hello`), JSON.stringify(plain));
		ok(plain.includes(`${RAIL}world`), JSON.stringify(plain));
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
		ok(plain.includes(`${RAIL}first chunk second chunk`), JSON.stringify(plain));
	});

	it("caps long results at 12 visible lines with a hidden-count marker on the rail", () => {
		const result = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result, isError: false },
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(plain.includes(`${RAIL}line1`), JSON.stringify(plain));
		ok(plain.includes(`${RAIL}line12`), JSON.stringify(plain));
		ok(!plain.some((l) => l.includes("line13")), `expected line13 to be hidden, got: ${JSON.stringify(plain)}`);
		ok(
			plain.some((l) => l.includes("18 more lines hidden")),
			`expected hidden-count marker, got: ${JSON.stringify(plain)}`,
		);
	});
});
