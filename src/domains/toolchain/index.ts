import type { DomainModule } from "../../core/domain-loader.js";
import type { ToolchainContract } from "./contract.js";
import { createToolchainBundle } from "./extension.js";
import { ToolchainManifest } from "./manifest.js";

export const ToolchainDomainModule: DomainModule<ToolchainContract> = {
	manifest: ToolchainManifest,
	createExtension: createToolchainBundle,
};

export type { ToolchainContract } from "./contract.js";
export type { ToolFetcher, ToolInstallOptions, ToolInstallResult } from "./install.js";
export { installPinnedTool, installTool } from "./install.js";
export { ToolchainManifest } from "./manifest.js";
export { toolchainRoot, toolVersionDir, vendoredBinaryPath } from "./paths.js";
export { currentToolPlatform, findPinnedTool, findPinnedToolByBinary, PINNED_TOOLS } from "./registry.js";
export type { ToolRemoveOptions, ToolRemoveResult } from "./remove.js";
export { installedToolVersions, pruneSupersededVersions, removeTool, STALE_STAGING_MS } from "./remove.js";
export {
	describeFloorRejection,
	describeResolution,
	installRemedy,
	resolveEntryBinary,
	resolveToolBinary,
	toolStatus,
	toolStatuses,
} from "./resolve.js";
export type {
	PinnedTool,
	PinnedToolDocument,
	PinnedToolDownload,
	ToolArchiveKind,
	ToolPathCandidate,
	ToolPlatform,
	ToolResolution,
	ToolSource,
	ToolStatus,
} from "./types.js";
export { compareVersions, parseVersion, resetVersionProbeCache, satisfiesMinimum } from "./version.js";
