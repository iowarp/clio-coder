import type { AgentMessage } from "../../../engine/types.js";
import { effectiveToolCall } from "../../../tools/surface.js";
import { estimateAgentContextBreakdown, estimateAgentMessageTokens } from "../../session/context-accounting.js";
import { contextHash, messageToolCalls } from "./snapshot.js";

interface WorkerPressureInput {
	messages: ReadonlyArray<AgentMessage>;
	systemPrompt: string;
	tools: ReadonlyArray<unknown>;
	contextWindow: number;
	outputReserve: number;
	threshold?: number;
	autoEvict?: boolean;
}

export class WorkerContextExhaustedError extends Error {}

/**
 * A server overflow reports only that the request was too large, never by how
 * much. The one retry must shrink the failed request to this share of its own
 * estimate. The target is relative to the request, so it needs no window and
 * serves an unreported window and a known one alike.
 */
const OVERFLOW_RECOVERY_KEEP = 0.7;

export interface WorkerContextGuard {
	(input: WorkerPressureInput): AgentMessage[];
	/**
	 * Project a smaller request after the server rejected the last one as too
	 * large, whether Clio's own estimate saw the overflow coming or not. Evicts
	 * the same reversible observations the ceiling path does, oldest first, and
	 * returns null unless that brings the request to the recovery target, so the
	 * caller fails with the server's own error instead of spending the only retry
	 * on a request that is still far too large. The first request is the caller's
	 * chosen fork and is never trimmed.
	 */
	recover(input: WorkerPressureInput): AgentMessage[] | null;
}

/** Per-worker reversible projection. Stable markers never rewrite its raw history. */
export function createWorkerContextGuard(archive: (ref: string, message: AgentMessage) => string): WorkerContextGuard {
	const evicted = new Map<string, AgentMessage>();
	let calls = 0;
	let firstInputLength = 0;
	let lastRequestTokens = 0;
	let anchorKey = "";
	let anchorUsage = 0;
	let anchorFootprint = 0;
	const project = (input: WorkerPressureInput, recovering: boolean): AgentMessage[] | null => {
		// An unreported serving window resolves to 0. It admits the request: the
		// server enforces its own limit, and a real overflow fails the run with
		// the server's error instead of a fabricated "insufficient headroom".
		const windowKnown = Number.isFinite(input.contextWindow) && input.contextWindow > 0;
		const ceiling = windowKnown
			? Math.min(Math.floor(input.contextWindow * (input.threshold ?? 0.8)), input.contextWindow - input.outputReserve)
			: Number.POSITIVE_INFINITY;
		const key = (message: AgentMessage) => contextHash(message);
		const messages = input.messages.map((message) => evicted.get(key(message)) ?? message);

		const breakdown = estimateAgentContextBreakdown({ systemPrompt: input.systemPrompt, tools: input.tools, messages });
		let structural = Object.values(breakdown).reduce((sum, value) => sum + value, 0);

		// Parent usage never anchors a child. Only a response to this worker's own request can do so.
		if (calls === 0) firstInputLength = input.messages.length;
		else {
			for (let index = messages.length - 1; index >= firstInputLength; index--) {
				const message = messages[index];
				if (
					message?.role !== "assistant" ||
					!message.usage ||
					message.stopReason === "error" ||
					message.stopReason === "aborted"
				)
					continue;
				const usage = message.usage;
				const actual = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				const nextKey = key(message);
				if (nextKey !== anchorKey) {
					anchorKey = nextKey;
					anchorUsage = Number.isFinite(actual) && actual > 0 ? actual : 0;
					// Usage describes the previous projected request plus this answer.
					// Keep that footprint stable across repeated projection of the same answer.
					anchorFootprint = lastRequestTokens + estimateAgentMessageTokens(message);
				}
				break;
			}
		}
		const count = () => Math.max(structural, anchorUsage > 0 ? anchorUsage + structural - anchorFootprint : 0);
		const accepted = () => {
			calls++;
			lastRequestTokens = structural;
			return messages;
		};
		const replace = (index: number, original: AgentMessage, projected: AgentMessage) => {
			const saved = estimateAgentMessageTokens(original) - estimateAgentMessageTokens(projected);
			if (saved <= 0) return;
			evicted.set(key(original), projected);
			messages[index] = projected;
			structural -= saved;
		};

		if (recovering) {
			// The first request is the caller's chosen fork, never auto-trimmed.
			if (calls <= 1 || input.autoEvict === false) return null;
		} else {
			if (count() <= ceiling) return accepted();
			// The first request must honor the selected fork; never auto-trim it into a splice.
			if (calls === 0)
				throw new WorkerContextExhaustedError(
					"worker context: initial request leaves insufficient context headroom; use a smaller splice",
				);
			if (input.autoEvict === false)
				throw new WorkerContextExhaustedError("worker context: context budget exhausted with automatic eviction disabled");
		}
		const recoveryTarget = Math.floor(lastRequestTokens * OVERFLOW_RECOVERY_KEEP);
		const over = () => (recovering ? structural > recoveryTarget : count() > ceiling);
		const assistantIndices = input.messages.flatMap((message, index) => (message.role === "assistant" ? [index] : []));
		const cutoff = assistantIndices[Math.max(0, assistantIndices.length - 2)] ?? 0;
		const toolCalls = new Map(input.messages.flatMap(messageToolCalls).map((call) => [call.id, call]));
		const evictableObservation = (message: AgentMessage | undefined): message is AgentMessage & { role: "toolResult" } => {
			if (!message || message.role !== "toolResult" || message.isError || evicted.has(key(message))) return false;
			const call = toolCalls.get(message.toolCallId);
			// A gateway call carries its capability's read semantics: a page
			// fetched through the gateway is as evictable as a direct fetch.
			const name = call ? effectiveToolCall(call.name, call.arguments).toolName : undefined;
			// Only observations with known read semantics. Preserve mutations and opaque tools.
			if (!name || !["read", "grep", "find", "ls", "code_nav", "web_read", "web_fetch"].includes(name)) return false;
			return JSON.stringify(message.content).length >= 1000;
		};
		const evictObservation = (index: number, message: AgentMessage, note: string) => {
			const ref = key(message);
			const file = archive(ref, structuredClone(message));
			replace(index, message, {
				...message,
				content: [{ type: "text" as const, text: note.replaceAll("{ref}", ref).replaceAll("{file}", file) }],
			} as AgentMessage);
		};
		for (let index = 0; index < cutoff && over(); index++) {
			const message = input.messages[index];
			if (!message || evicted.has(key(message))) continue;
			if (message.role === "assistant") {
				const content = message.content.filter((block) => block.type !== "thinking");
				if (content.length === 0 || content.length === message.content.length) continue;
				const projected = { ...message, content };
				replace(index, message, projected);
			} else if (evictableObservation(message)) {
				evictObservation(
					index,
					message,
					'[Worker context observation worker:{ref} evicted. Recover with context(scope="recall", ref="worker:{ref}"). Exact historical result: {file}. Read that file if needed; reread the source for current contents.]',
				);
			}
		}
		// One step's own results can outgrow the window: a 64K-token worker that
		// reads eight large files in parallel protects all of them as its latest
		// round, and the run used to die as context exhausted. Before failing,
		// evict the protected read results too, largest first, and say why so
		// the next step reads narrower instead of recalling the same bytes.
		if (over()) {
			const recent = input.messages
				.map((message, index) => ({ message, index }))
				.filter(({ message, index }) => index >= cutoff && evictableObservation(message))
				.sort((a, b) => estimateAgentMessageTokens(b.message) - estimateAgentMessageTokens(a.message));
			for (const { message, index } of recent) {
				if (!over()) break;
				evictObservation(
					index,
					message,
					"[Worker context observation worker:{ref} evicted: this step's results did not fit the model's context window. Read only the part you need, with offset and limit, one large source per step. Exact historical result: {file}.]",
				);
			}
		}
		if (recovering) return structural <= recoveryTarget ? accepted() : null;
		if (count() > ceiling)
			throw new WorkerContextExhaustedError(
				"worker context: protected task context exceeds available headroom after reversible eviction",
			);
		return accepted();
	};
	return Object.assign((input: WorkerPressureInput): AgentMessage[] => project(input, false) as AgentMessage[], {
		recover: (input: WorkerPressureInput): AgentMessage[] | null => project(input, true),
	});
}
