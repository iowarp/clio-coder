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

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../tools/surface.js";
import { redactSecretString } from "../safety/redaction.js";
import type { SessionEntry } from "../session/index.js";
import type { SessionLedgerStat } from "../session/related-ledgers.js";
import { sessionLedgersForRoots } from "../session/related-ledgers.js";
import { succeededCommandForms, successfulShellReceipt } from "./command-evidence.js";
import { recordObservedRead, repositoryRelativePath } from "./lesson-evidence.js";
import { observationDigest } from "./observations.js";
import { relatedRepositoryRoots } from "./operations.js";

export interface CompletedLessonSource {
	readonly revision: string;
	readonly refs: readonly string[];
	readonly text: string;
	readonly succeededCommands: ReadonlySet<string>;
	readonly observedReads: ReadonlyMap<string, readonly string[]>;
	/** Every exact shell command the task ran, in order, with its receipt; the host's own recipe evidence. */
	readonly commandRuns: readonly CommandRun[];
	/** Tool-call identities the rendered excerpt showed; history review skips them once retention settles. */
	readonly callIds?: readonly string[];
}

export interface CommandRun {
	readonly command: string;
	readonly ok: boolean;
	/** First diagnostic line of a failed run; empty for a success. */
	readonly diagnostic: string;
}

/** Reuse history's evidence renderer for one completed task, including process-to-process resume. */
export function completedLessonSource(entries: readonly SessionEntry[], root: string): CompletedLessonSource | null {
	let end = entries.length;
	// A recall-only new request must not hide the preceding task awaiting retention.
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.kind !== "message" || entry.role !== "user") continue;
		const task = entries.slice(index, end);
		const lastMessage = [...task].reverse().find((entry) => entry.kind === "message");
		const terminal = record(lastMessage?.kind === "message" ? lastMessage.payload : null);
		if (
			task.some((entry) => entry.kind === "message" && entry.role === "tool_result") &&
			lastMessage?.kind === "message" &&
			lastMessage.role === "assistant" &&
			(typeof terminal.text === "string" ? terminal.text.trim().length > 0 : Array.isArray(terminal.content)) &&
			(terminal.stopReason === undefined || terminal.stopReason === "stop") &&
			!(Array.isArray(terminal.content) && terminal.content.some((block) => record(block).type === "toolCall"))
		) {
			const source = renderCompletedLessonSource(task, root);
			if (source) return source;
		}
		end = index;
	}
	return null;
}

function renderCompletedLessonSource(entries: readonly SessionEntry[], root: string): CompletedLessonSource | null {
	const calls = new Map<string, PendingCall>();
	const lines: string[] = [];
	const refs: string[] = [];
	const succeededCommands = new Set<string>();
	const observedReads = new Map<string, string[]>();
	const commandRuns: CommandRun[] = [];
	const callIds: string[] = [];
	let worthwhile = false;
	let sourceReads = 0;
	let chars = 0;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry) continue;
		const rendered = renderEntry(entry as unknown as Record<string, unknown>, calls, new Set(), root, index);
		if (!rendered) continue;
		if (rendered.resolves !== null) calls.delete(rendered.resolves);
		let full = false;
		for (const item of rendered.items) {
			// Receipts are evidence whether or not their line fits the model's excerpt.
			commandRuns.push(...item.runs);
			for (const form of item.succeeded) succeededCommands.add(form);
			full ||= chars + item.line.length > 4000;
			if (full) continue;
			lines.push(item.line);
			chars += item.line.length + 1;
			refs.push(entry.turnId);
			if (item.callId !== null) callIds.push(item.callId);
			if (item.read !== null) recordObservedRead(observedReads, item.read.path, item.read.excerpt);
			if (item.worthReview === "command") worthwhile = true;
			if (item.worthReview === "source") sourceReads++;
		}
	}
	if (calls.size > 0 || (!worthwhile && sourceReads < SOURCE_READS_WORTH_REVIEW)) return null;
	const text = lines.join("\n");
	return {
		revision: observationDigest([refs, text]),
		refs,
		text,
		succeededCommands,
		observedReads,
		commandRuns,
		callIds,
	};
}

/**
 * Record tool calls a settled completed-task retention already reviewed, so
 * history review passes over them without another model call. A session that
 * closes right after its task used to be mined twice: once by retention and
 * again by the guardian reading the same ledger as history.
 */
export function recordReviewedHistoryCalls(stateDir: string, cwd: string, callIds: readonly string[]): void {
	const repositoryKey = relatedRepositoryRoots(cwd)?.repository.key ?? null;
	if (repositoryKey === null || callIds.length === 0) return;
	const path = historyReviewCursorPath(stateDir);
	try {
		withStateFileLockSync(
			path,
			() => {
				const file = readCursorFile(path) ?? { version: CURSOR_FILE_VERSION, repositories: {} };
				const current = readRepositoryCursors(path, repositoryKey) ?? { sessions: {}, seenCalls: [] };
				const known = new Set(current.seenCalls);
				file.repositories[repositoryKey] = boundCursors({
					sessions: current.sessions,
					seenCalls: [...current.seenCalls, ...callIds.filter((id) => !known.has(id))],
				});
				safeResourceWrite(path, `${JSON.stringify(file)}\n`);
			},
			{ timeoutMs: 100 },
		);
	} catch {
		// An optimization only: a lost write costs one repeated review.
	}
}

const CURSOR_FILE_VERSION = 1;
/** Sessions remembered per repository; the oldest cursors fall off first. */
const CURSOR_SESSION_LIMIT = 1_000;
/** Reviewed tool-call ids remembered per repository for fork deduplication. */
const SEEN_CALL_LIMIT = 4_000;
/** Largest window one read takes from a ledger; a slice may take several. */
const READ_WINDOW_MAX_BYTES = 4 * 1024 * 1024;
/**
 * First window a slice reads. A slice is a few thousand rendered characters,
 * so reading the largest window every time read and materialized megabytes to
 * use kilobytes; the window grows only when a line or a call's result needs it.
 */
const READ_WINDOW_INITIAL_BYTES = 256 * 1024;
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
	/** Ledger file identity the offset was recorded against; absent on cursors written before it existed. */
	identity?: string;
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
	/** Exact shell commands the excerpt ran, in order, with their receipts. */
	commandRuns?: ReadonlyArray<CommandRun>;
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
	const ledgerIdentity = (key: string): string | null => {
		try {
			const info = statSync(join(input.stateDir, "sessions", key, "current.jsonl"));
			return `${info.dev}:${info.ino}`;
		} catch {
			return null; /* A removed ledger has no cursor worth keeping. */
		}
	};
	/** Another process's progress is merged in, never overwritten by a stale copy. */
	const refresh = (): RepositoryCursors => {
		const disk = readRepositoryCursors(path, repositoryKey ?? "");
		cursors =
			cursors === null
				? (disk ?? { sessions: {}, seenCalls: [] })
				: disk === null
					? cursors
					: mergeCursors(disk, cursors, ledgerIdentity);
		return cursors;
	};
	const persist = (): void => {
		if (repositoryKey === null || cursors === null) return;
		try {
			withStateFileLockSync(
				path,
				() => {
					const file = readCursorFile(path) ?? { version: CURSOR_FILE_VERSION, repositories: {} };
					const disk = readRepositoryCursors(path, repositoryKey);
					const merged = disk === null || cursors === null ? cursors : mergeCursors(disk, cursors, ledgerIdentity);
					if (merged === null) return;
					cursors = merged;
					file.repositories[repositoryKey] = boundCursors(merged);
					safeResourceWrite(path, `${JSON.stringify(file)}\n`);
				},
				{ timeoutMs: 100 },
			);
		} catch {
			// Cursors are an optimization: a lost write costs one repeated review, never correctness.
		}
	};
	// The bytes of the last window read, so consecutive slices of one ledger read
	// only what they have not seen and are charged only for that.
	let cache: { key: string; identity: string; start: number; bytes: Buffer } | null = null;
	/** At most `length` bytes from `offset`, of which no more than `maxFresh` come from disk. */
	const readWindow = (
		ledger: SessionLedgerStat,
		offset: number,
		length: number,
		maxFresh: number,
	): { buffer: Buffer; fresh: number } => {
		const cached = cache;
		if (
			cached !== null &&
			cached.key === ledger.key &&
			cached.identity === ledger.identity &&
			cached.start + cached.bytes.length <= ledger.size &&
			offset >= cached.start &&
			offset <= cached.start + cached.bytes.length
		) {
			const have = cached.bytes.subarray(offset - cached.start);
			if (have.length >= length) return { buffer: have.subarray(0, length), fresh: 0 };
			const extra = readBytes(ledger.path, offset + have.length, Math.max(0, Math.min(length - have.length, maxFresh)));
			const buffer = Buffer.concat([have, extra]);
			cache = { key: ledger.key, identity: ledger.identity, start: offset, bytes: buffer };
			return { buffer, fresh: extra.length };
		}
		const buffer = readBytes(ledger.path, offset, Math.max(0, Math.min(length, maxFresh)));
		cache = { key: ledger.key, identity: ledger.identity, start: offset, bytes: buffer };
		return { buffer, fresh: buffer.length };
	};
	return {
		repositoryKey,
		next(request) {
			if (related === null) return { slice: null, exhausted: true };
			const state = refresh();
			const nowMs = request.nowMs ?? Date.now();
			const seen = new Set(state.seenCalls);
			const ledgers = sessionLedgersForRoots(input.stateDir, related.roots, {
				excludeSessionId: input.currentSessionId,
			}).filter((ledger) => request.horizonMs === Number.POSITIVE_INFINITY || nowMs - ledger.mtimeMs <= request.horizonMs);
			// Charged for bytes actually read from disk, not for the cursor distance consumed.
			let budget = request.maxReadBytes;
			let advanced = false;
			// A call held for its result past this request's budget: the horizon is
			// not exhausted, and the next request with a fresh budget pairs it.
			let budgetHeld = false;
			for (const ledger of ledgers) {
				const prior = state.sessions[ledger.key];
				// A cursor recorded against another file identity, or past the end of a
				// shorter file, belongs to a rewritten ledger; read it again from the
				// start and let the seen-call set drop what was already reviewed.
				const sameLedger = prior !== undefined && (prior.identity === undefined || prior.identity === ledger.identity);
				if (sameLedger && prior?.restricted) continue;
				let offset = sameLedger && prior !== undefined && prior.offset <= ledger.size ? prior.offset : 0;
				if (offset >= ledger.size) continue;
				let window = READ_WINDOW_INITIAL_BYTES;
				while (offset < ledger.size && budget > 0) {
					const remaining = budget;
					const read = readSlice(
						ledger,
						offset,
						Math.min(window, ledger.size - offset),
						request.maxChars,
						seen,
						(target, at, length) => readWindow(target, at, length, remaining),
						window >= READ_WINDOW_MAX_BYTES,
					);
					budget -= read.bytesRead;
					if (read.endOffset <= offset) {
						// A line or a call's result lies past what was read. Out of budget,
						// the next request resumes from the bytes already held; otherwise
						// widen the window, paying only for the bytes not yet read.
						if (read.needsWider) {
							if (budget <= 0) {
								budgetHeld = true;
								break;
							}
							if (window < READ_WINDOW_MAX_BYTES && offset + window < ledger.size) {
								window = Math.min(READ_WINDOW_MAX_BYTES, window * 4);
								continue;
							}
						}
						break;
					}
					if (read.restricted) {
						state.sessions[ledger.key] = {
							offset: read.endOffset,
							size: ledger.size,
							restricted: true,
							identity: ledger.identity,
						};
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
								commandRuns: read.commandRuns,
								advance: {
									key: ledger.key,
									cursor: { offset: read.endOffset, size: ledger.size, identity: ledger.identity },
									seenCalls: read.callIds,
								},
							},
							exhausted: false,
						};
					}
					// Nothing worth a model call here: advance past it deterministically.
					offset = read.endOffset;
					window = READ_WINDOW_INITIAL_BYTES;
					for (const id of read.callIds) seen.add(id);
					state.seenCalls.push(...read.callIds);
					state.sessions[ledger.key] = { offset, size: ledger.size, identity: ledger.identity };
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
			const state = refresh();
			const previous = state.sessions[slice.advance.key];
			// Monotonic within one ledger identity: a slice read before another
			// process moved further never moves the cursor back.
			if (
				previous === undefined ||
				previous.identity !== slice.advance.cursor.identity ||
				previous.offset < slice.advance.cursor.offset
			)
				state.sessions[slice.advance.key] = slice.advance.cursor;
			state.seenCalls.push(...slice.advance.seenCalls);
			persist();
		},
	};
}

/**
 * Union of two processes' progress for one repository. Within one ledger
 * identity the furthest offset wins (and a restriction sticks); across
 * identities only the cursor recorded against the ledger's current file
 * survives, because an offset into a replaced file means nothing.
 */
function mergeCursors(
	disk: RepositoryCursors,
	mine: RepositoryCursors,
	identityOf: (key: string) => string | null,
): RepositoryCursors {
	const sessions: Record<string, SessionCursor> = { ...disk.sessions };
	for (const [key, cursor] of Object.entries(mine.sessions)) {
		const other = sessions[key];
		if (other === undefined) {
			sessions[key] = cursor;
			continue;
		}
		if (other.identity === cursor.identity || other.identity === undefined || cursor.identity === undefined) {
			const furthest = cursor.offset >= other.offset ? cursor : other;
			sessions[key] = {
				...furthest,
				...(cursor.restricted || other.restricted ? { restricted: true as const } : {}),
				...((furthest.identity ?? cursor.identity ?? other.identity)
					? { identity: furthest.identity ?? cursor.identity ?? other.identity }
					: {}),
			};
			continue;
		}
		const current = identityOf(key);
		if (current === cursor.identity) sessions[key] = cursor;
		else if (current !== other.identity) delete sessions[key];
	}
	const seen = new Set(disk.seenCalls);
	return { sessions, seenCalls: [...disk.seenCalls, ...mine.seenCalls.filter((id) => !seen.has(id))] };
}

interface SliceRead {
	endOffset: number;
	/** Bytes this read took from disk; bytes already held from the previous window cost nothing. */
	bytesRead: number;
	/** No progress because a line or a call's result lies past this window; a wider window resumes it. */
	needsWider?: boolean;
	text: string;
	useful: boolean;
	restricted: boolean;
	callIds: string[];
	succeededCommands: Set<string>;
	observedReads: Map<string, string[]>;
	commandRuns: CommandRun[];
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
	readWindow: (ledger: SessionLedgerStat, offset: number, length: number) => { buffer: Buffer; fresh: number },
	widestWindow: boolean,
): SliceRead {
	const empty: SliceRead = {
		endOffset: offset,
		bytesRead: 0,
		text: "",
		useful: false,
		restricted: false,
		callIds: [],
		succeededCommands: new Set(),
		observedReads: new Map(),
		commandRuns: [],
	};
	let buffer: Buffer;
	let bytesRead = 0;
	try {
		const read = readWindow(ledger, offset, Math.min(maxBytes, ledger.size - offset));
		buffer = read.buffer;
		bytesRead = read.fresh;
	} catch {
		return empty;
	}
	empty.bytesRead = bytesRead;
	const atEnd = offset + buffer.length >= ledger.size;
	// Only a full read of the widest window may skip or abandon what does not fit;
	// a read the budget shortened resumes with more bytes instead.
	const widest = widestWindow && buffer.length >= Math.min(maxBytes, ledger.size - offset);
	const lastNewline = buffer.lastIndexOf(0x0a);
	// A final line without its newline may still be being written. A line
	// longer than the widest window is skipped, as it always was.
	if (lastNewline < 0) {
		if (atEnd) return empty;
		return widest ? { ...empty, endOffset: offset + buffer.length } : { ...empty, needsWider: true };
	}
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
	const commandRuns: CommandRun[] = [];
	let chars = 0;
	let step = 0;
	let commandWorth = false;
	let sourceReads = 0;
	let endOffset = offset;
	let stoppedByChars = false;
	let needsWider = false;
	/** Start of the last result line taken; a result after a pending call means the session moved on. */
	let lastResultStart = -1;
	for (const line of lines) {
		const entry = parseLine(line.text);
		if (entry?.kind === "custom" && entry.customType === FLOW_RESTRICTION_ENTRY_TYPE) {
			return {
				endOffset: line.end,
				bytesRead,
				text: "",
				useful: false,
				restricted: true,
				callIds,
				succeededCommands,
				observedReads,
				commandRuns,
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
				for (const form of item.succeeded) succeededCommands.add(form);
				commandRuns.push(...item.runs);
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
			// when a wider read can still reach the result (this window was not the
			// widest) or when the ledger simply ends before it (a live session has
			// not written it yet). A call the session moved on from (a later result
			// exists) or one no window can pair is abandoned, so a cancelled tool or
			// an oversize line cannot pin the cursor.
			const windowCut = !stoppedByChars && !atEnd && !widest;
			const awaitingResult = atEnd && !stoppedByChars && lastResultStart < earliestPending;
			if (windowCut || awaitingResult) endOffset = offset;
			needsWider = windowCut;
		}
	}
	return {
		endOffset,
		bytesRead,
		text: rendered.join("\n"),
		useful: commandWorth || sourceReads >= SOURCE_READS_WORTH_REVIEW,
		restricted: false,
		needsWider,
		callIds,
		succeededCommands,
		observedReads,
		commandRuns,
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
	/** Exact commands this receipt proves ran with exit 0: the command, and each segment of a pure `&&` chain. */
	succeeded: readonly string[];
	/** A successful read's repository-relative path and the excerpt shown for it, for source evidence. */
	read: { path: string; excerpt: string } | null;
	/** `command` for a non-trivial shell command, `source` for a successful source read, else null. */
	worthReview: "command" | "source" | null;
	/** Exact shell commands and their receipts; empty for anything else or a command shown inexactly. */
	runs: readonly CommandRun[];
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
					succeeded: [],
					read: null,
					worthReview: null,
					runs: [],
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
		// Repository-relative, as the lesson prompt asks: an absolute checkout path is
		// noise that also made two runs of the same session read differently.
		const shownDetail = typeof args.path === "string" ? (repositoryRelativePath(detail, [root]) ?? detail) : detail;
		const label = shortText(`${name}${shownDetail ? ` ${redactSecretString(shownDetail)}` : ""}`, COMMAND_MAX_CHARS);
		// A source investigation can teach a repository fact with no command
		// behind it. A successful read carries a bounded excerpt so a lesson can
		// quote it; the quote is verified against the checkout before it counts.
		const path = !failed && name === ToolNames.Read && detail.length > 0 ? repositoryRelativePath(detail, [root]) : null;
		// What Clio's own verification route answered is what makes the recipe a
		// session found next worth keeping: a bare "verify" line hid that it found nothing.
		const verdict =
			name === ToolNames.Verify
				? shortText(redactSecretString(resultText(result).split("\n")[0] ?? ""), DIAGNOSTIC_MAX_CHARS)
				: "";
		const excerpt = path === null ? verdict : shortText(redactSecretString(resultText(result)), READ_EXCERPT_MAX_CHARS);
		return {
			line: `${label}${failed ? " FAILED" : ""}${excerpt ? ` => ${excerpt}` : ""}`,
			counted: true,
			callId: id,
			succeeded: [],
			read: path === null || excerpt.length === 0 ? null : { path, excerpt },
			worthReview: !failed && detail.length > 0 ? "source" : null,
			runs: [],
		};
	}
	const redacted = redactSecretString(command);
	// Rendered exactly when it is one short line and carries no secret, so the
	// lesson pass can copy it and the host can compare it byte for byte.
	const exact = redacted === command && !/[\r\n]/u.test(command) && command.length <= COMMAND_MAX_CHARS;
	const shown = exact ? command : shortText(redacted, COMMAND_MAX_CHARS);
	// The same receipt the live guardian accepts: the shell tool's own success
	// outcome and a zero exit it reported.
	const succeeded = successfulShellReceipt(!failed, details);
	const worthReview = TRIVIAL_COMMAND.test(command.trim()) ? null : "command";
	if (succeeded) {
		// The exact command and, for a pure `&&` chain run from the root, each
		// of its segments: exit 0 proves every one of them finished with exit 0.
		const forms = exact ? succeededCommandForms(command, root, typeof args.cwd === "string" ? args.cwd : undefined) : [];
		return {
			line: `ok: ${shown}`,
			counted: true,
			callId: id,
			succeeded: forms,
			read: null,
			worthReview,
			runs: forms.map((form) => ({ command: form, ok: true, diagnostic: "" })),
		};
	}
	const failure = shortText(redactSecretString(diagnostic(result)), DIAGNOSTIC_MAX_CHARS);
	return {
		line: `FAILED: ${shown} => ${failure}`,
		counted: true,
		callId: id,
		succeeded: [],
		read: null,
		worthReview,
		runs: exact ? [{ command, ok: false, diagnostic: failure }] : [],
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
			...(typeof cursor.identity === "string" ? { identity: cursor.identity } : {}),
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
