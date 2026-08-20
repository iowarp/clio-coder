import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioKeybinding } from "../../src/domains/config/keybindings.js";
import {
	APPLICATION_DOUBLE_TAP_MS,
	type ApplicationControllerDeps,
	type ApplicationIntervalHandle,
	createApplicationController,
} from "../../src/interactive/application-controller.js";
import type { LeaderKeyController } from "../../src/interactive/leader-key.js";
import type { OverlayState } from "../../src/interactive/overlay-lifecycle.js";

interface Harness {
	deps: ApplicationControllerDeps;
	events: string[];
	diagnostics: string[];
	setNow(value: number): void;
	setOverlay(value: OverlayState): void;
	setStreaming(value: boolean): void;
	setEditorText(value: string): void;
	setLeaderPending(value: boolean): void;
	setLeaderConsumes(value: boolean): void;
	setOverlayConsumes(value: boolean): void;
	setEditorHistoryMatches(value: boolean): void;
	setBashCancels(value: boolean): void;
	setMatchedAction(value: ClioKeybinding | null): void;
	emitSigint(): void;
	/** Run the double-tap window's expiry callback, as the event loop would. */
	fireArmedTimer(): boolean;
}

function createHarness(overrides: Partial<ApplicationControllerDeps> = {}): Harness {
	const events: string[] = [];
	const diagnostics: string[] = [];
	let now = 1_000;
	let overlay: OverlayState = "closed";
	let streaming = false;
	let editorText = "";
	let leaderPending = false;
	let leaderConsumes = false;
	let overlayConsumes = false;
	let editorHistoryMatches = false;
	let bashCancels = false;
	let matchedAction: ClioKeybinding | null = null;
	let sigintListener: (() => void) | undefined;
	const keepAlive = { unref: () => {} };
	// The controller schedules the armed hint's expiry through the same
	// coordinator, so the harness keeps the two handles apart and holds the
	// expiry callback rather than running it on a real clock.
	const armedTimer = { unref: () => {} };
	let armedTimerCallback: (() => void) | null = null;
	const leaderKeys: LeaderKeyController = {
		isPending: () => leaderPending,
		route: () => {
			events.push("leader:route");
			return leaderConsumes;
		},
		reset: () => {
			events.push("leader:reset");
			leaderPending = false;
		},
		dispose: () => events.push("leader:dispose"),
	};
	const deps: ApplicationControllerDeps = {
		clock: { now: () => now },
		signals: {
			takeInterruptOwnership: () => {
				events.push("signal:take");
				return () => events.push("signal:restore");
			},
			on: (_signal, listener) => {
				events.push("signal:on");
				sigintListener = listener;
			},
			off: () => events.push("signal:off"),
		},
		intervals: {
			setInterval: (callback, delay) => {
				events.push(`interval:set:${delay}`);
				if (delay !== APPLICATION_DOUBLE_TAP_MS) return keepAlive;
				armedTimerCallback = callback;
				return armedTimer;
			},
			clearInterval: (handle) => {
				if (handle === armedTimer) armedTimerCallback = null;
				events.push(
					handle === keepAlive
						? "interval:clear:keepalive"
						: handle === armedTimer
							? "interval:clear:armed"
							: "interval:clear:owned",
				);
			},
		},
		intervalsToClear: [],
		leaderKeys,
		getOverlayState: () => overlay,
		routeOverlayKey: () => {
			events.push("overlay:route");
			return overlayConsumes;
		},
		matchesEditorHistory: () => {
			if (!editorHistoryMatches) return false;
			events.push("editor:history-match");
			return true;
		},
		matchesAction: (_data, id) => id === matchedAction,
		dispatchAction: (id) => {
			events.push(`action:${id}`);
			return true;
		},
		cancelActiveEditorBash: () => {
			events.push("bash:cancel");
			return bashCancels;
		},
		isStreaming: () => streaming,
		cancelActiveRun: () => events.push("run:cancel"),
		getEditorText: () => editorText,
		clearEditor: () => {
			events.push("editor:clear");
			editorText = "";
		},
		requestRender: () => events.push("render"),
		onShutdownArmedChange: (armed) => events.push(`armed:${armed}`),
		closeOverlay: () => {
			events.push("overlay:close");
			overlay = "closed";
		},
		listNotifications: () => [{ id: "first" }, { id: "second" }],
		dismissNotification: (id) => events.push(`notification:dismiss:${id}`),
		dismissAllNotifications: () => events.push("notification:dismiss-all"),
		toggleLastToolExpanded: () => {
			events.push("tool:last");
			return true;
		},
		toggleAllToolsExpanded: () => {
			events.push("tool:all");
			return true;
		},
		toggleLastThinking: () => {
			events.push("thinking:last");
			return true;
		},
		toggleAllThinking: () => {
			events.push("thinking:all");
			return true;
		},
		shutdownDisposers: [],
		stopUi: () => events.push("ui:stop"),
		cancelParkedCalls: (reason) => events.push(`parked:${reason}`),
		onShutdown: async () => {
			events.push("app:shutdown");
		},
		reportShutdownFailure: (step, error) => {
			diagnostics.push(`${step}: ${error instanceof Error ? error.message : String(error)}`);
		},
		...overrides,
	};
	return {
		deps,
		events,
		diagnostics,
		setNow: (value) => {
			now = value;
		},
		setOverlay: (value) => {
			overlay = value;
		},
		setStreaming: (value) => {
			streaming = value;
		},
		setEditorText: (value) => {
			editorText = value;
		},
		setLeaderPending: (value) => {
			leaderPending = value;
		},
		setLeaderConsumes: (value) => {
			leaderConsumes = value;
		},
		setOverlayConsumes: (value) => {
			overlayConsumes = value;
		},
		setEditorHistoryMatches: (value) => {
			editorHistoryMatches = value;
		},
		setBashCancels: (value) => {
			bashCancels = value;
		},
		setMatchedAction: (value) => {
			matchedAction = value;
		},
		emitSigint: () => sigintListener?.(),
		fireArmedTimer: () => {
			if (!armedTimerCallback) return false;
			armedTimerCallback();
			return true;
		},
	};
}

describe("contracts/interactive application controller", () => {
	it("installs SIGINT and keeps a pending main-editor leader chord ahead of Ctrl+C", () => {
		const harness = createHarness();
		harness.setLeaderPending(true);
		harness.setLeaderConsumes(true);
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		deepStrictEqual(controller.handleInput("\x03"), { consume: true });
		deepStrictEqual(harness.events, ["leader:route"]);
	});

	it("resets a modal's pending leader chord, then gives Ctrl+C modal precedence", () => {
		const harness = createHarness();
		harness.setOverlay("agents");
		harness.setLeaderPending(true);
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		deepStrictEqual(controller.handleInput("\x03"), { consume: true });
		deepStrictEqual(harness.events, ["leader:reset", "overlay:close"]);
	});

	it("keeps overlay ownership ahead of Esc cancellation and closed actions", () => {
		const harness = createHarness();
		harness.setOverlay("agents");
		harness.setStreaming(true);
		harness.setMatchedAction("clio.tool.expand");
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		strictEqual(controller.handleInput("\x1b"), undefined);
		deepStrictEqual(harness.events, ["overlay:route"]);
	});

	it("orders overlay routing, leader routing, bash cancellation, stream cancellation, and actions", () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;
		harness.setOverlayConsumes(true);
		deepStrictEqual(controller.handleInput("x"), { consume: true });
		deepStrictEqual(harness.events, ["overlay:route"]);

		harness.events.length = 0;
		harness.setOverlayConsumes(false);
		harness.setBashCancels(true);
		deepStrictEqual(controller.handleInput("\x1b"), { consume: true });
		deepStrictEqual(harness.events, ["overlay:route", "leader:route", "bash:cancel"]);

		harness.events.length = 0;
		harness.setBashCancels(false);
		harness.setStreaming(true);
		deepStrictEqual(controller.handleInput("\x1b"), { consume: true });
		deepStrictEqual(harness.events, ["overlay:route", "leader:route", "bash:cancel", "run:cancel"]);

		harness.events.length = 0;
		harness.setStreaming(false);
		harness.setMatchedAction("clio.tool.expand");
		deepStrictEqual(controller.handleInput("o"), { consume: true });
		deepStrictEqual(harness.events, ["overlay:route", "leader:route", "action:clio.tool.expand"]);
	});

	it("lets explicit editor history beat a conflicting app action after overlay routing", () => {
		const harness = createHarness();
		harness.setEditorHistoryMatches(true);
		harness.setMatchedAction("clio.model.cycleForward");
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		strictEqual(controller.handleInput("history"), undefined);
		deepStrictEqual(harness.events, ["overlay:route", "leader:route", "editor:history-match"]);

		harness.events.length = 0;
		harness.setOverlay("agents");
		strictEqual(controller.handleInput("history"), undefined);
		deepStrictEqual(harness.events, ["overlay:route"], "an open overlay remains ahead of editor history");
	});

	it("keeps the three key-action double-tap clocks independent and inclusive", () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		harness.setNow(10_000);
		controller.dismissNotifications();
		controller.toggleToolExpansion();
		harness.setNow(10_500);
		controller.dismissNotifications();
		controller.toggleThinkingExpansion();
		harness.setNow(10_501);
		controller.toggleToolExpansion();

		deepStrictEqual(harness.events, [
			"notification:dismiss:first",
			"tool:last",
			"render",
			"notification:dismiss-all",
			"thinking:last",
			"render",
			"tool:last",
			"render",
		]);
	});

	it("preserves Ctrl+C cancellation, editor clearing, arming, and double-tap shutdown", async () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		harness.setStreaming(true);
		harness.setNow(20_000);
		controller.handleCtrlC();
		deepStrictEqual(harness.events, ["run:cancel"]);

		harness.events.length = 0;
		harness.setStreaming(false);
		harness.setEditorText("draft");
		harness.setNow(21_000);
		controller.handleCtrlC();
		deepStrictEqual(harness.events, ["editor:clear", "render"]);

		harness.events.length = 0;
		harness.setNow(22_000);
		controller.handleCtrlC();
		deepStrictEqual(harness.events, [`interval:set:${APPLICATION_DOUBLE_TAP_MS}`, "armed:true", "render"]);

		harness.events.length = 0;
		harness.setNow(22_500);
		controller.handleCtrlC();
		await controller.run;
		deepStrictEqual(harness.events, [
			"signal:off",
			"signal:restore",
			"interval:clear:keepalive",
			"interval:clear:armed",
			"ui:stop",
			"parked:Clio Coder shutting down",
			"app:shutdown",
		]);
	});

	it("does not count the press that clears a draft toward the shutdown double tap", async () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		harness.setEditorText("preserved draft");
		harness.setNow(25_000);
		controller.handleCtrlC();
		deepStrictEqual(harness.events, ["editor:clear", "render"]);

		harness.events.length = 0;
		harness.setNow(25_100);
		controller.handleCtrlC();
		deepStrictEqual(
			harness.events,
			[`interval:set:${APPLICATION_DOUBLE_TAP_MS}`, "armed:true", "render"],
			"the first empty-editor press arms visibly instead of spending a hidden draft-clearing clock",
		);

		harness.events.length = 0;
		harness.setNow(25_200);
		controller.handleCtrlC();
		strictEqual(await controller.run, 0);
		strictEqual(harness.events.at(-1), "app:shutdown");
	});

	// Issue #108. Every other Ctrl+C outcome changed something on screen; arming
	// changed nothing, so a first press was indistinguishable from a key the
	// application never received, and the 500ms window that quits could not be
	// discovered by trying.
	it("shows the armed double tap and still quits on a second press inside the window", async () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		harness.setNow(40_000);
		controller.handleCtrlC();
		deepStrictEqual(
			harness.events,
			[`interval:set:${APPLICATION_DOUBLE_TAP_MS}`, "armed:true", "render"],
			"the arming press raises the hint and asks for the frame that shows it",
		);

		harness.events.length = 0;
		harness.setNow(40_499);
		controller.handleCtrlC();
		strictEqual(await controller.run, 0);
		strictEqual(harness.events.at(-1), "app:shutdown", "the second press inside the window still quits");
		strictEqual(
			harness.events.includes("interval:clear:armed"),
			true,
			"and the hint's expiry timer is released rather than left scheduled",
		);
	});

	it("drops the armed hint when the window lapses instead of promising a quit that will not happen", () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		harness.setNow(50_000);
		controller.handleCtrlC();
		harness.events.length = 0;

		strictEqual(harness.fireArmedTimer(), true, "arming scheduled its own expiry");
		deepStrictEqual(harness.events, ["interval:clear:armed", "armed:false", "render"]);

		// Nothing repaints an idle prompt on its own, so the lapse has to clear the
		// hint itself: a press this late re-arms rather than quitting, and a hint
		// still standing would have said otherwise.
		harness.events.length = 0;
		harness.setNow(51_000);
		controller.handleCtrlC();
		deepStrictEqual(harness.events, [`interval:set:${APPLICATION_DOUBLE_TAP_MS}`, "armed:true", "render"]);
		strictEqual(harness.events.includes("app:shutdown"), false, "a press outside the window re-arms, it does not quit");
	});

	it("restarts the expiry when a press re-arms before the previous timer has fired", () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		harness.setNow(70_000);
		controller.handleCtrlC();
		harness.events.length = 0;

		// By the clock this press is outside the window, so it re-arms rather than
		// quits; the first timer is still pending (a late event loop). It must be
		// replaced, not left to clear the hint in the middle of the new window.
		harness.setNow(70_501);
		controller.handleCtrlC();
		deepStrictEqual(harness.events, ["interval:clear:armed", `interval:set:${APPLICATION_DOUBLE_TAP_MS}`, "render"]);

		// Only the second timer exists now; the hint stays up until it fires.
		harness.events.length = 0;
		strictEqual(harness.fireArmedTimer(), true, "the re-arm scheduled its own expiry");
		deepStrictEqual(harness.events, ["interval:clear:armed", "armed:false", "render"]);
		strictEqual(harness.fireArmedTimer(), false, "nothing is left scheduled after the window lapses");
	});

	it("drops the armed hint with the press it spends on an overlay", () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		harness.setNow(60_000);
		controller.handleCtrlC();
		harness.events.length = 0;

		// An overlay opened between the two presses takes the second one, and that
		// press disarms the clock. The hint has to go with it.
		harness.setOverlay("agents");
		harness.setNow(60_100);
		controller.handleCtrlC();
		deepStrictEqual(harness.events, ["interval:clear:armed", "armed:false", "render", "overlay:close"]);
	});

	it("does not quit when a second Ctrl+C lands inside the window during a stream", async () => {
		// Found by cancelling a live turn. The first press cancels the stream and
		// used to arm the shutdown clock anyway, so pressing again because the
		// first looked like it did nothing killed the application mid-turn, with
		// the last frame still reading `writing`.
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		harness.setStreaming(true);
		harness.setNow(30_000);
		controller.handleCtrlC();
		harness.setNow(30_100);
		controller.handleCtrlC();
		deepStrictEqual(harness.events, ["run:cancel", "run:cancel"], "both presses cancel and neither shuts down");

		// Quitting still works. Once the run is cancelled, the documented double
		// tap does what it has always done.
		harness.events.length = 0;
		harness.setStreaming(false);
		harness.setNow(30_200);
		controller.handleCtrlC();
		deepStrictEqual(
			harness.events,
			[`interval:set:${APPLICATION_DOUBLE_TAP_MS}`, "armed:true", "render"],
			"the first press after the cancel only arms, and says so",
		);
		harness.setNow(30_400);
		controller.handleCtrlC();
		await controller.run;
		strictEqual(harness.events.at(-1), "app:shutdown");
	});

	it("runs shutdown once in exact interval, disposer, UI, parked-call, and application order", async () => {
		const firstInterval: ApplicationIntervalHandle = {};
		const secondInterval: ApplicationIntervalHandle = {};
		const harness = createHarness({
			intervalsToClear: [firstInterval, secondInterval],
			shutdownDisposers: [() => harness.events.push("dispose:first"), () => harness.events.push("dispose:second")],
		});
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		await Promise.all([controller.shutdown(), controller.shutdown()]);
		strictEqual(await controller.run, 0);
		deepStrictEqual(harness.events, [
			"signal:off",
			"signal:restore",
			"interval:clear:keepalive",
			"interval:clear:owned",
			"interval:clear:owned",
			"dispose:first",
			"dispose:second",
			"ui:stop",
			"parked:Clio Coder shutting down",
			"app:shutdown",
		]);
	});

	it("routes the installed SIGINT listener through the same coordinator", async () => {
		const harness = createHarness();
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;
		harness.setNow(30_000);
		harness.emitSigint();
		harness.setNow(30_001);
		harness.emitSigint();

		strictEqual(await controller.run, 0);
		strictEqual(harness.events.at(-1), "app:shutdown");
	});

	it("settles the run when the application's own shutdown rejects", async () => {
		// handleCtrlC calls shutdown fire-and-forget, so a rejecting step must
		// neither hang the run promise nor escape as an unhandled rejection.
		const harness = createHarness({
			onShutdown: async () => {
				throw new Error("shutdown boom");
			},
		});
		const controller = createApplicationController(harness.deps);

		await controller.shutdown();
		const settled = await Promise.race([
			controller.run,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250).unref()),
		]);
		strictEqual(settled, 1);
		deepStrictEqual(harness.diagnostics, ["application shutdown: shutdown boom"]);
	});

	it("reports every teardown step that failed rather than claiming a clean exit", async () => {
		// Swallowing has to mean "finish cleanup and report", not "finish cleanup
		// and call it a success". The notice channel is unavailable here because
		// interactive teardown may already have disposed it.
		const harness = createHarness({
			shutdownDisposers: [
				() => {
					throw new Error("disposer boom");
				},
				() => harness.events.push("dispose:second"),
			],
			stopUi: () => {
				throw new Error("ui boom");
			},
		});
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		await controller.shutdown();
		strictEqual(await controller.run, 1);
		deepStrictEqual(harness.diagnostics, ["shutdown disposer: disposer boom", "terminal stop: ui boom"]);
		// Every later step still ran, and the failures were reported after the
		// terminal was released so the report cannot land on a live TUI.
		deepStrictEqual(harness.events, [
			"signal:off",
			"signal:restore",
			"interval:clear:keepalive",
			"dispose:second",
			"parked:Clio Coder shutting down",
			"app:shutdown",
		]);
	});

	it("finishes the ordered release when a shutdown disposer throws", async () => {
		const harness = createHarness({
			shutdownDisposers: [
				() => {
					throw new Error("disposer boom");
				},
			],
		});
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		await controller.shutdown();
		const settled = await Promise.race([
			controller.run,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250).unref()),
		]);
		strictEqual(settled, 1);
		deepStrictEqual(harness.events.slice(-3), ["ui:stop", "parked:Clio Coder shutting down", "app:shutdown"]);
	});

	it("takes SIGINT from the shutdown that boot already armed", async () => {
		// Boot installs the core termination handler before an interactive surface
		// exists, and Node runs signal listeners in registration order. A
		// controller that only appends its own handler always loses the first
		// press to the shutdown that was armed first, so the contract where the
		// first press cancels and the second exits can never run.
		const listeners: Array<() => void> = [];
		const journal: string[] = [];
		const coreTermination = (): void => {
			journal.push("core:shutdown");
		};
		listeners.push(coreTermination);
		const deliver = (): void => {
			for (const listener of [...listeners]) listener();
		};
		const harness = createHarness({
			signals: {
				takeInterruptOwnership: () => {
					const index = listeners.indexOf(coreTermination);
					if (index >= 0) listeners.splice(index, 1);
					return () => void listeners.push(coreTermination);
				},
				on: (_signal, listener) => void listeners.push(listener),
				off: (_signal, listener) => {
					const index = listeners.indexOf(listener);
					if (index >= 0) listeners.splice(index, 1);
				},
			},
		});
		const controller = createApplicationController(harness.deps);
		harness.events.length = 0;

		deliver();
		deepStrictEqual(journal, []);
		deepStrictEqual(harness.events, [`interval:set:${APPLICATION_DOUBLE_TAP_MS}`, "armed:true", "render"]);

		harness.events.length = 0;
		deliver();
		strictEqual(await controller.run, 0);
		deepStrictEqual(journal, []);
		strictEqual(harness.events.at(-1), "app:shutdown");

		// Ownership goes back when the controller is done with it, so an interrupt
		// during a slow teardown still reaches a handler that exits the process.
		deepStrictEqual(listeners, [coreTermination]);
		deliver();
		deepStrictEqual(journal, ["core:shutdown"]);
	});

	// SIGTERM never reaches this controller. It goes to the termination
	// coordinator, which runs its hooks and calls process.exit with the TUI
	// still owning the screen. Measured on a pty: `kill -TERM` ended with `?25l`
	// last on the wire, so the cursor stayed hidden, where `/quit` on the same
	// build ended with `?25h`.
	it("registers a terminal teardown for shutdown paths that never reach it", async () => {
		const teardowns: Array<() => void> = [];
		const harness = createHarness({ registerTerminalTeardown: (teardown) => teardowns.push(teardown) });
		createApplicationController(harness.deps);

		strictEqual(teardowns.length, 1, "exactly one teardown is registered");
		strictEqual(harness.events.includes("ui:stop"), false, "registering does not stop the terminal");

		teardowns[0]?.();
		strictEqual(harness.events.filter((event) => event === "ui:stop").length, 1);
	});

	it("survives a terminal teardown that throws and reports it once", async () => {
		const teardowns: Array<() => void> = [];
		const harness = createHarness({
			registerTerminalTeardown: (teardown) => teardowns.push(teardown),
			stopUi: () => {
				throw new Error("terminal already closed");
			},
		});
		createApplicationController(harness.deps);

		teardowns[0]?.();
		deepStrictEqual(harness.diagnostics, ["terminal stop: terminal already closed"]);
		teardowns[0]?.();
		strictEqual(harness.diagnostics.length, 2, "a second teardown reports its own failure, not the first again");
	});

	it("leaves a SIGINT listener it did not install in place", async () => {
		// The production coordinator binds to process.removeAllListeners, so a
		// controller that clears the signal wholesale silently disarms an
		// embedder's own interrupt handling.
		const listeners = new Set<() => void>();
		let foreignRan = 0;
		listeners.add(() => {
			foreignRan += 1;
		});
		const harness = createHarness({
			signals: {
				takeInterruptOwnership: () => () => {},
				on: (_signal, listener) => void listeners.add(listener),
				off: (_signal, listener) => void listeners.delete(listener),
			},
		});
		const controller = createApplicationController(harness.deps);

		for (const listener of [...listeners]) listener();
		strictEqual(foreignRan, 1);

		await controller.shutdown();
		strictEqual(await controller.run, 0);
	});
});
