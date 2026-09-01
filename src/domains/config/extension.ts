import { BusChannels, type ConfigChangePayload } from "../../core/bus-events.js";
import { type ClioSettings, formatSettingsFailure } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { setGitCommitAttributionEnabled } from "../../core/git-commit-attribution.js";
import { readStrictLayeredSettings, updateLayeredSettings } from "../../core/settings-layers.js";
import { assertAgentIdNamespace } from "./agent-namespace.js";
import { type ChangeKind, diffSettings } from "./classify.js";
import type { ConfigContract } from "./contract.js";
import { type ConfigWatcher, startConfigWatcher } from "./watcher.js";

type ChangeListener = (payload: ConfigChangePayload) => void;

interface NativeAgentNamespace {
	list(): ReadonlyArray<{ id: string }>;
}

export function createConfigBundle(
	context: DomainContext,
	initialSettings?: Readonly<ClioSettings>,
): DomainBundle<ConfigContract> {
	let watcher: ConfigWatcher | null = null;
	let snapshot: ClioSettings | null = null;
	let reloadFailure: string | null = null;
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
				? BusChannels.ConfigHotReload
				: kind === "nextTurn"
					? BusChannels.ConfigNextTurn
					: BusChannels.ConfigRestartRequired;
		bus.emit(channel, payload);
		for (const listener of listeners.get(kind) ?? []) {
			try {
				listener(payload);
			} catch (err) {
				console.error(`[clio-coder:config] listener for ${kind} threw:`, err);
			}
		}
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
		context.bus.emit(BusChannels.ConfigReloadFailed, { message });
	}

	function onWatcherFire(): void {
		let next: ClioSettings;
		try {
			// One file read keeps the strict user-settings gate while workspace
			// overlays retain their established best-effort diagnostics.
			next = readStrictLayeredSettings(process.cwd()).settings;
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
		snapshot = next;
		setGitCommitAttributionEnabled(next.integrations.git.commitAttribution);
		if (!prev) return;
		const diff = diffSettings(prev, next);
		if (diff.hotReload.length > 0) dispatch("hotReload", { diff, settings: next });
		if (diff.nextTurn.length > 0) dispatch("nextTurn", { diff, settings: next });
		if (diff.restartRequired.length > 0) dispatch("restartRequired", { diff, settings: next });
	}

	const extension: DomainExtension = {
		async start() {
			if (initialSettings) snapshot = structuredClone(initialSettings);
			else snapshot = readStrictLayeredSettings(process.cwd()).settings;
			setGitCommitAttributionEnabled(snapshot.integrations.git.commitAttribution);
			watcher = startConfigWatcher(() => onWatcherFire());
		},
		async stop() {
			watcher?.stop();
			watcher = null;
		},
	};

	const contract: ConfigContract = {
		get() {
			if (!snapshot) throw new Error("config domain not started");
			return snapshot;
		},
		set(next) {
			contract.update?.(() => next);
		},
		update(mutate) {
			if (!snapshot) throw new Error("config domain not started");
			const previous = snapshot;
			const candidate = structuredClone(previous);
			mutate(candidate);
			assertAgentNamespace(candidate);
			// Apply the effective-view delta to the user document under one lock,
			// then validate it with the project layers before writing. In particular,
			// a route may name a target supplied only by this workspace.
			const normalized = updateLayeredSettings(process.cwd(), mutate);
			snapshot = normalized;
			setGitCommitAttributionEnabled(normalized.integrations.git.commitAttribution);
			const diff = diffSettings(previous, normalized);
			if (diff.hotReload.length > 0) dispatch("hotReload", { diff, settings: normalized });
			if (diff.nextTurn.length > 0) dispatch("nextTurn", { diff, settings: normalized });
			if (diff.restartRequired.length > 0) dispatch("restartRequired", { diff, settings: normalized });
		},
		onChange(kind, listener) {
			listeners.get(kind)?.add(listener);
			return () => {
				listeners.get(kind)?.delete(listener);
			};
		},
	};

	return { extension, contract };
}
