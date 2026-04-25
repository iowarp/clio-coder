import { readFileSync, statSync } from "node:fs";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 100 * 1024;

export const readTool: ToolSpec = {
	name: ToolNames.Read,
	description: `Read the contents of a file as UTF-8 text. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${
		DEFAULT_MAX_BYTES / 1024
	}KB (whichever hits first). Use offset/limit for large files; when the result is truncated, continue with the suggested offset until complete.`,
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file to read (relative or absolute)." }),
		offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)." })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const pathArg =
			typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (!pathArg) return { kind: "error", message: "read: missing path argument" };
		const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : null;
		try {
			const stat = statSync(pathArg);
			if (!stat.isFile()) return { kind: "error", message: `read: not a file: ${pathArg}` };
			if (stat.size > 20_000_000) {
				return { kind: "error", message: `read: file too large (${stat.size}B > 20MB); use bash with sed/head` };
			}
			const content = readFileSync(pathArg, "utf8");
			const allLines = content.split("\n");
			const totalLines = allLines.length;
			const startIndex = Math.min(offset - 1, totalLines);
			if (offset > 1 && startIndex >= totalLines) {
				return { kind: "error", message: `read: offset ${offset} is beyond end of file (${totalLines} lines total)` };
			}
			const sliceEnd = limit !== null ? Math.min(startIndex + limit, totalLines) : totalLines;
			const selected = allLines.slice(startIndex, sliceEnd).join("\n");
			let output = selected;
			let truncated = false;
			let truncatedBy: "lines" | "bytes" | null = null;
			let outputLines = sliceEnd - startIndex;
			if (limit === null && outputLines > DEFAULT_MAX_LINES) {
				outputLines = DEFAULT_MAX_LINES;
				output = allLines.slice(startIndex, startIndex + DEFAULT_MAX_LINES).join("\n");
				truncated = true;
				truncatedBy = "lines";
			}
			if (Buffer.byteLength(output, "utf8") > DEFAULT_MAX_BYTES) {
				const buf = Buffer.from(output, "utf8");
				const trimmed = buf.subarray(0, DEFAULT_MAX_BYTES).toString("utf8");
				const trimmedLines = trimmed.split("\n");
				if (trimmedLines.length > 1) trimmedLines.pop();
				output = trimmedLines.join("\n");
				outputLines = trimmedLines.length;
				truncated = true;
				truncatedBy = truncatedBy ?? "bytes";
			}
			if (truncated) {
				const startDisplay = startIndex + 1;
				const endDisplay = startIndex + outputLines;
				const nextOffset = endDisplay + 1;
				const reason = truncatedBy === "bytes" ? `${DEFAULT_MAX_BYTES / 1024}KB limit` : `${DEFAULT_MAX_LINES}-line limit`;
				output += `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalLines} (${reason}). Use offset=${nextOffset} to continue.]`;
			} else if (limit !== null && startIndex + outputLines < totalLines) {
				const nextOffset = startIndex + outputLines + 1;
				const remaining = totalLines - (startIndex + outputLines);
				output += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			}
			return { kind: "ok", output };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `read: ${msg}` };
		}
	},
};
