import type { DomainBundle, DomainContext } from "../../core/domain-loader.js";
import type { PluginsContract } from "./contract.js";
import { discoverPluginPackages } from "./discovery.js";
import {
	clearPluginSnapshots,
	enabledPluginResourceRoots,
	pluginSnapshotFor,
	reloadPluginResources,
} from "./resources.js";
import {
	disablePlugin,
	enablePlugin,
	installPlugin,
	listInstalledPlugins,
	removePlugin,
	updatePlugin,
} from "./state.js";

export function createPluginsBundle(_context: DomainContext): DomainBundle<PluginsContract> {
	return {
		extension: {
			start() {},
			stop() {
				clearPluginSnapshots();
			},
		},
		contract: {
			list: listInstalledPlugins,
			discover: discoverPluginPackages,
			install: installPlugin,
			update: updatePlugin,
			enable: enablePlugin,
			disable: disablePlugin,
			remove: removePlugin,
			resourceRoots: enabledPluginResourceRoots,
			snapshot: pluginSnapshotFor,
			reload: reloadPluginResources,
		},
	};
}
