import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { renderDiffLines } from "../../src/interactive/renderers/diff.js";
import {
	renderBashTranscriptExecution,
	renderToolExecution,
	renderToolSubline,
} from "../../src/interactive/renderers/tool-execution.js";
import { createClioTheme, fgSequence } from "../../src/interactive/theme/index.js";

const errorSequence = fgSequence("error");

const plain = (lines: string[]): string => stripTerminalSequences(lines.join("\n"));

describe("contracts/tool execution transcript", () => {
	it("uses the theme's add/remove colors and Pi word-level emphasis for live diffs", () => {
		const theme = createClioTheme({ color: true, truecolor: true });
		const rendered = renderDiffLines("-1 const old = one;\n+1 const new = two;", 100, { theme }).join("\n");

		ok(rendered.includes(theme.fgSequence("error")), rendered);
		ok(rendered.includes(theme.fgSequence("success")), rendered);
		ok(rendered.includes(`${String.fromCharCode(27)}[7mold`), rendered);
		ok(rendered.includes(`${String.fromCharCode(27)}[7mnew`), rendered);
	});

	it("presents a call signature, typed secondary arguments, and structured result facts", () => {
		const rendered = plain(
			renderToolExecution(
				{
					toolCallId: "bash-1",
					toolName: "bash",
					args: { command: "npm test", cwd: "/work/project", timeoutMs: 120_000 },
					result: {
						content: [{ type: "text", text: "all green\n" }],
						details: {
							exitCode: 0,
							resultSize: {
								shownBytes: 10,
								bytes: 9_000,
								truncated: true,
								offloadPath: "/tmp/clio-tool-output.log",
							},
						},
					},
					isError: false,
					durationMs: 8_700,
				},
				100,
			),
		);

		ok(rendered.includes("bash(npm test)"), rendered);
		ok(rendered.includes("args · 2"), rendered);
		ok(rendered.includes("cwd"), rendered);
		ok(rendered.includes('"/work/project"'), rendered);
		ok(rendered.includes("timeoutMs"), rendered);
		ok(rendered.includes("output · exit 0 · 1 line · 10B shown / 8.8KB total · truncated"), rendered);
		ok(rendered.includes("$ npm test"), rendered);
		ok(rendered.includes("full output  /tmp/clio-tool-output.log"), rendered);
	});

	it("summarizes mixed image content without writing its base64 payload to the terminal", () => {
		const base64 = Buffer.from("operator-private-image-bytes", "utf8").toString("base64");
		const rendered = plain(
			renderToolExecution(
				{
					toolCallId: "vision-1",
					toolName: "inspect_image",
					args: { path: "diagram.png" },
					result: {
						content: [
							{ type: "text", text: "Rendered diagram" },
							{ type: "image", mimeType: "image/png", data: base64 },
						],
					},
					isError: false,
				},
				100,
			),
		);

		ok(rendered.includes("Rendered diagram"), rendered);
		ok(rendered.includes("[image image/png · 28B]"), rendered);
		ok(!rendered.includes(base64), rendered);
		ok(!rendered.includes("operator-private-image-bytes"), rendered);
	});

	it("uses one lifecycle grammar for live and settled operator bash runs", () => {
		const execution = {
			command: "npm run typecheck",
			output: "checking src\n",
			running: true,
			elapsedMs: 4_200,
			totalBytes: 13,
			excludeFromContext: true,
			folded: false,
		};
		const running = plain(renderBashTranscriptExecution(execution, 100));
		ok(running.includes("bash(npm run typecheck)"), running);
		ok(running.includes("running · 4.2s"), running);
		ok(running.includes("live output"), running);
		ok(running.includes("checking src"), running);

		const settled = plain(
			renderBashTranscriptExecution(
				{ ...execution, running: false, exitCode: 0, output: "checking src\nclean\n", totalBytes: 19 },
				100,
			),
		);
		ok(settled.includes("✓"), settled);
		ok(settled.includes("output · exit 0"), settled);
		ok(settled.includes("excluded from context"), settled);
		ok(settled.includes("clean"), settled);
	});

	it("folds an operator bash run by default and keeps its facts on the one-line row", () => {
		const execution = {
			command: "npm run typecheck",
			output: "checking src\n",
			running: true,
			elapsedMs: 4_200,
			totalBytes: 13,
			excludeFromContext: true,
		};
		const running = plain(renderBashTranscriptExecution(execution, 100));
		strictEqual(running.split("\n").length, 1, running);
		ok(running.includes("running `npm run typecheck`"), running);
		ok(running.includes("running · 4.2s"), running);
		ok(!running.includes("checking src"), running);

		const later = plain(renderBashTranscriptExecution({ ...execution, elapsedMs: 9_100 }, 100));
		ok(later.includes("running · 9.1s"), "the folded running row updates in place");

		const settled = plain(
			renderBashTranscriptExecution(
				{
					...execution,
					running: false,
					exitCode: 0,
					output: "checking src\nclean\n",
					totalBytes: 40,
					truncated: true,
					fullOutputPath: "/tmp/clio-local-bash.log",
				},
				100,
			),
		);
		ok(settled.includes("ran `npm run typecheck`"), settled);
		ok(settled.includes("exit 0"), settled);
		ok(settled.includes("19B shown / 40B total"), settled);
		ok(settled.includes("truncated"), settled);
		ok(settled.includes("excluded from context"), settled);
		ok(settled.includes("full: /tmp/clio-local-bash.log"), settled);
		ok(!settled.includes("clean"), settled);
	});

	it("keeps a failed folded bash row red, exit-coded, and diagnostically useful", () => {
		const finished = {
			toolCallId: "bash-fail",
			toolName: "bash",
			args: { command: "npm test" },
			result: { content: [{ type: "text", text: "running suite\nError: 3 tests failed in auth.spec.ts\n\n" }] },
			isError: true,
			exitCode: 1,
			durationMs: 900,
		};
		const wide = renderToolSubline(finished, 120);
		const plainWide = plain(wide);
		ok(plainWide.includes("(exit 1)"), plainWide);
		ok(plainWide.includes("Error: 3 tests failed in auth.spec.ts"), plainWide);
		ok(!plainWide.includes("running suite"), "only the last non-empty output line rides the row");
		ok(wide.join("\n").includes(errorSequence), "the failed row uses the theme's error color");
		for (const line of wide) ok(visibleWidth(line) <= 120, line);

		// At 40 columns the excerpt is dropped before the exit code.
		const narrow = renderToolSubline(finished, 40);
		const plainNarrow = plain(narrow);
		ok(plainNarrow.includes("(exit 1)"), plainNarrow);
		ok(!plainNarrow.includes("auth.spec.ts"), plainNarrow);
		for (const line of narrow) ok(visibleWidth(line) <= 40, line);
	});

	it("states timeout, output-cap, and abort settlement on the folded bash row", () => {
		const timedOut = plain(
			renderToolSubline(
				{
					toolCallId: "bash-timeout",
					toolName: "bash",
					args: { command: "sleep 600" },
					result: { content: [{ type: "text", text: "" }], details: { exitCode: 124, timedOut: true, outputCapped: true } },
					isError: true,
					durationMs: 120_000,
				},
				120,
			),
		);
		ok(timedOut.includes("timed out"), timedOut);
		ok(timedOut.includes("output capped"), timedOut);
		ok(timedOut.includes("(exit 124)"), timedOut);

		const aborted = plain(
			renderToolSubline(
				{
					toolCallId: "bash-abort",
					toolName: "bash",
					args: { command: "sleep 600" },
					result: { content: [{ type: "text", text: "" }] },
					isError: true,
					outcome: "aborted",
					durationMs: 400,
				},
				120,
			),
		);
		ok(aborted.includes("aborted"), aborted);
	});
});
