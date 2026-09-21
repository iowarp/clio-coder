import { createHash } from "node:crypto";
import { canonicalMemoryRepositoryIdentity } from "./operations.js";
import { buildMemoryPromptSection, type MemoryPromptOptions } from "./prompt-section.js";
import { MEMORY_RELEVANCE_VERSION } from "./relevance.js";
import { readMemoryStoreSnapshot } from "./store.js";

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
			const key = createHash("sha256")
				.update(
					JSON.stringify([
						snapshot.revision,
						authority,
						selection,
						relevance,
						experimentalRelevance,
						MEMORY_RELEVANCE_VERSION,
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
