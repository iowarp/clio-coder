import type { ConfigChangeSource } from "../../core/bus-events.js";
import type { ClioSettings, SettingsMutator } from "../../core/config.js";
import type { SettingsOrigin } from "../../core/settings-layers.js";
import type { ChangeKind, ConfigDiff } from "./classify.js";

/**
 * The ConfigDomain's external surface. Other domains import this through the contract
 * returned by the domain loader, never by reaching into extension.ts.
 */
export interface ConfigContract {
	get(): Readonly<ClioSettings>;
	/** Reload through the same validation and change events as a file watcher. */
	reload?(): void;
	/** Defer setup's watcher events, retaining detected session-only targets in memory. */
	holdReloads?(sessionTargets?: ReadonlyArray<ClioSettings["targets"][number]>): void;
	/** Layer that set each saved leaf of `get()`; a missing path is a built-in default. */
	sources?(): Readonly<Record<string, SettingsOrigin>>;
	/**
	 * Cross-process-safe read-modify-write: the mutator runs against the
	 * freshest on-disk settings while holding the advisory settings lock, so
	 * two processes patching different fields cannot drop each other's writes.
	 * Refreshes the in-memory snapshot and dispatches change events.
	 */
	update?(mutate: SettingsMutator, source?: ConfigChangeSource): void;
	/** Save an explicit edit to this workspace's trusted private settings layer. */
	updateProject?(mutate: SettingsMutator, source?: ConfigChangeSource): void;
	/** A change that touches several kinds reaches each with the same payload object. */
	onChange(
		kind: ChangeKind,
		listener: (payload: {
			diff: ConfigDiff;
			settings: Readonly<ClioSettings>;
			previous?: Readonly<ClioSettings>;
			source?: ConfigChangeSource;
		}) => void,
	): () => void;
	/**
	 * End a boot-time hold on watcher reloads and run the one reload a held
	 * settings write left pending. A bundle created without a hold ignores it.
	 */
	releaseReloads?(): void;
}
