import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/index.js";
import type { Component, OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";

interface SessionHarness {
	events: string[];
	lifecycle: ReturnType<typeof createOverlayLifecycle>;
	components: Component[];
	setCurrent(meta: SessionMeta | null): void;
}

function sessionMeta(id: string, cwd: string): SessionMeta {
	return {
		id,
		cwd,
		createdAt: "2026-08-09T00:00:00.000Z",
		lastActivityAt: "2026-08-09T00:00:00.000Z",
		messageCount: 1,
	} as SessionMeta;
}

function createSessionHarness(options: {
	current: SessionMeta | null;
	resumed: SessionMeta;
	entries?: ReadonlyArray<SessionEntry>;
}): SessionHarness {
	const events: string[] = [];
	const components: Component[] = [];
	let current = options.current;
	const session = {
		current: () => current,
		history: () => [options.resumed],
		resume: (sessionId: string) => {
			events.push(`session:resume:${sessionId}`);
			current = options.resumed;
			return options.resumed;
		},
		tree: (sessionId?: string) => {
			events.push(`session:tree:${sessionId ?? "current"}`);
			return { leafId: "leaf-resumed" };
		},
		switchBranch: (sessionId: string) => {
			events.push(`session:switch-branch:${sessionId}`);
			if (options.current?.id === sessionId) current = options.current;
			return current;
		},
	} as unknown as SessionContract;
	const app = {
		session,
		providers: {},
		dispatch: {},
		bus: { on: () => () => {}, emit: () => {} },
		chat: {
			resetForSession: (turnId: string | null, messages?: ReadonlyArray<unknown>) =>
				events.push(`chat:reset:${turnId}:${messages?.length ?? 0}`),
		},
		onResumeSession: (sessionId: string) => {
			events.push(`app:resume:${sessionId}`);
			session.resume(sessionId);
		},
	} as unknown as OverlayLifecycleApplicationDeps;
	const tui = {
		requestRender: () => events.push("render"),
		showOverlay: (component: Component) => {
			components.push(component);
			const index = components.length;
			events.push(`show:${index}`);
			return { hide: () => events.push(`hide:${index}`) } as unknown as OverlayHandle;
		},
	} as unknown as TUI;
	const runtime = {
		app,
		tui,
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
		chatPanel: {
			appendUser: (text: string) => events.push(`panel:user:${text}`),
			collapseAllTools: () => events.push("panel:collapse-tools"),
		},
		resetTranscript: () => events.push("panel:reset"),
		io: { stdout: () => {}, stderr: (text: string) => events.push(`stderr:${text.trim()}`) },
		readStructuredEntries: (sessionId: string) => {
			events.push(`entries:read:${sessionId}`);
			return [...(options.entries ?? [])];
		},
		announceTaskMemorySeedOffer: () => events.push("memory-seed"),
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({ notice: () => {} }),
	} as unknown as OverlayLifecycleRuntimeDeps;

	return {
		events,
		lifecycle: createOverlayLifecycle(runtime),
		components,
		setCurrent: (meta) => {
			current = meta;
		},
	};
}

function submitSelectedOverlay(components: Component[]): void {
	const component = components.at(-1);
	if (!component?.handleInput) throw new Error("overlay component does not accept input");
	component.handleInput("\r");
}

function cancelSelectedOverlay(components: Component[]): void {
	const component = components.at(-1);
	if (!component?.handleInput) throw new Error("overlay component does not accept input");
	component.handleInput("\x1b");
}

const resumedUserEntry = {
	kind: "message",
	turnId: "turn-user",
	parentTurnId: null,
	timestamp: "2026-08-09T00:00:00.000Z",
	role: "user",
	payload: { content: [{ type: "text", text: "resumed prompt" }] },
} as SessionEntry;

describe("contracts/interactive session overlay lifecycle", () => {
	it("replays the selected session before refreshing and closing the resume overlay", () => {
		const prior = sessionMeta("prior", process.cwd());
		const resumed = sessionMeta("resumed", process.cwd());
		const harness = createSessionHarness({ current: prior, resumed, entries: [resumedUserEntry] });
		harness.lifecycle.openResumeOverlayState();
		strictEqual(harness.lifecycle.getState(), "resume");
		harness.events.length = 0;

		submitSelectedOverlay(harness.components);

		strictEqual(harness.lifecycle.getState(), "closed");
		deepStrictEqual(harness.events, [
			"app:resume:resumed",
			"session:resume:resumed",
			"entries:read:resumed",
			"panel:reset",
			"panel:user:resumed prompt",
			"panel:collapse-tools",
			"session:tree:resumed",
			"chat:reset:leaf-resumed:1",
			"memory-seed",
			"footer",
			"render",
			"stop-board",
			"hide:1",
			"context-island",
			"task-island",
			"render",
		]);
	});

	it("restores the prior session when the resumed cwd fallback is cancelled", async () => {
		const prior = sessionMeta("prior", process.cwd());
		const resumed = sessionMeta("resumed", "/definitely/missing/clio-session-cwd");
		const harness = createSessionHarness({ current: prior, resumed });
		harness.lifecycle.openResumeOverlayState();
		submitSelectedOverlay(harness.components);
		await Promise.resolve();
		strictEqual(harness.lifecycle.getState(), "cwd-fallback");
		strictEqual(harness.components.length, 2);
		harness.events.length = 0;

		cancelSelectedOverlay(harness.components);

		strictEqual(harness.lifecycle.getState(), "closed");
		deepStrictEqual(harness.events, [
			"session:switch-branch:prior",
			"footer",
			"stop-board",
			"hide:2",
			"context-island",
			"task-island",
			"render",
		]);
	});

	it("reopens the resume picker when cwd fallback is cancelled without a prior session", async () => {
		const resumed = sessionMeta("resumed", "/definitely/missing/clio-session-cwd");
		const harness = createSessionHarness({ current: null, resumed });
		harness.lifecycle.openResumeOverlayState();
		submitSelectedOverlay(harness.components);
		await Promise.resolve();
		strictEqual(harness.lifecycle.getState(), "cwd-fallback");
		harness.events.length = 0;

		cancelSelectedOverlay(harness.components);
		await Promise.resolve();

		strictEqual(harness.lifecycle.getState(), "resume");
		strictEqual(harness.components.length, 3);
		deepStrictEqual(harness.events, [
			"footer",
			"stop-board",
			"hide:2",
			"context-island",
			"task-island",
			"render",
			"show:3",
			"render",
		]);
	});
});
