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
		"Environment context. scope=workspace: git/project snapshot; settings: effective settings, autonomy and limits without credentials; budget: the live request budget; skills: list ready and installable skills or load one by name; recall: an evicted/summarized result by ref or path, or a list by query. Repository code/wiki: code_nav (mode=wiki).",
	parameters: Type.Object({
		scope: StringEnum(["workspace", "settings", "skills", "recall", "budget"], { description: "Context source." }),
		query: Type.Optional(
			Type.String({
				description: "settings: path/section/terms; recall (no ref): path/tool/ref terms; skills: narrow the list.",
			}),
		),
		name: Type.Optional(Type.String({ description: "skills: the skill to load." })),
		limit: Type.Optional(Type.Number({ description: "settings/recall: page size (max 12); skills: rows (max 200)." })),
		ref: Type.Optional(Type.String({ description: "recall: result ref; omit to discover." })),
		path: Type.Optional(Type.String({ description: "recall: newest evicted read of this file." })),
		offset: Type.Optional(Type.Number({ description: "settings, recall or skills: 0-based offset; follow nextOffset." })),
		include_tree: Type.Optional(Type.Boolean({ description: "skills: list the skill's files." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
