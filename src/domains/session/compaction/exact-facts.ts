/**
 * The checkpoint's harness-measured facts, written beside the model's summary.
 *
 * A summary is model-written, so the counts and anchors in it are the model's
 * recollection: a live run carried "39 helpers per file" across three
 * checkpoints when every file held 40, and its first edit after the cut quoted
 * text the file never contained. This block is the part of a checkpoint the
 * summarizer cannot write: the files compacted context touched, with their line
 * count and content hash read from disk at the cut, and the exact numbers recent
 * tool calls returned (exit codes, test counts, match counts) with the call that
 * produced each. It replaces the former `<read-files>` and `<modified-files>`
 * lists, whose paths it still carries, and later checkpoints carry it forward.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { expandPath } from "../../../tools/path-utils.js";
import { effectiveToolCall, expandChainMessages } from "../../../tools/surface.js";
import type { SessionEntry } from "../entries.js";

export interface FileOperations {
	read: Set<string>;
	modified: Set<string>;
}

/** Files measured on disk per checkpoint; later paths are still listed, unmeasured. */
const MEASURED_FILES_MAX = 24;
/** A larger file is reported by size alone rather than read whole at the cut. */
const MEASURED_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** Newest numeric tool results carried per checkpoint. */
const RESULTS_MAX = 8;
const SUBJECT_MAX_CHARS = 72;
const HASH_CHARS = 12;

const BLOCK = /\n*<exact-facts\b[^>]*>\n([\s\S]*?)\n<\/exact-facts>\n*/giu;
const ECHOED_BLOCK = /\n*<exact-facts\b[^>]*>[\s\S]*?(?:<\/exact-facts\s*>|$)\n*/giu;
const FILE_LINE =
	/^(read|modified) (.+?)(?: lines=\d+ sha256=[0-9a-f]+| bytes=\d+| missing| unreadable| not-a-file)?$/u;
const RESULTS_HEADING = "results:";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every path the prior block and the legacy path lists named, with its operation. */
export function recordPriorFileOperations(summary: string, record: (operation: string, path: string) => void): void {
	for (const [, body] of summary.matchAll(/<read-files>\n([\s\S]*?)\n<\/read-files>/g)) {
		for (const filePath of (body ?? "").split("\n")) record("read", filePath);
	}
	for (const [, body] of summary.matchAll(/<modified-files>\n([\s\S]*?)\n<\/modified-files>/g)) {
		for (const filePath of (body ?? "").split("\n")) record("edit", filePath);
	}
	for (const [, body] of summary.matchAll(BLOCK)) {
		for (const line of (body ?? "").split("\n")) {
			if (line === RESULTS_HEADING) break;
			const match = FILE_LINE.exec(line);
			if (match?.[1] && match[2]) record(match[1] === "read" ? "read" : "edit", match[2]);
		}
	}
}

/** The model may echo the prior block it saw in `<previous-context>`; the harness copy is the only one kept. */
export function stripEchoedExactFacts(text: string): string {
	return text.replace(ECHOED_BLOCK, "\n\n");
}

function measureFile(filePath: string, cwd: string | undefined): string {
	if (cwd === undefined) return "";
	const expanded = expandPath(filePath);
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	let size: number;
	try {
		const stat = statSync(absolute);
		if (!stat.isFile()) return " not-a-file";
		size = stat.size;
	} catch {
		return " missing";
	}
	if (size > MEASURED_FILE_MAX_BYTES) return ` bytes=${size}`;
	try {
		const bytes = readFileSync(absolute);
		let newlines = 0;
		for (const byte of bytes) if (byte === 10) newlines += 1;
		// The read tool's count: an unterminated last line is still a line.
		const lines = newlines + (bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? 1 : 0);
		const hash = createHash("sha256").update(bytes).digest("hex").slice(0, HASH_CHARS);
		return ` lines=${lines} sha256=${hash}`;
	} catch {
		return " unreadable";
	}
}

function oneLine(text: string, max = SUBJECT_MAX_CHARS): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return "";
	if (Array.isArray(result.content))
		return result.content
			.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
			.join("\n");
	return typeof result.output === "string" ? result.output : "";
}

const COUNT_WORDS =
	/\b(\d+)\s+(passed|passing|failed|failing|skipped|pending|todo|errors?|tests?|suites?|total)\b|\b(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$/gimu;

/** Test-runner tallies in a command's output, newest wording per label. */
function testCounts(text: string): string[] {
	const counts = new Map<string, string>();
	for (const match of text.slice(-4000).matchAll(COUNT_WORDS)) {
		const label = (match[2] ?? match[3] ?? "").toLowerCase();
		const value = match[1] ?? match[4];
		if (label && value) {
			counts.delete(label);
			counts.set(label, value);
		}
	}
	return [...counts].map(([label, value]) => `${value} ${label}`);
}

interface CallFacts {
	toolName: string;
	args: Record<string, unknown> | undefined;
}

function collectCalls(entries: ReadonlyArray<SessionEntry>): Map<string, CallFacts> {
	const calls = new Map<string, CallFacts>();
	const add = (id: unknown, name: unknown, args: unknown): void => {
		if (typeof id !== "string" || typeof name !== "string") return;
		const effective = effectiveToolCall(name, args);
		calls.set(id, { toolName: effective.toolName, args: effective.args });
	};
	for (const entry of entries) {
		if (entry.kind !== "message" || !isRecord(entry.payload)) continue;
		const payload = entry.payload;
		if (entry.role === "tool_call") add(payload.toolCallId, payload.name, payload.args ?? payload.arguments);
		else if (entry.role === "assistant" && Array.isArray(payload.content))
			for (const block of payload.content)
				if (isRecord(block) && block.type === "toolCall") add(block.id, block.name, block.arguments ?? block.args);
	}
	return calls;
}

function subjectOf(toolName: string, args: Record<string, unknown> | undefined): string {
	if (args === undefined) return toolName;
	const named = (key: string): string | undefined => {
		const value = args[key];
		return typeof value === "string" && value.trim().length > 0 ? value : undefined;
	};
	const command = named("command") ?? named("cmd");
	if (command !== undefined) return `${toolName} \`${oneLine(command)}\``;
	const pattern = named("pattern") ?? named("query");
	const path = named("path");
	const parts = [pattern === undefined ? undefined : `\`${oneLine(pattern, 40)}\``, path].filter(Boolean);
	return parts.length > 0 ? `${toolName} ${parts.join(" ")}` : toolName;
}

/** The exact numbers one tool result returned, or null when it returned none worth carrying. */
function numericResult(payload: Record<string, unknown>, call: CallFacts | undefined): string | null {
	if (payload.outcome === "blocked") return null;
	const recorded = typeof payload.toolName === "string" ? payload.toolName : undefined;
	const toolName = call?.toolName ?? recorded;
	// A file's line count is measured on disk; a read's own count would go stale.
	if (toolName === undefined || toolName === "read") return null;
	const result = isRecord(payload.result) ? payload.result : undefined;
	const details = isRecord(result?.details) ? result.details : undefined;
	const facts: string[] = [];
	if (typeof details?.exitCode === "number") facts.push(`exit=${details.exitCode}`);
	if (details?.timedOut === true) facts.push("timed-out");
	const observation = isRecord(details?.observation) ? details.observation : undefined;
	if (observation && typeof observation.unit === "string" && observation.unit !== "lines") {
		const total = observation.totalCount;
		const shown = observation.shownCount;
		if (typeof total === "number") facts.push(`${total} ${observation.unit}`);
		else if (typeof shown === "number") facts.push(`${shown}+ ${observation.unit}`);
	}
	if (typeof details?.exitCode === "number" || toolName === "verify")
		facts.push(...testCounts(resultText(payload.result)));
	if (facts.length === 0) return null;
	const id = typeof payload.toolCallId === "string" ? ` call=${payload.toolCallId}` : "";
	return `${subjectOf(toolName, call?.args)}: ${facts.join(", ")}${id}`;
}

function priorResults(summary: string): string[] {
	const out: string[] = [];
	for (const [, body] of summary.matchAll(BLOCK)) {
		const lines = (body ?? "").split("\n");
		const start = lines.indexOf(RESULTS_HEADING);
		if (start >= 0) out.push(...lines.slice(start + 1).filter((line) => line.trim().length > 0));
	}
	return out;
}

/** Numeric results in ledger order, prior checkpoints' carried lines first. */
function collectResults(entries: ReadonlyArray<SessionEntry>): string[] {
	const expanded = expandChainMessages(entries);
	const calls = collectCalls(expanded);
	const out: string[] = [];
	for (const entry of expanded) {
		if (entry.kind === "compactionSummary") {
			out.push(...priorResults(entry.summary));
			continue;
		}
		if (entry.kind !== "message" || entry.role !== "tool_result" || !isRecord(entry.payload)) continue;
		const id = entry.payload.toolCallId;
		const line = numericResult(entry.payload, typeof id === "string" ? calls.get(id) : undefined);
		if (line !== null) out.push(line);
	}
	const unique = [...new Set(out.reverse())].reverse();
	return unique.slice(-RESULTS_MAX);
}

/**
 * The `<exact-facts>` block for a checkpoint over `entries`: every file
 * `fileOps` names, modified first, measured against `cwd` when it is known,
 * and the newest numeric tool results. Empty when there is nothing to state.
 */
export function formatExactFacts(
	fileOps: FileOperations,
	entries: ReadonlyArray<SessionEntry>,
	cwd: string | undefined,
): string {
	const modified = [...fileOps.modified].sort();
	const readOnly = [...fileOps.read].filter((filePath) => !fileOps.modified.has(filePath)).sort();
	const files = [
		...modified.map((filePath) => ["modified", filePath] as const),
		...readOnly.map((filePath) => ["read", filePath] as const),
	].map(
		([operation, filePath], index) =>
			`${operation} ${filePath}${index < MEASURED_FILES_MAX ? measureFile(filePath, cwd) : ""}`,
	);
	const results = collectResults(entries);
	if (files.length === 0 && results.length === 0) return "";
	// No re-read advice here: a live 20k-window run took it as an order and re-read whole
	// files until each read forced another compaction. The edit guard asks at the edit.
	const lines = [
		"Measured by Clio at this checkpoint, not by the summarizer; where the summary disagrees, these values hold.",
		...files,
		...(results.length > 0 ? [RESULTS_HEADING, ...results] : []),
	];
	return `\n\n<exact-facts source="clio">\n${lines.join("\n")}\n</exact-facts>`;
}
