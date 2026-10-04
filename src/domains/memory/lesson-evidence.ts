/**
 * The host-side evidence check for a repository lesson.
 *
 * A lesson is a model's claim. It earns a `held` observation, which is what
 * lets the durable store's gate approve it without an operator, only when the
 * host can bind it to something it observed itself:
 *
 * - command evidence: the exact complete command the shell tool reported
 *   succeeding with exit 0, quoted whole in the lesson text; or
 * - source evidence: a quote the lesson text contains, found in the excerpt
 *   of a successful read result for that repository-relative path that the
 *   reviewed activity actually showed the model, and still present in the
 *   file at that path in the current checkout. A read of one range cannot
 *   vouch for text elsewhere in the file, and today's file cannot vouch for
 *   text no read ever showed.
 *
 * Model confidence, wording, or a path the agent never read is never evidence.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { TaskMemoryEntry } from "./task-bank.js";

export type LessonEvidenceKind = "command" | "source";

export interface LessonEvidenceInput {
	/** Complete commands the shell tool reported succeeding, byte for byte. */
	succeededCommands: ReadonlySet<string>;
	/**
	 * Repository-relative POSIX path to the bounded, redacted excerpts of its
	 * successful read results, exactly as the reviewed activity rendered them.
	 */
	observedReads: ReadonlyMap<string, ReadonlyArray<string>>;
	/** Checkout the quote is verified against: the current session's workspace root. */
	workspaceRoot: string;
}

/** Files larger than this are not scanned for a quote. */
const SOURCE_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;

export function lessonEvidence(entry: TaskMemoryEntry, input: LessonEvidenceInput): LessonEvidenceKind | null {
	if (entry.durable !== true) return null;
	if (
		entry.evidenceCommand !== undefined &&
		input.succeededCommands.has(entry.evidenceCommand) &&
		// The text has to make the same claim the evidence supports: the exact
		// command, delimited, so `node a.mjs --quick` does not vouch for `--full`.
		entry.content.includes(`\`${entry.evidenceCommand}\``)
	) {
		return "command";
	}
	const source = entry.evidenceSource;
	if (source === undefined) return null;
	const path = repositoryRelativePath(source.path, [input.workspaceRoot]);
	if (path === null) return null;
	const quote = collapse(source.quote);
	if (quote.length === 0 || !collapse(entry.content).includes(quote)) return null;
	const observed = input.observedReads.get(path) ?? [];
	if (!observed.some((snippet) => collapse(snippet).includes(quote))) return null;
	const content = readInsideRoot(input.workspaceRoot, path);
	return content !== null && collapse(content).includes(quote) ? "source" : null;
}

/**
 * A path as the repository names it: relative, POSIX-separated, inside one of
 * the given roots. An absolute path under a root is made relative to it; a
 * path that escapes every root is null.
 */
export function repositoryRelativePath(path: string, roots: ReadonlyArray<string>): string | null {
	const trimmed = path.trim();
	if (trimmed.length === 0) return null;
	let candidate: string | null = null;
	if (isAbsolute(trimmed)) {
		for (const root of roots) {
			const inside = relative(resolve(root), resolve(trimmed));
			if (inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside)) {
				candidate = inside;
				break;
			}
		}
	} else {
		candidate = trimmed;
	}
	if (candidate === null) return null;
	const normalized = posix.normalize(candidate.split(sep).join("/")).replace(/^\.\/+/u, "");
	if (normalized.length === 0 || normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
	return normalized;
}

function readInsideRoot(root: string, path: string): string | null {
	try {
		const realRoot = realpathSync(root);
		const target = realpathSync(resolve(realRoot, path));
		const inside = relative(realRoot, target);
		if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) return null;
		const info = statSync(target);
		if (!info.isFile() || info.size > SOURCE_EVIDENCE_MAX_BYTES) return null;
		return readFileSync(target, "utf8");
	} catch {
		// A file that is gone or unreadable in this checkout supports nothing here.
		return null;
	}
}

/** Excerpts remembered per path; the newest replace the oldest. */
const OBSERVED_SNIPPETS_PER_PATH = 4;
/** Paths remembered per reviewed scope. */
const OBSERVED_PATH_LIMIT = 256;

/** Record one excerpt a successful read showed the model, bounded per path and per scope. */
export function recordObservedRead(observed: Map<string, string[]>, path: string, snippet: string): void {
	if (snippet.trim().length === 0) return;
	const snippets = observed.get(path) ?? [];
	observed.delete(path);
	snippets.push(snippet);
	if (snippets.length > OBSERVED_SNIPPETS_PER_PATH) snippets.splice(0, snippets.length - OBSERVED_SNIPPETS_PER_PATH);
	observed.set(path, snippets);
	if (observed.size > OBSERVED_PATH_LIMIT) {
		const oldest = observed.keys().next().value;
		if (oldest !== undefined) observed.delete(oldest);
	}
}

function collapse(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}
