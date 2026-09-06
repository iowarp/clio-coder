/** Exact persisted tool-result recall and bounded discovery on the active path.
 * Bodies return at the tail through the caller's observation envelope; the raw
 * ledger, summary cut, and existing eviction markers remain unchanged.
 */

import { ceilChars } from "../../session/context-accounting.js";
import type { MessageEntry, SessionEntry } from "../../session/entries.js";
import { filterEntriesToActivePath } from "../../session/tree/active-path.js";
import {
	type ContextRecallFields,
	EMPTY_WORKING_SET_VIEW,
	type RecallError,
	type RecallResult,
	type RecallTrigger,
	type WorkingSetView,
} from "./contract.js";
import { parseRefKey, refKey } from "./fold.js";
import { callPathsByToolCallId } from "./path-index.js";
import {
	hasLegacyCompactionMarker,
	offloadPathOf,
	primaryPathOf,
	toolResultPayload,
	toolResultText,
} from "./payload.js";
import { compactionCut } from "./visible.js";

export type RecallOutcome = { ok: true; result: RecallResult } | { ok: false; error: RecallError };

function isThinkingEntry(entry: SessionEntry): boolean {
	return entry.kind === "message" && entry.role === "assistant";
}

function isToolResultEntry(entry: SessionEntry): entry is MessageEntry {
	return entry.kind === "message" && entry.role === "tool_result";
}

export function resolveRecall(
	entries: ReadonlyArray<SessionEntry>,
	view: WorkingSetView,
	ref: string,
	activeLeafTurnId?: string,
): RecallOutcome {
	const parsed = parseRefKey(ref);
	if (parsed === null) return { ok: false, error: { kind: "invalid_ref", ref } };
	const key = refKey(parsed);
	const active = filterEntriesToActivePath(entries, activeLeafTurnId);
	const entry = active.find((candidate) => candidate.turnId === key);
	if (entry === undefined) {
		return { ok: false, error: { kind: "not_on_active_path", ref: key } };
	}
	if (!isToolResultEntry(entry) || hasLegacyCompactionMarker(entry.payload)) {
		return { ok: false, error: { kind: "unavailable", ref: key } };
	}
	const state = view.evicted.has(key)
		? "evicted"
		: compactionCut(active).visible.some((candidate) => candidate.turnId === key)
			? "visible"
			: "summarized";
	if (state === "visible") return { ok: false, error: { kind: "visible", ref: key } };
	const payload = toolResultPayload(entry.payload);
	const body = toolResultText(payload.result);
	const offloadPath = offloadPathOf(payload);
	return {
		ok: true,
		result: {
			ref: parsed,
			state,
			entry,
			body,
			tokens: ceilChars(body.length),
			...(offloadPath !== undefined ? { offloadPath } : {}),
		},
	};
}

/**
 * The turn a `contextRecall` entry parents onto: the newest message on the
 * active path. Every recall caller needs this and they must agree, because a
 * record anchored anywhere else folds onto the wrong branch and a `/tree`
 * switch would then show a recall the branch never made.
 */
export function recallParentTurnId(entries: ReadonlyArray<SessionEntry>, activeLeafTurnId?: string): string | null {
	const active = filterEntriesToActivePath(entries, activeLeafTurnId);
	for (let i = active.length - 1; i >= 0; i -= 1) {
		const candidate = active[i];
		if (candidate?.kind === "message") return candidate.turnId;
	}
	return null;
}

export function buildRecallFields(
	result: RecallResult,
	meta: { trigger: RecallTrigger; toolCallId?: string },
): ContextRecallFields {
	return {
		kind: "contextRecall",
		ref: { entry: result.ref.entry },
		trigger: meta.trigger,
		tokensReadmitted: result.tokens,
		...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
	};
}

export interface RecallDiscoveryOptions {
	/** Case-insensitive terms matched against ref, tool name, and path. */
	query?: string;
	/** Default 8, maximum 12. */
	limit?: number;
	/** Zero-based position in matching active-path ledger order. */
	offset?: number;
	activeLeafTurnId?: string;
}

export interface RecallableRefListing {
	/** Bounded metadata rows; never result bodies or assistant thinking. */
	refs: string[];
	remaining: number;
	total: number;
	offset: number;
	nextOffset?: number;
}

/** Stable ledger-order pages for the same active path and query. */
export function recallableRefListing(
	entries: ReadonlyArray<SessionEntry>,
	view: WorkingSetView,
	options: RecallDiscoveryOptions = {},
): RecallableRefListing {
	const active = filterEntriesToActivePath(entries, options.activeLeafTurnId);
	const visible = new Set(compactionCut(active).visible.map((entry) => entry.turnId));
	const callPaths = callPathsByToolCallId(active);
	const terms = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	const limit =
		typeof options.limit === "number" && Number.isFinite(options.limit)
			? Math.max(1, Math.min(12, Math.floor(options.limit)))
			: 8;
	const offset =
		typeof options.offset === "number" && Number.isSafeInteger(options.offset) ? Math.max(0, options.offset) : 0;
	const refs: string[] = [];
	let total = 0;
	for (const entry of active) {
		if (!isToolResultEntry(entry) || hasLegacyCompactionMarker(entry.payload)) continue;
		const state = view.evicted.has(entry.turnId) ? "evicted" : visible.has(entry.turnId) ? "visible" : "summarized";
		if (state === "visible") continue;
		const payload = toolResultPayload(entry.payload);
		const toolCallId = typeof payload.obj.toolCallId === "string" ? payload.obj.toolCallId : undefined;
		const path = primaryPathOf(payload) ?? (toolCallId === undefined ? undefined : callPaths.get(toolCallId));
		const metadata = `${entry.turnId} ${payload.toolName} ${path ?? ""}`.toLowerCase();
		if (!terms.every((term) => metadata.includes(term))) continue;
		if (total >= offset && refs.length < limit) {
			// Keep each row bounded even for unusual tool/path metadata.
			const label = `${payload.toolName}${path === undefined ? "" : ` ${path}`}`.replace(/\s+/g, " ").slice(0, 240);
			refs.push(`${entry.turnId} (${label}) [${state}; ${entry.timestamp}]`);
		}
		total += 1;
	}
	const remaining = Math.max(0, total - offset - refs.length);
	return { refs, remaining, total, offset, ...(remaining > 0 ? { nextOffset: offset + refs.length } : {}) };
}

function recallableRefMessage(
	entries: ReadonlyArray<SessionEntry>,
	view: WorkingSetView,
	activeLeafTurnId?: string,
): string {
	const listing = recallableRefListing(entries, view, activeLeafTurnId === undefined ? {} : { activeLeafTurnId });
	if (listing.refs.length === 0) return "No recallable refs on the active path.";
	const more = listing.remaining > 0 ? `, and ${listing.remaining} more` : "";
	return `Recallable refs on the active path: ${listing.refs.join(", ")}${more}. Discover all matches with context(scope="recall", limit=8, offset=0), omitting ref; query filters path/tool/ref terms. Follow nextOffset.`;
}

/**
 * One-line operator/model-facing message for a recall failure. Says why an
 * assistant turn is refused instead of calling it "not evicted", and ends with
 * the refs that can be recalled. `entries` is the active path the view was
 * folded over; without it the listing is empty.
 */
export function recallErrorMessage(
	error: RecallError,
	entries: ReadonlyArray<SessionEntry> = [],
	view: WorkingSetView = EMPTY_WORKING_SET_VIEW,
	activeLeafTurnId?: string,
): string {
	const active = filterEntriesToActivePath(entries, activeLeafTurnId);
	const listing = ` ${recallableRefMessage(active, view, activeLeafTurnId)}`;
	switch (error.kind) {
		case "invalid_ref":
			return `recall ref must be a single turnId without whitespace; got '${error.ref}'.`;
		case "not_on_active_path":
			return `ref ${error.ref} is not on the active path of this session (unknown or on an abandoned branch).${listing}`;
		case "visible":
			return `ref ${error.ref} is visible; its content is already in context.${listing}`;
		case "unavailable": {
			const entry = active.find((candidate) => candidate.turnId === error.ref);
			if (entry !== undefined && isThinkingEntry(entry)) {
				return `ref ${error.ref} is an assistant turn; thinking is not recallable.${listing}`;
			}
			return `ref ${error.ref} has no recallable original tool result (unsupported entry or legacy destructive compaction).${listing}`;
		}
	}
}
