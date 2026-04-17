import type { ClioSettings } from "../../core/config.js";
import type { ChangeKind, ConfigDiff } from "./classify.js";

/**
 * The ConfigDomain's external surface. Other domains import this through the contract
 * returned by the domain loader — never by reaching into extension.ts.
 */
export interface ConfigContract {
	get(): Readonly<ClioSettings>;
	onChange(
		kind: ChangeKind,
		listener: (payload: { diff: ConfigDiff; settings: Readonly<ClioSettings> }) => void,
	): () => void;
}
