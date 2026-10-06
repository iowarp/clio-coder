import type { DomainModule } from "../../core/domain-loader.js";
import type { ExtensionsContract } from "./contract.js";
import { createExtensionsBundle } from "./extension.js";
import { ExtensionsManifest } from "./manifest.js";

export const ExtensionsDomainModule: DomainModule<ExtensionsContract> = {
	manifest: ExtensionsManifest,
	createExtension: createExtensionsBundle,
};

export type { ExtensionsContract } from "./contract.js";
export { loadManifestFromRoot } from "./discovery.js";
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
	type ExtensionScope,
	type ExtensionSnapshot,
	type ExtensionSnapshotDiagnostics,
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
} from "./manager.js";
export { ExtensionsManifest } from "./manifest.js";
export type { ExtensionHookDeclaration } from "./manifest-v2.js";
export type { ExtensionHookOutcome } from "./operator-runtime-v2.js";
export type { ExtensionContentAccess, ExtensionEffect, ExtensionHookEvent } from "./public-api-v2.js";
export {
	createExtensionRuntimeHookBridge,
	type ExtensionRuntimeHookBridge,
	type ExtensionRuntimeHookExecutor,
} from "./runtime-hook-bridge.js";
export { capabilityEnvelope, envelopeDigest } from "./runtime-schema-v2.js";
export {
	buildExtensionSnapshot,
	diffExtensionSnapshots,
	EXTENSION_SNAPSHOT_DIAGNOSTIC_CAP,
	EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP,
	EXTENSION_SNAPSHOT_DIAGNOSTIC_PER_PACKAGE_CAP,
} from "./snapshot.js";

export { extensionBaseDir, readExtensionInstallRecord } from "./state.js";
export type { ExtensionCapabilities, ExtensionCommandTool } from "./types.js";
