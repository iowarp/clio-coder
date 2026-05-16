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
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap other edits.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

type ParsedEditInput = { kind: "edits"; edits: Edit[] } | { kind: "replace_all"; oldText: string; newText: string };

function stringArg(args: Record<string, unknown>, ...names: string[]): string | null {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string") return value;
	}
	return null;
}

function parseEditEntry(value: unknown): Edit | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const oldText = stringArg(record, "oldText", "old_string");
	const newText = stringArg(record, "newText", "new_string");
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

function parseEditInput(args: Record<string, unknown>): ParsedEditInput | { kind: "error"; message: string } {
	const arrayEdits = parseEditsArray(args.edits);
	if (arrayEdits && arrayEdits.length > 0) return { kind: "edits", edits: arrayEdits };

	const oldText = stringArg(args, "oldText", "old_string");
	const newText = stringArg(args, "newText", "new_string");
	if (oldText === null) return { kind: "error", message: "edit: missing edits or old_string argument" };
	if (newText === null) return { kind: "error", message: "edit: missing edits or new_string argument" };
	if (args.replace_all === true) return { kind: "replace_all", oldText, newText };
	return { kind: "edits", edits: [{ oldText, newText }] };
}

function applyReplaceAll(normalizedContent: string, oldText: string, newText: string, pathArg: string) {
	const oldNormalized = normalizeToLF(oldText);
	if (oldNormalized.length === 0) throw new Error(`oldText must not be empty in ${pathArg}.`);
	const newNormalized = normalizeToLF(newText);
	const parts = normalizedContent.split(oldNormalized);
	const replacements = parts.length - 1;
	if (replacements === 0) {
		throw new Error(`Could not find the exact text in ${pathArg}. The old text must match exactly.`);
	}
	const newContent = parts.join(newNormalized);
	if (newContent === normalizedContent) throw new Error(`No changes made to ${pathArg}.`);
	return { baseContent: normalizedContent, newContent, replacements };
}

export const editTool: ToolSpec = {
	name: ToolNames.Edit,
	description:
		"Edit a single file using exact text replacement. Prefer edits[] with one or more {oldText,newText} replacements. Each oldText must match a unique, non-overlapping region of the original file. Legacy old_string/new_string input is accepted.",
	parameters: Type.Object(
		{
			path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)." })),
			file_path: Type.Optional(Type.String({ description: "Legacy alias for path." })),
			edits: Type.Optional(Type.Array(editEntrySchema, { description: "One or more targeted replacements." })),
			oldText: Type.Optional(Type.String({ description: "Legacy/direct exact text to replace." })),
			newText: Type.Optional(Type.String({ description: "Legacy/direct replacement text." })),
			old_string: Type.Optional(Type.String({ description: "Legacy alias for oldText." })),
			new_string: Type.Optional(Type.String({ description: "Legacy alias for newText." })),
			replace_all: Type.Optional(
				Type.Boolean({ description: "Legacy compatibility: replace every occurrence of old_string/new_string." }),
			),
		},
		{ anyOf: [{ required: ["path"] }, { required: ["file_path"] }] },
	),
	baseActionClass: "write",
	executionMode: "sequential",
	async run(args): Promise<ToolResult> {
		const pathArg = stringArg(args, "path", "file_path");
		if (!pathArg) return { kind: "error", message: "edit: missing path argument" };
		const parsed = parseEditInput(args);
		if (parsed.kind === "error") return { kind: "error", message: parsed.message };
		const filePath = resolveToCwd(pathArg);

		try {
			return await withFileMutationQueue(filePath, async () => {
				const rawContent = readFileSync(filePath, "utf8");
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const applied =
					parsed.kind === "replace_all"
						? applyReplaceAll(normalizedContent, parsed.oldText, parsed.newText, pathArg)
						: {
								...applyEditsToNormalizedContent(normalizedContent, parsed.edits, pathArg),
								replacements: parsed.edits.length,
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
					message: `edit: ${msg}. File not found at ${pathArg}. The path may be wrong (e.g. wrong extension; codewiki indexes only .ts/.tsx). Try: where_is, find, glob, or ls to locate it.`,
				};
			}
			return { kind: "error", message: `edit: ${msg}` };
		}
	},
};
