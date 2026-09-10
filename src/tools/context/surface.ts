import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const contextToolSurface = {
	name: ToolNames.Context,
	description:
		"Environment context: scope=workspace returns the git/project snapshot, scope=docs searches Clio's bundled documentation (omit query to list the corpus), scope=skills lists installed and marketplace skills or loads an installed one by name, scope=library reads the recipe catalog (installed skills/agents/prompts/fleets with their owner and invocation, plus installable packages) without activating or installing anything, scope=recall returns an exact persisted evicted or summarized tool result by ref; omit ref to discover historical results by query with bounded limit/offset pages. For repository code and the repo's generated wiki use code_nav (mode=wiki).",
	parameters: Type.Object({
		scope: StringEnum(["workspace", "docs", "skills", "library", "recall"], { description: "Context source." }),
		query: Type.Optional(
			Type.String({
				description:
					"scope=docs: question or terms. scope=library: name, owner, or description terms. scope=recall without ref: path, tool, or ref terms; omit to list.",
			}),
		),
		name: Type.Optional(Type.String({ description: "scope=skills: skill name to load; omit to list." })),
		kind: Type.Optional(
			StringEnum(["skill", "agent", "prompt", "fleet", "plugin"], {
				description: "scope=library: one recipe kind, or plugin for installable package rows.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description:
					"scope=docs: max sections (default 5, max 12). scope=library: max rows (default 20, max 50). scope=recall: max refs (default 8, max 12).",
			}),
		),
		ref: Type.Optional(
			Type.String({
				description:
					"scope=library: exact kind:name or resource key for one record. scope=recall: exact persisted result ref; omit for discovery.",
			}),
		),
		offset: Type.Optional(
			Type.Number({
				description: "scope=library and scope=recall discovery: zero-based offset; follow nextOffset (default 0).",
			}),
		),
		include_tree: Type.Optional(Type.Boolean({ description: "scope=skills: list files under the skill base_dir." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
