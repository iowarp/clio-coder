/**
 * Coalescing wrapper around chat events (slice 12.5d).
 *
 * Streaming responses fire `text_delta` / `thinking_delta` events at very
 * high frequency. The TUI's per-event `requestRender()` call rebuilt the
 * entire transcript on every delta, which scaled linearly with response
 * length and made long answers visibly lag. This wrapper applies every
 * event to the panel synchronously (so internal state stays consistent)
 * but defers `requestRender()` for delta events to a single coalesced
 * timer (~16ms = one frame at 60fps). Non-delta events render
 * synchronously so finalizers like `message_end` are never deferred.
 */

import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import type {
	BashExecutionEntry,
	BranchSummaryEntry,
	CompactionSummaryEntry,
	CustomEntry,
	FileEntryEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionInfoEntry,
	ThinkingLevelChangeEntry,
} from "../domains/session/entries.js";
import { wrapTextWithAnsi } from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatLoopEvent, RetryStatusPayload } from "./chat-loop.js";
import type { ChatPanel } from "./chat-panel.js";
import { renderBranchSummaryEntry } from "./renderers/branch-summary.js";
import { renderCompactionSummaryEntry } from "./renderers/compaction-summary.js";
import { formatRetryStatus } from "./renderers/retry-status.js";

const DEFAULT_COALESCE_MS = 16;

/**
 * Event kinds whose render is deferred into a coalesce window. All other
 * `ChatLoopEvent` kinds render synchronously and cancel any pending timer.
 */
const DELTA_TYPES: ReadonlySet<ChatLoopEvent["type"]> = new Set(["text_delta", "thinking_delta"]);

export interface CreateCoalescingChatRendererDeps {
	chatPanel: ChatPanel;
	requestRender: () => void;
	/** Coalesce window in ms. Defaults to 16 (one frame at 60fps). */
	coalesceMs?: number;
	/** Override for tests. Mirrors the setTimeout signature. */
	setTimer?: (cb: () => void, ms: number) => unknown;
	/** Override for tests. Mirrors the clearTimeout signature. */
	clearTimer?: (id: unknown) => void;
}

export interface CoalescingChatRenderer {
	applyEvent(event: ChatLoopEvent): void;
	/** Cancel the pending coalesce timer (if any) and request one synchronous render. */
	flush(): void;
}

export function createCoalescingChatRenderer(deps: CreateCoalescingChatRendererDeps): CoalescingChatRenderer {
	const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer =
		deps.clearTimer ??
		((id) => {
			clearTimeout(id as ReturnType<typeof setTimeout>);
		});
	const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;

	let pendingTimer: unknown = null;

	const fireCoalesced = (): void => {
		pendingTimer = null;
		deps.requestRender();
	};

	const cancelPending = (): boolean => {
		if (pendingTimer === null) return false;
		clearTimer(pendingTimer);
		pendingTimer = null;
		return true;
	};

	return {
		applyEvent(event) {
			deps.chatPanel.applyEvent(event);
			if (DELTA_TYPES.has(event.type)) {
				if (pendingTimer !== null) return;
				pendingTimer = setTimer(fireCoalesced, coalesceMs);
				return;
			}
			cancelPending();
			deps.requestRender();
		},
		flush() {
			const wasPending = cancelPending();
			if (!wasPending) return;
			deps.requestRender();
		},
	};
}

/**
 * Options for the rehydrate helper used by /resume and /fork.
 */
export interface RehydrateChatPanelOptions {
	/**
	 * Stop replay after the matching turn id (inclusive). /fork passes the
	 * selected parent turn id so the new branch's chat panel shows only the
	 * pre-fork transcript. Unset (default) replays the entire list.
	 */
	uptoTurnId?: string;
}

function extractTurnText(payload: unknown): string {
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

function stringifyPreview(value: unknown, limit = 600): string {
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

function timestampMillis(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function makeTextMessage(role: "user" | "assistant", text: string, timestamp: string): AgentMessage {
	const message: Record<string, unknown> = {
		role,
		content: [{ type: "text", text }],
		timestamp: timestampMillis(timestamp),
	};
	if (role === "assistant") message.stopReason = "stop";
	return message as unknown as AgentMessage;
}

function textBlockFromEntry(entry: MessageEntry): string {
	const text = extractTurnText(entry.payload);
	if (text.length > 0) return text;
	return stringifyPreview(entry.payload);
}

function chatMessageText(entry: MessageEntry): string {
	return extractTurnText(entry.payload);
}

function messageFailure(entry: MessageEntry): { stopReason: "error" | "aborted"; errorMessage: string } | null {
	const obj = payloadObject(entry.payload);
	if (!obj) return null;
	const stopReason = obj?.stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return null;
	const raw = obj.errorMessage;
	const errorMessage =
		typeof raw === "string" && raw.length > 0
			? raw
			: stopReason === "aborted"
				? "request aborted"
				: "provider returned an error";
	return { stopReason, errorMessage };
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
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

interface ReplayToolCall {
	id: string;
	name: string;
	args: unknown;
}

function extractToolCall(entry: MessageEntry): ReplayToolCall {
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

interface ReplayToolResult {
	id: string | null;
	name: string;
	result: unknown;
	isError: boolean;
}

function extractToolResult(entry: MessageEntry): ReplayToolResult {
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
	return { id, name, result, isError: obj?.isError === true || obj?.error === true };
}

function renderReplayLine(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, width);
}

function appendReplayLine(chatPanel: ChatPanel, text: string): void {
	chatPanel.appendReplayBlock((width) => renderReplayLine(text, width));
}

const BASH_REPLAY_MAX_LINES = 12;

function renderBashExecutionEntry(entry: BashExecutionEntry, width: number): string[] {
	const lines: string[] = [];
	lines.push(...wrapTextWithAnsi(`bash: $ ${entry.command}`, width));
	const output = entry.output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/g, "");
	if (output.length > 0) {
		const outputLines = output.split("\n");
		const hidden = Math.max(0, outputLines.length - BASH_REPLAY_MAX_LINES);
		const visible = outputLines.slice(-BASH_REPLAY_MAX_LINES);
		if (hidden > 0) lines.push(...wrapTextWithAnsi(`  ... ${hidden} earlier lines`, width));
		for (const line of visible) {
			lines.push(...wrapTextWithAnsi(`  ${line}`, width));
		}
	} else {
		lines.push(...wrapTextWithAnsi("  (no output)", width));
	}
	const status: string[] = [];
	if (entry.cancelled) status.push("cancelled");
	if (entry.exitCode !== null && entry.exitCode !== 0) status.push(`exit ${entry.exitCode}`);
	if (entry.truncated) status.push(entry.fullOutputPath ? `truncated: ${entry.fullOutputPath}` : "truncated");
	if (entry.excludeFromContext) status.push("excluded from context");
	if (status.length > 0) lines.push(...wrapTextWithAnsi(`  (${status.join(", ")})`, width));
	return lines;
}

function renderRetryStatusEntry(entry: CustomEntry, width: number): string[] {
	const data = payloadObject(entry.data);
	if (!data) return wrapTextWithAnsi("[retry] status", width);
	const rawPhase = data.phase;
	if (
		rawPhase !== "scheduled" &&
		rawPhase !== "waiting" &&
		rawPhase !== "retrying" &&
		rawPhase !== "cancelled" &&
		rawPhase !== "exhausted" &&
		rawPhase !== "recovered"
	) {
		return wrapTextWithAnsi("[retry] status", width);
	}
	const attempt = typeof data.attempt === "number" ? data.attempt : null;
	const maxAttempts = typeof data.maxAttempts === "number" ? data.maxAttempts : null;
	if (attempt === null || maxAttempts === null) return wrapTextWithAnsi("[retry] status", width);
	const status: RetryStatusPayload = {
		phase: rawPhase,
		attempt,
		maxAttempts,
		...(typeof data.errorMessage === "string" && data.errorMessage.length > 0 ? { errorMessage: data.errorMessage } : {}),
		...(typeof data.delayMs === "number" ? { delayMs: data.delayMs } : {}),
		...(typeof data.seconds === "number" ? { seconds: data.seconds } : {}),
	};
	return wrapTextWithAnsi(formatRetryStatus(status), width);
}

function renderCustomEntry(entry: CustomEntry, width: number): string[] {
	if (entry.customType === "retryStatus") return renderRetryStatusEntry(entry, width);
	const body = stringifyPreview(entry.data);
	const suffix = body.length > 0 ? ` ${body}` : "";
	return wrapTextWithAnsi(`custom:${entry.customType}${suffix}`, width);
}

function renderModelChangeEntry(entry: ModelChangeEntry, width: number): string[] {
	const endpoint = entry.endpoint ? `${entry.endpoint}/` : "";
	return wrapTextWithAnsi(`[model] ${endpoint}${entry.provider}/${entry.modelId}`, width);
}

function renderThinkingChangeEntry(entry: ThinkingLevelChangeEntry, width: number): string[] {
	return wrapTextWithAnsi(`[thinking] ${entry.thinkingLevel}`, width);
}

function renderFileEntry(entry: FileEntryEntry, width: number): string[] {
	const bytes = typeof entry.bytes === "number" ? `, ${entry.bytes} bytes` : "";
	return wrapTextWithAnsi(`[file ${entry.operation}] ${entry.path}${bytes}`, width);
}

function renderSessionInfoEntry(entry: SessionInfoEntry, width: number): string[] {
	if (entry.name) return wrapTextWithAnsi(`[session] ${entry.name}`, width);
	if (entry.label && entry.targetTurnId) return wrapTextWithAnsi(`[label] ${entry.targetTurnId}: ${entry.label}`, width);
	return [];
}

function truncateAtTurn(entries: ReadonlyArray<SessionEntry>, uptoTurnId?: string): SessionEntry[] {
	if (!uptoTurnId) return [...entries];
	const index = entries.findIndex((entry) => entry.turnId === uptoTurnId);
	if (index < 0) return [...entries];
	return entries.slice(0, index + 1);
}

function latestCompactionIndex(entries: ReadonlyArray<SessionEntry>): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.kind === "compactionSummary") return i;
	}
	return -1;
}

/**
 * Normalize a heterogeneous session JSONL stream into the entry sequence the
 * replay surfaces should show. When the slice contains a compaction boundary,
 * render the latest summary first and keep only the retained suffix plus
 * later entries, mirroring pi-coding-agent's buildSessionContext behavior.
 */
export function selectReplayEntries(
	turns: ReadonlyArray<unknown>,
	options: RehydrateChatPanelOptions = {},
): SessionEntry[] {
	const entries = truncateAtTurn(collectSessionEntries(turns), options.uptoTurnId);
	const compactionIndex = latestCompactionIndex(entries);
	if (compactionIndex < 0) return entries;

	const compaction = entries[compactionIndex] as CompactionSummaryEntry;
	const selected: SessionEntry[] = [compaction];
	const firstKeptIndex = compaction.firstKeptTurnId
		? entries.findIndex((entry) => entry.turnId === compaction.firstKeptTurnId)
		: -1;
	if (firstKeptIndex >= 0 && firstKeptIndex < compactionIndex) {
		selected.push(...entries.slice(firstKeptIndex, compactionIndex));
	}
	selected.push(...entries.slice(compactionIndex + 1));
	return selected;
}

function compactionContextText(entry: CompactionSummaryEntry): string {
	return [
		"The conversation history before this point was compacted into the following summary:",
		"",
		"<summary>",
		entry.summary,
		"</summary>",
	].join("\n");
}

function branchContextText(entry: BranchSummaryEntry): string {
	return [
		"The following is a summary of a branch that this conversation came back from:",
		"",
		"<summary>",
		entry.summary,
		"</summary>",
	].join("\n");
}

function bashContextText(entry: BashExecutionEntry): string {
	let text = `Ran \`${entry.command}\`\n`;
	text += entry.output.length > 0 ? `\`\`\`\n${entry.output}\n\`\`\`` : "(no output)";
	if (entry.cancelled) text += "\n\n(command cancelled)";
	else if (entry.exitCode !== null && entry.exitCode !== 0) text += `\n\nCommand exited with code ${entry.exitCode}`;
	if (entry.truncated && entry.fullOutputPath) text += `\n\n[Output truncated. Full output: ${entry.fullOutputPath}]`;
	return text;
}

function appendContextMessage(out: AgentMessage[], role: "user" | "assistant", text: string, timestamp: string): void {
	const trimmed = text.trim();
	if (trimmed.length === 0) return;
	out.push(makeTextMessage(role, trimmed, timestamp));
}

export function buildReplayAgentMessagesFromTurns(
	turns: ReadonlyArray<unknown>,
	options: RehydrateChatPanelOptions = {},
): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const entry of selectReplayEntries(turns, options)) {
		switch (entry.kind) {
			case "message": {
				const text = textBlockFromEntry(entry);
				if (entry.role === "user" || entry.role === "assistant") {
					if (entry.role === "assistant" && messageFailure(entry)) break;
					appendContextMessage(out, entry.role, chatMessageText(entry), entry.timestamp);
				} else if (entry.role === "tool_call") {
					const call = extractToolCall(entry);
					appendContextMessage(out, "assistant", `Tool call: ${call.name}(${stringifyPreview(call.args)})`, entry.timestamp);
				} else if (entry.role === "tool_result") {
					const result = extractToolResult(entry);
					appendContextMessage(out, "user", `Tool result: ${stringifyPreview(result.result)}`, entry.timestamp);
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
			case "compactionSummary":
				appendContextMessage(out, "user", compactionContextText(entry), entry.timestamp);
				break;
			case "custom":
			case "modelChange":
			case "thinkingLevelChange":
			case "fileEntry":
			case "sessionInfo":
				break;
		}
	}
	return out;
}

/**
 * Rehydrate a chat panel from a persisted session's turn list. The
 * interactive layer calls this after /resume or /fork so the user sees the
 * prior transcript instead of a blank pane; without it, swapping the
 * session contract updated meta but left the visible chat untouched
 * (Row 51 and Row 52 on the Phase 12 ledger).
 *
 * Replays a normalized SessionEntry stream. Legacy ClioTurnRecord lines are
 * normalized into message entries; v2 entries such as compaction summaries,
 * branch summaries, bash executions, custom entries, and metadata entries
 * are rendered explicitly. Tool call/result entries are best-effort: when a
 * result can be paired to a prior call id it updates that tool segment,
 * otherwise it falls back to a standalone transcript line.
 *
 * Pure except for the chat-panel calls: no I/O, no chat-loop events
 * wired. Callers read turns via `openSession(id).turns()` and pass them
 * in explicitly.
 */
export function rehydrateChatPanelFromTurns(
	chatPanel: ChatPanel,
	turns: ReadonlyArray<unknown>,
	options: RehydrateChatPanelOptions = {},
): void {
	const pendingToolIds: string[] = [];
	for (const entry of selectReplayEntries(turns, options)) {
		switch (entry.kind) {
			case "message": {
				if (entry.role === "user") {
					const text = chatMessageText(entry);
					if (text.length > 0) chatPanel.appendUser(text);
					break;
				}
				if (entry.role === "assistant") {
					const text = chatMessageText(entry);
					const failure = messageFailure(entry);
					if (text.length > 0 || failure) {
						const message = makeTextMessage("assistant", text, entry.timestamp);
						if (failure) {
							(message as { stopReason?: string; errorMessage?: string }).stopReason = failure.stopReason;
							(message as { stopReason?: string; errorMessage?: string }).errorMessage = failure.errorMessage;
						}
						chatPanel.applyEvent({ type: "message_end", message });
						chatPanel.applyEvent({ type: "agent_end", messages: [message] });
					}
					break;
				}
				if (entry.role === "tool_call") {
					const call = extractToolCall(entry);
					pendingToolIds.push(call.id);
					chatPanel.applyEvent({
						type: "tool_execution_start",
						toolCallId: call.id,
						toolName: call.name,
						args: call.args,
					});
					break;
				}
				if (entry.role === "tool_result") {
					const result = extractToolResult(entry);
					const fallbackId = result.id ?? pendingToolIds.pop() ?? null;
					if (fallbackId) {
						const pendingIndex = pendingToolIds.indexOf(fallbackId);
						if (pendingIndex >= 0) pendingToolIds.splice(pendingIndex, 1);
						chatPanel.applyEvent({
							type: "tool_execution_end",
							toolCallId: fallbackId,
							toolName: result.name,
							result: result.result,
							isError: result.isError,
						});
					} else {
						appendReplayLine(chatPanel, `tool result: ${stringifyPreview(result.result)}`);
					}
					break;
				}
				if (entry.role === "system") {
					const text = textBlockFromEntry(entry);
					if (text.length > 0) appendReplayLine(chatPanel, `system: ${text}`);
					break;
				}
				if (entry.role === "checkpoint") {
					const text = textBlockFromEntry(entry);
					appendReplayLine(chatPanel, text.length > 0 ? `[checkpoint] ${text}` : "[checkpoint]");
					break;
				}
				break;
			}
			case "bashExecution":
				chatPanel.appendReplayBlock((width) => renderBashExecutionEntry(entry, width));
				break;
			case "custom":
				if (entry.display !== false) chatPanel.appendReplayBlock((width) => renderCustomEntry(entry, width));
				break;
			case "modelChange":
				chatPanel.appendReplayBlock((width) => renderModelChangeEntry(entry, width));
				break;
			case "thinkingLevelChange":
				chatPanel.appendReplayBlock((width) => renderThinkingChangeEntry(entry, width));
				break;
			case "fileEntry":
				chatPanel.appendReplayBlock((width) => renderFileEntry(entry, width));
				break;
			case "branchSummary":
				if (entry.summary.trim().length > 0) {
					chatPanel.appendReplayBlock((width) => renderBranchSummaryEntry(entry, width));
				}
				break;
			case "compactionSummary":
				if (entry.summary.trim().length > 0) {
					chatPanel.appendReplayBlock((width) => renderCompactionSummaryEntry(entry, width));
				}
				break;
			case "sessionInfo":
				if (entry.name || entry.label) chatPanel.appendReplayBlock((width) => renderSessionInfoEntry(entry, width));
				break;
		}
	}
	for (const pendingId of pendingToolIds) {
		chatPanel.applyEvent({
			type: "tool_execution_end",
			toolCallId: pendingId,
			toolName: "tool",
			result: "missing result; session ended before the tool completed",
			isError: true,
		});
	}
}
