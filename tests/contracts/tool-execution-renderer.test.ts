import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { renderDiffLines } from "../../src/interactive/renderers/diff.js";
import { renderBashTranscriptExecution, renderToolExecution } from "../../src/interactive/renderers/tool-execution.js";
import { createClioTheme } from "../../src/interactive/theme/index.js";

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
});
