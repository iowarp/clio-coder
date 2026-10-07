import { normalizeTokenUsage } from "../../../core/token-split.js";
import type { ContinuityCheckpointPayload } from "../continuity/contract.js";
/**
 * Compaction orchestration.
 *
 * Given a list of session entries, finds the cut point, summarizes the
 * history portion via the supplied model, and returns the trimmed entry
 * list plus summary metadata. Callers persist the summary via
 * `session.appendEntry({ kind: "compactionSummary", ... })`.
 *
 * The stream call goes through `src/engine/ai.ts` to honor the engine
 * boundary; this module does not import pi-ai directly.
 */

import { streamSimple } from "../../../engine/ai.js";
import type { EngineModel, Usage } from "../../../engine/types.js";
import { effectiveToolCall, expandChainMessages } from "../../../tools/surface.js";
import type { WorkingSetView } from "../../context/working-set/contract.js";
import { foldWorkingSet } from "../../context/working-set/fold.js";
import { projectWorkingSet } from "../../context/working-set/project.js";
import { recallableRefListing } from "../../context/working-set/recall.js";
import { estimateAgentContextTokens, extractReasoningTokens } from "../context-accounting.js";
import type { CompactionSummaryEntry } from "../entries.js";
import {
	type CompactionUsage,
	latestSkillContextState,
	type PreservedUserContext,
	type SessionEntry,
	type SkillContextCheckpoint,
	type SkillContextState,
	skillContextContentHash,
	verifiedSkillContextCheckpoint,
} from "../entries.js";
import { serializeConversation } from "./branch-summary.js";
import { findCutPoint } from "./cut-point.js";
import { DEFAULT_KEEP_RECENT_TOKENS, DEFAULT_RESERVE_TOKENS } from "./defaults.js";
import { type ContinuityNoteCost, calculateContextTokens, estimateTokens, getLastAssistantUsage } from "./tokens.js";

export const COMPACTION_SUMMARY_MAX_TOKENS = 8192;

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

Keep each section concise. Preserve exact file paths, function names, and error messages.

Copy every literal the user stated verbatim into Constraints & Preferences or Critical Context: codewords, passphrases, names, numbers, versions, paths, URLs, identifiers, and decisions the user made. This holds even when the assistant declined to store the value as memory or called it conversation-only. A literal the user asked to be remembered is never droppable.`;

export const COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE = `The messages above are the beginning of the currently active user turn. They will be removed from the live context because the retained suffix starts in the middle of that turn.

When a <previous-context> block is present, it is canonical context from an earlier compaction. Carry its still-relevant constraints, decisions, active skills, unresolved work, exact identifiers, and file state into this checkpoint in addition to the active-turn details below. Do not discard it as unrelated older history.

In addition to that carried-forward context, summarize ONLY the active-turn details needed for another LLM to continue the same request:

- the user's active request
- tool calls already made in this turn
- tool results, file paths, commands, errors, and decisions already observed
- what should happen next
- every literal the user stated verbatim (codewords, names, numbers, paths, decisions), including any the assistant declined to store as memory

Do NOT answer the user. Do NOT summarize unrelated older history.`;

/** Validate the history checkpoint, never the intentionally different split-turn prompt. */
function validateHistorySummary(text: string): void {
	const required = [
		"## Goal",
		"## Constraints & Preferences",
		"## Progress",
		"### Done",
		"### In Progress",
		"### Blocked",
		"## Key Decisions",
		"## Next Steps",
		"## Critical Context",
	];
	const headings: string[] = [];
	let fence: { character: string; length: number } | undefined;
	for (const line of text.split(/\r?\n/)) {
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? "";
			if (!fence) fence = { character: marker[0] ?? "", length: marker.length };
			else if (marker[0] === fence.character && marker.length >= fence.length && !fenceMatch[2]?.trim()) fence = undefined;
			continue;
		}
		if (fence) continue;
		const heading = /^ {0,3}(#{2,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
		if (heading) {
			const normalized = `${heading[1]} ${heading[2]}`;
			if (required.includes(normalized)) headings.push(normalized);
		}
	}
	if (fence || headings.length !== required.length || headings.some((heading, index) => heading !== required[index])) {
		throw new Error(
			"compaction returned an incomplete history checkpoint: required headings must appear in order outside code fences; checkpoint was not saved",
		);
	}
}

/** One invoked summary stream, including failed calls that produce no checkpoint. */
export interface CompactionCallObservation {
	outcome: "success" | "error" | "aborted";
	usage: unknown;
	timestamp: string;
}

export interface CompactInput {
	/** Admission after exact request-fit, before each provider call. */
	beforeSummaryCall?: (() => void | Promise<void>) | undefined;
	/** Price the proposed replay before persisting the operator-visible figures. */
	checkpointTokenFigures?: (entry: Readonly<Omit<CompactionSummaryEntry, "timestamp">>) => {
		tokensBefore: number;
		tokensAfter: number;
	};
	checkpointForSummary?:
		| ((summaryRef: string, tokensBefore: number, tokensAfter: number) => ContinuityCheckpointPayload)
		| undefined;
	/** Ordered active-path session entries to compact; returned cut indexes address this same array. */
	entries: ReadonlyArray<SessionEntry>;
	/** Authoritative main-agent selection; omitted for unknown legacy state. */
	skillContextState?: SkillContextState | null;
	/** Pure source-test seam. Production uses the existing summary stream. */
	summarize?: (request: {
		systemPrompt: string;
		userText: string;
		/** Absent when the model reports no output limit and the server decides. */
		maxTokens?: number;
	}) => Promise<{ text: string; usage?: unknown }>;

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
	/** Carry this user message verbatim if removed; defaults to the latest operator turn for manual compaction. */
	preserveUserTurnId?: string;
	/** A new operator request is pending admission and is not yet in `entries`. */
	pendingOperatorTurn?: boolean;
	/** Accounting observer; called once per invoked stream, including failures. */
	onCall?: (call: CompactionCallObservation) => void;
	/**
	 * The continuity note replay projects, from `continuityProjectionTokens` and
	 * the projection's `noteAnchorTurnId`. The note survives the reduction, so it
	 * is on both sides of the before/after comparison; counting it needs the
	 * session and fork facts the caller has and this module does not, and the
	 * anchor id is what keeps it from being counted twice once a provider usage
	 * anchor already includes it.
	 */
	continuityNote?: ContinuityNoteCost;
}

export interface CompactResult {
	/** The paid checkpoint was discarded because it would not reduce context. */
	noGain?: boolean;
	skillContext?: SkillContextCheckpoint;
	userContext?: PreservedUserContext;
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

/**
 * The ledger chains entries linearly, so a result's parent is its own call only
 * when that call was alone in its batch. In a parallel batch the parent chain
 * runs back through sibling calls, results and activation receipts. The load is
 * still verifiable when that chain reaches the call without crossing another
 * assistant or user message, which would make it a different exchange.
 */
function resultFollowsCallInBatch(
	turn: ReadonlyArray<SessionEntry>,
	resultEntry: SessionEntry,
	call: SessionEntry,
): boolean {
	let parent = resultEntry.parentTurnId;
	for (let hops = 0; hops < turn.length && parent; hops++) {
		if (parent === call.turnId) return true;
		const link = turn.find((candidate) => candidate.turnId === parent);
		if (!link) return false;
		if (link.kind === "message" && link.role !== "tool_call" && link.role !== "tool_result") return false;
		parent = link.parentTurnId;
	}
	return false;
}

interface HistoricalSkillCall {
	args: Record<string, unknown>;
	stepId?: string;
}

function historicalSkillCall(payload: Record<string, unknown> | null, name: string): HistoricalSkillCall | null {
	if (!payload || typeof payload.name !== "string") return null;
	const effective = effectiveToolCall(payload.name, payload.args);
	if (effective.toolName === "context" && effective.args?.scope === "skills" && effective.args.name === name)
		return { args: effective.args };
	const args = payloadObject(payload.args);
	if (payload.name !== "gateway" || args?.op !== "chain" || !Array.isArray(args.steps)) return null;
	const steps = args.steps
		.map(payloadObject)
		.filter(
			(step) =>
				step?.capability === "context" &&
				payloadObject(step.args)?.scope === "skills" &&
				payloadObject(step.args)?.name === name,
		);
	const step = steps[0];
	const stepArgs = payloadObject(step?.args);
	return steps.length === 1 && typeof step?.id === "string" && stepArgs ? { args: stepArgs, stepId: step.id } : null;
}

/**
 * Prove the child instructions were actually visible in the complete
 * aggregate: the step settled untruncated (`details.steps`), the child receipt
 * pairs with the call, and the aggregate text carries that receipt verbatim.
 */
function historicalSkillReceipt(
	call: HistoricalSkillCall,
	result: Record<string, unknown> | null,
	summary: Record<string, unknown> | null,
): { result: Record<string, unknown> | null; summary: Record<string, unknown> | null } | null {
	if (call.stepId === undefined) return { result, summary };
	const details = payloadObject(result?.details);
	if (
		details?.op !== "chain" ||
		details.capability !== "context" ||
		summary?.truncated !== false ||
		!Array.isArray(details.chainResults) ||
		!Array.isArray(details.steps) ||
		!Array.isArray(result?.content)
	)
		return null;
	const children = details.chainResults.map(payloadObject).filter((child) => child?.id === call.stepId);
	const child = children[0];
	const receipt = payloadObject(child?.result);
	if (
		children.length !== 1 ||
		child?.capability !== "context" ||
		child.isError !== false ||
		JSON.stringify(child.args) !== JSON.stringify(call.args) ||
		!Array.isArray(receipt?.content)
	)
		return null;
	const rows = details.steps.map(payloadObject).filter((row) => row?.id === call.stepId);
	const row = rows[0];
	if (rows.length !== 1 || row?.capability !== "context" || row.kind !== "ok" || row.truncated !== false) return null;
	const text = (content: unknown[]) => content.map((block) => payloadObject(block)?.text).join("\n");
	const aggregate = text(result.content);
	const body = text(receipt.content);
	// The model read the body only if it sits whole under its own step header
	// and runs to the next section or the end. The header spelling mirrors
	// `chainStepHeader` in src/tools/gateway/chain.ts; the chained-skill
	// contract in tests/contracts/chain-output-eviction.test.ts fails if they drift.
	const section = `### step ${call.stepId} (context): ok\n${body}`;
	const at = aggregate.indexOf(section);
	const end = at + section.length;
	if (
		at < 0 ||
		(at > 0 && !aggregate.startsWith("\n\n", at - 2)) ||
		(end !== aggregate.length && !aggregate.startsWith("\n\n", end))
	)
		return null;
	return { result: receipt, summary: { bytes: Buffer.byteLength(body, "utf8"), truncated: false } };
}

/** Recover only complete, uniquely paired historical main-agent loads. Never consult current disk. */
export function captureSkillContext(
	entries: ReadonlyArray<SessionEntry>,
	selection: SkillContextState | undefined,
): SkillContextCheckpoint | undefined {
	if (!selection || selection.unknown) return undefined;
	const newestSelected = Math.max(
		-1,
		...selection.activationRefs.map((ref) => entries.findIndex((entry) => entry.turnId === ref)),
	);
	if (
		selection.activationRefs.length > 0 &&
		entries
			.slice(newestSelected + 1)
			.some((entry) => entry.kind === "skillActivation" && entry.activation.runId === undefined)
	)
		return undefined;
	const skills: SkillContextCheckpoint["skills"] = [];
	for (const ref of selection.activationRefs) {
		const matches = entries.filter((entry) => entry.turnId === ref);
		const entry = matches[0];
		if (matches.length !== 1 || entry?.kind !== "skillActivation") return undefined;
		const activation = entry.activation;
		if (
			activation.runId !== undefined ||
			activation.triggeredBy !== "tool" ||
			!activation.turnId ||
			activation.drift === "mismatch"
		)
			return undefined;
		// A later load with the same name supersedes this receipt, even if the later evidence is incomplete.
		if (
			entries
				.slice(entries.indexOf(entry) + 1)
				.some(
					(later) =>
						later.kind === "skillActivation" &&
						later.activation.runId === undefined &&
						later.activation.name === activation.name,
				)
		)
			return undefined;
		const request = entries.find((candidate) => candidate.turnId === activation.turnId);
		if (request?.kind !== "message" || request.role !== "user") return undefined;
		const start = entries.indexOf(request);
		const next = entries.findIndex(
			(candidate, index) => index > start && candidate.kind === "message" && candidate.role === "user",
		);
		const turn = entries.slice(start, next < 0 ? undefined : next);
		if (!turn.includes(entry)) return undefined;
		const calls = turn.filter((candidate) => {
			if (candidate.kind !== "message" || candidate.role !== "tool_call") return false;
			const payload = payloadObject(candidate.payload);
			return historicalSkillCall(payload, activation.name) !== null;
		});
		if (calls.length !== 1) return undefined;
		const call = calls[0];
		if (call?.kind !== "message") return undefined;
		const selectedCall = historicalSkillCall(payloadObject(call.payload), activation.name);
		if (!selectedCall) return undefined;
		const callId = payloadObject(call.payload)?.toolCallId;
		if (typeof callId !== "string" || !callId) return undefined;
		const assistant = turn.find((candidate) => candidate.turnId === call.parentTurnId);
		if (
			assistant?.kind !== "message" ||
			assistant.role !== "assistant" ||
			!contentBlocks(assistant.payload).some(
				(block) =>
					block.type === "toolCall" &&
					block.id === callId &&
					block.name === payloadObject(call.payload)?.name &&
					JSON.stringify(block.arguments) === JSON.stringify(payloadObject(call.payload)?.args),
			)
		)
			return undefined;
		const results = entries.filter(
			(candidate) =>
				candidate.kind === "message" &&
				candidate.role === "tool_result" &&
				payloadObject(candidate.payload)?.toolCallId === callId,
		);
		const resultEntry = results[0];
		if (
			results.length !== 1 ||
			resultEntry?.kind !== "message" ||
			!turn.includes(resultEntry) ||
			!resultFollowsCallInBatch(turn, resultEntry, call) ||
			entry.parentTurnId !== request.turnId
		)
			return undefined;
		const payload = payloadObject(resultEntry.payload);
		const selectedReceipt = historicalSkillReceipt(
			selectedCall,
			payloadObject(payload?.result),
			payloadObject(payload?.resultSummary),
		);
		if (!selectedReceipt) return undefined;
		const result = selectedReceipt.result;
		const details = payloadObject(result?.details);
		const observation = payloadObject(details?.observation);
		const resultSummary = selectedReceipt.summary;
		const summaryObservation = payloadObject(resultSummary?.observation);
		const sourceInfo = payloadObject(details?.sourceInfo);
		if (
			payload === null ||
			payload.toolName !== payloadObject(call.payload)?.name ||
			payload.isError !== false ||
			payload.outcome !== "ok" ||
			details?.kind !== "ok" ||
			observation?.truncated !== false ||
			details.workingSet !== undefined ||
			details.contextCompaction !== undefined ||
			resultSummary?.truncated !== false ||
			summaryObservation?.truncated === true ||
			details.name !== activation.name ||
			details.path !== activation.filePath ||
			details.hash !== activation.hash ||
			details.source !== activation.source ||
			details.sourceOrigin !== activation.sourceOrigin ||
			sourceInfo?.path !== activation.filePath ||
			sourceInfo.scope !== details.scope ||
			sourceInfo.source !== activation.sourceOrigin ||
			(details.drift !== undefined && details.drift !== "match") ||
			details.drift !== activation.drift ||
			!Array.isArray(result?.content) ||
			!result.content.every((block: unknown) => {
				const obj = payloadObject(block);
				return obj?.type === "text" && typeof obj.text === "string";
			})
		)
			return undefined;
		const content = result.content as Array<{ type: "text"; text: string }>;
		const text = content.map((block) => block.text).join("\n");
		if (
			observation.shownBytes !== Buffer.byteLength(text, "utf8") ||
			observation.totalBytes !== observation.shownBytes ||
			resultSummary?.bytes !== observation.shownBytes
		)
			return undefined;
		const requestPayload = payloadObject(request.payload);
		const operatorText = requestPayload?.operatorText;
		const requestText =
			typeof operatorText === "string" && operatorText.trim().length > 0 ? operatorText : requestPayload?.text;
		if (typeof requestText !== "string") return undefined;
		skills.push({
			activationRef: ref,
			requestRef: request.turnId,
			callRef: call.turnId,
			resultRef: resultEntry.turnId,
			activation: structuredClone(activation),
			requestText,
			content: structuredClone(content),
			contentHash: skillContextContentHash(content),
		});
	}
	const checkpoint = { version: 1 as const, skills };
	return verifiedSkillContextCheckpoint(checkpoint) ? checkpoint : undefined;
}

function buildPreviousContextPrefix(previousContextText: string): string {
	const trimmed = previousContextText.trim();
	return trimmed.length > 0 ? `<previous-context>\n${trimmed}\n</previous-context>\n\n` : "";
}

/**
 * Manual `/compact <text>` instructions. A trailing "Additional focus" line
 * after the split-turn template's "summarize ONLY" scope was ignored by a live
 * summarizer that dropped the session routes the operator asked it to keep
 * (DF-7), so they now outrank the template and name facts outside the transcript.
 */
function buildOperatorInstructions(instructions?: string): string {
	const focus = instructions?.trim();
	if (!focus) return "";
	return `\n\n<operator-instructions>\n${focus}\n</operator-instructions>\nThe operator wrote these instructions for this checkpoint. They override the default scope above: keep every fact, value and decision they name in the checkpoint, even when the conversation does not show it.`;
}

function buildUserText(conversationText: string, instructions?: string, previousContextText = ""): string {
	return `${buildPreviousContextPrefix(previousContextText)}<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_USER_PROMPT_TEMPLATE}${buildOperatorInstructions(instructions)}`;
}

function buildTurnPrefixUserText(conversationText: string, instructions?: string, previousContextText = ""): string {
	return `${buildPreviousContextPrefix(previousContextText)}<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE}${buildOperatorInstructions(instructions)}`;
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

/**
 * Sentences where the operator asked Clio to remember something. A summarizing
 * model may drop such a value when the assistant declined to store it as
 * memory (p6/U1: `MARBLE-OTTER` survived live replay and not a resume), so
 * these sentences are carried verbatim next to the generated summary instead
 * of trusting it to keep them.
 */
const OPERATOR_NOTE_SENTENCE = /^(?:please\s+)?(?:remember|keep in mind|don'?t forget)\b/iu;
const OPERATOR_NOTE_MAX_CHARS = 400;
const OPERATOR_NOTE_MAX_COUNT = 30;
const OPERATOR_NOTES_BLOCK = /<operator-notes\b([^>]*)>\s*\n([\s\S]*?)\n\s*<\/operator-notes\s*>/giu;

function escapeOperatorNote(note: string): string {
	return note.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function unescapeOperatorNote(note: string): string {
	return note.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
}

function operatorMessageText(entry: SessionEntry): string | null {
	if (entry.kind !== "message" || entry.role !== "user") return null;
	const payload = payloadObject(entry.payload);
	if (payload === null || payload.synthetic === true) return null;
	if (typeof payload.operatorText === "string") return payload.operatorText;
	if (typeof payload.text === "string") return payload.text;
	const parts = contentBlocks(payload)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string);
	return parts.length > 0 ? parts.join("\n") : null;
}

function extractOperatorNotes(entries: ReadonlyArray<SessionEntry>, latest?: string): string[] {
	const notes = new Set<string>();
	const add = (note: string): void => {
		const trimmed = note.trim();
		if (trimmed.length === 0) return;
		notes.add(trimmed.length > OPERATOR_NOTE_MAX_CHARS ? `${trimmed.slice(0, OPERATOR_NOTE_MAX_CHARS - 3)}...` : trimmed);
	};
	for (const entry of entries) {
		if (entry.kind === "compactionSummary") {
			for (const [, attributes, body] of entry.summary.matchAll(OPERATOR_NOTES_BLOCK)) {
				const escaped = /\bencoding=["']xml["']/iu.test(attributes ?? "");
				for (const line of (body ?? "").split("\n")) {
					const note = line.replace(/^- /u, "").trim();
					add(escaped ? unescapeOperatorNote(note) : note);
				}
			}
			continue;
		}
		const text = operatorMessageText(entry);
		if (text === null) continue;
		for (const sentence of text.split(/\n+|(?<=[.!?])\s+/u)) {
			const trimmed = sentence.trim();
			if (!OPERATOR_NOTE_SENTENCE.test(trimmed)) continue;
			add(trimmed);
		}
	}
	if (latest !== undefined) add(latest);
	return [...notes].slice(-OPERATOR_NOTE_MAX_COUNT);
}

function formatOperatorNotes(notes: ReadonlyArray<string>): string {
	if (notes.length === 0) return "";
	// Encode delimiters before promoting operator text into checkpoint context (p6/U1).
	return `\n\n<operator-notes encoding="xml">\n${notes.map((note) => `- ${escapeOperatorNote(note)}`).join("\n")}\n</operator-notes>`;
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
	// Chained read, write and edit steps touch files the summary must name.
	for (const entry of expandChainMessages(entries)) {
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

function formatRecallableRefs(
	entries: ReadonlyArray<SessionEntry>,
	firstKeptEntryIndex: number,
	view: WorkingSetView,
): string {
	const entryIndexes = new Map<string, number>();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry) entryIndexes.set(entry.turnId, index);
	}
	const evictedBeforeCut = new Map(
		[...view.evicted].filter(([ref]) => (entryIndexes.get(ref) ?? Number.POSITIVE_INFINITY) < firstKeptEntryIndex),
	);
	const listing = recallableRefListing(entries, { ...view, evicted: evictedBeforeCut });
	if (
		listing.refs.length === 0 &&
		!entries.slice(0, firstKeptEntryIndex).some((entry) => entry.kind === "message" && entry.role === "tool_result")
	)
		return "";
	const rows = [...listing.refs];
	if (listing.remaining > 0) rows.push(`and ${listing.remaining} more`);
	rows.push(
		'Preview only. Persisted original tool results removed by this summary are also recallable. Discover all active-path results with context(scope="recall", limit=8, offset=0), omitting ref; query filters path/tool/ref terms. Follow nextOffset, then recall the selected ref.',
	);
	return `\n\n<recallable-refs>\n${rows.join("\n")}\n</recallable-refs>`;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fold one summarization call's provider usage into the running total. A split
 * turn runs two calls; both are billed, so both are counted. Missing provider
 * counts stay separate from the known token subtotal.
 */
function addCompactionUsage(total: CompactionUsage | undefined, raw: unknown): CompactionUsage | undefined {
	const usage = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<Usage> & {
		reasoning?: number;
	};
	const { input, output, cacheRead, cacheWrite, reasoning, totalTokens, observed } = normalizeTokenUsage(
		usage as Record<string, unknown>,
	);
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
		...(base.cacheWrite1h === undefined && usage.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: (base.cacheWrite1h ?? 0) + numberOrZero(usage.cacheWrite1h) }),
		reasoning: base.reasoning + reasoning,
		totalTokens: base.totalTokens + totalTokens,
		cost: { total: base.cost.total + numberOrZero(usage.cost?.total) },
		apiCalls: base.apiCalls + 1,
		...((base.missingTokenCalls ?? 0) + (observed ? 0 : 1) > 0
			? { missingTokenCalls: (base.missingTokenCalls ?? 0) + (observed ? 0 : 1) }
			: {}),
	};
}

/** Keep attributable partial facts if a failed terminal object resets missing fields to zero. */
function retainReportedUsage(previous: Record<string, unknown>, raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return previous;
	const usage = raw as Record<string, unknown>;
	const known = { ...previous };
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens"]) {
		const value = numberOrZero(usage[field]);
		if (value > 0) known[field] = value;
	}
	const reasoning = extractReasoningTokens({ ...usage, reasoningTokens: undefined });
	if (reasoning !== null && reasoning > 0) known.reasoning = reasoning;
	if (usage.cost && typeof usage.cost === "object" && "total" in usage.cost) {
		const cost = numberOrZero(usage.cost.total);
		if (cost > 0) known.cost = { total: cost };
	}
	return known;
}

async function runSummaryStream(
	input: CompactInput,
	userText: string,
	systemPrompt: string,
	maxTokens: number | undefined,
): Promise<{ text: string; usage: unknown }> {
	const options: Record<string, unknown> = {};
	if (input.apiKey !== undefined) options.apiKey = input.apiKey;
	if (input.headers !== undefined) options.headers = input.headers;
	if (input.signal !== undefined) options.signal = input.signal;

	const context = {
		systemPrompt,
		messages: [buildUserMessage(userText)],
	};
	// Price the complete serialized request, including templates, previous
	// context, custom instructions and message overhead. This is the shared
	// estimate, not provider-exact tokenization; never truncate constraints to
	// make an oversized projected conversation fit.
	const estimatedInput = estimateAgentContextTokens(context);
	const contextWindow = input.model.contextWindow;
	if (!Number.isFinite(contextWindow) || contextWindow < 0) {
		throw new Error("compaction requires a non-negative finite model context window");
	}
	// An unreported serving window is 0, not a zero-token window. The reactive
	// overflow retry compacts on exactly such routes, so the server judges the
	// summary request and the fit check applies only to a known window.
	if (contextWindow > 0) {
		// The output budget is a ceiling. A small window keeps whatever the request
		// leaves it, down to the 1024-token floor compact() sets; a summary that
		// needs more stops at the length check below and is never saved.
		const minOutput = Math.min(maxTokens ?? 1024, 1024);
		if (estimatedInput + minOutput > contextWindow) {
			throw new Error(
				`compaction estimated input ${estimatedInput} tokens plus output ${minOutput} tokens exceeds model context window ${contextWindow}; use a larger compaction model or reduce the working set`,
			);
		}
		if (maxTokens !== undefined) maxTokens = Math.min(maxTokens, contextWindow - estimatedInput);
	}
	// An unknown output limit sends no explicit cap; the server decides.
	if (maxTokens !== undefined) options.maxTokens = maxTokens;

	input.signal?.throwIfAborted();
	await input.beforeSummaryCall?.();
	const timestamp = new Date().toISOString();
	let usage: unknown;
	let reported: Record<string, unknown> = {};
	let outcome: CompactionCallObservation["outcome"] = "error";
	try {
		if (input.summarize) {
			const response = await input.summarize({
				systemPrompt,
				userText,
				...(maxTokens !== undefined ? { maxTokens } : {}),
			});
			usage = response.usage;
			reported = retainReportedUsage(reported, usage);
			input.signal?.throwIfAborted();
			outcome = "success";
			return { text: response.text.trim(), usage };
		}
		// Summarization requests thinking off, as its resolver does. Bare stream
		// infers an active level from model.reasoning and would undo that choice.
		const events = streamSimple(
			input.model,
			context as unknown as Parameters<typeof streamSimple>[1],
			options as unknown as Parameters<typeof streamSimple>[2],
		);
		for await (const event of events) {
			// Some transports throw after yielding a partial response. Retain the
			// last reported usage even without a terminal error message.
			if ("partial" in event) {
				usage = event.partial.usage ?? usage;
				reported = retainReportedUsage(reported, usage);
			}
			if (event.type === "done") {
				usage = event.message.usage ?? usage;
				reported = retainReportedUsage(reported, usage);
				input.signal?.throwIfAborted();
				if (event.reason === "length" || event.message.stopReason === "length") {
					throw new Error("compaction summary reached the model output limit; incomplete checkpoint was not saved");
				}
				outcome = "success";
				return { text: textFromAssistant(event.message).trim(), usage };
			}
			if (event.type === "error") {
				usage = event.error.usage ?? usage;
				reported = retainReportedUsage(reported, usage);
				outcome = event.error.stopReason === "aborted" ? "aborted" : "error";
				throw new Error(`compaction stream failed: ${event.error.errorMessage ?? "unknown error"}`);
			}
		}
		throw new Error("compaction stream ended without a terminal response");
	} finally {
		input.onCall?.({
			outcome: outcome === "error" && input.signal?.aborted ? "aborted" : outcome,
			usage: outcome === "success" ? usage : reported,
			timestamp,
		});
	}
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
	// Apply the same ledger decisions as live replay before pricing or
	// serializing any slice, including the prior checkpoint's retained suffix.
	// Projection preserves positions and turn IDs; cuts still address the raw
	// input, which remains untouched and available for exact recall.
	const workingSet = foldWorkingSet(input.entries);
	const entries = projectWorkingSet(input.entries, workingSet);
	// Iterative compaction: when a prior `compactionSummary` exists, the
	// summary is canonical history. Restrict the cut search and the new-history
	// slice to entries strictly after that boundary; the canonical summary and
	// its retained suffix are recovered below and prepended explicitly rather
	// than rediscovering already-compacted raw history. Mirrors pi-coding-agent's
	// `boundaryStart = prevCompactionIndex + 1` and `usageStart = prevCompactionIndex`
	// in compaction.ts:619-628.
	const prevCompactionIndex = findLatestCompactionIndex(entries);
	const boundaryStart = prevCompactionIndex + 1;
	const selection =
		input.skillContextState === null ? undefined : (input.skillContextState ?? latestSkillContextState(input.entries));
	let skillContext = captureSkillContext(input.entries, selection);
	const priorCheckpoint = entries[prevCompactionIndex];
	// An explicit-off checkpoint carries an empty skill list: nothing was
	// retained, so nothing needs re-verification and later unknown state must
	// not block compaction forever.
	const priorSkillContext =
		priorCheckpoint?.kind === "compactionSummary" &&
		priorCheckpoint.skillContext !== undefined &&
		priorCheckpoint.skillContext.skills.length > 0
			? priorCheckpoint.skillContext
			: undefined;
	// A typed checkpoint is not regenerated from summary prose. Failure to verify
	// its original receipts prevents another destructive pass.
	if (priorSkillContext !== undefined && !skillContext) {
		throw new Error("cannot verify preserved skill context; retaining the existing checkpoint");
	}
	if (priorSkillContext !== undefined) {
		if (!verifiedSkillContextCheckpoint(priorSkillContext)) throw new Error("invalid preserved skill checkpoint");
		for (const previous of priorSkillContext.skills) {
			const current = skillContext?.skills.find((skill) => skill.activationRef === previous.activationRef);
			if (current && JSON.stringify(current) !== JSON.stringify(previous)) {
				throw new Error("preserved skill context no longer matches its captured receipt");
			}
		}
	}
	if (skillContext && priorSkillContext !== undefined) {
		skillContext = {
			version: 1,
			skills: skillContext.skills.map((skill) =>
				structuredClone(
					priorSkillContext.skills.find((previous) => previous.activationRef === skill.activationRef) ?? skill,
				),
			),
		};
	}
	// A legacy checkpoint (no typed field) never adjudicated older activations,
	// so the fallback clamp stays fail-closed across its boundary. A typed
	// checkpoint already retained or explicitly dropped everything before it.
	const legacyPriorCheckpoint =
		priorCheckpoint?.kind === "compactionSummary" && priorCheckpoint.skillContext === undefined;
	const protectedStart = skillContext
		? null
		: findLatestSkillActivationProtectionStart(entries, legacyPriorCheckpoint ? 0 : boundaryStart);
	const usageStart = prevCompactionIndex >= 0 ? prevCompactionIndex : 0;
	const usageEntries = entries.slice(usageStart);
	const lastUsage = getLastAssistantUsage(usageEntries);
	const tokensBefore = calculateContextTokens(usageEntries, lastUsage, input.continuityNote);
	const rawCut = findCutPoint(entries, keepRecentTokens, { startIndex: boundaryStart });
	const cut =
		protectedStart !== null && rawCut.firstKeptEntryIndex > protectedStart
			? { firstKeptEntryIndex: protectedStart, turnStartIndex: -1, isSplitTurn: false }
			: rawCut;
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const pre = entries.slice(boundaryStart, Math.max(boundaryStart, historyEnd));
	const turnPrefix = cut.isSplitTurn
		? entries.slice(Math.max(boundaryStart, cut.turnStartIndex), cut.firstKeptEntryIndex)
		: [];
	const previousContextEntries = priorCompactionContextEntries(entries, prevCompactionIndex);
	const previousContextText = serializeConversation(previousContextEntries);
	const fileOps = extractFileOps([
		...priorCompactionContextEntries(input.entries, prevCompactionIndex),
		...input.entries.slice(boundaryStart, cut.firstKeptEntryIndex),
	]);
	const firstKept = input.entries[cut.firstKeptEntryIndex] ?? null;
	// The newest complete exchange can begin immediately after the checkpoint.
	// Its earlier retained suffix is still live context, even though it sits
	// before boundaryStart in the append-only ledger. Summarize that suffix
	// with the canonical prior summary instead of declaring nothing to compact.
	// Never use this path to cross a protected cut or to re-summarize a bare
	// checkpoint with no retained work; the caller still enforces request fit.
	const priorSuffix = previousContextEntries.slice(1);
	const summarizePriorSuffix =
		pre.length === 0 &&
		turnPrefix.length === 0 &&
		firstKept !== null &&
		cut.firstKeptEntryIndex >= boundaryStart &&
		priorSuffix.some((entry) => entry.kind === "message" || entry.kind === "bashExecution") &&
		priorSuffix.reduce((tokens, entry) => tokens + estimateTokens(entry), 0) >=
			2 * (priorCheckpoint?.kind === "compactionSummary" ? estimateTokens(priorCheckpoint) : 0);

	if (pre.length === 0 && turnPrefix.length === 0 && !summarizePriorSuffix) {
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
	if (!Number.isFinite(reserveTokens) || reserveTokens <= 0) {
		throw new Error("compaction requires a positive finite reserve token budget");
	}
	// A route that reports no output limit gets no explicit cap and the server
	// decides; refusing it would leave a reactive overflow compaction with no way out.
	const maxTokens =
		Number.isFinite(input.model.maxTokens) && input.model.maxTokens >= 1
			? Math.min(
					COMPACTION_SUMMARY_MAX_TOKENS,
					Math.floor(input.model.maxTokens),
					Math.max(1024, Math.floor(reserveTokens * 0.8)),
				)
			: undefined;
	const summaryParts: string[] = [];
	let usage: CompactionUsage | undefined;
	if (pre.length > 0 || summarizePriorSuffix) {
		const conversationText = serializeConversation(summarizePriorSuffix ? priorSuffix : pre);
		const previousText = summarizePriorSuffix
			? serializeConversation(previousContextEntries.slice(0, 1))
			: previousContextText;
		const userText = buildUserText(conversationText, input.instructions, previousText);
		const historySummary = await runSummaryStream(input, userText, systemPrompt, maxTokens);
		usage = addCompactionUsage(usage, historySummary.usage);
		if (historySummary.text.length === 0) throw new Error("compaction returned an empty history summary");
		validateHistorySummary(historySummary.text);
		summaryParts.push(historySummary.text);
	}
	if (turnPrefix.length > 0) {
		const conversationText = serializeConversation(turnPrefix);
		const userText = buildTurnPrefixUserText(conversationText, input.instructions, previousContextText);
		const prefixSummary = await runSummaryStream(input, userText, systemPrompt, maxTokens);
		usage = addCompactionUsage(usage, prefixSummary.usage);
		if (prefixSummary.text.length === 0) throw new Error("compaction returned an empty split-turn summary");
		summaryParts.push(`**Turn Context (split turn):**\n\n${prefixSummary.text}`);
	}

	// A generated split summary is not a reliable copy of the active request.
	// Keep it in the canonical checkpoint so live replay and resume agree.
	let userContext: PreservedUserContext | undefined =
		!input.pendingOperatorTurn && priorCheckpoint?.kind === "compactionSummary" ? priorCheckpoint.userContext : undefined;
	// Manual compaction has no live active-turn hint after a turn settles.
	// Preserve the latest operator request if the split removes it as well.
	let activeUserIndex = -1;
	let latestUserIndex = -1;
	for (let index = entries.length - 1; !input.pendingOperatorTurn && index >= 0; index--) {
		const entry = entries[index];
		if (entry?.kind !== "message" || entry.role !== "user") continue;
		if ((entry.payload as { synthetic?: unknown } | null)?.synthetic === true) continue;
		if (latestUserIndex === -1) latestUserIndex = index;
		if (input.preserveUserTurnId === undefined || entry.turnId === input.preserveUserTurnId) {
			activeUserIndex = index;
			break;
		}
	}
	// A checkpoint's verbatim request belongs to its original turn. Once a new
	// user turn exists, replay must not present the old request as still active.
	if (userContext && latestUserIndex >= 0 && entries[latestUserIndex]?.turnId !== userContext.turnId)
		userContext = undefined;
	const activeUser =
		activeUserIndex >= 0 && activeUserIndex < cut.firstKeptEntryIndex ? entries[activeUserIndex] : undefined;
	if (activeUser?.kind === "message" && activeUser.payload && typeof activeUser.payload === "object") {
		const payload = activeUser.payload;
		// Composed text can contain transient reminders. Reassert only the
		// operator's canonical words when present, without normalizing them.
		const operatorText = "operatorText" in payload ? payload.operatorText : undefined;
		const text =
			typeof operatorText === "string" && operatorText.trim().length > 0
				? operatorText
				: "text" in payload && typeof payload.text === "string"
					? payload.text
					: null;
		if (text !== null) userContext = { turnId: activeUser.turnId, text };
	}

	// The instructions also ride verbatim as an operator note, so they survive
	// a summarizer that ignores them and carry into later checkpoints (DF-7).
	const compactInstructions = input.instructions?.trim();
	const operatorNotes = extractOperatorNotes(
		[
			...priorCompactionContextEntries(entries, prevCompactionIndex),
			...entries.slice(boundaryStart, cut.firstKeptEntryIndex),
		],
		compactInstructions ? `/compact: ${compactInstructions}` : undefined,
	);
	const summary = `${summaryParts
		.join("\n\n---\n\n")
		// The model sees the prior block inside <previous-context> and may echo it;
		// the extracted notes below are the one authoritative copy.
		.replace(/\n*<operator-notes\b[^>]*>[\s\S]*?(?:<\/operator-notes\s*>|$)\n*/giu, "\n\n")
		.trim()}${formatOperatorNotes(operatorNotes)}${formatFileOperations(fileOps)}${formatRecallableRefs(
		input.entries,
		cut.firstKeptEntryIndex,
		workingSet,
	)}`.trim();

	return {
		summary,
		firstKeptEntryIndex: cut.firstKeptEntryIndex,
		firstKeptTurnId: firstKept?.turnId ?? null,
		tokensBefore,
		messagesSummarized: pre.length + turnPrefix.length + (summarizePriorSuffix ? priorSuffix.length : 0),
		isSplitTurn: cut.isSplitTurn,
		...(usage !== undefined ? { usage } : {}),
		...(skillContext !== undefined ? { skillContext } : {}),
		...(userContext !== undefined ? { userContext } : {}),
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
