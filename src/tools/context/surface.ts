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
		"Environment context: scope=settings explains effective settings, autonomy, limits and UI commands without credentials; workspace returns the git/project snapshot; budget inspects the native session's live request budget (read-only, shadow policy); skills lists ready skills, installed states and marketplace options, or loads a ready skill by name; recall retrieves persisted evicted/summarized tool results by ref, or discovers them by query with limit/offset pages. Clio docs and recipes: gateway capabilities clio_docs and clio_library. Repository code/wiki: code_nav (mode=wiki).",
	parameters: Type.Object({
		scope: StringEnum(["workspace", "settings", "skills", "recall", "budget"], { description: "Context source." }),
		// These three carry three scopes each. The attached-schema byte budget in
		// tests/contracts/gateway-prompt.test.ts had 18 bytes of headroom, so
		// naming scope=skills here is paid for by compressing the wording rather
		// than by widening a budget that exists to keep the prompt small.
		query: Type.Optional(
			Type.String({
				description:
					"scope=settings: path/section/terms; scope=recall (no ref): path/tool/ref terms; scope=skills: narrow the list.",
			}),
		),
		name: Type.Optional(Type.String({ description: "scope=skills: skill name to load; omit to list." })),
		limit: Type.Optional(
			Type.Number({ description: "scope=settings/recall: page size (max 12); scope=skills: rows (max 200)." }),
		),
		ref: Type.Optional(Type.String({ description: "scope=recall: exact persisted result ref; omit for discovery." })),
		offset: Type.Optional(
			Type.Number({ description: "scope=settings, recall, or skills: 0-based offset; follow nextOffset." }),
		),
		include_tree: Type.Optional(Type.Boolean({ description: "scope=skills: list files under the skill base_dir." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
} satisfies ToolSurface;
