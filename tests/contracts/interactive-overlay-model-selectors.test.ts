import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { OpenModelOverlayDeps } from "../../src/interactive/overlays/model-selector.js";
import type { OpenScopedOverlayDeps } from "../../src/interactive/overlays/scoped-models.js";
import type { OpenSettingsOverlayDeps, SettingsOverlayHandle } from "../../src/interactive/overlays/settings.js";
import type { OpenThinkingOverlayDeps } from "../../src/interactive/overlays/thinking-selector.js";

type SelectorCharacterizationDeps = OverlayLifecycleRuntimeDeps & {
	openThinkingOverlay?: (tui: TUI, deps: OpenThinkingOverlayDeps) => OverlayHandle;
	openModelOverlay?: (tui: TUI, deps: OpenModelOverlayDeps) => OverlayHandle;
	openScopedOverlay?: (tui: TUI, deps: OpenScopedOverlayDeps) => OverlayHandle;
	openSettingsOverlay?: (tui: TUI, deps: OpenSettingsOverlayDeps) => SettingsOverlayHandle;
};

interface SelectorFactories {
	thinking?: (deps: OpenThinkingOverlayDeps) => OverlayHandle;
	model?: (deps: OpenModelOverlayDeps) => OverlayHandle;
	scoped?: (deps: OpenScopedOverlayDeps) => OverlayHandle;
	settings?: (deps: OpenSettingsOverlayDeps) => SettingsOverlayHandle;
}

function overlayHandle(): OverlayHandle {
	return { hide: () => {} } as unknown as OverlayHandle;
}

function makeLifecycle(options: {
	events: string[];
	factories: SelectorFactories;
	settings?: ClioSettings;
	probeAllLive?: () => Promise<void>;
}): ReturnType<typeof createOverlayLifecycle> {
	const { events, factories, settings } = options;
	const providers = {
		probeAllLive: options.probeAllLive ?? (() => Promise.resolve()),
	} as unknown as ProvidersContract;
	const app = {
		providers,
		bus: { on: () => () => {}, emit: () => {} },
		...(settings ? { getSettings: () => settings } : {}),
		writeSettings: (next: ClioSettings) => events.push(`write:${JSON.stringify(next.modelSelector?.favorites ?? [])}`),
		onSelectModel: (ref: { target: string; model: string }) => events.push(`select:${ref.target}/${ref.model}`),
		onSetScope: () => events.push("scope:set"),
		onSetThinkingLevel: (level: string) => events.push(`thinking:${level}`),
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
		notify: (level: string, text: string) => events.push(`notify:${level}:${text}`),
		terminal: { columns: 100 },
		dispatchBoard: {},
		getObservabilitySnapshot: () => ({}),
		chatPanel: {},
		io: { stdout: () => {}, stderr: () => {} },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({}),
		openThinkingOverlay: (_tui: TUI, deps: OpenThinkingOverlayDeps) => factories.thinking?.(deps) ?? overlayHandle(),
		openModelOverlay: (_tui: TUI, deps: OpenModelOverlayDeps) => factories.model?.(deps) ?? overlayHandle(),
		openScopedOverlay: (_tui: TUI, deps: OpenScopedOverlayDeps) => factories.scoped?.(deps) ?? overlayHandle(),
		openSettingsOverlay: (_tui: TUI, deps: OpenSettingsOverlayDeps) =>
			factories.settings?.(deps) ?? ({ ...overlayHandle(), refreshRows: () => {} } as unknown as SettingsOverlayHandle),
	} as unknown as SelectorCharacterizationDeps;
	return createOverlayLifecycle(runtime);
}

describe("contracts/interactive model selector overlays", () => {
	it("sets each selector state before constructing its overlay", () => {
		const events: string[] = [];
		const settings = { modelSelector: { recentLimit: 12, favorites: [] } } as unknown as ClioSettings;
		let lifecycle: ReturnType<typeof createOverlayLifecycle>;
		const factories: SelectorFactories = {
			thinking: () => {
				events.push(`factory:${lifecycle.getState()}`);
				return overlayHandle();
			},
			model: () => {
				events.push(`factory:${lifecycle.getState()}`);
				return overlayHandle();
			},
			scoped: () => {
				events.push(`factory:${lifecycle.getState()}`);
				return overlayHandle();
			},
			settings: () => {
				events.push(`factory:${lifecycle.getState()}`);
				return { ...overlayHandle(), refreshRows: () => {} } as unknown as SettingsOverlayHandle;
			},
		};
		lifecycle = makeLifecycle({ events, factories });
		lifecycle.openThinkingOverlayState();
		lifecycle.closeOverlay();
		lifecycle = makeLifecycle({ events, factories, settings });
		lifecycle.openModelOverlayState();
		lifecycle.closeOverlay();
		lifecycle.openScopedModelsOverlayState();
		lifecycle.closeOverlay();
		lifecycle.openSettingsOverlayState();

		deepStrictEqual(
			events.filter((event) => event.startsWith("factory:")),
			["factory:thinking", "factory:model", "factory:scoped-models", "factory:settings"],
		);
	});

	it("delegates model selection and favorite persistence before refreshing the footer", () => {
		const events: string[] = [];
		const settings = { modelSelector: { recentLimit: 12, favorites: [] } } as unknown as ClioSettings;
		let modelDeps: OpenModelOverlayDeps | undefined;
		const lifecycle = makeLifecycle({
			events,
			settings,
			factories: {
				model: (deps) => {
					modelDeps = deps;
					return overlayHandle();
				},
			},
		});

		lifecycle.openModelOverlayState();
		modelDeps?.onSelect({ target: "local", model: "alpha" });
		modelDeps?.onToggleFavorite?.({ target: "local", model: "alpha" }, true);

		deepStrictEqual(
			events.filter((event) => event === "footer" || event.startsWith("select:") || event.startsWith("write:")),
			["select:local/alpha", "footer", 'write:["local/alpha"]', "footer"],
		);
	});

	it("delegates thinking and scoped selections before refreshing the footer", () => {
		const events: string[] = [];
		let thinkingDeps: OpenThinkingOverlayDeps | undefined;
		let scopedDeps: OpenScopedOverlayDeps | undefined;
		let lifecycle = makeLifecycle({
			events,
			factories: {
				thinking: (deps) => {
					thinkingDeps = deps;
					return overlayHandle();
				},
				scoped: (deps) => {
					scopedDeps = deps;
					return overlayHandle();
				},
			},
		});

		lifecycle.openThinkingOverlayState();
		thinkingDeps?.onSelect("high");
		lifecycle.closeOverlay();
		lifecycle = makeLifecycle({
			events,
			factories: {
				scoped: (deps) => {
					scopedDeps = deps;
					return overlayHandle();
				},
			},
			settings: {} as ClioSettings,
		});
		lifecycle.openScopedModelsOverlayState();
		scopedDeps?.onCommit([]);

		deepStrictEqual(
			events.filter((event) => event === "footer" || event.startsWith("thinking:") || event === "scope:set"),
			["thinking:high", "footer", "scope:set", "footer"],
		);
	});

	it("refreshes settings after probing only while the settings overlay is live", async () => {
		const events: string[] = [];
		let resolveProbe: (() => void) | undefined;
		const probe = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		let settingsDeps: OpenSettingsOverlayDeps | undefined;
		const lifecycle = makeLifecycle({
			events,
			settings: {} as ClioSettings,
			probeAllLive: () => probe,
			factories: {
				settings: (deps) => {
					settingsDeps = deps;
					return {
						...overlayHandle(),
						refreshRows: () => events.push("settings:refresh"),
					} as unknown as SettingsOverlayHandle;
				},
			},
		});

		lifecycle.openSettingsOverlayState();
		settingsDeps?.onClose();
		resolveProbe?.();
		await probe;
		await Promise.resolve();

		strictEqual(events.includes("settings:refresh"), false);
	});
});
