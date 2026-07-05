import type { MessageEntry, SessionEntry } from "../entries.js";

/**
 * Active-branch selection over a tree-shaped session entry list.
 *
 * current.jsonl is append-only: after a /tree switch to an earlier turn, new
 * turns parent onto that turn and the abandoned sibling turns stay in the
 * file. Replaying the file linearly resurrects those abandoned turns, so
 * replay surfaces filter through this helper first.
 *
 * The filter traces the leaf's ancestry across message entries and keeps:
 *   - message entries on the active path,
 *   - sidecar entries anchored to a path turn (parentTurnId or targetTurnId),
 *   - compaction summaries whose firstKeptTurnId or parent lands on the path,
 *   - unanchored sidecars (parentTurnId null), which cannot be attributed to
 *     a branch and keep their historical always-included behavior.
 *
 * When the message graph is a plain chain (no turn has two or more message
 * children) the list is returned unchanged, so linear sessions replay
 * identically to the pre-tree behavior even if an old rewrite left gaps in
 * the parent chain.
 */
export function filterEntriesToActivePath(entries: ReadonlyArray<SessionEntry>, leafTurnId?: string): SessionEntry[] {
	const messages: MessageEntry[] = [];
	const messagesById = new Map<string, MessageEntry>();
	for (const entry of entries) {
		if (entry.kind !== "message") continue;
		messages.push(entry);
		messagesById.set(entry.turnId, entry);
	}
	if (!hasBranch(messages)) return [...entries];

	// The leaf defaults to the most recent append (file order), which is the
	// turn the session would parent the next append onto after a switch.
	const leaf = resolveLeafMessage(entries, messagesById, leafTurnId) ?? messages[messages.length - 1];
	if (!leaf) return [...entries];

	const pathIds = new Set<string>();
	let current: MessageEntry | undefined = leaf;
	while (current && !pathIds.has(current.turnId)) {
		pathIds.add(current.turnId);
		if (current.parentTurnId === null) break;
		// A missing parent means an older rewrite dropped it; treat the break
		// as the root rather than failing the whole replay.
		current = messagesById.get(current.parentTurnId);
	}
	return entries.filter((entry) => entryOnActivePath(entry, pathIds));
}

/**
 * Resolve the pinned leaf id to a message entry. A sidecar id pins the
 * branch through the turn it is anchored to (targetTurnId, firstKeptTurnId,
 * or parentTurnId), so callers may pass any entry's turnId. An id that
 * resolves to nothing falls back to the caller's default leaf.
 */
function resolveLeafMessage(
	entries: ReadonlyArray<SessionEntry>,
	messagesById: ReadonlyMap<string, MessageEntry>,
	leafTurnId: string | undefined,
): MessageEntry | undefined {
	if (leafTurnId === undefined) return undefined;
	const direct = messagesById.get(leafTurnId);
	if (direct) return direct;
	const sidecar = entries.find((entry) => entry.turnId === leafTurnId);
	if (!sidecar) return undefined;
	const anchor = sidecarAnchorTurnId(sidecar);
	return anchor === null ? undefined : messagesById.get(anchor);
}

function sidecarAnchorTurnId(entry: SessionEntry): string | null {
	if (entry.kind === "label") return entry.targetTurnId;
	if (entry.kind === "sessionInfo") return entry.targetTurnId ?? entry.parentTurnId;
	if (entry.kind === "compactionSummary" && entry.firstKeptTurnId.length > 0) return entry.firstKeptTurnId;
	return entry.parentTurnId;
}

function hasBranch(messages: ReadonlyArray<MessageEntry>): boolean {
	const seenParents = new Set<string>();
	for (const message of messages) {
		if (message.parentTurnId === null) continue;
		if (seenParents.has(message.parentTurnId)) return true;
		seenParents.add(message.parentTurnId);
	}
	return false;
}

function entryOnActivePath(entry: SessionEntry, pathIds: ReadonlySet<string>): boolean {
	if (entry.kind === "message") return pathIds.has(entry.turnId);
	if (entry.kind === "label") return pathIds.has(entry.targetTurnId);
	if (entry.kind === "sessionInfo") return entry.targetTurnId === undefined || pathIds.has(entry.targetTurnId);
	if (entry.kind === "compactionSummary" && entry.firstKeptTurnId.length > 0 && pathIds.has(entry.firstKeptTurnId)) {
		return true;
	}
	return entry.parentTurnId === null || pathIds.has(entry.parentTurnId);
}
