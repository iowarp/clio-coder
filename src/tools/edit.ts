import { readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const editEntrySchema = Type.Object({
	oldText: Type.String({ description: "Exact unique text to replace; must not overlap other edits." }),
	newText: Type.String({ description: "Replacement text." }),
});

function parseEditEntry(value: unknown): Edit | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const oldText = typeof record.oldText === "string" ? record.oldText : null;
	const newText = typeof record.newText === "string" ? record.newText : null;
	if (oldText === null || newText === null) return null;
	return { oldText, newText };
}

function parseEditsArray(value: unknown): Edit[] | null {
	if (!Array.isArray(value)) return null;
	const edits = value.map(parseEditEntry);
	if (edits.some((entry) => entry === null)) return null;
	return edits as Edit[];
}

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
function prepareEditArguments(args: Record<string, unknown>): Record<string, unknown> {
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

export const editTool: ToolSpec = {
	name: ToolNames.Edit,
	description:
		"Edit one file with exact text replacements. Each oldText must match a unique region of the original file.",
	parameters: Type.Object({
		path: Type.String({ description: "File path (relative or absolute)." }),
		edits: Type.Array(editEntrySchema, { description: "One or more targeted replacements." }),
	}),
	baseActionClass: "write",
	executionMode: "sequential",
	prepareArguments: prepareEditArguments,
	async run(rawArgs): Promise<ToolResult> {
		// Normalize here too so direct run() callers (not just registry-admitted
		// calls) accept the legacy/JSON-string shapes. Idempotent.
		const args = prepareEditArguments(rawArgs);
		const pathArg = typeof args.path === "string" ? args.path : null;
		if (!pathArg) return { kind: "error", message: "edit: missing path argument" };
		const edits = parseEditsArray(args.edits);
		if (!edits || edits.length === 0) {
			return { kind: "error", message: 'edit: provide edits as [{"oldText":"...","newText":"..."}, ...]' };
		}
		const filePath = resolveToCwd(pathArg);

		try {
			return await withFileMutationQueue(filePath, async () => {
				const rawContent = readFileSync(filePath, "utf8");
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const applied = {
					...applyEditsToNormalizedContent(normalizedContent, edits, pathArg),
					replacements: edits.length,
				};
				const finalContent = bom + restoreLineEndings(applied.newContent, originalEnding);
				writeFileSync(filePath, finalContent, "utf8");
				const diff = generateDiffString(applied.baseContent, applied.newContent);
				// The validation nudge is point-of-failure conditioning: measured on
				// a live 35B coder worker, the model edited correctly and then spent
				// its remaining calls "validating" with navigation tools (code_nav
				// deps) until the loop guard aborted the run. Naming the real
				// validation path on the mutation result is the deterministic channel
				// every agent sees at exactly the moment it matters.
				return {
					kind: "ok",
					output: `edited ${pathArg}: ${applied.replacements} replacement(s). Validate now: rerun the failing test or verify; navigation tools do not validate edits.`,
					details: { diff: diff.diff, firstChangedLine: diff.firstChangedLine, paths: [filePath] },
				};
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") {
				return {
					kind: "error",
					message: `edit: ${msg}. File not found at ${pathArg}. The path may be wrong. Try: code_nav, find, glob, or ls to locate it.`,
				};
			}
			return { kind: "error", message: `edit: ${msg}` };
		}
	},
};
