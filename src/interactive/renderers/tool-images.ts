/**
 * Screenshots inside a settled tool card. A terminal that speaks the Kitty or iTerm2 graphics protocol draws each
 * image inline under the result; every other terminal keeps the text the result already prints (the screenshot
 * paths and the `[image …]` placeholder), so nothing is added there.
 *
 * Images come from the result's own image blocks (what an image route sent the model) and, when it carries none,
 * from the screenshot files it names in `details.shots`, so a text-only route still shows the person its screenshots.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
	displayImageMimeType,
	type ToolResultImage,
	toolResultImages,
	toolResultShotPaths,
} from "../../core/tool-result-images.js";
import { getCapabilities, Image } from "../../engine/tui.js";
import { cardRail } from "../card.js";
import { clioTheme } from "../theme/index.js";

/** Images drawn under one card; the rest stay listed by path in the result text. */
const MAX_CARD_IMAGES = 4;
/** Rows one image may take, so a full-page screenshot does not push the conversation off screen. */
const MAX_IMAGE_ROWS = 18;
const MAX_IMAGE_COLUMNS = 100;
/** A screenshot file read for display is skipped above this size. */
const MAX_SHOT_FILE_BYTES = 8 * 1024 * 1024;
const CACHE_LIMIT = 32;

interface CardImage extends ToolResultImage {
	key: string;
	filename?: string;
}

const components = new Map<string, Image>();

function cached(image: CardImage): Image {
	// The protocol is part of the key: a component keeps the rows it drew for the protocol it saw first.
	const key = `${getCapabilities().images}:${image.key}`;
	const existing = components.get(key);
	if (existing !== undefined) {
		// Refresh recency so the oldest image is the one evicted.
		components.delete(key);
		components.set(key, existing);
		return existing;
	}
	const component = new Image(
		image.data,
		image.mimeType,
		{ fallbackColor: (text) => clioTheme().fg("annotation", text) },
		{
			maxWidthCells: MAX_IMAGE_COLUMNS,
			maxHeightCells: MAX_IMAGE_ROWS,
			...(image.filename !== undefined ? { filename: image.filename } : {}),
		},
	);
	components.set(key, component);
	if (components.size > CACHE_LIMIT) {
		const oldest = components.keys().next().value;
		if (oldest !== undefined) components.delete(oldest);
	}
	return component;
}

function shotImage(path: string): CardImage | null {
	const mimeType = displayImageMimeType(path);
	if (mimeType === null) return null;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SHOT_FILE_BYTES) return null;
		const key = `file:${path}:${stat.mtimeMs}:${stat.size}`;
		if (components.has(`${getCapabilities().images}:${key}`))
			return { key, mimeType, data: "", filename: basename(path) };
		return { key, mimeType, data: readFileSync(path).toString("base64"), filename: basename(path) };
	} catch {
		return null;
	}
}

function cardImages(result: unknown): CardImage[] {
	const inline = toolResultImages(result);
	if (inline.length > 0) {
		return inline.slice(0, MAX_CARD_IMAGES).map((image) => ({
			...image,
			key: `inline:${image.mimeType}:${image.data.length}:${image.data.slice(0, 48)}:${image.data.slice(-48)}`,
		}));
	}
	const images: CardImage[] = [];
	for (const path of toolResultShotPaths(result)) {
		const image = shotImage(path);
		if (image !== null) images.push(image);
		if (images.length >= MAX_CARD_IMAGES) break;
	}
	return images;
}

/**
 * Rows drawing one image at most `width` columns wide, or none when the terminal draws no images. The `/view`
 * overlay uses it for a screenshot artifact.
 */
export function inlineImageRows(image: ToolResultImage & { key: string; filename?: string }, width: number): string[] {
	if (getCapabilities().images === null) return [];
	return cached(image).render(Math.max(4, Math.min(MAX_IMAGE_COLUMNS, width)));
}

/**
 * Rows drawing a settled result's images inside the card rail, or none when the terminal draws no images, the
 * result has none, or the card is being written out as text (`unbounded`, the export and inspection path).
 */
export function renderToolResultImages(result: unknown, width: number, opts: { unbounded?: boolean } = {}): string[] {
	if (opts.unbounded === true || getCapabilities().images === null) return [];
	const images = cardImages(result);
	if (images.length === 0) return [];
	const rail = cardRail(false);
	const columns = Math.max(4, Math.min(MAX_IMAGE_COLUMNS, width - 4));
	const rows: string[] = [];
	for (const image of images) {
		for (const line of cached(image).render(columns)) rows.push(`${rail}${line}`);
	}
	return rows;
}
