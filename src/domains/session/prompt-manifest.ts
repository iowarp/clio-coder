import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwdHash, sessionPaths } from "../../engine/session.js";
import type { ProjectPreloadClass } from "../prompts/preload.js";
import type { SessionMeta } from "./contract.js";

/**
 * Per-session prompt-manifest ledger. Every prompt compile whose text
 * changed appends one record to `prompt-manifest.jsonl`, a sibling of
 * `current.jsonl`, so a finished session's stored artifacts alone state the
 * exact system-prompt hash, section breakdown, fragment versions, and the
 * thinking dial active at compile time. The record is a manifest, never the
 * prompt text: hashes and token estimates keep it cheap while two sessions
 * stay diffable without recompiling anything.
 */

export interface PromptManifestSection {
	id: string;
	tokenEstimate: number;
}

export interface PromptManifestFragment {
	id: string;
	relPath: string;
	contentHash: string;
	dynamic: boolean;
}

export interface SessionPromptCompileRecord {
	/** ISO timestamp of the compile. */
	at: string;
	/** Hash of the previously served prompt, null on the first compile. */
	previousHash: string | null;
	systemPromptHash: string;
	tokenEstimate: number;
	/** Thinking dial applied to the live agent when this prompt was compiled. */
	thinkingLevel: string | null;
	projectPreload: ProjectPreloadClass | null;
	sections: PromptManifestSection[];
	fragments: PromptManifestFragment[];
}

export function getPromptManifestFilePath(meta: SessionMeta): string {
	const safeMeta = {
		...meta,
		cwdHash: meta.cwdHash || cwdHash(meta.cwd || process.cwd()),
	};
	const paths = sessionPaths(safeMeta);
	return join(dirname(paths.current), "prompt-manifest.jsonl");
}

/** Best-effort append; prompt provenance must never abort a turn. */
export function appendPromptCompileRecord(meta: SessionMeta, record: SessionPromptCompileRecord): void {
	try {
		const file = getPromptManifestFilePath(meta);
		appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Disk pressure or permissions; the live session keeps running.
	}
}

export function readPromptCompileRecords(meta: SessionMeta): SessionPromptCompileRecord[] {
	try {
		const file = getPromptManifestFilePath(meta);
		if (!existsSync(file)) return [];
		const records: SessionPromptCompileRecord[] = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				records.push(JSON.parse(line) as SessionPromptCompileRecord);
			} catch {
				// Skip torn or corrupt lines; provenance reads are best-effort.
			}
		}
		return records;
	} catch {
		return [];
	}
}
