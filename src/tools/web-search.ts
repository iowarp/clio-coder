import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const webSearchTool: ToolSpec = {
	name: ToolNames.WebSearch,
	description: "Search the web. Returns top results with title + snippet + URL.",
	baseActionClass: "read",
	async run(args): Promise<ToolResult> {
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (!query) return { kind: "error", message: "web_search: missing query" };
		const output = [
			`web_search stub for query: ${query}`,
			"",
			"This runtime ships without a configured search provider.",
			"Install a search credential via /providers to enable web results.",
		].join("\n");
		return { kind: "ok", output };
	},
};
