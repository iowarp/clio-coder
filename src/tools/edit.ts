import { readFile, stat } from "node:fs/promises";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import {
	applyEditsToNormalizedContent,
	type Edit,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { editToolSurface, prepareEditArguments } from "./edit-surface.js";
import { publishFileAtomically, withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveMutationTarget } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const DIFF_LIMIT = 1024 * 1024;
const VALIDATION_CHUNK = 64 * 1024;

async function invalidUtf8Offset(bytes: Buffer): Promise<number> {
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let failingStart = 0;
	for (let start = 0; start < bytes.length; start += VALIDATION_CHUNK) {
		try {
			decoder.decode(bytes.subarray(start, start + VALIDATION_CHUNK), { stream: true });
		} catch {
			failingStart = start;
			break;
		}
		failingStart = Math.min(start + VALIDATION_CHUNK, bytes.length);
		await yieldImmediate();
	}
	// Include the previous code point when a sequence crosses the chunk boundary.
	let start = Math.max(0, failingStart - 4);
	while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
	const narrow = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let sequenceStart = start;
	const end = Math.min(bytes.length, failingStart + VALIDATION_CHUNK);
	for (let i = start; i < end; i += 1) {
		try {
			if (narrow.decode(bytes.subarray(i, i + 1), { stream: true }).length > 0) sequenceStart = i + 1;
		} catch {
			return sequenceStart;
		}
		if ((i - start + 1) % 1024 === 0) await yieldImmediate();
	}
	return sequenceStart;
}

async function classifyEndings(bytes: Buffer): Promise<"\n" | "\r\n"> {
	let crlf = false;
	let lf = false;
	let nextYield = VALIDATION_CHUNK;
	for (let i = 0; i < bytes.length; i += 1) {
		if (bytes[i] === 0) throw new Error(`NUL byte at byte offset ${i}; refusing binary input`);
		if (bytes[i] === 13) {
			if (bytes[i + 1] !== 10) throw new Error("Mixed or bare-CR line endings are unsupported; nothing was normalized");
			crlf = true;
			i += 1;
		} else if (bytes[i] === 10) lf = true;
		if (crlf && lf) throw new Error("Mixed or bare-CR line endings are unsupported; nothing was normalized");
		if (i >= nextYield) {
			nextYield = i + VALIDATION_CHUNK;
			await yieldImmediate();
		}
	}
	return crlf ? "\r\n" : "\n";
}

/** Large edits keep original endings and slice only the matched regions. */
function applyLargeExactEdits(content: string, edits: Edit[], ending: "\n" | "\r\n"): string {
	const matches = edits
		.map((edit, editIndex) => {
			const oldText = restoreLineEndings(normalizeToLF(edit.oldText), ending);
			if (!oldText) throw new Error(`edits[${editIndex}].oldText must not be empty`);
			const index = content.indexOf(oldText);
			if (index < 0)
				throw new Error("Files above 1 MiB require exact matches; fuzzy matching is skipped to bound allocation");
			if (content.indexOf(oldText, index + oldText.length) >= 0)
				throw new Error("The text must be unique; provide more context");
			return { index, length: oldText.length, replacement: restoreLineEndings(normalizeToLF(edit.newText), ending) };
		})
		.sort((a, b) => a.index - b.index);
	const pieces: string[] = [];
	let cursor = 0;
	for (const entry of matches) {
		if (entry.index < cursor) throw new Error("Edits overlap; target disjoint regions");
		pieces.push(content.slice(cursor, entry.index), entry.replacement);
		cursor = entry.index + entry.length;
	}
	pieces.push(content.slice(cursor));
	const result = pieces.join("");
	if (result === content) throw new Error("No changes made; replacements produced identical content");
	return result;
}

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

export const editTool: ToolSpec = {
	...editToolSurface,
	async run(rawArgs, options): Promise<ToolResult> {
		// Normalize here too so direct run() callers (not just registry-admitted
		// calls) accept the legacy/JSON-string shapes. Idempotent.
		const args = prepareEditArguments(rawArgs);
		const pathArg = typeof args.path === "string" ? args.path : null;
		if (!pathArg) return { kind: "error", message: "edit: missing path argument" };
		const edits = parseEditsArray(args.edits);
		if (!edits || edits.length === 0) {
			return { kind: "error", message: 'edit: provide edits as [{"oldText":"...","newText":"..."}, ...]' };
		}
		const { path: filePath, physical } = resolveMutationTarget(pathArg);

		try {
			return await withFileMutationQueue(
				filePath,
				async () => {
					const info = await stat(filePath);
					if (!info.isFile()) throw new Error("Refusing directory or non-file target");
					const bytes = await readFile(filePath);
					const originalEnding = await classifyEndings(bytes);
					let rawContent: string;
					try {
						rawContent = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
					} catch {
						throw new Error(`Invalid UTF-8 at byte offset ${await invalidUtf8Offset(bytes)}`);
					}
					const { bom, text: content } = stripBom(rawContent);
					let finalContent: string;
					let diff: ReturnType<typeof generateDiffString> | undefined;
					if (bytes.length > DIFF_LIMIT) {
						finalContent = bom + applyLargeExactEdits(content, edits, originalEnding);
					} else {
						const applied = applyEditsToNormalizedContent(normalizeToLF(content), edits, pathArg);
						finalContent = bom + restoreLineEndings(applied.newContent, originalEnding);
						if (Buffer.byteLength(finalContent, "utf8") <= DIFF_LIMIT) {
							diff = generateDiffString(applied.baseContent, applied.newContent);
						}
					}
					const file = await publishFileAtomically(filePath, finalContent, {
						...(options?.writeTargetViolation ? { admitTarget: options.writeTargetViolation } : {}),
					});
					// The validation nudge is point-of-failure conditioning: measured on
					// a live 35B coder worker, the model edited correctly and then spent
					// its remaining calls "validating" with navigation tools (code_nav
					// deps) until the loop guard aborted the run. Naming the real
					// validation path on the mutation result is the deterministic channel
					// every agent sees at exactly the moment it matters.
					return {
						kind: "ok",
						output: `edited ${pathArg}: ${edits.length} replacement(s). Validate now: rerun the failing test or verify; navigation tools do not validate edits.${!diff ? "\nnote: diff skipped because the previous or new file exceeds 1 MiB" : ""}${file.durabilityWarning ? `\n${file.durabilityWarning}` : ""}`,
						details: {
							file: { before: file.before, after: file.after },
							diff: diff?.diff,
							firstChangedLine: diff?.firstChangedLine,
							paths: [filePath],
						},
					};
				},
				physical,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") {
				return {
					kind: "error",
					message: `edit: Nothing was published. ${msg}. File not found at ${pathArg}. The path may be wrong. Try: code_nav, find, glob, or ls to locate it.`,
				};
			}
			return { kind: "error", message: `edit: Nothing was published. ${msg}` };
		}
	},
};
