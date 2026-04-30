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
import type { Model } from "../../../engine/types.js";
import type { SessionEntry } from "../entries.js";
import { serializeConversation } from "./branch-summary.js";
import { findCutPoint } from "./cut-point.js";
import { DEFAULT_KEEP_RECENT_TOKENS, DEFAULT_RESERVE_TOKENS } from "./defaults.js";
import { calculateContextTokens, getLastAssistantUsage } from "./tokens.js";

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

Summarize ONLY the active-turn details needed for another LLM to continue the same request:

- the user's active request
- tool calls already made in this turn
- tool results, file paths, commands, errors, and decisions already observed
- what should happen next

Do NOT answer the user. Do NOT summarize unrelated older history.`;

export interface CompactInput {
	/** Ordered session entries to compact. The caller reads these from the session domain. */
	entries: ReadonlyArray<SessionEntry>;
	/** Resolved orchestrator or compaction-override model. */
	model: Model<never>;
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
	/** Index into `entries` of the first entry that remains post-compaction. */
	firstKeptEntryIndex: number;
	/** Turn id of that first-kept entry, or null when entries is empty. */
	firstKeptTurnId: string | null;
	/** Estimated total context tokens before compaction. */
	tokensBefore: number;
	/** Number of entries that fed the summarization prompt. */
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

function buildUserText(conversationText: string, instructions?: string): string {
	const focus = instructions?.trim();
	const suffix = focus ? `\n\nAdditional focus: ${focus}` : "";
	return `<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_USER_PROMPT_TEMPLATE}${suffix}`;
}

function buildTurnPrefixUserText(conversationText: string, instructions?: string): string {
	const focus = instructions?.trim();
	const suffix = focus ? `\n\nAdditional focus: ${focus}` : "";
	return `<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE}${suffix}`;
}

async function runSummaryStream(
	input: CompactInput,
	userText: string,
	systemPrompt: string,
	maxTokens: number,
): Promise<string> {
	const options: Record<string, unknown> = { maxTokens };
	if (input.apiKey !== undefined) options.apiKey = input.apiKey;
	if (input.headers !== undefined) options.headers = input.headers;
	if (input.signal !== undefined) options.signal = input.signal;

	const context = {
		systemPrompt,
		messages: [buildUserMessage(userText)],
	};

	const events = stream(
		input.model as unknown as Parameters<typeof stream>[0],
		context as unknown as Parameters<typeof stream>[1],
		options as unknown as Parameters<typeof stream>[2],
	);

	let summary = "";
	for await (const event of events) {
		if (event.type === "done") {
			summary = textFromAssistant(event.message);
			break;
		}
		if (event.type === "error") {
			const reason = event.error.errorMessage ?? "unknown error";
			throw new Error(`compaction stream failed: ${reason}`);
		}
	}
	return summary.trim();
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
	// summary is canonical history. Restrict the cut search and the pre-slice
	// to entries strictly after that boundary so the next summary builds on
	// the previous one instead of re-summarizing it. Mirrors pi-coding-agent's
	// `boundaryStart = prevCompactionIndex + 1` and `usageStart = prevCompactionIndex`
	// in compaction.ts:619-628.
	const prevCompactionIndex = findLatestCompactionIndex(input.entries);
	const boundaryStart = prevCompactionIndex + 1;
	const usageStart = prevCompactionIndex >= 0 ? prevCompactionIndex : 0;
	const usageEntries = input.entries.slice(usageStart);
	const lastUsage = getLastAssistantUsage(usageEntries);
	const tokensBefore = calculateContextTokens(usageEntries, lastUsage);
	const cut = findCutPoint(input.entries, keepRecentTokens, { startIndex: boundaryStart });
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const pre = input.entries.slice(boundaryStart, Math.max(boundaryStart, historyEnd));
	const turnPrefix = cut.isSplitTurn
		? input.entries.slice(Math.max(boundaryStart, cut.turnStartIndex), cut.firstKeptEntryIndex)
		: [];
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
	if (pre.length > 0) {
		const conversationText = serializeConversation(pre);
		const userText = buildUserText(conversationText, input.instructions);
		const historySummary = await runSummaryStream(input, userText, systemPrompt, maxTokens);
		if (historySummary.length > 0) summaryParts.push(historySummary);
	}
	if (turnPrefix.length > 0) {
		const conversationText = serializeConversation(turnPrefix);
		const userText = buildTurnPrefixUserText(conversationText, input.instructions);
		const prefixSummary = await runSummaryStream(input, userText, systemPrompt, maxTokens);
		if (prefixSummary.length > 0) {
			summaryParts.push(`**Turn Context (split turn):**\n\n${prefixSummary}`);
		}
	}

	const summary = summaryParts.join("\n\n---\n\n").trim();

	return {
		summary,
		firstKeptEntryIndex: cut.firstKeptEntryIndex,
		firstKeptTurnId: firstKept?.turnId ?? null,
		tokensBefore,
		messagesSummarized: pre.length + turnPrefix.length,
		isSplitTurn: cut.isSplitTurn,
	};
}

interface TextBlock {
	type: "text";
	text: string;
}

function textFromAssistant(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content: unknown }).content;
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
