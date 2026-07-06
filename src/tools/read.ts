import { readFileSync, statSync } from "node:fs";
import { Type } from "typebox";
import { GUARDRAIL_DEFAULTS, GUARDRAIL_ENV_VARS, resolveGuardrail } from "../core/guardrails.js";
import { ToolNames } from "../core/tool-names.js";
import { finalizeObservation, observationBudgetExhausted, reserveObservation } from "./observation.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import {
	DEFAULT_MAX_LINES,
	formatSize,
	splitLinesForCounting,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "./truncate.js";
import { truncateUtf8 } from "./truncate-utf8.js";

// Per-call read cap. Raised from the 16KB per-observation source cap toward
// pi's 50KB so large source/generated files finish in fewer calls (a 144KB file
// took ~9 sequential 16KB reads before). The per-turn observation budget
// (src/tools/observation.ts) still bounds the aggregate. Value, settings key,
// and env override (CLIO_READ_MAX_BYTES) live in core/guardrails.ts.
export const DEFAULT_READ_MAX_BYTES = GUARDRAIL_DEFAULTS.readMaxBytes;
export const READ_MAX_BYTES_ENV = GUARDRAIL_ENV_VARS.readMaxBytes;
const MIN_READ_CAP_BYTES = 1024;

export function readMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	return Math.max(MIN_READ_CAP_BYTES, resolveGuardrail("readMaxBytes", env));
}

export const readTool: ToolSpec = {
	name: ToolNames.Read,
	description: `Read a UTF-8 text file. Output is capped at ${DEFAULT_MAX_LINES} lines or ${
		DEFAULT_READ_MAX_BYTES / 1024
	}KB per call; truncated results say how to continue with offset/limit. Pass tail=N to read the last N lines (jump to EOF) instead of paging from the top.`,
	parameters: Type.Object({
		path: Type.String({ description: "File path (relative or absolute)." }),
		offset: Type.Optional(Type.Number({ description: "1-indexed start line." })),
		limit: Type.Optional(Type.Number({ description: "Max lines to read." })),
		tail: Type.Optional(
			Type.Number({ description: "Read the last N lines of the file (jump to EOF). Overrides offset/limit." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pathArg = typeof args.path === "string" ? args.path : null;
		if (!pathArg) return { kind: "error", message: "read: missing path argument" };
		const filePath = resolveReadPath(pathArg);
		const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : null;
		const tail = typeof args.tail === "number" && args.tail > 0 ? Math.floor(args.tail) : null;
		const reservation = reserveObservation(readMaxBytes(), options);
		try {
			const stat = statSync(filePath);
			if (!stat.isFile()) return { kind: "error", message: `read: not a file: ${filePath}` };
			if (stat.size > 20_000_000) {
				return {
					kind: "error",
					message: `read: file too large (${stat.size}B > 20MB). Use grep/find to locate the relevant section or read a smaller generated/source file; use shell access only when byte-level inspection is explicitly needed.`,
				};
			}
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: ToolNames.Read,
					unit: "lines",
					reservation,
					subject: `reading ${pathArg}`,
					hint: "Use offset/limit in a follow-up turn or grep/find for a narrower section.",
				});
			}
			const content = readFileSync(filePath, "utf8");
			// Slice from the raw split (keeps the trailing newline on selections that
			// reach EOF); count lines honestly (a trailing "\n" is a terminator, not
			// a phantom extra line) so continuation notices never over-report by one.
			const allLines = content.split("\n");
			const totalLines = splitLinesForCounting(content).length;
			const totalBytes = Buffer.byteLength(content, "utf8");
			const startIndex = Math.min(offset - 1, totalLines);
			if (tail === null && offset > 1 && startIndex >= totalLines) {
				// The anchor matters for weak models: a bare "beyond end of file"
				// reads as a paging mistake and triggers a tail-re-reading walk. Say
				// plainly that nothing exists past the last line and that re-reading
				// cannot produce new content.
				return {
					kind: "error",
					message:
						`read: offset ${offset} is beyond end of file (${totalLines} lines total). The file ends at line ` +
						`${totalLines} and has no further content; do not page past it or re-read the tail — a read covering ` +
						`line ${totalLines} has already returned everything.`,
				};
			}
			const cap = reservation.callCapBytes;

			if (tail !== null) {
				// Jump to EOF: keep the last N lines, then bound by the byte cap from
				// the end (reusing truncateTail) so the very tail always survives.
				const startLine = Math.max(0, totalLines - tail);
				const tailContent = allLines.slice(startLine).join("\n");
				const truncation = truncateTail(tailContent, { maxBytes: cap, maxLines: tail });
				const shownLines = truncation.outputLines;
				const firstShown = Math.max(1, totalLines - shownLines + 1);
				const truncated = startLine > 0 || truncation.truncated;
				return finalizeObservation({
					tool: ToolNames.Read,
					unit: "lines",
					output: truncation.content,
					shownCount: shownLines,
					totalCount: totalLines,
					totalBytes,
					truncated,
					...(truncated ? { next: `offset=${Math.max(1, firstShown - shownLines)} limit=${shownLines}` } : {}),
					reservation,
					...(options ? { options } : {}),
				});
			}

			const selected =
				limit !== null ? allLines.slice(startIndex, startIndex + limit).join("\n") : allLines.slice(startIndex).join("\n");
			const truncation: TruncationResult = truncateHead(selected, { maxBytes: cap });
			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(Buffer.byteLength(allLines[startIndex] ?? "", "utf8"));
				const linePrefix = truncateUtf8(allLines[startIndex] ?? "", cap, "\n[line truncated]");
				const output = `${linePrefix}\n\n[Line ${startIndex + 1} is ${firstLineSize}, exceeding the ${formatSize(cap)} read limit. Showing the UTF-8 prefix only. Use grep with a narrower literal/regex or edit with exact surrounding text; use shell access only when byte-level inspection is required.]`;
				return finalizeObservation({
					tool: ToolNames.Read,
					unit: "lines",
					output,
					shownCount: 0,
					totalCount: totalLines,
					totalBytes,
					truncated: true,
					omitNotice: true,
					reservation,
					...(options ? { options } : {}),
				});
			}
			const endDisplay = startIndex + truncation.outputLines;
			const moreAfter = endDisplay < totalLines;
			const truncated = truncation.truncated || (limit !== null && moreAfter);
			return finalizeObservation({
				tool: ToolNames.Read,
				unit: "lines",
				output: truncation.content,
				shownCount: truncation.outputLines,
				totalCount: totalLines,
				totalBytes,
				truncated,
				...(truncated && moreAfter ? { next: `offset=${endDisplay + 1}` } : {}),
				reservation,
				...(options ? { options } : {}),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") {
				return {
					kind: "error",
					message: `read: ${msg}. File not found at ${pathArg}. The path may be wrong. Try: code_nav, find, or ls to locate it.`,
				};
			}
			return { kind: "error", message: `read: ${msg}` };
		}
	},
};
