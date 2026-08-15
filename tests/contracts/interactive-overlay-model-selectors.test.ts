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
import type { OpenSettingsOverlayDeps, SettingsOverlayHandle } from "../../src/interactive/overlays/settings.js";

type SelectorCharacterizationDeps = OverlayLifecycleRuntimeDeps & {
	openModelOverlay?: (tui: TUI, deps: OpenModelOverlayDeps) => OverlayHandle;
	openSettingsOverlay?: (tui: TUI, deps: OpenSettingsOverlayDeps) => SettingsOverlayHandle;
};

interface SelectorFactories {
	model?: (deps: OpenModelOverlayDeps) => OverlayHandle;
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
		getFleetNodes: () => [],
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
		chatPanel: {},
		io: { stdout: () => {}, stderr: () => {} },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({}),
		openModelOverlay: (_tui: TUI, deps: OpenModelOverlayDeps) => factories.model?.(deps) ?? overlayHandle(),
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
			model: () => {
				events.push(`factory:${lifecycle.getState()}`);
				return overlayHandle();
			},
			settings: () => {
				events.push(`factory:${lifecycle.getState()}`);
				return { ...overlayHandle(), refreshRows: () => {} } as unknown as SettingsOverlayHandle;
			},
		};
		lifecycle = makeLifecycle({ events, factories, settings });
		lifecycle.openModelOverlayState();
		lifecycle.closeOverlay();
		lifecycle.openSettingsOverlayState();

		deepStrictEqual(
			events.filter((event) => event.startsWith("factory:")),
			["factory:model", "factory:settings"],
		);
	});

	it("hands the settings overlay the fleet-node snapshot and a connect flow for its target rows", () => {
		const events: string[] = [];
		let settingsDeps: OpenSettingsOverlayDeps | undefined;
		const lifecycle = makeLifecycle({
			events,
			settings: {} as ClioSettings,
			factories: {
				settings: (deps) => {
					settingsDeps = deps;
					return { ...overlayHandle(), refreshRows: () => {} } as unknown as SettingsOverlayHandle;
				},
			},
		});
		lifecycle.openSettingsOverlayState("targets");
		strictEqual(settingsDeps?.section, "targets");
		deepStrictEqual(settingsDeps?.getFleetNodes?.(), []);
		strictEqual(typeof settingsDeps?.connectTarget, "function");
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
