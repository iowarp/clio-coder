import { clioStateDir } from "../../core/xdg.js";
import type { ProjectPreloadClass } from "../prompts/preload.js";
import { readSessionPromptCompiles } from "../telemetry/index.js";
import type { SessionMeta } from "./contract.js";

/** Compiled prompt layout, independent of the version 1 journal format (#434). */
export const PROMPT_MANIFEST_VERSION = 4;

export interface PromptManifestSection {
	id: string;
	tokenEstimate: number;
	contentHash?: string;
}

export interface PromptManifestFragment {
	id: string;
	relPath: string;
	contentHash: string;
	dynamic: boolean;
}

export interface SessionPromptCompileRecord {
	/** Prompt layout version. */
	version: number;
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
	contextWindow: number | null;
	contextWindowSource: string | null;
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

export function isProjectPreloadClass(value: unknown): value is ProjectPreloadClass {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	const integer = (item: unknown): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0;
	const optionalInteger = (item: unknown): boolean => item === undefined || integer(item);
	const range = (item: unknown): boolean =>
		item === null ||
		(Array.isArray(item) &&
			item.length === 2 &&
			integer(item[0]) &&
			item[0] >= 1 &&
			integer(item[1]) &&
			item[1] >= item[0]);
	return (
		typeof row.mode === "string" &&
		["full", "partial", "synopsis", "none"].includes(row.mode) &&
		integer(row.chars) &&
		integer(row.lines) &&
		(row.reason === null || (typeof row.reason === "string" && ["size", "lines", "no-clio-md"].includes(row.reason))) &&
		typeof row.nearLimit === "boolean" &&
		typeof row.label === "string" &&
		optionalInteger(row.includedChars) &&
		optionalInteger(row.includedLines) &&
		optionalInteger(row.omittedSupportFragments) &&
		(row.providerSupportsTools === undefined ||
			row.providerSupportsTools === null ||
			typeof row.providerSupportsTools === "boolean") &&
		(row.sources === undefined ||
			(Array.isArray(row.sources) &&
				row.sources.every((source: unknown) => {
					if (source === null || typeof source !== "object" || Array.isArray(source)) return false;
					const s = source as Record<string, unknown>;
					return (
						typeof s.path === "string" &&
						typeof s.contentHash === "string" &&
						/^[a-f0-9]{64}$/.test(s.contentHash) &&
						integer(s.availableChars) &&
						integer(s.availableLines) &&
						integer(s.includedChars) &&
						integer(s.includedLines) &&
						s.includedChars <= s.availableChars &&
						s.includedLines <= s.availableLines &&
						range(s.includedRange) &&
						range(s.omittedRange) &&
						(s.omissionReason === null || s.omissionReason === "budget")
					);
				})))
	);
}

export function readPromptCompileManifest(meta: SessionMeta, stateDir = clioStateDir()): PromptManifestReadResult {
	return readSessionPromptCompiles(stateDir, meta.id);
}

export function readPromptCompileRecords(meta: SessionMeta): SessionPromptCompileRecord[] {
	return readPromptCompileManifest(meta).records;
}
