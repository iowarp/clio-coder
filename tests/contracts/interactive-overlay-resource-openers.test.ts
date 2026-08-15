import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import type { ClioKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { SkillsHubDeps } from "../../src/interactive/overlays/skills-hub.js";
import type { SlashCommandContext } from "../../src/interactive/slash-commands.js";

type ListOpener = (tui: TUI, context: SlashCommandContext, onClose: () => void) => OverlayHandle;
type ResourceCharacterizationDeps = OverlayLifecycleRuntimeDeps & {
	openHelpOverlay?: (
		tui: TUI,
		manager: ClioKeybindingManager,
		onClose: () => void,
		initialFilter?: string,
	) => OverlayHandle;
	openAgentsOverlay?: ListOpener;
	openSkillsHub?: (tui: TUI, deps: SkillsHubDeps) => OverlayHandle;
	openPromptsOverlay?: ListOpener;
	openExtensionsOverlay?: ListOpener;
};

interface ResourceFactories {
	help?: ResourceCharacterizationDeps["openHelpOverlay"];
	agents?: ListOpener;
	skills?: ResourceCharacterizationDeps["openSkillsHub"];
	prompts?: ListOpener;
	extensions?: ListOpener;
}

function makeHandle(events: string[], name: string): OverlayHandle {
	return { hide: () => events.push(`hide:${name}`) } as unknown as OverlayHandle;
}

function makeLifecycle(events: string[], factories: ResourceFactories): ReturnType<typeof createOverlayLifecycle> {
	let slashContextSequence = 0;
	const app = {
		bus: { on: () => () => {}, emit: () => {} },
		resources: { skills: () => ({ items: [], diagnostics: [] }) },
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
		editor: {
			getText: () => "",
			setText: (text: string) => events.push(`editor:${text}`),
		},
		getSlashContext: () => {
			slashContextSequence += 1;
			events.push(`context:${slashContextSequence}`);
			return {
				notice: (level: string, text: string) => events.push(`notice:${level}:${text}`),
				sequence: slashContextSequence,
			} as unknown as SlashCommandContext;
		},
		openHelpOverlay: factories.help,
		openAgentsOverlay: factories.agents,
		openSkillsHub: factories.skills,
		openPromptsOverlay: factories.prompts,
		openExtensionsOverlay: factories.extensions,
	} as unknown as ResourceCharacterizationDeps;
	return createOverlayLifecycle(runtime);
}

describe("contracts/interactive resource overlay openers", () => {
	it("sets state before every factory and delegates each close callback", () => {
		const events: string[] = [];
		const closeCallbacks = new Map<string, () => void>();
		let lifecycle: ReturnType<typeof createOverlayLifecycle>;
		const capture = (name: string, onClose: () => void): OverlayHandle => {
			events.push(`factory:${name}:${lifecycle.getState()}`);
			closeCallbacks.set(name, onClose);
			return makeHandle(events, name);
		};
		lifecycle = makeLifecycle(events, {
			help: (_tui, _manager, onClose) => capture("help", onClose),
			agents: (_tui, _context, onClose) => capture("agents", onClose),
			skills: (_tui, deps) => capture("skills", deps.onClose),
			prompts: (_tui, _context, onClose) => capture("prompts", onClose),
			extensions: (_tui, _context, onClose) => capture("extensions", onClose),
		});
		const cases: Array<[string, () => void]> = [
			["help", () => lifecycle.openHelpOverlayState("permissions")],
			["agents", lifecycle.openAgentsOverlayState],
			["skills", lifecycle.openSkillsHubState],
			["prompts", lifecycle.openPromptsOverlayState],
			["extensions", lifecycle.openExtensionsOverlayState],
		];

		for (const [name, open] of cases) {
			open();
			strictEqual(lifecycle.getState(), name === "skills" ? "skills-hub" : name);
			closeCallbacks.get(name)?.();
			strictEqual(lifecycle.getState(), "closed");
		}

		deepStrictEqual(
			events.filter((event) => event.startsWith("factory:")),
			[
				"factory:help:help",
				"factory:agents:agents",
				"factory:skills:skills-hub",
				"factory:prompts:prompts",
				"factory:extensions:extensions",
			],
		);
		deepStrictEqual(
			events.filter((event) => event.startsWith("hide:")),
			["hide:help", "hide:agents", "hide:skills", "hide:prompts", "hide:extensions"],
		);
	});

	it("looks up a fresh slash context when each context-backed list opens", () => {
		const events: string[] = [];
		const seenContexts: number[] = [];
		const captureContext: ListOpener = (_tui, context, onClose) => {
			seenContexts.push((context as unknown as { sequence: number }).sequence);
			return { hide: onClose } as unknown as OverlayHandle;
		};
		const lifecycle = makeLifecycle(events, {
			agents: captureContext,
			prompts: captureContext,
			extensions: captureContext,
		});

		lifecycle.openAgentsOverlayState();
		lifecycle.closeOverlay();
		lifecycle.openPromptsOverlayState();
		lifecycle.closeOverlay();
		lifecycle.openExtensionsOverlayState();

		deepStrictEqual(seenContexts, [1, 2, 3]);
		deepStrictEqual(
			events.filter((event) => event.startsWith("context:")),
			["context:1", "context:2", "context:3"],
		);
	});

	it("maps a skills selection to editor text and an immediate render", () => {
		const events: string[] = [];
		let skillsDeps: SkillsHubDeps | undefined;
		const lifecycle = makeLifecycle(events, {
			skills: (_tui, deps) => {
				skillsDeps = deps;
				return makeHandle(events, "skills");
			},
		});

		lifecycle.openSkillsHubState();
		events.length = 0;
		skillsDeps?.setEditorText("/skill:review ");

		deepStrictEqual(events, ["editor:/skill:review ", "render"]);
	});
});
