import type { AgentMessage } from "../../../engine/types.js";
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

/** Per-worker reversible projection. Stable markers never rewrite its raw history. */
export function createWorkerContextGuard(archive: (ref: string, message: AgentMessage) => string) {
	const evicted = new Map<string, AgentMessage>();
	let calls = 0;
	let firstInputLength = 0;
	let lastRequestTokens = 0;
	let anchorKey = "";
	let anchorUsage = 0;
	let anchorFootprint = 0;
	return (input: WorkerPressureInput): AgentMessage[] => {
		const ceiling = Math.min(
			Math.floor(input.contextWindow * (input.threshold ?? 0.8)),
			input.contextWindow - input.outputReserve,
		);
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

		if (count() <= ceiling) return accepted();
		// The first request must honor the selected fork; never auto-trim it into a splice.
		if (calls === 0)
			throw new WorkerContextExhaustedError(
				"worker context: initial request leaves insufficient context headroom; use a smaller splice",
			);
		if (input.autoEvict === false)
			throw new WorkerContextExhaustedError("worker context: context budget exhausted with automatic eviction disabled");
		const assistantIndices = input.messages.flatMap((message, index) => (message.role === "assistant" ? [index] : []));
		const cutoff = assistantIndices[Math.max(0, assistantIndices.length - 2)] ?? 0;
		const toolCalls = new Map(input.messages.flatMap(messageToolCalls).map((call) => [call.id, call]));
		for (let index = 0; index < cutoff && count() > ceiling; index++) {
			const message = input.messages[index];
			if (!message || evicted.has(key(message))) continue;
			if (message.role === "assistant") {
				const content = message.content.filter((block) => block.type !== "thinking");
				if (content.length === 0 || content.length === message.content.length) continue;
				const projected = { ...message, content };
				replace(index, message, projected);
			} else if (message.role === "toolResult" && !message.isError) {
				const name = toolCalls.get(message.toolCallId)?.name;
				// Only observations with known read semantics. Preserve mutations and opaque tools.
				if (!name || !["read", "grep", "find", "ls", "code_nav", "web_fetch"].includes(name)) continue;
				if (JSON.stringify(message.content).length < 1000) continue;
				const ref = key(message);
				const file = archive(ref, structuredClone(message));
				const projected = {
					...message,
					content: [
						{
							type: "text" as const,
							text: `[Worker context observation worker:${ref} evicted. Recover with context(scope="recall", ref="worker:${ref}"). Exact historical result: ${file}. Read that file if needed; reread the source for current contents.]`,
						},
					],
				};
				replace(index, message, projected);
			}
		}
		if (count() > ceiling)
			throw new WorkerContextExhaustedError(
				"worker context: protected task context exceeds available headroom after reversible eviction",
			);
		return accepted();
	};
}
