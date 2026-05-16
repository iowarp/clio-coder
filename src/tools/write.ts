import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const writeTool: ToolSpec = {
	name: ToolNames.Write,
	description:
		"Write a UTF-8 text file. Creates parent directories and overwrites existing files. Use edit for surgical changes to existing files.",
	parameters: Type.Object({
		path: Type.String({ description: "Path of the file to create (relative or absolute)." }),
		content: Type.String({ description: "Full UTF-8 file contents." }),
		overwrite: Type.Optional(Type.Boolean({ description: "Deprecated compatibility flag; write overwrites files." })),
	}),
	baseActionClass: "write",
	executionMode: "sequential",
	async run(args): Promise<ToolResult> {
		const pathArg =
			typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (!pathArg) return { kind: "error", message: "write: missing path argument" };
		const content =
			typeof args.content === "string" ? args.content : args.content === undefined ? null : String(args.content);
		if (content === null) return { kind: "error", message: "write: missing content argument" };
		const filePath = resolveToCwd(pathArg);
		try {
			await withFileMutationQueue(filePath, async () => {
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, content, "utf8");
			});
			const bytes = Buffer.byteLength(content, "utf8");
			return { kind: "ok", output: `wrote ${bytes}B to ${pathArg}` };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `write: ${msg}` };
		}
	},
};
