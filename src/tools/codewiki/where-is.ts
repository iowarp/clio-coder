import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { compileGlobRegex } from "../glob.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { loadCodewikiForTool, renderEntries } from "./shared.js";

const REGEX_SYNTAX_HINTS = /\.\*|\.\+|\^|\$|\\[dDwWsSbB]|\(\?:|\(\?=|\(\?!/;

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
	if (REGEX_SYNTAX_HINTS.test(pattern)) {
		try {
			return new RegExp(pattern);
		} catch {
			// fall through to glob or substring
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
	description:
		"Find codewiki entries whose paths match a glob, regex, or substring. Codewiki indexes TypeScript only, so paths end in .ts or .tsx. Patterns: glob (e.g. src/interactive/*.ts), bare regex (e.g. .*tui.* or ^src/cli/), regex literal (/cli/i), or substring (e.g. tui). Empty entries means zero matches, so broaden the pattern, switch syntax, or use the glob tool.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Pattern: glob, bare regex like .*tui.*, /regex/flags, or substring." }),
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
