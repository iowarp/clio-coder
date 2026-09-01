import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionArtifact } from "../../src/domains/session/session-artifacts.js";
import type { SessionTaskHistoryBoard, TaskBoardSnapshot } from "../../src/domains/session/task-board.js";
import type { UserTask } from "../../src/domains/user-tasks/store.js";
import { type Component, type OverlayHandle, type TUI, visibleWidth } from "../../src/engine/tui.js";
import {
	formatCompositeTasksOverlayBodyLines,
	formatTasksOverlayBodyLines,
	openTasksOverlay,
} from "../../src/interactive/tasks-overlay.js";

const ESC = "\x1b";
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function board(overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
	return {
		boardId: "board-overlay",
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

function userTask(id: string, status: UserTask["status"] = "open"): UserTask {
	return {
		id,
		title: `operator work ${id}`,
		status,
		createdAt: "2026-08-19T10:00:00.000Z",
		updatedAt: "2026-08-19T10:00:00.000Z",
	};
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

	it("wraps evidence and failure reasons in full at narrow widths", () => {
		const evidence = "Typecheck and every focused task-board contract completed without failures.";
		const reason = "Waiting for the operator to provide the deployment credential before continuing.";
		const lines = formatTasksOverlayBodyLines(
			board({
				tasks: [
					{ id: "t1", title: "verify", status: "completed", evidence },
					{ id: "t2", title: "deploy", status: "blocked", reason },
				],
			}),
			40,
		).map(stripAnsi);
		const collapsed = lines.join(" ").replace(/\s+/gu, " ");

		ok(collapsed.includes(evidence), `evidence was cut: ${collapsed}`);
		ok(collapsed.includes(reason), `blocked reason was cut: ${collapsed}`);
		for (const line of lines) ok(visibleWidth(line) <= 40, `line overflows: ${line}`);
	});

	it("renders one in-flight header line with full run ids and no per-run template lines", () => {
		const body = plainBody(
			board({
				activeRunIds: ["run-abc123456789", "run-def987654321"],
			}),
		);

		ok(body.includes("proof task-ledger:run-abc123456789"), body);
		// One in-flight header line lists the full ids; the per-run dispatch:/
		// evidence: template lines and the bottom in-flight block are retired.
		ok(body.includes("in flight run-abc123456789 · run-def987654321"), body);
		ok(!body.includes("dispatch:run-abc123456789"), body);
		ok(!body.includes("evidence:run-abc123456789"), body);
		ok(!body.includes("dispatched runs in flight"), body);
		// Full ids, never the old 10-char slice.
		ok(!body.includes("run-abc123,"), body);
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

	it("marks a clipped row with an ellipsis instead of a hard cut", () => {
		const clipped = plainBody(
			board({
				title: "Ship a feature with a title long enough to force truncation in the overlay body",
			}),
			40,
		);
		const titleRow = clipped.split("\n").find((line) => line.startsWith("Ship a feature"));
		ok(titleRow, clipped);
		ok(titleRow.includes("…"), `clipped title should carry an ellipsis, got: ${titleRow}`);
	});

	it("renders a completed evidence note verbatim without a derived run-id suffix", () => {
		const body = plainBody(
			board({
				tasks: [{ id: "t1", title: "verify it", status: "completed", evidence: "verified with run-proof-123" }],
			}),
		);

		ok(body.includes("evidence verified with run-proof-123"), body);
		// The derived evidence:<runId> suffix is gone; the id it echoed survives
		// only inside the evidence prose the agent wrote.
		ok(!body.includes("evidence:run-proof-123"), body);
	});

	it("renders all four sections with generation identity, exact origins, artifacts, and operator status", () => {
		const current = board({
			tasks: [
				{ id: "t1", title: "agent work", status: "active", origin: "agent" },
				{ id: "t2", title: "operator pickup", status: "pending", origin: "user", userTaskId: "u7" },
			],
		});
		const history: SessionTaskHistoryBoard[] = [
			{
				boardId: current.boardId,
				title: current.title,
				tasks: current.tasks,
				lastSnapshotAt: "2026-08-19T10:03:00.000Z",
			},
			{
				boardId: "board-prior",
				title: "Prior plan",
				tasks: [
					{ id: "t1", title: "prior proof", status: "completed", evidence: "contracts passed", origin: "agent" },
					{ id: "t2", title: "unfinished old row", status: "active", origin: "agent" },
				],
				lastSnapshotAt: "2026-08-19T10:02:00.000Z",
			},
		];
		const artifacts: SessionArtifact[] = [
			{
				path: ".clio-coder/artifacts/release.md",
				tool: "artifact",
				artifactKind: "report",
				turnId: "turn-artifact",
				timestamp: "2026-08-19T10:04:00.000Z",
				overwrites: 0,
			},
		];
		const text = stripAnsi(
			formatCompositeTasksOverlayBodyLines({
				board: current,
				history,
				artifacts,
				userTasks: [userTask("u7", "picked")],
				selectedIndex: 1,
				workspace: process.cwd(),
			}).join("\n"),
		);
		for (const heading of ["Tasks", "Task history", "Artifacts", "Operator tasks"]) ok(text.includes(heading), text);
		ok(text.includes("operator pickup · operator u7"), text);
		ok(text.includes("board-prior:t1 prior proof · agent · Prior plan"), text);
		ok(text.includes("evidence contracts passed"), text);
		ok(!text.includes("unfinished old row"), text);
		ok(text.includes(".clio-coder/artifacts/release.md · artifact:report"), text);
		ok(text.includes("u7   operator work u7 · picked"), text);
	});

	it("keeps every composite section within narrow widths", () => {
		const lines = formatCompositeTasksOverlayBodyLines(
			{
				board: board({ title: "A current board title long enough to be clipped at narrow widths" }),
				history: [],
				artifacts: [
					{
						path: "a/very/long/path/to/an/operator/report-that-must-be-clipped.md",
						tool: "artifact",
						turnId: "turn-1",
						timestamp: "2026-08-19T10:04:00.000Z",
						overwrites: 0,
					},
				],
				userTasks: [userTask("u1")],
			},
			34,
		);
		for (const line of lines) ok(visibleWidth(line) <= 34, `line overflowed: ${stripAnsi(line)}`);
	});

	it("captures expensive snapshots once, refreshes explicitly, and performs no I/O on repaint", () => {
		const harness = fakeTui();
		let boardReads = 0;
		let sessionReads = 0;
		let userReads = 0;
		openTasksOverlay(
			harness.tui,
			() => {
				boardReads += 1;
				return board();
			},
			{
				getSessionSnapshot: () => {
					sessionReads += 1;
					return { history: [], artifacts: [] };
				},
				getUserTasks: () => {
					userReads += 1;
					return [];
				},
			},
		);
		strictEqual(sessionReads, 1);
		strictEqual(userReads, 1);
		for (let index = 0; index < 25; index += 1) harness.component().render(80);
		strictEqual(boardReads, 25, "only the cached live-board getter participates in repaint");
		strictEqual(sessionReads, 1);
		strictEqual(userReads, 1);
		harness.component().handleInput?.("r");
		strictEqual(sessionReads, 2);
		strictEqual(userReads, 2);
	});

	it("applies add, hand, done, and drop only after successful store callbacks", () => {
		const harness = fakeTui();
		let tasks = [userTask("u1"), userTask("u2"), userTask("u3")];
		const events: string[] = [];
		const mutate = (id: string, status: UserTask["status"]): void => {
			events.push(`${status}:${id}`);
			tasks = tasks.map((task) => (task.id === id ? { ...task, status } : task));
		};
		openTasksOverlay(harness.tui, () => null, {
			getUserTasks: () => tasks,
			onAddUserTask: (title) => {
				events.push(`add:${title}`);
				tasks = [...tasks, { ...userTask("u4"), title }];
			},
			onHandUserTask: (id) => mutate(id, "handed"),
			onDoneUserTask: (id) => mutate(id, "done"),
			onDropUserTask: (id) => mutate(id, "dropped"),
		});
		const component = harness.component();
		component.handleInput?.("h");
		component.handleInput?.("\x1b[B");
		component.handleInput?.("d");
		component.handleInput?.("\x1b[B");
		component.handleInput?.("x");
		component.handleInput?.("a");
		for (const char of "new operator work") component.handleInput?.(char);
		component.handleInput?.("\r");
		deepStrictEqual(events, ["handed:u1", "done:u2", "dropped:u3", "add:new operator work"]);
		const rendered = stripAnsi(component.render(80).join("\n"));
		ok(rendered.includes("u1   operator work u1 · handed"), rendered);
		ok(rendered.includes("u2   operator work u2 · done"), rendered);
		ok(rendered.includes("u3   operator work u3 · dropped"), rendered);
		ok(rendered.includes("u4   new operator work · open"), rendered);
	});

	it("retains the old snapshot and reports a failed mutation", () => {
		const harness = fakeTui();
		openTasksOverlay(harness.tui, () => null, {
			getUserTasks: () => [userTask("u1")],
			onHandUserTask: () => {
				throw new Error("sidecar unavailable");
			},
		});
		harness.component().handleInput?.("h");
		const rendered = stripAnsi(harness.component().render(80).join("\n"));
		ok(rendered.includes("operator work u1 · open"), rendered);
		ok(rendered.includes("sidecar unavailable"), rendered);
	});

	it("closes before opening an artifact by its exact recorded path", () => {
		const harness = fakeTui();
		const events: string[] = [];
		const path = "reports/Release Notes.md";
		openTasksOverlay(harness.tui, () => null, {
			getSessionSnapshot: () => ({
				history: [],
				artifacts: [
					{
						path,
						tool: "write",
						turnId: "turn-1",
						timestamp: "2026-08-19T10:04:00.000Z",
						overwrites: 0,
					},
				],
			}),
			onClose: () => events.push("close"),
			onOpenArtifact: (selectedPath) => events.push(`view:${selectedPath}`),
		});
		harness.component().handleInput?.("\r");
		deepStrictEqual(events, ["close", `view:${path}`]);
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
