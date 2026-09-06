import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const contextToolSurface = {
	name: ToolNames.Context,
	description:
		"Environment context: scope=workspace returns the git/project snapshot, scope=docs searches Clio's bundled documentation (omit query to list the corpus), scope=skills lists installed and marketplace skills or loads an installed one by name, scope=recall returns an exact persisted evicted or summarized tool result by ref; omit ref to discover historical results by query with bounded limit/offset pages. For repository code and the repo's generated wiki use code_nav (mode=wiki).",
	parameters: Type.Object({
		scope: StringEnum(["workspace", "docs", "skills", "recall"], { description: "Context source." }),
		query: Type.Optional(
			Type.String({
				description: "scope=docs: question or terms. scope=recall without ref: path, tool, or ref terms; omit to list.",
			}),
		),
		name: Type.Optional(Type.String({ description: "scope=skills: skill name to load; omit to list." })),
		limit: Type.Optional(
			Type.Number({
				description: "scope=docs: max sections (default 5, max 12). scope=recall: max refs (default 8, max 12).",
			}),
		),
		ref: Type.Optional(Type.String({ description: "scope=recall: exact persisted result ref; omit for discovery." })),
		offset: Type.Optional(
			Type.Number({ description: "scope=recall discovery: zero-based offset; follow nextOffset (default 0)." }),
		),
		include_tree: Type.Optional(Type.Boolean({ description: "scope=skills: list files under the skill base_dir." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
