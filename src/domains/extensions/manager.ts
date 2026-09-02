export {
	discoverExtensionPackages,
	extensionManifestYaml,
	findExtensionManifestPath,
	parseExtensionManifest,
} from "./discovery.js";
export { enabledExtensionResourceRoots, extensionResourcePath } from "./resources.js";
export {
	disableExtension,
	enableExtension,
	extensionBaseDir,
	installExtension,
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
	ExtensionResourceKind,
	ExtensionResourceRoot,
	ExtensionScope,
	ExtensionState,
	ExtensionStateUpgradeReport,
	InstalledExtension,
} from "./types.js";
