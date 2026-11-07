/**
 * Stale-file edit guard, packaged as a middleware hook registration.
 *
 * After a compaction the model holds a summary of a file, not its text, yet it
 * tends to edit straight from memory: a live run's first edit after the cut
 * quoted text the file never contained, and another matched the wrong one of
 * two identical lines. This guard refuses an `edit` of a file the latest
 * checkpoint names in its exact-facts block until the file has been observed
 * again in what the model can still see: a read, grep, write or edit of it, a
 * shell command naming it, or a recall of an earlier read. An observation the
 * working set has since evicted or masked does not count, since its text is
 * gone too. Files the model never saw before the cut are not judged here.
 */

import { expandPath } from "../../../tools/path-utils.js";
import { effectiveToolCall } from "../../../tools/surface.js";
import { foldWorkingSet } from "../../context/working-set/fold.js";
import { buildPathIndex, canonicalize, type PathObservation } from "../../context/working-set/path-index.js";
import { hasLegacyCompactionMarker, recalledRef } from "../../context/working-set/payload.js";
import { compactionCut } from "../../context/working-set/visible.js";
import type { MiddlewareEffect, MiddlewareHookRegistration } from "../../middleware/index.js";
import type { SessionEntry } from "../entries.js";
import { recordPriorFileOperations } from "./exact-facts.js";

export const STALE_EDIT_GUARD_REGISTRATION_ID = "guard.stale-file-edit";

export interface StaleEditGuardOptions {
	/** The current session's active-path entries, in ledger order. */
	readEntries: () => ReadonlyArray<SessionEntry>;
	/** Directory relative tool paths resolve against. */
	cwd: () => string;
}

const FRESH_OPS = new Set<PathObservation["op"]>(["read", "grep", "write", "edit"]);

function pathArgument(args: unknown): string | null {
	if (typeof args !== "object" || args === null) return null;
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return null;
}

function resolvePath(path: string, cwd: string): string {
	return canonicalize(expandPath(path), cwd);
}

/** Why this edit must wait for a fresh look at its file, or null when it may run. */
export function staleEditBlockReason(
	entries: ReadonlyArray<SessionEntry>,
	toolName: string,
	toolArgs: unknown,
	cwd: string,
): string | null {
	const call = effectiveToolCall(toolName, toolArgs);
	if (call.toolName !== "edit") return null;
	const requested = pathArgument(call.args);
	if (requested === null) return null;
	const target = resolvePath(requested, cwd);
	const cut = compactionCut(entries);
	const checkpoint = entries[cut.compactionIndex];
	if (checkpoint?.kind !== "compactionSummary") return null;
	let stale = false;
	recordPriorFileOperations(checkpoint.summary, (_operation, path) => {
		if (path.trim().length > 0 && resolvePath(path, cwd) === target) stale = true;
	});
	if (!stale) return null;

	const visible = new Set(cut.visible.map((entry) => entry.turnId));
	const index = buildPathIndex(entries, { cwd });
	const evicted = foldWorkingSet(entries).evicted;
	const inSight = (observation: PathObservation): boolean => {
		if (observation.isError || observation.isBlocked) return false;
		if (!visible.has(observation.ref.entry) || evicted.has(observation.ref.entry)) return false;
		const entry = entries[observation.entryIndex];
		return !(entry?.kind === "message" && hasLegacyCompactionMarker(entry.payload));
	};
	for (const observation of index.byPath.get(target) ?? []) {
		if (FRESH_OPS.has(observation.op) && inSight(observation)) return null;
	}
	const named = [requested, target];
	for (const observation of index.observations) {
		if (observation.op === "bash" && inSight(observation) && named.some((path) => observation.argsKey.includes(path)))
			return null;
	}
	// A recall readmits an earlier read at the tail, though the original stays evicted.
	const readsOfTarget = new Set(
		(index.byPath.get(target) ?? []).filter((item) => item.op === "read" && !item.isError).map((item) => item.ref.entry),
	);
	for (const entry of cut.visible) {
		if (entry.kind !== "message" || entry.role !== "tool_result" || evicted.has(entry.turnId)) continue;
		const ref = recalledRef(entry.payload);
		if (ref !== null && readsOfTarget.has(ref) && !hasLegacyCompactionMarker(entry.payload)) return null;
	}
	return `re-read ${requested} before editing it: its content left context at the compaction of ${checkpoint.timestamp} and only a summary remains, so old_text written now comes from memory. Read the region you will change, then retry the edit.`;
}

export function createStaleEditGuardRegistration(options: StaleEditGuardOptions): MiddlewareHookRegistration {
	return {
		id: STALE_EDIT_GUARD_REGISTRATION_ID,
		description: "blocks edits of files a compaction summarized until they are observed again",
		hooks: ["before_tool"],
		evidence: "path:compacted-file@tool-args",
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "before_tool" || input.toolName === undefined) return [];
			if (effectiveToolCall(input.toolName, input.toolArgs).toolName !== "edit") return [];
			const reason = staleEditBlockReason(options.readEntries(), input.toolName, input.toolArgs, options.cwd());
			return reason === null ? [] : [{ kind: "block_tool", reason, severity: "hard-block" }];
		},
	};
}
