import { TURN_IMAGES_MAX_BASE64 } from "../../contracts/attachments.js";
import {
	ATTACHMENT_MAX_EDGE,
	type Attachment,
	acceptsType,
	admitAttachment,
	decodeTextFile,
} from "./attachments-model.js";

const KEY = "clio-coder-gui-attachments:";
const INDEX = "clio-coder-gui-attachment-index";
const MAX_SESSIONS = 32;

/** Restore only bounded, valid attachments. Recompute UTF-8 size instead of trusting stored metadata. */
export function decodeAttachmentDraft(raw: string | null): Attachment[] {
	if (!raw || raw.length > 2_000_000) return [];
	try {
		const data: unknown = JSON.parse(raw);
		if (!Array.isArray(data) || data.length > 8) return [];
		const restored: Attachment[] = [];
		for (const item of data) {
			if (
				!item ||
				typeof item !== "object" ||
				typeof item.id !== "string" ||
				!/^[!-~]{1,128}$/u.test(item.id) ||
				typeof item.name !== "string" ||
				!item.name ||
				item.name.length > 128
			)
				return [];
			// biome-ignore lint/suspicious/noControlCharactersInRegex: filenames may not contain control characters.
			if (/[\u0000-\u001f\u007f]/u.test(item.name) || restored.some((other) => other.id === item.id)) return [];
			let attachment: Attachment;
			if (item.kind === "file" && typeof item.text === "string") {
				const result = decodeTextFile(item.name, new TextEncoder().encode(item.text));
				if (!result.ok) return [];
				attachment = { id: item.id, name: item.name, kind: "file", text: result.text, bytes: result.bytes };
			} else if (
				item.kind === "image" &&
				acceptsType(item.mimeType) &&
				typeof item.data === "string" &&
				item.data.length <= TURN_IMAGES_MAX_BASE64 &&
				/^[A-Za-z0-9+/]+={0,2}$/u.test(item.data) &&
				item.data.length >= 4 &&
				[item.width, item.height].every((size) => Number.isInteger(size) && size > 0 && size <= ATTACHMENT_MAX_EDGE)
			) {
				attachment = {
					id: item.id,
					name: item.name,
					kind: "image",
					mimeType: item.mimeType,
					data: item.data,
					width: item.width,
					height: item.height,
				};
			} else return [];
			if (!admitAttachment(restored, attachment).ok) return [];
			restored.push(attachment);
		}
		return restored;
	} catch {
		return [];
	}
}

export function savedAttachments(sessionId: string): Attachment[] {
	try {
		return decodeAttachmentDraft(sessionStorage.getItem(`${KEY}${sessionId}`));
	} catch {
		return [];
	}
}

/** Draft bytes remain local to this browser tab. Acknowledged sends remove them. */
export function persistAttachments(sessionId: string, attachments: readonly Attachment[]): boolean {
	try {
		let parsed: unknown;
		try {
			parsed = JSON.parse(sessionStorage.getItem(INDEX) ?? "[]");
		} catch {
			parsed = [];
		}
		const index: string[] = Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string" && id !== sessionId)
			: [];
		if (attachments.length) {
			while (index.length >= MAX_SESSIONS) {
				const oldest = index.shift();
				if (oldest) sessionStorage.removeItem(`${KEY}${oldest}`);
			}
			sessionStorage.setItem(`${KEY}${sessionId}`, JSON.stringify(attachments));
			index.push(sessionId);
		} else sessionStorage.removeItem(`${KEY}${sessionId}`);
		sessionStorage.setItem(INDEX, JSON.stringify(index));
		return true;
	} catch {
		return false;
	}
}
