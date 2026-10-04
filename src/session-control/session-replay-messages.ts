/**
 * Session-ledger replay as model messages.
 *
 * Pure ledger logic: which entries a replay works from, and the agent messages
 * they become. Nothing here renders, so the turn engine can import it without
 * reaching the terminal renderers; `chat-renderer.ts` re-exports the public
 * names and shares the entry-decoding helpers.
 */

import { compactionCut } from "../domains/context/working-set/visible.js";
import { captureSkillContext } from "../domains/session/compaction/compact.js";
import type {
	BashExecutionEntry,
	BranchSummaryEntry,
	CompactionSummaryEntry,
	MessageEntry,
	PreservedSkillContext,
	SessionEntry,
} from "../domains/session/entries.js";
import { latestSkillContextState, verifiedSkillContextCheckpoint } from "../domains/session/entries.js";
import { HANDOFF_SEED_CUSTOM_TYPE, handoffSeedContextText, isHandoffSeedData } from "../domains/session/handoff.js";
import { foldTaskBoard } from "../domains/session/task-board.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import {
	type BashExecutionMessage,
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
} from "../engine/messages.js";
import type { AgentMessage } from "../engine/types.js";
import { isSelfExplainingAbort } from "./chat-loop-messages.js";
import type { WorkerReceiptReader } from "./worker-stream.js";

const MAX_REPLAY_TEXT_CHARS = 20_000;

/**
 * Options for the rehydrate helper used by /resume and /fork.
 */
export interface RehydrateChatPanelOptions {
	/** Unprojected ledger for verifying historical skill receipts after eviction projection. */
	skillContextEntries?: ReadonlyArray<SessionEntry>;
	/**
	 * Select the active branch ancestry without truncating later sidecars.
	 * Live compaction replay uses this so a summary appended after the current
	 * message leaf remains visible. Unset offline readers retain their
	 * file-order fallback.
	 */
	activeLeafTurnId?: string;
	/**
	 * Pin the active-branch leaf and stop replay after that turn (inclusive).
	 * /tree switches and /fork pass the selected turn id so replay follows
	 * that turn's ancestry. Unset (default) treats the most recently appended
	 * message turn as the leaf.
	 */
	uptoTurnId?: string;
	/**
	 * Render orphan tool results (results with no matching prior call) in full,
	 * without the live view's middle-elision. `/export` sets this so its
	 * throwaway panel writes complete tool bodies; the paired-result path reads
	 * the same intent from the panel's `unboundedToolBodies` option.
	 */
	unboundedToolBodies?: boolean;
	/**
	 * Sealed-receipt reader for the worker blocks a `workerRun` entry names.
	 * Defaults to `<state>/receipts/<runId>.json`; tests inject their own. This
	 * is the one place replay reads outside the entry stream, and it swallows
	 * every failure, so a session whose receipts are gone still replays.
	 */
	readWorkerReceipt?: WorkerReceiptReader;
	/**
	 * Already-rendered continuity blocks, in order, from
	 * `continuityReplayBlocks`. Each is emitted verbatim exactly once and never
	 * routed through `appendContextMessage`, whose trim and replay cap would
	 * crop an accepted note; §4 forbids trimming, normalizing or regenerating
	 * accepted text. Resolving which blocks these are needs the session and fork
	 * facts a renderer does not have, so the caller supplies the finished text
	 * and this module only places it.
	 */
	continuityBlocks?: ReadonlyArray<string>;
}

/**
 * The active-path slice a replay works from, **before** the compaction cut.
 *
 * Exported because the continuity fold needs exactly this array: evidence for a
 * transaction routinely sits older than the cut, and `selectReplayEntries`
 * would both drop it and renumber every surviving position. A caller that
 * resolves a projection folds this, then renders, so the two agree on one
 * ordered input.
 */
export function activeEntriesBeforeCompactionCut(
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions = {},
	/**
	 * Whether to apply `uptoTurnId`'s positional truncation.
	 *
	 * Display replay always does. Continuity does not, unless the selection is a
	 * genuine historical cut, because `uptoTurnId` carries two different meanings
	 * through one option: a live `/tree` switch passes it to stop the transcript
	 * at the selected message, and a historical fork passes it to describe a
	 * moment that really had no later records. Truncating for the first case
	 * physically discards a pause, a delivery or an acknowledgement anchored
	 * after the selected message, and a fold cannot restore a record it was never
	 * shown: leaving a `historical` flag false does not undo a cut already made.
	 * The branch selection honors the leaf either way; only the positional cut
	 * is conditional.
	 */
	truncateAtSelection = true,
): SessionEntry[] {
	const active = filterEntriesToActivePath(turns, options.activeLeafTurnId ?? options.uptoTurnId);
	return truncateAtSelection ? truncateAtTurn(active, options.uptoTurnId) : active;
}

export function extractTurnText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const p = payload as Record<string, unknown>;
	if (typeof p.text === "string") return p.text;
	if (Array.isArray(p.content)) {
		for (const block of p.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") return b.text;
		}
	}
	return "";
}

export function stringifyPreview(value: unknown, limit = 600): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
	try {
		const text = JSON.stringify(value);
		if (!text) return "";
		return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
	} catch {
		const text = String(value);
		return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
	}
}

export function truncateReplayText(text: string, limit = MAX_REPLAY_TEXT_CHARS): string {
	if (text.length <= limit) return text;
	const omitted = text.length - limit;
	return `${text.slice(0, limit)}\n\n[... ${omitted} more characters truncated from replay context]`;
}

export function timestampMillis(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? 0 : parsed;
}

export function makeTextMessage(role: "user" | "assistant", text: string, timestamp: string): AgentMessage {
	const message: Record<string, unknown> = {
		role,
		content: [{ type: "text", text }],
		timestamp: timestampMillis(timestamp),
	};
	if (role === "assistant") message.stopReason = "stop";
	return message as unknown as AgentMessage;
}

function cloneContentBlocks(content: unknown, maxTextChars?: number): unknown[] | null {
	if (!Array.isArray(content)) return null;
	return content
		.filter((block) => !!block && typeof block === "object")
		.map((block) => {
			const cloned: Record<string, unknown> = { ...(block as Record<string, unknown>) };
			if (typeof maxTextChars === "number") {
				if (typeof cloned.text === "string") cloned.text = truncateReplayText(cloned.text, maxTextChars);
				if (typeof cloned.thinking === "string") cloned.thinking = truncateReplayText(cloned.thinking, maxTextChars);
			}
			return cloned;
		});
}

export function richMessageFromEntry(entry: MessageEntry, maxTextChars?: number): AgentMessage | null {
	if (entry.role !== "user" && entry.role !== "assistant") return null;
	const obj = payloadObject(entry.payload);
	const content = cloneContentBlocks(obj?.content, maxTextChars);
	const text = truncateReplayText(extractTurnText(entry.payload), maxTextChars);
	const stopReason = typeof obj?.stopReason === "string" ? obj.stopReason : undefined;
	if (!content && text.length === 0 && !messageFailure(entry) && stopReason !== "length") return null;
	const message: Record<string, unknown> = {
		role: entry.role,
		content: content ?? [{ type: "text", text }],
		timestamp: timestampMillis(entry.timestamp),
	};
	if (entry.role === "assistant") {
		const failure = messageFailure(entry);
		message.stopReason = failure?.stopReason ?? stopReason ?? "stop";
		if (obj?.clioCoderAbortReason === "tool_argument_generation")
			message.clioCoderAbortReason = "tool_argument_generation";
		if (failure) message.errorMessage = failure.errorMessage;
		for (const key of [
			"usage",
			"api",
			"provider",
			"model",
			"responseModelIdObservation",
			"responseModel",
			"responseId",
			"providerThinkingLevel",
			"gatewayRouting",
			"diagnostics",
			"contextUsageInvalidated",
		]) {
			if (obj?.[key] !== undefined) message[key] = obj[key];
		}
	}
	return message as unknown as AgentMessage;
}

function toolCallIdsFromMessage(message: AgentMessage): string[] {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const ids: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type !== "toolCall") continue;
		if (typeof b.id === "string" && b.id.length > 0) ids.push(b.id);
	}
	return ids;
}

function recordToolCallsFromMessage(message: AgentMessage, seen: Set<string>): void {
	for (const id of toolCallIdsFromMessage(message)) seen.add(id);
}

/**
 * Replay sink that hands tool results to the model in the order the assistant
 * issued the calls.
 *
 * The ledger appends a tool result when its tool finishes, while the live loop
 * appends a parallel batch's results by call index (pi executes the batch and
 * pushes results in the assistant's order). A two-call turn whose second call
 * finished first is therefore recorded as [b, a] and was sent as [a, b]. A
 * resume that replayed the ledger order sent different bytes from that point
 * on, and the provider's prefix cache missed for the rest of the session.
 * Results are staged until the next non-result message and released in call
 * order; an id the staged assistant turn never issued keeps its ledger order
 * after the known ones.
 */
function createOrderedReplaySink(): {
	messages: AgentMessage[];
	push(message: AgentMessage): void;
	stageToolResult(message: AgentMessage): void;
	flush(): void;
} {
	const messages: AgentMessage[] = [];
	let callOrder: string[] = [];
	let staged: AgentMessage[] = [];
	const rank = (message: AgentMessage): number => {
		const id = (message as { toolCallId?: unknown }).toolCallId;
		const index = typeof id === "string" ? callOrder.indexOf(id) : -1;
		return index < 0 ? Number.MAX_SAFE_INTEGER : index;
	};
	const flush = (): void => {
		if (staged.length === 0) return;
		staged.sort((a, b) => rank(a) - rank(b));
		messages.push(...staged);
		staged = [];
		callOrder = [];
	};
	return {
		messages,
		flush,
		push(message) {
			flush();
			messages.push(message);
			// Consecutive assistant messages (one legacy standalone tool_call entry
			// per call) share one batch; anything else starts a new one.
			if (message.role === "assistant") callOrder.push(...toolCallIdsFromMessage(message));
			else callOrder = [];
		},
		stageToolResult(message) {
			staged.push(message);
		},
	};
}

function toolCallMessageFromEntry(entry: MessageEntry): AgentMessage {
	const call = extractToolCall(entry);
	const block: Record<string, unknown> = { type: "toolCall", id: call.id, name: call.name };
	if (call.args !== undefined) block.arguments = call.args;
	return {
		role: "assistant",
		content: [block],
		stopReason: "toolUse",
		timestamp: timestampMillis(entry.timestamp),
	} as unknown as AgentMessage;
}

export function toolResultContent(result: unknown, unbounded = false): unknown[] {
	const obj = payloadObject(result);
	if (Array.isArray(obj?.content)) {
		return cloneContentBlocks(obj.content, unbounded ? undefined : MAX_REPLAY_TEXT_CHARS) ?? [];
	}
	if (isTextResult(result)) return [{ type: "text", text: unbounded ? result.text : truncateReplayText(result.text) }];
	if (typeof result === "string") return [{ type: "text", text: unbounded ? result : truncateReplayText(result) }];
	return [{ type: "text", text: stringifyPreview(result, unbounded ? Number.POSITIVE_INFINITY : 10_000) }];
}

function textFromContentBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("");
}

function toolResultText(result: unknown): string {
	const obj = payloadObject(result);
	const contentText = textFromContentBlocks(obj?.content);
	if (contentText.length > 0) return contentText;
	if (isTextResult(result)) return result.text;
	if (typeof result === "string") return result;
	return stringifyPreview(result, 10_000);
}

function comparableReplayText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function messagePayloadComparableText(payload: unknown): string {
	const text = extractTurnText(payload);
	if (text.length > 0) return text;
	return textFromContentBlocks(payloadObject(payload)?.content);
}

function isLegacyToolResultAssistantDuplicate(toolResult: MessageEntry, assistant: MessageEntry): boolean {
	const priorText = comparableReplayText(toolResultText(extractToolResult(toolResult).result));
	if (priorText.length === 0) return false;
	const assistantText = comparableReplayText(messagePayloadComparableText(assistant.payload));
	return assistantText.length > 0 && assistantText === priorText;
}

function isTextResult(value: unknown): value is { text: string } {
	return payloadObject(value)?.text !== undefined && typeof (value as { text?: unknown }).text === "string";
}

function toolResultMessageFromEntry(entry: MessageEntry, unbounded = false): AgentMessage {
	const result = extractToolResult(entry);
	return {
		role: "toolResult",
		content: toolResultContent(result.result, unbounded),
		toolCallId: result.id ?? entry.turnId,
		toolName: result.name,
		isError: result.isError,
		timestamp: timestampMillis(entry.timestamp),
	} as AgentMessage;
}

export function textBlockFromEntry(entry: MessageEntry): string {
	const text = extractTurnText(entry.payload);
	if (text.length > 0) return text;
	return stringifyPreview(entry.payload);
}

export function messageFailure(entry: MessageEntry): { stopReason: "error" | "aborted"; errorMessage: string } | null {
	const obj = payloadObject(entry.payload);
	if (!obj) return null;
	const stopReason = obj?.stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return null;
	const raw = obj.errorMessage;
	if (isSelfExplainingAbort({ stopReason, errorMessage: raw, text: extractTurnText(entry.payload) })) return null;
	const errorMessage =
		typeof raw === "string" && raw.length > 0
			? raw
			: stopReason === "aborted"
				? "request aborted"
				: "model target returned an error";
	return { stopReason, errorMessage };
}

export function payloadObject(payload: unknown): Record<string, unknown> | null {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function firstContentBlock(payload: unknown, type: string): Record<string, unknown> | null {
	const obj = payloadObject(payload);
	const content = obj?.content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === type) return b;
	}
	return null;
}

export interface ReplayToolCall {
	id: string;
	name: string;
	args: unknown;
}

export function extractToolCall(entry: MessageEntry): ReplayToolCall {
	const payload = entry.payload;
	const obj = payloadObject(payload);
	const block = firstContentBlock(payload, "toolCall");
	const fn = payloadObject(obj?.function);
	const id =
		(typeof obj?.id === "string" && obj.id) ||
		(typeof obj?.toolCallId === "string" && obj.toolCallId) ||
		(typeof obj?.tool_call_id === "string" && obj.tool_call_id) ||
		(typeof block?.id === "string" && block.id) ||
		entry.turnId;
	const name =
		(typeof obj?.name === "string" && obj.name) ||
		(typeof obj?.toolName === "string" && obj.toolName) ||
		(typeof obj?.tool === "string" && obj.tool) ||
		(typeof fn?.name === "string" && fn.name) ||
		(typeof block?.name === "string" && block.name) ||
		"tool";
	const args =
		obj?.arguments ??
		obj?.args ??
		obj?.input ??
		parseMaybeJson(fn?.arguments) ??
		block?.arguments ??
		block?.args ??
		undefined;
	return { id, name, args };
}

export interface ReplayToolResult {
	id: string | null;
	name: string;
	result: unknown;
	isError: boolean;
	durationMs?: number;
	resultSummary?: Record<string, unknown>;
	/** Persisted admission verdict; absent on history written before it was recorded. */
	outcome?: string;
	blockReason?: string;
	/** Admission's action class; an unknown dynamic tool is classified by it, live and on replay. */
	actionClass?: string;
}

export function extractToolResult(entry: MessageEntry): ReplayToolResult {
	const payload = entry.payload;
	const obj = payloadObject(payload);
	const contentText = extractTurnText(payload);
	const id =
		(typeof obj?.toolCallId === "string" && obj.toolCallId) ||
		(typeof obj?.tool_call_id === "string" && obj.tool_call_id) ||
		(typeof obj?.id === "string" && obj.id) ||
		null;
	const name =
		(typeof obj?.toolName === "string" && obj.toolName) ||
		(typeof obj?.name === "string" && obj.name) ||
		(typeof obj?.tool === "string" && obj.tool) ||
		"tool";
	const result =
		obj?.result ?? obj?.output ?? obj?.out ?? obj?.content ?? (contentText.length > 0 ? contentText : payload);
	const durationMs = typeof obj?.durationMs === "number" && Number.isFinite(obj.durationMs) ? obj.durationMs : undefined;
	const resultSummary = payloadObject(obj?.resultSummary) ?? undefined;
	const outcome = typeof obj?.outcome === "string" && obj.outcome.length > 0 ? obj.outcome : undefined;
	const blockReason = typeof obj?.blockReason === "string" && obj.blockReason.length > 0 ? obj.blockReason : undefined;
	const actionClass = typeof obj?.actionClass === "string" && obj.actionClass.length > 0 ? obj.actionClass : undefined;
	return {
		id,
		name,
		result,
		isError: obj?.isError === true || obj?.error === true,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(resultSummary !== undefined ? { resultSummary } : {}),
		...(outcome !== undefined ? { outcome } : {}),
		...(blockReason !== undefined ? { blockReason } : {}),
		...(actionClass !== undefined ? { actionClass } : {}),
	};
}

function truncateAtTurn(entries: ReadonlyArray<SessionEntry>, uptoTurnId?: string): SessionEntry[] {
	if (!uptoTurnId) return [...entries];
	const index = entries.findIndex((entry) => entry.turnId === uptoTurnId);
	if (index < 0) return [...entries];
	return entries.slice(0, index + 1);
}

function toolCallIdsInEntry(entry: SessionEntry): string[] {
	if (entry.kind !== "message") return [];
	if (entry.role === "tool_call") return [extractToolCall(entry).id];
	if (entry.role !== "assistant") return [];
	const obj = payloadObject(entry.payload);
	if (!Array.isArray(obj?.content)) return [];
	const ids: string[] = [];
	for (const block of obj.content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type !== "toolCall") continue;
		if (typeof record.id === "string" && record.id.length > 0) ids.push(record.id);
	}
	return ids;
}

function toolResultIdInEntry(entry: SessionEntry): string | null {
	if (entry.kind !== "message" || entry.role !== "tool_result") return null;
	return extractToolResult(entry).id;
}

function findPriorToolCallEntry(
	entries: ReadonlyArray<SessionEntry>,
	toolCallId: string,
	endExclusive: number,
): SessionEntry | null {
	for (let index = Math.min(endExclusive, entries.length) - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry) continue;
		if (toolCallIdsInEntry(entry).includes(toolCallId)) return entry;
	}
	return null;
}

function repairToolResultOrphans(
	allEntries: ReadonlyArray<SessionEntry>,
	selected: ReadonlyArray<SessionEntry>,
	compactionIndex: number,
): SessionEntry[] {
	const out: SessionEntry[] = [];
	const seenToolCalls = new Set<string>();
	const emittedTurnIds = new Set<string>();
	const remember = (entry: SessionEntry): void => {
		emittedTurnIds.add(entry.turnId);
		for (const id of toolCallIdsInEntry(entry)) seenToolCalls.add(id);
	};
	for (const entry of selected) {
		const resultId = toolResultIdInEntry(entry);
		if (resultId !== null && !seenToolCalls.has(resultId)) {
			const dependency = findPriorToolCallEntry(allEntries, resultId, compactionIndex);
			if (dependency !== null && !emittedTurnIds.has(dependency.turnId)) {
				out.push(dependency);
				remember(dependency);
			}
		}
		out.push(entry);
		remember(entry);
	}
	return out;
}

/**
 * Normalize a heterogeneous session JSONL stream into the entry sequence the
 * replay surfaces should show. The stream is first narrowed to the active
 * branch of the turn tree (activeLeafTurnId selects a live branch;
 * uptoTurnId selects and historically truncates; otherwise the most recent
 * append wins), so abandoned sibling turns from earlier /tree switches never
 * replay. When the remaining slice contains a compaction boundary, render the
 * latest summary first and keep only the retained suffix plus later entries,
 * mirroring pi-coding-agent's buildSessionContext behavior.
 */
export function selectReplayEntries(
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions = {},
): SessionEntry[] {
	const active = filterEntriesToActivePath(turns, options.activeLeafTurnId ?? options.uptoTurnId);
	const entries = truncateAtTurn(active, options.uptoTurnId);
	// The cut itself is the working-set layer's definition of "what the model
	// can see", shared with the eviction policy input so the two cannot drift.
	const cut = compactionCut(entries);
	if (cut.compactionIndex < 0) return dropLegacyToolResultAssistantDuplicates(entries);
	const compaction = entries[cut.compactionIndex] as CompactionSummaryEntry;
	const selected: SessionEntry[] = [compaction, ...cut.visible];
	return dropLegacyToolResultAssistantDuplicates(repairToolResultOrphans(entries, selected, cut.compactionIndex));
}

/** Retire the exact replay block when a later operator turn is admitted without a replay rebuild. */
export function retireActiveUserContextForNextOperator(
	messages: AgentMessage[],
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions = {},
): AgentMessage[] {
	const checkpoint = selectReplayEntries(turns, options).find((entry) => entry.kind === "compactionSummary");
	if (checkpoint?.kind !== "compactionSummary" || !checkpoint.userContext) return messages;
	const text = `Active user instructions (verbatim):\n${checkpoint.userContext.text}`;
	const timestamp = timestampMillis(checkpoint.timestamp);
	return messages.filter(
		(message) =>
			message.role !== "user" ||
			message.timestamp !== timestamp ||
			!Array.isArray(message.content) ||
			message.content.length !== 1 ||
			message.content[0]?.type !== "text" ||
			message.content[0].text !== text,
	);
}

function dropLegacyToolResultAssistantDuplicates(entries: ReadonlyArray<SessionEntry>): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (const entry of entries) {
		const previous = out[out.length - 1];
		if (
			entry.kind === "message" &&
			entry.role === "assistant" &&
			previous?.kind === "message" &&
			previous.role === "tool_result" &&
			isLegacyToolResultAssistantDuplicate(previous, entry)
		) {
			continue;
		}
		out.push(entry);
	}
	return out;
}

function compactionContextText(entry: CompactionSummaryEntry): string {
	return `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`;
}

function branchContextText(entry: BranchSummaryEntry): string {
	return `${BRANCH_SUMMARY_PREFIX}${entry.summary}${BRANCH_SUMMARY_SUFFIX}`;
}

/** Project Clio's ledger entry onto pi's bash message so pi owns the replay wording. */
function bashContextText(entry: BashExecutionEntry): string {
	const message: BashExecutionMessage = {
		role: "bashExecution",
		command: entry.command,
		output: truncateReplayText(entry.output),
		exitCode: entry.exitCode ?? undefined,
		cancelled: entry.cancelled,
		truncated: entry.truncated,
		...(entry.fullOutputPath !== undefined ? { fullOutputPath: entry.fullOutputPath } : {}),
		timestamp: Date.parse(entry.timestamp) || 0,
	};
	return bashExecutionToText(message);
}

function appendContextMessage(
	out: { push(message: AgentMessage): void },
	role: "user" | "assistant",
	text: string,
	timestamp: string,
): void {
	const trimmed = text.trim();
	if (trimmed.length === 0) return;
	out.push(makeTextMessage(role, truncateReplayText(trimmed), timestamp));
}

const UNVERIFIED_SKILL_CHECKPOINT_TEXT =
	"Preserved skill instructions on this checkpoint failed integrity verification and were not replayed. If a skill still applies, ask the operator to run /skill <name> again.";

/** Selected but unverifiable: name the skill and the exact ledger ref instead of dropping it. */
function unverifiedSkillContextText(skill: PreservedSkillContext): string {
	const activation = skill.activation;
	return `Preserved skill instructions for ${activation.name} (source=${activation.source} hash=${activation.hash} path=${activation.filePath}) could not be re-verified against this session's ledger and were not replayed. If the skill still applies, recall the original load with context(scope="recall", ref="${skill.resultRef}") or ask the operator to run /skill ${activation.name} again.`;
}

function skillActivationContextText(entry: Extract<SessionEntry, { kind: "skillActivation" }>): string {
	const activation = entry.activation;
	const turn = activation.turnId ? ` turn=${activation.turnId}` : "";
	return `Active skill loaded: ${activation.name} source=${activation.source} hash=${activation.hash} path=${activation.filePath} triggeredBy=${activation.triggeredBy}${turn}. Continue honoring this skill unless the user changes direction.`;
}

export function buildReplayAgentMessagesFromTurns(
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions = {},
): AgentMessage[] {
	const out = createOrderedReplaySink();
	const seenToolCalls = new Set<string>();
	const activeEntries = activeEntriesBeforeCompactionCut(turns, options);
	const skillState = latestSkillContextState(activeEntries);
	// One emission point for the continuity blocks, tracked by a flag rather than
	// by counting occurrences: the note has to appear exactly once whether the
	// replay window holds a carrying summary, an eviction-only commit, or
	// neither. `selectReplayEntries` keeps at most one compaction summary, so
	// the in-loop emission below cannot fire twice.
	let continuityEmitted = false;
	const emitContinuity = (timestamp: string): void => {
		if (continuityEmitted) return;
		continuityEmitted = true;
		// Verbatim. The accepted note is agent-authored handoff text and is
		// carried as data; it is never presented as an operator turn and never
		// passes through the trimming/truncating context helper.
		for (const block of options.continuityBlocks ?? []) out.push(makeTextMessage("user", block, timestamp));
	};
	const evidence = activeEntriesBeforeCompactionCut(options.skillContextEntries ?? turns, options);
	const verified = captureSkillContext(evidence, skillState);
	// A selected skill whose load verifies whole replays whole. Its result is
	// the instructions the session still stands on, and the live model read
	// them uncut; the replay cap would drop their tail on every rebuild after
	// eviction, compaction, resume or fork. Unverified, deselected and
	// ordinary results keep the cap.
	const wholeSkillResults = new Set(verified?.skills.map((skill) => skill.resultRef) ?? []);
	const replayEntries = selectReplayEntries(turns, options);
	const latestOperator = [...replayEntries]
		.reverse()
		.find(
			(entry) =>
				entry.kind === "message" &&
				entry.role === "user" &&
				(entry.payload as { synthetic?: unknown } | null)?.synthetic !== true,
		);
	for (const entry of replayEntries) {
		switch (entry.kind) {
			case "message": {
				const text = textBlockFromEntry(entry);
				if (entry.role === "user" || entry.role === "assistant") {
					if (entry.role === "assistant" && messageFailure(entry)) break;
					const message = richMessageFromEntry(entry, MAX_REPLAY_TEXT_CHARS);
					if (message) {
						out.push(message);
						recordToolCallsFromMessage(message, seenToolCalls);
					}
				} else if (entry.role === "tool_call") {
					const call = extractToolCall(entry);
					if (!seenToolCalls.has(call.id)) {
						const message = toolCallMessageFromEntry(entry);
						out.push(message);
						recordToolCallsFromMessage(message, seenToolCalls);
					}
				} else if (entry.role === "tool_result") {
					out.stageToolResult(toolResultMessageFromEntry(entry, wholeSkillResults.has(entry.turnId)));
				} else if (entry.role === "system") {
					appendContextMessage(out, "user", `System note: ${text}`, entry.timestamp);
				}
				break;
			}
			case "bashExecution":
				if (!entry.excludeFromContext) appendContextMessage(out, "user", bashContextText(entry), entry.timestamp);
				break;
			case "branchSummary":
				appendContextMessage(out, "user", branchContextText(entry), entry.timestamp);
				break;
			case "compactionSummary": {
				out.push(makeTextMessage("user", compactionContextText(entry), entry.timestamp));
				const checkpointIndex = activeEntries.findIndex((candidate) => candidate.turnId === entry.turnId);
				const board = checkpointIndex < 0 ? null : foldTaskBoard(activeEntries.slice(0, checkpointIndex));
				if (board) {
					const rows = board.tasks.map((task) => `${task.id} ${task.status} ${task.title}`);
					out.push(
						makeTextMessage("user", [`[Task board as of checkpoint] ${board.title}`, ...rows].join("\n"), entry.timestamp),
					);
				}
				if (entry.userContext && (!latestOperator || latestOperator.turnId === entry.userContext.turnId))
					out.push(
						makeTextMessage("user", `Active user instructions (verbatim):\n${entry.userContext.text}`, entry.timestamp),
					);
				if (entry.skillContext !== undefined) {
					const retainedSkills = entry.skillContext.skills.length;
					if (!verifiedSkillContextCheckpoint(entry.skillContext)) {
						// The raw pairs behind a tampered checkpoint are already outside the
						// replay window. Say so rather than dropping the skill without a trace.
						if (retainedSkills > 0) {
							out.push(makeTextMessage("user", UNVERIFIED_SKILL_CHECKPOINT_TEXT, entry.timestamp));
						}
						break;
					}
					for (const skill of entry.skillContext.skills) {
						// An explicit later state that no longer names this activation is a
						// deliberate off or replacement; it leaves no trace, by design.
						if (skillState && !skillState.unknown && !skillState.activationRefs.includes(skill.activationRef)) continue;
						const receipt = verified?.skills.find((candidate) => candidate.activationRef === skill.activationRef);
						if (!receipt || JSON.stringify(receipt) !== JSON.stringify(skill)) {
							// Still selected, but its original receipt cannot be re-verified
							// (masked, rewritten, or unknown state). Never inject unverified
							// bytes, and never lose the skill silently either.
							out.push(makeTextMessage("user", unverifiedSkillContextText(skill), entry.timestamp));
							continue;
						}
						// This is historical instruction context, not a generated summary or a tool result.
						// Keep the exact captured blocks outside summary replay's text cap.
						out.push(makeTextMessage("user", `Preserved skill request (verbatim):\n${skill.requestText}`, entry.timestamp));
						out.push(makeTextMessage("user", `Verified loaded skill: ${JSON.stringify(skill.activation)}`, entry.timestamp));
						for (const block of skill.content) out.push(makeTextMessage("user", block.text, entry.timestamp));
					}
				}
				// The reduction boundary is where the handoff happened, so the note
				// sits directly after the summary that replaced the history it
				// describes, whether or not this summary is the one that carried it.
				emitContinuity(entry.timestamp);
				break;
			}
			case "skillActivation":
				if (entry.activation.runId !== undefined || (skillState && !skillState.activationRefs.includes(entry.turnId)))
					break;
				appendContextMessage(out, "user", skillActivationContextText(entry), entry.timestamp);
				break;
			// The one custom entry that becomes a model message. `/handoff` seeds a
			// new session with a reviewed document, and the seed is the first thing
			// the model reads there; it is labelled by its origin session and
			// carried as data, never as a user turn the operator did not write.
			case "custom":
				if (entry.customType === HANDOFF_SEED_CUSTOM_TYPE && isHandoffSeedData(entry.data)) {
					appendContextMessage(out, "user", handoffSeedContextText(entry.data), entry.timestamp);
				}
				break;
			case "modelChange":
			case "thinkingLevelChange":
			case "fileEntry":
			case "sessionInfo":
			case "label":
			case "protectedArtifact":
			case "taskLedger":
			case "decisionLedger":
			// A worker's answer is not the operator's words and not the model's.
			// It reaches the model only when an operator shares it, and a share
			// is already a user message by the time it lands in the ledger.
			case "workerRun":
			// Working-set entries are folded into a view by the context domain
			// and applied as a projection before this builder runs; the
			// entries themselves never become messages.
			case "contextEviction":
			case "contextRecall":
			// Continuity records are bookkeeping. The chain and the commit payload
			// never become model messages; the one thing that reaches the model is
			// the accepted note, projected once through `continuityBlocks`. Handling
			// each commit here instead would emit a copy per record and would still
			// miss a commit that sits before the cut.
			case "handoffTransaction":
			case "continuityCommit":
				break;
		}
	}
	// No compaction summary in the replay window: an eviction-only or
	// continuity-only outcome still has a note to carry, so it lands at the end
	// of the replayed history rather than being dropped.
	emitContinuity(activeEntries[activeEntries.length - 1]?.timestamp ?? new Date(0).toISOString());
	out.flush();
	return out.messages;
}
