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
	let raw = value;
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	}
	if (!Array.isArray(raw)) return null;
	const edits = raw.map(parseEditEntry);
	if (edits.some((entry) => entry === null)) return null;
	return edits as Edit[];
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
	async run(args): Promise<ToolResult> {
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
				return {
					kind: "ok",
					output: `edited ${pathArg}: ${applied.replacements} replacement(s)`,
					details: { diff: diff.diff, firstChangedLine: diff.firstChangedLine },
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
