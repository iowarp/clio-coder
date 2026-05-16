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
	InstalledExtension,
} from "./types.js";
