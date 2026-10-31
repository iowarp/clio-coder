import { type ClioSettings, formatSettingsFailure } from "../../core/config.js";
import { writeDiagnostic } from "../../core/diagnostics.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { setGitCommitAttributionEnabled } from "../../core/git-commit-attribution.js";
import { formatSettingsLayerWarning } from "../../core/settings-layer-diagnostics.js";
import {
	readLayeredSettings,
	readStrictLayeredSettings,
	type SettingsOrigin,
	updateLayeredSettings,
	updateProjectLocalSettings,
} from "../../core/settings-layers.js";
import type { ConfigChangePayload, ConfigChangeScope, ConfigChangeSource } from "../../core/telemetry/live-events.js";
import { assertAgentIdNamespace } from "./agent-namespace.js";
import { type ChangeKind, diffSettings } from "./classify.js";
import type { ConfigContract } from "./contract.js";
import { type ConfigWatcher, startConfigWatcher } from "./watcher.js";

type ChangeListener = (payload: ConfigChangePayload) => void;

interface NativeAgentNamespace {
	list(): ReadonlyArray<{ id: string }>;
}

export interface ConfigBundleOptions {
	/**
	 * Interactive boot turns the event loop between its phases, so a settings
	 * write can reach the watcher before the agents domain can validate it or
	 * any reload subscriber exists. While held, a watcher fire only marks a
	 * reload pending, and `releaseReloads()` runs it once with both in place.
	 */
	holdReloads?: boolean;
}

export function createConfigBundle(
	context: DomainContext,
	initialSettings?: Readonly<ClioSettings>,
	options: ConfigBundleOptions = {},
): DomainBundle<ConfigContract> {
	let watcher: ConfigWatcher | null = null;
	let snapshot: ClioSettings | null = null;
	let reloadFailure: string | null = null;
	let projectWarning: string | null = null;
	let reloadsHeld = options.holdReloads === true;
	let reloadPending = false;
	const sessionTargets = new Map<string, ClioSettings["targets"][number]>();
	function retainSessionTargets(settings: ClioSettings): ClioSettings {
		for (const target of sessionTargets.values()) {
			if (!settings.targets.some((saved) => saved.id === target.id)) settings.targets.push(target);
		}
		return settings;
	}
	let sourcesFor: { snapshot: ClioSettings; sources: Record<string, SettingsOrigin> } | null = null;
	const listeners = new Map<ChangeKind, Set<ChangeListener>>([
		["hotReload", new Set()],
		["nextTurn", new Set()],
		["restartRequired", new Set()],
	]);

	function assertAgentNamespace(settings: Readonly<ClioSettings>): void {
		const agents = context.getContract<NativeAgentNamespace>("agents");
		if (agents) assertAgentIdNamespace(agents.list(), settings.integrations.externalAgents.entries);
	}

	function dispatch(kind: ChangeKind, payload: ConfigChangePayload): void {
		const bus = context.bus;
		const channel =
			kind === "hotReload"
				? "config.hot_reloaded"
				: kind === "nextTurn"
					? "config.next_turn_scheduled"
					: "config.restart_required";
		bus.emit(channel, payload);
		for (const listener of listeners.get(kind) ?? []) {
			try {
				listener(payload);
			} catch (err) {
				writeDiagnostic(
					`[clio-coder:config] listener for ${kind} threw: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		}
	}

	/** One payload object per change, so a listener on several kinds can tell one change from two. */
	function dispatchChange(
		previous: Readonly<ClioSettings>,
		settings: Readonly<ClioSettings>,
		source: ConfigChangeSource,
		scope?: ConfigChangeScope,
	): void {
		const diff = diffSettings(previous, settings);
		const payload: ConfigChangePayload = { diff, settings, previous, source, ...(scope ? { scope } : {}) };
		if (diff.hotReload.length > 0) dispatch("hotReload", payload);
		if (diff.nextTurn.length > 0) dispatch("nextTurn", payload);
		if (diff.restartRequired.length > 0) dispatch("restartRequired", payload);
	}

	/**
	 * Publish the rejection as one operator line, on transitions only. It used
	 * to go to `console.error` with the raw error, which inside a running TUI
	 * printed a util.inspect dump and a dist-chunk stack trace straight over
	 * the live frame. The renderer subscribes and shows a normal notice; `null`
	 * clears it once a later reload succeeds.
	 */
	function publishReloadFailure(message: string | null): void {
		if (reloadFailure === message) return;
		reloadFailure = message;
		context.bus.emit("config.reload_failed", { message });
	}

	function onWatcherFire(): void {
		if (reloadsHeld) {
			reloadPending = true;
			return;
		}
		let next: ClioSettings;
		try {
			// One file read keeps the strict user-settings gate while workspace
			// overlays retain their established best-effort diagnostics.
			const layered = readStrictLayeredSettings(process.cwd());
			const warning = formatSettingsLayerWarning(layered);
			if (warning !== null && warning !== projectWarning) writeDiagnostic(warning);
			projectWarning = warning;
			next = layered.settings;
		} catch (err) {
			// The rejection is the whole effect: `snapshot` is untouched, so the
			// session keeps running on the last good settings.
			publishReloadFailure(formatSettingsFailure(err));
			return;
		}
		const prev = snapshot;
		try {
			assertAgentNamespace(next);
		} catch (err) {
			publishReloadFailure(formatSettingsFailure(err));
			return;
		}
		publishReloadFailure(null);
		snapshot = retainSessionTargets(next);
		setGitCommitAttributionEnabled(next.integrations.git.commitAttribution);
		if (!prev) return;
		dispatchChange(prev, next, "file");
	}

	const extension: DomainExtension = {
		async start() {
			if (initialSettings) {
				snapshot = structuredClone(initialSettings);
				projectWarning = formatSettingsLayerWarning(readLayeredSettings(process.cwd()));
			} else {
				const layered = readStrictLayeredSettings(process.cwd());
				projectWarning = formatSettingsLayerWarning(layered);
				if (projectWarning !== null) writeDiagnostic(projectWarning);
				snapshot = layered.settings;
			}
			setGitCommitAttributionEnabled(snapshot.integrations.git.commitAttribution);
			watcher = startConfigWatcher(() => onWatcherFire());
		},
		async stop() {
			watcher?.stop();
			watcher = null;
		},
	};

	const contract: ConfigContract = {
		reload: onWatcherFire,
		holdReloads(targets = []) {
			for (const target of targets) sessionTargets.set(target.id, target);
			reloadsHeld = true;
		},
		get() {
			if (!snapshot) throw new Error("config domain not started");
			return snapshot;
		},
		sources() {
			if (!snapshot) throw new Error("config domain not started");
			// Every reload and save swaps the snapshot, so its identity keys the attribution.
			if (sourcesFor?.snapshot !== snapshot)
				sourcesFor = { snapshot, sources: readLayeredSettings(process.cwd()).sources };
			return sourcesFor.sources;
		},
		update(mutate, source) {
			if (!snapshot) throw new Error("config domain not started");
			const previous = snapshot;
			// Apply the effective-view delta to the user document under one lock,
			// then validate it with the project layers before writing. In particular,
			// a route may name a target supplied only by this workspace.
			const normalized = updateLayeredSettings(process.cwd(), (candidate) => {
				const next = mutate(candidate) ?? candidate;
				assertAgentNamespace(next);
				return next;
			});
			snapshot = retainSessionTargets(normalized);
			setGitCommitAttributionEnabled(normalized.integrations.git.commitAttribution);
			dispatchChange(previous, normalized, source, "user");
		},
		updateProject(mutate, source) {
			if (!snapshot) throw new Error("config domain not started");
			const previous = snapshot;
			const normalized = updateProjectLocalSettings(process.cwd(), (candidate) => {
				const next = mutate(candidate) ?? candidate;
				assertAgentNamespace(next);
				return next;
			});
			snapshot = retainSessionTargets(normalized);
			setGitCommitAttributionEnabled(normalized.integrations.git.commitAttribution);
			dispatchChange(previous, normalized, source, "project");
		},
		onChange(kind, listener) {
			listeners.get(kind)?.add(listener);
			return () => {
				listeners.get(kind)?.delete(listener);
			};
		},
		releaseReloads() {
			if (!reloadsHeld) return;
			reloadsHeld = false;
			if (!reloadPending) return;
			reloadPending = false;
			onWatcherFire();
		},
	};

	return { extension, contract };
}
