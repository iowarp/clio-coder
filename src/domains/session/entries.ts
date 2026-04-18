/**
 * Rich session entry union (Phase 12 slice 12a).
 *
 * Entries are the v2 persistence vocabulary for session events. Each entry
 * carries its `kind` discriminant, a `turnId` (uuid v7 where possible so
 * entries sort by creation), a parent pointer, and an ISO timestamp.
 *
 * Later slices extend this union:
 *   - compactionSummary is produced by compaction/compact.ts (slice 12c).
 *   - branchSummary is produced by the fork path (slice 12b).
 *   - bashExecution / fileEntry become the wire shape for Phase 14 extensions.
 *
 * Legacy v1 ClioTurnRecord lines in current.jsonl are normalized into
 * MessageEntry instances via `fromLegacyTurn` so callers see a uniform
 * SessionEntry[] surface regardless of session format version.
 */

import type { ClioTurnRecord } from "../../engine/session.js";

export interface BaseSessionEntry {
	kind: string;
	turnId: string;
	parentTurnId: string | null;
	timestamp: string;
}

export type MessageRole = ClioTurnRecord["kind"];

export interface MessageEntry extends BaseSessionEntry {
	kind: "message";
	role: MessageRole;
	payload: unknown;
	dynamicInputs?: unknown;
	renderedPromptHash?: string;
}

export interface BashExecutionEntry extends BaseSessionEntry {
	kind: "bashExecution";
	command: string;
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
}

export interface CustomEntry<T = unknown> extends BaseSessionEntry {
	kind: "custom";
	customType: string;
	data?: T;
	display?: boolean;
}

export interface ModelChangeEntry extends BaseSessionEntry {
	kind: "modelChange";
	provider: string;
	modelId: string;
	endpoint?: string;
}

export interface ThinkingLevelChangeEntry extends BaseSessionEntry {
	kind: "thinkingLevelChange";
	thinkingLevel: string;
}

export interface FileEntryEntry extends BaseSessionEntry {
	kind: "fileEntry";
	path: string;
	operation: "read" | "write" | "edit" | "create" | "delete";
	bytes?: number;
	hash?: string;
}

export interface BranchSummaryEntry extends BaseSessionEntry {
	kind: "branchSummary";
	fromTurnId: string;
	summary: string;
}

export interface CompactionSummaryEntry extends BaseSessionEntry {
	kind: "compactionSummary";
	summary: string;
	tokensBefore: number;
	firstKeptTurnId: string;
}

export interface SessionInfoEntry extends BaseSessionEntry {
	kind: "sessionInfo";
	/** Optional human-readable session name. */
	name?: string;
	/**
	 * When present, this entry labels an earlier turn. Readers scan
	 * `sessionInfo` entries whose `targetTurnId` matches a turn id; the
	 * last-wins `label` becomes that turn's display label in /tree.
	 * Empty string clears the label.
	 */
	targetTurnId?: string;
	label?: string;
}

export type SessionEntry =
	| MessageEntry
	| BashExecutionEntry
	| CustomEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry
	| FileEntryEntry
	| BranchSummaryEntry
	| CompactionSummaryEntry
	| SessionInfoEntry;

/**
 * Canonical list of entry kinds. Exposed so consumers that switch on
 * `entry.kind` can assert exhaustive coverage in tests; keeping the list
 * here (rather than inline) is how a new kind in a later slice picks up
 * every reader at once.
 */
export const SESSION_ENTRY_KINDS = [
	"message",
	"bashExecution",
	"custom",
	"modelChange",
	"thinkingLevelChange",
	"fileEntry",
	"branchSummary",
	"compactionSummary",
	"sessionInfo",
] as const;

export type SessionEntryKind = (typeof SESSION_ENTRY_KINDS)[number];

/**
 * Structural guard: true when `value` has a `turnId` string and a `kind`
 * that matches the SessionEntry union. Legacy ClioTurnRecord records use
 * `id`/`at` and fail this check, so reader code can dispatch via:
 *   if (isSessionEntry(raw)) { ...rich... } else { ...legacy... }
 */
export function isSessionEntry(value: unknown): value is SessionEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.turnId !== "string") return false;
	if (typeof v.kind !== "string") return false;
	return (SESSION_ENTRY_KINDS as readonly string[]).includes(v.kind);
}

/**
 * Normalize a legacy ClioTurnRecord into a MessageEntry. Used by the
 * session domain on read to present a uniform entries[] view of pre-v2
 * sessions; pre-existing on-disk lines are untouched until the next
 * checkpoint rewrites them.
 */
export function fromLegacyTurn(record: ClioTurnRecord): MessageEntry {
	const entry: MessageEntry = {
		kind: "message",
		turnId: record.id,
		parentTurnId: record.parentId,
		timestamp: record.at,
		role: record.kind,
		payload: record.payload,
	};
	if (record.dynamicInputs !== undefined) entry.dynamicInputs = record.dynamicInputs;
	if (record.renderedPromptHash !== undefined) entry.renderedPromptHash = record.renderedPromptHash;
	return entry;
}
