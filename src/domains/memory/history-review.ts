/**
 * Incremental reads of the repository's earlier sessions for the idle memory
 * guardian.
 *
 * Session history is cwd-partitioned, so the guardian reads only the buckets of
 * the current repository's own checkout roots (`relatedRepositoryRoots`): the
 * main checkout and its linked worktrees. Each ledger is read forward from a
 * durable byte cursor, so an unchanged session is never put in front of a
 * model twice, and a tool call already reviewed under another session (a fork
 * copies its parent's entries) is recognized by its call id and skipped.
 *
 * A slice comes from one session only, so every lesson it yields carries that
 * session as provenance. A session whose ledger records an information-flow
 * restriction is not read past the restriction: the context after it may not
 * leave for an arbitrary model, and the guardian has no per-destination
 * admission for another session's labels.
 */

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../tools/surface.js";
import { redactSecretString } from "../safety/redaction.js";
import type { SessionLedgerStat } from "../session/related-ledgers.js";
import { sessionLedgersForRoots } from "../session/related-ledgers.js";
import { recordObservedRead, repositoryRelativePath } from "./lesson-evidence.js";
import { relatedRepositoryRoots } from "./operations.js";

const CURSOR_FILE_VERSION = 1;
/** Sessions remembered per repository; the oldest cursors fall off first. */
const CURSOR_SESSION_LIMIT = 1_000;
/** Reviewed tool-call ids remembered per repository for fork deduplication. */
const SEEN_CALL_LIMIT = 4_000;
/** Largest window one read takes from a ledger; a slice may take several. */
const READ_WINDOW_MAX_BYTES = 4 * 1024 * 1024;
const COMMAND_MAX_CHARS = 400;
const TASK_MAX_CHARS = 300;
const DIAGNOSTIC_MAX_CHARS = 160;
const READ_EXCERPT_MAX_CHARS = 240;
/** Persisted flow labels; the same custom entry type `src/entry/flow-ledger.ts` writes. */
const FLOW_RESTRICTION_ENTRY_TYPE = "clio_coder_flow_restriction";

/**
 * Shell inspection that teaches nothing about how this repository works on its
 * own. Reading source through the agent's tools is different: a fact learned
 * from the code is a lesson too, so tool reads count toward review below.
 */
const TRIVIAL_COMMAND =
	/^(?:cd\s+\S+\s*&&\s*)?(?:ls|ll|cat|head|tail|less|pwd|echo|printf|grep|rg|find|fd|wc|which|type|file|stat|tree|du|df|date|whoami|true|sed\s+-n|git\s+(?:status|diff|log|show|branch|rev-parse|remote|stash\s+list))\b/u;

interface SessionCursor {
	offset: number;
	size: number;
	/** The ledger recorded a flow restriction at or before `offset`; nothing later is read. */
	restricted?: true;
}

interface RepositoryCursors {
	sessions: Record<string, SessionCursor>;
	seenCalls: string[];
}

interface CursorFile {
	version: typeof CURSOR_FILE_VERSION;
	repositories: Record<string, RepositoryCursors>;
}

export interface HistoryReviewSlice {
	/** The session the excerpt came from; the provenance of every lesson it yields. */
	sessionId: string;
	/** Checkout root whose bucket held the session. */
	root: string;
	/** Bounded excerpt, rendered like the turn log the lesson pass reads. */
	text: string;
	/** Complete commands the shell tool reported succeeding with exit 0, byte for byte. */
	succeededCommands: ReadonlySet<string>;
	/** Excerpts of successful read results the excerpt showed, by repository-relative path. */
	observedReads: ReadonlyMap<string, ReadonlyArray<string>>;
	/** Applied by `commit` once the excerpt was actually reviewed. */
	readonly advance: { key: string; cursor: SessionCursor; seenCalls: string[] };
}

export interface HistorySliceRequest {
	/** Only sessions written within this many milliseconds; Infinity reads all. */
	horizonMs: number;
	/** Excerpt character budget. */
	maxChars: number;
	/** Bytes this request may read across all ledgers before it yields. */
	maxReadBytes: number;
	nowMs?: number;
}

export interface HistoryReviewSource {
	/** Canonical repository key the cursors belong to, or null outside a repository. */
	readonly repositoryKey: string | null;
	/**
	 * The next excerpt worth a model call within the request's horizon, or null
	 * when nothing in range is new. Ledger stretches with nothing worth review
	 * advance their cursors here without a model call. `exhausted` is false when
	 * the read budget ran out before the horizon was fully scanned.
	 */
	next(request: HistorySliceRequest): { slice: HistoryReviewSlice | null; exhausted: boolean };
	/** Record a slice as reviewed. */
	commit(slice: HistoryReviewSlice): void;
}

/** Durable per-repository review cursors under the state directory. */
function historyReviewCursorPath(stateDir: string): string {
	return join(stateDir, "memory", "history-review.json");
}

export function createHistoryReviewSource(input: {
	stateDir: string;
	cwd: string;
	currentSessionId: string | null;
}): HistoryReviewSource {
	const related = relatedRepositoryRoots(input.cwd);
	const repositoryKey = related?.repository.key ?? null;
	const path = historyReviewCursorPath(input.stateDir);
	let cursors: RepositoryCursors | null = null;
	const load = (): RepositoryCursors => {
		if (cursors !== null) return cursors;
		cursors = readRepositoryCursors(path, repositoryKey ?? "") ?? { sessions: {}, seenCalls: [] };
		return cursors;
	};
	const persist = (): void => {
		if (repositoryKey === null || cursors === null) return;
		try {
			const file = readCursorFile(path) ?? { version: CURSOR_FILE_VERSION, repositories: {} };
			file.repositories[repositoryKey] = boundCursors(cursors);
			safeResourceWrite(path, `${JSON.stringify(file)}\n`);
		} catch {
			// Cursors are an optimization: a lost write costs one repeated review, never correctness.
		}
	};
	return {
		repositoryKey,
		next(request) {
			if (related === null) return { slice: null, exhausted: true };
			const state = load();
			const nowMs = request.nowMs ?? Date.now();
			const seen = new Set(state.seenCalls);
			const ledgers = sessionLedgersForRoots(input.stateDir, related.roots, {
				excludeSessionId: input.currentSessionId,
			}).filter((ledger) => request.horizonMs === Number.POSITIVE_INFINITY || nowMs - ledger.mtimeMs <= request.horizonMs);
			let budget = request.maxReadBytes;
			let advanced = false;
			// A call held for its result past this request's budget: the horizon is
			// not exhausted, and the next request with a fresh budget pairs it.
			let budgetHeld = false;
			for (const ledger of ledgers) {
				const prior = state.sessions[ledger.key];
				if (prior?.restricted) continue;
				// A ledger shorter than its cursor was rewritten; read it again from the
				// start and let the seen-call set drop what was already reviewed.
				let offset = prior !== undefined && prior.offset <= ledger.size ? prior.offset : 0;
				if (offset >= ledger.size) continue;
				while (offset < ledger.size && budget > 0) {
					const read = readSlice(ledger, offset, Math.min(budget, READ_WINDOW_MAX_BYTES), request.maxChars, seen);
					budget -= Math.max(1, read.endOffset - offset);
					if (read.endOffset <= offset) {
						if (read.heldForBudget) budgetHeld = true;
						break;
					}
					if (read.restricted) {
						state.sessions[ledger.key] = { offset: read.endOffset, size: ledger.size, restricted: true };
						advanced = true;
						break;
					}
					if (read.useful) {
						if (advanced) persist();
						return {
							slice: {
								sessionId: ledger.sessionId,
								root: ledger.root,
								text: read.text,
								succeededCommands: read.succeededCommands,
								observedReads: read.observedReads,
								advance: {
									key: ledger.key,
									cursor: { offset: read.endOffset, size: ledger.size },
									seenCalls: read.callIds,
								},
							},
							exhausted: false,
						};
					}
					// Nothing worth a model call here: advance past it deterministically.
					offset = read.endOffset;
					for (const id of read.callIds) seen.add(id);
					state.seenCalls.push(...read.callIds);
					state.sessions[ledger.key] = { offset, size: ledger.size };
					advanced = true;
				}
				if (budget <= 0) {
					if (advanced) persist();
					return { slice: null, exhausted: false };
				}
			}
			if (advanced) persist();
			return { slice: null, exhausted: !budgetHeld };
		},
		commit(slice) {
			const state = load();
			state.sessions[slice.advance.key] = slice.advance.cursor;
			state.seenCalls.push(...slice.advance.seenCalls);
			persist();
		},
	};
}

interface SliceRead {
	endOffset: number;
	/** The read stopped at a call whose result lies past this budget-cut window; a fresh budget resumes it. */
	heldForBudget?: boolean;
	text: string;
	useful: boolean;
	restricted: boolean;
	callIds: string[];
	succeededCommands: Set<string>;
	observedReads: Map<string, string[]>;
}

/**
 * Read complete JSONL lines from `offset` and render them until the character
 * budget is spent. A tool call and its result are joined by call id inside the
 * read window; a result whose call fell in an earlier window is skipped.
 */
function readSlice(
	ledger: SessionLedgerStat,
	offset: number,
	maxBytes: number,
	maxChars: number,
	seen: ReadonlySet<string>,
): SliceRead {
	const empty: SliceRead = {
		endOffset: offset,
		text: "",
		useful: false,
		restricted: false,
		callIds: [],
		succeededCommands: new Set(),
		observedReads: new Map(),
	};
	let buffer: Buffer;
	try {
		buffer = readBytes(ledger.path, offset, Math.min(maxBytes, ledger.size - offset));
	} catch {
		return empty;
	}
	const atEnd = offset + buffer.length >= ledger.size;
	const lastNewline = buffer.lastIndexOf(0x0a);
	// A final line without its newline may still be being written.
	if (lastNewline < 0) return atEnd ? empty : { ...empty, endOffset: offset + buffer.length };
	const lines: Array<{ text: string; start: number; end: number }> = [];
	let start = 0;
	while (start <= lastNewline) {
		const end = buffer.indexOf(0x0a, start);
		lines.push({ text: buffer.subarray(start, end).toString("utf8"), start: offset + start, end: offset + end + 1 });
		start = end + 1;
	}
	const calls = new Map<string, PendingCall>();
	const rendered: string[] = [];
	const callIds: string[] = [];
	const succeededCommands = new Set<string>();
	const observedReads = new Map<string, string[]>();
	let chars = 0;
	let step = 0;
	let commandWorth = false;
	let sourceReads = 0;
	let endOffset = offset;
	let stoppedByChars = false;
	let heldForBudget = false;
	/** Start of the last result line taken; a result after a pending call means the session moved on. */
	let lastResultStart = -1;
	for (const line of lines) {
		const entry = parseLine(line.text);
		if (entry?.kind === "custom" && entry.customType === FLOW_RESTRICTION_ENTRY_TYPE) {
			return {
				endOffset: line.end,
				text: "",
				useful: false,
				restricted: true,
				callIds,
				succeededCommands,
				observedReads,
			};
		}
		const rendering = entry === null ? null : renderEntry(entry, calls, seen, ledger.root, line.start);
		if (rendering !== null) {
			const cost = rendering.items.reduce((total, item) => total + (item.line.length > 0 ? item.line.length + 1 : 0), 0);
			// Stop before this line, leaving it and the call it resolves for the next
			// slice, unless that call opened this slice: then stopping would leave no
			// progress, so the result is taken over budget.
			const resolvesFirstCall = rendering.resolves !== null && calls.get(rendering.resolves)?.start === offset;
			if (chars + cost > maxChars && rendered.length > 0 && !resolvesFirstCall) {
				stoppedByChars = true;
				break;
			}
			if (rendering.resolves !== null) {
				calls.delete(rendering.resolves);
				lastResultStart = line.start;
			}
			for (const item of rendering.items) {
				if (item.callId !== null) callIds.push(item.callId);
				if (item.line.length > 0) {
					step += item.counted ? 1 : 0;
					rendered.push(item.counted ? `${step}. ${item.line}` : item.line);
					chars += item.line.length + 1;
				}
				if (item.succeeded !== null) succeededCommands.add(item.succeeded);
				if (item.read !== null) recordObservedRead(observedReads, item.read.path, item.read.excerpt);
				if (item.worthReview === "command") commandWorth = true;
				else if (item.worthReview === "source") sourceReads += 1;
			}
		}
		endOffset = line.end;
	}
	// A tool call whose result this slice did not take must be read again with
	// it: stopping after the call would leave the next slice a result with no
	// call, and the command or read it proves would be lost for good.
	let earliestPending = Number.POSITIVE_INFINITY;
	for (const call of calls.values()) earliestPending = Math.min(earliestPending, call.start);
	if (earliestPending < endOffset) {
		if (earliestPending > offset) endOffset = earliestPending;
		else {
			// The call opens this read, so rolling back makes no progress. Hold here
			// when a larger read can still reach the result (this window was cut by
			// the per-wake budget) or when the ledger simply ends before it (a live
			// session has not written it yet). A call the session moved on from (a
			// later result exists) or one no window can pair is abandoned, so a
			// cancelled tool or an oversize line cannot pin the cursor.
			const budgetCut = !stoppedByChars && !atEnd && maxBytes < READ_WINDOW_MAX_BYTES;
			const awaitingResult = atEnd && !stoppedByChars && lastResultStart < earliestPending;
			if (budgetCut || awaitingResult) endOffset = offset;
			heldForBudget = budgetCut;
		}
	}
	return {
		endOffset,
		text: rendered.join("\n"),
		useful: commandWorth || sourceReads >= SOURCE_READS_WORTH_REVIEW,
		restricted: false,
		heldForBudget,
		callIds,
		succeededCommands,
		observedReads,
	};
}

/** A tool call read in this slice whose result has not been taken yet. */
interface PendingCall {
	name: string;
	args: Record<string, unknown>;
	/** Ledger offset of the call's own line, where a rollback resumes. */
	start: number;
}

interface EntryRendering {
	/** Call id this result line resolves, retired only once the line is taken. */
	resolves: string | null;
	items: RenderedItem[];
}

/** One observation a ledger line yields. A gateway chain's result yields one per settled step. */
interface RenderedItem {
	line: string;
	counted: boolean;
	/** Unique id of the observation, for fork deduplication. */
	callId: string | null;
	succeeded: string | null;
	/** A successful read's repository-relative path and the excerpt shown for it, for source evidence. */
	read: { path: string; excerpt: string } | null;
	/** `command` for a non-trivial shell command, `source` for a successful source read, else null. */
	worthReview: "command" | "source" | null;
}

/** Source reads that make a stretch worth review on their own, without a shell command. */
const SOURCE_READS_WORTH_REVIEW = 2;

function renderEntry(
	entry: Record<string, unknown>,
	calls: Map<string, PendingCall>,
	seen: ReadonlySet<string>,
	root: string,
	lineStart: number,
): EntryRendering | null {
	if (entry.kind !== "message") return null;
	const payload = record(entry.payload);
	if (entry.role === "user") {
		const text = typeof payload.operatorText === "string" ? payload.operatorText : payload.text;
		if (typeof text !== "string" || text.trim().length === 0) return null;
		return {
			resolves: null,
			items: [
				{
					line: `task: ${shortText(redactSecretString(text), TASK_MAX_CHARS)}`,
					counted: false,
					callId: null,
					succeeded: null,
					read: null,
					worthReview: null,
				},
			],
		};
	}
	if (entry.role === "tool_call") {
		const id = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
		const name = typeof payload.name === "string" ? payload.name : null;
		if (id === null || name === null) return null;
		calls.set(id, { name, args: record(payload.args), start: lineStart });
		return null;
	}
	if (entry.role !== "tool_result") return null;
	const id = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
	if (id === null) return null;
	const call = calls.get(id);
	if (call === undefined) return null;
	if (seen.has(id)) return { resolves: id, items: [] };
	const result = record(payload.result);
	const failed = payload.isError === true || payload.outcome !== "ok";
	// A gateway chain ran real steps; each settled, admitted child speaks for
	// itself with its own id, exactly as the ledger's other readers expand it.
	const children = gatewayChainReceipts(call.name, result);
	if (children.length > 0) {
		return {
			resolves: id,
			items: children.flatMap((child) => {
				const childId = `${id}:${child.id}`;
				if (seen.has(childId)) return [];
				const childResult = record(child.result);
				const childFailed =
					child.admission.outcome !== "ok" ||
					child.admission.decision !== "allowed" ||
					record(childResult.details).kind !== "ok";
				return [renderOutcome(childId, child.capability, child.args, childResult, childFailed, root)];
			}),
		};
	}
	// A single gateway call stands for the capability it ran.
	const effective = effectiveToolCall(call.name, call.args, result.details);
	return {
		resolves: id,
		items: [renderOutcome(id, effective.toolName, effective.args ?? {}, result, failed, root)],
	};
}

function renderOutcome(
	id: string,
	name: string,
	args: Record<string, unknown>,
	result: Record<string, unknown>,
	failed: boolean,
	root: string,
): RenderedItem {
	const details = record(result.details);
	const command = name === ToolNames.Bash && typeof args.command === "string" ? args.command : null;
	if (command === null) {
		const detail = typeof args.path === "string" ? args.path : typeof args.pattern === "string" ? args.pattern : "";
		const label = shortText(`${name}${detail ? ` ${redactSecretString(detail)}` : ""}`, COMMAND_MAX_CHARS);
		// A source investigation can teach a repository fact with no command
		// behind it. A successful read carries a bounded excerpt so a lesson can
		// quote it; the quote is verified against the checkout before it counts.
		const path = !failed && name === ToolNames.Read && detail.length > 0 ? repositoryRelativePath(detail, [root]) : null;
		const excerpt = path === null ? "" : shortText(redactSecretString(resultText(result)), READ_EXCERPT_MAX_CHARS);
		return {
			line: `${label}${failed ? " FAILED" : ""}${excerpt ? ` => ${excerpt}` : ""}`,
			counted: true,
			callId: id,
			succeeded: null,
			read: path === null || excerpt.length === 0 ? null : { path, excerpt },
			worthReview: !failed && detail.length > 0 ? "source" : null,
		};
	}
	const redacted = redactSecretString(command);
	// Rendered exactly when it is one short line and carries no secret, so the
	// lesson pass can copy it and the host can compare it byte for byte.
	const exact = redacted === command && !/[\r\n]/u.test(command) && command.length <= COMMAND_MAX_CHARS;
	const shown = exact ? command : shortText(redacted, COMMAND_MAX_CHARS);
	// The same receipt the live guardian accepts: the shell tool's own success
	// outcome and a zero exit it reported.
	const succeeded = !failed && details.outcome === "success" && details.exitCode === 0;
	const worthReview = TRIVIAL_COMMAND.test(command.trim()) ? null : "command";
	if (succeeded) {
		return {
			line: `ok: ${shown}`,
			counted: true,
			callId: id,
			succeeded: exact ? command : null,
			read: null,
			worthReview,
		};
	}
	return {
		line: `FAILED: ${shown} => ${shortText(redactSecretString(diagnostic(result)), DIAGNOSTIC_MAX_CHARS)}`,
		counted: true,
		callId: id,
		succeeded: null,
		read: null,
		worthReview,
	};
}

function resultText(result: Record<string, unknown>): string {
	const content = Array.isArray(result.content) ? result.content : [];
	return content
		.map((block) => record(block).text)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

function diagnostic(result: Record<string, unknown>): string {
	const content = Array.isArray(result.content) ? result.content : [];
	for (const block of content) {
		const text = record(block).text;
		if (typeof text !== "string") continue;
		const lines = text
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);
		return (
			lines.find((line) => /\b(error|failed|cannot|not found|missing|denied|expected|fatal)\b/iu.test(line)) ??
			lines[0] ??
			""
		);
	}
	return "";
}

function readBytes(path: string, offset: number, length: number): Buffer {
	const buffer = Buffer.alloc(Math.max(0, length));
	if (length <= 0) return buffer;
	const fd = openSync(path, "r");
	try {
		const read = readSync(fd, buffer, 0, length, offset);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

function parseLine(text: string): Record<string, unknown> | null {
	if (text.trim().length === 0) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		// A partial first line after a rewritten ledger or a mid-line resume carries nothing usable.
		return null;
	}
}

function readCursorFile(path: string): CursorFile | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CursorFile>;
		if (parsed.version !== CURSOR_FILE_VERSION || parsed.repositories === null || typeof parsed.repositories !== "object")
			return null;
		return parsed as CursorFile;
	} catch {
		// Absent or unreadable: every session reads as unreviewed.
		return null;
	}
}

function readRepositoryCursors(path: string, repositoryKey: string): RepositoryCursors | null {
	const entry = readCursorFile(path)?.repositories[repositoryKey];
	if (entry === undefined || entry === null || typeof entry !== "object") return null;
	const sessions: Record<string, SessionCursor> = {};
	for (const [key, value] of Object.entries(record(entry.sessions))) {
		const cursor = record(value);
		if (typeof cursor.offset !== "number" || typeof cursor.size !== "number") continue;
		sessions[key] = {
			offset: cursor.offset,
			size: cursor.size,
			...(cursor.restricted === true ? { restricted: true as const } : {}),
		};
	}
	const seenCalls = Array.isArray(entry.seenCalls)
		? entry.seenCalls.filter((id): id is string => typeof id === "string")
		: [];
	return { sessions, seenCalls };
}

function boundCursors(cursors: RepositoryCursors): RepositoryCursors {
	const keys = Object.keys(cursors.sessions);
	const sessions =
		keys.length <= CURSOR_SESSION_LIMIT
			? cursors.sessions
			: Object.fromEntries(keys.slice(-CURSOR_SESSION_LIMIT).map((key) => [key, cursors.sessions[key] as SessionCursor]));
	return { sessions, seenCalls: [...new Set(cursors.seenCalls)].slice(-SEEN_CALL_LIMIT) };
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function shortText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
