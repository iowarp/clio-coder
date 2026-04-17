import { readFileSync, statSync } from "node:fs";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const readTool: ToolSpec = {
	name: ToolNames.Read,
	description: "Read a file from the filesystem. Returns the content as text.",
	baseActionClass: "read",
	async run(args): Promise<ToolResult> {
		const pathArg =
			typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (!pathArg) return { kind: "error", message: "read: missing path argument" };
		try {
			const stat = statSync(pathArg);
			if (!stat.isFile()) return { kind: "error", message: `read: not a file: ${pathArg}` };
			if (stat.size > 2_000_000) {
				return { kind: "error", message: `read: file too large (${stat.size}B > 2MB)` };
			}
			const content = readFileSync(pathArg, "utf8");
			return { kind: "ok", output: content };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `read: ${msg}` };
		}
	},
};
