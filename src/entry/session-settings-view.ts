/**
 * The live session's effective settings: saved settings under this process's
 * startup overrides, the conversation's "for this session only" overrides and
 * the session routing state, plus every mutation that moves one of those
 * layers or writes through to a saved one.
 *
 * The composition root builds it once, after the routing state is seeded,
 * then publishes `getCurrentSettings` as the late-bound settings slot before
 * `start` runs the first projection and subscribes to session and config
 * changes.
 */

import type { ClioSettings, SettingsMutator } from "../core/config.js";
import { readSettings, updateSettings } from "../core/config.js";
import type { OutputStyle } from "../core/defaults.js";
import { configureGitCommitAttribution } from "../core/git-commit-attribution.js";
import { configureGuardrails, guardrailValuesFromSettings } from "../core/guardrails.js";
import { type RouteProvenance, resolveRouteProvenance, routeForSettingPath } from "../core/route-provenance.js";
import {
	applyOverrides,
	applyRoutingPatch,
	applySessionRouting,
	commitRoutingPatch,
	createRoutingGestures,
	diffRouting,
	getAtPath,
	isRoutingPath,
	mergeRoutingPatchIntoSettings,
	type RoutingPatch,
	restoreRoutingFields,
	routingPatchForId,
	type SessionOverrides,
	type SessionRoutingState,
	setAtPath,
} from "../core/session-routing.js";
import { type SettingsOrigin, settingsSourceFor, updateProjectLocalSettings } from "../core/settings-layers.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { ConfigChangeSource } from "../core/telemetry/live-events.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { diffSettings } from "../domains/config/index.js";
import { configureRunEventJournal } from "../domains/dispatch/run-event-journal.js";
import type { ProvidersContract, ThinkingLevel } from "../domains/providers/index.js";
import {
	isOrchestratorEligibleRuntime,
	resolveModelRuntimeCapabilitiesForProviders,
	resolveRuntimeTarget,
	VALID_THINKING_LEVELS,
} from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import type { SessionContract } from "../domains/session/contract.js";
import { restoreResumedSessionRoute } from "../domains/session/resumed-route.js";
import { appendSessionThinkingLevel } from "../domains/session/thinking-route.js";
import type { AcpSafeSettingsPatch, AcpSafeSettingsSnapshot } from "../engine/acp/server.js";
import type { clampThinkingLevel, selectModel } from "../session-control/index.js";

type SettingsScope = "session" | "project" | "global";

interface SessionSettingsViewDeps {
	config: ConfigContract | undefined;
	providers: ProvidersContract;
	session: SessionContract | undefined;
	bus: TelemetryHub;
	/** Process-wide overrides from the command line; the root may still add to it before the first read. */
	startupOverrides: SessionOverrides;
	sessionRouting: SessionRoutingState;
	outputStyleListeners: ReadonlySet<(style: OutputStyle) => void>;
	/** Session-control's model decisions, passed in so this module stays off the Stage 0 seam. */
	selectModel: typeof selectModel;
	clampThinkingLevel: typeof clampThinkingLevel;
}

function advanceThinkingLevel(current: ThinkingLevel, available: ReadonlyArray<ThinkingLevel>): ThinkingLevel {
	const levels = available.length > 0 ? available : VALID_THINKING_LEVELS;
	if (!levels.includes(current)) return levels[0] ?? "off";
	const normalized = current;
	const idx = levels.indexOf(normalized);
	return levels[(idx + 1) % levels.length] ?? "off";
}

/**
 * Scoped model cycle actions step the orchestrator through the `scope` list of target
 * ids or target/model refs. Absent scope is a no-op so unconfigured users
 * feel nothing.
 */
function advanceScopedTarget(
	settings: Readonly<ClioSettings>,
	direction: "forward" | "backward",
): { target: string; model: string | null } | null {
	const scope = settings.chat.modelPicker.cycleSet ?? [];
	if (scope.length === 0) return null;
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const filteredScope = scope.filter((entry) => {
		const [targetId] = entry.split("/");
		const target = settings.targets.find((e) => e.id === targetId);
		if (!target) return false;
		const runtime = registry.get(target.runtime);
		return runtime !== null && isOrchestratorEligibleRuntime(runtime);
	});
	if (filteredScope.length === 0) return null;
	const activeTarget = settings.chat.target ?? "";
	const activeModel = settings.chat.model ?? "";
	const activeCombinedRef = activeTarget.length > 0 && activeModel.length > 0 ? `${activeTarget}/${activeModel}` : "";
	const idx = filteredScope.findIndex((entry) => entry === activeCombinedRef || entry === activeTarget);
	const base = idx === -1 ? 0 : idx + (direction === "forward" ? 1 : filteredScope.length - 1);
	const next = filteredScope[base % filteredScope.length];
	if (!next) return null;
	const [targetId, ...modelParts] = next.split("/");
	if (!targetId) return null;
	if (modelParts.length > 0) {
		return { target: targetId, model: modelParts.join("/") };
	}
	if (activeTarget === targetId) {
		return { target: targetId, model: activeModel || null };
	}
	const descriptor = settings.targets.find((entry) => entry.id === targetId);
	return { target: targetId, model: descriptor?.defaultModel ?? null };
}

export function createSessionSettingsView(deps: SessionSettingsViewDeps) {
	const { config, providers, session, bus, startupOverrides, sessionRouting, outputStyleListeners } = deps;
	const conversationOverrides = new Map<string, SessionOverrides>();
	let overrideSessionId = session?.current()?.id ?? null;
	let sessionOverrides: SessionOverrides = new Map();
	let forkParentId: string | null = null;
	let loadingSessionId: string | null = null;
	const syncConversationOverrides = (resumedId: string | null = loadingSessionId): boolean => {
		const incomingId = session?.current()?.id ?? null;
		if (incomingId === overrideSessionId) return false;
		if (overrideSessionId !== null) conversationOverrides.set(overrideSessionId, sessionOverrides);
		// AUD-3 finding 1: a draft's choices belong to its first newly created
		// conversation, while resuming an existing ID discards the draft. A fork
		// continues its parent, so inherit a copy; later resumes load its own map.
		// SessionResuming marks loads before replacement, so earlier resume observers see the same choice.
		let incomingOverrides = incomingId === null ? undefined : conversationOverrides.get(incomingId);
		if (incomingOverrides === undefined && incomingId !== null && incomingId !== resumedId) {
			if (overrideSessionId === null) incomingOverrides = sessionOverrides;
			else if (forkParentId === overrideSessionId) incomingOverrides = new Map(sessionOverrides);
		}
		overrideSessionId = incomingId;
		sessionOverrides = incomingOverrides ?? new Map();
		forkParentId = null;
		loadingSessionId = null;
		return true;
	};
	// The effective view is derived by deep-cloning the saved snapshot, and it
	// is read on the tool-admission hot path (every call resolves autonomy
	// through it). Memoize on the two things it depends on: the config
	// domain's snapshot identity (swapped wholesale on every update and
	// external hot reload) and a generation counter bumped by every session
	// routing/override mutation below. Without this, one tool call cost a full
	// settings structuredClone.
	let sessionStateGeneration = 0;
	let cachedSettingsBase: Readonly<ClioSettings> | null = null;
	let cachedSettingsGeneration = -1;
	let cachedSettingsView: ClioSettings | null = null;
	const bumpSessionState = (): void => {
		sessionStateGeneration += 1;
		const settings = getCurrentSettings();
		configureGuardrails(guardrailValuesFromSettings(settings));
		configureRunEventJournal(settings.fleet.history.journal);
		configureGitCommitAttribution(settings.integrations.git);
	};
	const getCurrentSettings = (): ClioSettings => {
		// AUD-3 finding 1: lazy creates and forks do not emit SessionResumed.
		// Check identity before a cached view can expose the outgoing conversation.
		if (syncConversationOverrides()) bumpSessionState();
		// Recents live in the data dir (core/recent-models.ts), never in
		// settings.yaml; consumers that need them call listRecentModels
		// directly, so an Alt+M pick in another session does not churn the
		// config watcher here.
		const base = config?.get();
		// No config domain (unit tests, degraded boot): readSettings() returns a
		// fresh object every call, so there is nothing stable to key a cache on.
		if (base === undefined) {
			return applySessionRouting(
				applyOverrides(readSettings(), new Map([...startupOverrides, ...sessionOverrides])),
				sessionRouting,
			);
		}
		if (
			cachedSettingsView !== null &&
			cachedSettingsBase === base &&
			cachedSettingsGeneration === sessionStateGeneration
		) {
			return cachedSettingsView;
		}
		const view = applySessionRouting(
			applyOverrides(base, new Map([...startupOverrides, ...sessionOverrides])),
			sessionRouting,
		);
		cachedSettingsBase = base;
		cachedSettingsGeneration = sessionStateGeneration;
		cachedSettingsView = view;
		return view;
	};
	const persistCurrentThinkingLevel = (): void => {
		const meta = session?.current();
		if (!session || !meta) return;
		const chat = getCurrentSettings().chat;
		const level = chat.thinkingLevel ?? "off";
		const resolved =
			chat.target && chat.model
				? resolveRuntimeTarget(providers, {
						targetId: chat.target,
						wireModelId: chat.model,
						requestedThinkingLevel: level,
						use: "orchestrator",
						requireTools: false,
					})
				: null;
		const effort = resolved?.ok
			? (resolved.target.modelRuntime.thinking.effort ??
				(resolved.target.effectiveThinkingLevel === "off" ? "none" : resolved.target.effectiveThinkingLevel))
			: undefined;
		appendSessionThinkingLevel(
			session,
			level,
			effort,
			session.leafId(meta.id),
			resolved?.ok ? resolved.target.effectiveThinkingLevel : undefined,
		);
	};
	// Recomputed on every read from live state, so a compaction summary that
	// dropped a session-only route cannot change what Clio says about it (DF-7).
	const routeProvenance = (): RouteProvenance => {
		const sources = config?.sources?.() ?? {};
		return resolveRouteProvenance(getCurrentSettings(), config?.get() ?? readSettings(), (path) =>
			settingsSourceFor(sources, path),
		);
	};
	// Which layer set one setting's effective value, for the settings center's
	// origin column: a route reads its live provenance, any other path is a
	// session override or whichever file layer set it.
	const settingOrigin = (path: string): SettingsOrigin | "session" => {
		const route = isRoutingPath(path) ? routeForSettingPath(path) : null;
		if (route !== null) {
			const source = routeProvenance().active[route];
			return source === "chat" ? "built-in" : source;
		}
		// The cycle set lives in the session's routing state, not its overrides, and no route owns it.
		if (
			isRoutingPath(path) &&
			JSON.stringify(getAtPath(getCurrentSettings(), path)) !==
				JSON.stringify(getAtPath(config?.get() ?? readSettings(), path))
		) {
			return "session";
		}
		if (sessionOverrides.has(path)) return "session";
		return settingsSourceFor(config?.sources?.() ?? {}, path);
	};
	/**
	 * The first projection, then the session and config subscriptions, each
	 * group handing its unsubscribes to `onDrain` as one hook.
	 */
	const start = (onDrain: (hook: () => void) => void): void => {
		bumpSessionState();
		// AUD-3 finding 1: resume/branch switches publish after replacement; new
		// conversations and forks only park, so refresh those after replacement.
		const unsubscribeConversationOverrides = [
			bus.subscribe("session.resume_started", ({ sessionId }) => {
				loadingSessionId = sessionId;
				queueMicrotask(() => {
					if (loadingSessionId === sessionId) loadingSessionId = null;
				});
			}),
			bus.subscribe("session.reattached", ({ sessionId }) => {
				if (syncConversationOverrides(sessionId)) bumpSessionState();
			}),
			bus.subscribe("session.parked", ({ sessionId, reason }) => {
				forkParentId = reason === "fork" ? sessionId : null;
				queueMicrotask(() => getCurrentSettings());
			}),
		];
		onDrain(() => {
			for (const unsubscribe of unsubscribeConversationOverrides) unsubscribe();
		});
		// The config bundle publishes saved values on reload; session-scoped
		// overrides must win, so re-derive every process-local projection from the
		// effective session view after it.
		const unsubscribeSettingsProjectionSync = (["config.hot_reloaded", "config.next_turn_scheduled"] as const).map(
			(channel) => bus.subscribe(channel, () => bumpSessionState()),
		);
		onDrain(() => {
			for (const unsubscribe of unsubscribeSettingsProjectionSync) unsubscribe();
		});
	};
	/**
	 * Locked read-modify-write of saved settings. Routes through the config
	 * contract (which refreshes its snapshot and dispatches change events) when
	 * available, else straight through core updateSettings. Either way the
	 * mutator runs against the freshest on-disk state under the advisory
	 * settings lock, so two processes saving defaults at the same time cannot
	 * interleave and drop each other's patches.
	 */
	const persistSavedMutation = (mutator: SettingsMutator, source: ConfigChangeSource): void => {
		if (config?.update) config.update(mutator, source);
		else updateSettings(mutator);
		bumpSessionState();
	};
	const persistProjectMutation = (mutator: SettingsMutator, source: ConfigChangeSource): void => {
		if (config?.updateProject) config.updateProject(mutator, source);
		else updateProjectLocalSettings(process.cwd(), mutator);
		bumpSessionState();
	};
	/**
	 * Apply a routing change with one consistent scope: it takes effect in this
	 * session immediately and writes through to saved settings as the default
	 * for future sessions. Only the patched fields hit the file, so concurrent
	 * sessions cannot clobber each other's saved defaults wholesale. A save the
	 * file refuses puts the live route back (commitRoutingPatch) and rethrows.
	 */
	const updateSessionRouting = (patch: RoutingPatch, source: ConfigChangeSource): void => {
		commitRoutingPatch(
			sessionRouting,
			patch,
			() => persistSavedMutation((saved) => mergeRoutingPatchIntoSettings(saved, patch), source),
			bumpSessionState,
		);
		persistCurrentThinkingLevel();
	};
	/**
	 * A routing change at the scope the operator chose. "session" moves the live
	 * route and leaves settings.yaml alone, so a swap that points at a dead
	 * endpoint dies with the session that made it; "global" is the historical
	 * write-through. Nothing on this path writes durably without a scope.
	 */
	/**
	 * An edit that moved only this session's effective settings. The saved layers did not change, so the config
	 * domain publishes nothing; this tells the journal and a held budget admission which surface made it (#434).
	 */
	const publishSessionSettingsChange = (previous: ClioSettings, source: ConfigChangeSource): void => {
		const sessionId = session?.current()?.id;
		if (!sessionId) return;
		const settings = getCurrentSettings();
		const diff = diffSettings(previous, settings);
		if (diff.hotReload.length + diff.nextTurn.length + diff.restartRequired.length === 0) return;
		bus.emit("config.session_changed", { sessionId, diff, settings, previous, source, scope: "session" });
	};
	const applyRoutingAtScope = (patch: RoutingPatch, scope: SettingsScope, source: ConfigChangeSource): void => {
		if (scope === "global") {
			updateSessionRouting(patch, source);
			return;
		}
		if (scope === "project") {
			persistProjectMutation((saved) => mergeRoutingPatchIntoSettings(saved, patch), source);
		}
		const previous = getCurrentSettings();
		applyRoutingPatch(sessionRouting, patch);
		bumpSessionState();
		if (scope === "session") publishSessionSettingsChange(previous, source);
		persistCurrentThinkingLevel();
	};
	/** Pick a target and model at a scope; an absent thinking level keeps the live one. */
	const selectAtScope = (
		choice: { target: string; model: string; thinkingLevel?: ThinkingLevel | undefined },
		scope: SettingsScope,
		source: ConfigChangeSource,
	): void => {
		const current = getCurrentSettings();
		deps.selectModel(
			providers,
			{ target: choice.target, model: choice.model, thinkingLevel: choice.thinkingLevel ?? current.chat.thinkingLevel },
			(selected) => applyRoutingAtScope({ orchestrator: selected }, scope, source),
			current.chat.modelPicker.recentLimit,
		);
	};
	/** Apply a route patch at a scope with its thinking level clamped to what the patched route supports. */
	const clampAtScope = (
		patch: { target?: string; model?: string; thinkingLevel?: ThinkingLevel },
		scope: SettingsScope,
		source: ConfigChangeSource,
	): void => {
		const current = getCurrentSettings();
		const thinkingLevel = deps.clampThinkingLevel(
			providers,
			patch.target ?? current.chat.target,
			patch.model ?? current.chat.model,
			patch.thinkingLevel ?? current.chat.thinkingLevel,
		);
		applyRoutingAtScope({ orchestrator: { ...patch, thinkingLevel } }, scope, source);
	};
	const readAcpSafeSettings = (): AcpSafeSettingsSnapshot => {
		const settings = getCurrentSettings();
		return {
			target: settings.chat.target,
			model: settings.chat.model,
			thinkingLevel: settings.chat.thinkingLevel ?? "off",
			autonomy: settings.safety.autonomy,
		};
	};
	/**
	 * ACP safe settings are one atomic persisted mutation followed by infallible
	 * in-process routing assignment. Persisting first avoids reporting a live
	 * route that failed to become the future-session default.
	 */
	const commitAcpSafeSettings = (patch: AcpSafeSettingsPatch, source: "acp" | "gui"): AcpSafeSettingsSnapshot => {
		const orchestrator: NonNullable<RoutingPatch["orchestrator"]> = {};
		if (patch["chat.target"] !== undefined) orchestrator.target = patch["chat.target"];
		if (patch["chat.model"] !== undefined) orchestrator.model = patch["chat.model"];
		if (patch["chat.thinkingLevel"] !== undefined) {
			orchestrator.thinkingLevel = patch["chat.thinkingLevel"];
		}
		const routingPatch: RoutingPatch | null = Object.keys(orchestrator).length > 0 ? { orchestrator } : null;
		persistSavedMutation((saved) => {
			if (routingPatch !== null) mergeRoutingPatchIntoSettings(saved, routingPatch);
			if (patch["safety.autonomy"] !== undefined) saved.safety.autonomy = patch["safety.autonomy"];
		}, source);
		if (routingPatch !== null) {
			applyRoutingPatch(sessionRouting, routingPatch);
			bumpSessionState();
		}
		persistCurrentThinkingLevel();
		return readAcpSafeSettings();
	};
	/**
	 * Persist a whole-settings blob coming from the effective view (the
	 * /settings overlay, favorites toggles). Routing edits in the blob are
	 * absorbed into the session state and written through; everything else is
	 * persisted without leaking this session's routing into the saved defaults.
	 */
	const applySettingsBlob = (next: ClioSettings, source: ConfigChangeSource): void => {
		const patch = diffRouting(getCurrentSettings(), next);
		commitRoutingPatch(
			sessionRouting,
			patch ?? {},
			() =>
				persistSavedMutation((fresh) => {
					const persisted = structuredClone(next);
					restoreRoutingFields(persisted, fresh);
					// A whole-blob write (providers, favorites) must not globalize a
					// session-only override: restore every overridden leaf from the
					// fresh file so it stays session-local until explicitly saved.
					for (const path of [...startupOverrides.keys(), ...sessionOverrides.keys()]) {
						setAtPath(persisted, path, getAtPath(fresh, path));
					}
					if (patch) mergeRoutingPatchIntoSettings(persisted, patch);
					return persisted;
				}, source),
			bumpSessionState,
		);
		persistCurrentThinkingLevel();
	};
	/**
	 * Commit a single /settings edit, keyed by its config-path id. `next` is the
	 * effective view with the one leaf already changed.
	 *   - scope "session": apply live only. Routing ids feed the routing state;
	 *     every other id becomes a session override. settings.yaml is untouched.
	 *   - scope "global": apply live and persist just that leaf as the new
	 *     default, clearing any prior session override for it.
	 * Restart-required ids (budget.concurrency, runtimePlugins,
	 * terminal.tuiMode, terminal.fullscreenScrollbar) cannot apply
	 * live, so the overlay only offers "global" for them; the file write is what
	 * a later restart picks up.
	 */
	const commitSetting = (id: string, next: ClioSettings, scope: SettingsScope, source: ConfigChangeSource): void => {
		if (isRoutingPath(id)) {
			// Build the patch from `next` keyed by the edited id, not by diffing
			// against the live view: a prior session-only apply already moved the
			// routing state, so a diff would be empty and the global save would
			// silently no-op. Only the touched fields are persisted, so concurrent
			// sessions never clobber each other's saved routing.
			const patch = routingPatchForId(id, next);
			if (!patch) return;
			if (scope === "global") {
				updateSessionRouting(patch, source);
				return;
			}
			applyRoutingAtScope(patch, scope, source);
			return;
		}
		const previous = getCurrentSettings();
		const value = getAtPath(next, id);
		if (scope === "session") {
			sessionOverrides.set(id, value);
			bumpSessionState();
			publishSessionSettingsChange(previous, source);
			if (id === "interface.outputDetail") {
				const style = getCurrentSettings().interface.outputDetail;
				for (const listener of outputStyleListeners) listener(style);
			}
			return;
		}
		if (scope === "project") {
			persistProjectMutation((saved) => setAtPath(saved, id, value), source);
			sessionOverrides.delete(id);
			bumpSessionState();
			return;
		}
		// Same contract as a routing save: a refused write leaves the session
		// override it would have replaced in place.
		const hadOverride = sessionOverrides.has(id);
		const priorOverride = sessionOverrides.get(id);
		sessionOverrides.delete(id);
		bumpSessionState();
		try {
			persistSavedMutation((saved) => setAtPath(saved, id, value), source);
		} catch (error) {
			if (hadOverride) sessionOverrides.set(id, priorOverride);
			bumpSessionState();
			throw error;
		}
	};
	// Shift+Tab and the scoped model cycle move this session only; see createRoutingGestures.
	const routingGestures = createRoutingGestures({
		nextThinkingLevel: () => {
			const current = getCurrentSettings();
			const thinking = resolveModelRuntimeCapabilitiesForProviders(
				providers,
				current.chat.target,
				current.chat.model,
				current.chat.thinkingLevel ?? "off",
			)?.thinking;
			const effectiveAvailable = thinking?.supportedLevels ?? (["off"] as ThinkingLevel[]);
			return advanceThinkingLevel(thinking?.effectiveLevel ?? current.chat.thinkingLevel ?? "off", effectiveAvailable);
		},
		nextScopedTarget: (direction) => advanceScopedTarget(getCurrentSettings(), direction),
		apply: (patch, scope) => applyRoutingAtScope(patch, scope, "keybinding"),
	});
	const restoreResumedRoute = (pinned?: { route?: boolean; thinking?: boolean }): string | null =>
		restoreResumedSessionRoute(
			{
				session: session ?? null,
				currentSettings: getCurrentSettings,
				defaultThinkingLevel: () => (config?.get() ?? readSettings()).chat.thinkingLevel ?? "off",
				applyPatch: (patch) => {
					applyRoutingPatch(sessionRouting, patch);
					bumpSessionState();
				},
				persistThinkingLevel: persistCurrentThinkingLevel,
			},
			pinned,
		);
	/** Create a session on the current route and record the route's thinking level in it. */
	const createRoutedSession = (): void => {
		const settings = getCurrentSettings();
		session?.create({
			cwd: process.cwd(),
			...(settings.chat.target ? { target: settings.chat.target } : {}),
			...(settings.chat.model ? { model: settings.chat.model } : {}),
		});
		persistCurrentThinkingLevel();
	};
	return {
		getCurrentSettings,
		bump: bumpSessionState,
		start,
		persistCurrentThinkingLevel,
		routeProvenance,
		settingOrigin,
		persistSavedMutation,
		applyRoutingAtScope,
		selectAtScope,
		clampAtScope,
		readAcpSafeSettings,
		commitAcpSafeSettings,
		applySettingsBlob,
		commitSetting,
		routingGestures,
		restoreResumedRoute,
		createRoutedSession,
	};
}
