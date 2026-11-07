import { createHash } from "node:crypto";
import type { MemoryPromptSelection } from "./contract.js";
import { canonicalMemoryRepositoryIdentity } from "./operations.js";
import {
	inspectMemoryPromptSelection,
	MEMORY_PROMPT_DEFAULT_TOKEN_BUDGET,
	type MemoryPromptOptions,
	renderMemoryPromptSection,
} from "./prompt-section.js";
import { MEMORY_RELEVANCE_VERSION } from "./relevance.js";
import { readMemoryStoreSnapshot } from "./store.js";
import type { MemoryScope } from "./types.js";

/**
 * Key-sorted entries, so two passes that scored the same records the same way
 * hit the cache regardless of the order the answers came back in.
 */
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
}

export interface MemoryPromptReaderOptions {
	onSelection?: (selection: MemoryPromptSelection) => void;
	getDataDir: () => string;
	/** Explicit experiment only: rank by the turn without dropping anything. */
	experimentalRelevance?: boolean;
	/**
	 * Carry only records the turn plainly concerns (`selectRelevantMemory`).
	 * `demoted` is read at each fresh selection; a throw counts as none.
	 */
	relevanceGate?: { demoted?: () => ReadonlySet<string> };
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
export type MemoryPromptReader = (request: MemoryPromptRequest) => string;

/** Scopes the main agent's prompt draws from; other eligible scopes reach it only through memory_recall. */
export const MEMORY_MAIN_PROMPT_SCOPES: ReadonlyArray<MemoryScope> = ["global", "repo", "runtime"];

export function createMemoryPromptReader(options: MemoryPromptReaderOptions): MemoryPromptReader {
	// Copy options now: mutable caller arrays must not silently change eligibility.
	const selection = { ...options.selection, scopes: [...(options.selection?.scopes ?? MEMORY_MAIN_PROMPT_SCOPES)] };
	const relevanceGate = options.relevanceGate;
	const experimentalRelevance = options.experimentalRelevance === true || relevanceGate !== undefined;
	const demotedNow = (): ReadonlySet<string> => {
		try {
			return relevanceGate?.demoted?.() ?? new Set();
		} catch {
			return new Set();
		}
	};
	const readStore = options.readStore ?? readMemoryStoreSnapshot;
	let frame: { key: string; section: string } | null = null;
	let selected: { key: string; section: string; items: MemoryPromptSelection["items"] } | null = null;
	const authorityOf = (request: MemoryPromptRequest) => {
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
		return { dataDir, activeRepository, authority, frameKey: JSON.stringify([request.turnId, authority]) };
	};
	const read = (request: MemoryPromptRequest): string => {
		const { dataDir, activeRepository, authority, frameKey } = authorityOf(request);
		if (request.turnId !== null && frame?.key === frameKey) return frame.section;
		let section = "";
		try {
			const snapshot = readStore(dataDir);
			const relevance = {
				taskText: request.taskText,
				activePaths: [...request.activePaths],
				activeSymbols: [...(request.activeSymbols ?? [])],
			};
			const demoted = relevanceGate === undefined ? null : demotedNow();
			const key = createHash("sha256")
				.update(
					JSON.stringify([
						snapshot.revision,
						authority,
						selection,
						relevance,
						experimentalRelevance,
						demoted === null ? null : [...demoted].sort(),
						MEMORY_RELEVANCE_VERSION,
					]),
				)
				.digest("hex");
			if (selected?.key === key) section = selected.section;
			else {
				const built = inspectMemoryPromptSelection(snapshot.records, {
					...selection,
					activeRepository,
					activeRuntime: { kind: "runtime", key: request.runtimeId },
					...(experimentalRelevance ? { relevance } : {}),
					...(demoted === null ? {} : { gate: { demoted } }),
				});
				section = renderMemoryPromptSection(built.records);
				const records = new Map(snapshot.records.map((record) => [record.id, record]));
				const items = built.decisions.flatMap((decision, index) => {
					const record = records.get(decision.id);
					return record
						? [{ id: record.id, text: record.lesson, scope: record.scope, rank: index + 1, reason: decision.reason }]
						: [];
				});
				selected = Object.freeze({ key, section, items });
			}
			try {
				options.onSelection?.({
					turnId: request.turnId,
					repository: activeRepository?.key ?? null,
					runtime: request.runtimeId,
					model: request.modelId,
					preparedAt: new Date().toISOString(),
					submittedAt: null,
					section,
					tokenBudget: selection.tokenBudget ?? MEMORY_PROMPT_DEFAULT_TOKEN_BUDGET,
					items: selected?.items ?? [],
				});
			} catch {
				/* Inspection cannot change which facts the prompt carries. */
			}
		} catch {
			// A failed fresh read revokes old approved content, including its cache.
			selected = null;
		}
		frame = request.turnId === null ? null : Object.freeze({ key: frameKey, section });
		return section;
	};
	return read;
}
