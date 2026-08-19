/**
 * Adapt Clio's shared TUI transcript projection to semantic HTML tool rows.
 * pi-coding-agent 0.84.0 uses the same TUI-render-then-ANSI-convert pattern in
 * `dist/core/export-html/tool-renderer.js`; Clio keeps its own transcript model
 * and tool renderers, so the adaptation operates on their rendered lines.
 */
import { stripTerminalSequences } from "../../engine/tui.js";
import { ansiLinesToHtml, escapeHtml } from "./ansi-to-html.js";

interface TranscriptBlock {
	kind: "tool" | "transcript";
	toolName?: string;
	lines: string[];
}

function toolNameFromHeader(line: string): string | null {
	const plain = stripTerminalSequences(line);
	return /^\s*▸\s+([^\s(]+)/u.exec(plain)?.[1] ?? null;
}

function isToolBodyLine(line: string): boolean {
	return /^\s*[│╰]/u.test(stripTerminalSequences(line));
}

function blocksFromLines(lines: ReadonlyArray<string>): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	for (const line of lines) {
		const name = toolNameFromHeader(line);
		if (name !== null) {
			blocks.push({ kind: "tool", toolName: name, lines: [line] });
			continue;
		}
		const previous = blocks[blocks.length - 1];
		if (previous?.kind === "tool" && isToolBodyLine(line)) {
			previous.lines.push(line);
			continue;
		}
		if (previous?.kind === "transcript") previous.lines.push(line);
		else blocks.push({ kind: "transcript", lines: [line] });
	}
	return blocks;
}

export function renderTranscriptHtml(lines: ReadonlyArray<string>): string {
	return blocksFromLines(lines)
		.map((block) => {
			const body = ansiLinesToHtml(block.lines);
			if (block.kind === "tool") {
				return `<section class="tool-row" data-tool="${escapeHtml(block.toolName ?? "unknown")}">${body}</section>`;
			}
			return `<div class="transcript-row">${body}</div>`;
		})
		.join("\n");
}
