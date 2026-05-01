import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { compileGlobRegex } from "../glob.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { loadCodewikiForTool, renderEntries } from "./shared.js";

function regexFromPattern(pattern: string): RegExp | null {
	if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
		const last = pattern.lastIndexOf("/");
		const body = pattern.slice(1, last);
		const flags = pattern.slice(last + 1);
		try {
			return new RegExp(body, flags);
		} catch {
			return null;
		}
	}
	if (/[*?[\]]/.test(pattern)) {
		try {
			return compileGlobRegex(pattern);
		} catch {
			return null;
		}
	}
	return null;
}

export const whereIsTool: ToolSpec = {
	name: ToolNames.WhereIs,
	description: "Find codewiki entries whose paths match a glob, regex, or substring.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Path glob, regex like /cli/, or plain substring." }),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
		if (pattern.length === 0) return { kind: "error", message: "where_is: missing pattern argument" };
		const loaded = loadCodewikiForTool();
		if (!loaded.ok) return { kind: "error", message: loaded.message };
		const regex = regexFromPattern(pattern);
		const entries = loaded.codewiki.entries.filter((entry) => {
			if (regex) return regex.test(entry.path);
			return entry.path.includes(pattern);
		});
		return { kind: "ok", output: renderEntries(entries) };
	},
};
