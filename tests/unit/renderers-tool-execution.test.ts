import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	renderToolCallHeader,
	renderToolExecution,
	renderToolResultOnly,
	renderToolSubline,
} from "../../src/interactive/renderers/tool-execution.js";

// Strip ANSI sequences. Biome bans literal control chars in regex source,
// so build the pattern from a constructor with the ESC byte injected.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

const RAIL = "│ ";
const HEADER_PREFIX = "▸ ";
const STATUS_OK = "✓";
const STATUS_ERROR = "✗";

function renderPlainSubline(call: Parameters<typeof renderToolSubline>[0], width: number): string[] {
	return renderToolSubline(call, width).map(stripAnsi);
}

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

	it("renders a read subline", () => {
		strictEqual(
			renderPlainSubline({ toolCallId: "t1", toolName: "read", args: { path: "README.md" } }, 80)[0],
			`${HEADER_PREFIX}reading README.md`,
		);
	});

	it("renders an edit subline", () => {
		strictEqual(
			renderPlainSubline({ toolCallId: "t1", toolName: "edit", args: { path: "src/foo.ts" } }, 80)[0],
			`${HEADER_PREFIX}editing src/foo.ts`,
		);
	});

	it("renders a write subline", () => {
		strictEqual(
			renderPlainSubline({ toolCallId: "t1", toolName: "write", args: { path: "src/bar.ts" } }, 80)[0],
			`${HEADER_PREFIX}writing src/bar.ts`,
		);
	});

	it("renders an ls subline", () => {
		strictEqual(
			renderPlainSubline({ toolCallId: "t1", toolName: "ls", args: { path: "." } }, 80)[0],
			`${HEADER_PREFIX}listing .`,
		);
	});

	it("renders a bash subline", () => {
		strictEqual(
			renderPlainSubline({ toolCallId: "t1", toolName: "bash", args: { command: "npm test" } }, 80)[0],
			`${HEADER_PREFIX}running \`npm test\``,
		);
	});

	it("renders a grep subline", () => {
		strictEqual(
			renderPlainSubline({ toolCallId: "t1", toolName: "grep", args: { pattern: "TODO" } }, 80)[0],
			`${HEADER_PREFIX}searching for \`TODO\``,
		);
	});

	it("renders a glob subline", () => {
		strictEqual(
			renderPlainSubline({ toolCallId: "t1", toolName: "glob", args: { pattern: "**/*.ts" } }, 80)[0],
			`${HEADER_PREFIX}matching \`**/*.ts\``,
		);
	});

	it("renders a web_fetch subline", () => {
		strictEqual(
			renderPlainSubline({ toolCallId: "t1", toolName: "web_fetch", args: { url: "https://example.com" } }, 80)[0],
			`${HEADER_PREFIX}fetching https://example.com`,
		);
	});

	it("renderToolSubline omits the status glyph for in-flight tool calls", () => {
		const plain = renderPlainSubline({ toolCallId: "t1", toolName: "read", args: { path: "a.ts" } }, 80)[0] ?? "";
		ok(!plain.includes(STATUS_OK), `subline should not carry ok glyph in flight: ${plain}`);
		ok(!plain.includes(STATUS_ERROR), `subline should not carry error glyph in flight: ${plain}`);
	});

	it("renderToolSubline appends a green check on success", () => {
		const plain = renderPlainSubline(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "hi", isError: false },
			80,
		);
		ok(
			plain.some((line) => line === `${HEADER_PREFIX}reading a.ts ${STATUS_OK}`),
			JSON.stringify(plain),
		);
	});

	it("renderToolSubline appends a red cross on error", () => {
		const plain = renderPlainSubline(
			{ toolCallId: "t1", toolName: "bash", args: { command: "false" }, result: "exit 1", isError: true },
			80,
		);
		ok(
			plain.some((line) => line === `${HEADER_PREFIX}running \`false\` ${STATUS_ERROR}`),
			JSON.stringify(plain),
		);
	});

	it("truncates a very long bash command in the subline preview", () => {
		const long = "x".repeat(200);
		const plain = renderPlainSubline({ toolCallId: "t1", toolName: "bash", args: { command: long } }, 120)[0] ?? "";
		ok(plain.includes("..."), JSON.stringify(plain));
		ok(!plain.includes(long), JSON.stringify(plain));
	});

	it("renderToolSubline falls back to the header form for unknown tools", () => {
		const plain = renderPlainSubline({ toolCallId: "t1", toolName: "mystery", args: { x: 1 } }, 80)[0] ?? "";
		strictEqual(plain, `${HEADER_PREFIX}mystery({"x":1})`);
	});

	it("wraps tool sublines to the supplied width", () => {
		const lines = renderPlainSubline(
			{
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda" },
			},
			24,
		);
		for (const line of lines) {
			ok(line.length <= 24, `line too wide: ${JSON.stringify(line)}`);
		}
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

	it("renders the edit-tool dispatch path with +new and -old diff lines", () => {
		const lines = renderToolExecution(
			{
				toolCallId: "t1",
				toolName: "edit",
				args: { path: "x.ts", old_string: "old", new_string: "new" },
				result: "ok",
				isError: false,
			},
			80,
		);
		const plain = lines.map(stripAnsi);
		ok(
			plain.some((l) => l.includes("+new")),
			`expected +new in diff output, got: ${JSON.stringify(plain)}`,
		);
		ok(
			plain.some((l) => l.includes("-old")),
			`expected -old in diff output, got: ${JSON.stringify(plain)}`,
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

	// Fix 4: rail color flips to red when the finished result is an error so
	// the tool block reads as a single failed unit even at a glance.
	it("renders the result rail in red when the finished call is an error", () => {
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "bash", args: { command: "false" }, result: "boom", isError: true },
			80,
		);
		const railLine = lines.find((line) => stripAnsi(line).startsWith(`${RAIL}boom`));
		ok(railLine !== undefined, `expected a rail line carrying 'boom', got: ${JSON.stringify(lines.map(stripAnsi))}`);
		ok(
			railLine.includes(`${String.fromCharCode(27)}[31m`),
			`expected red ANSI sequence on rail line, got: ${JSON.stringify(railLine)}`,
		);
		strictEqual(stripAnsi(railLine).startsWith(RAIL), true);
	});

	// Fix 5: discriminate `ToolExecutionStart` vs `ToolExecutionFinished` on
	// `result`, not `isError`. A start payload that happens to carry a stray
	// `isError: false` must still take the in-flight (no-glyph) path.
	it("treats a start payload with a stray isError as in-flight", () => {
		const start = { toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, isError: false } as unknown;
		const plain = renderPlainSubline(start as Parameters<typeof renderToolSubline>[0], 80)[0] ?? "";
		ok(!plain.includes(STATUS_OK), `start payload must not render the ok glyph: ${plain}`);
		ok(!plain.includes(STATUS_ERROR), `start payload must not render the error glyph: ${plain}`);
	});

	// Fix 2: the JSON args body splits on \n first, then caps the line count.
	// The previous codepoint-level truncate could cut inside an open string or
	// before a closing brace and break copy-paste of the rendered block.
	it("caps a long JSON args body at the line limit with a hidden-count marker", () => {
		const args: Record<string, string> = {};
		for (let i = 0; i < 50; i += 1) args[`field${String(i).padStart(2, "0")}`] = `value-${i}`;
		const lines = renderToolExecution({ toolCallId: "t1", toolName: "mystery", args, result: "ok", isError: false }, 120);
		const plain = lines.map(stripAnsi);
		// The pretty-printed JSON has 52 lines (open brace + 50 fields + close brace),
		// which exceeds the 24-line cap. The renderer must emit a hidden-count
		// marker rather than slicing mid-line.
		const markerIdx = plain.findIndex((l) => / more lines hidden$/.test(l));
		ok(markerIdx >= 0, `expected hidden-count marker, got: ${JSON.stringify(plain)}`);
		// Inspect only the args-body region (between the header and the marker
		// inclusive). The result block sits past the marker. Every body line
		// must be a complete JSON line, never a mid-line cut: open brace,
		// `"fieldNN": "value-N",` (indented two spaces), or the marker itself.
		const headerIdx = plain.findIndex((l) => l.startsWith(`${HEADER_PREFIX}mystery(`));
		ok(headerIdx >= 0 && markerIdx > headerIdx, `unexpected layout: ${JSON.stringify(plain)}`);
		for (let i = headerIdx + 1; i <= markerIdx; i += 1) {
			const line = plain[i] ?? "";
			ok(line.startsWith(RAIL), `args-body line missing rail: ${JSON.stringify(line)}`);
			const body = line.slice(RAIL.length);
			if (body.startsWith("...")) continue;
			ok(
				body === "{" || body.startsWith("  "),
				`args-body line not a complete JSON line (mid-line cut?): ${JSON.stringify(line)}`,
			);
		}
		// Also assert that no malformed JSON terminator (a stray `..."` from
		// the old codepoint truncate) leaked in.
		for (let i = headerIdx + 1; i < markerIdx; i += 1) {
			const line = plain[i] ?? "";
			ok(!line.includes(`..."`), `mid-string cut leaked into args body: ${JSON.stringify(line)}`);
		}
	});

	// Fix 1: the dim ` (<key>)` discoverability hint is appended to the first
	// wrapped line of finished collapsed sublines. Suppressed on in-flight
	// (header) and expanded paths and when no key string is supplied.
	it("appends the expand-key hint to finished sublines when an expandKey is supplied", () => {
		const lines = renderToolSubline(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "hi", isError: false },
			80,
			"ctrl+o",
		);
		const plain = lines.map(stripAnsi);
		ok(
			plain.some((l) => l.includes("(ctrl+o)")),
			`expected expand-key hint, got: ${JSON.stringify(plain)}`,
		);
		ok(plain[0]?.includes("(ctrl+o)"), `hint must land on the first line, got: ${JSON.stringify(plain)}`);
	});

	it("omits the expand-key hint on in-flight sublines even when a key is supplied", () => {
		const lines = renderToolSubline({ toolCallId: "t1", toolName: "read", args: { path: "a.ts" } }, 80, "ctrl+o");
		const plain = lines.map(stripAnsi).join("\n");
		ok(!plain.includes("(ctrl+o)"), `in-flight subline must not carry expand-key hint: ${plain}`);
	});

	it("omits the expand-key hint when no key is supplied", () => {
		const lines = renderToolSubline(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "hi", isError: false },
			80,
		);
		const plain = lines.map(stripAnsi).join("\n");
		ok(!plain.includes("(ctrl+o)"), `unbound expand-key must suppress hint: ${plain}`);
	});

	it("omits the expand-key hint on the expanded full-render path (renderToolExecution)", () => {
		const lines = renderToolExecution(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "hi", isError: false },
			80,
		);
		const plain = lines.map(stripAnsi).join("\n");
		ok(!plain.includes("(ctrl+o)"), `expanded render must not carry expand-key hint: ${plain}`);
	});

	it("respects user rebinds: the supplied key string is rendered verbatim", () => {
		const lines = renderToolSubline(
			{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "hi", isError: false },
			80,
			"alt+x",
		);
		const plain = lines.map(stripAnsi).join("\n");
		ok(plain.includes("(alt+x)"), `expected rebinding to surface, got: ${plain}`);
		ok(!plain.includes("(ctrl+o)"), `default key must not leak when a rebind is supplied: ${plain}`);
	});
});
