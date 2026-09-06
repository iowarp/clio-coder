import { readFileSync, statSync } from "node:fs";
import { Type } from "typebox";
import { GUARDRAIL_DEFAULTS, resolveGuardrail } from "../core/guardrails.js";
import { ToolNames } from "../core/tool-names.js";
import { finalizeObservation, observationBudgetExhausted, reserveObservation } from "./observation.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { isSessionOffloadPath } from "./result-shaping.js";
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
// (src/tools/observation.ts) still bounds the aggregate. The configurable
// value lives at safety.limits.readBytesPerCall.
export const DEFAULT_READ_MAX_BYTES = GUARDRAIL_DEFAULTS.readMaxBytes;
const MIN_READ_CAP_BYTES = 1024;

export function readMaxBytes(): number {
	return Math.max(MIN_READ_CAP_BYTES, resolveGuardrail("readMaxBytes"));
}

// Number only an already bounded slice, retaining its explicit physical line
// count: a truncated slice ending in a blank line can look like a terminator.
function numberSourceLines(content: string, firstLine: number, lineCount: number): string {
	return content
		.split("\n")
		.map((line, index) => (index < lineCount ? `${firstLine + index} | ${line}` : line))
		.join("\n");
}

function numberedPrefixBytes(totalLines: number): number {
	let bytes = totalLines * 3; // " | " after each decimal source line number.
	for (let first = 1, digits = 1; first <= totalLines; first *= 10, digits++) {
		bytes += (Math.min(totalLines + 1, first * 10) - first) * digits;
	}
	return bytes;
}

export const readTool: ToolSpec = {
	name: ToolNames.Read,
	description: `Read a UTF-8 text file. Output is capped at ${DEFAULT_MAX_LINES} lines or ${
		DEFAULT_READ_MAX_BYTES / 1024
	}KB per call; truncated results say how to continue with offset/limit. Pass tail=N to read the last N lines (jump to EOF) instead of paging from the top. Set line_numbers=true for citations: each source line is prefixed with its physical 1-based line number and " | "; these labels are not file content.`,
	parameters: Type.Object({
		path: Type.String({ description: "File path (relative or absolute)." }),
		line_numbers: Type.Optional(
			Type.Boolean({
				description: "Display physical source line numbers for citations. Default false preserves plain text.",
			}),
		),
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
		const numbered = args.line_numbers === true;
		const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : null;
		const tail = typeof args.tail === "number" && args.tail > 0 ? Math.floor(args.tail) : null;
		// Reading the session's own offload files bypasses the shared turn pool
		// (an optionless reservation is untracked): the "full: <path>" escape
		// hatch appears exactly when the pool is exhausted, so charging these
		// reads to it made the hatch a dead end. The per-call byte cap still
		// bounds each slice.
		const reservation = isSessionOffloadPath(filePath, options?.sessionId)
			? reserveObservation(readMaxBytes())
			: reserveObservation(readMaxBytes(), options);
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
			const totalBytes = Buffer.byteLength(content, "utf8") + (numbered ? numberedPrefixBytes(totalLines) : 0);
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
				const sourceTruncation = truncateTail(tailContent, { maxBytes: cap, maxLines: tail });
				let truncation = sourceTruncation;
				if (numbered) {
					const numberedContent = numberSourceLines(
						sourceTruncation.content,
						totalLines - sourceTruncation.outputLines + 1,
						sourceTruncation.outputLines,
					);
					truncation = truncateTail(numberedContent, { maxBytes: cap, maxLines: tail });
					if (sourceTruncation.lastLinePartial || truncation.lastLinePartial) {
						// Never return a tail fragment with a lost or fabricated complete
						// line label. Keep the suffix within the cap and mark it partial.
						const label = `${totalLines} | [partial line suffix] `;
						const suffix = truncateTail(allLines[totalLines - 1] ?? "", { maxBytes: cap - Buffer.byteLength(label) });
						truncation = { ...truncation, content: label + suffix.content, outputLines: 0, truncated: true };
					}
				}
				const shownLines = truncation.outputLines;
				const firstShown = Math.max(1, totalLines - shownLines + 1);
				const truncated = startLine > 0 || sourceTruncation.truncated || truncation.truncated;
				return finalizeObservation({
					tool: ToolNames.Read,
					unit: "lines",
					output: truncation.content,
					shownCount: shownLines,
					totalCount: totalLines,
					totalBytes,
					truncated,
					...(truncated && shownLines > 0
						? {
								next: `offset=${Math.max(1, firstShown - shownLines)} limit=${shownLines}${numbered ? " line_numbers=true" : ""}`,
							}
						: {}),
					reservation,
					...(options ? { options } : {}),
				});
			}

			const endIndex = limit !== null ? Math.min(startIndex + limit, totalLines) : totalLines;
			// Preserve the last selected source line's terminator when it exists.
			// Joining a limited slice alone turns ["x", ""] into "x\n", which
			// truncateHead counts as one line; [""] even becomes an empty file.
			// The raw split's final entry tells us whether that newline is real,
			// without inventing a line at EOF or changing shared text counting.
			const selected =
				allLines.slice(startIndex, endIndex).join("\n") + (endIndex > startIndex && endIndex < allLines.length ? "\n" : "");
			const sourceTruncation = truncateHead(selected, { maxBytes: cap });
			const truncation: TruncationResult =
				numbered && !sourceTruncation.firstLineExceedsLimit
					? truncateHead(numberSourceLines(sourceTruncation.content, startIndex + 1, sourceTruncation.outputLines), {
							maxBytes: cap,
						})
					: sourceTruncation;
			if (truncation.firstLineExceedsLimit) {
				const label = numbered ? `${startIndex + 1} | ` : "";
				const firstLineSize = formatSize(Buffer.byteLength(label + (allLines[startIndex] ?? ""), "utf8"));
				const linePrefix =
					label + truncateUtf8(allLines[startIndex] ?? "", cap - Buffer.byteLength(label), "\n[line truncated]");
				const output = `${linePrefix}\n\n[${numbered ? "Numbered line" : "Line"} ${startIndex + 1} is ${firstLineSize}, exceeding the ${formatSize(cap)} read limit. Showing the UTF-8 prefix only. Use grep with a narrower literal/regex or edit with exact surrounding text; use shell access only when byte-level inspection is required.]`;
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
			const truncated = sourceTruncation.truncated || truncation.truncated || (limit !== null && moreAfter);
			return finalizeObservation({
				tool: ToolNames.Read,
				unit: "lines",
				output: truncation.content,
				shownCount: truncation.outputLines,
				totalCount: totalLines,
				totalBytes,
				truncated,
				...(truncated && moreAfter ? { next: `offset=${endDisplay + 1}${numbered ? " line_numbers=true" : ""}` } : {}),
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
