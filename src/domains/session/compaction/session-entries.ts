/**
 * Unified session-entry reader shared by the `/compact` handler in
 * `entry/orchestrator.ts` and the chat-loop's `readSessionEntries` hook.
 *
 * current.jsonl is heterogeneous: legacy v1 ClioTurnRecord lines coexist with
 * v2 SessionEntry kinds (compactionSummary, branchSummary, bashExecution,
 * modelChange, ...). Slice 12c's reader only kept records matching the
 * `id + at + kind` legacy shape and silently discarded everything else. Once
 * a compactionSummary landed in current.jsonl, that reader dropped it on the
 * next pass so `calculateContextTokens` saw the pre-compaction transcript
 * and auto-compaction re-fired every turn.
 *
 * `collectSessionEntries` dispatches on shape: v2 entries pass through, legacy
 * turns normalize via `fromLegacyTurn`, everything else is defensively
 * dropped. Unknown lines are rare in practice (only a write from a future
 * schema a rollback downgraded), but the reader logs them through the
 * process-level stderr tracer so they are not completely invisible.
 */

import type { ClioTurnRecord } from "../../../engine/session.js";
import { type SessionEntry, fromLegacyTurn, isSessionEntry } from "../entries.js";

function hasLegacyTurnShape(value: unknown): value is ClioTurnRecord {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && typeof v.at === "string" && typeof v.kind === "string";
}

export function collectSessionEntries(turns: ReadonlyArray<unknown>): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (const raw of turns) {
		if (isSessionEntry(raw)) {
			out.push(raw);
			continue;
		}
		if (hasLegacyTurnShape(raw)) {
			out.push(fromLegacyTurn(raw));
			continue;
		}
		// Unknown shape. Dropping is defensive; a trace here lets diag
		// scripts notice when a new entry kind lands without a reader
		// update, without breaking normal runs.
		if (process.env.CLIO_BUS_TRACE === "1") {
			process.stderr.write(`[clio:session-entries] dropped unknown line: ${JSON.stringify(raw).slice(0, 120)}\n`);
		}
	}
	return out;
}
