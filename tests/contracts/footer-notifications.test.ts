import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	formatNotificationBadge,
	formatNotificationPanel,
	type Notification,
} from "../../src/interactive/footer/notifications.js";
import { createClioTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function notice(text: string): Notification {
	return {
		id: "notice-1",
		level: "info",
		text,
		key: null,
		addedAt: 0,
		expiresAt: null,
	};
}

describe("contracts/footer notification widths", () => {
	it("reserves the severity/count head and dismiss action before ellipsizing the message", () => {
		const badge = formatNotificationBadge(
			[notice("Configuration changed on disk and must be reloaded before continuing")],
			40,
			{ theme: createClioTheme({ color: false }) },
		);

		ok(badge);
		strictEqual(visibleWidth(badge), 40);
		ok(badge.startsWith("ℹ 1 notice · "), badge);
		ok(badge.includes("…"), badge);
		ok(badge.endsWith(" · [Alt+X] dismiss"), badge);
	});

	it("reduces to the meaningful head and action when no message column remains", () => {
		const badge = formatNotificationBadge([notice("Complete detail remains in the dashboard")], 21, {
			theme: createClioTheme({ color: false }),
		});

		strictEqual(badge, "ℹ 1 · [Alt+X] dismiss");
		strictEqual(visibleWidth(badge), 21);
	});

	it("degrades narrow footers by whole dismiss affordances, never a mid-word clip", () => {
		const theme = createClioTheme({ color: false });
		for (const [width, expected] of [
			[20, "ℹ 1 · [Alt+X]"],
			[16, "ℹ 1 · [Alt+X]"],
			[12, "ℹ 1"],
		] as const) {
			const badge = formatNotificationBadge([notice("Complete detail remains in the dashboard")], width, { theme });
			strictEqual(badge, expected, `${width} columns choose a whole compact unit`);
			ok(visibleWidth(badge ?? "") <= width);
		}
	});

	it("uses the compact fallback instead of a message body containing only an ellipsis", () => {
		const badge = formatNotificationBadge([notice("Complete detail remains in the dashboard")], 32, {
			theme: createClioTheme({ color: false }),
		});

		strictEqual(badge, "ℹ 1 · [Alt+X] dismiss");
	});

	it("fits styled ANSI output by visible columns without losing the action tail", () => {
		const theme = createClioTheme({ color: true, truecolor: true });
		const badge = formatNotificationBadge([notice("A deliberately long colored notification message")], 48, {
			theme,
		});

		ok(badge);
		ok(badge.includes(ESC), "the contract must exercise ANSI-styled segments");
		strictEqual(visibleWidth(badge), 48);
		ok(strip(badge).endsWith(" · [Alt+X] dismiss"), strip(badge));
		ok(strip(badge).includes("…"), strip(badge));
		ok(badge.includes(`${theme.fgSequence("muted")}…`), "the ellipsis carries the muted token after its own reset");
	});

	it("counts wide glyphs while preserving a complete ellipsis and dismiss key", () => {
		const badge = formatNotificationBadge([notice("資料庫連線失敗，請重新載入完整設定")], 44, {
			theme: createClioTheme({ color: false }),
		});

		ok(badge);
		strictEqual(visibleWidth(badge), 44);
		ok(badge.includes("資料"), badge);
		ok(badge.includes("…"), badge);
		ok(badge.endsWith(" · [Alt+X] dismiss"), badge);
	});

	it("keeps NO_COLOR output plain and meaningful", () => {
		const badge = formatNotificationBadge([notice("Reload required")], 80, {
			theme: createClioTheme({ color: false }),
		});

		strictEqual(badge, "ℹ 1 notice · Reload required · [Alt+X] dismiss");
		ok(!badge.includes(ESC));
	});

	it("wraps complete notices in the expanded panel", () => {
		const width = 36;
		const message = "Tool support is unavailable for this model; Clio drives every agent role through typed tools";
		const panel = formatNotificationPanel(
			[notice(message)],
			width,
			{ theme: createClioTheme({ color: false }) },
		);
		const collapsed = panel.slice(1, -1).join(" ").replace(/\s+/gu, " ").trim();

		ok(collapsed.includes(message), `expanded notification was cut: ${collapsed}`);
		for (const row of panel) ok(visibleWidth(row) <= width, `row overflows: ${strip(row)}`);
	});
});
