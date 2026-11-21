/**
 * Branch summary builders.
 *
 * Deterministic text assembly for the compaction prompt. The summarization
 * model is asked to read a serialized conversation and emit a structured
 * checkpoint; serializing the conversation ourselves (rather than handing
 * over raw messages) prevents the model from treating the prompt as an
 * ongoing conversation to continue.
 *
 * Ports pi-coding-agent's `serializeConversation` + the split-turn helpers
 * in compaction.ts, adapted to Clio's SessionEntry union.
 */

import { displayToolCall, gatewayChainPlan, isGatewayChain } from "../../../tools/gateway-display.js";
import type { MessageEntry, SessionEntry } from "../entries.js";
import {
	contentBlocks,
	messageText,
	payloadObject,
	toolCallArguments,
	toolResultValue,
} from "../message-projection.js";

/**
 * Tool-result and bash bodies are truncated to this char count inside
 * summaries unless the caller gives a larger per-body cap.
 */
export const TOOL_RESULT_MAX_CHARS = 2000;

export interface SerializeConversationOptions {
	/** Per-body char cap for tool results and bash output; defaults to TOOL_RESULT_MAX_CHARS. */
	toolResultMaxChars?: number;
	/** Per-message char cap for user and assistant text; unset keeps every message whole. */
	messageMaxChars?: number;
	/** An assistant message follows these entries on the path, so a call already read every tool result in them. */
	assistantFollows?: boolean;
	/** Signature skeletons of code reads by tool-result turn id (`codeReadSkeletons`), used only for a body over the cap. */
	skeletons?: ReadonlyMap<string, CodeReadSkeleton>;
}

export interface CodeReadSkeleton {
	text: string;
	/** Function bodies the skeleton reduced to a marker line. */
	bodies: number;
}

export interface PreparedBranchEntries {
	/** Entries up to (exclusive) the first-kept index. These get summarized. */
	pre: SessionEntry[];
	/** Entries at and after the first-kept index. These remain verbatim. */
	post: SessionEntry[];
}

/**
 * Keeps a body's head and tail around the omission marker, so a value near the
 * end of a long read reaches the summarizer as well as its opening does.
 */
function readNote(seen: boolean): string {
	return seen
		? "the assistant read this result in full"
		: "clipped before the assistant read it, so a narrow re-read is expected";
}

function truncate(text: string, max: number, seen: boolean): string {
	if (text.length <= max) return text;
	const read = readNote(seen);
	const head = Math.ceil(max / 2);
	return `${text.slice(0, head)}\n\n[... ${text.length - max} more characters not shown here; ${read}]\n\n${text.slice(text.length - (max - head))}`;
}

/**
 * A code read over the cap goes to the summarizer as its signatures (CTX-17): every declaration a later turn may name
 * survives, where a head-and-tail clip kept the bodies at both ends and dropped every signature between them. A
 * skeleton still over the cap is clipped the same way.
 */
function signaturesOnly(skeleton: CodeReadSkeleton, max: number, seen: boolean): string {
	const bodies = `${skeleton.bodies} function bod${skeleton.bodies === 1 ? "y" : "ies"}`;
	return `[Signatures only: ${bodies} omitted to fit the summary; ${readNote(seen)}]\n${truncate(skeleton.text, max, seen)}`;
}

/** Keeps a message's head and tail around an omission marker; the ledger keeps the raw turn. */
function clipMessage(text: string, max: number | undefined): string {
	if (max === undefined || text.length <= max) return text;
	const head = Math.ceil(max / 2);
	const tail = max - head;
	return `${text.slice(0, head)}\n\n[... ${text.length - max} characters omitted from this message; the full text is in the session ledger ...]\n\n${text.slice(text.length - tail)}`;
}

function stringifyPreview(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// Payload shapes are read through `message-projection.ts`, the one reader the
// observation source shares: a string, `{ text }`, or `{ content: [...] }`.

function assistantThinkingText(entry: MessageEntry): string {
	const payload = entry.payload;
	const explicit = payloadObject(payload)?.thinking;
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	return contentBlocks(payload)
		.filter((block) => block.type === "thinking" && typeof block.thinking === "string")
		.map((block) => block.thinking as string)
		.join("\n");
}

function assistantToolCalls(entry: MessageEntry): ReadonlyArray<Record<string, unknown>> {
	return contentBlocks(entry.payload).filter((block) => block.type === "toolCall");
}

function assistantToolCallsText(entry: MessageEntry, messageMax: number | undefined): string {
	const calls = assistantToolCalls(entry).map((block) => {
		const name = typeof block.name === "string" && block.name.length > 0 ? block.name : "tool";
		return displayCallText(name, block.arguments ?? block.args ?? block.input, messageMax);
	});
	return calls.join("; ");
}

function toolCallText(entry: MessageEntry, messageMax: number | undefined): string {
	const obj = payloadObject(entry.payload);
	if (!obj) return messageText(entry);
	const name = typeof obj.name === "string" ? obj.name : typeof obj.toolName === "string" ? obj.toolName : "tool";
	const args = toolCallArguments(obj);
	if (args !== undefined) return displayCallText(name, args, messageMax);
	return messageText(entry) || name;
}

/**
 * Chat persists one call twice: as a toolCall block in the assistant message
 * and as the tool_call row written when it starts. The assistant block comes
 * first and renders the call, so a row whose id one of them carries is
 * skipped. A row with no such block in the slice, as in legacy ledgers or a
 * slice cut between the two, still renders.
 */
function assistantCallIds(entries: ReadonlyArray<SessionEntry>): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.kind !== "message" || entry.role !== "assistant") continue;
		for (const block of assistantToolCalls(entry)) if (typeof block.id === "string") ids.add(block.id);
	}
	return ids;
}

/**
 * A summary names the capability that ran, as the transcript and /tree do: the
 * coordinator reaches most capabilities through gateway op=call or a chain.
 */
function displayCallText(name: string, args: unknown, messageMax: number | undefined): string {
	if (isGatewayChain(name, args)) {
		const steps = gatewayChainPlan(name, args).map((step) => step.capability);
		return `gateway chain(${steps.join(", ")})`;
	}
	const call = displayToolCall(name, args);
	if (args === undefined) return call.toolName;
	// Arguments take the message clip, so a large write body cannot hold a slice over budget.
	const shown = clipMessage(stringifyPreview(call.viaGateway ? (call.args ?? {}) : args), messageMax);
	return `${call.toolName}(${shown})${call.viaGateway ? " via gateway" : ""}`;
}

function toolResultText(entry: MessageEntry): string {
	const obj = payloadObject(entry.payload);
	const result = obj === null ? undefined : toolResultValue(obj);
	if (Array.isArray(payloadObject(result)?.content)) {
		const parts = contentBlocks(result)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string);
		if (parts.length > 0) return parts.join("\n");
	}
	const textResult = payloadObject(result)?.text;
	if (typeof textResult === "string") return textResult;
	const text = messageText(entry);
	if (text.length > 0) return text;
	return stringifyPreview(result ?? entry.payload);
}

/**
 * Walk entries in order and emit `[Role]: body` sections suitable for
 * embedding inside a `<conversation>...</conversation>` block. Output is
 * stable for a given input. Tests rely on this determinism.
 *
 * Non-context-bearing kinds (modelChange, thinkingLevelChange, fileEntry,
 * sessionInfo, protectedArtifact, taskLedger, decisionLedger, custom) are skipped: they never contribute
 * to the replayed LLM context, so summarizing them would waste tokens on
 * bookkeeping.
 */
export function serializeConversation(
	entries: ReadonlyArray<SessionEntry>,
	options: SerializeConversationOptions = {},
): string {
	const bodyMax = options.toolResultMaxChars ?? TOOL_RESULT_MAX_CHARS;
	const messageMax = options.messageMaxChars;
	const renderedCalls = assistantCallIds(entries);
	// A result after the last assistant message reached no model call, unless the caller knows one follows the slice.
	const seenBefore = options.assistantFollows
		? entries.length
		: entries.map((entry) => entry.kind === "message" && entry.role === "assistant").lastIndexOf(true);
	const parts: string[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.kind === "message") {
			const text = messageText(entry).trim();
			switch (entry.role) {
				case "user":
					if (text.length === 0) break;
					parts.push(`[User]: ${clipMessage(text, messageMax)}`);
					break;
				case "assistant": {
					const thinking = assistantThinkingText(entry).trim();
					const calls = assistantToolCallsText(entry, messageMax).trim();
					if (thinking.length > 0) parts.push(`[Assistant thinking]: ${clipMessage(thinking, messageMax)}`);
					if (text.length > 0) parts.push(`[Assistant]: ${clipMessage(text, messageMax)}`);
					if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls}`);
					break;
				}
				case "tool_call": {
					const id = payloadObject(entry.payload)?.toolCallId;
					if (typeof id === "string" && renderedCalls.has(id)) break;
					parts.push(`[Assistant tool calls]: ${toolCallText(entry, messageMax).trim()}`);
					break;
				}
				case "tool_result": {
					const body = toolResultText(entry).trim();
					const skeleton = body.length > bodyMax ? options.skeletons?.get(entry.turnId) : undefined;
					const seen = index < seenBefore;
					parts.push(`[Tool result]: ${skeleton ? signaturesOnly(skeleton, bodyMax, seen) : truncate(body, bodyMax, seen)}`);
					break;
				}
				case "system":
					if (text.length === 0) break;
					parts.push(`[System]: ${text}`);
					break;
				case "checkpoint":
					// Checkpoint markers are bookkeeping; do not inject into summaries.
					break;
			}
			continue;
		}
		if (entry.kind === "bashExecution") {
			// `!!` is an operator-private terminal command. Its immutable ledger
			// entry remains available to transcript replay, but neither its command
			// nor its output may cross a model boundary through compaction.
			if (entry.excludeFromContext === true) continue;
			parts.push(`[Bash]: $ ${entry.command}\n${truncate(entry.output, bodyMax, index < seenBefore)}`);
			continue;
		}
		if (entry.kind === "branchSummary") {
			parts.push(`[Branch summary]: ${entry.summary}`);
			continue;
		}
		if (entry.kind === "compactionSummary") {
			parts.push(`[Prior summary]: ${entry.summary}`);
			continue;
		}
		if (entry.kind === "skillActivation") {
			const activation = entry.activation;
			parts.push(
				`[Skill activation]: ${activation.name} source=${activation.source} hash=${activation.hash} path=${activation.filePath} triggeredBy=${activation.triggeredBy}`,
			);
		}
		// custom, modelChange, thinkingLevelChange, fileEntry, sessionInfo,
		// protectedArtifact, taskLedger, decisionLedger, and workerRun do not
		// project into the serialized conversation. Neither do handoffTransaction
		// and continuityCommit: this is an allowlist, so transaction JSON can
		// never reach the summarization prompt as if it were conversation, and
		// the accepted note is never regenerated from summarizer prose.
	}
	return parts.join("\n\n");
}

/**
 * Skeletons of the code reads among `entries` whose body is longer than `minChars`, keyed by tool-result turn id, for
 * `serializeConversation`'s `skeletons`. A read is a `read` call, direct or through the gateway, whose path names a
 * language with a vendored grammar; any other result, and any read the parser cannot skeletonize, has no entry and
 * keeps the plain clip. The parser loads on first use, never at boot.
 */
export async function codeReadSkeletons(
	entries: ReadonlyArray<SessionEntry>,
	minChars: number,
): Promise<ReadonlyMap<string, CodeReadSkeleton>> {
	const paths = new Map<string, string>();
	const note = (id: unknown, name: unknown, args: unknown) => {
		if (typeof id !== "string" || typeof name !== "string") return;
		const call = displayToolCall(name, args);
		const path = payloadObject(call.args)?.path;
		if (call.toolName === "read" && typeof path === "string" && path.length > 0) paths.set(id, path);
	};
	for (const entry of entries) {
		if (entry.kind !== "message") continue;
		if (entry.role === "assistant")
			for (const block of assistantToolCalls(entry))
				note(block.id, block.name, block.arguments ?? block.args ?? block.input);
		if (entry.role === "tool_call") {
			const obj = payloadObject(entry.payload);
			if (obj) note(obj.toolCallId, obj.name ?? obj.toolName, toolCallArguments(obj));
		}
	}
	const reads = entries.flatMap((entry) => {
		if (entry.kind !== "message" || entry.role !== "tool_result") return [];
		const path = paths.get(String(payloadObject(entry.payload)?.toolCallId));
		const body = toolResultText(entry).trim();
		return path !== undefined && body.length > minChars ? [{ turnId: entry.turnId, path, body }] : [];
	});
	const skeletons = new Map<string, CodeReadSkeleton>();
	if (reads.length === 0) return skeletons;
	const { codeSkeleton } = await import("../../context/codewiki/tree-sitter.js");
	for (const read of reads) {
		const skeleton = await codeSkeleton(read.path, read.body);
		if (skeleton) skeletons.set(read.turnId, skeleton);
	}
	return skeletons;
}
