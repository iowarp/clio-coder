import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const writeTool: ToolSpec = {
	name: ToolNames.Write,
	description: "Write a file to the filesystem. Refuses to overwrite an existing file unless overwrite=true.",
	parameters: Type.Object(
		{
			path: Type.String({ description: "Absolute or relative path of the file to create." }),
			content: Type.String({ description: "Full UTF-8 file contents." }),
			overwrite: Type.Optional(Type.Boolean({ description: "Set true to replace an existing file. Defaults to false." })),
		},
		{ additionalProperties: false },
	),
	baseActionClass: "write",
	executionMode: "sequential",
	async run(args): Promise<ToolResult> {
		const pathArg =
			typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (!pathArg) return { kind: "error", message: "write: missing path argument" };
		const content =
			typeof args.content === "string" ? args.content : args.content === undefined ? null : String(args.content);
		if (content === null) return { kind: "error", message: "write: missing content argument" };
		const overwrite = args.overwrite === true;
		try {
			if (existsSync(pathArg) && !overwrite) {
				return {
					kind: "error",
					message: `write: refusing to overwrite existing file: ${pathArg} (pass overwrite=true)`,
				};
			}
			mkdirSync(dirname(pathArg), { recursive: true });
			writeFileSync(pathArg, content, "utf8");
			const bytes = Buffer.byteLength(content, "utf8");
			return { kind: "ok", output: `wrote ${bytes}B to ${pathArg}` };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `write: ${msg}` };
		}
	},
};
