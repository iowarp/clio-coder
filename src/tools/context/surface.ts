import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const contextToolSurface = {
	name: ToolNames.Context,
	description:
		"Environment context: scope=workspace returns the git/project snapshot, scope=docs searches Clio's bundled documentation (omit query to list the corpus), scope=skills lists installed and marketplace skills or loads an installed one by name, scope=recall returns the exact body of an evicted tool result by ref (the turnId named in an [evicted ...] marker). For repository code and the repo's generated wiki use code_nav (mode=wiki).",
	parameters: Type.Object({
		scope: StringEnum(["workspace", "docs", "skills", "recall"], { description: "Context source." }),
		query: Type.Optional(Type.String({ description: "scope=docs: question or terms; omit to list the corpus." })),
		name: Type.Optional(Type.String({ description: "scope=skills: skill name to load; omit to list." })),
		limit: Type.Optional(Type.Number({ description: "scope=docs: max sections (default 5, max 12)." })),
		ref: Type.Optional(Type.String({ description: "scope=recall: ref of the evicted item, as named in its marker." })),
		include_tree: Type.Optional(Type.Boolean({ description: "scope=skills: list files under the skill base_dir." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
