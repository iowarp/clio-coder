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

export interface PromptManifestReadError {
	line: number | null;
	message: string;
}

export interface PromptManifestReadResult {
	records: SessionPromptCompileRecord[];
	errors: PromptManifestReadError[];
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

function isSessionPromptCompileRecord(value: unknown): value is SessionPromptCompileRecord {
	if (!isRecord(value)) return false;
	return (
		typeof value.at === "string" &&
		ISO_8601_TIMESTAMP.test(value.at) &&
		Number.isFinite(Date.parse(value.at)) &&
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
