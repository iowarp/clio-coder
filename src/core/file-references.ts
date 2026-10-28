import { isUtf8 } from "node:buffer";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { formatSize } from "../engine/truncate.js";
import type { ImageContent } from "../engine/types.js";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.js";
import { GUARDRAIL_DEFAULTS } from "./guardrails.js";
import { expandConfigPath } from "./resolve-config-value.js";

export interface FileReferenceDiagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
}

export interface FileReferenceResult {
	text: string;
	images: ImageContent[];
	diagnostics: FileReferenceDiagnostic[];
	/** Absolute files that were actually expanded into text or image context. */
	referencedPaths: string[];
}

export interface FileReferenceOptions {
	cwd?: string;
	missing?: "error" | "leave";
	includeImages?: boolean;
	autoResizeImages?: boolean;
}

const DEFAULT_IMAGE_MAX_BASE64_BYTES = 4.5 * 1024 * 1024;

/** Enough of a file to recognise an image or document signature (tar's sits at offset 257). */
const SIGNATURE_BYTES = 4096;

/**
 * Largest text file an `@path` reference inlines whole, the same ceiling the ACP
 * server puts on an embedded resource. A bigger file is named instead, so one
 * reference cannot fill the context window before the turn starts.
 */
export const INLINE_TEXT_MAX_BYTES = 256 * 1024;

interface InlineFileReference {
	start: number;
	end: number;
	raw: string;
	fileArg: string;
	quoted: boolean;
}

function decodeQuotedFileArg(input: string, start: number, quote: '"' | "'"): { value: string; end: number } | null {
	let value = "";
	let escaped = false;
	for (let index = start; index < input.length; index += 1) {
		const character = input[index] ?? "";
		if (escaped) {
			value += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === quote) return { value, end: index + 1 };
		value += character;
	}
	return null;
}

/** Scanner shared by sync and async expansion; quoted references may contain spaces. */
function inlineFileReferences(input: string): InlineFileReference[] {
	const references: InlineFileReference[] = [];
	for (let start = 0; start < input.length; start += 1) {
		if (input[start] !== "@" || (start > 0 && !/\s/u.test(input[start - 1] ?? ""))) continue;
		const next = input[start + 1];
		if (next === '"' || next === "'") {
			const decoded = decodeQuotedFileArg(input, start + 2, next);
			if (!decoded || decoded.value.length === 0) continue;
			references.push({
				start,
				end: decoded.end,
				raw: input.slice(start, decoded.end),
				fileArg: decoded.value,
				quoted: true,
			});
			start = decoded.end - 1;
			continue;
		}
		let end = start + 1;
		while (end < input.length && !/\s/u.test(input[end] ?? "")) end += 1;
		if (end === start + 1) continue;
		references.push({
			start,
			end,
			raw: input.slice(start, end),
			fileArg: input.slice(start + 1, end),
			quoted: false,
		});
		start = end - 1;
	}
	return references;
}

function renderTextFile(filePath: string, content: string): string {
	return `<file name="${filePath}">\n${content}\n</file>\n`;
}

function renderImageFile(filePath: string, content = ""): string {
	return `<file name="${filePath}">${content}</file>\n`;
}

/** A referenced file whose bytes are not inlined: the block says what it is and how to read it. */
function renderFileNote(filePath: string, note: string): string {
	return `<file name="${filePath}">[${note}]</file>\n`;
}

function readSignature(filePath: string, size: number): Buffer {
	const bytes = Buffer.alloc(Math.min(size, SIGNATURE_BYTES));
	const fd = openSync(filePath, "r");
	try {
		const read = readSync(fd, bytes, 0, bytes.length, 0);
		return bytes.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

function result(
	text: string,
	diagnostics: FileReferenceDiagnostic[] = [],
	images: ImageContent[] = [],
	referencedPaths: string[] = [],
): FileReferenceResult {
	return { text, diagnostics, images, referencedPaths };
}

export function detectSupportedImageMimeType(bytes: Buffer): string | null {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	const signature = bytes.subarray(0, 6).toString("ascii");
	if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

export type DocumentKind = "notebook" | "pdf" | "zip" | "tar" | "gzip";

/** Documents read renders to text before windowing: by extension for notebooks, by magic bytes otherwise. */
export function detectDocumentKind(filePath: string, first: Buffer): DocumentKind | null {
	if (path.extname(filePath).toLowerCase() === ".ipynb") return "notebook";
	if (first.toString("latin1", 0, 5) === "%PDF-") return "pdf";
	if (
		first[0] === 0x50 &&
		first[1] === 0x4b &&
		(first[2] === 3 || first[2] === 5) &&
		(first[3] === 4 || first[3] === 6)
	) {
		return "zip";
	}
	if (first[0] === 0x1f && first[1] === 0x8b) return "gzip";
	if (first.length >= 262 && first.toString("latin1", 257, 262) === "ustar") return "tar";
	return null;
}

/**
 * A PDF or archive reference becomes the text `read` would show on its first
 * call, under read's per-call cap, with the call that continues it. Rendering
 * failures (no poppler, a damaged file) name the file and the reason instead.
 */
async function renderDocumentReference(filePath: string, kind: Exclude<DocumentKind, "notebook">, size: number) {
	const { renderDocument, windowDocument } = await import("../tools/read-documents/index.js");
	const request = { numbered: false, offset: 1, limit: null, tail: null, signal: undefined };
	const handle = await open(filePath, "r");
	let rendered: Awaited<ReturnType<typeof renderDocument>>;
	try {
		rendered = await renderDocument(kind, filePath, handle, size, request);
	} finally {
		await handle.close();
	}
	if ("error" in rendered) {
		return {
			text: renderFileNote(filePath, `${kind} file (${formatSize(size)}), not inlined: ${rendered.error}`),
			diagnostic: {
				type: "warning" as const,
				message: `${kind} file could not be rendered: ${rendered.error}`,
				path: filePath,
			},
		};
	}
	const view = windowDocument(rendered.text, request, GUARDRAIL_DEFAULTS.readMaxBytes);
	if ("error" in view) {
		return {
			text: renderFileNote(filePath, `${kind} file (${formatSize(size)}), not inlined: ${view.error}`),
			diagnostic: { type: "warning" as const, message: view.error, path: filePath },
		};
	}
	const more =
		view.next === undefined
			? ""
			: `\n[showing ${view.shownCount} of ${view.totalCount} rendered lines; continue with read on this path, ${view.next}]`;
	return { text: renderTextFile(filePath, `${view.output}${more}`) };
}

/** Shared tool image encoding; the cap counts base64 bytes actually sent. */
export async function prepareBoundedImage(bytes: Buffer, maxBytes: number): Promise<ImageContent | null> {
	const mimeType = detectSupportedImageMimeType(bytes);
	if (mimeType === null || maxBytes <= 0) return null;
	const original: ImageContent = { type: "image", mimeType, data: bytes.toString("base64") };
	const resized = await resizeImage(original, { maxBytes });
	if (resized) return { type: "image", mimeType: resized.mimeType, data: resized.data };
	return Buffer.byteLength(original.data) <= maxBytes ? original : null;
}

async function readFileReferenceAsync(fileArg: string, options: FileReferenceOptions): Promise<FileReferenceResult> {
	const filePath = expandConfigPath(fileArg, options.cwd === undefined ? undefined : { cwd: options.cwd });
	if (!existsSync(filePath)) {
		if (options.missing === "leave") return result(`@${fileArg}`);
		return result("", [{ type: "error", message: `file not found: ${filePath}`, path: filePath }]);
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(filePath);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return result("", [{ type: "error", message: `file could not be stat'ed: ${reason}`, path: filePath }]);
	}
	if (!stat.isFile()) {
		return result("", [{ type: "error", message: `not a file: ${filePath}`, path: filePath }]);
	}
	if (stat.size === 0) return result("", [], [], [filePath]);
	try {
		const signature = readSignature(filePath, stat.size);
		const imageMimeType = detectSupportedImageMimeType(signature);
		if (imageMimeType) {
			if (options.includeImages !== true) return result(`@${fileArg}`);

			const bytes = readFileSync(filePath);
			const originalImage: ImageContent = {
				type: "image",
				mimeType: imageMimeType,
				data: bytes.toString("base64"),
			};
			if (options.autoResizeImages === false) {
				return result(renderImageFile(filePath), [], [originalImage], [filePath]);
			}

			const resized = await resizeImage(originalImage);
			if (!resized) {
				if (Buffer.byteLength(originalImage.data, "utf-8") < DEFAULT_IMAGE_MAX_BASE64_BYTES) {
					return result(renderImageFile(filePath), [], [originalImage], [filePath]);
				}
				return result(
					renderImageFile(filePath, "[Image omitted: could not be resized below the inline image size limit.]"),
					[],
					[],
					[filePath],
				);
			}

			return result(
				renderImageFile(filePath, formatDimensionNote(resized)),
				[],
				[{ type: "image", mimeType: resized.mimeType, data: resized.data }],
				[filePath],
			);
		}
		// A notebook is JSON text and inlines like any other text file.
		const kind = detectDocumentKind(filePath, signature);
		if (kind !== null && kind !== "notebook") {
			const document = await renderDocumentReference(filePath, kind, stat.size);
			return result(document.text, document.diagnostic ? [document.diagnostic] : [], [], [filePath]);
		}
		const size = formatSize(stat.size);
		const binary = (what: string) =>
			result(
				renderFileNote(filePath, `${what} (${size}), not inlined; inspect it with run_script and a library for its format`),
				[{ type: "warning", message: `${what} not inlined (${size})`, path: filePath }],
				[],
				[filePath],
			);
		if (signature.includes(0)) return binary("binary file");
		if (stat.size > INLINE_TEXT_MAX_BYTES) {
			return result(
				renderFileNote(
					filePath,
					`text file (${size}) is larger than the ${formatSize(INLINE_TEXT_MAX_BYTES)} inline limit, not inlined; read it in windows with read and offset/limit`,
				),
				[{ type: "warning", message: `text file not inlined (${size})`, path: filePath }],
				[],
				[filePath],
			);
		}
		const bytes = readFileSync(filePath);
		if (!isUtf8(bytes)) return binary("file that is not UTF-8 text");
		return result(renderTextFile(filePath, bytes.toString("utf8")), [], [], [filePath]);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return result("", [{ type: "error", message: `file could not be read: ${reason}`, path: filePath }]);
	}
}

export async function readFileArgsAsync(
	fileArgs: ReadonlyArray<string>,
	options: FileReferenceOptions = {},
): Promise<FileReferenceResult> {
	const diagnostics: FileReferenceDiagnostic[] = [];
	const images: ImageContent[] = [];
	const referencedPaths: string[] = [];
	let text = "";
	for (const fileArg of fileArgs) {
		const ref = await readFileReferenceAsync(fileArg, {
			...options,
			missing: options.missing ?? "error",
			includeImages: true,
		});
		text += ref.text;
		images.push(...ref.images);
		diagnostics.push(...ref.diagnostics);
		referencedPaths.push(...ref.referencedPaths);
	}
	return { text, images, diagnostics, referencedPaths };
}

function splitTrailingPunctuation(token: string): { fileArg: string; suffix: string } {
	const match = token.match(/^(.+?)([),.;:!?]+)$/);
	if (!match?.[1] || !match[2]) return { fileArg: token, suffix: "" };
	const candidate = match[1];
	const suffix = match[2];
	const ext = path.extname(candidate);
	if (ext.length === 0 && suffix.startsWith(".")) return { fileArg: token, suffix: "" };
	return { fileArg: candidate, suffix };
}

export async function expandInlineFileReferencesAsync(
	input: string,
	options: FileReferenceOptions = {},
): Promise<FileReferenceResult> {
	const diagnostics: FileReferenceDiagnostic[] = [];
	const images: ImageContent[] = [];
	const referencedPaths: string[] = [];
	let text = "";
	let lastIndex = 0;
	for (const reference of inlineFileReferences(input)) {
		text += input.slice(lastIndex, reference.start);

		const direct = await readFileReferenceAsync(reference.fileArg, {
			...options,
			missing: "leave",
			includeImages: options.includeImages === true,
		});
		if (direct.text !== `@${reference.fileArg}`) {
			diagnostics.push(...direct.diagnostics);
			images.push(...direct.images);
			referencedPaths.push(...direct.referencedPaths);
			text += direct.text;
			lastIndex = reference.end;
			continue;
		}

		const { fileArg, suffix } = reference.quoted
			? { fileArg: reference.fileArg, suffix: "" }
			: splitTrailingPunctuation(reference.fileArg);
		if (fileArg === reference.fileArg) {
			text += reference.raw;
			lastIndex = reference.end;
			continue;
		}

		const stripped = await readFileReferenceAsync(fileArg, {
			...options,
			missing: "leave",
			includeImages: options.includeImages === true,
		});
		if (stripped.text === `@${fileArg}`) {
			text += reference.raw;
			lastIndex = reference.end;
			continue;
		}
		diagnostics.push(...stripped.diagnostics);
		images.push(...stripped.images);
		referencedPaths.push(...stripped.referencedPaths);
		text += `${stripped.text}${suffix}`;
		lastIndex = reference.end;
	}
	text += input.slice(lastIndex);
	return { text, images, diagnostics, referencedPaths };
}
