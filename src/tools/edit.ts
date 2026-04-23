import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const editTool: ToolSpec = {
	name: ToolNames.Edit,
	description: "Search-and-replace on a file. old_string must match exactly once unless replace_all=true.",
	parameters: Type.Object(
		{
			path: Type.String({ description: "Absolute or relative path to the file to edit." }),
			old_string: Type.String({ description: "Exact substring to replace. Must be non-empty." }),
			new_string: Type.String({ description: "Replacement substring. May be empty to delete." }),
			replace_all: Type.Optional(
				Type.Boolean({ description: "Set true to replace every occurrence. Defaults to false (single match required)." }),
			),
		},
		{ additionalProperties: false },
	),
	baseActionClass: "write",
	async run(args): Promise<ToolResult> {
		const pathArg =
			typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (!pathArg) return { kind: "error", message: "edit: missing path argument" };
		if (typeof args.old_string !== "string") {
			return { kind: "error", message: "edit: missing old_string argument" };
		}
		if (typeof args.new_string !== "string") {
			return { kind: "error", message: "edit: missing new_string argument" };
		}
		const oldStr = args.old_string;
		const newStr = args.new_string;
		const replaceAll = args.replace_all === true;
		if (oldStr.length === 0) {
			return { kind: "error", message: "edit: old_string must not be empty" };
		}
		try {
			const original = readFileSync(pathArg, "utf8");
			let replacements = 0;
			let updated: string;
			if (replaceAll) {
				const parts = original.split(oldStr);
				replacements = parts.length - 1;
				updated = parts.join(newStr);
			} else {
				const first = original.indexOf(oldStr);
				if (first === -1) {
					return { kind: "error", message: `edit: old_string not found in ${pathArg}` };
				}
				const second = original.indexOf(oldStr, first + oldStr.length);
				if (second !== -1) {
					return {
						kind: "error",
						message: `edit: old_string matches multiple times in ${pathArg}; pass replace_all=true or provide more context`,
					};
				}
				updated = original.slice(0, first) + newStr + original.slice(first + oldStr.length);
				replacements = 1;
			}
			if (replacements === 0) {
				return { kind: "error", message: `edit: old_string not found in ${pathArg}` };
			}
			const tmp = join(dirname(pathArg), `.${Date.now()}.${process.pid}.clio-edit.tmp`);
			writeFileSync(tmp, updated, "utf8");
			renameSync(tmp, pathArg);
			return { kind: "ok", output: `edited ${pathArg}: ${replacements} replacement(s)` };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `edit: ${msg}` };
		}
	},
};
