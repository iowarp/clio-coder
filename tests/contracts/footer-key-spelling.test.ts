import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createFollowUpQueuePanel } from "../../src/interactive/follow-up-queue-panel.js";
import { footerKeyHint } from "../../src/interactive/footer/key-hints.js";
import { formatNotificationPanel } from "../../src/interactive/footer/notifications.js";
import { renderCompactDashboard } from "../../src/interactive/footer/pages.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import { footerState } from "../harness/footer-fixture.js";

test("footer, queue and action hints spell live keybindings consistently", () => {
	const previous = getKeybindings();
	const manager = createKeybindingManager({
		...DEFAULT_SETTINGS,
		interface: {
			...DEFAULT_SETTINGS.interface,
			keybindings: {
				"clio-coder.status.toggle": "ctrl+u",
				"clio-coder.leader": "alt+g",
				"clio-coder.model.select": "ctrl+m",
				"clio-coder.notifications.dismiss": "ctrl+n",
			},
		},
	});
	try {
		match(manager.actionLabel("clio-coder.notifications.dismiss"), /Ctrl\+N/u);
		// Hints spell one route; /help spells them all.
		strictEqual(manager.actionLabel("clio-coder.model.select"), "Ctrl+M");
		strictEqual(manager.fullActionLabel("clio-coder.model.select"), "Ctrl+M · Alt+G M");
		strictEqual(manager.actionLabel("clio-coder.autonomy.toggle"), "Alt+G Y");
		match(footerKeyHint(0, false, Number.POSITIVE_INFINITY, "idle") ?? "", /Ctrl\+M Model\b/u);
		const state = footerState();
		state.demo = false;
		state.session.leaderArmed = true;
		const queue = createFollowUpQueuePanel({ getNavigateKey: () => manager.actionLabel("clio-coder.queue.open") });
		queue.setMessages([{ id: "q1", enqueuedAt: 0, kind: "follow-up", text: "inspect this" }]);
		const notice = {
			id: "warning",
			level: "warning" as const,
			text: "Connection needs review",
			key: null,
			addedAt: state.now,
			expiresAt: null,
		};
		for (const width of [60, 80, 120, 200]) {
			const compact = renderCompactDashboard(state, width);
			match(compact.map(stripTerminalSequences).join("\n"), /Alt\+G → choose key/u);
			const queued = queue.render(width);
			match(queued.map(stripTerminalSequences).join("\n"), /\[Alt\+Q\] review, a restores all/u);
			state.session.leaderArmed = false;
			state.notices = [notice];
			const badge = renderCompactDashboard(state, width);
			const panel = formatNotificationPanel([notice], width, {
				dismissKeyLabel: manager.actionLabel("clio-coder.notifications.dismiss"),
			});
			match(badge.map(stripTerminalSequences).join("\n"), new RegExp(GLYPH.warn));
			match(panel.map(stripTerminalSequences).join("\n"), new RegExp(GLYPH.warn));
			match(panel.map(stripTerminalSequences).join("\n"), /Ctrl\+N dismiss/u);
			state.session.leaderArmed = true;
			state.notices = [];
			for (const line of [...compact, ...queued, ...badge, ...panel]) {
				ok(visibleWidth(line) <= width);
				for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
			}
		}
	} finally {
		setKeybindings(previous);
	}
});
