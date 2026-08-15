import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionMeta } from "../../src/domains/session/contract.js";
import { relative } from "../../src/interactive/format-time.js";
import { buildSessionItems, formatRelativeTime } from "../../src/interactive/overlays/session-selector.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import { withTimeZone } from "../harness/clock.js";

describe("contracts/small selectors", () => {
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

	// Past 30 days the relative ladder falls back to a calendar date. That date
	// is the operator's, so a session last touched at 02:30Z reads as the 14th
	// in Chicago and the 15th in Kolkata rather than UTC's answer in both.
	it("the resume picker dates an old session in the operator's zone", () => {
		const meta: SessionMeta = {
			cwd: "/tmp/project",
			id: "old",
			createdAt: "2026-06-15T02:30:00.000Z",
			lastActivityAt: "2026-06-15T02:30:00.000Z",
			endedAt: "2026-06-15T02:30:00.000Z",
			messageCount: 1,
			firstMessagePreview: "hello",
		} as SessionMeta;
		const now = Date.parse("2026-08-15T02:30:00.000Z");
		const strip = (zone: string): string => withTimeZone(zone, () => buildSessionItems([meta], now)[0]?.label ?? "");

		ok(strip("America/Chicago").includes("2026-06-14"), strip("America/Chicago"));
		ok(strip("Asia/Kolkata").includes("2026-06-15"), strip("Asia/Kolkata"));
		ok(strip("UTC").includes("2026-06-15"), strip("UTC"));
	});

	// The two relative formatters had diverged: /resume had a week branch and the
	// welcome banner did not, so one artifact read "1w ago" here and "10d ago"
	// there. One module, one ladder.
	it("the resume picker and the welcome banner age the same instant identically", () => {
		const now = Date.parse("2026-08-15T02:30:00.000Z");
		const tenDaysAgo = now - 10 * 86_400_000;
		strictEqual(formatRelativeTime(new Date(tenDaysAgo).toISOString(), now), "1w ago");
		strictEqual(relative(tenDaysAgo, now), "1w ago");
	});
});
