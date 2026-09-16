import { open, stat } from "node:fs/promises";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { generateDiffString } from "./edit-diff.js";
import { publishFileAtomically, withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const writeTool: ToolSpec = {
	name: ToolNames.Write,
	description:
		"Write a UTF-8 text file, creating parent directories and overwriting existing files. Publishes atomically through symlinks, preserving mode bits. In-process writes are serialized; external writers are not locked and the last rename wins. Use edit for surgical changes.",
	parameters: Type.Object({
		path: Type.String({ description: "File path (relative or absolute)." }),
		content: Type.String({ description: "Full UTF-8 file contents." }),
	}),
	baseActionClass: "write",
	executionMode: "sequential",
	async run(args): Promise<ToolResult> {
		const pathArg = typeof args.path === "string" ? args.path : null;
		if (!pathArg) return { kind: "error", message: "write: missing path argument" };
		const content =
			typeof args.content === "string" ? args.content : args.content === undefined ? null : String(args.content);
		if (content === null) return { kind: "error", message: "write: missing content argument" };
		const filePath = resolveToCwd(pathArg);
		try {
			const bytes = Buffer.byteLength(content, "utf8");
			const { file, diff, previousEndedWithNewline, skipDiff } = await withFileMutationQueue(filePath, async () => {
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
				const diff = skipDiff ? undefined : generateDiffString(previousContent, content).diff;
				const file = await publishFileAtomically(filePath, content);
				return { file, diff, previousEndedWithNewline: previousContent.endsWith("\n"), skipDiff };
			});
			let output = `wrote ${bytes}B to ${pathArg}`;
			if (skipDiff) output += "\nnote: diff skipped because the previous or new file exceeds 1 MiB";
			if (file.durabilityWarning) output += `\n${file.durabilityWarning}`;
			if (previousEndedWithNewline && !content.endsWith("\n")) {
				output += `\nnote: ${pathArg} no longer ends with a newline; the previous content did`;
			}
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
					observation: { shownBytes: bytes },
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `write: Nothing was published. ${msg}` };
		}
	},
};
