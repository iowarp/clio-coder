/**
 * What the session has observed about which files.
 *
 * One pass over the active-path entries produces one `PathObservation` per
 * tool result (and per `fileEntry`) that names a path: which file, which line
 * range, which paths a listing surfaced, whether the call failed, and where in
 * the turn sequence it sits. The structural policy reads it to answer the four
 * questions its rules ask ("was this file written after I read it", "did a
 * later read cover this range", "did this failure get resolved", "has this
 * listing been consumed"), and the replay reference graph reads the same index
 * to label `file_reread`, `file_discovery`, and `file_rewrite` edges. One
 * index, two consumers, so a rule and its measurement can never disagree about
 * what the session did.
 *
 * Pure, deterministic, single pass. No filesystem access: paths are resolved
 * lexically against the session cwd the caller passes (`options.cwd`), and only
 * normalized when it does not. The cwd is never sniffed from the entries and
 * never defaulted to `process.cwd()`: the live ledger readers strip the JSONL
 * header, and a replay run and a live run must index the same ledger the same
 * way.
 *
 * This is `extractFileOps` in `compaction/compact.ts` generalized: same
 * `path | file_path | filePath` argument reading, same tool-call pairing as
 * `chat-renderer.ts`, plus ranges, listings, failures, and turn positions.
 */

import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import type { MessageEntry, SessionEntry } from "../../session/entries.js";
import type { WorkingSetRef } from "./contract.js";
import { isTurnStart } from "./horizon.js";
import { isRecord, toolResultText } from "./payload.js";

/**
 * The observing verb. Clio's `git` and `verify` are command runners with an
 * exit status, so they index as `bash`; `artifact` writes a file, so it indexes
 * as `write`. Tools that observe no path at all (dispatch, web_fetch, tasks,
 * ask_user, context, ...) produce no observation.
 */
export type PathOp = "read" | "grep" | "find" | "ls" | "code_nav" | "write" | "edit" | "bash";

/**
 * Lines of a file an observation covers. `offset` counts lines skipped from the
 * top (0-based), so a whole-file read is `{ offset: 0, limit: null }` and
 * `read(offset: 1)` normalizes to it. `limit: null` means "to EOF".
 */
export interface PathRange {
	offset: number;
	limit: number | null;
}

export interface PathObservation {
	/** The evictable unit: the tool_result entry, or the fileEntry entry for write/edit evidence. */
	ref: WorkingSetRef;
	toolCallId: string | null;
	toolName: string;
	op: PathOp;
	/**
	 * Canonical absolute path when the session cwd is known, else the path as
	 * the call wrote it. Empty when the call named no path (a bash command with
	 * no cwd argument), which keeps it out of `byPath` without dropping the
	 * observation the failure rules need.
	 */
	path: string;
	/**
	 * Line coverage for `read`, null for everything else and for a `tail` read,
	 * whose coverage is unknowable without the file. Supersession treats a null
	 * range as unknown: it covers nothing and only a full read covers it.
	 */
	range: PathRange | null;
	/** Listing ops only: concrete file paths the result surfaced, resolved like `path`. */
	surfaced: ReadonlyArray<string>;
	isError: boolean;
	/** The safety rails refused the call: no observation happened, and it resolves nothing. */
	isBlocked: boolean;
	/** Turn starts (user message, bashExecution, branchSummary) strictly before this entry. */
	turnIndex: number;
	/** Index in the entries array this index was built from. */
	entryIndex: number;
	/** Tool-call arguments as deterministic JSON with sorted keys; empty when the call is unknown. */
	argsKey: string;
}

export interface PathIndex {
	/** Ledger order. */
	observations: ReadonlyArray<PathObservation>;
	byRef: ReadonlyMap<string, PathObservation>;
	byPath: ReadonlyMap<string, ReadonlyArray<PathObservation>>;
	/** Every entry's turn position, including entries that observe no path. */
	turnIndexOf: ReadonlyMap<string, number>;
	turnCount: number;
}

/** Commands whose stdout is a list of paths. Anything else surfaces nothing. */
const LISTING_COMMANDS = new Set(["ls", "find", "tree", "fd", "rg", "grep"]);
/** Commands whose stdout is `path:line:text` rather than one path per line. */
const MATCH_LINE_COMMANDS = new Set(["rg", "grep"]);

const TOOL_OPS: ReadonlyMap<string, PathOp> = new Map<string, PathOp>([
	["read", "read"],
	["grep", "grep"],
	["find", "find"],
	["ls", "ls"],
	["code_nav", "code_nav"],
	["write", "write"],
	["edit", "edit"],
	["artifact", "write"],
	["bash", "bash"],
	["git", "bash"],
	["verify", "bash"],
]);

/** code_nav modes whose `query` is a file path rather than a symbol or page name. */
const CODE_NAV_PATH_MODES = new Set(["path", "outline", "deps", "dependents"]);

/** Ops whose result is a list of other paths. */
const LISTING_OPS = new Set<PathOp>(["grep", "find", "ls", "bash"]);

export interface PathIndexOptions {
	/** Session working directory; relative arguments resolve against it. Null leaves them relative (normalized). */
	cwd?: string | null;
}

/**
 * Lexical canonicalization only: no realpath, no `process.cwd()`, no `~`
 * expansion. With a cwd, `src/a.ts`, `./src/a.ts`, and `/cwd/src/a.ts` all key
 * the same file; without one the first two still do.
 */
function canonicalize(value: string, cwd: string | null): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) return "";
	if (isAbsolute(trimmed)) return normalize(trimmed);
	return cwd === null ? normalize(trimmed) : resolve(cwd, trimmed);
}

function usableCwd(options: PathIndexOptions | undefined): string | null {
	const cwd = options?.cwd;
	if (typeof cwd !== "string" || cwd.trim().length === 0 || !isAbsolute(cwd)) return null;
	return normalize(cwd);
}

function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	}
	if (value === undefined) return "null";
	return JSON.stringify(value) ?? "null";
}

interface ToolCallFacts {
	toolName: string;
	args: unknown;
	argsKey: string;
}

function callFacts(toolName: string, args: unknown): ToolCallFacts {
	return { toolName, args, argsKey: args === undefined ? "" : stableStringify(args) };
}

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
	if (record === null) return null;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return null;
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
	return isRecord(payload) ? payload : null;
}

/** Record every tool call the ledger holds, in both shapes it persists them. */
function collectToolCalls(entries: ReadonlyArray<SessionEntry>): Map<string, ToolCallFacts> {
	const calls = new Map<string, ToolCallFacts>();
	for (const entry of entries) {
		if (entry.kind !== "message") continue;
		const obj = payloadRecord(entry.payload);
		if (entry.role === "tool_call" && obj !== null) {
			const id = stringField(obj, "toolCallId", "tool_call_id", "id") ?? entry.turnId;
			const name = stringField(obj, "name", "toolName", "tool") ?? "tool";
			calls.set(id, callFacts(name, obj.args ?? obj.arguments ?? obj.input));
			continue;
		}
		if (entry.role !== "assistant" || obj === null || !Array.isArray(obj.content)) continue;
		for (const block of obj.content) {
			if (!isRecord(block) || block.type !== "toolCall") continue;
			const id = stringField(block, "id", "toolCallId") ?? entry.turnId;
			const name = stringField(block, "name", "toolName") ?? "tool";
			calls.set(id, callFacts(name, block.arguments ?? block.args ?? block.input));
		}
	}
	return calls;
}

/**
 * The one path argument of every tool call, as the model wrote it, keyed by
 * toolCallId. Markers read this so a `read` that left the working set still
 * says which file it was; the canonical, cwd-resolved form the rules key on
 * would show the model an absolute path it never typed.
 */
export function callPathsByToolCallId(entries: ReadonlyArray<SessionEntry>): ReadonlyMap<string, string> {
	const paths = new Map<string, string>();
	for (const [id, call] of collectToolCalls(entries)) {
		const named = stringField(isRecord(call.args) ? call.args : null, "path", "file_path", "filePath");
		if (named !== null) paths.set(id, named);
	}
	return paths;
}

/**
 * The path the call was about. Search tools default to the working directory,
 * which is what they actually searched, so a `grep` with no `path` argument is
 * an observation of the cwd rather than of nothing.
 */
function observedPath(op: PathOp, args: Record<string, unknown> | null, cwd: string | null): string {
	if (op === "bash") {
		const explicit = stringField(args, "cwd");
		return explicit === null ? "" : canonicalize(explicit, cwd);
	}
	if (op === "code_nav") {
		const mode = stringField(args, "mode");
		if (mode === null || !CODE_NAV_PATH_MODES.has(mode)) return "";
		const query = stringField(args, "query");
		return query === null ? "" : canonicalize(query, cwd);
	}
	const named = stringField(args, "path", "file_path", "filePath");
	if (named !== null) return canonicalize(named, cwd);
	// grep, find, and ls all default to ".".
	if (op === "grep" || op === "find" || op === "ls") return cwd ?? ".";
	return "";
}

function readRange(args: Record<string, unknown> | null): PathRange | null {
	if (args === null) return { offset: 0, limit: null };
	const tail = args.tail;
	// A tail read covers an unknown suffix; claiming a range would let it
	// supersede reads it may not contain.
	if (typeof tail === "number" && Number.isFinite(tail) && tail > 0) return null;
	const rawOffset = args.offset;
	const rawLimit = args.limit;
	const offset =
		typeof rawOffset === "number" && Number.isFinite(rawOffset) && rawOffset > 1 ? Math.floor(rawOffset) - 1 : 0;
	const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : null;
	return { offset, limit };
}

/**
 * Is this line a concrete file path rather than prose, a directory, or a
 * tool's own notice? Deliberately permissive about extensions (`Makefile` and
 * `LICENSE` are files) and strict about whitespace, because every listing this
 * parses prints one path per line. Over-counting only keeps a listing in the
 * working set longer; under-counting would evict a listing whose paths the
 * agent still needs.
 */
function looksLikeConcreteFilePath(line: string): boolean {
	const text = line.trim();
	if (text.length === 0) return false;
	// The observation envelope's own trailer, e.g. `[grep: 261/261+ matches ...]`.
	if (text.startsWith("[")) return false;
	if (text.endsWith("/")) return false;
	return !/\s/.test(text);
}

/** `path:line: text` from grep content mode and from bash `rg`/`grep`. */
function pathFromMatchLine(line: string): string | null {
	const match = /^([^\s:]+):\d+[:-]/.exec(line.trim());
	return match?.[1] ?? null;
}

function surfacedPaths(
	op: PathOp,
	args: Record<string, unknown> | null,
	text: string,
	root: string,
	cwd: string | null,
): string[] {
	const lines = text.split("\n");
	const matchLines = op === "grep" || (op === "bash" && isMatchLineCommand(args));
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const raw = matchLines ? (pathFromMatchLine(line) ?? candidateWholeLine(line)) : candidateWholeLine(line);
		if (raw === null) continue;
		const resolved = resolveSurfaced(raw, root, cwd);
		if (resolved.length === 0 || seen.has(resolved)) continue;
		seen.add(resolved);
		out.push(resolved);
	}
	return out;
}

function candidateWholeLine(line: string): string | null {
	return looksLikeConcreteFilePath(line) ? line.trim() : null;
}

function isMatchLineCommand(args: Record<string, unknown> | null): boolean {
	const verb = commandVerb(args);
	return verb !== null && MATCH_LINE_COMMANDS.has(verb);
}

function commandVerb(args: Record<string, unknown> | null): string | null {
	const command = stringField(args, "command");
	if (command === null) return null;
	const first = command.trimStart().split(/\s+/)[0];
	return first === undefined || first.length === 0 ? null : basename(first);
}

/**
 * A listing prints paths relative to what it searched, so they join onto the
 * observation's own path before canonicalizing, whether that root is absolute
 * or still relative. A single-file search root surfaces its own basename,
 * which resolves back to the root rather than to a child of it.
 */
function resolveSurfaced(value: string, root: string, cwd: string | null): string {
	if (isAbsolute(value)) return normalize(value);
	if (root.length === 0) return canonicalize(value, cwd);
	if (basename(root) === value) return canonicalize(root, cwd);
	return canonicalize(join(root, value), cwd);
}

/** A listing result only surfaces paths when the call was a listing in the first place. */
function shouldParseSurfaced(op: PathOp, args: Record<string, unknown> | null, isError: boolean): boolean {
	if (isError || !LISTING_OPS.has(op)) return false;
	if (op !== "bash") return true;
	const verb = commandVerb(args);
	return verb !== null && LISTING_COMMANDS.has(verb);
}

function fileEntryOp(operation: "read" | "write" | "edit" | "create" | "delete"): PathOp {
	if (operation === "read") return "read";
	if (operation === "edit") return "edit";
	return "write";
}

function toolResultObservation(
	entry: MessageEntry,
	context: { entryIndex: number; turnIndex: number; cwd: string | null; calls: ReadonlyMap<string, ToolCallFacts> },
): PathObservation | null {
	const obj = payloadRecord(entry.payload);
	const toolCallId = stringField(obj, "toolCallId", "tool_call_id", "id");
	const call = toolCallId === null ? undefined : context.calls.get(toolCallId);
	const toolName = stringField(obj, "toolName", "name", "tool") ?? call?.toolName ?? "tool";
	const op = TOOL_OPS.get(toolName);
	if (op === undefined) return null;
	const args = call !== undefined && isRecord(call.args) ? call.args : null;
	const isError = obj?.isError === true || obj?.error === true;
	const isBlocked = obj?.outcome === "blocked" || typeof obj?.blockReason === "string";
	const path = observedPath(op, args, context.cwd);
	const surfaced = shouldParseSurfaced(op, args, isError)
		? surfacedPaths(op, args, toolResultText(obj?.result ?? entry.payload), path, context.cwd)
		: [];
	return {
		ref: { entry: entry.turnId },
		toolCallId,
		toolName,
		op,
		path,
		range: op === "read" ? readRange(args) : null,
		surfaced,
		isError,
		isBlocked,
		turnIndex: context.turnIndex,
		entryIndex: context.entryIndex,
		argsKey: call?.argsKey ?? "",
	};
}

export function buildPathIndex(entries: ReadonlyArray<SessionEntry>, options?: PathIndexOptions): PathIndex {
	const cwd = usableCwd(options);
	const calls = collectToolCalls(entries);
	const observations: PathObservation[] = [];
	const byRef = new Map<string, PathObservation>();
	const byPath = new Map<string, PathObservation[]>();
	const turnIndexOf = new Map<string, number>();
	let turnIndex = 0;

	for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
		const entry = entries[entryIndex];
		if (entry === undefined) continue;
		turnIndexOf.set(entry.turnId, turnIndex);
		let observation: PathObservation | null = null;
		if (entry.kind === "fileEntry") {
			observation = {
				ref: { entry: entry.turnId },
				toolCallId: null,
				toolName: "fileEntry",
				op: fileEntryOp(entry.operation),
				path: canonicalize(entry.path, cwd),
				range: null,
				surfaced: [],
				isError: false,
				isBlocked: false,
				turnIndex,
				entryIndex,
				argsKey: "",
			};
		} else if (entry.kind === "message" && entry.role === "tool_result") {
			observation = toolResultObservation(entry, { entryIndex, turnIndex, cwd, calls });
		}
		if (observation !== null) {
			observations.push(observation);
			byRef.set(observation.ref.entry, observation);
			if (observation.path.length > 0) {
				const bucket = byPath.get(observation.path);
				if (bucket === undefined) byPath.set(observation.path, [observation]);
				else bucket.push(observation);
			}
		}
		if (isTurnStart(entry)) turnIndex += 1;
	}

	return { observations, byRef, byPath, turnIndexOf, turnCount: turnIndex };
}
