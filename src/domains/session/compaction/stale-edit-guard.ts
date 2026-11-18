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
import {
	canonicalize,
	createPathIndexBuilder,
	type PathIndexBuilder,
	type PathObservation,
} from "../../context/working-set/path-index.js";
import { hasLegacyCompactionMarker, recalledRef } from "../../context/working-set/payload.js";
import { compactionCut } from "../../context/working-set/visible.js";
import type { MiddlewareEffect, MiddlewareHookRegistration } from "../../middleware/index.js";
import type { CompactionSummaryEntry, SessionEntry } from "../entries.js";
import { activePath, extendsSnapshot, findLastEntry } from "../tree/active-path.js";
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

/**
 * What the guard reads of one active path: its path index, the refs the working
 * set evicted, and what the latest compaction left in sight. A frozen path that
 * only grew since the last edit folds just the appended entries; a branch
 * switch or navigation hands over a path that does not extend the last one, and
 * the view is rebuilt.
 */
interface GuardView {
	entries: ReadonlyArray<SessionEntry>;
	cwd: string;
	paths: PathIndexBuilder;
	evicted: Set<string>;
	/** True when `evicted` folds every entry of `entries`, which then is its own active path. */
	evictedWholeSlice: boolean;
	visible: Set<string>;
	/** Visible tool results that recall a ref, with that ref. */
	recalls: Array<{ turnId: string; ref: string; legacy: boolean }>;
}

function buildGuardView(entries: ReadonlyArray<SessionEntry>, cwd: string): GuardView {
	const paths = createPathIndexBuilder({ cwd });
	paths.append(entries, 0);
	const view: GuardView = {
		entries,
		cwd,
		paths,
		evicted: new Set(),
		evictedWholeSlice: false,
		visible: new Set(),
		recalls: [],
	};
	foldEvictions(view, entries, 0);
	cutVisible(view, compactionCut(entries).visible);
	return view;
}

function extendGuardView(view: GuardView, entries: ReadonlyArray<SessionEntry>): boolean {
	const from = view.entries.length;
	if (!view.paths.append(entries, from)) return false;
	view.entries = entries;
	foldEvictions(view, entries, view.evictedWholeSlice ? from : 0);
	const suffix = entries.slice(from);
	if (suffix.some((entry) => entry.kind === "compactionSummary")) {
		view.visible.clear();
		view.recalls.length = 0;
		cutVisible(view, compactionCut(entries).visible);
	} else cutVisible(view, suffix);
	return true;
}

/** `foldWorkingSet(entries).evicted`, folding only from `from` while `entries` is its own active path. */
function foldEvictions(view: GuardView, entries: ReadonlyArray<SessionEntry>, from: number): void {
	view.evictedWholeSlice = activePath(entries) === entries;
	if (!view.evictedWholeSlice) {
		view.evicted = new Set(foldWorkingSet(entries).evicted.keys());
		return;
	}
	if (from === 0) view.evicted = new Set();
	for (let index = from; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry?.kind === "contextEviction") for (const item of entry.evicted) view.evicted.add(item.ref.entry);
	}
}

function cutVisible(view: GuardView, visible: ReadonlyArray<SessionEntry>): void {
	for (const entry of visible) {
		view.visible.add(entry.turnId);
		if (entry.kind !== "message" || entry.role !== "tool_result") continue;
		const ref = recalledRef(entry.payload);
		if (ref !== null) view.recalls.push({ turnId: entry.turnId, ref, legacy: hasLegacyCompactionMarker(entry.payload) });
	}
}

/** Why this edit must wait for a fresh look at its file, or null when it may run. */
function staleEditBlockReason(
	entries: ReadonlyArray<SessionEntry>,
	view: (cwd: string) => GuardView,
	toolName: string,
	toolArgs: unknown,
	cwd: string,
): string | null {
	const call = effectiveToolCall(toolName, toolArgs);
	if (call.toolName !== "edit") return null;
	const requested = pathArgument(call.args);
	if (requested === null) return null;
	const target = resolvePath(requested, cwd);
	const checkpoint = findLastEntry(
		entries,
		(entry): entry is CompactionSummaryEntry => entry.kind === "compactionSummary",
	);
	if (checkpoint === undefined) return null;
	let stale = false;
	recordPriorFileOperations(checkpoint.summary, (_operation, path) => {
		if (path.trim().length > 0 && resolvePath(path, cwd) === target) stale = true;
	});
	if (!stale) return null;

	const { paths, evicted, visible, recalls } = view(cwd);
	const index = paths.index;
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
	for (const recall of recalls) {
		if (!evicted.has(recall.turnId) && readsOfTarget.has(recall.ref) && !recall.legacy) return null;
	}
	return `re-read ${requested} before editing it: its content left context at the compaction of ${checkpoint.timestamp} and only a summary remains, so old_text written now comes from memory. Read the region you will change, then retry the edit.`;
}

export function createStaleEditGuardRegistration(options: StaleEditGuardOptions): MiddlewareHookRegistration {
	let cached: GuardView | null = null;
	return {
		id: STALE_EDIT_GUARD_REGISTRATION_ID,
		description: "blocks edits of files a compaction summarized until they are observed again",
		hooks: ["before_tool"],
		evidence: "path:compacted-file@tool-args",
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "before_tool" || input.toolName === undefined) return [];
			if (effectiveToolCall(input.toolName, input.toolArgs).toolName !== "edit") return [];
			const entries = options.readEntries();
			// Only a frozen path is known not to change behind the cache.
			const view = (cwd: string): GuardView => {
				if (!Object.isFrozen(entries)) return buildGuardView(entries, cwd);
				if (
					cached?.cwd === cwd &&
					(cached.entries === entries || (extendsSnapshot(cached.entries, entries) && extendGuardView(cached, entries)))
				)
					return cached;
				cached = buildGuardView(entries, cwd);
				return cached;
			};
			const reason = staleEditBlockReason(entries, view, input.toolName, input.toolArgs, options.cwd());
			return reason === null ? [] : [{ kind: "block_tool", reason, severity: "hard-block" }];
		},
	};
}
