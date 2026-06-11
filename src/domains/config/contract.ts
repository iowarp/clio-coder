import type { ClioSettings, SettingsMutator } from "../../core/config.js";
import type { ChangeKind, ConfigDiff } from "./classify.js";

/**
 * The ConfigDomain's external surface. Other domains import this through the contract
 * returned by the domain loader, never by reaching into extension.ts.
 */
export interface ConfigContract {
	get(): Readonly<ClioSettings>;
	set?(next: ClioSettings): void;
	/**
	 * Cross-process-safe read-modify-write: the mutator runs against the
	 * freshest on-disk settings while holding the advisory settings lock, so
	 * two processes patching different fields cannot drop each other's writes.
	 * Refreshes the in-memory snapshot and dispatches change events like set.
	 */
	update?(mutate: SettingsMutator): void;
	onChange(
		kind: ChangeKind,
		listener: (payload: { diff: ConfigDiff; settings: Readonly<ClioSettings> }) => void,
	): () => void;
}
