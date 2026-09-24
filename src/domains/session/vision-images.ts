import type { ImageContent } from "../../engine/types.js";
import type { SessionEntry } from "./entries.js";
import { filterEntriesToActivePath } from "./tree/active-path.js";

function isImageContent(value: unknown): value is ImageContent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const block = value as Record<string, unknown>;
	return block.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string";
}

/** Keep an explicit vision question on the current branch, including after resume. */
export function latestUserImages(entries: ReadonlyArray<SessionEntry>, leafTurnId?: string): ImageContent[] {
	const active = filterEntriesToActivePath(entries, leafTurnId);
	for (let index = active.length - 1; index >= 0; index -= 1) {
		const entry = active[index];
		if (entry?.kind !== "message" || entry.role !== "user") continue;
		const payload = entry.payload as { content?: unknown };
		if (!Array.isArray(payload?.content)) continue;
		const images = payload.content.filter(isImageContent);
		if (images.length > 0) return images;
	}
	return [];
}
