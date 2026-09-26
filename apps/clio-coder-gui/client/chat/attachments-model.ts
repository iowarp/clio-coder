// What may ride a request as images or text files, decided before any of it is sent. The agent
// judges each image by its bytes and resizes it again; these rules only keep a request inside the one
// stdio line the agent reads it from, and say why when an attachment cannot come along.

import {
	attachmentWeight,
	TURN_FILE_MAX,
	TURN_FILE_MAX_BYTES,
	TURN_IMAGE_MAX,
	TURN_IMAGE_TYPES,
	TURN_IMAGES_MAX_BASE64,
} from "../../contracts/attachments.js";

export type AttachmentType = (typeof TURN_IMAGE_TYPES)[number];

export interface ImageAttachment {
	id: string;
	kind: "image";
	name: string;
	mimeType: AttachmentType;
	/** Base64 of the bytes that will be sent, after any downscale. */
	data: string;
	width: number;
	height: number;
}

/** A text file the agent receives as an embedded resource, beside the request rather than inside it. */
export interface FileAttachment {
	id: string;
	kind: "file";
	name: string;
	text: string;
	/** UTF-8 size of `text`. */
	bytes: number;
}

export type Attachment = ImageAttachment | FileAttachment;

const imagesOf = (items: readonly Attachment[]) =>
	items.filter((item): item is ImageAttachment => item.kind === "image");
const filesOf = (items: readonly Attachment[]) => items.filter((item): item is FileAttachment => item.kind === "file");
const weightOf = (items: readonly Attachment[]) => attachmentWeight(imagesOf(items), filesOf(items));

/**
 * A picked file read as text, or the reason it cannot be. Only UTF-8 text without NUL or terminal
 * control bytes is sent: anything else is a binary the model would read as noise, and control bytes
 * are what would let a file outgrow its budget once escaped.
 */
export function decodeTextFile(
	name: string,
	bytes: Uint8Array,
): { ok: true; text: string; bytes: number } | { ok: false; reason: string } {
	if (bytes.length > TURN_FILE_MAX_BYTES)
		return { ok: false, reason: `${name} is larger than ${TURN_FILE_MAX_BYTES / 1024} KiB. Attach a smaller file.` };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { ok: false, reason: `${name} is not UTF-8 text.` };
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control bytes.
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
		return { ok: false, reason: `${name} is not a text file.` };
	if (text.trim() === "") return { ok: false, reason: `${name} is empty.` };
	return { ok: true, text, bytes: bytes.length };
}

/** Longest edge sent. Larger images are drawn down to it; the agent's own resize does the rest. */
export const ATTACHMENT_MAX_EDGE = 1568;

export function acceptsType(type: string): type is AttachmentType {
	return (TURN_IMAGE_TYPES as readonly string[]).includes(type);
}

/** The size an image is drawn at, never larger than it was. */
export function fittedSize(width: number, height: number, maxEdge = ATTACHMENT_MAX_EDGE) {
	const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether one more attachment fits beside those already attached, and why not when it does not. */
export function admitAttachment(current: readonly Attachment[], next: Attachment) {
	if (next.kind === "image" && imagesOf(current).length >= TURN_IMAGE_MAX)
		return { ok: false as const, reason: `A request carries at most ${TURN_IMAGE_MAX} images.` };
	if (next.kind === "file" && filesOf(current).length >= TURN_FILE_MAX)
		return { ok: false as const, reason: `A request carries at most ${TURN_FILE_MAX} files.` };
	if (weightOf(current) + weightOf([next]) > TURN_IMAGES_MAX_BASE64)
		return {
			ok: false as const,
			reason: `${next.name} would make this request too large to send. Remove an attachment or attach a smaller one.`,
		};
	return { ok: true as const };
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** How the attachments read beside Send; empty when there are none. */
export function attachmentSummary(current: readonly Attachment[]): string {
	if (current.length === 0) return "";
	const images = imagesOf(current);
	const files = filesOf(current);
	const bytes =
		images.reduce((total, item) => total + (item.data.length * 3) / 4, 0) +
		files.reduce((total, item) => total + item.bytes, 0);
	const parts = [
		...(images.length > 0 ? [counted(images.length, "image")] : []),
		...(files.length > 0 ? [counted(files.length, "file")] : []),
	];
	return `${parts.join(" and ")}, about ${Math.round(bytes / 1024)} KiB`;
}

/** Attachments go with a new request only: steering text cannot carry them. */
export function attachmentRefusal(current: readonly Attachment[], running: boolean): string | null {
	if (current.length === 0 || !running) return null;
	return "Attachments go with a new request. Send them once this turn finishes, or remove them to add direction now.";
}
