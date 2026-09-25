export type { ToolFetcher, ToolInstallOptions, ToolInstallResult } from "./install.js";
export { installPinnedTool, installTool } from "./install.js";
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
