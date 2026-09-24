import { deepStrictEqual } from "node:assert/strict";
import { it } from "node:test";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { latestUserImages } from "../../src/domains/session/vision-images.js";

const first = { type: "image" as const, mimeType: "image/png", data: "FIRST" };
const second = { type: "image" as const, mimeType: "image/png", data: "SECOND" };
const sibling = { type: "image" as const, mimeType: "image/png", data: "SIBLING" };

function user(turnId: string, parentTurnId: string | null, image?: typeof first): SessionEntry {
	return {
		kind: "message",
		role: "user",
		turnId,
		parentTurnId,
		timestamp: "2026-09-24T00:00:00Z",
		payload: { content: [{ type: "text", text: turnId }, ...(image ? [image] : [])] },
	};
}

it("finds the latest original image on the active session branch", () => {
	const entries = [user("a", null, first), user("b", "a", second), user("c", "b"), user("d", "a", sibling)];
	deepStrictEqual(latestUserImages(entries, "c"), [second]);
	deepStrictEqual(latestUserImages(entries, "d"), [sibling]);
});
