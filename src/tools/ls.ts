import { lstatSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const MAX_ENTRIES = 1000;

function entryType(stat: Stats): "d" | "f" | "l" {
	if (stat.isSymbolicLink()) return "l";
	if (stat.isDirectory()) return "d";
	return "f";
}

export const lsTool: ToolSpec = {
	name: ToolNames.Ls,
	description: "List directory entries. Prefer this over `bash ls` for file exploration.",
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Directory to list. Defaults to the orchestrator cwd." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const rootArg = typeof args.path === "string" ? args.path : process.cwd();
		const root = path.resolve(rootArg);

		let rootStat: Stats;
		try {
			rootStat = lstatSync(root);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `ls: ${msg}` };
		}

		if (!rootStat.isDirectory()) {
			return { kind: "error", message: `ls: not a directory: ${root}` };
		}

		try {
			const entries = readdirSync(root, { withFileTypes: true })
				.map((entry) => {
					const absPath = path.join(root, entry.name);
					const stat = lstatSync(absPath);
					return {
						name: entry.name,
						size: stat.size,
						type: entryType(stat),
					};
				})
				.sort((a, b) => a.name.localeCompare(b.name));

			return {
				kind: "ok",
				output: entries
					.slice(0, MAX_ENTRIES)
					.map((entry) => `${entry.type}  ${String(entry.size).padStart(6, " ")}  ${entry.name}`)
					.join("\n"),
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `ls: ${msg}` };
		}
	},
};
