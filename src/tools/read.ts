import { readFileSync, statSync } from "node:fs";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

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
		const filePath = resolveReadPath(pathArg);
		const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : null;
		try {
			const stat = statSync(filePath);
			if (!stat.isFile()) return { kind: "error", message: `read: not a file: ${filePath}` };
			if (stat.size > 20_000_000) {
				return { kind: "error", message: `read: file too large (${stat.size}B > 20MB); use bash with sed/head` };
			}
			const content = readFileSync(filePath, "utf8");
			const allLines = content.split("\n");
			const totalLines = allLines.length;
			const startIndex = Math.min(offset - 1, totalLines);
			if (offset > 1 && startIndex >= totalLines) {
				return { kind: "error", message: `read: offset ${offset} is beyond end of file (${totalLines} lines total)` };
			}
			const selected =
				limit !== null
					? allLines.slice(startIndex, Math.min(startIndex + limit, totalLines)).join("\n")
					: allLines.slice(startIndex).join("\n");
			const truncation = truncateHead(selected);
			let output: string;
			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(Buffer.byteLength(allLines[startIndex] ?? "", "utf8"));
				output = `[Line ${startIndex + 1} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startIndex + 1}p' ${pathArg} | head -c ${DEFAULT_MAX_BYTES}]`;
			} else if (truncation.truncated) {
				const endDisplay = startIndex + truncation.outputLines;
				const nextOffset = endDisplay + 1;
				output = truncation.content;
				const suffix =
					truncation.truncatedBy === "lines"
						? `[Showing lines ${startIndex + 1}-${endDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
						: `[Showing lines ${startIndex + 1}-${endDisplay} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				output += `\n\n${suffix}`;
			} else if (limit !== null && startIndex + truncation.outputLines < totalLines) {
				const nextOffset = startIndex + truncation.outputLines + 1;
				const remaining = totalLines - (startIndex + truncation.outputLines);
				output = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				output = truncation.content;
			}
			return {
				kind: "ok",
				output,
				...(truncation.truncated ? { details: { truncation } } : {}),
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") {
				return {
					kind: "error",
					message: `read: ${msg}. File not found at ${pathArg}. The path may be wrong (e.g. wrong extension; codewiki indexes only .ts/.tsx). Try: where_is, find, glob, or ls to locate it.`,
				};
			}
			return { kind: "error", message: `read: ${msg}` };
		}
	},
};
