import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { formatNotificationBadge, type Notification } from "../../src/interactive/footer/notifications.js";
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

	it("fits styled ANSI output by visible columns without losing the action tail", () => {
		const badge = formatNotificationBadge([notice("A deliberately long colored notification message")], 48, {
			theme: createClioTheme({ color: true, truecolor: true }),
		});

		ok(badge);
		ok(badge.includes(ESC), "the contract must exercise ANSI-styled segments");
		strictEqual(visibleWidth(badge), 48);
		ok(strip(badge).endsWith(" · [Alt+X] dismiss"), strip(badge));
		ok(strip(badge).includes("…"), strip(badge));
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
});
