import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	atomicWrite,
	openSession,
	readSessionFileEntries,
	type SessionTreeNode,
	sessionPaths,
	writeJsonlFileAtomic,
} from "../../../engine/session.js";
import { isSessionEntry, type SessionEntry, type SessionInfoEntry } from "../entries.js";

/**
 * Domain-level tree-file helpers. Operates directly on the on-disk artifacts
 * the engine writer owns (`tree.json`, `current.jsonl`, `meta.json`) for the
 * non-current session cases that the higher-level SessionContract methods
 * need: /tree rendering for arbitrary sessions, editLabel on another session,
 * deleteSession tombstoning.
 *
 * For the *current* session, writes flow through `SessionManagerState.writer`
 * (via manager.appendEntry / checkpoint). This module only handles the
 * off-loaded paths.
 */

export interface ResolvedLabel {
	label: string;
	timestamp: string;
}

export interface SessionTreeFileBundle {
	sessionId: string;
	nodes: SessionTreeNode[];
	labels: Map<string, ResolvedLabel>;
}

/**
 * Load the `tree.json` for an arbitrary session plus the resolved labels.
 * Uses the engine reader (openSession) so we do not re-implement its
 * session-directory lookup.
 */
export function readTreeBundle(sessionId: string): SessionTreeFileBundle {
	const reader = openSession(sessionId);
	const nodes = [...reader.tree()];
	const labels = resolveLabelMap(readRichEntries(sessionId));
	return { sessionId, nodes, labels };
}

/**
 * Read only the rich SessionEntry records from `current.jsonl`. Legacy
 * ClioTurnRecord lines are skipped (they contribute tree data via tree.json
 * already; labels only live on SessionEntry lines).
 */
function readRichEntries(sessionId: string): SessionEntry[] {
	const meta = openSession(sessionId).meta();
	const paths = sessionPaths(meta);
	if (!existsSync(paths.current)) return [];
	const out: SessionEntry[] = [];
	for (const parsed of readSessionFileEntries(paths.current)) {
		if (isSessionEntry(parsed)) out.push(parsed);
	}
	return out;
}

/**
 * Scan rich entries for SessionInfoEntry label markers. Last-wins by
 * timestamp (ISO8601 strings sort lexicographically for same-format inputs).
 * Empty-string label acts as a tombstone: it is stored with its timestamp
 * so that subsequent older-timestamp label sets do not resurrect the label.
 * Consumers treat `label === ""` as "no label".
 *
 * Exported for unit tests via the manager module path. Intentionally kept
 * off the domain index barrel.
 */
export function resolveLabelMap(entries: ReadonlyArray<SessionEntry>): Map<string, ResolvedLabel> {
	const out = new Map<string, ResolvedLabel>();
	for (const entry of entries) {
		const info = labelFields(entry);
		if (!info) continue;
		const existing = out.get(info.targetTurnId);
		if (existing && existing.timestamp > info.timestamp) continue;
		if (info.label === undefined || info.label === "") {
			out.set(info.targetTurnId, { label: "", timestamp: info.timestamp });
			continue;
		}
		out.set(info.targetTurnId, { label: info.label, timestamp: info.timestamp });
	}
	return out;
}

function labelFields(entry: SessionEntry): { targetTurnId: string; timestamp: string; label?: string } | null {
	if (entry.kind === "label") return entry;
	if (entry.kind !== "sessionInfo") return null;
	const info = entry as SessionInfoEntry;
	if (!info.targetTurnId) return null;
	const out: { targetTurnId: string; timestamp: string; label?: string } = {
		targetTurnId: info.targetTurnId,
		timestamp: info.timestamp,
	};
	if (info.label !== undefined) out.label = info.label;
	return out;
}

/**
 * Append a single SessionEntry line to an arbitrary session's
 * `current.jsonl`. Uses appendFileSync + fsync for atomicity of the single
 * line. Intended for the not-current session case in editLabel; the
 * current-session case goes through the engine writer.
 */
export function appendEntryToSessionFile(sessionId: string, entry: SessionEntry): void {
	const meta = openSession(sessionId).meta();
	const paths = sessionPaths(meta);
	const entries = readSessionFileEntries(paths.current);
	writeJsonlFileAtomic(paths.current, [...entries, entry]);
}

/**
 * Atomically rewrite a session's tree.json on disk. Engine writer persists
 * tree.json through its own path when the session is current; this helper
 * supports manual rewrites (e.g. after a deleteSession tombstone check).
 */
export function writeTreeFile(sessionId: string, nodes: ReadonlyArray<SessionTreeNode>): void {
	const meta = openSession(sessionId).meta();
	const paths = sessionPaths(meta);
	atomicWrite(paths.tree, JSON.stringify(nodes, null, 2));
}

/**
 * Destructively remove the entire session directory (current.jsonl,
 * tree.json, meta.json, plus any sidecars the engine adds in future).
 * Used by deleteSession when `keepFiles` is not requested.
 */
export function removeSessionDirectory(sessionId: string): void {
	const meta = openSession(sessionId).meta();
	const paths = sessionPaths(meta);
	const dir = dirname(paths.meta);
	rmSync(dir, { recursive: true, force: true });
}

/**
 * Tombstone variant: rename `meta.json` to `meta.deleted.json` so
 * `listSessionsForCwd` (which filters on existence of meta.json) drops
 * the session from history without touching the transcript files.
 * Resume can still target the session id directly via manual recovery.
 */
export function tombstoneSession(sessionId: string): void {
	const meta = openSession(sessionId).meta();
	const paths = sessionPaths(meta);
	if (!existsSync(paths.meta)) return;
	const tombstone = join(dirname(paths.meta), "meta.deleted.json");
	renameSync(paths.meta, tombstone);
}
