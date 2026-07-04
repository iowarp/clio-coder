import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskBoardSnapshot } from "../../src/domains/session/task-board.js";
import { type Component, type OverlayHandle, type TUI, visibleWidth } from "../../src/engine/tui.js";
import { formatTasksOverlayBodyLines, openTasksOverlay } from "../../src/interactive/tasks-overlay.js";

const ESC = "\x1b";
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function board(overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
	return {
		title: "Ship the feature",
		tasks: [
			{ id: "t1", title: "design it", status: "pending" },
			{ id: "t2", title: "build it", status: "active" },
		],
		activeRunIds: [],
		...overrides,
	};
}

function plainBody(snapshot: TaskBoardSnapshot | null, width = 84): string {
	return stripAnsi(formatTasksOverlayBodyLines(snapshot, width).join("\n"));
}

function overlayHandle(onHide: () => void = () => {}): OverlayHandle {
	let hidden = false;
	let focused = true;
	return {
		hide(): void {
			hidden = true;
			onHide();
		},
		setHidden(nextHidden: boolean): void {
			hidden = nextHidden;
		},
		isHidden(): boolean {
			return hidden;
		},
		focus(): void {
			focused = true;
		},
		unfocus(): void {
			focused = false;
		},
		isFocused(): boolean {
			return focused;
		},
	};
}

function fakeTui(): {
	tui: TUI;
	component: () => Component;
	hideCalls: () => number;
} {
	let mounted: Component | null = null;
	let hides = 0;
	const tui = {
		terminal: { columns: 80 },
		showOverlay(component: Component): OverlayHandle {
			mounted = component;
			return overlayHandle(() => {
				hides += 1;
			});
		},
		requestRender(): void {},
	} as unknown as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("overlay was not mounted");
			return mounted;
		},
		hideCalls: () => hides,
	};
}

describe("contracts/tasks-overlay", () => {
	it("keeps the empty board state readable", () => {
		deepStrictEqual(formatTasksOverlayBodyLines(null).map(stripAnsi), [
			"No task board declared in this session.",
			"",
			'The agent declares one with the tasks tool (action="plan") before multi-step work.',
		]);
	});

	it("renders task rows, receipts, and a task-ledger proof reference without active runs", () => {
		const body = plainBody(
			board({
				tasks: [
					{ id: "t1", title: "design it", status: "completed", evidence: "npm test green" },
					{ id: "t2", title: "build it", status: "blocked", reason: "waiting on credentials" },
					{ id: "t3", title: "document it", status: "cancelled", reason: "superseded" },
				],
			}),
		);

		ok(body.includes("Ship the feature"), body);
		ok(body.includes("1/3 done"), body);
		ok(body.includes("proof task-ledger:t1"), body);
		ok(body.includes("t1   design it"), body);
		ok(body.includes("evidence npm test green"), body);
		ok(body.includes("blocked waiting on credentials"), body);
		ok(body.includes("dropped superseded"), body);
	});

	it("renders dispatch and evidence proof references for each active run id", () => {
		const body = plainBody(
			board({
				activeRunIds: ["run-abc123456789", "run-def987654321"],
			}),
		);

		ok(body.includes("proof task-ledger:run-abc123456789"), body);
		ok(body.includes("run run-abc123456789 dispatch:run-abc123456789 evidence:run-abc123456789"), body);
		ok(body.includes("run run-def987654321 dispatch:run-def987654321 evidence:run-def987654321"), body);
		ok(body.includes("dispatched runs in flight run-abc123, run-def987"), body);
	});

	it("keeps long titles and run ids within the requested width", () => {
		const lines = formatTasksOverlayBodyLines(
			board({
				title: "Ship a feature with a title long enough to force truncation in the overlay body",
				activeRunIds: [`run-${"x".repeat(120)}`],
				tasks: [{ id: "t1", title: "write a task row with a long title that should not overflow", status: "active" }],
			}),
			34,
		);

		for (const line of lines) ok(visibleWidth(line) <= 34, `line overflowed: ${stripAnsi(line)}`);
	});

	it("adds a conservative evidence reference when a completed note contains a run id", () => {
		const body = plainBody(
			board({
				tasks: [{ id: "t1", title: "verify it", status: "completed", evidence: "verified with run-proof-123" }],
			}),
		);

		ok(body.includes("evidence verified with run-proof-123 evidence:run-proof-123"), body);
	});

	it("preserves Escape close behavior", () => {
		let closed = 0;
		const harness = fakeTui();
		const handle = openTasksOverlay(harness.tui, () => board(), {
			onClose: () => {
				closed += 1;
			},
		});

		harness.component().handleInput?.(ESC);
		strictEqual(closed, 1);
		strictEqual(harness.hideCalls(), 0);
		handle.hide();
		strictEqual(harness.hideCalls(), 1);
	});
});
