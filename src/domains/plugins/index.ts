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
	installLibraryPackage,
	installPlugin,
	listInstalledPlugins,
	newlyBrokenDependents,
	observePluginCopy,
	type PluginDependentBreak,
	PluginWriterRefusal,
	pluginBaseDir,
	pluginStatePath,
	readPluginInstallRecord,
	removePlugin,
	resolvePluginPrecedence,
	updatePlugin,
	withPluginScopeLock,
} from "./state.js";
export type {
	ClioPluginConfiguration,
	ForeignPackageFormat,
	InstalledPlugin,
	LibraryPackageInstallInput,
	PackageTrust,
	PluginCandidate,
	PluginComponent,
	PluginComponentKind,
	PluginDiagnostic,
	PluginDiagnosticCode,
	PluginExpectedCopy,
	PluginExpectedState,
	PluginInstallOptions,
	PluginInstallRecord,
	PluginInstallResult,
	PluginListOptions,
	PluginManifest,
	PluginMutationOptions,
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
export { isForeignPluginOrigin } from "./types.js";
