import { BusChannels, type ConfigChangePayload } from "../../core/bus-events.js";
import { type ClioSettings, formatSettingsFailure, readSettings, updateSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { readLayeredSettings } from "../../core/settings-layers.js";
import { assertAgentIdNamespace } from "./agent-namespace.js";
import { type ChangeKind, diffSettings } from "./classify.js";
import type { ConfigContract } from "./contract.js";
import { type ConfigWatcher, startConfigWatcher } from "./watcher.js";

type ChangeListener = (payload: ConfigChangePayload) => void;

interface NativeAgentNamespace {
	list(): ReadonlyArray<{ id: string }>;
}

export function createConfigBundle(context: DomainContext): DomainBundle<ConfigContract> {
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
		if (agents) assertAgentIdNamespace(agents.list(), settings.delegation.agents);
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
				console.error(`[clio:config] listener for ${kind} threw:`, err);
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
			// readSettings keeps the strict throw-on-invalid-user-settings gate; the
			// layered read then overlays project .clio/settings(.local).yaml.
			readSettings();
			next = readLayeredSettings(process.cwd()).settings;
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
		if (!prev) return;
		const diff = diffSettings(prev, next);
		if (diff.hotReload.length > 0) dispatch("hotReload", { diff, settings: next });
		if (diff.nextTurn.length > 0) dispatch("nextTurn", { diff, settings: next });
		if (diff.restartRequired.length > 0) dispatch("restartRequired", { diff, settings: next });
	}

	const extension: DomainExtension = {
		async start() {
			readSettings();
			snapshot = readLayeredSettings(process.cwd()).settings;
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
			// updateSettings writes the user layer; re-layer so project overlays
			// stay applied in the refreshed snapshot.
			updateSettings(mutate);
			const normalized = readLayeredSettings(process.cwd()).settings;
			snapshot = normalized;
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
