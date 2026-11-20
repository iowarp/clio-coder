import { createHash } from "node:crypto";
import type { MemoryPromptSelection } from "./contract.js";
import { deliveryOpens, type MemoryDeliveryGate, sectionCarries } from "./lesson-projection.js";
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
	/**
	 * Rank by the turn and carry only records it plainly concerns (`selectRelevantMemory`).
	 * Without a gate the reader keeps the legacy priority order.
	 * `demoted` is read at each fresh selection; a throw counts as none.
	 */
	relevanceGate?: { demoted?: () => ReadonlySet<string> };
	selection?: Pick<MemoryPromptOptions, "scopes" | "tokenBudget" | "maxItems">;
	/** Source seam for deterministic read-count tests; production reads the real bounded store. */
	readStore?: typeof readMemoryStoreSnapshot;
	/**
	 * The session's delivery gate (DESIGN 4.4). `off` leaves the section empty; a record the gate refuses at load is
	 * left out and the selection fills its place. Without it every eligible record may be selected, as before.
	 */
	delivery?: Pick<MemoryDeliveryGate, "mode" | "admit">;
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
			const mode = options.delivery?.mode() ?? "decision";
			if (!deliveryOpens(mode, "section")) {
				// An empty selection is still a selection: the owner fixes the session's delivery baseline from it, so turning
				// delivery on later admits no lesson approved since, and a stale earlier section is not counted as carried.
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
						items: [],
					});
				} catch {
					/* Inspection cannot change which facts the prompt carries. */
				}
				selected = null;
				frame = request.turnId === null ? null : Object.freeze({ key: frameKey, section });
				return section;
			}
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
						demoted === null ? null : [...demoted].sort(),
						MEMORY_RELEVANCE_VERSION,
					]),
				)
				.digest("hex");
			if (selected?.key === key) section = selected.section;
			else {
				// The section carries lessons with command evidence or an operator's approval, and none the delivery
				// check refuses. A refusal leaves the record out and the selection runs again without it.
				const refused = new Set<string>();
				const carried = snapshot.records.filter(sectionCarries);
				const choose = () =>
					inspectMemoryPromptSelection(
						carried.filter((record) => !refused.has(record.id)),
						{
							...selection,
							activeRepository,
							activeRuntime: { kind: "runtime", key: request.runtimeId },
							...(demoted === null ? {} : { relevance, gate: { demoted } }),
						},
					);
				let built = choose();
				for (const gate = options.delivery; gate !== undefined; built = choose()) {
					const refusedNow = built.records.filter((record) => !gate.admit(record, request.cwd));
					if (refusedNow.length === 0) break;
					for (const record of refusedNow) refused.add(record.id);
				}
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
