/**
 * The images a settled tool result can show a person, read from the shape every surface stores: the result's
 * `content` blocks (what the model saw on an image route) and `details.shots` (the screenshot files the browser tool
 * wrote, present on every route). Shared by the ACP wire, the terminal card and `/view` so each surface draws the same
 * screenshots. Pure: no file reads.
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The display MIME type of an image file by its extension, or null for a file no surface draws. */
export function displayImageMimeType(path: string): string | null {
	return DISPLAY_IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

/** Inline image blocks of a tool result (`{content: [...]}` or a bare block array) in an allow-listed format. */
export function toolResultImages(result: unknown): ToolResultImage[] {
	const blocks = Array.isArray(result)
		? result
		: isRecord(result) && Array.isArray(result.content)
			? result.content
			: [];
	const images: ToolResultImage[] = [];
	for (const block of blocks) {
		if (!isRecord(block) || block.type !== "image") continue;
		const { mimeType, data } = block;
		if (typeof mimeType !== "string" || !DISPLAY_IMAGE_MIME_TYPES.has(mimeType)) continue;
		if (typeof data !== "string" || data.length === 0 || !BASE64.test(data)) continue;
		images.push({ mimeType, data });
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
