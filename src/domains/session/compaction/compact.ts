/**
 * Compaction orchestration (Phase 12 slice 12c).
 *
 * Given a list of session entries, finds the cut point, summarizes the
 * history portion via the supplied model, and returns the trimmed entry
 * list plus summary metadata. Callers persist the summary via
 * `session.appendEntry({ kind: "compactionSummary", ... })`.
 *
 * The stream call goes through `src/engine/ai.ts` to honor the engine
 * boundary; this module does not import pi-ai directly.
 */

import { stream } from "../../../engine/ai.js";
import type { EngineModel, Usage } from "../../../engine/types.js";
import { foldWorkingSet } from "../../context/working-set/fold.js";
import { recallableRefListing } from "../../context/working-set/recall.js";
import type { CompactionUsage, SessionEntry } from "../entries.js";
import { serializeConversation } from "./branch-summary.js";
import { findCutPoint } from "./cut-point.js";
import { DEFAULT_KEEP_RECENT_TOKENS, DEFAULT_RESERVE_TOKENS } from "./defaults.js";
import { calculateContextTokens, getLastAssistantUsage } from "./tokens.js";

interface FileOperations {
	read: Set<string>;
	modified: Set<string>;
}

/**
 * Default system prompt for the summarization call. Kept inline so a
 * session with no `compaction.systemPrompt` override still produces stable
 * output. `COMPACTION_USER_PROMPT_TEMPLATE` is the structured format string
 * appended after the serialized conversation.
 */
export const COMPACTION_SYSTEM_PROMPT = [
	"You are a context summarization assistant.",
	"Read the supplied conversation between a user and an AI coding assistant,",
	"then emit a structured summary in the exact format shown in the user message.",
	"Do NOT continue the conversation. Do NOT answer any questions in it.",
].join(" ");

export const COMPACTION_USER_PROMPT_TEMPLATE = `The messages above are a conversation to summarize. Create a structured context checkpoint another LLM will use to continue the work.

When a <previous-context> block is present, it is the canonical checkpoint and retained suffix from an earlier compaction. Produce one cumulative replacement checkpoint: preserve every still-relevant constraint, decision, active skill, unresolved task, exact identifier, and file-state detail from that block while incorporating the newer conversation.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by the user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE = `The messages above are the beginning of the currently active user turn. They will be removed from the live context because the retained suffix starts in the middle of that turn.

When a <previous-context> block is present, it is canonical context from an earlier compaction. Carry its still-relevant constraints, decisions, active skills, unresolved work, exact identifiers, and file state into this checkpoint in addition to the active-turn details below. Do not discard it as unrelated older history.

In addition to that carried-forward context, summarize ONLY the active-turn details needed for another LLM to continue the same request:

- the user's active request
- tool calls already made in this turn
- tool results, file paths, commands, errors, and decisions already observed
- what should happen next

Do NOT answer the user. Do NOT summarize unrelated older history.`;

export interface CompactInput {
	/** Ordered session entries to compact. The caller reads these from the session domain. */
	entries: ReadonlyArray<SessionEntry>;
	/** Resolved orchestrator or compaction-override model. */
	model: EngineModel;
	/** API key for the model. Optional because local engines accept a fallback handled upstream. */
	apiKey?: string;
	/** Per-provider headers to pass through with the stream request. */
	headers?: Record<string, string>;
	/** AbortSignal to cancel the summarization mid-stream. */
	signal?: AbortSignal;
	/** Optional user-supplied focus appended to the summarization instructions. */
	instructions?: string;
	/** Override the built-in COMPACTION_SYSTEM_PROMPT for the call. */
	systemPrompt?: string;
	/** Override the built-in reserve-tokens default (DEFAULT_RESERVE_TOKENS). */
	reserveTokens?: number;
	/** Override the built-in keep-recent default (DEFAULT_KEEP_RECENT_TOKENS). */
	keepRecentTokens?: number;
}

export interface CompactResult {
	/** Generated summary text. Empty when there was nothing to summarize. */
	summary: string;
	/**
	 * Provider usage for the summarization call(s), summed. A compaction is a
	 * real model call and is billed like one; absent when the provider reported
	 * no usage at all, so a caller never records a fabricated zero-token call.
	 */
	usage?: CompactionUsage;
	/** Index into `entries` of the first entry that remains post-compaction. */
	firstKeptEntryIndex: number;
	/** Turn id of that first-kept entry, or null when entries is empty. */
	firstKeptTurnId: string | null;
	/** Estimated total context tokens before compaction. */
	tokensBefore: number;
	/** Number of newly compacted entries (excluding a carried-forward prior checkpoint and retained suffix). */
	messagesSummarized: number;
	/** True when the cut split a turn (caller may want to show a banner). */
	isSplitTurn: boolean;
}

function buildUserMessage(text: string): {
	role: "user";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
} {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

/**
 * Walk entries from newest to oldest and return the index of the most recent
 * `compactionSummary` entry, or -1 when none is present. Mirrors pi-coding-agent's
 * `prevCompactionIndex` discovery in compaction.ts:613-618 so iterative
 * compactions do not re-summarize content already captured in a prior summary.
 */
function findLatestCompactionIndex(entries: ReadonlyArray<SessionEntry>): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.kind === "compactionSummary") return i;
	}
	return -1;
}

function findLatestSkillActivationProtectionStart(
	entries: ReadonlyArray<SessionEntry>,
	startIndex: number,
): number | null {
	for (let i = entries.length - 1; i >= startIndex; i--) {
		if (entries[i]?.kind !== "skillActivation") continue;
		const turnStart = findTurnStartForProtection(entries, i, startIndex);
		return turnStart === -1 ? i : turnStart;
	}
	return null;
}

function findTurnStartForProtection(
	entries: ReadonlyArray<SessionEntry>,
	entryIndex: number,
	startIndex: number,
): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.kind === "branchSummary") return i;
		if (entry.kind === "bashExecution") return i;
		if (entry.kind === "message" && entry.role === "user") return i;
	}
	return -1;
}

function buildPreviousContextPrefix(previousContextText: string): string {
	const trimmed = previousContextText.trim();
	return trimmed.length > 0 ? `<previous-context>\n${trimmed}\n</previous-context>\n\n` : "";
}

function buildUserText(conversationText: string, instructions?: string, previousContextText = ""): string {
	const focus = instructions?.trim();
	const suffix = focus ? `\n\nAdditional focus: ${focus}` : "";
	return `${buildPreviousContextPrefix(previousContextText)}<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_USER_PROMPT_TEMPLATE}${suffix}`;
}

function buildTurnPrefixUserText(conversationText: string, instructions?: string, previousContextText = ""): string {
	const focus = instructions?.trim();
	const suffix = focus ? `\n\nAdditional focus: ${focus}` : "";
	return `${buildPreviousContextPrefix(previousContextText)}<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE}${suffix}`;
}

/**
 * Recover the context that the latest compaction left live. A compaction
 * summary is appended after the retained suffix, so on the next pass that
 * suffix sits immediately before the summary entry and is otherwise outside
 * `boundaryStart`. Replay drops both the older summary and that suffix once a
 * newer summary is appended; feeding them to every applicable prompt branch
 * lets the model produce a genuinely cumulative replacement checkpoint.
 */
function priorCompactionContextEntries(entries: ReadonlyArray<SessionEntry>, compactionIndex: number): SessionEntry[] {
	const compaction = entries[compactionIndex];
	if (compaction?.kind !== "compactionSummary") return [];

	let firstKeptIndex = -1;
	if (compaction.firstKeptTurnId.length > 0) {
		for (let index = 0; index < compactionIndex; index++) {
			if (entries[index]?.turnId === compaction.firstKeptTurnId) {
				firstKeptIndex = index;
				break;
			}
		}
	}

	const retainedSuffix = firstKeptIndex >= 0 ? entries.slice(firstKeptIndex, compactionIndex) : [];
	// Put the summary first: semantically it precedes the retained suffix even
	// though append-only session order stores the summary after that suffix.
	return [compaction, ...retainedSuffix];
}

function createFileOps(): FileOperations {
	return { read: new Set(), modified: new Set() };
}

function recordFileOperation(fileOps: FileOperations, operation: unknown, filePath: unknown): void {
	if (typeof filePath !== "string" || filePath.trim().length === 0) return;
	const normalized = filePath.trim();
	if (operation === "read") {
		fileOps.read.add(normalized);
		return;
	}
	if (operation === "write" || operation === "edit" || operation === "create" || operation === "delete") {
		fileOps.modified.add(normalized);
	}
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

function contentBlocks(payload: unknown): ReadonlyArray<Record<string, unknown>> {
	const content = payloadObject(payload)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object");
}

function extractPathArg(args: unknown): string | null {
	const obj = payloadObject(args);
	if (!obj) return null;
	const candidate = obj.path ?? obj.file_path ?? obj.filePath;
	return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function extractFileOpsFromMessage(entry: SessionEntry, fileOps: FileOperations): void {
	if (entry.kind !== "message") return;
	if (entry.role === "tool_call") {
		const obj = payloadObject(entry.payload);
		if (!obj) return;
		const name = typeof obj.name === "string" ? obj.name : typeof obj.toolName === "string" ? obj.toolName : "";
		recordFileOperation(fileOps, name, extractPathArg(obj.args ?? obj.arguments ?? obj.input));
		return;
	}
	if (entry.role !== "assistant") return;
	for (const block of contentBlocks(entry.payload)) {
		if (block.type !== "toolCall") continue;
		const name = typeof block.name === "string" ? block.name : "";
		recordFileOperation(fileOps, name, extractPathArg(block.arguments ?? block.args ?? block.input));
	}
}

function extractFileOpsFromPriorSummary(summary: string, fileOps: FileOperations): void {
	for (const [, body] of summary.matchAll(/<read-files>\n([\s\S]*?)\n<\/read-files>/g)) {
		for (const filePath of (body ?? "").split("\n")) recordFileOperation(fileOps, "read", filePath);
	}
	for (const [, body] of summary.matchAll(/<modified-files>\n([\s\S]*?)\n<\/modified-files>/g)) {
		for (const filePath of (body ?? "").split("\n")) recordFileOperation(fileOps, "edit", filePath);
	}
}

function extractFileOps(entries: ReadonlyArray<SessionEntry>): FileOperations {
	const fileOps = createFileOps();
	for (const entry of entries) {
		if (entry.kind === "fileEntry") {
			recordFileOperation(fileOps, entry.operation, entry.path);
			continue;
		}
		if (entry.kind === "compactionSummary") {
			extractFileOpsFromPriorSummary(entry.summary, fileOps);
			continue;
		}
		extractFileOpsFromMessage(entry, fileOps);
	}
	return fileOps;
}

function formatFileOperations(fileOps: FileOperations): string {
	const modified = [...fileOps.modified].sort();
	const readOnly = [...fileOps.read].filter((filePath) => !fileOps.modified.has(filePath)).sort();
	const sections: string[] = [];
	if (readOnly.length > 0) sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
	if (modified.length > 0) sections.push(`<modified-files>\n${modified.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

function formatRecallableRefs(entries: ReadonlyArray<SessionEntry>, firstKeptEntryIndex: number): string {
	const entryIndexes = new Map<string, number>();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry) entryIndexes.set(entry.turnId, index);
	}
	const view = foldWorkingSet(entries);
	const evictedBeforeCut = new Map(
		[...view.evicted].filter(([ref]) => (entryIndexes.get(ref) ?? Number.POSITIVE_INFINITY) < firstKeptEntryIndex),
	);
	const listing = recallableRefListing(entries, { ...view, evicted: evictedBeforeCut });
	if (listing.refs.length === 0) return "";
	const rows = [...listing.refs];
	if (listing.remaining > 0) rows.push(`and ${listing.remaining} more`);
	return `\n\n<recallable-refs>\n${rows.join("\n")}\n</recallable-refs>`;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fold one summarization call's provider usage into the running total. A split
 * turn runs two calls; both are billed, so both are counted. Returns the
 * accumulator unchanged when the provider reported nothing, so "no usage" stays
 * distinguishable from "a call that cost zero".
 */
function addCompactionUsage(total: CompactionUsage | undefined, raw: unknown): CompactionUsage | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return total;
	const usage = raw as Partial<Usage> & { reasoning?: number };
	const input = numberOrZero(usage.input);
	const output = numberOrZero(usage.output);
	const cacheRead = numberOrZero(usage.cacheRead);
	const cacheWrite = numberOrZero(usage.cacheWrite);
	const totalTokens = numberOrZero(usage.totalTokens) || input + output + cacheRead + cacheWrite;
	if (totalTokens === 0) return total;
	const base = total ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: { total: 0 },
		apiCalls: 0,
	};
	return {
		input: base.input + input,
		output: base.output + output,
		cacheRead: base.cacheRead + cacheRead,
		cacheWrite: base.cacheWrite + cacheWrite,
		reasoning: base.reasoning + numberOrZero(usage.reasoning),
		totalTokens: base.totalTokens + totalTokens,
		cost: { total: base.cost.total + numberOrZero(usage.cost?.total) },
		apiCalls: base.apiCalls + 1,
	};
}

async function runSummaryStream(
	input: CompactInput,
	userText: string,
	systemPrompt: string,
	maxTokens: number,
): Promise<{ text: string; usage: unknown }> {
	const options: Record<string, unknown> = { maxTokens };
	if (input.apiKey !== undefined) options.apiKey = input.apiKey;
	if (input.headers !== undefined) options.headers = input.headers;
	if (input.signal !== undefined) options.signal = input.signal;

	const context = {
		systemPrompt,
		messages: [buildUserMessage(userText)],
	};

	const events = stream(
		input.model,
		context as unknown as Parameters<typeof stream>[1],
		options as unknown as Parameters<typeof stream>[2],
	);

	let summary = "";
	let usage: unknown;
	for await (const event of events) {
		if (event.type === "done") {
			summary = textFromAssistant(event.message);
			usage = (event.message as { usage?: unknown }).usage;
			break;
		}
		if (event.type === "error") {
			const reason = event.error.errorMessage ?? "unknown error";
			throw new Error(`compaction stream failed: ${reason}`);
		}
	}
	return { text: summary.trim(), usage };
}

/**
 * Run the compaction pipeline: find the cut, serialize the history portion,
 * ask the model for a summary, and return the result. The caller decides
 * what to do with `summary` and `firstKeptTurnId`; typically they persist a
 * `compactionSummary` entry via `session.appendEntry` and swap the live
 * message list for `entries.slice(firstKeptEntryIndex)`.
 */
export async function compact(input: CompactInput): Promise<CompactResult> {
	const reserveTokens = input.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const keepRecentTokens = input.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
	// Iterative compaction: when a prior `compactionSummary` exists, the
	// summary is canonical history. Restrict the cut search and the new-history
	// slice to entries strictly after that boundary; the canonical summary and
	// its retained suffix are recovered below and prepended explicitly rather
	// than rediscovering already-compacted raw history. Mirrors pi-coding-agent's
	// `boundaryStart = prevCompactionIndex + 1` and `usageStart = prevCompactionIndex`
	// in compaction.ts:619-628.
	const prevCompactionIndex = findLatestCompactionIndex(input.entries);
	const boundaryStart = prevCompactionIndex + 1;
	const protectedStart = findLatestSkillActivationProtectionStart(input.entries, boundaryStart);
	const usageStart = prevCompactionIndex >= 0 ? prevCompactionIndex : 0;
	const usageEntries = input.entries.slice(usageStart);
	const lastUsage = getLastAssistantUsage(usageEntries);
	const tokensBefore = calculateContextTokens(usageEntries, lastUsage);
	const rawCut = findCutPoint(input.entries, keepRecentTokens, { startIndex: boundaryStart });
	const cut =
		protectedStart !== null && rawCut.firstKeptEntryIndex > protectedStart
			? { firstKeptEntryIndex: protectedStart, turnStartIndex: -1, isSplitTurn: false }
			: rawCut;
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const pre = input.entries.slice(boundaryStart, Math.max(boundaryStart, historyEnd));
	const turnPrefix = cut.isSplitTurn
		? input.entries.slice(Math.max(boundaryStart, cut.turnStartIndex), cut.firstKeptEntryIndex)
		: [];
	const previousContextEntries = priorCompactionContextEntries(input.entries, prevCompactionIndex);
	const previousContextText = serializeConversation(previousContextEntries);
	const fileOps = extractFileOps([...previousContextEntries, ...pre, ...turnPrefix]);
	const firstKept = input.entries[cut.firstKeptEntryIndex] ?? null;

	if (pre.length === 0 && turnPrefix.length === 0) {
		return {
			summary: "",
			firstKeptEntryIndex: cut.firstKeptEntryIndex,
			firstKeptTurnId: firstKept?.turnId ?? null,
			tokensBefore,
			messagesSummarized: 0,
			isSplitTurn: cut.isSplitTurn,
		};
	}

	const systemPrompt = input.systemPrompt ?? COMPACTION_SYSTEM_PROMPT;
	const maxTokens = Math.max(1024, Math.floor(reserveTokens * 0.8));
	const summaryParts: string[] = [];
	let usage: CompactionUsage | undefined;
	if (pre.length > 0) {
		const conversationText = serializeConversation(pre);
		const userText = buildUserText(conversationText, input.instructions, previousContextText);
		const historySummary = await runSummaryStream(input, userText, systemPrompt, maxTokens);
		usage = addCompactionUsage(usage, historySummary.usage);
		if (historySummary.text.length > 0) summaryParts.push(historySummary.text);
	}
	if (turnPrefix.length > 0) {
		const conversationText = serializeConversation(turnPrefix);
		const userText = buildTurnPrefixUserText(conversationText, input.instructions, previousContextText);
		const prefixSummary = await runSummaryStream(input, userText, systemPrompt, maxTokens);
		usage = addCompactionUsage(usage, prefixSummary.usage);
		if (prefixSummary.text.length > 0) {
			summaryParts.push(`**Turn Context (split turn):**\n\n${prefixSummary.text}`);
		}
	}

	const summary = `${summaryParts.join("\n\n---\n\n").trim()}${formatFileOperations(fileOps)}${formatRecallableRefs(
		input.entries,
		cut.firstKeptEntryIndex,
	)}`.trim();

	return {
		summary,
		firstKeptEntryIndex: cut.firstKeptEntryIndex,
		firstKeptTurnId: firstKept?.turnId ?? null,
		tokensBefore,
		messagesSummarized: pre.length + turnPrefix.length,
		isSplitTurn: cut.isSplitTurn,
		...(usage !== undefined ? { usage } : {}),
	};
}

interface TextBlock {
	type: "text";
	text: string;
}

function textFromAssistant(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is TextBlock =>
				!!c &&
				typeof c === "object" &&
				(c as { type?: unknown }).type === "text" &&
				typeof (c as { text?: unknown }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}
