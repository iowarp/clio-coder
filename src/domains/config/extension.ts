import { BusChannels, type ConfigChangePayload } from "../../core/bus-events.js";
import { type ClioSettings, readSettings, updateSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { type ChangeKind, diffSettings } from "./classify.js";
import type { ConfigContract } from "./contract.js";
import { type ConfigWatcher, startConfigWatcher } from "./watcher.js";

type ChangeListener = (payload: ConfigChangePayload) => void;

export function createConfigBundle(context: DomainContext): DomainBundle<ConfigContract> {
	let watcher: ConfigWatcher | null = null;
	let snapshot: ClioSettings | null = null;
	const listeners = new Map<ChangeKind, Set<ChangeListener>>([
		["hotReload", new Set()],
		["nextTurn", new Set()],
		["restartRequired", new Set()],
	]);

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

	function onWatcherFire(): void {
		let next: ClioSettings;
		try {
			next = readSettings();
		} catch (err) {
			console.error("[clio:config] reload rejected:", err);
			return;
		}
		const prev = snapshot;
		snapshot = next;
		if (!prev) return;
		const diff = diffSettings(prev, next);
		if (diff.hotReload.length > 0) dispatch("hotReload", { diff, settings: next });
		if (diff.nextTurn.length > 0) dispatch("nextTurn", { diff, settings: next });
		if (diff.restartRequired.length > 0) dispatch("restartRequired", { diff, settings: next });
	}

	const extension: DomainExtension = {
		async start() {
			snapshot = readSettings();
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
			const normalized = updateSettings(mutate);
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
