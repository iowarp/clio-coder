import type { DomainModule } from "../../core/domain-loader.js";
import type { PluginsContract } from "./contract.js";
import { createPluginsBundle } from "./extension.js";
import { PluginsManifest } from "./manifest.js";

export const PluginsDomainModule: DomainModule<PluginsContract> = {
	manifest: PluginsManifest,
	createExtension: createPluginsBundle,
};
export type { PluginsContract } from "./contract.js";
export {
	discoverPluginPackages,
	isPluginId,
	PLUGIN_EXTENSION_KEY,
	PLUGIN_RESOURCE_KINDS,
	PLUGIN_SCHEMA,
	parsePluginManifest,
	pluginPathContained,
	pluginResourcePath,
	readPluginManifest,
} from "./discovery.js";
export { pluginContentDigest, pluginContentDigestWithCapture } from "./integrity.js";
export {
	buildPluginSnapshot,
	clearPluginSnapshots,
	enabledPluginResourceRoots,
	pluginSnapshotFor,
	reloadPluginResources,
} from "./resources.js";
export {
	disablePlugin,
	enablePlugin,
	installPlugin,
	listInstalledPlugins,
	pluginBaseDir,
	pluginStatePath,
	readPluginInstallRecord,
	removePlugin,
	updatePlugin,
} from "./state.js";
export type {
	ClioPluginConfiguration,
	InstalledPlugin,
	PluginCandidate,
	PluginComponent,
	PluginComponentKind,
	PluginDiagnostic,
	PluginInstallOptions,
	PluginInstallRecord,
	PluginInstallResult,
	PluginListOptions,
	PluginManifest,
	PluginMutationResult,
	PluginOrigin,
	PluginProvenance,
	PluginResourceKind,
	PluginResourceRoot,
	PluginResources,
	PluginScope,
	PluginSnapshot,
	PluginState,
} from "./types.js";
