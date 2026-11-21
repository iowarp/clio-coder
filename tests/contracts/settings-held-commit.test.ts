import { deepStrictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import { dockTop } from "../../src/interactive/dock.js";
import { openSettingsOverlay } from "../../src/interactive/overlays/settings.js";

/** Picks YOLO on the autonomy row and applies it for this session; returns the notices. */
function chooseYolo(commitResult: boolean | undefined): string[] {
	let settings: ClioSettings = structuredClone(DEFAULT_SETTINGS);
	const notices: string[] = [];
	const tui = {
		terminal: { rows: 30 },
		requestRender() {},
		showOverlay() {
			return { hide() {} };
		},
	} as unknown as TUI;
	const parent = openSettingsOverlay(tui, {
		getSettings: () => settings,
		writeSettings(next) {
			settings = next;
		},
		commitSetting(_id, next) {
			if (commitResult !== false) settings = next;
			return commitResult;
		},
		notice: (_level, text) => void notices.push(text),
		onClose() {},
		section: "safety",
		rowId: "safety.autonomy",
	});
	const frame = dockTop(tui)?.frame as unknown as Component;
	frame.handleInput?.("\r"); // open the autonomy choices
	frame.handleInput?.("\x1b[B"); // YOLO
	frame.handleInput?.("\r");
	frame.handleInput?.("\r"); // Apply this session
	parent.hide();
	return notices;
}

test("/settings announces an applied autonomy change", () => {
	const notices = chooseYolo(undefined);
	ok(
		notices.some((text) => text.includes("set to YOLO")),
		notices.join("\n"),
	);
});

test("/settings does not announce yolo as set while its acceptance card holds the change (#407)", () => {
	deepStrictEqual(
		chooseYolo(false).filter((text) => text.includes("set to")),
		[],
	);
});
