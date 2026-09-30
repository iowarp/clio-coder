import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Component, OverlayOptions } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { createInteractiveTickers } from "../../src/interactive/interactive-tickers.js";
import { footerState } from "../harness/footer-fixture.js";

test("context progress allocates no transcript overlay; task island survives resize and short terminals", () => {
	const terminal = { columns: 80, rows: 24 };
	const slots: { component: Component; options: OverlayOptions; hidden: boolean }[] = [];
	const row = footerState().dispatchRows[0];
	ok(row);
	const tui = {
		terminal,
		requestRender() {},
		showOverlay(component: Component, options: OverlayOptions = {}) {
			const slot = { component, options, hidden: false };
			slots.push(slot);
			return {
				setHidden(hidden: boolean) {
					slot.hidden = hidden;
				},
				hide() {
					slot.hidden = true;
				},
			} as never;
		},
	};
	let modal = "closed";
	let expanded = false;
	const controller = createInteractiveTickers({
		tui,
		dispatchBoardStore: { activeRows: () => [], reconcile() {} },
		getTaskBoard: () => ({
			boardId: "b1",
			title: "Board",
			activeRunIds: [],
			tasks: [{ id: "t1", title: "Task", status: "active" }],
		}),
		contextActivityStore: {
			active: () => true,
			current: () => ({
				kind: "context-init",
				phase: "scan",
				status: "running",
				message: "Scanning",
				startedAtMs: 0,
				updatedAtMs: 0,
				completedAtMs: null,
				current: null,
				total: null,
				detail: null,
			}),
		},
		getOverlayState: () => modal,
		isFooterExpanded: () => expanded,
		scheduleInterval: () => ({}),
		clearScheduledInterval() {},
	});
	const visible = (index: number) => {
		const slot = slots[index];
		ok(slot);
		return !slot.hidden && (slot.options.visible?.(terminal.columns, terminal.rows) ?? true);
	};
	try {
		for (const width of [60, 80, 100, 120, 200, 80, 92]) {
			terminal.columns = width;
			for (const height of [18, 24]) {
				terminal.rows = height;
				controller.renderTaskIsland();
				controller.renderContextIsland();
				strictEqual(visible(0), width >= 80, `${width}x${height} task`);
				strictEqual(slots.length, 1, "only the task island owns an overlay");
				for (const slot of slots)
					for (const line of slot.component.render(slot.options.width as number)) {
						ok(visibleWidth(line) <= width);
						const plain = line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
						ok(
							[...plain].every((char) => char.charCodeAt(0) >= 32 && (char.charCodeAt(0) < 127 || char.charCodeAt(0) > 159)),
						);
					}
			}
		}
		for (const mode of ["modal", "expanded"]) {
			modal = mode === "modal" ? "settings" : "closed";
			expanded = mode === "expanded";
			controller.renderTaskIsland();
			controller.renderContextIsland();
			strictEqual(visible(0), false);
			strictEqual(slots.length, 1);
		}
	} finally {
		controller.dispose();
	}
});
