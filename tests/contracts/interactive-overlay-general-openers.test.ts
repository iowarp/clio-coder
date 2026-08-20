import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleController,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { OpenContextResetOverlayDeps } from "../../src/interactive/overlays/context-reset.js";
import type { OpenDecisionsOverlayOptions } from "../../src/interactive/overlays/decisions.js";
import type { OpenTasksOverlayOptions } from "../../src/interactive/tasks-overlay.js";

type GeneralOpenerSeams = {
	openCostOverlay?: typeof import("../../src/interactive/cost-overlay.js").openCostOverlay;
	openContextOverlay?: typeof import("../../src/interactive/context-overlay.js").openContextOverlay;
	openContextResetOverlay?: typeof import("../../src/interactive/overlays/context-reset.js").openContextResetOverlay;
	openTasksOverlay?: typeof import("../../src/interactive/tasks-overlay.js").openTasksOverlay;
	openDecisionsOverlay?: typeof import("../../src/interactive/overlays/decisions.js").openDecisionsOverlay;
	openMemoryOverlay?: typeof import("../../src/interactive/memory-overlay.js").openMemoryOverlay;
	openViewOverlay?: typeof import("../../src/interactive/view/view-overlay.js").openViewOverlay;
};

function makeRuntime(args: {
	events: string[];
	app?: Partial<OverlayLifecycleApplicationDeps>;
	runtime?: Partial<OverlayLifecycleRuntimeDeps & GeneralOpenerSeams>;
}): OverlayLifecycleRuntimeDeps & GeneralOpenerSeams {
	const { events } = args;
	const app = {
		providers: {},
		bus: { on: () => () => {}, emit: () => {} },
		chat: { contextLedger: () => ({}) },
		dispatch: {},
		observability: {},
		stateDir: "/tmp/clio-overlay-general-state",
		dataDir: "/tmp/clio-overlay-general-data",
		readSessionEntries: () => [],
		...args.app,
	} as unknown as OverlayLifecycleApplicationDeps;
	return {
		app,
		tui: { requestRender: () => events.push("render") } as unknown as TUI,
		footer: {
			refresh: () => events.push("footer"),
			toggleExpanded: () => events.push("footer-toggle"),
		},
		interactiveTickers: {
			stopDispatchBoardTicker: () => events.push("stop-board"),
			startDispatchBoardTicker: () => events.push("start-board"),
			renderContextIsland: () => events.push("context-island"),
			renderTaskIsland: () => events.push("task-island"),
		},
		busNoticeSink: { appendReplayBlock: () => {}, requestRender: () => {} },
		chatRenderer: { applyEvent: () => {} },
		notify: () => {},
		terminal: { columns: 70 },
		dispatchBoard: {
			resetSelection: () => events.push("reset-selection"),
			selectedRow: () => null,
		},
		chatPanel: {},
		io: { stdout: () => {}, stderr: (text: string) => events.push(`stderr:${text}`) },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({ notice: () => {} }),
		...args.runtime,
	} as unknown as OverlayLifecycleRuntimeDeps & GeneralOpenerSeams;
}

describe("contracts/interactive general overlay openers", () => {
	it("publishes each general overlay state before invoking its factory", () => {
		const events: string[] = [];
		const observed: string[] = [];
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
		let lifecycle: OverlayLifecycleController;
		const observe = (name: string): OverlayHandle => {
			observed.push(`${name}:${lifecycle.getState()}`);
			return handle;
		};
		const runtime = makeRuntime({
			events,
			app: {
				getSessionId: () => "session-1",
				getTaskBoard: () => null,
				getTaskMemoryStatus: () => ({}) as never,
			},
			runtime: {
				openCostOverlay: () => observe("cost"),
				openContextOverlay: () => observe("context"),
				openTasksOverlay: () => observe("tasks"),
				openDecisionsOverlay: () => observe("decisions"),
				openMemoryOverlay: () => observe("memory"),
				openViewOverlay: (_tui, options) => {
					strictEqual(options.initialFilter, "errors");
					return observe("view");
				},
			},
		});
		lifecycle = createOverlayLifecycle(runtime);

		for (const open of [
			() => lifecycle.openCostOverlayState(),
			() => lifecycle.openContextViewOverlayState(),
			() => lifecycle.openTasksOverlayState(),
			() => lifecycle.openDecisionsOverlayState(),
			() => lifecycle.openMemoryOverlayState(),
			() => lifecycle.openViewOverlayState("errors"),
		]) {
			open();
			lifecycle.closeOverlay();
		}

		deepStrictEqual(observed, [
			"cost:cost",
			"context:context-view",
			"tasks:tasks",
			"decisions:decisions",
			"memory:memory",
			"view:view",
		]);
		lifecycle.dispose();
	});

	it("persists a correction, closes the board, and submits exactly one ordinary operator turn", () => {
		const events: string[] = [];
		let options: OpenDecisionsOverlayOptions | undefined;
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
		const runtime = makeRuntime({
			events,
			app: {
				getDecisionBoard: () => [],
				supersedeDecision: (interviewId, key, correction) => {
					events.push(`supersede:${interviewId}:${key}:${correction ?? ""}`);
				},
			},
			runtime: {
				getSlashContext: () =>
					({
						submitChat: (text: string) => events.push(`submit:${text}`),
					}) as never,
				openDecisionsOverlay: (_tui, getInterviews, overlayOptions) => {
					deepStrictEqual(getInterviews(), []);
					options = overlayOptions;
					return handle;
				},
			},
		});
		const lifecycle = createOverlayLifecycle(runtime);
		lifecycle.openDecisionsOverlayState();

		options?.onCorrection(
			{ interviewId: "interview-1", key: "scope", label: "Scope", value: "CLI only" },
			"Include the TUI",
		);

		strictEqual(lifecycle.getState(), "closed");
		strictEqual(events.filter((event) => event.startsWith("supersede:")).length, 1);
		deepStrictEqual(
			events.filter((event) => event.startsWith("submit:")),
			[
				'submit:Decision "Scope" (previously: CLI only) is superseded by the operator. New direction: Include the TUI. Acknowledge and adjust the plan.',
			],
		);
		strictEqual(
			events.findIndex((event) => event.startsWith("supersede:")) < events.indexOf("hide"),
			true,
			"the acknowledged snapshot precedes closing and submission",
		);
		strictEqual(
			events.indexOf("hide") < events.findIndex((event) => event.startsWith("submit:")),
			true,
			"the single-overlay guard is released before the ordinary user turn",
		);
		lifecycle.dispose();
	});

	it("captures composite task snapshots, uses ordinary handoff submission, and deep-links exact artifact paths", () => {
		const events: string[] = [];
		let taskOptions: OpenTasksOverlayOptions | undefined;
		let viewFilter: string | undefined;
		let failHand = false;
		let sessionEntryReads = 0;
		const operatorTask = {
			id: "u1",
			title: "review release",
			note: "check receipts",
			status: "open" as const,
			createdAt: "2026-08-19T10:00:00.000Z",
			updatedAt: "2026-08-19T10:00:00.000Z",
		};
		const runtime = makeRuntime({
			events,
			app: {
				getSessionId: () => "session-1",
				session: {
					current: () => ({ id: "session-1", cwd: "/workspace", pinnedLeafTurnId: "assistant-kept" }),
				} as never,
				readSessionEntries: () => {
					sessionEntryReads += 1;
					return [
						{
							kind: "message",
							turnId: "user-root",
							parentTurnId: null,
							timestamp: "2026-08-19T10:00:00.000Z",
							role: "user",
							payload: { text: "root" },
						},
						{
							kind: "taskLedger",
							turnId: "ledger-1",
							parentTurnId: null,
							timestamp: "2026-08-19T10:01:00.000Z",
							boardId: "board-1",
							goals: [{ id: "board", title: "Prior", status: "completed" }],
							subgoals: [{ id: "t1", title: "done", status: "completed", origin: "agent" }],
							activeRunIds: [],
							requiredValidationEvidence: [],
						},
						{
							kind: "message",
							turnId: "artifact-1",
							parentTurnId: "user-root",
							timestamp: "2026-08-19T10:02:00.000Z",
							role: "tool_result",
							payload: {
								toolName: "write",
								isError: false,
								result: { details: { paths: ["reports/Release Notes.md"] } },
							},
						},
						{
							kind: "message",
							turnId: "assistant-kept",
							parentTurnId: "artifact-1",
							timestamp: "2026-08-19T10:03:00.000Z",
							role: "assistant",
							payload: { text: "kept" },
						},
						{
							kind: "message",
							turnId: "user-abandoned",
							parentTurnId: "assistant-kept",
							timestamp: "2026-08-19T10:04:00.000Z",
							role: "user",
							payload: { text: "abandoned continuation" },
						},
						{
							kind: "taskLedger",
							turnId: "ledger-abandoned",
							parentTurnId: null,
							timestamp: "2026-08-19T10:05:00.000Z",
							boardId: "board-abandoned",
							goals: [{ id: "board", title: "Abandoned", status: "active" }],
							subgoals: [{ id: "t1", title: "stale", status: "active", origin: "agent" }],
							activeRunIds: [],
							requiredValidationEvidence: [],
						},
						{
							kind: "message",
							turnId: "artifact-abandoned",
							parentTurnId: "user-abandoned",
							timestamp: "2026-08-19T10:06:00.000Z",
							role: "tool_result",
							payload: {
								toolName: "write",
								isError: false,
								result: { details: { paths: ["reports/Abandoned.md"] } },
							},
						},
					] as never;
				},
				userTasks: {
					snapshot: () => [operatorTask],
					add: () => operatorTask,
					hand: () => {
						if (failHand) throw new Error("sidecar unavailable");
						return { ...operatorTask, status: "handed" as const, handedSessionId: "session-1" };
					},
					done: () => ({ ...operatorTask, status: "done" as const }),
					drop: () => ({ ...operatorTask, status: "dropped" as const }),
				} as never,
			},
			runtime: {
				getSlashContext: () => ({ submitChat: (text: string) => events.push(`submit:${text}`) }) as never,
				openTasksOverlay: (_tui, _getBoard, options) => {
					taskOptions = options;
					return { hide: () => events.push("hide:tasks") } as unknown as OverlayHandle;
				},
				openViewOverlay: (_tui, options) => {
					viewFilter = options.initialFilter;
					return { hide: () => events.push("hide:view") } as unknown as OverlayHandle;
				},
			},
		});
		const lifecycle = createOverlayLifecycle(runtime);
		lifecycle.openTasksOverlayState();
		const snapshot = taskOptions?.getSessionSnapshot?.();
		strictEqual(snapshot?.history[0]?.boardId, "board-1");
		strictEqual(snapshot?.artifacts[0]?.path, "reports/Release Notes.md");
		strictEqual(
			snapshot?.history.some((board) => board.boardId === "board-abandoned"),
			false,
		);
		strictEqual(
			snapshot?.artifacts.some((artifact) => artifact.path === "reports/Abandoned.md"),
			false,
		);
		strictEqual(sessionEntryReads, 1, "one active-path snapshot feeds both composite folds");
		deepStrictEqual(taskOptions?.getUserTasks?.(), [operatorTask]);

		taskOptions?.onHandUserTask?.("u1");
		deepStrictEqual(
			events.filter((event) => event.startsWith("submit:")),
			[
				'submit:Operator task u1: review release. check receipts. Pick it up with tasks action="pick" id="u1" and work it when appropriate.',
			],
		);
		failHand = true;
		let failure = "";
		try {
			taskOptions?.onHandUserTask?.("u1");
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		strictEqual(failure, "sidecar unavailable");
		strictEqual(events.filter((event) => event.startsWith("submit:")).length, 1);

		taskOptions?.onClose?.();
		taskOptions?.onOpenArtifact?.("reports/Release Notes.md");
		strictEqual(lifecycle.getState(), "view");
		strictEqual(viewFilter, "workspace:reports/Release Notes.md");
		lifecycle.dispose();
	});

	it("keeps the decision board open and submits nothing when the revision append fails", () => {
		const events: string[] = [];
		let options: OpenDecisionsOverlayOptions | undefined;
		const runtime = makeRuntime({
			events,
			app: {
				getDecisionBoard: () => [],
				supersedeDecision: () => {
					throw new Error("ledger unavailable");
				},
			},
			runtime: {
				getSlashContext: () => ({ submitChat: (text: string) => events.push(`submit:${text}`) }) as never,
				openDecisionsOverlay: (_tui, _getInterviews, overlayOptions) => {
					options = overlayOptions;
					return { hide: () => events.push("hide") } as unknown as OverlayHandle;
				},
			},
		});
		const lifecycle = createOverlayLifecycle(runtime);
		lifecycle.openDecisionsOverlayState();

		let message = "";
		try {
			options?.onCorrection(
				{ interviewId: "interview-1", key: "scope", label: "Scope", value: "CLI only" },
				"Include the TUI",
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		strictEqual(message, "ledger unavailable");
		strictEqual(lifecycle.getState(), "decisions");
		strictEqual(events.includes("hide"), false);
		strictEqual(
			events.some((event) => event.startsWith("submit:")),
			false,
		);
		lifecycle.dispose();
	});

	it("closes context reset before invoking its asynchronous mutation and refreshes after settlement", async () => {
		const events: string[] = [];
		let resetDeps: OpenContextResetOverlayDeps | undefined;
		let resolveClear: (() => void) | undefined;
		const clearSettled = new Promise<void>((resolve) => {
			resolveClear = resolve;
		});
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
		const runtime = makeRuntime({
			events,
			app: {
				onContextClear: (options) => {
					events.push(`clear:${JSON.stringify(options)}`);
					return clearSettled;
				},
			},
			runtime: {
				openContextResetOverlay: (_tui, deps) => {
					resetDeps = deps;
					events.push("factory");
					return handle;
				},
			},
		});
		const lifecycle = createOverlayLifecycle(runtime);
		lifecycle.openContextResetOverlayState();
		events.length = 0;

		resetDeps?.onReset("preserve-clio-md");
		strictEqual(lifecycle.getState(), "closed");
		deepStrictEqual(events, ["stop-board", "hide", "context-island", "task-island", "render"]);

		await Promise.resolve();
		deepStrictEqual(events, [
			"stop-board",
			"hide",
			"context-island",
			"task-island",
			"render",
			'clear:{"confirmed":true}',
		]);
		resolveClear?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
		deepStrictEqual(events.slice(-2), ["footer", "render"]);
		lifecycle.dispose();
	});

	it("toggles the footer without taking overlay state", () => {
		const events: string[] = [];
		const lifecycle = createOverlayLifecycle(makeRuntime({ events }));

		lifecycle.toggleFooterDashboardState();

		strictEqual(lifecycle.getState(), "closed");
		deepStrictEqual(events, ["footer-toggle", "task-island", "render"]);
		lifecycle.dispose();
	});

	it("opens and toggles the dispatch board with the clamped width and ticker lifecycle", () => {
		const events: string[] = [];
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
		let lifecycle: OverlayLifecycleController;
		let frameOptions: OverlayOptions | undefined;
		const runtime = makeRuntime({
			events,
			runtime: {
				showOverlayFrame: (_tui, _component, options) => {
					events.push(`frame:${lifecycle.getState()}`);
					frameOptions = options;
					return handle;
				},
			},
		});
		lifecycle = createOverlayLifecycle(runtime);

		lifecycle.toggleDispatchBoardOverlay();
		strictEqual(lifecycle.getState(), "dispatch-board");
		strictEqual(frameOptions?.width, 66);
		deepStrictEqual(events, ["reset-selection", "frame:dispatch-board", "start-board", "render"]);

		events.length = 0;
		lifecycle.toggleDispatchBoardOverlay();
		strictEqual(lifecycle.getState(), "closed");
		deepStrictEqual(events, ["stop-board", "hide", "context-island", "task-island", "render"]);
		lifecycle.dispose();
	});
});
