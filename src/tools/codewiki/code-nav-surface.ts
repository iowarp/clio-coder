import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const CODE_NAV_DEFAULT_LIMIT = 50;
export const CODE_NAV_DEFAULT_ENTRY_LIMIT = 25;
export const CODE_NAV_MAX_LIMIT = 200;

export const codeNavToolSurface = {
	name: ToolNames.CodeNav,
	description:
		"Navigate the indexed codewiki: mode=symbol finds files by symbol, path finds files by glob/regex/substring, entries lists likely entry points, outline lists file symbols, deps lists imports, and dependents lists importers. mode=wiki without query lists generated Markdown wiki pages; with query it resolves a page id/title and returns its summary plus a path to open with read. For Clio's bundled product docs use context scope=docs.",
	parameters: Type.Object({
		mode: StringEnum(["symbol", "path", "entries", "outline", "deps", "dependents", "wiki"], {
			description: "Lookup mode.",
		}),
		query: Type.Optional(
			Type.String({ description: "Symbol name, indexed path/pattern/substring, or wiki page id/title." }),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Max results (default ${CODE_NAV_DEFAULT_LIMIT}, entries ${CODE_NAV_DEFAULT_ENTRY_LIMIT}, max ${CODE_NAV_MAX_LIMIT}).`,
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
