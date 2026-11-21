/**
 * What a tool row draws for the images a call returned: a browser screenshot
 * the agent took, or the path of one when the route takes no images. Pure: the
 * card renders the result and decides nothing.
 *
 * The server already bounds and allow-lists the field (supervisor.ts
 * `toolImages`); this module checks again, because a data URL built from a
 * type the browser would sniff differently (SVG carries script) is the one
 * mistake an `<img>` cannot undo.
 */

import type { TimelineItem } from "../../contracts/sessions.js";

const DRAWABLE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const TOOL_IMAGES_SHOWN = 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ToolImageView {
	readonly key: string;
	/** A `data:` URL with the allow-listed type; the CSP admits `img-src data:`. */
	readonly src: string;
	readonly alt: string;
}

export interface ToolImageLinkView {
	readonly key: string;
	readonly path: string;
	/** The file's name, shown as the link's label; the full path rides in the title. */
	readonly label: string;
}

export interface ToolImagesView {
	readonly images: readonly ToolImageView[];
	readonly links: readonly ToolImageLinkView[];
}

/** `toolName` is the card's canonical name (`presentTool(item).name`), so the alt text says which tool drew it. */
export function toolImagesView(item: Pick<TimelineItem, "images" | "imageLinks">, toolName: string): ToolImagesView {
	const drawable = (item.images ?? [])
		.filter((image) => DRAWABLE_TYPES.has(image.mimeType) && image.data.length > 0 && BASE64.test(image.data))
		.slice(0, TOOL_IMAGES_SHOWN);
	const name = toolName.trim() || "tool";
	const images = drawable.map((image, index) => ({
		key: `${index}:${image.mimeType}:${image.data.length}`,
		src: `data:${image.mimeType};base64,${image.data}`,
		alt:
			drawable.length === 1 ? `Image returned by ${name}` : `Image ${index + 1} of ${drawable.length} returned by ${name}`,
	}));
	const links = (item.imageLinks ?? [])
		.filter((link) => link.path.length > 0)
		.slice(0, TOOL_IMAGES_SHOWN)
		.map((link, index) => ({
			key: `${index}:${link.path}`,
			path: link.path,
			label: link.name.trim() || link.path,
		}));
	return { images, links };
}
