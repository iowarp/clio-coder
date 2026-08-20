import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Component, Terminal } from "../../src/engine/tui.js";
import {
	createInteractiveShell,
	createProcessInteractiveShell,
	type InteractiveShellInterval,
	type InteractiveShellTui,
	settleLatestInteractiveFrame,
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
		await shell.settle();
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

	it("starts teardown synchronously and exposes one idempotent settlement", async () => {
		const log: string[] = [];
		let release = (): void => {};
		const teardown = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tui: InteractiveShellTui = {
			addChild: () => {},
			setFocus: () => {},
			start: () => {},
			stop: () => log.push("stop"),
			requestRender: () => {},
		};
		const shell = createInteractiveShell({
			createTerminal: () => ({ id: "terminal" }) as TestTerminal,
			createTui: () => tui,
			onStop: () => {
				log.push("teardown");
				return teardown;
			},
		});

		shell.stop();
		shell.stop();
		const first = shell.settle();
		strictEqual(shell.settle(), first);
		deepStrictEqual(log, ["stop", "teardown"]);
		release();
		await first;
	});

	it("registers the fullscreen layout root before focus and rendering start", () => {
		const log: string[] = [];
		const root = {} as Component;
		const editor = {} as Component;
		const tui: InteractiveShellTui = {
			mode: "fullscreen",
			addChild: () => log.push("add-root"),
			setLayoutRoot: (component) => log.push(component === root ? "layout-root" : "layout-other"),
			setFocus: () => log.push("focus-editor"),
			start: () => log.push("start"),
			stop: () => {},
			requestRender: () => {},
		};
		const shell = createInteractiveShell({
			createTerminal: () => ({ id: "terminal" }) as TestTerminal,
			createTui: () => tui,
			scheduleInterval: () => ({ id: 1 }) as TestInterval,
			clearScheduledInterval: () => {},
		});

		shell.mount(root, editor);

		deepStrictEqual(log, ["add-root", "layout-root", "focus-editor", "start"]);
	});

	it("keeps an unusable optional trace path nonfatal", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-trace-failure-"));
		const parentFile = join(dir, "not-a-directory");
		writeFileSync(parentFile, "occupied", "utf8");
		const previous = process.env.CLIO_CODER_RENDER_TRACE;
		process.env.CLIO_CODER_RENDER_TRACE = join(parentFile, "trace.jsonl");
		try {
			createProcessInteractiveShell();
		} finally {
			if (previous === undefined) delete process.env.CLIO_CODER_RENDER_TRACE;
			else process.env.CLIO_CODER_RENDER_TRACE = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("issues one final frame after a permanent no-drain bound instead of abandoning model state", async () => {
		const waits: number[] = [];
		let renders = 0;
		const frameId = await settleLatestInteractiveFrame(
			{
				whenWritable: async (timeoutMs) => {
					waits.push(timeoutMs ?? -1);
					return false;
				},
			},
			7,
			async () => {
				renders += 1;
				return 41;
			},
		);

		strictEqual(frameId, 41);
		strictEqual(renders, 1);
		deepStrictEqual(waits, [7], "a failed pre-render wait does not add a second unbounded wait");
	});
});
