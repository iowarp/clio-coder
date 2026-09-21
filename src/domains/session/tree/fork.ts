import { readSessionFileEntries, type SessionTreeNode, sessionPaths } from "../../../engine/session.js";
import { collectSessionEntries } from "../compaction/session-entries.js";
import { HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE } from "../continuity/operator-request.js";
import type { SessionMeta } from "../contract.js";
import { isSessionHeader, type SessionEntry } from "../entries.js";
import { enrichForkMeta } from "../history.js";
import { type SessionManagerState, startSession } from "../manager.js";
import { entryBelongsToPath } from "./active-path.js";

/**
 * Single-point fork-from-parent-turn orchestration. Closes the caller's
 * prior state writer, starts a fresh session inheriting cwd/model/target
 * from the parent meta, then stamps parent pointers atomically via
 * enrichForkMeta. Returns the new SessionManagerState so the caller can
 * install it as current.
 *
 * Used by SessionContract.fork (current session) and the /fork message
 * picker overlay. Kept out of extension.ts so the bundle wiring stays thin.
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
	nodes: ReadonlyArray<SessionTreeNode>;
}

interface LinkedRecord {
	id: string;
	parentId: string | null;
	timestamp: string;
	treeKind: SessionTreeNode["kind"] | null;
	raw: SessionEntry;
}

function linkedRecordFromEntry(entry: SessionEntry): LinkedRecord {
	return {
		id: entry.turnId,
		parentId: entry.parentTurnId,
		timestamp: entry.timestamp,
		treeKind: entry.kind === "message" ? entry.role : null,
		raw: entry,
	};
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

/**
 * Fork-specific tightening of the shared `entryBelongsToPath` verdict. A fork
 * is a snapshot frozen at `parentTurnId`: a compaction summary written after
 * that point did not exist at the fork moment even when its `firstKeptTurnId`
 * names an ancestor turn, so it must not ride along just because that turn
 * happens to be on the path. Live `/tree`-switch replay does not need this
 * extra gate (see the comment on the shared function for why), which is the
 * one place fork and live replay still deliberately disagree.
 *
 * Continuity records need the same gate and for a stronger reason. They anchor
 * to a turn on the path, so the shared verdict would carry a pause, a delivery,
 * an acknowledgement or an operator recovery request written *after* the fork
 * point into a branch that stands before it. That is not just stale display: a
 * fork inheriting a later `resumed` record, or the control request behind it,
 * would inherit the evidence for a state it never reached. §8 requires ancestry
 * **and** file position for both new kinds; the reserved operator control
 * subtype is named explicitly because §3.1 puts it under the same cutoff, and
 * because it is the one `custom` record that is authority rather than display.
 */
function sessionEntryBelongsToPath(
	entry: SessionEntry,
	pathIds: ReadonlySet<string>,
	atOrBeforeForkPoint: boolean,
): boolean {
	if (atOrBeforeForkPoint) return entryBelongsToPath(entry, pathIds, atOrBeforeForkPoint);
	if (entry.kind === "compactionSummary") return false;
	if (entry.kind === "handoffTransaction" || entry.kind === "continuityCommit") return false;
	if (entry.kind === "custom" && entry.customType === HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE) return false;
	return entryBelongsToPath(entry, pathIds, atOrBeforeForkPoint);
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
	const records = readSessionFileEntries(parentCurrentPath).filter((entry) => !isSessionHeader(entry));
	const parsed = collectSessionEntries(records, parentCurrentPath);
	const linked = parsed.map(linkedRecordFromEntry);
	const path = traceAncestry(linked, leafTurnId);
	const pathIds = new Set(path.map((record) => record.id));
	const forkPointIndex = parsed.findIndex((entry) => linkedRecordFromEntry(entry).id === leafTurnId);
	const entries = parsed.filter((entry, index) =>
		sessionEntryBelongsToPath(entry, pathIds, forkPointIndex >= 0 && index <= forkPointIndex),
	);
	return {
		parentCurrentPath,
		entries,
		tree: treeFromLinearPath(path),
	};
}

/**
 * Fork the given state into a new session. Closes the prior writer once the
 * child session is known good, so the on-disk endedAt marker on the parent is
 * never written for a fork that failed; the caller is responsible for
 * replacing its own state pointer with `result.next`.
 */
export function forkFromState(input: ForkInput): ForkResult {
	const parentMeta = input.from.meta;
	// Appends are already synchronous writes (writeSync in the engine writer),
	// so the read below already sees everything appended in this process
	// without closing first; flushAppends only fsyncs for durability. Reading
	// (and traceAncestry inside branchEntriesFromParent, which throws on an
	// unknown or broken parent chain) happens before the parent writer is
	// touched, so a broken fork point leaves the parent open and un-ended
	// instead of orphaning the caller (issue #93).
	input.from.writer.flushAppends();
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
	// Only now is the child known good: created, seeded, and stamped with its
	// parent pointers. Close (and stamp endedAt on) the parent last.
	void input.from.writer.close();
	return { next, parentMeta, nodes: branch.tree };
}
