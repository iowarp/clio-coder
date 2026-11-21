/**
 * The images a settled tool result can show a person, read from the shape every surface stores: the result's
 * `content` blocks (what the model saw on an image route), `details.displayImages` (the bounded display copies the
 * browser tool makes when the route takes no image input, so the model saw none) and `details.shots` (the screenshot
 * files the browser tool wrote, present on every route). Shared by the ACP wire, the terminal card and `/view` so each
 * surface draws the same screenshots. Pure: no file reads.
 */
import { extname, isAbsolute } from "node:path";

export interface ToolResultImage {
	mimeType: string;
	data: string;
}

const DISPLAY_IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
const DISPLAY_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(Object.values(DISPLAY_IMAGE_MIME_BY_EXTENSION));
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
/** No surface draws more screenshots than this for one call. */
export const MAX_DISPLAY_SHOTS = 8;
/** Display copies one result carries in `details.displayImages`, and their base64 characters together. */
export const MAX_DISPLAY_IMAGES = 4;
export const DISPLAY_IMAGES_MAX_CHARS = 192 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The display MIME type of an image file by its extension, or null for a file no surface draws. */
export function displayImageMimeType(path: string): string | null {
	return DISPLAY_IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

function drawableImage(value: unknown): ToolResultImage | null {
	if (!isRecord(value)) return null;
	const { mimeType, data } = value;
	if (typeof mimeType !== "string" || !DISPLAY_IMAGE_MIME_TYPES.has(mimeType)) return null;
	if (typeof data !== "string" || data.length === 0 || !BASE64.test(data)) return null;
	return { mimeType, data };
}

/**
 * Images of a tool result (`{content: [...]}` or a bare block array) in an allow-listed format: its inline image
 * blocks, or when it has none its `details.displayImages` copies.
 */
export function toolResultImages(result: unknown): ToolResultImage[] {
	const blocks = Array.isArray(result)
		? result
		: isRecord(result) && Array.isArray(result.content)
			? result.content
			: [];
	const images: ToolResultImage[] = [];
	for (const block of blocks) {
		const image = isRecord(block) && block.type === "image" ? drawableImage(block) : null;
		if (image !== null) images.push(image);
	}
	if (images.length > 0) return images;
	const details = isRecord(result) && isRecord(result.details) ? result.details : null;
	if (details === null || !Array.isArray(details.displayImages)) return images;
	for (const copy of details.displayImages.slice(0, MAX_DISPLAY_IMAGES)) {
		const image = drawableImage(copy);
		if (image !== null) images.push(image);
	}
	return images;
}

/** Absolute screenshot paths a tool result names in `details.shots`, in order, deduplicated and capped. */
export function toolResultShotPaths(result: unknown): string[] {
	const details = isRecord(result) && isRecord(result.details) ? result.details : null;
	if (details === null || !Array.isArray(details.shots)) return [];
	const paths: string[] = [];
	for (const shot of details.shots) {
		if (typeof shot !== "string" || !isAbsolute(shot) || displayImageMimeType(shot) === null) continue;
		if (shot.includes("\n") || paths.includes(shot)) continue;
		paths.push(shot);
		if (paths.length >= MAX_DISPLAY_SHOTS) break;
	}
	return paths;
}
