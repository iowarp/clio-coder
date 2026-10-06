import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolSurface } from "./lazy-tool.js";

const editEntrySchema = Type.Object({
	oldText: Type.String({ description: "Exact unique text to replace; must not overlap other edits." }),
	newText: Type.String({ description: "Replacement text." }),
});

/**
 * Normalize the weak-model argument shapes edit still sees in the wild, ported
 * from pi's prepareEditArguments:
 *  - `edits` sent as a JSON string (Opus 4.6, GLM-5.1) -> parsed to an array.
 *  - legacy top-level `{oldText, newText}` (pre-`edits[]` callers) -> appended
 *    to `edits[]` instead of erroring the turn.
 * Pure and idempotent: already-normalized args pass through unchanged. Wired as
 * the registry `prepareArguments` hook and also called at the top of `run` so
 * direct callers get the same normalization.
 */
export function prepareEditArguments(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const next: Record<string, unknown> = { ...args };
	if (typeof next.edits === "string") {
		try {
			const parsed = JSON.parse(next.edits) as unknown;
			if (Array.isArray(parsed)) next.edits = parsed;
		} catch {
			// Leave the malformed string in place; run() reports the shape error.
		}
	}
	if (typeof next.oldText === "string" && typeof next.newText === "string") {
		const edits = Array.isArray(next.edits) ? [...next.edits] : [];
		edits.push({ oldText: next.oldText, newText: next.newText });
		const { oldText: _oldText, newText: _newText, ...rest } = next;
		return { ...rest, edits };
	}
	return next;
}

export const editToolSurface = {
	name: ToolNames.Edit,
	description:
		"Edit one file with exact text replacements. Each oldText must match a unique region of the original file; matching tries exact text first, then quote/dash/NFKC and trailing-space normalization, then indentation relaxation. Several non-overlapping edits to one file go in one call. Files above 1 MiB require exact matches and skip diffs to bound allocation. Refuses NUL bytes, invalid UTF-8, and mixed or bare-CR line endings. LF replacement text adopts the file's LF or CRLF endings; the UTF-8 BOM is preserved. Publishes atomically through symlinks with mode bits preserved. External writers are not locked; the last rename wins. Returned file identities describe publication, not a precondition on an earlier model read.",
	parameters: Type.Object({
		path: Type.String({ description: "File path (relative or absolute)." }),
		edits: Type.Array(editEntrySchema, { description: "One or more targeted replacements." }),
	}),
	baseActionClass: "write",
	executionMode: "sequential",
	prepareArguments: prepareEditArguments,
} satisfies ToolSurface;
