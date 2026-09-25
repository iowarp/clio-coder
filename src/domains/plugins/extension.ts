import type { DomainBundle, DomainContext } from "../../core/domain-loader.js";
import { clearPluginSnapshots } from "./resources.js";

/**
 * The plugins domain publishes no contract: callers use the module functions
 * from `index.ts`. It stays loaded so session teardown drops the cached
 * plugin snapshots.
 */
export function createPluginsBundle(_context: DomainContext): DomainBundle {
	return {
		extension: {
			start() {},
			stop() {
				clearPluginSnapshots();
			},
		},
		contract: {},
	};
}
