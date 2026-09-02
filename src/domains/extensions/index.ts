import type { DomainModule } from "../../core/domain-loader.js";
import type { ExtensionsContract } from "./contract.js";
import { createExtensionsBundle } from "./extension.js";
import { ExtensionsManifest } from "./manifest.js";

export const ExtensionsDomainModule: DomainModule<ExtensionsContract> = {
	manifest: ExtensionsManifest,
	createExtension: createExtensionsBundle,
};

export type { ExtensionsContract } from "./contract.js";
export {
	type ClioExtensionManifest,
	disableExtension,
	discoverExtensionPackages,
	type ExtensionCandidate,
	type ExtensionDiagnostic,
	type ExtensionHookSource,
	type ExtensionInstallOptions,
	type ExtensionInstallResult,
	type ExtensionListOptions,
	type ExtensionMutationResult,
	type ExtensionProvenance,
	type ExtensionReloadCandidate,
	type ExtensionReloadCommitted,
	type ExtensionReloadPrepareResult,
	type ExtensionReloadRejection,
	type ExtensionReloadRejectionReason,
	type ExtensionReloadResult,
	type ExtensionResourceKind,
	type ExtensionResourceRoot,
	type ExtensionScope,
	type ExtensionSnapshot,
	type ExtensionSnapshotDiagnostics,
	type ExtensionStateUpgradeReport,
	enabledExtensionResourceRoots,
	enableExtension,
	extensionManifestYaml,
	extensionSnapshotFor,
	type InstalledExtension,
	type InstalledExtensionRecord,
	installExtension,
	isLoadableExtension,
	type LoadableExtension,
	listInstalledExtensionRecords,
	listInstalledExtensions,
	parseExtensionManifest,
	removeExtension,
	upgradeLegacyExtensionInstallState,
} from "./manager.js";
export { ExtensionsManifest } from "./manifest.js";
export {
	buildExtensionSnapshot,
	diffExtensionSnapshots,
	EXTENSION_SNAPSHOT_DIAGNOSTIC_CAP,
	EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP,
	EXTENSION_SNAPSHOT_DIAGNOSTIC_PER_PACKAGE_CAP,
} from "./snapshot.js";
