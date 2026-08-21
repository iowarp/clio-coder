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
	/** The leaf resume lands on, which resolveLeafOnOpen reads off the /tree pin. */
	leafId?: string;
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
			return { leafId: options.leafId ?? "leaf-resumed" };
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
			cancel: () => events.push("chat:cancel"),
			isStreaming: () => false,
			resetForSession: (turnId: string | null, messages?: ReadonlyArray<unknown>) =>
				events.push(`chat:reset:${turnId}:${messages?.length ?? 0}`),
			whenSettled: async () => {},
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
			clearFoldOverrides: () => events.push("panel:clear-fold-overrides"),
			applyEvent: (event: { type: string; message?: { content?: unknown } }) => {
				if (event.type !== "message_end") return;
				const content = event.message?.content;
				const text = Array.isArray(content)
					? content.map((block) => (block as { text?: string }).text ?? "").join("")
					: String(content ?? "");
				events.push(`panel:assistant:${text}`);
			},
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

function messageEntry(
	turnId: string,
	parentTurnId: string | null,
	role: "user" | "assistant",
	text: string,
): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: "2026-08-09T00:00:00.000Z",
		role,
		payload: { text },
	} as SessionEntry;
}

/** u1 -> a1 -> u2 -> a2, the shape issue #107 was captured on. */
const pinnedBranchEntries: ReadonlyArray<SessionEntry> = [
	messageEntry("turn-u1", null, "user", "u1"),
	messageEntry("turn-a1", "turn-u1", "assistant", "a1"),
	messageEntry("turn-u2", "turn-a1", "user", "u2"),
	messageEntry("turn-a2", "turn-u2", "assistant", "a2"),
];

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
			// The leaf is read before the transcript is rebuilt, because it is what
			// the rebuild follows (issue #107).
			"session:tree:resumed",
			"panel:reset",
			"panel:user:resumed prompt",
			"panel:clear-fold-overrides",
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

	// Issue #107. current.jsonl is append-only, so a session resumed on a /tree
	// pin still carries the abandoned turns after it. Replaying the file
	// unfiltered rendered them as ordinary history above the prompt while the
	// engine extended from the pin, and /tree marked the pin with its active-tip
	// glyph at the same time. Resume now follows the same active path the /tree
	// switch does, rooted at the leaf resume actually landed on.
	it("replays only the pinned branch, leaving the abandoned turns off the transcript", () => {
		const prior = sessionMeta("prior", process.cwd());
		const resumed = sessionMeta("resumed", process.cwd());
		const harness = createSessionHarness({
			current: prior,
			resumed,
			entries: pinnedBranchEntries,
			leafId: "turn-a1",
		});
		harness.lifecycle.openResumeOverlayState();
		harness.events.length = 0;

		submitSelectedOverlay(harness.components);

		const panelEvents = harness.events.filter(
			(event) => event.startsWith("panel:user:") || event.startsWith("panel:assistant:"),
		);
		deepStrictEqual(panelEvents, ["panel:user:u1", "panel:assistant:a1"], "u2 and a2 are past the pin");
		// Two replay messages, the same two the panel drew: the provider context and
		// the transcript cannot disagree about which branch this is.
		strictEqual(
			harness.events.includes("chat:reset:turn-a1:2"),
			true,
			`chat reset should carry the pinned leaf and its two messages, got: ${harness.events.join(", ")}`,
		);
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
