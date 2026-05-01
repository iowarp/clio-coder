import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { loadCodewikiForTool, renderEntries } from "./shared.js";

export const findSymbolTool: ToolSpec = {
	name: ToolNames.FindSymbol,
	description: "Find codewiki entries that export the requested symbol.",
	parameters: Type.Object({
		symbol: Type.String({ description: "Exported symbol name to look up." }),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
		if (symbol.length === 0) return { kind: "error", message: "find_symbol: missing symbol argument" };
		const loaded = loadCodewikiForTool();
		if (!loaded.ok) return { kind: "error", message: loaded.message };
		const entries = loaded.codewiki.entries.filter((entry) => entry.exports.includes(symbol));
		return { kind: "ok", output: renderEntries(entries) };
	},
};
