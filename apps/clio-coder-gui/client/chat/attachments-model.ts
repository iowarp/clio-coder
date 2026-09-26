// What may ride a request as images, decided before any pixels are read. The agent judges each image
// by its bytes and resizes it again; these rules only keep a request inside the one stdio line the
// agent reads it from, and say why when an image cannot come along.

import { TURN_IMAGE_MAX, TURN_IMAGE_TYPES, TURN_IMAGES_MAX_BASE64 } from "../../contracts/attachments.js";

export type AttachmentType = (typeof TURN_IMAGE_TYPES)[number];

export interface Attachment {
	id: string;
	name: string;
	mimeType: AttachmentType;
	/** Base64 of the bytes that will be sent, after any downscale. */
	data: string;
	width: number;
	height: number;
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

/** Whether one more image fits beside those already attached, and why not when it does not. */
export function admitAttachment(current: readonly Attachment[], next: Pick<Attachment, "data" | "name">) {
	if (current.length >= TURN_IMAGE_MAX)
		return { ok: false as const, reason: `A request carries at most ${TURN_IMAGE_MAX} images.` };
	const used = current.reduce((total, item) => total + item.data.length, 0);
	if (used + next.data.length > TURN_IMAGES_MAX_BASE64)
		return {
			ok: false as const,
			reason: `${next.name} would make this request too large to send. Remove an image or attach a smaller one.`,
		};
	return { ok: true as const };
}

/** How the attachments read beside Send; empty when there are none. */
export function attachmentSummary(current: readonly Attachment[]): string {
	if (current.length === 0) return "";
	const kib = Math.round((current.reduce((total, item) => total + item.data.length, 0) * 3) / 4 / 1024);
	return `${current.length} ${current.length === 1 ? "image" : "images"}, about ${kib} KiB`;
}

/** Images go with a new request only: steering text cannot carry them. */
export function attachmentRefusal(current: readonly Attachment[], running: boolean): string | null {
	if (current.length === 0 || !running) return null;
	return "Images go with a new request. Send them once this turn finishes, or remove them to add direction now.";
}
