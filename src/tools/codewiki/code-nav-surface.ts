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
		"Navigate a codemap: symbol finds definitions, path matches paths, entries lists entry candidates, outline lists symbols, deps lists imports, dependents lists importers. project returns orientation, current Git and operator tasks; recorded status is not verification. wiki lists pages or resolves query to a summary and readable path. For Clio product docs use clio_docs through gateway.",
	parameters: Type.Object({
		source: Type.Optional(
			StringEnum(["workspace", "clio"], {
				description: "Code map source (default workspace).",
				default: "workspace",
			}),
		),
		mode: StringEnum(["symbol", "path", "entries", "outline", "deps", "dependents", "wiki", "project"], {
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
