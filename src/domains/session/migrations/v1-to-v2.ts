import type { SessionMeta } from "../contract.js";

/**
 * v1→v2 session-format migration.
 *
 * v1 sessions have no `sessionFormatVersion` field on meta.json (missing is
 * treated as 1). v2 adds the field set to 2 and unlocks the rich SessionEntry
 * vocabulary for new appends; existing ClioTurnRecord lines in current.jsonl
 * stay unchanged on disk and are normalized on read by `fromLegacyTurn` in
 * entries.ts.
 *
 * This migration is intentionally schema-only for slice 12a. Later slices
 * (12c's compactionSummary, 12b's branchSummary) write new entry kinds to
 * the same current.jsonl; the file can hold a mix of legacy lines and v2
 * SessionEntry lines until the next checkpoint.
 *
 * Mutates the passed meta in place. Idempotent: calling on already-v2 meta
 * is a no-op.
 */
export function migrateV1ToV2(meta: SessionMeta): void {
	const current = meta.sessionFormatVersion ?? 1;
	if (current >= 2) return;
	meta.sessionFormatVersion = 2;
}
