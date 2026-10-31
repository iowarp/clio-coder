/**
 * A run's display feed: the full rows a worker's dashboard card and `clio-coder fleet view --follow` stream from.
 *
 * The run's telemetry journal keeps only the structural projection of each feed row (kind, type, outcome, duration,
 * ids), so a viewer in another process cannot rebuild the worker's prose, call descriptors, reasons or token counts
 * from it. This file is run state like the session ledger: local, append-only, never shared and never folded into
 * telemetry (#434). It sits in the run's state directory next to its recordings, `<stateDir>/runs/<runId>/feed.jsonl`,
 * and leaves with the run's ledger row.
 *
 * Format version 1, one JSON object per line, newest last: `{ v: 1, seq, at, kind, ... }`, where the rest is one
 * {@link RunEventJournalBody}. `seq` increases by one per line and run. Every string is secret-redacted before it is
 * written. Prose streams in coalesced rows that can split a credential, so a text row holds back its last two words
 * and the next row, or the next line of any other kind, writes them.
 *
 * Bounding follows the telemetry journal: past {@link RUN_FEED_CAP_BYTES} display `event` rows are dropped behind one
 * `journal_truncated` row, while `open`, `result` and `terminal` always land. The `terminal` row closes the feed.
 * Nothing here throws into a dispatch.
 */

import {
	closeSync,
	constants,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import type { ToolCallFacts } from "../../tools/agent-tools.js";
import { createRedactionTally, redactSecretsDeep } from "../evidence/redact.js";
import type { RunEventJournalBody } from "./run-event-journal.js";

export const RUN_FEED_VERSION = 1;
export const RUN_FEED_FILE = "feed.jsonl";
/** Per-run size cap; crossing it drops display rows behind one marker. */
export const RUN_FEED_CAP_BYTES = 2 * 1024 * 1024;
/** Tail bytes a reader pulls, so following a capped feed stays cheap. */
export const RUN_FEED_READ_TAIL_BYTES = 256 * 1024;
/** Prose a text row may hold back while it waits for a word boundary. */
const TEXT_CARRY_MAX_CHARS = 4096;
/** Runs whose writer state one process keeps; an evicted run reloads it from its file. */
const WRITER_LIMIT = 256;

export type RunFeedLine = { v: typeof RUN_FEED_VERSION; seq: number; at: string } & RunEventJournalBody;

/**
 * Run ids are generated base36, and fleet and gate ids add a prefix and hex. Nothing legitimate contains a path
 * separator, so anything that does is refused before a path is built from it.
 */
function isSafeRunId(runId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) && runId !== "." && runId !== "..";
}

function runStateDirectory(stateDir: string, runId: string): string {
	return join(stateDir, "runs", runId);
}

/** One run's feed file. */
export function runFeedPath(runId: string, stateDir: string = clioStateDir()): string {
	return join(runStateDirectory(stateDir, runId), RUN_FEED_FILE);
}

/** The run whose display feed was written most recently, for `/panes open logs` (#434). */
export function newestRunFeedRunId(stateDir: string = clioStateDir()): string | null {
	if (stateRootRemoved()) return null;
	let names: string[];
	try {
		names = readdirSync(join(stateDir, "runs"));
	} catch {
		return null;
	}
	let newest: { runId: string; at: number } | null = null;
	for (const runId of names) {
		if (!isSafeRunId(runId)) continue;
		try {
			const stats = statSync(runFeedPath(runId, stateDir), { throwIfNoEntry: false });
			if (stats === undefined || !stats.isFile()) continue;
			if (newest === null || stats.mtimeMs > newest.at) newest = { runId, at: stats.mtimeMs };
		} catch {
			// A run pruned while the directory is scanned has no feed to follow (#434).
		}
	}
	return newest?.runId ?? null;
}

/** Remove the feeds of runs that left the ledger ring; recordings beside them keep their own authority. */
export function removeRunFeeds(stateDir: string, runIds: Iterable<string>): void {
	for (const runId of runIds) {
		if (!isSafeRunId(runId)) continue;
		try {
			rmSync(runFeedPath(runId, stateDir), { force: true });
		} catch {
			// A feed we could not remove is retained display state, not an error.
		}
	}
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

interface WriterState {
	seq: number;
	bytes: number;
	dropping: boolean;
	closed: boolean;
	/** The held-back tail of the last text row. */
	carry: string;
	carryAt: string;
}

const writers = new Map<string, WriterState>();

/** A run's directory, refusing a symlink or a non-directory where the run state belongs. */
function ensureRunDirectory(stateDir: string, runId: string): string {
	const directory = runStateDirectory(stateDir, runId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	for (const path of [join(stateDir, "runs"), directory]) {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("run state directory is not a regular directory");
	}
	return directory;
}

/** Resume a feed this process did not start, such as a recovered run, from its last lines. */
function loadWriterState(path: string): WriterState {
	const state: WriterState = { seq: 0, bytes: 0, dropping: false, closed: false, carry: "", carryAt: "" };
	const tail = readTail(path, 64 * 1024);
	if (tail === null) return state;
	state.bytes = tail.size;
	for (const raw of tail.text.split("\n")) {
		const line = readRunFeedLine(raw);
		if (line === null) continue;
		state.seq = Math.max(state.seq, line.seq);
		if (line.kind === "journal_truncated") state.dropping = true;
		if (line.kind === "terminal") state.closed = true;
	}
	return state;
}

function writerFor(path: string): WriterState {
	let state = writers.get(path);
	if (state !== undefined) return state;
	state = loadWriterState(path);
	writers.set(path, state);
	for (const [key, held] of writers) {
		if (writers.size <= WRITER_LIMIT) break;
		// An evicted writer's held prose is written now; a later row for it reloads seq from the file.
		if (held.carry.length > 0) writeRow(key, held, { kind: "event", type: "text", detail: held.carry }, held.carryAt);
		writers.delete(key);
	}
	return state;
}

function writeRow(path: string, state: WriterState, body: RunEventJournalBody, at: string): void {
	const row = redactSecretsDeep({ v: RUN_FEED_VERSION, seq: state.seq + 1, at, ...body }, createRedactionTally());
	const line = `${JSON.stringify(row)}\n`;
	const handle = openSync(
		path,
		constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeSync(handle, line);
	} finally {
		closeSync(handle);
	}
	state.seq += 1;
	state.bytes += Buffer.byteLength(line);
}

function writeBounded(path: string, state: WriterState, body: RunEventJournalBody, at: string): void {
	if (body.kind === "event" && (state.dropping || state.bytes >= RUN_FEED_CAP_BYTES)) {
		if (!state.dropping) {
			state.dropping = true;
			writeRow(path, state, { kind: "journal_truncated", reason: "per-run size cap", droppedFromSeq: state.seq + 1 }, at);
		}
		return;
	}
	writeRow(path, state, body, at);
	if (body.kind === "terminal") state.closed = true;
}

/** Split prose at the start of its last two words, the most a credential pattern spans across whitespace. */
function holdBack(text: string): { head: string; tail: string } {
	const words = /\S+\s*$/u;
	const last = text.search(words);
	if (last <= 0) return { head: "", tail: text };
	const previous = text.slice(0, last).search(words);
	const cut = previous < 0 ? last : previous;
	return { head: text.slice(0, cut), tail: text.slice(cut) };
}

/**
 * Append one display row to a run's feed. Best-effort: a feed that cannot be written loses the row, and the dispatch
 * never learns about it.
 */
export function appendRunFeed(runId: string, body: RunEventJournalBody, at: string = new Date().toISOString()): void {
	if (!isSafeRunId(runId) || stateRootRemoved()) return;
	try {
		const stateDir = clioStateDir();
		const path = runFeedPath(runId, stateDir);
		const state = writerFor(path);
		if (state.closed) return;
		if (state.seq === 0 && state.bytes === 0) ensureRunDirectory(stateDir, runId);
		if (body.kind === "event" && body.type === "text" && body.detail !== undefined) {
			const { head, tail } = holdBack(state.carry + body.detail);
			if (state.carry.length === 0) state.carryAt = at;
			if (head.length > 0) writeBounded(path, state, { ...body, detail: head }, state.carryAt);
			state.carry = tail;
			state.carryAt = head.length > 0 ? at : state.carryAt;
			if (state.carry.length > TEXT_CARRY_MAX_CHARS) {
				writeBounded(path, state, { kind: "event", type: "text", detail: state.carry }, state.carryAt);
				state.carry = "";
			}
			return;
		}
		if (state.carry.length > 0) {
			writeBounded(path, state, { kind: "event", type: "text", detail: state.carry }, state.carryAt);
			state.carry = "";
		}
		writeBounded(path, state, body, at);
	} catch {
		// Display state is best-effort; the run's telemetry journal still holds its structural feed.
	}
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

function readTail(path: string, tailBytes: number): { text: string; size: number; headDropped: boolean } | null {
	let handle: number;
	try {
		handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return null;
	}
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - Math.max(0, Math.floor(tailBytes)));
		const chunk = Buffer.alloc(size - start);
		const count = readSync(handle, chunk, 0, chunk.length, start);
		let bytes = chunk.subarray(0, count);
		if (start > 0) {
			const newline = bytes.indexOf(0x0a);
			bytes = bytes.subarray(newline < 0 ? bytes.length : newline + 1);
		}
		return { text: bytes.toString("utf8"), size, headDropped: start > 0 };
	} catch {
		return null;
	} finally {
		closeSync(handle);
	}
}

/** A tool call's facts, read defensively from a producer payload or a feed row. */
export function parseToolCallFacts(value: unknown): ToolCallFacts | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.target !== "string" || record.target.length === 0) return undefined;
	const callFacts: ToolCallFacts = { target: record.target };
	for (const key of [
		"offset",
		"limit",
		"tail",
		"returnedBytes",
		"observationBytes",
		"poolLimitBytes",
		"poolUsedBeforeBytes",
	] as const) {
		const count = record[key];
		if (typeof count === "number" && Number.isFinite(count) && count >= 0) callFacts[key] = count;
	}
	for (const key of ["startLine", "endLine"] as const) {
		const count = record[key];
		if (count === null || (typeof count === "number" && Number.isSafeInteger(count) && count >= 1))
			callFacts[key] = count;
	}
	for (const key of ["partialLine", "truncated", "poolExhausted"] as const) {
		if (typeof record[key] === "boolean") callFacts[key] = record[key];
	}
	if (record.targetTruncated === true) callFacts.targetTruncated = true;
	if (record.rangeUnit === "physical-lines" || record.rangeUnit === "rendered-lines")
		callFacts.rangeUnit = record.rangeUnit;
	return callFacts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString<K extends string>(record: Record<string, unknown>, key: K): { [P in K]?: string } {
	const value = record[key];
	return (typeof value === "string" ? { [key]: value } : {}) as { [P in K]?: string };
}

function optionalCount<K extends string>(record: Record<string, unknown>, key: K): { [P in K]?: number } {
	const value = record[key];
	return (typeof value === "number" && Number.isFinite(value) && value >= 0 ? { [key]: value } : {}) as {
		[P in K]?: number;
	};
}

function readBody(record: Record<string, unknown>): RunEventJournalBody | null {
	switch (record.kind) {
		case "open":
			return typeof record.runId === "string" && typeof record.agentId === "string"
				? { kind: "open", runId: record.runId, agentId: record.agentId }
				: null;
		case "event": {
			if (typeof record.type !== "string") return null;
			const outcome = record.outcome;
			const callFacts = parseToolCallFacts(record.callFacts);
			const scope = record.usageScope;
			return {
				kind: "event",
				type: record.type,
				...optionalString(record, "detail"),
				...optionalString(record, "tool"),
				...optionalString(record, "callId"),
				...optionalString(record, "verb"),
				...optionalString(record, "reason"),
				...optionalCount(record, "durationMs"),
				...optionalCount(record, "tokens"),
				...optionalCount(record, "callIndex"),
				...(outcome === "ok" || outcome === "error" || outcome === "blocked" ? { outcome } : {}),
				...(scope === "call" || scope === "run-aggregate" ? { usageScope: scope } : {}),
				...(callFacts !== undefined ? { callFacts } : {}),
			};
		}
		case "journal_truncated":
			return typeof record.reason === "string" && Number.isSafeInteger(record.droppedFromSeq)
				? { kind: "journal_truncated", reason: record.reason, droppedFromSeq: record.droppedFromSeq as number }
				: null;
		case "result":
			if (typeof record.outcome !== "string") return null;
			if (record.exitCode !== null && typeof record.exitCode !== "number") return null;
			return {
				kind: "result",
				outcome: record.outcome,
				exitCode: record.exitCode,
				...optionalString(record, "attemptRunId"),
			};
		case "terminal":
			return typeof record.outcome === "string"
				? { kind: "terminal", outcome: record.outcome, ...optionalString(record, "detail") }
				: null;
		default:
			return null;
	}
}

/** One feed line, read defensively: null for anything malformed, of another version, or of an unknown kind. */
export function readRunFeedLine(raw: string): RunFeedLine | null {
	if (raw.length === 0) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== RUN_FEED_VERSION) return null;
	if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1 || typeof value.at !== "string") return null;
	const body = readBody(value);
	return body === null ? null : { v: RUN_FEED_VERSION, seq: value.seq as number, at: value.at, ...body };
}

export interface ReadRunFeedOptions {
	stateDir?: string;
	/** Keep at most this many lines, newest last. */
	maxLines?: number;
	tailBytes?: number;
}

export interface RunFeedRead {
	path: string;
	present: boolean;
	bytes: number;
	lines: RunFeedLine[];
	/** True when the writer dropped display rows, or when this read skipped a file head. */
	truncated: boolean;
	terminal: { outcome: string; detail?: string } | null;
	agentId: string | null;
}

/**
 * Read one run's feed. Reads at most the last {@link RUN_FEED_READ_TAIL_BYTES}, discarding a leading partial line, so
 * a viewer polling a capped feed never pulls megabytes per tick. A skipped head reports as `truncated` for the same
 * reason the writer's marker does: the transcript on screen is not the whole run.
 */
export function readRunFeed(runId: string, options: ReadRunFeedOptions = {}): RunFeedRead {
	const path = runFeedPath(runId, options.stateDir);
	const empty: RunFeedRead = {
		path,
		present: false,
		bytes: 0,
		lines: [],
		truncated: false,
		terminal: null,
		agentId: null,
	};
	if (!isSafeRunId(runId)) return empty;
	const tail = readTail(path, options.tailBytes ?? RUN_FEED_READ_TAIL_BYTES);
	if (tail === null) return empty;
	const lines: RunFeedLine[] = [];
	let truncated = tail.headDropped;
	let terminal: { outcome: string; detail?: string } | null = null;
	let agentId: string | null = null;
	for (const raw of tail.text.split("\n")) {
		// A trailing partial line is the writer mid-append, not corruption.
		const line = readRunFeedLine(raw);
		if (line === null) continue;
		if (line.kind === "journal_truncated") truncated = true;
		if (line.kind === "open") agentId = line.agentId;
		if (line.kind === "terminal")
			terminal = line.detail === undefined ? { outcome: line.outcome } : { outcome: line.outcome, detail: line.detail };
		lines.push(line);
	}
	const maxLines = options.maxLines;
	if (maxLines !== undefined && lines.length > maxLines) {
		lines.splice(0, lines.length - maxLines);
		truncated = true;
	}
	return { path, present: true, bytes: tail.size, lines, truncated, terminal, agentId };
}
