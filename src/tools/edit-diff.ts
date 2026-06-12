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
}

interface LineBounds {
	contentStart: number;
	contentEnd: number;
	terminatorEnd: number;
	text: string;
}

interface ResolvedMatch {
	found: boolean;
	index: number;
	matchLength: number;
	newText: string;
	occurrences: number;
}

function findNonOverlappingOccurrences(content: string, text: string): number[] {
	if (text.length === 0) return [];
	const indexes: number[] = [];
	let fromIndex = 0;
	for (;;) {
		const index = content.indexOf(text, fromIndex);
		if (index === -1) break;
		indexes.push(index);
		fromIndex = index + text.length;
	}
	return indexes;
}

function splitLineBounds(content: string): LineBounds[] {
	const lines: LineBounds[] = [];
	let contentStart = 0;
	for (let i = 0; i < content.length; i += 1) {
		if (content[i] !== "\n") continue;
		lines.push({
			contentStart,
			contentEnd: i,
			terminatorEnd: i + 1,
			text: content.slice(contentStart, i),
		});
		contentStart = i + 1;
	}
	lines.push({
		contentStart,
		contentEnd: content.length,
		terminatorEnd: content.length,
		text: content.slice(contentStart),
	});
	return lines;
}

function lineIndexAtOffset(lines: ReadonlyArray<LineBounds>, offset: number): number {
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line && offset < line.terminatorEnd) return i;
	}
	return Math.max(0, lines.length - 1);
}

function lineSpanForFuzzyMatch(content: string, fuzzyContent: string, match: FuzzyMatchResult): FuzzyMatchResult {
	const originalLines = splitLineBounds(content);
	const fuzzyLines = splitLineBounds(fuzzyContent);
	const startLine = lineIndexAtOffset(fuzzyLines, match.index);
	const endLine = lineIndexAtOffset(fuzzyLines, match.index + match.matchLength - 1);
	const originalStart = originalLines[startLine]?.contentStart ?? 0;
	const fallbackEndLine = originalLines[originalLines.length - 1];
	if (!fallbackEndLine) return { found: false, index: -1, matchLength: 0 };
	const originalEndLine = originalLines[endLine] ?? fallbackEndLine;
	const includeTrailingLineEnding = fuzzyContent[match.index + match.matchLength - 1] === "\n";
	const originalEnd = includeTrailingLineEnding ? originalEndLine.terminatorEnd : originalEndLine.contentEnd;
	return { found: true, index: originalStart, matchLength: originalEnd - originalStart };
}

function leadingWhitespace(line: string): string {
	return /^[\t ]*/.exec(line)?.[0] ?? "";
}

function stripLeadingWhitespace(line: string): string {
	return line.slice(leadingWhitespace(line).length);
}

function logicalLinesForMatch(text: string): { lines: string[]; includeTrailingLineEnding: boolean } {
	const includeTrailingLineEnding = text.endsWith("\n");
	const body = includeTrailingLineEnding ? text.slice(0, -1) : text;
	return { lines: body.split("\n"), includeTrailingLineEnding };
}

function applyIndentDelta(text: string, oldIndent: string, matchedIndent: string): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.trim().length === 0) return "";
			if (line.startsWith(oldIndent)) return `${matchedIndent}${line.slice(oldIndent.length)}`;
			return line;
		})
		.join("\n");
}

function findExactMatch(content: string, oldText: string, newText: string): ResolvedMatch {
	const indexes = findNonOverlappingOccurrences(content, oldText);
	if (indexes.length === 0) return { found: false, index: -1, matchLength: 0, newText, occurrences: 0 };
	return {
		found: true,
		index: indexes[0] ?? -1,
		matchLength: oldText.length,
		newText,
		occurrences: indexes.length,
	};
}

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) i += 1;
	return i;
}

function commonSuffixLength(a: string, b: string, maxLength: number): number {
	const max = Math.min(a.length, b.length, maxLength);
	let i = 0;
	while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
	return i;
}

function spliceChangedLine(originalLine: string, oldLine: string, newLine: string): string {
	const normalizedOld = normalizeForFuzzyMatch(oldLine);
	const normalizedNew = normalizeForFuzzyMatch(newLine);
	const trimmedOriginal = originalLine.trimEnd();
	const trimmedNew = newLine.trimEnd();
	const oneToOne =
		trimmedOriginal.length === normalizedOld.length &&
		oldLine.trimEnd().length === normalizedOld.length &&
		trimmedNew.length === normalizedNew.length;
	if (!oneToOne) return newLine;
	const prefix = commonPrefixLength(normalizedOld, normalizedNew);
	const suffix = commonSuffixLength(
		normalizedOld,
		normalizedNew,
		Math.min(normalizedOld.length, normalizedNew.length) - prefix,
	);
	return (
		trimmedOriginal.slice(0, prefix) +
		trimmedNew.slice(prefix, normalizedNew.length - suffix) +
		trimmedOriginal.slice(normalizedOld.length - suffix) +
		newLine.slice(trimmedNew.length)
	);
}

function spliceFuzzyNewText(matchedOriginal: string, oldText: string, newText: string): string {
	const originalHadTrailingNewline = matchedOriginal.endsWith("\n");
	const oldHadTrailingNewline = oldText.endsWith("\n");
	if (originalHadTrailingNewline !== oldHadTrailingNewline) return newText;
	const originalBody = originalHadTrailingNewline ? matchedOriginal.slice(0, -1) : matchedOriginal;
	const oldBody = oldHadTrailingNewline ? oldText.slice(0, -1) : oldText;
	if (normalizeForFuzzyMatch(originalBody) !== normalizeForFuzzyMatch(oldBody)) return newText;

	const newHadTrailingNewline = newText.endsWith("\n");
	const newBody = newHadTrailingNewline ? newText.slice(0, -1) : newText;
	const originalLines = originalBody.split("\n");
	const oldLines = oldBody.split("\n");
	const newLines = newBody.split("\n");
	if (originalLines.length !== oldLines.length) return newText;

	let resultLines: string[];
	if (oldLines.length === newLines.length) {
		resultLines = oldLines.map((oldLine, i) => {
			const originalLine = originalLines[i] ?? oldLine;
			const newLine = newLines[i] ?? oldLine;
			if (normalizeForFuzzyMatch(oldLine) === normalizeForFuzzyMatch(newLine)) return originalLine;
			return spliceChangedLine(originalLine, oldLine, newLine);
		});
	} else {
		const maxPairs = Math.min(oldLines.length, newLines.length);
		let prefixLines = 0;
		while (
			prefixLines < maxPairs &&
			normalizeForFuzzyMatch(oldLines[prefixLines] ?? "") === normalizeForFuzzyMatch(newLines[prefixLines] ?? "")
		) {
			prefixLines += 1;
		}
		let suffixLines = 0;
		while (
			suffixLines < maxPairs - prefixLines &&
			normalizeForFuzzyMatch(oldLines[oldLines.length - 1 - suffixLines] ?? "") ===
				normalizeForFuzzyMatch(newLines[newLines.length - 1 - suffixLines] ?? "")
		) {
			suffixLines += 1;
		}
		resultLines = [
			...originalLines.slice(0, prefixLines),
			...newLines.slice(prefixLines, newLines.length - suffixLines),
			...originalLines.slice(originalLines.length - suffixLines, originalLines.length),
		];
	}
	return resultLines.join("\n") + (newHadTrailingNewline ? "\n" : "");
}

function findFuzzyMatch(content: string, oldText: string, newText: string): ResolvedMatch {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const indexes = findNonOverlappingOccurrences(fuzzyContent, fuzzyOldText);
	if (indexes.length === 0) return { found: false, index: -1, matchLength: 0, newText, occurrences: 0 };
	const fuzzyMatch = { found: true, index: indexes[0] ?? -1, matchLength: fuzzyOldText.length };
	const originalMatch = lineSpanForFuzzyMatch(content, fuzzyContent, fuzzyMatch);
	if (!originalMatch.found) return { found: false, index: -1, matchLength: 0, newText, occurrences: 0 };
	const matchedOriginal = content.slice(originalMatch.index, originalMatch.index + originalMatch.matchLength);
	return {
		found: true,
		index: originalMatch.index,
		matchLength: originalMatch.matchLength,
		newText: spliceFuzzyNewText(matchedOriginal, oldText, newText),
		occurrences: indexes.length,
	};
}

function findIndentationRelaxedMatch(content: string, oldText: string, newText: string): ResolvedMatch {
	const oldSequence = logicalLinesForMatch(oldText);
	const oldComparableLines = oldSequence.lines.map(stripLeadingWhitespace);
	const contentLines = splitLineBounds(content);
	const matches: { index: number; matchLength: number; matchedIndent: string }[] = [];
	const maxStart = contentLines.length - oldComparableLines.length;

	for (let startLine = 0; startLine <= maxStart; startLine += 1) {
		let matched = true;
		for (let offset = 0; offset < oldComparableLines.length; offset += 1) {
			const contentLine = contentLines[startLine + offset];
			if (!contentLine || stripLeadingWhitespace(contentLine.text) !== oldComparableLines[offset]) {
				matched = false;
				break;
			}
		}
		if (!matched) continue;

		const lastLine = contentLines[startLine + oldComparableLines.length - 1];
		if (!lastLine) continue;
		if (oldSequence.includeTrailingLineEnding && lastLine.terminatorEnd === lastLine.contentEnd) continue;
		const firstLine = contentLines[startLine];
		if (!firstLine) continue;
		const matchStart = firstLine.contentStart;
		const matchEnd = oldSequence.includeTrailingLineEnding ? lastLine.terminatorEnd : lastLine.contentEnd;
		matches.push({
			index: matchStart,
			matchLength: matchEnd - matchStart,
			matchedIndent: leadingWhitespace(firstLine.text),
		});
	}

	if (matches.length === 0) return { found: false, index: -1, matchLength: 0, newText, occurrences: 0 };
	const match = matches[0];
	if (!match) return { found: false, index: -1, matchLength: 0, newText, occurrences: 0 };
	const oldIndent = leadingWhitespace(oldSequence.lines[0] ?? "");
	return {
		found: true,
		index: match.index,
		matchLength: match.matchLength,
		newText: applyIndentDelta(newText, oldIndent, match.matchedIndent),
		occurrences: matches.length,
	};
}

function resolveMatch(content: string, oldText: string, newText: string): ResolvedMatch {
	const exactMatch = findExactMatch(content, oldText, newText);
	if (exactMatch.found) return exactMatch;

	const fuzzyMatch = findFuzzyMatch(content, oldText, newText);
	if (fuzzyMatch.found) return fuzzyMatch;

	return findIndentationRelaxedMatch(content, oldText, newText);
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

	const baseContent = normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i += 1) {
		const edit = normalizedEdits[i];
		if (!edit) continue;
		const match = resolveMatch(baseContent, edit.oldText, edit.newText);
		if (!match.found) throw notFoundError(path, i, normalizedEdits.length);
		if (match.occurrences > 1) throw duplicateError(path, i, normalizedEdits.length, match.occurrences);
		matchedEdits.push({
			editIndex: i,
			matchIndex: match.index,
			matchLength: match.matchLength,
			newText: match.newText,
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
