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

export function readInsideRoot(root: string, path: string): string | null {
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

/**
 * What a lesson is about, read from its own text alone. A lesson kept on
 * command evidence quotes its exact command in backticks, so a backticked span
 * with more than one word is a command; a single backticked word is a name.
 * Paths and environment variables are the other handles an operator searches
 * by. No model reads this, and nothing outside the text is consulted.
 */
export interface LessonSubject {
	readonly commands: readonly string[];
	readonly paths: readonly string[];
	readonly envVars: readonly string[];
}

export function lessonSubject(text: string): LessonSubject {
	const spans = [...text.matchAll(/`([^`\n]+)`/gu)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
	// A span that opens with a flag (`--mode native`) is part of a command, not one.
	const commands = unique(spans.filter((span) => /\s/u.test(span) && !span.startsWith("-")));
	const prose = text.replace(/`[^`\n]*`/gu, " ");
	const pathLike = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?$|^[\w@-]+\.[a-z][a-z0-9]{0,5}$/iu;
	const paths = unique([
		...spans.filter((span) => !/\s/u.test(span) && pathLike.test(span)),
		...[...prose.matchAll(/(?:^|[\s(])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+)/gu)].map((match) => match[1] ?? ""),
		...commands.flatMap((command) => command.split(/\s+/u).filter((word) => pathLike.test(word))),
	]).filter(Boolean);
	// Assigned (`NAME=value`), expanded (`$NAME`) or named as one; an all-caps error code is neither.
	const envVars = unique(
		[
			...text.matchAll(
				/\b([A-Z][A-Z0-9_]{2,})=|\$\{?([A-Z][A-Z0-9_]{2,})|environment variable\s+`?([A-Z][A-Z0-9_]{2,})/gu,
			),
		].map((match) => match[1] ?? match[2] ?? match[3] ?? ""),
	);
	return { commands, paths, envVars };
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function collapse(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}
