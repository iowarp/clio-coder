import { open, stat } from "node:fs/promises";
import { type EditDiffResult, generateDiffString } from "./edit-diff.js";
import { publishFileAtomically, withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveMutationTarget } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { writeToolSurface } from "./write-surface.js";

/** Below this many lines a whole-file rewrite costs about as much as an edit. */
const PARTIAL_REWRITE_MIN_LINES = 20;

/**
 * A rewrite that left at least two thirds of an existing file in place was a
 * partial change sent as the whole file. A local model trimming a notes file
 * rewrote it with write six times in one run and never called edit, resending
 * every line each time. The note steers the next change to edit without
 * refusing this write: a deliberate full rewrite stays legitimate.
 */
function partialRewriteNote(previousContent: string, diff: EditDiffResult): string | null {
	const oldLines = previousContent.split("\n").length - (previousContent.endsWith("\n") ? 1 : 0);
	if (oldLines < PARTIAL_REWRITE_MIN_LINES) return null;
	const kept = oldLines - diff.removedLines;
	if (kept * 3 < (kept + Math.max(diff.removedLines, diff.addedLines)) * 2) return null;
	return `${kept} of ${oldLines} lines were unchanged. For a partial change to an existing file use edit, which sends only the replaced text; keep write for new files and full rewrites.`;
}

export const writeTool: ToolSpec = {
	...writeToolSurface,
	async run(args, options): Promise<ToolResult> {
		const pathArg = typeof args.path === "string" ? args.path : null;
		if (!pathArg) return { kind: "error", message: "write: missing path argument" };
		const content =
			typeof args.content === "string" ? args.content : args.content === undefined ? null : String(args.content);
		if (content === null) return { kind: "error", message: "write: missing content argument" };
		const { path: filePath, physical } = resolveMutationTarget(pathArg);
		try {
			const bytes = Buffer.byteLength(content, "utf8");
			const { file, diff, previousEndedWithNewline, skipDiff, unchanged, partialRewrite } = await withFileMutationQueue(
				filePath,
				async () => {
					const previous = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return null;
						throw error;
					});
					if (previous && !previous.isFile()) throw new Error("Refusing directory or non-file target");
					let skipDiff = Math.max(previous?.size ?? 0, bytes) > 1024 * 1024;
					let previousContent = "";
					if (previous && !skipDiff) {
						const handle = await open(filePath, "r");
						try {
							// The sentinel bounds the actual read even if an external writer
							// grows or replaces the file after the earlier metadata check.
							const buffer = Buffer.allocUnsafe(1024 * 1024 + 1);
							let total = 0;
							while (total < buffer.length) {
								const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
								if (bytesRead === 0) break;
								total += bytesRead;
							}
							skipDiff = total > 1024 * 1024;
							if (!skipDiff) previousContent = buffer.toString("utf8", 0, total);
						} finally {
							await handle.close();
						}
					}
					const diffResult = skipDiff ? undefined : generateDiffString(previousContent, content);
					const diff = diffResult?.diff;
					const file = await publishFileAtomically(filePath, content, {
						...(options?.writeTargetViolation ? { admitTarget: options.writeTargetViolation } : {}),
					});
					// Only a diffed overwrite can prove the bytes did not change.
					const unchanged = previous !== null && !skipDiff && previousContent === content;
					return {
						file,
						diff,
						previousEndedWithNewline: previousContent.endsWith("\n"),
						skipDiff,
						unchanged,
						partialRewrite:
							previous !== null && diffResult !== undefined && !unchanged
								? partialRewriteNote(previousContent, diffResult)
								: null,
					};
				},
				physical,
			);
			let output = `wrote ${bytes}B to ${pathArg}`;
			if (skipDiff) output += "\nnote: diff skipped because the previous or new file exceeds 1 MiB";
			if (file.durabilityWarning) output += `\n${file.durabilityWarning}`;
			if (previousEndedWithNewline && !content.endsWith("\n")) {
				output += `\nnote: ${pathArg} no longer ends with a newline; the previous content did`;
			}
			if (partialRewrite !== null) output += `\nnote: ${partialRewrite}`;
			// The transcript ledger sizes a call from details.observation.shownBytes
			// before it falls back to the length of the returned text. A write's
			// text is a confirmation sentence, so without this the ledger printed
			// the sentence's length as the file size.
			return {
				kind: "ok",
				output,
				details: {
					file: { before: file.before, after: file.after },
					diff,
					paths: [filePath],
					...(unchanged ? { unchanged: true } : {}),
					observation: { shownBytes: bytes },
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `write: Nothing was published. ${msg}` };
		}
	},
};
