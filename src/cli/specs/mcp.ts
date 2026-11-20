import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["mcp"],
	summary: "list, test and trust declared MCP servers",
	hidden: false,
});
