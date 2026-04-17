import { Value } from "@sinclair/typebox/value";
import { BusChannels } from "../../core/bus-events.js";
import { readSettings, type ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { diffSettings, type ChangeKind, type ConfigDiff } from "./classify.js";
import type { ConfigContract } from "./contract.js";
import { SettingsSchema } from "./schema.js";
import { startConfigWatcher, type ConfigWatcher } from "./watcher.js";

type ChangeListener = (payload: { diff: ConfigDiff; settings: Readonly<ClioSettings> }) => void;

export function createConfigBundle(context: DomainContext): DomainBundle<ConfigContract> {
	let watcher: ConfigWatcher | null = null;
	let snapshot: ClioSettings | null = null;
	const listeners = new Map<ChangeKind, Set<ChangeListener>>([
		["hotReload", new Set()],
		["nextTurn", new Set()],
		["restartRequired", new Set()],
	]);

	function validate(candidate: ClioSettings): void {
		if (Value.Check(SettingsSchema, candidate)) return;
		const first = [...Value.Errors(SettingsSchema, candidate)][0];
		throw new Error(`settings.yaml failed schema validation at ${first?.path ?? "(root)"}: ${first?.message ?? "unknown"}`);
	}

	function dispatch(kind: ChangeKind, payload: { diff: ConfigDiff; settings: Readonly<ClioSettings> }): void {
		const bus = context.bus;
		const channel = kind === "hotReload" ? BusChannels.ConfigHotReload : kind === "nextTurn" ? BusChannels.ConfigNextTurn : BusChannels.ConfigRestartRequired;
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
			validate(next);
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
			validate(snapshot);
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
		onChange(kind, listener) {
			listeners.get(kind)?.add(listener);
			return () => {
				listeners.get(kind)?.delete(listener);
			};
		},
	};

	return { extension, contract };
}
