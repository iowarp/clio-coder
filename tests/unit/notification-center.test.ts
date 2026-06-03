import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	classifyNoticeLevel,
	createNotificationCenter,
	DEFAULT_INFO_TTL_MS,
	formatNotificationBadge,
	formatNotificationPanel,
	type Notification,
	notificationGlyph,
} from "../../src/interactive/footer/notifications.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function entry(overrides: Partial<Notification> = {}): Notification {
	return {
		id: "notice-1",
		level: "warning",
		text: "something happened",
		key: null,
		addedAt: 0,
		expiresAt: null,
		...overrides,
	};
}

describe("interactive/footer/notification-center state", () => {
	it("adds typed entries and lists them severity-first", () => {
		let clock = 1000;
		const center = createNotificationCenter({ now: () => clock });
		center.add({ level: "info", text: "info one" });
		clock = 1001;
		center.add({ level: "error", text: "boom" });
		clock = 1002;
		center.add({ level: "warning", text: "careful" });
		const list = center.list();
		strictEqual(list.length, 3);
		strictEqual(list[0]?.level, "error");
		strictEqual(list[1]?.level, "warning");
		strictEqual(list[2]?.level, "info");
	});

	it("auto-expires info entries but keeps warnings and errors", () => {
		let clock = 0;
		const center = createNotificationCenter({ now: () => clock });
		center.add({ level: "info", text: "fades" });
		center.add({ level: "warning", text: "stays" });
		strictEqual(center.count(), 2);
		clock = DEFAULT_INFO_TTL_MS + 1;
		const list = center.list();
		strictEqual(list.length, 1);
		strictEqual(list[0]?.level, "warning");
		strictEqual(center.hasBlocking(), true);
	});

	it("honors an explicit ttl and a pinned (ttl 0) entry", () => {
		let clock = 0;
		const center = createNotificationCenter({ now: () => clock });
		center.add({ level: "info", text: "short", ttlMs: 50 });
		center.add({ level: "info", text: "pinned", ttlMs: 0 });
		clock = 100;
		const list = center.list();
		strictEqual(list.length, 1);
		strictEqual(list[0]?.text, "pinned");
	});

	it("replaces an entry that re-adds the same key instead of stacking", () => {
		const center = createNotificationCenter({ now: () => 0 });
		center.add({ level: "info", text: "connecting mini", key: "connect:mini" });
		center.add({ level: "warning", text: "mini failed", key: "connect:mini" });
		const list = center.list();
		strictEqual(list.length, 1);
		strictEqual(list[0]?.text, "mini failed");
		strictEqual(list[0]?.level, "warning");
	});

	it("dismisses by id or by key, and dismissAll clears everything", () => {
		const center = createNotificationCenter({ now: () => 0 });
		const id = center.add({ level: "warning", text: "by id" });
		center.add({ level: "warning", text: "by key", key: "k" });
		strictEqual(center.dismiss(id), true);
		strictEqual(center.dismiss("k"), true);
		strictEqual(center.dismiss("missing"), false);
		center.add({ level: "error", text: "again" });
		center.dismissAll();
		strictEqual(center.count(), 0);
	});

	it("fires onChange on add and dismiss so the footer can redraw", () => {
		let changes = 0;
		const center = createNotificationCenter({ now: () => 0, onChange: () => (changes += 1) });
		const id = center.add({ level: "warning", text: "x" });
		center.dismiss(id);
		strictEqual(changes, 2);
	});

	it("classifies legacy notice strings into levels", () => {
		strictEqual(classifyNoticeLevel("Clio keybinding notice: ... may not fire ..."), "warning");
		strictEqual(classifyNoticeLevel("clio: CLIO.md fingerprint differs from current project state."), "warning");
		strictEqual(classifyNoticeLevel("clio: malformed CLIO.md ignored: boom"), "error");
		strictEqual(classifyNoticeLevel("clio: No CLIO.md detected. Run /init."), "info");
	});
});

describe("interactive/footer/notification-center rendering", () => {
	it("renders a single compact badge with the most-severe glyph and a count", () => {
		const badge = formatNotificationBadge([entry({ level: "warning" }), entry({ id: "notice-2", level: "info" })], 80);
		ok(badge);
		const text = stripAnsi(badge);
		ok(text.includes(notificationGlyph("warning")), text);
		ok(text.includes("2 notices"), text);
		ok(text.includes("Alt+X dismiss"), text);
	});

	it("returns null when there are no notices to badge", () => {
		strictEqual(formatNotificationBadge([], 80), null);
		strictEqual(formatNotificationPanel([], 80).length, 0);
	});

	it("uses the resolved dismiss key label in badge and panel", () => {
		const badge = formatNotificationBadge([entry()], 80, { dismissKeyLabel: "Ctrl+Q" });
		ok(badge);
		ok(stripAnsi(badge).includes("Ctrl+Q dismiss"), stripAnsi(badge));
		const panel = formatNotificationPanel([entry()], 80, { dismissKeyLabel: "Ctrl+Q" });
		ok(stripAnsi(panel.join("\n")).includes("Ctrl+Q dismiss"), stripAnsi(panel.join("\n")));
	});

	it("renders an expanded panel header, rows, and a dismiss hint", () => {
		const lines = formatNotificationPanel([entry({ text: "first" }), entry({ id: "notice-2", text: "second" })], 60);
		const text = stripAnsi(lines.join("\n"));
		ok(text.toLowerCase().includes("notices"), text);
		ok(text.includes("first"), text);
		ok(text.includes("second"), text);
		ok(text.includes("Alt+X dismiss"), text);
	});

	it("caps panel rows and reports the overflow count", () => {
		const many = Array.from({ length: 7 }, (_, i) => entry({ id: `notice-${i}`, text: `row ${i}` }));
		const lines = formatNotificationPanel(many, 60, { maxRows: 3 });
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("+4 more"), text);
	});

	it("keeps badge and panel width-safe across terminals", () => {
		const sample = [entry({ level: "error", text: "a very long notice string that should never overflow the footer" })];
		for (const width of [24, 40, 80, 120]) {
			const badge = formatNotificationBadge(sample, width);
			if (badge) ok(visibleWidth(badge) <= width, `badge too wide at ${width}: ${visibleWidth(badge)}`);
			for (const line of formatNotificationPanel(sample, width)) {
				ok(visibleWidth(line) <= width, `panel line too wide at ${width}: ${visibleWidth(line)}`);
			}
		}
	});
});
