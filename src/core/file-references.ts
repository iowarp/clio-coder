import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ImageContent } from "../engine/types.js";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.js";
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

function result(
	text: string,
	diagnostics: FileReferenceDiagnostic[] = [],
	images: ImageContent[] = [],
	referencedPaths: string[] = [],
): FileReferenceResult {
	return { text, diagnostics, images, referencedPaths };
}

function detectSupportedImageMimeType(bytes: Buffer): string | null {
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
		const bytes = readFileSync(filePath);
		const imageMimeType = detectSupportedImageMimeType(bytes);
		if (imageMimeType) {
			if (options.includeImages !== true) return result(`@${fileArg}`);

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
