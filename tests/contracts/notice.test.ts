import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { appendNotice, type CommandOutputSink } from "../../src/interactive/command-output.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

describe("contracts/notice", () => {
	it("renders each level with the correct glyph and color token", () => {
		const theme = clioTheme();
		const testCases = [
			{
				level: "info" as const,
				glyph: GLYPH.noticeInfo,
				token: "dim" as const,
			},
			{
				level: "success" as const,
				glyph: GLYPH.noticeSuccess,
				token: "success" as const,
			},
			{
				level: "warn" as const,
				glyph: GLYPH.noticeWarn,
				token: "warning" as const,
			},
			{
				level: "error" as const,
				glyph: GLYPH.noticeError,
				token: "error" as const,
			},
		];

		for (const tc of testCases) {
			const blocks: Array<(width: number) => string[]> = [];
			const sink: CommandOutputSink = {
				appendReplayBlock(renderBlock) {
					blocks.push(renderBlock);
				},
				requestRender() {},
			};

			appendNotice(tc.level, "test message", sink);
			strictEqual(blocks.length, 1);

			const render = blocks[0];
			ok(render);
			const lines = render(80);
			strictEqual(lines.length, 1);
			const expectedPrefix = `${theme.fg(tc.token, tc.glyph)} `;
			strictEqual(lines[0], `${expectedPrefix}test message`);
		}
	});

	it("returns a single logical line and wraps when narrow", () => {
		const theme = clioTheme();
		const blocks: Array<(width: number) => string[]> = [];
		const sink: CommandOutputSink = {
			appendReplayBlock(renderBlock) {
				blocks.push(renderBlock);
			},
			requestRender() {},
		};

		appendNotice("success", "very long message that wraps when the terminal is narrow", sink);
		strictEqual(blocks.length, 1);

		// With a width of 30, it should wrap to multiple lines
		const render = blocks[0];
		ok(render);
		const lines = render(30);
		strictEqual(lines.length > 1, true);

		// The first line should start with the success glyph
		const expectedPrefix = `${theme.fg("success", GLYPH.noticeSuccess)} `;
		const firstLine = lines[0];
		ok(firstLine);
		strictEqual(firstLine.startsWith(expectedPrefix), true);
	});

	it("collapses embedded newlines into one notice message", () => {
		const blocks: Array<(width: number) => string[]> = [];
		const sink: CommandOutputSink = {
			appendReplayBlock(renderBlock) {
				blocks.push(renderBlock);
			},
			requestRender() {},
		};

		appendNotice("info", "usage:\n/run <agent> <task>\n", sink);
		strictEqual(blocks.length, 1);
		const render = blocks[0];
		ok(render);
		const lines = render(80);
		strictEqual(lines.length, 1);
		strictEqual(lines[0]?.includes("\n"), false);
		strictEqual(lines[0]?.endsWith("usage: /run <agent> <task>"), true);
	});

	it("does not append anything if the text is empty", () => {
		const blocks: Array<(width: number) => string[]> = [];
		const sink: CommandOutputSink = {
			appendReplayBlock(renderBlock) {
				blocks.push(renderBlock);
			},
			requestRender() {},
		};

		appendNotice("info", "", sink);
		strictEqual(blocks.length, 0);

		appendNotice("info", "  \n\r  ", sink);
		strictEqual(blocks.length, 0);
	});
});
