import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { hookLandingRefusal } from "./tool-landing.js";

/** ASCII whitespace, the separators `wc -w` splits words on in the C locale. */
function isSpaceByte(byte: number): boolean {
	return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

interface FileCounts {
	words: number;
	lines: number;
	bytes: number;
}

/** Streams the file, so a large one is counted without being held in memory. */
async function countFile(filePath: string, signal: AbortSignal | undefined): Promise<FileCounts> {
	let words = 0;
	let newlines = 0;
	let bytes = 0;
	let inWord = false;
	let last = -1;
	const stream = createReadStream(filePath, signal ? { signal } : {});
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		bytes += chunk.length;
		for (const byte of chunk) {
			if (byte === 0x0a) newlines++;
			if (isSpaceByte(byte)) inWord = false;
			else if (!inWord) {
				inWord = true;
				words++;
			}
		}
		last = chunk[chunk.length - 1] ?? last;
	}
	// A last line with no trailing newline is still a line; `wc -l` would miss it.
	const lines = newlines + (bytes > 0 && last !== 0x0a ? 1 : 0);
	return { words, lines, bytes };
}

/**
 * A file's word, line and byte counts. A delegated worker without bash had no
 * way to check its own length against a budget except reading the file and
 * estimating (WTF-P 0.8.3 B3). Words are runs of non-whitespace, as `wc -w`
 * counts them; an extension that counts by its own rule (markup excluded, say)
 * stays the authority for its budgets.
 */
export const countTool: ToolSpec = {
	name: ToolNames.Count,
	description:
		"Count a file's words (whitespace-separated runs, as wc -w), lines and bytes without reading it into context.",
	parameters: Type.Object({
		path: Type.String({ description: "File to count." }),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		if (typeof args.path !== "string" || args.path.length === 0) {
			return { kind: "error", message: "count: path is required" };
		}
		const filePath = resolveReadPath(args.path);
		const moved = hookLandingRefusal(ToolNames.Count, options?.hookLanding, filePath);
		if (moved !== null) return { kind: "error", message: moved };
		try {
			const entry = await stat(filePath);
			if (!entry.isFile()) return { kind: "error", message: `count: not a file: ${args.path}` };
			const counts = await countFile(filePath, options?.signal);
			return {
				kind: "ok",
				output: `${args.path}: ${counts.words} words, ${counts.lines} lines, ${counts.bytes} bytes`,
				details: { path: filePath, ...counts },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `count: ${msg}` };
		}
	},
};
