export {
	discoverExtensionPackages,
	extensionManifestYaml,
	findExtensionManifestPath,
	parseExtensionManifest,
} from "./discovery.js";
export { enabledExtensionResourceRoots, extensionResourcePath } from "./resources.js";
export type { InstalledExtensionRecord } from "./state.js";
export {
	disableExtension,
	enableExtension,
	extensionBaseDir,
	installExtension,
	listInstalledExtensionRecords,
	listInstalledExtensions,
	removeExtension,
	upgradeLegacyExtensionInstallState,
} from "./state.js";
export type {
	ClioExtensionManifest,
	ExtensionCandidate,
	ExtensionDiagnostic,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionManifestResources,
	ExtensionMutationResult,
	ExtensionProvenance,
	ExtensionResourceKind,
	ExtensionResourceRoot,
	ExtensionScope,
	ExtensionState,
	ExtensionStateUpgradeReport,
	InstalledExtension,
	LoadableExtension,
} from "./types.js";
export { isLoadableExtension } from "./types.js";
