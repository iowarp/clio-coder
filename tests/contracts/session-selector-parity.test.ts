import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionMeta } from "../../src/domains/session/contract.js";
import { createSessionOverlayBox } from "../../src/interactive/overlays/session-selector.js";

function session(index: number): SessionMeta {
	return {
		id: `session-${index.toString().padStart(2, "0")}`,
		cwd: "/tmp/project",
		createdAt: "2026-08-19T12:00:00.000Z",
		lastActivityAt: "2026-08-19T12:00:00.000Z",
		endedAt: "2026-08-19T12:00:00.000Z",
		messageCount: 1,
		firstMessagePreview: `prompt ${index}`,
	} as SessionMeta;
}

describe("contracts/session selector parity", () => {
	it("moves one visible page at a time before resuming the selected session", () => {
		let selected = "";
		const box = createSessionOverlayBox(
			Array.from({ length: 30 }, (_, index) => session(index)),
			(sessionId) => {
				selected = sessionId;
			},
			() => {},
		);

		box.handleInput("\u001b[6~");
		ok(box.render(110).join("\n").includes("(13/30)"));
		box.handleInput("\u001b[5~");
		ok(box.render(110).join("\n").includes("(1/30)"));
		box.handleInput("\u001b[6~");
		box.handleInput("\n");

		strictEqual(selected, "session-12");
		box.dispose();
	});
});
