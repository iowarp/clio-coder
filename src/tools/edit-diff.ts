import * as Diff from "diff";

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
}

function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
	}
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
	}
	return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function notFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function duplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: ReadonlyArray<Edit>,
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));
	for (let i = 0; i < normalizedEdits.length; i += 1) {
		if ((normalizedEdits[i]?.oldText ?? "").length === 0) {
			throw new Error(
				normalizedEdits.length === 1
					? `oldText must not be empty in ${path}.`
					: `edits[${i}].oldText must not be empty in ${path}.`,
			);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i += 1) {
		const edit = normalizedEdits[i];
		if (!edit) continue;
		const match = fuzzyFindText(baseContent, edit.oldText);
		if (!match.found) throw notFoundError(path, i, normalizedEdits.length);
		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) throw duplicateError(path, i, normalizedEdits.length, occurrences);
		matchedEdits.push({
			editIndex: i,
			matchIndex: match.index,
			matchLength: match.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i += 1) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (!previous || !current) continue;
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i -= 1) {
		const edit = matchedEdits[i];
		if (!edit) continue;
		newContent =
			newContent.slice(0, edit.matchIndex) + edit.newText + newContent.slice(edit.matchIndex + edit.matchLength);
	}
	if (baseContent === newContent) {
		throw new Error(
			normalizedEdits.length === 1
				? `No changes made to ${path}. The replacement produced identical content.`
				: `No changes made to ${path}. The replacements produced identical content.`,
		);
	}
	return { baseContent, newContent };
}

export function generateDiffString(oldContent: string, newContent: string, contextLines = 4): EditDiffResult {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i];
		if (!part) continue;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			firstChangedLine ??= newLineNum;
			for (const line of raw) {
				if (part.added) {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum += 1;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum += 1;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPart = parts[i + 1];
		const nextPartIsChange = Boolean(nextPart?.added || nextPart?.removed);
		const hasLeadingChange = lastWasChange;
		const hasTrailingChange = nextPartIsChange;
		if (hasLeadingChange && hasTrailingChange) {
			if (raw.length <= contextLines * 2) {
				for (const line of raw) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum += 1;
					newLineNum += 1;
				}
			} else {
				const leading = raw.slice(0, contextLines);
				const trailing = raw.slice(raw.length - contextLines);
				const skipped = raw.length - leading.length - trailing.length;
				for (const line of leading) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum += 1;
					newLineNum += 1;
				}
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipped;
				newLineNum += skipped;
				for (const line of trailing) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum += 1;
					newLineNum += 1;
				}
			}
		} else if (hasLeadingChange) {
			const shown = raw.slice(0, contextLines);
			for (const line of shown) {
				output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum += 1;
				newLineNum += 1;
			}
			const skipped = raw.length - shown.length;
			if (skipped > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipped;
				newLineNum += skipped;
			}
		} else if (hasTrailingChange) {
			const skipped = Math.max(0, raw.length - contextLines);
			if (skipped > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipped;
				newLineNum += skipped;
			}
			for (const line of raw.slice(skipped)) {
				output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum += 1;
				newLineNum += 1;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}
		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}
