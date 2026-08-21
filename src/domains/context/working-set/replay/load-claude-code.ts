/**
 * Read-only Claude Code transcript loader for replay-lite.
 *
 * Claude Code persists provider-shaped JSONL rather than Clio session entries.
 * This module normalizes that wire format once, at the corpus boundary, into
 * the exact message payloads Clio's replay/index/policy code already reads.
 * No policy or metric has a provider-specific branch.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import {
	type CustomEntry,
	isSessionHeader,
	type MessageEntry,
	type SessionEntry,
	type SessionHeader,
} from "../../../session/entries.js";
import { buildPathIndex } from "../path-index.js";
import { loadClioTraces, type ReplayLoadCascade } from "./load-clio.js";
import { buildReferenceGraph } from "./reference-graph.js";
import { countReplayTurns, type Trace } from "./trace.js";

export interface LoadClaudeCodeTraceOptions {
	filter?: boolean;
}

export type ReplayInputFormat = "clio" | "claude-code" | "auto";

interface ClaudeRecord {
	type?: unknown;
	message?: unknown;
	summary?: unknown;
	sessionId?: unknown;
	cwd?: unknown;
	timestamp?: unknown;
	isSidechain?: unknown;
	[key: string]: unknown;
}

interface ParsedRecords {
	records: ClaudeRecord[];
	malformed: number;
}

interface Discovery {
	files: string[];
	missingInputs: number;
}

interface NormalizedTool {
	name: string;
	args: Record<string, unknown>;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const CLAUDE_FILTER_KEYS = [
	"sidechain_or_subagent",
	"summary_only",
	"turns_lt_8",
	"tool_results_lt_8",
	"no_file_reread",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function collectJsonlFiles(input: string, out: Set<string>): Promise<boolean> {
	const path = resolve(input);
	let facts: Awaited<ReturnType<typeof stat>>;
	try {
		facts = await stat(path);
	} catch {
		return false;
	}
	if (facts.isFile()) {
		if (extname(path) === ".jsonl") out.add(path);
		return true;
	}
	if (!facts.isDirectory()) return true;

	let children: Dirent[];
	try {
		children = await readdir(path, { withFileTypes: true });
	} catch {
		return true;
	}
	for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
		const childPath = resolve(path, child.name);
		if (child.isDirectory()) await collectJsonlFiles(childPath, out);
		else if (child.isFile() && extname(child.name) === ".jsonl") out.add(childPath);
	}
	return true;
}

export async function discoverReplayJsonlFiles(paths: ReadonlyArray<string>): Promise<Discovery> {
	const files = new Set<string>();
	let missingInputs = 0;
	for (const path of paths) {
		if (!(await collectJsonlFiles(path, files))) missingInputs += 1;
	}
	return { files: [...files].sort((a, b) => a.localeCompare(b)), missingInputs };
}

function parseRecords(raw: string): ParsedRecords {
	const records: ClaudeRecord[] = [];
	let malformed = 0;
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (isRecord(value)) records.push(value as ClaudeRecord);
			else malformed += 1;
		} catch {
			// Claude Code can leave a partial final line after a crash. Match the
			// research loader's lenience: retain the readable event prefix.
			malformed += 1;
		}
	}
	return { records, malformed };
}

/** Detect the first semantic record after metadata such as `mode`. */
export function detectReplayInputFormat(raw: string): Exclude<ReplayInputFormat, "auto"> | null {
	const { records } = parseRecords(raw);
	for (const record of records) {
		if (isSessionHeader(record)) return "clio";
		if ((record.type === "user" || record.type === "assistant") && isRecord(record.message)) {
			return "claude-code";
		}
		if (record.type === "summary" && record.summary !== undefined) return "claude-code";
	}
	return null;
}

function timestampOf(record: ClaudeRecord | undefined): string {
	return stringValue(record?.timestamp) ?? EPOCH;
}

function sessionIdOf(records: ReadonlyArray<ClaudeRecord>, source: string): string {
	for (const record of records) {
		const id = stringValue(record.sessionId);
		if (id !== undefined) return id;
	}
	return basename(source, ".jsonl");
}

function cwdOf(records: ReadonlyArray<ClaudeRecord>): string | undefined {
	for (const record of records) {
		const cwd = stringValue(record.cwd);
		if (cwd !== undefined) return cwd;
	}
	return undefined;
}

function usagePayload(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const number = (key: string): number => {
		const item = value[key];
		return typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : 0;
	};
	const input = number("input_tokens");
	const output = number("output_tokens");
	const cacheRead = number("cache_read_input_tokens");
	const cacheWrite = number("cache_creation_input_tokens");
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: 0,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textFromToolResult(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		if (content === undefined || content === null) return "";
		try {
			return JSON.stringify(content) ?? String(content);
		} catch {
			return String(content);
		}
	}
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (!isRecord(block)) continue;
		if (typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
		else {
			try {
				parts.push(JSON.stringify(block));
			} catch {
				parts.push(String(block));
			}
		}
	}
	return parts.join("\n");
}

function renamePath(args: Record<string, unknown>, key = "file_path"): void {
	if (typeof args.path !== "string" && typeof args[key] === "string") args.path = args[key];
	delete args[key];
}

function normalizeEditItems(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => {
		if (!isRecord(item)) return item;
		return {
			oldText: item.oldText ?? item.old_string ?? "",
			newText: item.newText ?? item.new_string ?? "",
		};
	});
}

function normalizeTool(originalName: string, input: unknown): NormalizedTool {
	const args: Record<string, unknown> = isRecord(input) ? { ...input } : {};
	args.__claudeCodeTool = originalName;

	switch (originalName) {
		case "Read":
			renamePath(args);
			return { name: "read", args };
		case "Edit":
		case "MultiEdit": {
			renamePath(args);
			if (Array.isArray(args.edits)) args.edits = normalizeEditItems(args.edits);
			else if (typeof args.old_string === "string" && typeof args.new_string === "string") {
				args.edits = [{ oldText: args.old_string, newText: args.new_string }];
			}
			delete args.old_string;
			delete args.new_string;
			delete args.replace_all;
			return { name: "edit", args };
		}
		case "Write":
			renamePath(args);
			return { name: "write", args };
		case "Grep": {
			if (typeof args.glob !== "string" && typeof args.include === "string") args.glob = args.include;
			delete args.include;
			if (typeof args.output_mode === "string") {
				args.mode =
					args.output_mode === "files_with_matches" ? "files" : args.output_mode === "count" ? "count" : "content";
				delete args.output_mode;
			}
			return { name: "grep", args };
		}
		case "Glob":
			return { name: "find", args };
		case "LS":
			return { name: "ls", args };
		case "Bash":
			if (typeof args.timeout_ms !== "number" && typeof args.timeout === "number") args.timeout_ms = args.timeout;
			delete args.timeout;
			return { name: "bash", args };
		case "WebFetch":
			return { name: "web_fetch", args };
		case "Task":
			if (typeof args.task !== "string" && typeof args.prompt === "string") args.task = args.prompt;
			if (typeof args.agent !== "string" && typeof args.subagent_type === "string") args.agent = args.subagent_type;
			if (typeof args.briefing !== "string" && typeof args.description === "string") args.briefing = args.description;
			delete args.prompt;
			delete args.subagent_type;
			delete args.description;
			return { name: "dispatch", args };
		case "TodoWrite": {
			const todos = Array.isArray(args.todos) ? args.todos : [];
			args.action = "plan";
			args.title = "Claude Code todos";
			args.tasks = todos
				.map((todo) => (isRecord(todo) && typeof todo.content === "string" ? todo.content : null))
				.filter((todo): todo is string => todo !== null);
			return { name: "tasks", args };
		}
		case "NotebookEdit":
			renamePath(args, "notebook_path");
			return { name: "edit", args };
		default:
			return { name: originalName.toLowerCase(), args };
	}
}

function assistantBlocks(message: Record<string, unknown>): {
	content: Array<Record<string, unknown>>;
	toolUses: Array<Record<string, unknown>>;
} {
	const content: Array<Record<string, unknown>> = [];
	const toolUses: Array<Record<string, unknown>> = [];
	if (typeof message.content === "string") {
		content.push({ type: "text", text: message.content });
		return { content, toolUses };
	}
	if (!Array.isArray(message.content)) return { content, toolUses };
	for (const block of message.content) {
		if (!isRecord(block)) continue;
		if (block.type === "tool_use") {
			toolUses.push(block);
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			content.push({ type: "text", text: block.text });
		}
		if (block.type === "thinking" && typeof block.thinking === "string") {
			content.push({
				type: "thinking",
				thinking: block.thinking,
				...(typeof block.signature === "string" ? { signature: block.signature } : {}),
			});
		}
	}
	return { content, toolUses };
}

function normalizeTranscript(records: ReadonlyArray<ClaudeRecord>, source: string): Trace {
	const entries: SessionEntry[] = [];
	const toolNames = new Map<string, string>();
	let parentTurnId: string | null = null;
	let eventIndex = 0;
	const nextTurnId = (): string => {
		const id = `cc-${String(eventIndex).padStart(6, "0")}`;
		eventIndex += 1;
		return id;
	};
	const appendMessage = (role: MessageEntry["role"], payload: unknown, timestamp: string): void => {
		const turnId = nextTurnId();
		entries.push({ kind: "message", role, payload, turnId, parentTurnId, timestamp });
		parentTurnId = turnId;
	};

	const id = sessionIdOf(records, source);
	const cwd = cwdOf(records);
	const firstRecord =
		records.find((record) => record.isSidechain !== true && stringValue(record.cwd) !== undefined) ??
		records.find((record) => record.isSidechain !== true);
	if (cwd !== undefined) {
		const turnId = nextTurnId();
		const header: CustomEntry & Omit<SessionHeader, "parentTurnId"> = {
			type: "session",
			version: 4,
			id,
			cwd,
			timestamp: timestampOf(firstRecord),
			kind: "custom",
			customType: "claude-code-session-header",
			turnId,
			parentTurnId,
			display: false,
		};
		entries.push(header);
		parentTurnId = turnId;
	}

	for (const record of records) {
		if (record.isSidechain === true) continue;
		if (record.type !== "user" && record.type !== "assistant") continue;
		if (!isRecord(record.message)) continue;
		const timestamp = timestampOf(record);
		if (record.type === "assistant") {
			const { content, toolUses } = assistantBlocks(record.message);
			const text = content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			const thinking = content
				.filter((block) => block.type === "thinking")
				.map((block) => block.thinking)
				.join("");
			const usage = usagePayload(record.message.usage);
			appendMessage(
				"assistant",
				{
					text,
					content,
					...(thinking.length > 0 ? { thinking } : {}),
					...(usage === undefined ? {} : { usage }),
				},
				timestamp,
			);
			for (const block of toolUses) {
				const originalName = stringValue(block.name) ?? "tool";
				const toolCallId = stringValue(block.id) ?? `claude-tool-${eventIndex}`;
				const tool = normalizeTool(originalName, block.input);
				toolNames.set(toolCallId, tool.name);
				appendMessage("tool_call", { toolCallId, name: tool.name, args: tool.args }, timestamp);
			}
			continue;
		}

		const userContent = record.message.content;
		if (typeof userContent === "string") {
			appendMessage("user", { text: userContent }, timestamp);
			continue;
		}
		if (!Array.isArray(userContent)) continue;
		const userText: string[] = [];
		for (const block of userContent) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") userText.push(block.text);
			if (block.type !== "tool_result") continue;
			const toolCallId = stringValue(block.tool_use_id) ?? `claude-tool-result-${eventIndex}`;
			appendMessage(
				"tool_result",
				{
					toolCallId,
					toolName: toolNames.get(toolCallId) ?? "tool",
					result: { content: [{ type: "text", text: textFromToolResult(block.content) }] },
					isError: block.is_error === true,
				},
				timestamp,
			);
		}
		// A Claude Code user record is the provider-call boundary, including a
		// record that carries only tool results. Put the boundary after those
		// results so replay's turn-start hook sees the exact completed prefix.
		appendMessage("user", { text: userText.join("\n") }, timestamp);
	}

	return { id, source, entries, turnCount: countReplayTurns(entries) };
}

function toolResultCount(entries: ReadonlyArray<SessionEntry>): number {
	return entries.reduce((count, entry) => count + (entry.kind === "message" && entry.role === "tool_result" ? 1 : 0), 0);
}

function emptyClaudeCascade(found: number, unreadable: number): ReplayLoadCascade {
	return {
		found,
		unreadable,
		filtered: Object.fromEntries(CLAUDE_FILTER_KEYS.map((key) => [key, 0])),
		kept: 0,
	};
}

function increment(cascade: ReplayLoadCascade, reason: (typeof CLAUDE_FILTER_KEYS)[number]): void {
	cascade.filtered[reason] = (cascade.filtered[reason] ?? 0) + 1;
}

function isSubagentPath(source: string): boolean {
	return source.split(sep).includes("subagents");
}

export async function loadClaudeCodeTraces(
	paths: ReadonlyArray<string>,
	opts: LoadClaudeCodeTraceOptions = {},
): Promise<{ traces: Trace[]; cascade: ReplayLoadCascade }> {
	const discovery = await discoverReplayJsonlFiles(paths);
	const cascade = emptyClaudeCascade(discovery.files.length, discovery.missingInputs);
	const traces: Trace[] = [];

	for (const source of discovery.files) {
		if (isSubagentPath(source)) {
			increment(cascade, "sidechain_or_subagent");
			continue;
		}
		let raw: string;
		try {
			raw = await readFile(source, "utf8");
		} catch {
			cascade.unreadable += 1;
			continue;
		}
		const parsed = parseRecords(raw);
		const mainRecords = parsed.records.filter((record) => record.isSidechain !== true);
		const conversation = mainRecords.filter((record) => record.type === "user" || record.type === "assistant");
		if (conversation.length === 0) {
			if (parsed.records.some((record) => record.isSidechain === true)) {
				increment(cascade, "sidechain_or_subagent");
				continue;
			}
			if (mainRecords.some((record) => record.type === "summary" || record.summary !== undefined)) {
				increment(cascade, "summary_only");
				continue;
			}
			cascade.unreadable += 1;
			continue;
		}
		const trace = normalizeTranscript(mainRecords, source);
		if (opts.filter !== false) {
			if (trace.turnCount < 8) {
				increment(cascade, "turns_lt_8");
				continue;
			}
			if (toolResultCount(trace.entries) < 8) {
				increment(cascade, "tool_results_lt_8");
				continue;
			}
			const graph = buildReferenceGraph(trace, buildPathIndex(trace.entries));
			if (!graph.edges.some((edge) => edge.kind === "file_reread")) {
				increment(cascade, "no_file_reread");
				continue;
			}
		}
		traces.push(trace);
	}

	cascade.kept = traces.length;
	return { traces, cascade };
}

function mergeFiltered(...sources: ReadonlyArray<Record<string, number>>): Record<string, number> {
	const ordered: string[] = [...CLAUDE_FILTER_KEYS];
	for (const source of sources) {
		for (const key of Object.keys(source)) if (!ordered.includes(key)) ordered.push(key);
	}
	return Object.fromEntries(ordered.map((key) => [key, sources.reduce((sum, source) => sum + (source[key] ?? 0), 0)]));
}

/** CLI-facing format router; auto classifies every discovered JSONL independently. */
export async function loadReplayTraces(
	paths: ReadonlyArray<string>,
	format: ReplayInputFormat,
	opts: LoadClaudeCodeTraceOptions = {},
): Promise<{ traces: Trace[]; cascade: ReplayLoadCascade }> {
	if (format === "clio") return loadClioTraces(paths, { filter: opts.filter === false ? false : {} });
	if (format === "claude-code") return loadClaudeCodeTraces(paths, opts);

	const discovery = await discoverReplayJsonlFiles(paths);
	const clio: string[] = [];
	const claudeCode: string[] = [];
	let unreadable = discovery.missingInputs;
	for (const source of discovery.files) {
		try {
			const raw = await readFile(source, "utf8");
			const detected = detectReplayInputFormat(raw);
			if (detected === "clio") clio.push(source);
			else if (detected === "claude-code") claudeCode.push(source);
			else unreadable += 1;
		} catch {
			unreadable += 1;
		}
	}

	const [clioLoaded, claudeLoaded] = await Promise.all([
		loadClioTraces(clio, { filter: opts.filter === false ? false : {} }),
		loadClaudeCodeTraces(claudeCode, opts),
	]);
	const traces = [...clioLoaded.traces, ...claudeLoaded.traces].sort((a, b) => a.source.localeCompare(b.source));
	return {
		traces,
		cascade: {
			found: discovery.files.length,
			unreadable: unreadable + clioLoaded.cascade.unreadable + claudeLoaded.cascade.unreadable,
			filtered: mergeFiltered(clioLoaded.cascade.filtered, claudeLoaded.cascade.filtered),
			kept: traces.length,
		},
	};
}
