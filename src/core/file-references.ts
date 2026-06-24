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

const FILE_REF = /(^|\s)@(\S+)/g;
const DEFAULT_IMAGE_MAX_BASE64_BYTES = 4.5 * 1024 * 1024;

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

function readFileReference(fileArg: string, options: FileReferenceOptions): FileReferenceResult {
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
			return result(
				renderImageFile(filePath),
				[],
				[{ type: "image", mimeType: imageMimeType, data: bytes.toString("base64") }],
				[filePath],
			);
		}
		return result(renderTextFile(filePath, bytes.toString("utf8")), [], [], [filePath]);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return result("", [{ type: "error", message: `file could not be read: ${reason}`, path: filePath }]);
	}
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

export function expandInlineFileReferences(input: string, options: FileReferenceOptions = {}): FileReferenceResult {
	const diagnostics: FileReferenceDiagnostic[] = [];
	const images: ImageContent[] = [];
	const referencedPaths: string[] = [];
	const text = input.replace(FILE_REF, (match: string, prefix: string, token: string) => {
		const direct = readFileReference(token, {
			...options,
			missing: "leave",
			includeImages: options.includeImages === true,
		});
		if (direct.text !== `@${token}`) {
			diagnostics.push(...direct.diagnostics);
			images.push(...direct.images);
			referencedPaths.push(...direct.referencedPaths);
			return `${prefix}${direct.text}`;
		}

		const { fileArg, suffix } = splitTrailingPunctuation(token);
		if (fileArg === token) return match;
		const stripped = readFileReference(fileArg, {
			...options,
			missing: "leave",
			includeImages: options.includeImages === true,
		});
		if (stripped.text === `@${fileArg}`) return match;
		diagnostics.push(...stripped.diagnostics);
		images.push(...stripped.images);
		referencedPaths.push(...stripped.referencedPaths);
		return `${prefix}${stripped.text}${suffix}`;
	});
	return { text, images, diagnostics, referencedPaths };
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
	for (const match of input.matchAll(FILE_REF)) {
		const index = match.index ?? 0;
		const full = match[0] ?? "";
		const prefix = match[1] ?? "";
		const token = match[2] ?? "";
		text += input.slice(lastIndex, index);

		const direct = await readFileReferenceAsync(token, {
			...options,
			missing: "leave",
			includeImages: options.includeImages === true,
		});
		if (direct.text !== `@${token}`) {
			diagnostics.push(...direct.diagnostics);
			images.push(...direct.images);
			referencedPaths.push(...direct.referencedPaths);
			text += `${prefix}${direct.text}`;
			lastIndex = index + full.length;
			continue;
		}

		const { fileArg, suffix } = splitTrailingPunctuation(token);
		if (fileArg === token) {
			text += full;
			lastIndex = index + full.length;
			continue;
		}

		const stripped = await readFileReferenceAsync(fileArg, {
			...options,
			missing: "leave",
			includeImages: options.includeImages === true,
		});
		if (stripped.text === `@${fileArg}`) {
			text += full;
			lastIndex = index + full.length;
			continue;
		}
		diagnostics.push(...stripped.diagnostics);
		images.push(...stripped.images);
		referencedPaths.push(...stripped.referencedPaths);
		text += `${prefix}${stripped.text}${suffix}`;
		lastIndex = index + full.length;
	}
	text += input.slice(lastIndex);
	return { text, images, diagnostics, referencedPaths };
}
