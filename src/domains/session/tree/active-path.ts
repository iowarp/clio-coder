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
 *   - unanchored sidecars (parentTurnId null) written at or before the leaf's
 *     position in the file. `fork.ts` shares this same rule (`entryBelongsToPath`
 *     below) for the same reason: an unanchored sidecar records state as of
 *     the moment it was written, and a sidecar written after the turn a
 *     reconstruction stands at was not visible then, on any branch. Before
 *     issue #94 this filter kept every unanchored sidecar regardless of
 *     position while fork applied the positional cut, so the same turn
 *     reached by /tree switch versus /fork saw two different task boards.
 *
 * A plain chain is returned unchanged unless a live caller explicitly pins an
 * earlier leaf. That preserves historical linear replay (including old parent
 * gaps) while making a backward /tree selection authoritative before the next
 * append creates a structural sibling.
 */
export function filterEntriesToActivePath(entries: ReadonlyArray<SessionEntry>, leafTurnId?: string): SessionEntry[] {
	const messages: MessageEntry[] = [];
	const messagesById = new Map<string, MessageEntry>();
	for (const entry of entries) {
		if (entry.kind !== "message") continue;
		messages.push(entry);
		messagesById.set(entry.turnId, entry);
	}
	// Without a live-session pointer, offline readers fall back to the most
	// recent message in file order. Current-session runtime paths must pass the
	// explicit leaf because switchTurn() changes the next append point without
	// appending a message to the ledger.
	const latest = messages[messages.length - 1];
	const pinnedLeaf = resolveLeafMessage(entries, messagesById, leafTurnId);
	if (!hasBranch(messages) && (pinnedLeaf === undefined || pinnedLeaf.turnId === latest?.turnId)) return [...entries];
	const leaf = pinnedLeaf ?? latest;
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
	const leafIndex = entries.findIndex((entry) => entry.kind === "message" && entry.turnId === leaf.turnId);
	return entries.filter((entry, index) => entryBelongsToPath(entry, pathIds, leafIndex >= 0 && index <= leafIndex));
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

/**
 * Shared verdict for whether a session entry belongs to a reconstruction
 * standing at the turn `pathIds` traces back to. Used by both live
 * `/tree`-switch replay (above) and `/fork` (`fork.ts`), so the two surfaces
 * agree on the one thing that was inconsistent between them: an unanchored
 * sidecar (`parentTurnId === null`, e.g. `taskLedger`, a routing notice, a
 * leafless `workerRun`) carries no turn pointer, so file position is the only
 * signal available for it. `atOrBeforeLeaf` is that positional verdict,
 * computed by the caller: was the entry written at or before the leaf's
 * position in the file. A sidecar written after the leaf's position was not
 * visible when a reconstruction standing at that leaf would have looked, on
 * any branch, so it is excluded (issue #94; before this fix, live replay kept
 * every unanchored sidecar regardless of position while fork dropped anything
 * after the fork point, so the same turn reached the two ways produced two
 * different task boards).
 *
 * `compactionSummary` is deliberately not given the same positional
 * treatment here: a compaction anchored to a turn on the path is ordinarily
 * appended after that turn's own message (compaction runs on top of a
 * finished conversation, not before it), so gating it by leaf position would
 * drop the compaction that legitimately covers the leaf itself. `fork.ts`
 * layers its own, stricter compaction gate on top of this function, because
 * a fork represents a snapshot frozen at one moment and a compaction written
 * after that moment did not exist at the fork point even when its anchor
 * turn is an ancestor. A `sessionInfo` entry with no `targetTurnId` is a
 * session-wide fact (e.g. a rename), not scoped to any branch or moment, so
 * it is always kept.
 */
export function entryBelongsToPath(
	entry: SessionEntry,
	pathIds: ReadonlySet<string>,
	atOrBeforeLeaf: boolean,
): boolean {
	if (entry.kind === "message") return pathIds.has(entry.turnId);
	if (entry.kind === "label") return pathIds.has(entry.targetTurnId);
	if (entry.kind === "sessionInfo") return entry.targetTurnId === undefined || pathIds.has(entry.targetTurnId);
	if (entry.kind === "compactionSummary" && entry.firstKeptTurnId.length > 0 && pathIds.has(entry.firstKeptTurnId)) {
		return true;
	}
	return entry.parentTurnId === null ? atOrBeforeLeaf : pathIds.has(entry.parentTurnId);
}
