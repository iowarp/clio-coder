import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const CODE_NAV_DEFAULT_LIMIT = 50;
export const CODE_NAV_DEFAULT_ENTRY_LIMIT = 25;
export const CODE_NAV_MAX_LIMIT = 200;
export const CODE_NAV_DEFAULT_RELATED_LIMIT = 40;

export const codeNavToolSurface = {
	name: ToolNames.CodeNav,
	description:
		"Navigate a codemap: symbol finds definitions, path matches paths, entries lists entry candidates, outline lists symbols, deps lists imports, dependents lists importers. related=true on symbol or exact-path outline returns one bounded bundle of definitions, the owning file, direct imports, importers and test importers; use it before a change instead of chaining outline/deps/dependents. project returns orientation, current Git and operator tasks; recorded status is not verification. wiki lists pages or resolves query to a summary and readable path. For Clio product docs use clio_docs through gateway.",
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
				description: `Max results (default ${CODE_NAV_DEFAULT_LIMIT}, entries ${CODE_NAV_DEFAULT_ENTRY_LIMIT}, related ${CODE_NAV_DEFAULT_RELATED_LIMIT} across the whole bundle, max ${CODE_NAV_MAX_LIMIT}).`,
			}),
		),
		related: Type.Optional(
			Type.Boolean({
				description:
					"symbol/outline only: add the owning file's direct import neighborhood. Importers are import edges, not call sites; test importers are check hints, not coverage.",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
