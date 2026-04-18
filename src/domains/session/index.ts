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
