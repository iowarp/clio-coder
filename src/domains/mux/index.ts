import type { DomainModule } from "../../core/domain-loader.js";
import type { MuxContract } from "./contract.js";
import { createMuxBundle, type MuxDomainOptions } from "./extension.js";
import { MuxManifest } from "./manifest.js";

/** Zero-configuration module: guest when detected, `none` otherwise. */
export const MuxDomainModule: DomainModule<MuxContract> = {
	manifest: MuxManifest,
	createExtension: (context) => createMuxBundle(context),
};

/** Parameterized module for callers that gate panes off or on explicitly. */
export function createMuxDomainModule(options: MuxDomainOptions): DomainModule<MuxContract> {
	return {
		manifest: MuxManifest,
		createExtension: (context) => createMuxBundle(context, options),
	};
}

export type {
	MuxContract,
	MuxNotifyRequest,
	MuxOpenUtilityPaneRequest,
	MuxRuntime,
	MuxRuntimeOptions,
} from "./contract.js";
export { createMuxRuntime } from "./contract.js";
export { detectMux, type MuxDetection, type MuxEnablement, resolveSocketCandidates } from "./detect.js";
export type { MuxDomainOptions } from "./extension.js";
export { MuxManifest } from "./manifest.js";
export { createPaneRegistry, type MuxPaneRegistry, paneRecord } from "./pane-registry.js";
export { MUX_METHOD_MIN_PROTOCOL, type MuxGatedMethod, muxSupportsMethod } from "./protocol.js";
export { createMuxClient, type MuxClient, type MuxClientOptions, type MuxSubscription } from "./socket-client.js";
export {
	type MuxAgentState,
	MuxError,
	type MuxErrorKind,
	type MuxEvent,
	type MuxEventKind,
	type MuxLayoutNode,
	type MuxLayoutTree,
	type MuxLog,
	type MuxMode,
	type MuxNotificationSound,
	type MuxPanePurpose,
	type MuxPaneRecord,
	type MuxPaneRef,
	type MuxRect,
	type MuxReportableAgentState,
	MuxRequestTimeout,
	type MuxSelfLocation,
	type MuxSelfReport,
	type MuxServerInfo,
	type MuxSnapshot,
	type MuxTab,
	type MuxTabGeometry,
	muxErrorKind,
} from "./types.js";
export { clioCliEntryPath, type ViewerCommandOptions, watchViewerCommand } from "./viewer-command.js";
export {
	createYaziEventStream,
	parseYaziEventLine,
	YAZI_STREAM_MAX_BYTES,
	YAZI_STREAM_POLL_MS,
	type YaziCdEvent,
	type YaziEvent,
	type YaziEventStream,
	type YaziEventStreamOptions,
	type YaziEventStreamStats,
	type YaziEventStreamStopReason,
	type YaziPickEvent,
} from "./yazi/event-stream.js";
export {
	describeYaziProfile,
	ensureYaziProfile,
	hashYaziAssetTree,
	inspectCurrentYaziProfile,
	inspectYaziProfile,
	renderYaziKeymap,
	resetYaziProfile,
	userYaziConfigDir,
	type YaziProfile,
	type YaziProfileInspection,
	type YaziProfileOptions,
	type YaziProfileStamp,
	type YaziProfileState,
	yaziProfileDir,
} from "./yazi/profile.js";
export {
	createYaziSession,
	type YaziChooserResult,
	type YaziProfileMode,
	type YaziResolvedBinaries,
	type YaziSession,
	type YaziSessionMode,
	type YaziSessionOpenResult,
	type YaziSessionOptions,
	type YaziSessionSnapshot,
} from "./yazi/session.js";
export { renderYaziTheme } from "./yazi/theme.js";
