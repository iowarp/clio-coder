import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { createFollowUpQueuePanel } from "../../src/interactive/follow-up-queue-panel.js";
import { GLYPH } from "../../src/interactive/theme/index.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function plain(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

describe("contracts/follow-up-queue", () => {
	it("marks a steer with the user glyph and never the tool ledger glyph", () => {
		const panel = createFollowUpQueuePanel();
		panel.setMessages([
			{ kind: "steer", text: "focus on the parser" },
			{ kind: "follow-up", text: "then run the tests" },
		]);

		const rendered = plain(panel.render(80).join("\n"));

		// A steer is the user's voice redirecting the live turn, so it carries the
		// user glyph. The queued follow-up keeps the queued glyph.
		ok(rendered.includes(`${GLYPH.user} steer`), rendered);
		ok(rendered.includes(`${GLYPH.queued} queued`), rendered);
		// The toolHeader glyph is reserved for the tool ledger and must not leak
		// into the steering queue panel.
		ok(!rendered.includes(GLYPH.toolHeader), rendered);
	});
});
