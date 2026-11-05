import type { ClioSettings } from "../core/config.js";
import type { ThinkingLevel } from "../core/defaults.js";
import { formatFooterTokens } from "../core/display-units.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { RouteBreakerView } from "../domains/dispatch/contract.js";
import type { InteropProposal } from "../domains/interop/index.js";
import {
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	thinkingEffectNote,
} from "../domains/providers/index.js";
import type { FleetNodeSnapshot } from "../domains/scheduling/cluster.js";
import type { TUI } from "../engine/tui.js";
import type { RouteMoveFit, RouteMoveResult, RouteMoveWait } from "../session-control/chat-loop.js";
import type { FooterDashboardPanel } from "./footer/dashboard.js";
import { routeAppliedNoticeKey } from "./footer/notifications.js";
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
import type { SettingValueOrigin } from "./overlays/settings-presentation.js";

export interface OverlayModelSelectorsDeps {
	tui: TUI;
	transitions: Pick<OverlayTransitions, "state" | "handle">;
	providers: ProvidersContract;
	bus: TelemetryHub;
	refreshFooter: Pick<FooterDashboardPanel, "refresh">["refresh"];
	notify: (level: InteractiveNoticeLevel, text: string, key?: string) => void;
	closeOverlay: () => void;
	getSettings?: () => Readonly<ClioSettings>;
	writeSettings?: (next: ClioSettings) => void;
	commitSetting?: (id: string, next: ClioSettings, scope: "session" | "project" | "global") => void;
	/** Settings shows which layer set each value when the host can say. */
	settingOrigin?: (path: string) => SettingValueOrigin;
	onSelectModel?: (ref: { target: string; model: string }, scope: ModelScopeChoice) => void;
	/** A pick made during a turn takes effect on the next one, which the confirmation has to say. */
	isTurnInFlight?: () => boolean;
	/** What the next request would resend of this session, null or zero when it has no history yet. */
	historyTokens?: () => number | null;
	routeLeavesCache?: (route: { target: string; model: string }) => boolean;
	/** What the running turn is waiting on, read live: it decides whether a pick moves the request. */
	routeMoveWait?: () => RouteMoveWait;
	routeMoveFit?: (route: { target: string; model: string }) => RouteMoveFit;
	/** Called once the pick is applied. Sends the waiting request to the new route if it can still go. */
	moveWaitingRequest?: () => RouteMoveResult;
	/** Applied with the chosen scope when the swap named a thinking level. */
	onSetThinkingLevel?: (level: ThinkingLevel, scope?: ModelScopeChoice) => void;
	/** Settings → Fleet shows live node placement health when the scheduler exposes it. */
	getFleetNodes?: () => ReadonlyArray<FleetNodeSnapshot>;
	/** Settings → Targets shows this process's dispatch breaker state per route. */
	getRouteBreakers?: () => ReadonlyArray<RouteBreakerView>;
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

/** Why a pick cannot reach this turn, for the dialog and the confirmation alike. */
function notThisTurn(wait: RouteMoveWait, fit?: RouteMoveFit): string {
	if (fit?.kind === "too-large")
		return `this conversation needs about ${formatFooterTokens(fit.neededTokens)} tokens and that model's window is ${formatFooterTokens(fit.window)}`;
	if (fit?.kind === "images") return "it cannot read this turn's images";
	if (fit?.kind === "unresolved") return "it cannot be used right now";
	if (wait === "output") return "output has started";
	if (wait === "tool") return "a tool is running";
	return "this request is not waiting on a model";
}

/** The line above the model list, before any route is chosen. */
export function modelListTurnEffect(wait: RouteMoveWait): string | null {
	if (wait === "idle") return null;
	if (wait === "first-output") return "No output yet, so a pick moves the waiting request.";
	if (wait === "retry-wait") return "Waiting to retry, so a pick sends the request now.";
	return `A pick applies from the next turn, because ${notThisTurn(wait)}.`;
}

/** What a swap costs a session with history, in the words of its journal's `model_changed` cold reason. */
export function routeSwitchCost(historyTokens: number | null | undefined, leavesCache: boolean): string | null {
	if (!leavesCache || !historyTokens || historyTokens <= 0) return null;
	return `A new model starts with no prompt cache, so the next turn re-reads this session's ${formatFooterTokens(historyTokens)} tokens.`;
}

/** The line in the scope dialog, once the route is known. */
export function routeTurnEffect(wait: RouteMoveWait, fit: RouteMoveFit | undefined, model: string): string | null {
	if (wait === "idle" || fit?.kind === "same") return null;
	const movable = wait === "first-output" || wait === "retry-wait";
	if (movable && (fit === undefined || fit.kind === "fits")) {
		return wait === "first-output"
			? `No output yet, so this moves the waiting request to ${model} now.`
			: `Waiting to retry, so this sends the request to ${model} now.`;
	}
	return `Applies from the next turn, because ${notThisTurn(wait, movable ? fit : undefined)}.`;
}

/** The clause the confirmation ends on, from what actually happened at the Enter. */
function moveOutcomeClause(result: RouteMoveResult): string {
	if (result.kind === "moved") return " · moved the waiting request";
	if (result.kind !== "next-turn") return "";
	return result.fit ? ` · from the next turn, because ${notThisTurn(result.wait, result.fit)}` : " · from the next turn";
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
			...(deps.routeMoveWait ? { turnEffect: () => modelListTurnEffect(deps.routeMoveWait?.() ?? "idle") } : {}),
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
				const current = new Set(next.chat.modelPicker?.favorites ?? []);
				if (favorite) current.add(value);
				else current.delete(value);
				next.chat.modelPicker = {
					...(next.chat.modelPicker ?? { recentLimit: 12, favorites: [] }),
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
		// Sized once: nothing grows the context while a request waits, and the frame loop must not re-estimate it.
		const fit =
			deps.routeMoveWait?.() !== "idle" ? deps.routeMoveFit?.({ target: ref.target, model: ref.model }) : undefined;
		const switchCost = routeSwitchCost(
			deps.historyTokens?.(),
			deps.routeLeavesCache?.({ target: ref.target, model: ref.model }) ?? false,
		);
		deps.transitions.handle = openModelScope(deps.tui, {
			ref,
			...(switchCost ? { switchCost } : {}),
			...(deps.routeMoveWait
				? { turnEffect: () => routeTurnEffect(deps.routeMoveWait?.() ?? "idle", fit, ref.model) }
				: {}),
			onChoose: (scope) => {
				deps.closeOverlay();
				const swap = formatPendingModelScope(ref);
				// A refused save (a project setting that outranks the user file, an
				// ineligible runtime) leaves the route where it was; say so here
				// rather than let the throw escape the key handler after the success
				// line was never shown.
				const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));
				try {
					deps.onSelectModel?.({ target: ref.target, model: ref.model }, scope);
				} catch (error) {
					deps.notify("error", `model unchanged: ${swap} was not applied: ${failure(error)}`);
					deps.refreshFooter();
					return;
				}
				try {
					if (ref.thinkingLevel) deps.onSetThinkingLevel?.(ref.thinkingLevel, scope);
				} catch (error) {
					deps.notify("warning", `model applied, thinking unchanged: ${failure(error)}`);
					deps.refreshFooter();
					return;
				}
				const timing = deps.moveWaitingRequest
					? moveOutcomeClause(deps.moveWaitingRequest())
					: deps.isTurnInFlight?.() === true
						? " · from the next turn"
						: "";
				const applied =
					scope === "global"
						? `active and saved globally: ${swap}${timing}`
						: scope === "project"
							? `active and saved for this project: ${swap}${timing}`
							: `active this session: ${swap}${timing}`;
				const down = deps.providers.list().find((status) => status.target.id === ref.target)?.health.status === "down";
				const thinking = resolveModelRuntimeCapabilitiesForProviders(
					deps.providers,
					ref.target,
					ref.model,
					deps.getSettings?.().chat?.thinkingLevel ?? "off",
				)?.thinking;
				const note = thinking ? thinkingEffectNote(thinking) : null;
				const facts = [
					applied,
					down ? "this route is down, so turns fail until it answers; /model switches" : null,
					note !== null && thinking ? `thinking ${thinking.display} (${note})` : null,
				];
				deps.notify(
					down ? "warning" : "success",
					facts.filter(Boolean).join(" · "),
					routeAppliedNoticeKey(ref.target, ref.model),
				);
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
			...(deps.getRouteBreakers ? { getRouteBreakers: deps.getRouteBreakers } : {}),
			...(deps.connectTarget ? { connectTarget: deps.connectTarget } : {}),
			...(deps.getInteropProposals ? { getInteropProposals: deps.getInteropProposals } : {}),
			...(deps.settingOrigin ? { settingOrigin: deps.settingOrigin } : {}),
			writeSettings: (next) => {
				deps.writeSettings?.(next);
				deps.refreshFooter();
			},
			...(deps.commitSetting
				? {
						commitSetting: (id: string, next: ClioSettings, scope: "session" | "project" | "global") => {
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
