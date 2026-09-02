export {
	discoverExtensionPackages,
	extensionManifestYaml,
	findExtensionManifestPath,
	parseExtensionManifest,
} from "./discovery.js";
export { enabledExtensionResourceRoots, extensionResourcePath, extensionSnapshotFor } from "./resources.js";
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
	ExtensionHookSource,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionManifestResources,
	ExtensionMutationResult,
	ExtensionProvenance,
	ExtensionReloadCandidate,
	ExtensionReloadCommitted,
	ExtensionReloadPrepareResult,
	ExtensionReloadRejection,
	ExtensionReloadRejectionReason,
	ExtensionReloadResult,
	ExtensionResourceKind,
	ExtensionResourceRoot,
	ExtensionScope,
	ExtensionSnapshot,
	ExtensionSnapshotDiagnostics,
	ExtensionState,
	ExtensionStateUpgradeReport,
	InstalledExtension,
	LoadableExtension,
} from "./types.js";
export { isLoadableExtension } from "./types.js";
