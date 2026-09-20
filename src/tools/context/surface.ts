import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

/**
 * The permanent context schema keeps the scopes the base agent needs on
 * every turn: workspace state, effective settings, skill activation, and recall of evicted
 * results. Clio's bundled documentation and the recipe catalog are secondary
 * reads and live behind the gateway as `clio_docs` and `clio_library`.
 */
export const contextToolSurface = {
	name: ToolNames.Context,
	description:
		"Environment context: scope=settings explains current effective settings, autonomy, configured limits, and exact UI commands without exposing credentials; scope=workspace returns the git/project snapshot, scope=skills lists ready skills, installed package states and marketplace options, or loads a ready skill by name, scope=recall returns an exact persisted evicted or summarized tool result by ref; omit ref to discover historical results by query with bounded limit/offset pages. Clio's documentation and the recipe catalog are gateway capabilities (clio_docs, clio_library). For repository code and the repo's generated wiki use code_nav (mode=wiki).",
	parameters: Type.Object({
		scope: StringEnum(["workspace", "settings", "skills", "recall"], { description: "Context source." }),
		query: Type.Optional(
			Type.String({
				description:
					"scope=settings: settings path, section, or terms; scope=recall without ref: path, tool, or ref terms.",
			}),
		),
		name: Type.Optional(Type.String({ description: "scope=skills: skill name to load; omit to list." })),
		limit: Type.Optional(Type.Number({ description: "scope=settings or recall: bounded page size (max 12)." })),
		ref: Type.Optional(Type.String({ description: "scope=recall: exact persisted result ref; omit for discovery." })),
		offset: Type.Optional(
			Type.Number({
				description: "scope=settings or recall discovery: zero-based offset; follow nextOffset (default 0).",
			}),
		),
		include_tree: Type.Optional(Type.Boolean({ description: "scope=skills: list files under the skill base_dir." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
