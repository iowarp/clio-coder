import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { codeInk, codeInkLexer } from "../../src/interactive/renderers/code-ink.js";
import { LiveToolView } from "../../src/interactive/renderers/live-tool-view.js";
import { renderToolPreview } from "../../src/interactive/renderers/tool-execution.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";

const content = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i}; /* note ${i} */`).join("\n");

function forming(args: Record<string, unknown>, toolName = "write") {
	return { toolCallId: "w", toolName, args, phase: "forming" as const };
}

const plain = (rows: readonly string[]): string[] => rows.map(stripTerminalSequences);

describe("live tool views", () => {
	it("render a streamed write identically from the segment cache and cold, at a fixed height", () => {
		for (const width of [75, 120]) {
			for (const style of ["standard", "detailed"] as const) {
				const detail = transcriptDetail(style);
				const live = new LiveToolView();
				const heights = new Set<number>();
				for (let end = 1; end <= content.length; end += 97) {
					const call = forming({ path: "src/streamed.ts", content: content.slice(0, end) });
					const cached = renderToolPreview(call, width, detail, { terminalRows: 50, live });
					deepStrictEqual(cached, renderToolPreview(call, width, detail, { terminalRows: 50 }));
					if (end > content.length / 2) heights.add(cached.length);
				}
				strictEqual(heights.size, 1, `${style} at ${width} keeps one height once the window fills`);
			}
		}
	});

	it("show the newest lines under a count of the lines above, and a line count on the row", () => {
		const rows = plain(
			renderToolPreview(forming({ path: "src/streamed.ts", content }), 120, transcriptDetail("standard")),
		);
		match(rows[0] ?? "", /write src\/streamed\.ts ◌ preparing · 300 lines$/u);
		strictEqual(rows[1], "  │ … 295 lines above");
		strictEqual(rows.at(-1), "  │ export const value299 = 299; /* note 299 */");
		strictEqual(rows.length, 7);
		deepStrictEqual(
			plain(renderToolPreview(forming({ path: "src/streamed.ts", content }), 120, transcriptDetail("compact"))),
			[rows[0]],
		);
	});

	it("redact a secret whose flag sits on the line above the window", () => {
		const secret = `${content}\ncurl --token\nhunter2-secret-value\nl1\nl2\nl3\nl4`;
		const rows = plain(
			renderToolPreview(forming({ path: "run.sh", content: secret }), 120, transcriptDetail("standard")),
		);
		strictEqual(rows[2], "  │ [redacted]", "the window opens on the value; its flag is above it");
		const text = rows.join("\n");
		doesNotMatch(text, /hunter2|--token/u);
		match(text, /\[redacted\]/u);
	});

	it("state a command's whole size when the tool kept only its tail", () => {
		const output = Array.from({ length: 50 }, (_, i) => `ok ${i}`).join("\n");
		const rows = plain(
			renderToolPreview(
				{ toolCallId: "b", toolName: "bash", args: { command: "pnpm test" }, phase: "running", elapsedMs: 1200 },
				100,
				transcriptDetail("standard"),
				{
					partialResult: {
						content: [{ type: "text", text: output }],
						details: { resultSize: { bytes: 2_500_000, truncated: true } },
					},
				},
			),
		);
		match(rows[1] ?? "", /^ {2}│ … earlier output above · 2\.4MB so far$/u);
		strictEqual(rows.at(-1), "  │ ok 49");
		strictEqual(rows.length, 7);
	});

	it("ink a window from the recorded carry exactly as the whole text inks", () => {
		const lines = ["const a = 1;", "/* opened", "still a comment", "closed */ const b = `x", "y` + 2;"];
		const lexer = codeInkLexer("ts");
		ok(lexer);
		let carry = lexer.start;
		for (const line of lines.slice(0, 2)) carry = lexer.advance(line, carry);
		deepStrictEqual(lexer.ink(lines.slice(2), carry), codeInk("ts", lines).slice(2));
	});
});
