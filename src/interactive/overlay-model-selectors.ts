import type { ClioSettings } from "../core/config.js";
import type { ThinkingLevel } from "../core/defaults.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { InteropProposal } from "../domains/interop/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import type { FleetNodeSnapshot } from "../domains/scheduling/cluster.js";
import type { TUI } from "../engine/tui.js";
import type { FooterDashboardPanel } from "./footer/dashboard.js";
import type { InteractiveNoticeLevel } from "./interactive-subscriptions.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import {
	formatPendingModelScope,
	type ModelScopeChoice,
	openModelScopeOverlay,
	type PendingModelScope,
} from "./overlays/model-scope.js";
import { openModelOverlay } from "./overlays/model-selector.js";
import { openSettingsOverlay, type SettingsCenterRowId, type SettingsSectionId } from "./overlays/settings.js";

export interface OverlayModelSelectorsDeps {
	tui: TUI;
	transitions: Pick<OverlayTransitions, "state" | "handle">;
	providers: ProvidersContract;
	bus: SafeEventBus;
	refreshFooter: Pick<FooterDashboardPanel, "refresh">["refresh"];
	notify: (level: InteractiveNoticeLevel, text: string, key?: string) => void;
	closeOverlay: () => void;
	getSettings?: () => Readonly<ClioSettings>;
	writeSettings?: (next: ClioSettings) => void;
	commitSetting?: (id: string, next: ClioSettings, scope: "session" | "global") => void;
	onSelectModel?: (ref: { target: string; model: string }, scope: ModelScopeChoice) => void;
	/** Applied with the chosen scope when the swap named a thinking level. */
	onSetThinkingLevel?: (level: ThinkingLevel, scope?: ModelScopeChoice) => void;
	/** Settings → Fleet shows live node placement health when the scheduler exposes it. */
	getFleetNodes?: () => ReadonlyArray<FleetNodeSnapshot>;
	/** Settings → Targets "connect" runs the auth flow over the open settings overlay. */
	connectTarget?: (targetId: string) => Promise<void> | void;
	/** Settings → Advanced offers detected agents on the delegation.agents row. */
	getInteropProposals?: () => ReadonlyArray<InteropProposal>;
	openModelOverlay?: typeof openModelOverlay;
	openModelScopeOverlay?: typeof openModelScopeOverlay;
	openSettingsOverlay?: typeof openSettingsOverlay;
}

export interface OverlayModelSelectors {
	openModelOverlayState(): void;
	/** Ask where a resolved swap lands, then apply it. Nothing changes until the operator answers. */
	openModelScopeState(ref: PendingModelScope): void;
	openSettingsOverlayState(section?: SettingsSectionId, rowId?: SettingsCenterRowId): void;
	refreshSettingsOverlay(): void;
}

export function createOverlayModelSelectors(deps: OverlayModelSelectorsDeps): OverlayModelSelectors {
	const openModel = deps.openModelOverlay ?? openModelOverlay;
	const openModelScope = deps.openModelScopeOverlay ?? openModelScopeOverlay;
	const openSettings = deps.openSettingsOverlay ?? openSettingsOverlay;
	let settingsOverlayRefresh: (() => void) | null = null;

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
			// The picker resolves what to run; the scope dialog resolves where it
			// lands. Closing this overlay first keeps one modal on screen at a time.
			onSelect: (ref) => {
				deps.closeOverlay();
				openModelScopeState(ref);
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

	const openModelScopeState = (ref: PendingModelScope): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "model-scope";
		deps.transitions.handle = openModelScope(deps.tui, {
			ref,
			onChoose: (scope) => {
				deps.closeOverlay();
				deps.onSelectModel?.({ target: ref.target, model: ref.model }, scope);
				if (ref.thinkingLevel) deps.onSetThinkingLevel?.(ref.thinkingLevel, scope);
				const swap = formatPendingModelScope(ref);
				deps.notify("success", scope === "global" ? `active and saved globally: ${swap}` : `active this session: ${swap}`);
				deps.refreshFooter();
			},
			onCancel: () => {
				deps.closeOverlay();
				deps.notify("info", "model unchanged");
			},
		});
		deps.tui.requestRender();
	};

	const openSettingsOverlayState = (section?: SettingsSectionId, rowId?: SettingsCenterRowId): void => {
		if (deps.transitions.state !== "closed" || !deps.getSettings || !deps.writeSettings) return;
		deps.transitions.state = "settings";
		const handle = openSettings(deps.tui, {
			getSettings: deps.getSettings,
			providers: deps.providers,
			...(section ? { section } : {}),
			...(rowId ? { rowId } : {}),
			...(deps.getFleetNodes ? { getFleetNodes: deps.getFleetNodes } : {}),
			...(deps.connectTarget ? { connectTarget: deps.connectTarget } : {}),
			...(deps.getInteropProposals ? { getInteropProposals: deps.getInteropProposals } : {}),
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
		openModelOverlayState,
		openModelScopeState,
		openSettingsOverlayState,
		refreshSettingsOverlay: () => settingsOverlayRefresh?.(),
	};
}
