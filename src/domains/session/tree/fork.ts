import {
	type ClioTurnRecord,
	readSessionFileEntries,
	type SessionTreeNode,
	sessionPaths,
} from "../../../engine/session.js";
import type { SessionMeta } from "../contract.js";
import { isSessionEntry, isSessionHeader, type SessionEntry } from "../entries.js";
import { enrichForkMeta } from "../history.js";
import { type SessionManagerState, startSession } from "../manager.js";

/**
 * Single-point fork-from-parent-turn orchestration. Closes the caller's
 * prior state writer, starts a fresh session inheriting cwd/model/target
 * from the parent meta, then stamps parent pointers atomically via
 * enrichForkMeta. Returns the new SessionManagerState so the caller can
 * install it as current.
 *
 * Used by SessionContract.fork (current session) and the /fork message
 * picker path that lands in slice 12b-3. Kept out of extension.ts so the
 * bundle wiring stays thin.
 */
export interface ForkInput {
	/** The state we are forking from. Must carry a live writer. */
	from: SessionManagerState;
	/** Id of the parent turn (pinned via /fork message-picker). */
	parentTurnId: string;
	/** Optional cwd override; defaults to the parent session's cwd. */
	cwd?: string;
}

export interface ForkResult {
	next: SessionManagerState;
	parentMeta: SessionMeta;
}

interface LinkedRecord {
	id: string;
	parentId: string | null;
	timestamp: string;
	treeKind: SessionTreeNode["kind"] | null;
	raw: unknown;
}

const LEGACY_TURN_KINDS: readonly ClioTurnRecord["kind"][] = [
	"user",
	"assistant",
	"tool_call",
	"tool_result",
	"system",
	"checkpoint",
];

function isLegacyTurnKind(value: unknown): value is ClioTurnRecord["kind"] {
	return typeof value === "string" && (LEGACY_TURN_KINDS as readonly string[]).includes(value);
}

function isLegacyTurnRecord(value: unknown): value is ClioTurnRecord {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		(v.parentId === null || typeof v.parentId === "string") &&
		typeof v.at === "string" &&
		isLegacyTurnKind(v.kind) &&
		Object.hasOwn(v, "payload")
	);
}

function linkedRecordFromEntry(entry: unknown): LinkedRecord | null {
	if (isSessionHeader(entry)) return null;
	if (isSessionEntry(entry)) {
		return {
			id: entry.turnId,
			parentId: entry.parentTurnId,
			timestamp: entry.timestamp,
			treeKind: entry.kind === "message" ? entry.role : null,
			raw: entry,
		};
	}
	if (isLegacyTurnRecord(entry)) {
		return {
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.at,
			treeKind: entry.kind,
			raw: entry,
		};
	}
	return null;
}

function traceAncestry(records: ReadonlyArray<LinkedRecord>, leafTurnId: string): LinkedRecord[] {
	const byId = new Map<string, LinkedRecord>();
	for (const record of records) byId.set(record.id, record);
	const path: LinkedRecord[] = [];
	let current = byId.get(leafTurnId);
	if (!current) throw new Error(`session.fork: parent turn not found: ${leafTurnId}`);
	const seen = new Set<string>();
	while (current) {
		if (seen.has(current.id)) throw new Error(`session.fork: cycle in parent chain at ${current.id}`);
		seen.add(current.id);
		path.unshift(current);
		if (current.parentId === null) break;
		const next = byId.get(current.parentId);
		if (!next) throw new Error(`session.fork: broken parent chain at ${current.id}`);
		current = next;
	}
	return path;
}

function treeFromLinearPath(path: ReadonlyArray<LinkedRecord>): SessionTreeNode[] {
	return path
		.filter((record): record is LinkedRecord & { treeKind: SessionTreeNode["kind"] } => record.treeKind !== null)
		.map((record) => ({
			id: record.id,
			parentId: record.parentId,
			at: record.timestamp,
			kind: record.treeKind,
		}));
}

function sessionEntryBelongsToPath(entry: SessionEntry, pathIds: ReadonlySet<string>): boolean {
	if (entry.kind === "message") return pathIds.has(entry.turnId);
	if (entry.kind === "label") return pathIds.has(entry.targetTurnId);
	if (entry.kind === "sessionInfo") return entry.targetTurnId ? pathIds.has(entry.targetTurnId) : false;
	if (entry.kind === "compactionSummary") {
		return (
			(entry.firstKeptTurnId.length > 0 && pathIds.has(entry.firstKeptTurnId)) ||
			entry.parentTurnId === null ||
			pathIds.has(entry.parentTurnId)
		);
	}
	return entry.parentTurnId === null || pathIds.has(entry.parentTurnId);
}

function entryBelongsToPath(entry: unknown, pathIds: ReadonlySet<string>): boolean {
	if (isSessionEntry(entry)) return sessionEntryBelongsToPath(entry, pathIds);
	const linked = linkedRecordFromEntry(entry);
	return linked !== null && pathIds.has(linked.id);
}

function branchEntriesFromParent(
	parentMeta: SessionMeta,
	leafTurnId: string,
): {
	parentCurrentPath: string;
	entries: unknown[];
	tree: SessionTreeNode[];
} {
	const parentCurrentPath = sessionPaths(parentMeta).current;
	const parsed = readSessionFileEntries(parentCurrentPath);
	const linked = parsed.map(linkedRecordFromEntry).filter((entry): entry is LinkedRecord => entry !== null);
	const path = traceAncestry(linked, leafTurnId);
	const pathIds = new Set(path.map((record) => record.id));
	const entries = parsed.filter((entry) => {
		if (isSessionHeader(entry)) return false;
		return entryBelongsToPath(entry, pathIds);
	});
	return {
		parentCurrentPath,
		entries,
		tree: treeFromLinearPath(path),
	};
}

/**
 * Fork the given state into a new session. Closes the prior writer
 * best-effort so the on-disk endedAt marker is written; the caller is
 * responsible for replacing its own state pointer with `result.next`.
 */
export function forkFromState(input: ForkInput): ForkResult {
	const parentMeta = input.from.meta;
	// close() only performs synchronous filesystem work before resolving, so
	// the following read sees a fully flushed parent transcript.
	void input.from.writer.close();
	const branch = branchEntriesFromParent(parentMeta, input.parentTurnId);

	const cwd = input.cwd ?? parentMeta.cwd;
	const next = startSession({
		cwd,
		model: parentMeta.model,
		target: parentMeta.target,
		initialEntries: branch.entries,
		initialTree: branch.tree,
		parentSession: branch.parentCurrentPath,
		parentTurnId: input.parentTurnId,
	});
	enrichForkMeta(next.meta, parentMeta.id, input.parentTurnId);
	return { next, parentMeta };
}
