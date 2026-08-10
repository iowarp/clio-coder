import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioKeybinding } from "../../src/domains/config/keybindings.js";
import {
	type ApplicationControllerDeps,
	type ApplicationIntervalHandle,
	createApplicationController,
} from "../../src/interactive/application-controller.js";
import type { LeaderKeyController } from "../../src/interactive/leader-key.js";
import type { OverlayState } from "../../src/interactive/overlay-lifecycle.js";

interface Harness {
	deps: ApplicationControllerDeps;
	events: string[];
	setNow(value: number): void;
	setOverlay(value: OverlayState): void;
	setStreaming(value: boolean): void;
	setEditorText(value: string): void;
	setLeaderPending(value: boolean): void;
	setLeaderConsumes(value: boolean): void;
	setOverlayConsumes(value: boolean): void;
	setBashCancels(value: boolean): void;
	setMatchedAction(value: ClioKeybinding | null): void;
	emitSigint(): void;
}

function createHarness(overrides: Partial<ApplicationControllerDeps> = {}): Harness {
	const events: string[] = [];
	let now = 1_000;
	let overlay: OverlayState = "closed";
	let streaming = false;
	let editorText = "";
	let leaderPending = false;
	let leaderConsumes = false;
	let overlayConsumes = false;
	let bashCancels = false;
	let matchedAction: ClioKeybinding | null = null;
	let sigintListener: (() => void) | undefined;
	const keepAlive = { unref: () => {} };
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
			on: (_signal, listener) => {
				events.push("signal:on");
				sigintListener = listener;
			},
			off: () => events.push("signal:off"),
		},
		intervals: {
			setInterval: (_callback, delay) => {
				events.push(`interval:set:${delay}`);
				return keepAlive;
			},
			clearInterval: (handle) => events.push(handle === keepAlive ? "interval:clear:keepalive" : "interval:clear:owned"),
		},
		intervalsToClear: [],
		leaderKeys,
		getOverlayState: () => overlay,
		routeOverlayKey: () => {
			events.push("overlay:route");
			return overlayConsumes;
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
		...overrides,
	};
	return {
		deps,
		events,
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
		setBashCancels: (value) => {
			bashCancels = value;
		},
		setMatchedAction: (value) => {
			matchedAction = value;
		},
		emitSigint: () => sigintListener?.(),
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
		deepStrictEqual(harness.events, []);
		harness.setNow(22_500);
		controller.handleCtrlC();
		await controller.run;
		deepStrictEqual(harness.events, [
			"signal:off",
			"interval:clear:keepalive",
			"ui:stop",
			"parked:Clio Coder shutting down",
			"app:shutdown",
		]);
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
