import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const CODE_NAV_DEFAULT_LIMIT = 50;
export const CODE_NAV_DEFAULT_ENTRY_LIMIT = 25;
export const CODE_NAV_MAX_LIMIT = 200;
export const CODE_NAV_DEFAULT_RELATED_LIMIT = 40;

export const codeNavToolSurface: ToolSurface = {
	name: ToolNames.CodeNav,
	description:
		"Navigate a codemap: symbol (definitions), path, entries (entry candidates), outline (symbols), deps (imports), dependents (importers). related=true on symbol or an exact-path outline bundles definitions, owning file, imports, importers and test importers; use it before a change. project: orientation, Git, operator tasks (recorded status is not verification). wiki: pages, or a query's summary and path. Clio product docs: clio_docs.",
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
				description: `Max results (default ${CODE_NAV_DEFAULT_LIMIT}, entries ${CODE_NAV_DEFAULT_ENTRY_LIMIT}, related ${CODE_NAV_DEFAULT_RELATED_LIMIT} per bundle, max ${CODE_NAV_MAX_LIMIT}).`,
			}),
		),
		related: Type.Optional(
			Type.Boolean({
				description:
					"symbol/outline: add the owning file's import neighborhood. Importers are import edges, not call sites; test importers are hints, not coverage.",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
};
