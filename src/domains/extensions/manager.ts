export {
	discoverExtensionPackages,
	extensionManifestYaml,
	findExtensionManifestPath,
	parseExtensionManifest,
} from "./discovery.js";
export { extensionSnapshotFor } from "./snapshot-access.js";
export type { InstalledExtensionRecord } from "./state.js";
export {
	disableExtension,
	enableExtension,
	extensionBaseDir,
	installExtension,
	listInstalledExtensionRecords,
	listInstalledExtensions,
	removeExtension,
} from "./state.js";
export type {
	ClioExtensionManifest,
	ExtensionCandidate,
	ExtensionDiagnostic,
	ExtensionHookSource,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionMutationResult,
	ExtensionProvenance,
	ExtensionReloadCandidate,
	ExtensionReloadCommitted,
	ExtensionReloadPrepareResult,
	ExtensionReloadRejection,
	ExtensionReloadRejectionReason,
	ExtensionReloadResult,
	ExtensionScope,
	ExtensionSnapshot,
	ExtensionSnapshotDiagnostics,
	ExtensionState,
	InstalledExtension,
	LoadableExtension,
} from "./types.js";
export { isLoadableExtension } from "./types.js";
