import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { OpenModelScopeOverlayDeps } from "../../src/interactive/overlays/model-scope.js";
import type { OpenModelOverlayDeps } from "../../src/interactive/overlays/model-selector.js";
import type { OpenSettingsOverlayDeps, SettingsOverlayHandle } from "../../src/interactive/overlays/settings.js";

type SelectorCharacterizationDeps = OverlayLifecycleRuntimeDeps & {
	openModelOverlay?: (tui: TUI, deps: OpenModelOverlayDeps) => OverlayHandle;
	openModelScopeOverlay?: (tui: TUI, deps: OpenModelScopeOverlayDeps) => OverlayHandle;
	openSettingsOverlay?: (tui: TUI, deps: OpenSettingsOverlayDeps) => SettingsOverlayHandle;
};

interface SelectorFactories {
	model?: (deps: OpenModelOverlayDeps) => OverlayHandle;
	scope?: (deps: OpenModelScopeOverlayDeps) => OverlayHandle;
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
		writeSettings: (next: ClioSettings) => events.push(`write:${JSON.stringify(next.chat.modelPicker?.favorites ?? [])}`),
		onSelectModel: (ref: { target: string; model: string }, scope: string) =>
			events.push(`select:${ref.target}/${ref.model}:${scope}`),
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
		openModelScopeOverlay: (_tui: TUI, deps: OpenModelScopeOverlayDeps) => factories.scope?.(deps) ?? overlayHandle(),
		openSettingsOverlay: (_tui: TUI, deps: OpenSettingsOverlayDeps) =>
			factories.settings?.(deps) ?? ({ ...overlayHandle(), refreshRows: () => {} } as unknown as SettingsOverlayHandle),
	} as unknown as SelectorCharacterizationDeps;
	return createOverlayLifecycle(runtime);
}

describe("contracts/interactive model selector overlays", () => {
	it("sets each selector state before constructing its overlay", () => {
		const events: string[] = [];
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
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
		lifecycle.openSettingsOverlayState("targets", "targets.target-a");
		strictEqual(settingsDeps?.section, "targets");
		strictEqual(settingsDeps?.rowId, "targets.target-a");
		deepStrictEqual(settingsDeps?.getFleetNodes?.(), []);
		strictEqual(typeof settingsDeps?.connectTarget, "function");
	});

	// G3 from smoke pass 2: a pick used to reach settings.yaml with no prompt.
	// The picker resolves what to run and the scope dialog resolves where it
	// lands, so nothing is applied between the two.
	it("routes a picked model through the scope dialog and applies at the chosen scope", () => {
		const events: string[] = [];
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		let modelDeps: OpenModelOverlayDeps | undefined;
		let scopeDeps: OpenModelScopeOverlayDeps | undefined;
		const lifecycle = makeLifecycle({
			events,
			settings,
			factories: {
				model: (deps) => {
					modelDeps = deps;
					return overlayHandle();
				},
				scope: (deps) => {
					scopeDeps = deps;
					return overlayHandle();
				},
			},
		});

		lifecycle.openModelOverlayState();
		modelDeps?.onSelect({ target: "local", model: "alpha" });
		deepStrictEqual(scopeDeps?.ref, { target: "local", model: "alpha" }, "the swap reaches the dialog intact");
		deepStrictEqual(
			events.filter((event) => event.startsWith("select:")),
			[],
			"nothing is applied while the operator is still choosing",
		);

		scopeDeps?.onChoose("session");
		modelDeps?.onToggleFavorite?.({ target: "local", model: "alpha" }, true);

		deepStrictEqual(
			events.filter((event) => event === "footer" || event.startsWith("select:") || event.startsWith("write:")),
			["select:local/alpha:session", "footer", 'write:["local/alpha"]', "footer"],
		);
	});

	it("applies globally when the operator says so, and applies nothing when they cancel", () => {
		const events: string[] = [];
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		let modelDeps: OpenModelOverlayDeps | undefined;
		let scopeDeps: OpenModelScopeOverlayDeps | undefined;
		const lifecycle = makeLifecycle({
			events,
			settings,
			factories: {
				model: (deps) => {
					modelDeps = deps;
					return overlayHandle();
				},
				scope: (deps) => {
					scopeDeps = deps;
					return overlayHandle();
				},
			},
		});

		lifecycle.openModelOverlayState();
		modelDeps?.onSelect({ target: "local", model: "alpha" });
		scopeDeps?.onChoose("global");
		deepStrictEqual(
			events.filter((event) => event.startsWith("select:")),
			["select:local/alpha:global"],
		);

		lifecycle.openModelOverlayState();
		modelDeps?.onSelect({ target: "local", model: "beta" });
		scopeDeps?.onCancel();
		deepStrictEqual(
			events.filter((event) => event.startsWith("select:")),
			["select:local/alpha:global"],
			"cancelling leaves the model where it was",
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
