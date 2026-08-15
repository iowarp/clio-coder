import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ProvidersContract, ThinkingLevel } from "../domains/providers/index.js";
import type { TUI } from "../engine/tui.js";
import type { FooterDashboardPanel } from "./footer/dashboard.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openModelOverlay } from "./overlays/model-selector.js";
import { extractScopeFromSettings, openScopedOverlay } from "./overlays/scoped-models.js";
import { openSettingsOverlay, type SettingsSectionId } from "./overlays/settings.js";
import {
	openThinkingOverlay,
	readThinkingLevel,
	resolveAvailableThinkingLevels,
	resolveThinkingCapability,
	resolveThinkingLabeler,
} from "./overlays/thinking-selector.js";
import type { TargetsHubNoticeLevel } from "./providers-overlay.js";

export interface OverlayModelSelectorsDeps {
	tui: TUI;
	transitions: Pick<OverlayTransitions, "state" | "handle">;
	providers: ProvidersContract;
	bus: SafeEventBus;
	refreshFooter: Pick<FooterDashboardPanel, "refresh">["refresh"];
	notify: (level: TargetsHubNoticeLevel, text: string, key?: string) => void;
	closeOverlay: () => void;
	getSettings?: () => Readonly<ClioSettings>;
	writeSettings?: (next: ClioSettings) => void;
	commitSetting?: (id: string, next: ClioSettings, scope: "session" | "global") => void;
	onSelectModel?: (ref: { target: string; model: string }) => void;
	onSetScope?: (scope: string[]) => void;
	onSetThinkingLevel?: (level: ThinkingLevel) => void;
	openThinkingOverlay?: typeof openThinkingOverlay;
	openModelOverlay?: typeof openModelOverlay;
	openScopedOverlay?: typeof openScopedOverlay;
	openSettingsOverlay?: typeof openSettingsOverlay;
}

export interface OverlayModelSelectors {
	openThinkingOverlayState(): void;
	openModelOverlayState(): void;
	openScopedModelsOverlayState(): void;
	openSettingsOverlayState(section?: SettingsSectionId): void;
	refreshSettingsOverlay(): void;
}

export function createOverlayModelSelectors(deps: OverlayModelSelectorsDeps): OverlayModelSelectors {
	const openThinking = deps.openThinkingOverlay ?? openThinkingOverlay;
	const openModel = deps.openModelOverlay ?? openModelOverlay;
	const openScoped = deps.openScopedOverlay ?? openScopedOverlay;
	const openSettings = deps.openSettingsOverlay ?? openSettingsOverlay;
	let settingsOverlayRefresh: (() => void) | null = null;

	const openThinkingOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "thinking";
		const settings = deps.getSettings?.();
		const current = settings
			? (resolveThinkingCapability(deps.providers, settings)?.effectiveLevel ?? readThinkingLevel(settings))
			: "off";
		const available = settings ? resolveAvailableThinkingLevels(deps.providers, settings) : (["off"] as ThinkingLevel[]);
		const thinkingOverlayDeps: Parameters<typeof openThinkingOverlay>[1] = {
			current,
			available,
			onSelect: (next) => {
				deps.onSetThinkingLevel?.(next);
				deps.refreshFooter();
			},
			onClose: deps.closeOverlay,
			...(settings ? { labelFor: resolveThinkingLabeler(deps.providers, settings) } : {}),
		};
		deps.transitions.handle = openThinking(deps.tui, thinkingOverlayDeps);
		deps.tui.requestRender();
	};

	const openModelOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		deps.transitions.state = "model";
		deps.transitions.handle = openModel(deps.tui, {
			settings,
			...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
			providers: deps.providers,
			bus: deps.bus,
			onSelect: (ref) => {
				deps.onSelectModel?.(ref);
				deps.refreshFooter();
			},
			onToggleFavorite: (ref, favorite) => {
				if (!deps.getSettings || !deps.writeSettings) return;
				const next = structuredClone(deps.getSettings()) as ClioSettings;
				const value = `${ref.target}/${ref.model}`;
				const current = new Set(next.modelSelector?.favorites ?? []);
				if (favorite) current.add(value);
				else current.delete(value);
				next.modelSelector = {
					...(next.modelSelector ?? { recentLimit: 12, favorites: [] }),
					favorites: [...current],
				};
				deps.writeSettings(next);
				deps.refreshFooter();
			},
			onClose: deps.closeOverlay,
		});
		deps.tui.requestRender();
	};

	const openScopedModelsOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		deps.transitions.state = "scoped-models";
		deps.transitions.handle = openScoped(deps.tui, {
			providers: deps.providers,
			currentScope: extractScopeFromSettings(settings),
			onCommit: (next) => {
				deps.onSetScope?.(next);
				deps.refreshFooter();
			},
			onClose: deps.closeOverlay,
		});
		deps.tui.requestRender();
	};

	const openSettingsOverlayState = (section?: SettingsSectionId): void => {
		if (deps.transitions.state !== "closed" || !deps.getSettings || !deps.writeSettings) return;
		deps.transitions.state = "settings";
		const handle = openSettings(deps.tui, {
			getSettings: deps.getSettings,
			providers: deps.providers,
			...(section ? { section } : {}),
			writeSettings: (next) => {
				deps.writeSettings?.(next);
				deps.refreshFooter();
			},
			...(deps.commitSetting
				? {
						commitSetting: (id: string, next: ClioSettings, scope: "session" | "global") => {
							deps.commitSetting?.(id, next, scope);
							deps.refreshFooter();
						},
					}
				: {}),
			notice: deps.notify,
			onClose: () => {
				settingsOverlayRefresh = null;
				deps.closeOverlay();
			},
		});
		deps.transitions.handle = handle;
		settingsOverlayRefresh = handle.refreshRows;
		void (async () => {
			try {
				await deps.providers.probeAllLive();
				if (deps.transitions.state === "settings") settingsOverlayRefresh?.();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				deps.notify("warning", `settings model refresh failed: ${msg}`, "settings:model-refresh");
			}
		})();
		deps.tui.requestRender();
	};

	return {
		openThinkingOverlayState,
		openModelOverlayState,
		openScopedModelsOverlayState,
		openSettingsOverlayState,
		refreshSettingsOverlay: () => settingsOverlayRefresh?.(),
	};
}
