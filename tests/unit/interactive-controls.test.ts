import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ClioKeybinding } from "../../src/domains/config/keybindings.js";
import {
	CTRL_C_DOUBLE_TAP_MS,
	type CtrlCAction,
	type OverlayKeyDeps,
	resolveCtrlCAction,
	routeOverlayKey,
} from "../../src/interactive/index.js";
import { applySettingChange, buildSettingItems } from "../../src/interactive/overlays/settings.js";

function classify(overrides: Partial<Parameters<typeof resolveCtrlCAction>[0]> = {}): CtrlCAction {
	return resolveCtrlCAction({
		overlayState: "closed",
		streaming: false,
		editorText: "",
		lastCtrlCAt: 0,
		now: 10_000,
		...overrides,
	});
}

describe("interactive ctrl+c controls", () => {
	it("cancels the active stream before any other action", () => {
		strictEqual(
			classify({
				streaming: true,
				overlayState: "providers",
				editorText: "draft",
			}),
			"cancel-stream",
		);
	});

	it("closes overlays when idle", () => {
		strictEqual(classify({ overlayState: "providers" }), "close-overlay");
	});

	it("clears editor text before arming shutdown", () => {
		strictEqual(classify({ editorText: "draft prompt" }), "clear-editor");
	});

	it("arms shutdown on the first ctrl+c when idle and empty", () => {
		strictEqual(classify(), "arm-shutdown");
	});

	it("shuts down on a second ctrl+c inside the grace window", () => {
		strictEqual(
			classify({
				lastCtrlCAt: 10_000 - CTRL_C_DOUBLE_TAP_MS + 1,
			}),
			"shutdown",
		);
	});

	it("stops treating ctrl+c as a double-tap once the grace window expires", () => {
		strictEqual(
			classify({
				lastCtrlCAt: 10_000 - CTRL_C_DOUBLE_TAP_MS - 1,
			}),
			"arm-shutdown",
		);
	});
});

describe("routeOverlayKey dispatch-board toggle", () => {
	const DISPATCH_TOGGLE = "\x02"; // ctrl+b

	function buildDeps(): { deps: OverlayKeyDeps; closed: { count: number }; shutdown: { count: number } } {
		const closed = { count: 0 };
		const shutdown = { count: 0 };
		const deps: OverlayKeyDeps = {
			cancelSuper: () => {},
			confirmSuper: () => {},
			now: () => 0,
			closeOverlay: () => {
				closed.count += 1;
			},
			requestShutdown: () => {
				shutdown.count += 1;
			},
		};
		return { deps, closed, shutdown };
	}

	function matchesFactory(id: ClioKeybinding, data: string): (d: string, i: ClioKeybinding) => boolean {
		return (d, i) => i === id && d === data;
	}

	it("closes the dispatch board when the toggle key is pressed while the overlay is open", () => {
		const { deps, closed, shutdown } = buildDeps();
		const matches = matchesFactory("clio.dispatchBoard.toggle", DISPATCH_TOGGLE);
		const consumed = routeOverlayKey(DISPATCH_TOGGLE, "dispatch-board", deps, matches);
		strictEqual(consumed, true);
		strictEqual(closed.count, 1);
		strictEqual(shutdown.count, 0);
	});

	it("still routes Esc through the existing dispatch-board branch (closeOverlay called once)", () => {
		const { deps, closed } = buildDeps();
		const matches = matchesFactory("clio.dispatchBoard.toggle", DISPATCH_TOGGLE);
		const consumed = routeOverlayKey("\x1b", "dispatch-board", deps, matches);
		strictEqual(consumed, true);
		strictEqual(closed.count, 1);
	});

	it("exit keybinding still wins over dispatch-board toggle", () => {
		const { deps, shutdown } = buildDeps();
		// Simulate a matcher where data matches both exit and toggle; exit is
		// checked first in routeOverlayKey, so shutdown wins.
		const matches = (_data: string, id: ClioKeybinding) => id === "clio.exit";
		const consumed = routeOverlayKey(DISPATCH_TOGGLE, "dispatch-board", deps, matches);
		strictEqual(consumed, true);
		strictEqual(shutdown.count, 1);
	});
});

describe("settings overlay compaction controls", () => {
	it("surfaces and applies live compaction controls", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		const items = buildSettingItems(settings);
		const auto = items.find((item) => item.id === "compaction.auto");
		const threshold = items.find((item) => item.id === "compaction.threshold");

		ok(auto, "compaction.auto row should be visible");
		ok(threshold, "compaction.threshold row should be visible");
		strictEqual(auto.currentValue, "true");
		strictEqual(threshold.currentValue, "0.8");

		applySettingChange(settings, "compaction.auto", "false");
		applySettingChange(settings, "compaction.threshold", "0.9");
		strictEqual(settings.compaction.auto, false);
		strictEqual(settings.compaction.threshold, 0.9);
	});
});

describe("settings overlay retry controls", () => {
	it("surfaces and applies retry controls", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		const items = buildSettingItems(settings);
		const enabled = items.find((item) => item.id === "retry.enabled");
		const maxRetries = items.find((item) => item.id === "retry.maxRetries");
		const baseDelayMs = items.find((item) => item.id === "retry.baseDelayMs");
		const maxDelayMs = items.find((item) => item.id === "retry.maxDelayMs");

		ok(enabled, "retry.enabled row should be visible");
		ok(maxRetries, "retry.maxRetries row should be visible");
		ok(baseDelayMs, "retry.baseDelayMs row should be visible");
		ok(maxDelayMs, "retry.maxDelayMs row should be visible");
		strictEqual(enabled.currentValue, "true");
		strictEqual(maxRetries.currentValue, "3");
		strictEqual(baseDelayMs.currentValue, "2000");
		strictEqual(maxDelayMs.currentValue, "60000");

		applySettingChange(settings, "retry.enabled", "false");
		applySettingChange(settings, "retry.maxRetries", "5");
		applySettingChange(settings, "retry.baseDelayMs", "1000");
		applySettingChange(settings, "retry.maxDelayMs", "30000");
		strictEqual(settings.retry.enabled, false);
		strictEqual(settings.retry.maxRetries, 5);
		strictEqual(settings.retry.baseDelayMs, 1000);
		strictEqual(settings.retry.maxDelayMs, 30000);
	});
});
