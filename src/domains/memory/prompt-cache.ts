import { createHash } from "node:crypto";
import { canonicalMemoryRepositoryIdentity } from "./operations.js";
import { buildMemoryPromptSection, type MemoryPromptOptions } from "./prompt-section.js";
import {
	MEMORY_PRECOMPUTED_RELEVANCE_VERSION,
	MEMORY_RELEVANCE_VERSION,
	type PrecomputedMemoryRelevance,
} from "./relevance.js";
import { readMemoryStoreSnapshot } from "./store.js";

/**
 * Key-sorted entries, so two passes that scored the same records the same way
 * hit the cache regardless of the order the answers came back in.
 */
function sortedScores(scores: Readonly<Record<string, number>>): Array<[string, number]> {
	return Object.entries(scores).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Host-owned attempt identity, distinct from the ledger ID allocated after preflight. */
export interface MemoryPromptRequest {
	readonly turnId: string | null;
	readonly sessionAuthority: string;
	readonly cwd: string;
	readonly targetId: string;
	readonly runtimeId: string;
	readonly modelId: string;
	readonly taskText: string;
	readonly activePaths: readonly string[];
	readonly activeSymbols?: readonly string[];
	/**
	 * Scores this turn's pre-turn pass resolved, or absent when the memory
	 * decision site is unbound or the pass produced nothing. It is part of the
	 * cache key: a new pass that reused the previous turn's cached section would
	 * be serving a selection the scores no longer justify.
	 */
	readonly precomputedRelevance?: PrecomputedMemoryRelevance;
}

export interface MemoryPromptReaderOptions {
	getDataDir: () => string;
	/** Explicit experiment only; production leaves relevance off. */
	experimentalRelevance?: boolean;
	selection?: Pick<MemoryPromptOptions, "scopes" | "tokenBudget" | "maxItems">;
	/** Source seam for deterministic read-count tests; production reads the real bounded store. */
	readStore?: typeof readMemoryStoreSnapshot;
}

/**
 * Single-entry immutable text cache. A new prepared operator attempt rereads the
 * store; ordinary external edits become visible at the next attempt. Within an
 * attempt/its admitted continuations, selection is frozen, except authority
 * changes (session/branch, data root, canonical repo, actual target/runtime/model).
 * Calls without a prepared turn (boot/reset prewarm) read each time. Later
 * prewarm can reuse the preceding snapshot; a fresh attempt always rereads.
 */
export function createMemoryPromptReader(options: MemoryPromptReaderOptions): (request: MemoryPromptRequest) => string {
	// Copy options now: mutable caller arrays must not silently change eligibility.
	const selection = { ...options.selection, scopes: [...(options.selection?.scopes ?? ["global", "repo", "runtime"])] };
	const experimentalRelevance = options.experimentalRelevance === true;
	const readStore = options.readStore ?? readMemoryStoreSnapshot;
	let frame: { key: string; section: string } | null = null;
	let selected: { key: string; section: string } | null = null;
	let pinned: PinnedRanking | null = null;
	return (request) => {
		const dataDir = options.getDataDir();
		const activeRepository = canonicalMemoryRepositoryIdentity(request.cwd);
		const authority = JSON.stringify([
			dataDir,
			request.sessionAuthority,
			request.cwd,
			activeRepository,
			request.targetId,
			request.runtimeId,
			request.modelId,
		]);
		const frameKey = JSON.stringify([request.turnId, authority]);
		if (request.turnId !== null && frame?.key === frameKey) return frame.section;
		let section = "";
		try {
			const snapshot = readStore(dataDir);
			const relevance = {
				taskText: request.taskText,
				activePaths: [...request.activePaths],
				activeSymbols: [...(request.activeSymbols ?? [])],
			};
			// The section sits in the system prompt, so a ranking that moved with
			// every turn's task would recompile the prompt and send the whole
			// conversation through a cold prefill on each follow-up (26.6s at 64k
			// tokens on a local 27B). The first ranking a session applies is kept
			// until the approved records or the session's authority change.
			const precomputed = pinRanking(
				pinned,
				request.precomputedRelevance,
				{ authority: pinAuthority(authority, request.sessionAuthority), session: request.sessionAuthority },
				snapshot.revision,
			);
			pinned = precomputed === undefined ? pinned : precomputed.pin;
			// The score map is keyed, not just its presence: the same records under
			// a new ranking's scores select differently, and reusing the cached text
			// would serve a section those scores no longer justify.
			const ranking = precomputed?.ranking;
			const key = createHash("sha256")
				.update(
					JSON.stringify([
						snapshot.revision,
						authority,
						selection,
						relevance,
						experimentalRelevance,
						MEMORY_RELEVANCE_VERSION,
						MEMORY_PRECOMPUTED_RELEVANCE_VERSION,
						ranking === undefined ? null : [ranking.source, sortedScores(ranking.scores)],
					]),
				)
				.digest("hex");
			if (selected?.key === key) section = selected.section;
			else {
				section = buildMemoryPromptSection(snapshot.records, {
					...selection,
					activeRepository,
					activeRuntime: { kind: "runtime", key: request.runtimeId },
					...(experimentalRelevance ? { relevance } : {}),
					...(ranking === undefined ? {} : { precomputedRelevance: ranking }),
				}).section;
				selected = Object.freeze({ key, section });
			}
		} catch {
			// A failed fresh read revokes old approved content, including its cache.
			selected = null;
		}
		frame = request.turnId === null ? null : Object.freeze({ key: frameKey, section });
		return section;
	};
}

interface PinnedRanking {
	/** Reader authority without the session component, so a pending id can be matched. */
	readonly authority: string;
	/** Session authority the ranking was pinned under. */
	readonly session: string;
	readonly revision: string;
	readonly ranking: PrecomputedMemoryRelevance;
}

function pinAuthority(authority: string, sessionAuthority: string): string {
	return authority.replace(JSON.stringify(sessionAuthority), "");
}

/**
 * A session's first turn can run before its id exists, under `pending:<n>`.
 * The session that id becomes is the same session, so the pin carries over.
 */
function sameSession(pinned: string, current: string): boolean {
	if (pinned === current) return true;
	try {
		const [pinnedEpoch, pinnedId] = JSON.parse(pinned) as [unknown, unknown];
		const [currentEpoch] = JSON.parse(current) as [unknown, unknown];
		return pinnedEpoch === currentEpoch && typeof pinnedId === "string" && pinnedId.startsWith("pending:");
	} catch {
		return false;
	}
}

/**
 * The ranking this turn's section uses: the session's pinned one while it
 * still applies, even on a turn whose pass produced no scores, otherwise this
 * turn's, which becomes the new pin. With no pin and no scores the section
 * keeps its base order, which is every turn when the site is unbound.
 */
function pinRanking(
	pinned: PinnedRanking | null,
	fresh: PrecomputedMemoryRelevance | undefined,
	identity: { authority: string; session: string },
	revision: string,
): { ranking: PrecomputedMemoryRelevance; pin: PinnedRanking } | undefined {
	if (
		pinned !== null &&
		pinned.authority === identity.authority &&
		pinned.revision === revision &&
		sameSession(pinned.session, identity.session)
	) {
		return { ranking: pinned.ranking, pin: { ...pinned, session: identity.session } };
	}
	// An empty score map ranks nothing, so it must not claim the session's pin.
	if (fresh === undefined || Object.keys(fresh.scores).length === 0) return undefined;
	return { ranking: fresh, pin: { ...identity, revision, ranking: fresh } };
}
