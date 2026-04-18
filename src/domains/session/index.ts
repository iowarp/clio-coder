import type { DomainModule } from "../../core/domain-loader.js";
import { createSessionBundle } from "./extension.js";
import { SessionManifest } from "./manifest.js";

export const SessionDomainModule: DomainModule = {
	manifest: SessionManifest,
	createExtension: createSessionBundle,
};

export { SessionManifest } from "./manifest.js";
export type {
	ClioSessionMetaExtension,
	DeleteSessionOptions,
	SessionContract,
	SessionEntryInput,
	SessionMeta,
	TurnInput,
} from "./contract.js";
export {
	SESSION_ENTRY_KINDS,
	fromLegacyTurn,
	isSessionEntry,
} from "./entries.js";
export type {
	BashExecutionEntry,
	BaseSessionEntry,
	BranchSummaryEntry,
	CompactionSummaryEntry,
	CustomEntry,
	FileEntryEntry,
	MessageEntry,
	MessageRole,
	ModelChangeEntry,
	SessionEntry,
	SessionEntryKind,
	SessionInfoEntry,
	ThinkingLevelChangeEntry,
} from "./entries.js";
export { CURRENT_SESSION_FORMAT_VERSION, runMigrations } from "./migrations/index.js";
// The tree/ module is a domain-internal building block. Only the
// overlay-facing types surface here; callers that need deeper helpers import
// from the concrete submodules directly (session domain only).
export type { TreeSnapshot, TreeSnapshotNode } from "./tree/navigator.js";
