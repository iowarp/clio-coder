import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, Terminal } from "../../src/engine/tui.js";
import {
	createInteractiveShell,
	type InteractiveShellInterval,
	type InteractiveShellTui,
} from "../../src/interactive/interactive-shell.js";

interface TestTerminal extends Terminal {
	id: string;
}

interface TestInterval extends InteractiveShellInterval {
	id: number;
}

describe("interactive shell ownership", () => {
	it("constructs, mounts, and anchors in the established initialization order", async () => {
		const log: string[] = [];
		const terminal = { id: "terminal" } as TestTerminal;
		const root = {} as Component;
		const editor = {} as Component;
		const interval: TestInterval = { id: 1 };
		const tui: InteractiveShellTui = {
			addChild: (component) => log.push(component === root ? "add-root" : "add-other"),
			setFocus: (component) => log.push(component === editor ? "focus-editor" : "focus-other"),
			start: () => log.push("start"),
			stop: () => log.push("stop"),
			requestRender: () => log.push("render"),
		};
		const shell = createInteractiveShell({
			createTerminal: () => {
				log.push("terminal");
				return terminal;
			},
			createTui: (createdTerminal) => {
				strictEqual(createdTerminal, terminal);
				log.push("tui");
				return tui;
			},
			scheduleInterval: (_callback, intervalMs) => {
				log.push(`anchor:${intervalMs}`);
				return interval;
			},
			clearScheduledInterval: (handle) => log.push(`clear:${(handle as TestInterval).id}`),
		});

		shell.mount(root, editor);
		const run = shell.anchor();
		shell.releaseAnchor();
		shell.stop();
		shell.complete(7);

		strictEqual(await run, 7);
		deepStrictEqual(log, [
			"terminal",
			"tui",
			"add-root",
			"focus-editor",
			"start",
			`anchor:${1 << 30}`,
			"clear:1",
			"stop",
		]);
	});

	it("makes mount, anchor, release, and completion idempotent", async () => {
		let starts = 0;
		let schedules = 0;
		let clears = 0;
		const interval: TestInterval = { id: 1 };
		const tui: InteractiveShellTui = {
			addChild: () => {},
			setFocus: () => {},
			start: () => {
				starts += 1;
			},
			stop: () => {},
			requestRender: () => {},
		};
		const shell = createInteractiveShell({
			createTerminal: () => ({ id: "terminal" }) as TestTerminal,
			createTui: () => tui,
			scheduleInterval: () => {
				schedules += 1;
				return interval;
			},
			clearScheduledInterval: () => {
				clears += 1;
			},
		});
		const component = {} as Component;

		shell.mount(component, component);
		shell.mount(component, component);
		const firstRun = shell.anchor();
		strictEqual(shell.anchor(), firstRun);
		shell.releaseAnchor();
		shell.releaseAnchor();
		shell.complete(3);
		shell.complete(9);

		strictEqual(await firstRun, 3);
		strictEqual(starts, 1);
		strictEqual(schedules, 1);
		strictEqual(clears, 1);
	});
});
