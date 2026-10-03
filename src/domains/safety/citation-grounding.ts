/**
 * Citation grounding, packaged as an after_tool + turn_end hook registration.
 *
 * A `path:line` citation is grounded only when a tool printed that line number:
 * a `read` with `line_numbers: true`, or a grep match. A model that read a file
 * without the gutter and then cites physical ranges has counted or recalled
 * them, and on small local models those ranges drift by dozens of lines (DF-1:
 * `env_cache.py:327-350` for a function at 375, after a whole-file read). Prompt
 * text did not hold there, so the check runs on the final answer itself.
 *
 * The registration records which lines the session saw numbered and which files
 * it read without numbers. At turn_end it extracts the final text's line
 * citations and, when one points into a file read without numbers at a line no
 * tool printed, it carries the turn onward once with the list. It never blocks
 * the answer: the chat loop's single nudge per turn bounds it, and a second
 * final answer passes as written.
 *
 * Deliberate gaps, each of which can only miss a flag, never invent one:
 * a file the session never read through `read` is not judged (a resumed or
 * compacted session would otherwise be flagged for reads it cannot see), a file
 * the session mutated is skipped (its line numbers moved), and bash output such
 * as `grep -n` is invisible to the hook. `code_nav` symbol lines are also
 * invisible, so a citation of a definition line found only through `code_nav`
 * in a file read without numbers is flagged.
 */

import { ToolNames } from "../../core/tool-names.js";
import { resolveReadPath } from "../../tools/path-utils.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { mutationPathsForTool } from "./finish-contract.js";

export const CITATION_GROUNDING_REGISTRATION_ID = "assessor.citation-grounding";

/** How many unbacked citations one nudge names before it counts the rest. */
const NAMED_CITATION_LIMIT = 8;

export interface LineCitation {
	/** The path as written in the answer. */
	path: string;
	start: number;
	end: number;
	/** A bare `lines A-B` bound to the last path named before it, as written. */
	bare?: string;
}

/** What one session has shown the model, keyed by absolute path. */
export interface CitationEvidence {
	/** Lines a tool printed with their physical number. */
	numbered: Map<string, Set<number>>;
	/** Files read at least once without the line-number gutter. */
	readUnnumbered: Set<string>;
	/** Files the session changed; their earlier line numbers no longer hold. */
	mutated: Set<string>;
}

export function emptyCitationEvidence(): CitationEvidence {
	return { numbered: new Map(), readUnnumbered: new Set(), mutated: new Set() };
}

function addNumbered(evidence: CitationEvidence, file: string, start: number, end: number): void {
	const bucket = evidence.numbered.get(file) ?? new Set<number>();
	for (let line = start; line <= end; line++) bucket.add(line);
	evidence.numbered.set(file, bucket);
}

function finiteCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * Fold one settled tool call into the evidence. `details` is the tool result's
 * structured details: `observation.shownCount`/`totalCount` for read, and
 * `observedLines` (absolute path to line list) for grep.
 */
export function recordCitationEvidence(
	evidence: CitationEvidence,
	toolName: string,
	args: Readonly<Record<string, unknown>> | undefined,
	details: Readonly<Record<string, unknown>> | undefined,
	cwd: string,
): void {
	if (toolName === ToolNames.Read) {
		if (typeof args?.path !== "string" || args.path.length === 0) return;
		const file = resolveReadPath(args.path, cwd);
		if (args.line_numbers !== true) {
			evidence.readUnnumbered.add(file);
			return;
		}
		const observation = details?.observation as Record<string, unknown> | undefined;
		const shown = finiteCount(observation?.shownCount);
		if (shown === null || shown === 0) return;
		const tail = finiteCount(args.tail);
		let start: number;
		if (tail !== null && tail > 0) {
			// A numbered tail always carries an exact total (read refuses otherwise).
			const total = finiteCount(observation?.totalCount);
			if (total === null) return;
			start = Math.max(1, total - shown + 1);
		} else {
			start = finiteCount(args.offset) ?? 1;
			if (start < 1) start = 1;
		}
		addNumbered(evidence, file, start, start + shown - 1);
		return;
	}
	if (toolName === ToolNames.Grep) {
		const observed = details?.observedLines;
		if (observed === null || typeof observed !== "object" || Array.isArray(observed)) return;
		for (const [file, lines] of Object.entries(observed as Record<string, unknown>)) {
			if (!Array.isArray(lines)) continue;
			for (const line of lines) if (Number.isInteger(line) && line > 0) addNumbered(evidence, file, line, line);
		}
		return;
	}
	for (const raw of mutationPathsForTool(toolName, args as Record<string, unknown> | undefined)) {
		evidence.mutated.add(resolveReadPath(raw, cwd));
	}
}

// A path token: optional leading ./, ../, ~/ or /, directories, and a file name
// with an extension that starts with a letter, so "1.5" or "v0.6" never match.
const PATH_SOURCE = String.raw`(?:\.{1,2}/|~/|/)?(?:[\w@+-][\w.@+-]*/)*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}`;
const RANGE_SOURCE = String.raw`(\d+)(?:\s*[-–—]\s*(\d+))?`;
// One scan finds both shapes in order: `path:12-30` (also `path:12:5`, line
// then column) and a path mention followed later by `line 12` / `lines 12-30`,
// which binds to the nearest path written before it.
const CITATION_SCAN = new RegExp(
	String.raw`(?<![\w/.@+-])(${PATH_SOURCE})(?::(\d+)(?:[-–—](\d+))?)?|\b[Ll]ines?\s+${RANGE_SOURCE}\b`,
	"gu",
);

/** Fenced code is quoted material; a `line 3` inside it is not a citation. */
function withoutFencedCode(text: string): string {
	return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, (block) => block.replace(/[^\n]/gu, " "));
}

function lineNumber(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const value = Number.parseInt(raw, 10);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Every line citation in an answer, in order. A bare `lines A-B` binds to the
 * last path named before it that `isFile` accepts, so a prose token such as
 * `Node.js` between a file and its range does not take the binding.
 */
export function extractLineCitations(text: string, isFile: (written: string) => boolean = () => true): LineCitation[] {
	const citations: LineCitation[] = [];
	let lastPath: string | null = null;
	for (const match of withoutFencedCode(text).matchAll(CITATION_SCAN)) {
		const [, pathToken, pathStart, pathEnd, bareStart, bareEnd] = match;
		if (pathToken !== undefined) {
			if (isFile(pathToken)) lastPath = pathToken;
			const start = lineNumber(pathStart);
			if (start === null) continue;
			const end = lineNumber(pathEnd) ?? start;
			citations.push({ path: pathToken, start, end: Math.max(start, end) });
			continue;
		}
		const start = lineNumber(bareStart);
		if (start === null || lastPath === null) continue;
		const end = lineNumber(bareEnd) ?? start;
		citations.push({ path: lastPath, start, end: Math.max(start, end), bare: match[0] });
	}
	return citations;
}

/** Absolute files a written path can mean: itself under cwd, or a read file it is a suffix of. */
function candidateFiles(evidence: CitationEvidence, written: string, cwd: string): string[] {
	const direct = resolveReadPath(written, cwd);
	const known = new Set([...evidence.readUnnumbered, ...evidence.numbered.keys()]);
	if (known.has(direct)) return [direct];
	const suffix = `/${written.replace(/^\.\//u, "")}`;
	return [...known].filter((file) => file.endsWith(suffix));
}

/**
 * Citations into a file the session read without line numbers whose start or
 * end line no tool printed. A citation the evidence cannot judge is kept out.
 */
export function unbackedCitations(
	evidence: CitationEvidence,
	citations: ReadonlyArray<LineCitation>,
	cwd: string,
): LineCitation[] {
	const unbacked: LineCitation[] = [];
	const seen = new Set<string>();
	for (const citation of citations) {
		const files = candidateFiles(evidence, citation.path, cwd);
		if (files.length === 0 || files.some((file) => evidence.mutated.has(file))) continue;
		if (!files.some((file) => evidence.readUnnumbered.has(file))) continue;
		const backed = files.some((file) => {
			const lines = evidence.numbered.get(file);
			return lines?.has(citation.start) === true && lines.has(citation.end);
		});
		if (backed) continue;
		const key = `${citation.path}:${citation.start}-${citation.end}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unbacked.push(citation);
	}
	return unbacked;
}

function formatCitation(citation: LineCitation): string {
	// The binding is a guess, so a bare range is quoted as written rather than
	// restated as a path:line the answer never wrote.
	if (citation.bare !== undefined) return `"${citation.bare}" (after ${citation.path})`;
	return citation.start === citation.end
		? `${citation.path}:${citation.start}`
		: `${citation.path}:${citation.start}-${citation.end}`;
}

export function buildCitationGroundingMessage(unbacked: ReadonlyArray<LineCitation>): string {
	const named = unbacked.slice(0, NAMED_CITATION_LIMIT).map(formatCitation).join(", ");
	const rest = unbacked.length - NAMED_CITATION_LIMIT;
	return (
		`[Clio Coder] Citation check: ${named}${rest > 0 ? ` and ${rest} more` : ""} cite line numbers no tool printed; ` +
		"those files were read without line numbers, so the ranges were counted or recalled. Before answering, " +
		"re-read each cited region with read line_numbers=true (grep the symbol first to find its offset) and correct " +
		"the ranges, or cite the symbol name without a line number. Keep the rest of the answer as it is; this check " +
		"asks for no new analysis."
	);
}

export interface CreateCitationGroundingRegistrationOptions {
	/** Workspace root that relative read paths resolve against. Defaults to process.cwd(). */
	cwd?: () => string;
}

export function createCitationGroundingRegistration(
	options: CreateCitationGroundingRegistrationOptions = {},
): MiddlewareHookRegistration {
	const cwd = options.cwd ?? (() => process.cwd());
	let evidence = emptyCitationEvidence();
	let evidenceSessionId: string | undefined;
	let nudgedUserTurnId: string | null = null;
	const forSession = (sessionId: string | undefined): void => {
		if (sessionId === undefined || sessionId === evidenceSessionId) return;
		evidence = emptyCitationEvidence();
		evidenceSessionId = sessionId;
		nudgedUserTurnId = null;
	};
	return {
		id: CITATION_GROUNDING_REGISTRATION_ID,
		description: "carry the turn onward once when the final answer cites line numbers no tool printed",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			forSession(input.sessionId);
			if (input.hook === "after_tool") {
				if (input.metadata?.resultKind !== "ok" || input.toolName === undefined) return [];
				recordCitationEvidence(evidence, input.toolName, input.toolArgs, input.toolResultDetails, cwd());
				return [];
			}
			if (input.hook !== "turn_end") return [];
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			const text = input.text ?? "";
			if (evidence.readUnnumbered.size === 0 || text.trim().length === 0) return [];
			// One nudge per operator turn: the answer after it passes as written.
			const userTurnId = typeof input.metadata?.userTurnId === "string" ? input.metadata.userTurnId : null;
			if (userTurnId !== null && userTurnId === nudgedUserTurnId) return [];
			const root = cwd();
			const citations = extractLineCitations(text, (written) => candidateFiles(evidence, written, root).length > 0);
			const unbacked = unbackedCitations(evidence, citations, root);
			if (unbacked.length === 0) return [];
			nudgedUserTurnId = userTurnId;
			const message = buildCitationGroundingMessage(unbacked);
			return [
				{ kind: "request_continuation", message, note: "line citations were not printed by any read" },
				{ kind: "inject_reminder", message, severity: "warn" },
			];
		},
	};
}
