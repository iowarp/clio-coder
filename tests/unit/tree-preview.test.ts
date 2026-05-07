import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { TreeSnapshot } from "../../src/domains/session/tree/navigator.js";
import { buildTurnPreview, TURN_PREVIEW_MAX_CHARS } from "../../src/domains/session/tree/preview.js";
import {
	createTreeOverlayViewForTesting,
	formatTreeRow,
	TREE_OVERLAY_WIDTH,
} from "../../src/interactive/overlays/tree-selector.js";

const ESC = String.fromCharCode(0x1b);

describe("buildTurnPreview", () => {
	it("clamps a long user message and adds an ellipsis", () => {
		const long = "x".repeat(200);
		const preview = buildTurnPreview({ kind: "user", payload: { text: long } });
		ok(preview.endsWith("…"), `expected trailing ellipsis, got: ${preview}`);
		strictEqual(preview.length, TURN_PREVIEW_MAX_CHARS);
		strictEqual(preview.slice(0, TURN_PREVIEW_MAX_CHARS - 1), "x".repeat(TURN_PREVIEW_MAX_CHARS - 1));
	});

	it("collapses newlines and tabs in assistant text into a single line", () => {
		const text = "first line\nsecond\tline\r\nthird line";
		const preview = buildTurnPreview({ kind: "assistant", payload: { text } });
		strictEqual(preview, "first line second line third line");
		ok(!preview.includes("\n"), "preview must be single-line");
		ok(!preview.includes("\t"), "preview must not retain tabs");
	});

	it("extracts assistant text from a content array of text blocks", () => {
		const payload = {
			text: "",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			],
		};
		const preview = buildTurnPreview({ kind: "assistant", payload });
		strictEqual(preview, "hello world");
	});

	it("renders a tool_call as toolName(arg) with the most distinguishing arg", () => {
		const readPreview = buildTurnPreview({
			kind: "tool_call",
			payload: { toolCallId: "1", name: "read", args: { path: "/path/to/file.ts" } },
		});
		strictEqual(readPreview, 'read("/path/to/file.ts")');
		const bashPreview = buildTurnPreview({
			kind: "tool_call",
			payload: { toolCallId: "2", name: "bash", args: { command: "npm run test" } },
		});
		strictEqual(bashPreview, 'bash("npm run test")');
		const grepPreview = buildTurnPreview({
			kind: "tool_call",
			payload: { toolCallId: "3", name: "where_is", args: { pattern: ".*tui.*" } },
		});
		strictEqual(grepPreview, 'where_is(".*tui.*")');
	});

	it("renders a tool_result with [ok] for success and [err] for errors", () => {
		const okPreview = buildTurnPreview({
			kind: "tool_result",
			payload: {
				toolCallId: "1",
				toolName: "read",
				result: { content: [{ type: "text", text: "file contents here" }] },
				isError: false,
			},
		});
		ok(okPreview.startsWith("[ok]"), `expected [ok] prefix, got: ${okPreview}`);
		ok(okPreview.includes("file contents here"));

		const errPreview = buildTurnPreview({
			kind: "tool_result",
			payload: {
				toolCallId: "2",
				toolName: "bash",
				result: { content: [{ type: "text", text: "command not found" }] },
				isError: true,
			},
		});
		ok(errPreview.startsWith("[err]"), `expected [err] prefix, got: ${errPreview}`);
		ok(errPreview.includes("command not found"));
	});

	it("renders distinct empty / aborted / error markers", () => {
		strictEqual(buildTurnPreview({ kind: "user", payload: {} }), "(empty)");
		strictEqual(buildTurnPreview({ kind: "user", payload: { text: "" } }), "(empty)");
		strictEqual(buildTurnPreview({ kind: "user", payload: { text: "   \n\t  " } }), "(empty)");
		strictEqual(buildTurnPreview({ kind: "assistant", payload: { text: "", stopReason: "aborted" } }), "(aborted)");
		strictEqual(buildTurnPreview({ kind: "assistant", payload: { text: "", stopReason: "error" } }), "(error)");
		strictEqual(buildTurnPreview({ kind: "checkpoint", payload: null }), "(checkpoint)");
		strictEqual(buildTurnPreview({ kind: "tool_result", payload: { toolCallId: "x", isError: false } }), "[ok]");
	});

	it("strips ANSI escape sequences from previews", () => {
		const colored = `${ESC}[31mhello${ESC}[0m world`;
		const preview = buildTurnPreview({ kind: "user", payload: { text: colored } });
		strictEqual(preview, "hello world");
	});

	it("strips known tokenizer sentinels from previews", () => {
		const text = "before <|endoftext|> after <|im_end|>";
		const preview = buildTurnPreview({ kind: "assistant", payload: { text } });
		// Sentinels are removed; whitespace is then collapsed into single spaces.
		strictEqual(preview, "before after");
	});

	it("falls back to a tool-call summary when assistant text is empty", () => {
		const payload = {
			text: "",
			content: [
				{ type: "toolCall", id: "1", name: "read", arguments: { path: "/a" } },
				{ type: "toolCall", id: "2", name: "bash", arguments: { command: "ls" } },
			],
			stopReason: "toolUse",
		};
		const preview = buildTurnPreview({ kind: "assistant", payload });
		ok(preview.startsWith("(tool calls)"), `got: ${preview}`);
		ok(preview.includes("read"));
		ok(preview.includes("bash"));
	});

	it("handles a tool_call with no args by emitting bare parens", () => {
		const preview = buildTurnPreview({
			kind: "tool_call",
			payload: { toolCallId: "1", name: "list", args: {} },
		});
		strictEqual(preview, "list()");
	});
});

describe("formatTreeRow renders payload-driven previews", () => {
	const baseSnapshot = (preview?: string): TreeSnapshot => ({
		sessionId: "s1",
		meta: {
			id: "s1",
			cwd: "/tmp",
			createdAt: "2024-01-01T00:00:00.000Z",
			endedAt: null,
			model: null,
			endpoint: null,
		},
		leafId: "n1",
		nodesById: {
			n1: {
				id: "0123456789abcdef",
				parentId: null,
				at: "2024-01-01T00:00:00.000Z",
				kind: "user",
				children: [],
				...(preview !== undefined ? { preview } : {}),
			},
		},
		rootIds: ["n1"],
	});

	it("includes the preview text from the snapshot node in the rendered row", () => {
		const snap = baseSnapshot("hello world from the user");
		const node = snap.nodesById.n1;
		ok(node, "test snapshot must define n1");
		const line = formatTreeRow({ depth: 0, node, sessionId: "s1" }, { showTimestamps: false, width: 80 });
		ok(line.includes("hello world from the user"), `row missing preview text: ${line}`);
		ok(line.includes("user"), `row missing role: ${line}`);
	});

	it("uses a kind-aware fallback when the snapshot has no preview", () => {
		const snap = baseSnapshot();
		const node = snap.nodesById.n1;
		ok(node, "test snapshot must define n1");
		const line = formatTreeRow({ depth: 0, node, sessionId: "s1" }, { showTimestamps: false, width: 80 });
		ok(line.includes("(no text)"), `expected fallback marker, got: ${line}`);
	});
});

describe("tree overlay end-to-end render", () => {
	it("paints distinct previews per row instead of generic [role] cells", () => {
		const snapshot: TreeSnapshot = {
			sessionId: "s1",
			meta: {
				id: "s1",
				cwd: "/tmp",
				createdAt: "2024-01-01T00:00:00.000Z",
				endedAt: null,
				model: null,
				endpoint: null,
			},
			leafId: "n4",
			nodesById: {
				n1: {
					id: "u1aaaa",
					parentId: null,
					at: "2024-01-01T00:00:00.000Z",
					kind: "user",
					preview: "build me a website",
					children: ["n2"],
				},
				n2: {
					id: "a1bbbb",
					parentId: "u1aaaa",
					at: "2024-01-01T00:00:01.000Z",
					kind: "assistant",
					preview: "(tool calls) read",
					children: ["n3"],
				},
				n3: {
					id: "c1cccc",
					parentId: "a1bbbb",
					at: "2024-01-01T00:00:02.000Z",
					kind: "tool_call",
					preview: 'read("/README.md")',
					children: ["n4"],
				},
				n4: {
					id: "r1dddd",
					parentId: "c1cccc",
					at: "2024-01-01T00:00:03.000Z",
					kind: "tool_result",
					preview: "[ok] file contents here",
					children: [],
				},
			},
			rootIds: ["n1"],
		};

		const session: Partial<SessionContract> = { tree: () => snapshot };
		const view = createTreeOverlayViewForTesting(
			{
				session: session as SessionContract,
				onSwitchBranch: () => {},
				onClose: () => {},
			},
			snapshot,
		);
		const rendered = view.render(TREE_OVERLAY_WIDTH).join("\n");
		ok(rendered.includes("build me a website"), `rendered:\n${rendered}`);
		ok(rendered.includes('read("/README.md")'), `rendered:\n${rendered}`);
		ok(rendered.includes("[ok] file contents here"), `rendered:\n${rendered}`);
		ok(rendered.includes("(tool calls) read"), `rendered:\n${rendered}`);
		// And the bug we are fixing: rows must not all read the same generic
		// `[role]` cell anymore.
		ok(!/\[user\]\s+\[assistant\]\s+\[tool_call\]/.test(rendered), "old [role] placeholders should be gone");
	});
});
