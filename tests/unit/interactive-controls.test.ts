import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { CTRL_C_DOUBLE_TAP_MS, type CtrlCAction, resolveCtrlCAction } from "../../src/interactive/index.js";

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
