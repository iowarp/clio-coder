import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { AskUserOverlaySession } from "../../src/interactive/overlays/ask-user.js";
import type { AskUserQuestion, AskUserResult } from "../../src/tools/ask-user.js";

type AskUserCharacterizationDeps = OverlayLifecycleRuntimeDeps & {
	openAskUserOverlay?: (tui: TUI, deps: { onCancel: () => void }) => AskUserOverlaySession;
};

const questions: AskUserQuestion[] = [{ question: "Continue?", options: [{ label: "Yes" }] }];
const answered: AskUserResult = { answers: [{ question: "Continue?", answer: "Yes" }] };
const cancelled: AskUserResult = { answers: [], cancelled: true };

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => resolvePromise?.(value),
	};
}

function makeSession(events: string[], result: Deferred<AskUserResult>): AskUserOverlaySession {
	let waiting = true;
	return {
		ask: () => {
			events.push("ask");
			waiting = false;
			return result.promise.then((value) => {
				waiting = true;
				return value;
			});
		},
		cancel: () => {
			events.push("cancel");
			result.resolve(cancelled);
		},
		close: () => events.push("close"),
		hide: () => events.push("hide"),
		isWaiting: () => waiting,
	} as unknown as AskUserOverlaySession;
}

function makeLifecycle(results: Deferred<AskUserResult>[]): {
	lifecycle: ReturnType<typeof createOverlayLifecycle>;
	events: string[];
} {
	const events: string[] = [];
	let openIndex = 0;
	const app = {
		bus: { on: () => () => {}, emit: () => {} },
		registerAskUserHandler: () => {
			events.push("register");
			return () => events.push("unregister");
		},
	} as unknown as OverlayLifecycleApplicationDeps;
	const runtime = {
		app,
		tui: { requestRender: () => events.push("render") } as unknown as TUI,
		footer: { refresh: () => events.push("footer") },
		interactiveTickers: {
			stopDispatchBoardTicker: () => events.push("stop-board"),
			renderContextIsland: () => events.push("context-island"),
			renderTaskIsland: () => events.push("task-island"),
		},
		busNoticeSink: { appendReplayBlock: () => {}, requestRender: () => {} },
		chatRenderer: { applyEvent: () => {} },
		notify: () => {},
		terminal: { columns: 100 },
		dispatchBoard: {},
		chatPanel: {},
		io: { stdout: () => {}, stderr: () => {} },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({}),
		openAskUserOverlay: () => {
			events.push(`open:${openIndex}`);
			const result = results[openIndex];
			openIndex += 1;
			if (!result) throw new Error("unexpected ask-user session");
			return makeSession(events, result);
		},
	} as unknown as AskUserCharacterizationDeps;
	return { lifecycle: createOverlayLifecycle(runtime), events };
}

describe("contracts/interactive ask-user overlay lifecycle", () => {
	it("closes a non-tool interview after a successful answer", async () => {
		const result = deferred<AskUserResult>();
		const { lifecycle, events } = makeLifecycle([result]);

		const pending = lifecycle.openAskUserOverlayState(questions);
		strictEqual(lifecycle.getState(), "ask-user");
		result.resolve(answered);
		deepStrictEqual(await pending, answered);

		strictEqual(lifecycle.getState(), "closed");
		strictEqual(lifecycle.isAskUserWaiting(), false);
		deepStrictEqual(events.slice(0, 4), ["register", "open:0", "render", "ask"]);
		strictEqual(events.includes("close"), true);
	});

	it("keeps a tool-backed interview open and waiting after a successful round", async () => {
		const result = deferred<AskUserResult>();
		const { lifecycle, events } = makeLifecycle([result]);

		const pending = lifecycle.openAskUserOverlayState(questions, { turnId: "turn-1", toolCallId: "tool-1" });
		result.resolve(answered);
		deepStrictEqual(await pending, answered);

		strictEqual(lifecycle.getState(), "ask-user");
		strictEqual(lifecycle.isAskUserWaiting(), true);
		strictEqual(events.includes("close"), false);
	});

	it("latches cancellation for a turn until reset permits the next tool-backed round", async () => {
		const first = deferred<AskUserResult>();
		const second = deferred<AskUserResult>();
		const { lifecycle, events } = makeLifecycle([first, second]);

		const pending = lifecycle.openAskUserOverlayState(questions, { turnId: "turn-1" });
		lifecycle.cancelAskUser();
		deepStrictEqual(await pending, cancelled);
		deepStrictEqual(await lifecycle.openAskUserOverlayState(questions, { turnId: "turn-1" }), cancelled);
		strictEqual(events.filter((event) => event.startsWith("open:")).length, 1);

		lifecycle.resetAskUserCancellation();
		const next = lifecycle.openAskUserOverlayState(questions, { turnId: "turn-2" });
		strictEqual(events.filter((event) => event.startsWith("open:")).length, 2);
		second.resolve(answered);
		deepStrictEqual(await next, answered);
	});

	it("unregisters the handler and cancels an active interview on dispose", async () => {
		const result = deferred<AskUserResult>();
		const { lifecycle, events } = makeLifecycle([result]);

		const pending = lifecycle.openAskUserOverlayState(questions, { toolCallId: "tool-1" });
		lifecycle.dispose();
		deepStrictEqual(await pending, cancelled);

		const unregister = events.indexOf("unregister");
		const cancel = events.indexOf("cancel");
		const close = events.indexOf("close");
		strictEqual(unregister > -1, true);
		strictEqual(cancel > unregister, true);
		strictEqual(close > cancel, true);
	});
});
