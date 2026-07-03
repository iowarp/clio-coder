import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThinkingLevel } from "../../src/domains/providers/index.js";
import type { SessionMeta } from "../../src/domains/session/contract.js";
import { buildSessionItems } from "../../src/interactive/overlays/session-selector.js";
import { buildThinkingItems } from "../../src/interactive/overlays/thinking-selector.js";
import { GLYPH } from "../../src/interactive/theme/index.js";

describe("contracts/small selectors", () => {
	it("the thinking picker marks the current level with the active mark, not the running dot", () => {
		const levels: ThinkingLevel[] = ["off", "low", "medium", "high"];
		const items = buildThinkingItems("medium", levels);

		const current = items.find((item) => item.value === "medium");
		ok(current, "expected a row for the current level");
		ok(current.label.startsWith(GLYPH.active), current.label);
		ok(!current.label.includes(GLYPH.running), current.label);

		// Every other level leads with a blank marker column, never a glyph.
		for (const item of items) {
			if (item.value === "medium") continue;
			ok(item.label.startsWith(" "), item.label);
			ok(!item.label.includes(GLYPH.active), item.label);
		}
	});

	it("the resume picker glyphs an ended session ok and an open session running", () => {
		const base = {
			cwd: "/tmp/project",
			createdAt: "2026-07-03T14:00:00Z",
			lastActivityAt: "2026-07-03T15:00:00Z",
			messageCount: 3,
			target: "anthropic",
			model: "claude-sonnet-5",
			firstMessagePreview: "hello",
		};
		const ended: SessionMeta = { ...base, id: "ended", endedAt: "2026-07-03T15:30:00Z" } as SessionMeta;
		const open: SessionMeta = { ...base, id: "open", endedAt: null } as SessionMeta;

		const [endedItem, openItem] = buildSessionItems([ended, open], Date.parse("2026-07-03T16:00:00Z"));

		strictEqual(endedItem?.label.startsWith(GLYPH.ok), true);
		strictEqual(openItem?.label.startsWith(GLYPH.running), true);
		// The retired raw check mark literal never leaks into a row label.
		ok(!openItem?.label.includes(GLYPH.ok), openItem?.label);
	});
});
