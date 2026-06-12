import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const writeTool: ToolSpec = {
	name: ToolNames.Write,
	description:
		"Write a UTF-8 text file, creating parent directories and overwriting existing files. Use edit for surgical changes.",
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
			let previousEndedWithNewline = false;
			await withFileMutationQueue(filePath, async () => {
				try {
					previousEndedWithNewline = readFileSync(filePath, "utf8").endsWith("\n");
				} catch {
					previousEndedWithNewline = false;
				}
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, content, "utf8");
			});
			const bytes = Buffer.byteLength(content, "utf8");
			let output = `wrote ${bytes}B to ${pathArg}`;
			if (previousEndedWithNewline && !content.endsWith("\n")) {
				output += `\nnote: ${pathArg} no longer ends with a newline; the previous content did`;
			}
			return { kind: "ok", output };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `write: ${msg}` };
		}
	},
};
