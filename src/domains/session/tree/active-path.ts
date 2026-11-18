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
	// An unfrozen input always yields a fresh array the caller may own.
	if (!Object.isFrozen(entries)) return computeActivePath(entries, leafTurnId).path as SessionEntry[];
	return [...cachedActivePath(entries, leafTurnId).path];
}

/**
 * `filterEntriesToActivePath` without the copy: a frozen array shared by every
 * caller that asks for the same leaf of the same frozen ledger snapshot. A
 * snapshot that only appended to one already seen folds just the appended
 * entries, so a long session's per-tool-call readers stop re-deriving the path
 * from entry 0. A linear session gets the snapshot itself back. The cache
 * trusts a frozen array's entries not to change, as the ledger index's
 * deep-frozen snapshots guarantee.
 */
export function activePath(entries: ReadonlyArray<SessionEntry>, leafTurnId?: string): ReadonlyArray<SessionEntry> {
	if (!Object.isFrozen(entries)) return Object.freeze([...computeActivePath(entries, leafTurnId).path]);
	return cachedActivePath(entries, leafTurnId).path;
}

/** The last item matching `predicate`, scanning backward without copying. */
export function findLastEntry<T, S extends T>(
	items: ReadonlyArray<T>,
	predicate: (item: T) => item is S,
): S | undefined;
export function findLastEntry<T>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): T | undefined;
export function findLastEntry<T>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): T | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index] as T;
		if (predicate(item)) return item;
	}
	return undefined;
}

/**
 * Everything one path computation learned about its snapshot. The maps grow in
 * place when a later snapshot extends this one, so a state that has been
 * extended leaves the cache: its maps describe the longer snapshot.
 */
interface ActivePathState {
	entries: ReadonlyArray<SessionEntry>;
	leafTurnId: string | undefined;
	path: ReadonlyArray<SessionEntry>;
	messagesById: Map<string, MessageEntry>;
	seenParents: Set<string>;
	/** Every turn id some entry names as parent, target or first kept turn. */
	anchors: Set<string>;
	branched: boolean;
	latest: MessageEntry | undefined;
	/** Null when the path is the whole snapshot. */
	pathIds: Set<string> | null;
	leaf: MessageEntry | undefined;
	leafIndex: number;
	/** How many path entries sit at or before `leafIndex`. */
	prefixCount: number;
}

const ACTIVE_PATH_CACHE_SIZE = 8;
const activePathCache: ActivePathState[] = [];

function cachedActivePath(entries: ReadonlyArray<SessionEntry>, leafTurnId: string | undefined): ActivePathState {
	for (let index = 0; index < activePathCache.length; index += 1) {
		const state = activePathCache[index] as ActivePathState;
		if (state.entries !== entries || state.leafTurnId !== leafTurnId) continue;
		if (index > 0) {
			activePathCache.splice(index, 1);
			activePathCache.unshift(state);
		}
		return state;
	}
	for (let index = 0; index < activePathCache.length; index += 1) {
		const prior = activePathCache[index] as ActivePathState;
		if (!extendsSnapshot(prior.entries, entries)) continue;
		const next = extendActivePath(prior, entries, leafTurnId);
		if (next === null) continue;
		activePathCache.splice(index, 1);
		activePathCache.unshift(next);
		return next;
	}
	const state = computeActivePath(entries, leafTurnId);
	if (state.path !== entries) state.path = Object.freeze(state.path as SessionEntry[]);
	activePathCache.unshift(state);
	if (activePathCache.length > ACTIVE_PATH_CACHE_SIZE) activePathCache.length = ACTIVE_PATH_CACHE_SIZE;
	return state;
}

/** True when `next` holds every entry of `prior`, the same objects in the same slots, and more. */
export function extendsSnapshot(prior: ReadonlyArray<SessionEntry>, next: ReadonlyArray<SessionEntry>): boolean {
	if (next.length <= prior.length || prior.length === 0) return false;
	if (next[prior.length - 1] !== prior[prior.length - 1]) return false;
	for (let index = 0; index < prior.length; index += 1) if (next[index] !== prior[index]) return false;
	return true;
}

function noteAnchors(entry: SessionEntry, anchors: Set<string>): void {
	if (entry.parentTurnId !== null) anchors.add(entry.parentTurnId);
	if (entry.kind === "label") anchors.add(entry.targetTurnId);
	if (entry.kind === "sessionInfo" && entry.targetTurnId !== undefined) anchors.add(entry.targetTurnId);
	if (entry.kind === "compactionSummary" && entry.firstKeptTurnId.length > 0) anchors.add(entry.firstKeptTurnId);
}

/**
 * The tree filter itself. On the plain-chain branch a frozen input comes back
 * as the same array; every other result is a fresh array.
 */
function computeActivePath(entries: ReadonlyArray<SessionEntry>, leafTurnId: string | undefined): ActivePathState {
	const messagesById = new Map<string, MessageEntry>();
	const seenParents = new Set<string>();
	const anchors = new Set<string>();
	let branched = false;
	let latest: MessageEntry | undefined;
	for (const entry of entries) {
		noteAnchors(entry, anchors);
		if (entry.kind !== "message") continue;
		latest = entry;
		messagesById.set(entry.turnId, entry);
		if (entry.parentTurnId === null) continue;
		if (seenParents.has(entry.parentTurnId)) branched = true;
		seenParents.add(entry.parentTurnId);
	}
	const base = { entries, leafTurnId, messagesById, seenParents, anchors, branched, latest };
	// Without a live-session pointer, offline readers fall back to the most
	// recent message in file order. Current-session runtime paths must pass the
	// explicit leaf because switchTurn() changes the next append point without
	// appending a message to the ledger.
	const pinnedLeaf = resolveLeafMessage(entries, messagesById, leafTurnId);
	const leaf = pinnedLeaf ?? latest;
	if ((!branched && (pinnedLeaf === undefined || pinnedLeaf.turnId === latest?.turnId)) || !leaf) {
		const path = Object.isFrozen(entries) ? entries : [...entries];
		return { ...base, path, pathIds: null, leaf: undefined, leafIndex: -1, prefixCount: 0 };
	}

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
	const path: SessionEntry[] = [];
	let prefixCount = 0;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index] as SessionEntry;
		const atOrBeforeLeaf = leafIndex >= 0 && index <= leafIndex;
		if (!entryBelongsToPath(entry, pathIds, atOrBeforeLeaf)) continue;
		path.push(entry);
		if (atOrBeforeLeaf) prefixCount += 1;
	}
	return { ...base, path, pathIds, leaf, leafIndex, prefixCount };
}

/**
 * Carry `prior` over the entries appended after it, or null when the appended
 * entries could change a verdict `prior` already made: a message id reused or
 * named by an earlier entry, or a leaf that does not descend from the prior
 * leaf through appended messages. The caller then computes from scratch.
 */
function extendActivePath(
	prior: ActivePathState,
	entries: ReadonlyArray<SessionEntry>,
	leafTurnId: string | undefined,
): ActivePathState | null {
	const start = prior.entries.length;
	const added = new Map<string, { message: MessageEntry; index: number }>();
	const addedParents = new Set<string>();
	let branched = prior.branched;
	let latest = prior.latest;
	for (let index = start; index < entries.length; index += 1) {
		const entry = entries[index] as SessionEntry;
		if (entry.kind !== "message") continue;
		if (prior.messagesById.has(entry.turnId) || added.has(entry.turnId) || prior.anchors.has(entry.turnId)) return null;
		added.set(entry.turnId, { message: entry, index });
		latest = entry;
		if (entry.parentTurnId === null) continue;
		if (prior.seenParents.has(entry.parentTurnId) || addedParents.has(entry.parentTurnId)) branched = true;
		addedParents.add(entry.parentTurnId);
	}
	const lookup = (id: string): MessageEntry | undefined => added.get(id)?.message ?? prior.messagesById.get(id);
	const pinnedLeaf = resolveLeafMessage(entries, { get: lookup }, leafTurnId);
	const leaf = pinnedLeaf ?? latest;
	const linear = (!branched && (pinnedLeaf === undefined || pinnedLeaf.turnId === latest?.turnId)) || !leaf;

	const walked: MessageEntry[] = [];
	if (!linear) {
		if (prior.pathIds === null || prior.leaf === undefined || leaf === undefined) return null;
		const seen = new Set<string>();
		let current: MessageEntry | undefined = leaf;
		while (current !== prior.leaf) {
			if (!current || !added.has(current.turnId) || seen.has(current.turnId)) return null;
			seen.add(current.turnId);
			walked.push(current);
			if (current.parentTurnId === null) return null;
			current = lookup(current.parentTurnId);
		}
	}

	for (const { message } of added.values()) prior.messagesById.set(message.turnId, message);
	for (const parent of addedParents) prior.seenParents.add(parent);
	for (let index = start; index < entries.length; index += 1) noteAnchors(entries[index] as SessionEntry, prior.anchors);
	const base = {
		entries,
		leafTurnId,
		messagesById: prior.messagesById,
		seenParents: prior.seenParents,
		anchors: prior.anchors,
		branched,
		latest,
	};
	if (linear) return { ...base, path: entries, pathIds: null, leaf: undefined, leafIndex: -1, prefixCount: 0 };

	const pathIds = prior.pathIds as Set<string>;
	for (const message of walked) pathIds.add(message.turnId);
	const leafIndex = leaf === prior.leaf ? prior.leafIndex : (added.get((leaf as MessageEntry).turnId)?.index ?? -1);
	// Only entries past the prior leaf can change verdict: unanchored sidecars
	// between the two leaves now sit at or before the leaf.
	const path = prior.path.slice(0, prior.prefixCount);
	let prefixCount = prior.prefixCount;
	for (let index = prior.leafIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index] as SessionEntry;
		const atOrBeforeLeaf = index <= leafIndex;
		if (!entryBelongsToPath(entry, pathIds, atOrBeforeLeaf)) continue;
		path.push(entry);
		if (atOrBeforeLeaf) prefixCount += 1;
	}
	return { ...base, path: Object.freeze(path), pathIds, leaf, leafIndex, prefixCount };
}

/**
 * Resolve the pinned leaf id to a message entry. A sidecar id pins the
 * branch through the turn it is anchored to (targetTurnId, firstKeptTurnId,
 * or parentTurnId), so callers may pass any entry's turnId. An id that
 * resolves to nothing falls back to the caller's default leaf.
 */
function resolveLeafMessage(
	entries: ReadonlyArray<SessionEntry>,
	messagesById: { get(id: string): MessageEntry | undefined },
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
