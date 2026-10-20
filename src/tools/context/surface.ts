import { Type } from "typebox";
import type { ClioSettings } from "../../core/config.js";
import { semanticUsable } from "../../core/config.js";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

/** Session settings fix the advertised semantic capability at registration (#432). */
export function createContextToolSurface(semantic?: ClioSettings["context"]["semantic"]): ToolSurface {
	const usable = semanticUsable(semantic);
	return {
		name: ToolNames.Context,
		description:
			"Environment context. scope=workspace: git/project snapshot; settings: effective settings, autonomy and limits without credentials; budget: the live request budget; skills: list ready and installable skills or load one by name; recall: an evicted/summarized result by ref or path, or a list by query." +
			(usable
				? " semantic: opt-in bounded source search by meaning (query required); inspect returned originals before claims."
				: "") +
			" Repository code/wiki: code_nav (mode=wiki).",
		parameters: Type.Object({
			scope: StringEnum(["workspace", "settings", "skills", "recall", "budget", ...(usable ? ["semantic"] : [])], {
				description: "Context source.",
			}),
			query: Type.Optional(
				Type.String({
					description:
						"settings: path/section/terms; recall (no ref): path/tool/ref terms; skills: narrow the list." +
						(usable ? " semantic: required search text (max 2000 characters)." : ""),
				}),
			),
			name: Type.Optional(Type.String({ description: "skills: the skill to load." })),
			limit: Type.Optional(
				Type.Number({
					description:
						"settings/recall: page size (max 12); skills: rows (max 200)." +
						(usable ? " semantic: candidates (1-20, default 5)." : ""),
				}),
			),
			...(usable
				? {
						kinds: Type.Optional(
							Type.Array(StringEnum(["code", "wiki", "memory", "evidence", "inbox", "recording"]), {
								minItems: 1,
								maxItems: 6,
								description: "semantic: source kinds to include.",
							}),
						),
						run_id: Type.Optional(Type.String({ maxLength: 256, description: "semantic: restrict to this run." })),
						media_type: Type.Optional(Type.String({ maxLength: 256, description: "semantic: restrict to this MIME type." })),
						after: Type.Optional(
							Type.String({ maxLength: 32, description: "semantic: earliest source date or ISO timestamp (UTC)." }),
						),
						before: Type.Optional(
							Type.String({ maxLength: 32, description: "semantic: latest source date or ISO timestamp (UTC)." }),
						),
					}
				: {}),
			ref: Type.Optional(Type.String({ description: "recall: result ref; omit to discover." })),
			path: Type.Optional(Type.String({ description: "recall: newest evicted read of this file." })),
			offset: Type.Optional(
				Type.Number({ description: "settings, recall or skills: 0-based offset; follow nextOffset." }),
			),
			include_tree: Type.Optional(Type.Boolean({ description: "skills: list the skill's files." })),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
	};
}
