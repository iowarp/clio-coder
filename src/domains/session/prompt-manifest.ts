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

/**
 * Layout version of the compiled prompt these records describe.
 *
 * 1: the order shipped through 0.3.8.
 * 2: stable-prefix-first ordering with one `# Memory` header, and
 *    `contextWindowSource` recorded alongside the window the prompt states
 *    (issue #249).
 *
 * A record without a `version` field predates the field and is read as 1, so a
 * 0.3.8 manifest still parses. Bump this whenever the compiled text moves for a
 * reason other than its inputs: a resumed session then has the version in hand
 * to explain the one `promptRecompiled` entry its first compile writes.
 */
export const PROMPT_MANIFEST_VERSION = 2;

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
	/** Prompt layout version; see `PROMPT_MANIFEST_VERSION`. Absent on pre-0.3.9 records. */
	version?: number;
	/** ISO timestamp of the compile. */
	at: string;
	/** Hash of the previously served prompt, null on the first compile. */
	previousHash: string | null;
	systemPromptHash: string;
	tokenEstimate: number;
	/** Thinking dial applied to the live agent when this prompt was compiled. */
	thinkingLevel: string | null;
	/**
	 * The window the prompt's `Context window: N` states, and the layer that
	 * answered it. `loaded` is what the backend has this model open at; anything
	 * else means the figure can still move once a loaded window is observed, and
	 * a later recompile is then explained rather than mysterious.
	 */
	contextWindow?: number | null;
	contextWindowSource?: string | null;
	projectPreload: ProjectPreloadClass | null;
	sections: PromptManifestSection[];
	fragments: PromptManifestFragment[];
}

export interface PromptManifestReadError {
	line: number | null;
	message: string;
}

export interface PromptManifestReadResult {
	records: SessionPromptCompileRecord[];
	errors: PromptManifestReadError[];
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Canonical UTC only, the same rule capacity-lease.ts and memory/validate.ts
 * enforce. The previous regex accepted `+05:30` offsets, which parse to a valid
 * instant but sort wrong against a `Z` row, and manifest records are read back
 * in file order and compared as strings.
 */
function isCanonicalUtcTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

function isPromptManifestSection(value: unknown): value is PromptManifestSection {
	return isRecord(value) && typeof value.id === "string" && isNonNegativeInteger(value.tokenEstimate);
}

function isPromptManifestFragment(value: unknown): value is PromptManifestFragment {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.relPath === "string" &&
		isSha256(value.contentHash) &&
		typeof value.dynamic === "boolean"
	);
}

function isProjectPreloadClass(value: unknown): value is ProjectPreloadClass {
	if (!isRecord(value)) return false;
	return (
		(value.mode === "full" || value.mode === "synopsis" || value.mode === "none") &&
		isNonNegativeInteger(value.chars) &&
		isNonNegativeInteger(value.lines) &&
		(value.reason === null || value.reason === "size" || value.reason === "lines" || value.reason === "no-clio-md") &&
		typeof value.nearLimit === "boolean" &&
		typeof value.label === "string"
	);
}

/** Optional fields added after 0.3.8: absent is valid, present must be well-typed. */
function isOptional<T>(value: unknown, guard: (candidate: unknown) => candidate is T): boolean {
	return value === undefined || guard(value);
}

function isSessionPromptCompileRecord(value: unknown): value is SessionPromptCompileRecord {
	if (!isRecord(value)) return false;
	return (
		isOptional(value.version, isNonNegativeInteger) &&
		isOptional(value.contextWindow, (candidate): candidate is number | null =>
			candidate === null ? true : isNonNegativeInteger(candidate),
		) &&
		isOptional(value.contextWindowSource, (candidate): candidate is string | null =>
			candidate === null ? true : typeof candidate === "string",
		) &&
		isCanonicalUtcTimestamp(value.at) &&
		(value.previousHash === null || isSha256(value.previousHash)) &&
		isSha256(value.systemPromptHash) &&
		isNonNegativeInteger(value.tokenEstimate) &&
		(value.thinkingLevel === null || typeof value.thinkingLevel === "string") &&
		(value.projectPreload === null || isProjectPreloadClass(value.projectPreload)) &&
		Array.isArray(value.sections) &&
		value.sections.every(isPromptManifestSection) &&
		Array.isArray(value.fragments) &&
		value.fragments.every(isPromptManifestFragment)
	);
}

export function getPromptManifestFilePath(meta: SessionMeta, stateDir?: string): string {
	const safeMeta = {
		...meta,
		cwdHash: meta.cwdHash || cwdHash(meta.cwd || process.cwd()),
	};
	if (stateDir !== undefined) {
		return join(stateDir, "sessions", safeMeta.cwdHash, safeMeta.id, "prompt-manifest.jsonl");
	}
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

export function readPromptCompileManifest(meta: SessionMeta, stateDir?: string): PromptManifestReadResult {
	const file = getPromptManifestFilePath(meta, stateDir);
	try {
		if (!existsSync(file)) return { records: [], errors: [] };
		const records: SessionPromptCompileRecord[] = [];
		const errors: PromptManifestReadError[] = [];
		for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
			if (line.trim().length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isSessionPromptCompileRecord(parsed)) {
					records.push(parsed);
				} else {
					errors.push({ line: index + 1, message: "invalid prompt manifest record" });
				}
			} catch {
				errors.push({ line: index + 1, message: "invalid JSON" });
			}
		}
		return { records, errors };
	} catch (err) {
		return {
			records: [],
			errors: [{ line: null, message: err instanceof Error ? err.message : String(err) }],
		};
	}
}

export function readPromptCompileRecords(meta: SessionMeta): SessionPromptCompileRecord[] {
	return readPromptCompileManifest(meta).records;
}
