/**
 * Projection from chat-loop events to the headless `--json` wire stream.
 *
 * The stream is append-oriented: it carries each piece of content exactly
 * once, as an increment while it streams and as one completed message when it
 * lands. It never repeats the growing snapshot of an in-progress message,
 * because that is quadratic in a long turn. One tool-heavy headless turn wrote
 * 802 MB of stdout, 99.3% of it `message_update` snapshots of a message
 * whose final form is 44 KB.
 *
 * The rules, in one place:
 *   - `message_update` is dropped. Its increments are already published as
 *     `text_delta` / `thinking_delta`, and its `message` is the partial form of
 *     the `message_end` that follows.
 *   - `text_delta` / `thinking_delta` carry the increment, not the growing
 *     partial text.
 *   - `message_end` keeps the message's accounting (role, model, usage, stop
 *     reason, tool calls) and replaces the assistant `text` and `thinking`
 *     blocks the deltas already carried with a marker naming their length.
 *     Without this the stream carried every assistant token twice: measured on
 *     one run, 41,094 bytes of deltas alongside 24,600 bytes of `message_end`
 *     re-stating the same thinking and text. `user` and `toolResult` messages
 *     pass through whole, because nothing else on the stream carries them.
 *   - `agent_end` carries its segment's usage and message count, not a second
 *     copy of every message already streamed.
 *   - `turn_end` keeps its assistant message (stop reason and usage live
 *     there) and drops `toolResults`, each of which already crossed the wire
 *     as a `tool_execution_end`.
 *   - `tool_execution_*` frames name the capability that ran. A gateway
 *     op=call carries the capability as `toolName`, its own arguments as
 *     `args`, and `via: "gateway"`, so a consumer written against v056 direct
 *     calls keeps reading `bash` and `command`. A chain keeps its `gateway`
 *     frames and is followed by a start/end pair per settled step, each with
 *     `toolCallId` `<parent>:<step id>` and `parentToolCallId`.
 *   - Every other event passes through unchanged.
 */

import type { AgentMessage } from "../../engine/types.js";
import type { ChatLoopEvent } from "../../interactive/chat-loop.js";
import { sumRunUsage } from "../../interactive/chat-loop-messages.js";
import {
	chainStepToolCallId,
	displayToolCall,
	type GatewayChainStep,
	gatewayChainSteps,
	VIA_GATEWAY,
} from "../../tools/gateway-display.js";

export function projectHeadlessJsonEvent(event: ChatLoopEvent): unknown | null {
	if (event.type === "message_update") return null;
	if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
		const call = displayToolCall(event.toolName, event.args);
		return call.viaGateway ? { ...event, toolName: call.toolName, args: call.args ?? {}, via: VIA_GATEWAY } : event;
	}
	if (event.type === "tool_execution_end") {
		const details = isRecord(event.result) ? event.result.details : undefined;
		const call = displayToolCall(event.toolName, undefined, details);
		return call.viaGateway ? { ...event, toolName: call.toolName, via: VIA_GATEWAY } : event;
	}
	if (event.type === "text_delta") {
		return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
	}
	if (event.type === "thinking_delta") {
		return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
	}
	if (event.type === "message_end") {
		return { ...event, message: withoutStreamedContent(event.message) };
	}
	if (event.type === "agent_end") return segmentSummary(event.type, event.messages);
	if (event.type === "turn_end") {
		return { type: event.type, message: withoutStreamedContent(event.message) };
	}
	return event;
}

export interface HeadlessJsonProjector {
	/** The wire frames one chat-loop event becomes, in order; empty when the event is dropped. */
	project(event: ChatLoopEvent): unknown[];
}

/**
 * The stateful half of the headless projection. A gateway call's end frame
 * carries no arguments, and a refused capability's result carries no
 * `details.capability`, so the end frame takes the capability its start frame
 * named. A chain's end frame is followed by each settled step as its own
 * start/end pair; the provider and the session keep the single aggregate.
 */
export function createHeadlessJsonProjector(): HeadlessJsonProjector {
	const capabilities = new Map<string, string>();
	return {
		project(event) {
			let projected = projectHeadlessJsonEvent(event);
			if (projected === null) return [];
			if (event.type === "tool_execution_start" && isRecord(projected) && projected.via === VIA_GATEWAY) {
				capabilities.set(event.toolCallId, String(projected.toolName));
			}
			if (event.type !== "tool_execution_end") return [projected];
			const started = capabilities.get(event.toolCallId);
			capabilities.delete(event.toolCallId);
			if (started !== undefined && isRecord(projected) && projected.via !== VIA_GATEWAY) {
				projected = { ...projected, toolName: started, via: VIA_GATEWAY };
			}
			const steps = gatewayChainSteps(event.toolName, event.result);
			return [projected, ...steps.flatMap((step) => chainStepFrames(event.toolCallId, step))];
		},
	};
}

/** One settled chain step as the start/end pair a direct call of its capability would have produced. */
function chainStepFrames(parentToolCallId: string, step: GatewayChainStep): unknown[] {
	const identity = {
		toolCallId: chainStepToolCallId(parentToolCallId, step.id),
		parentToolCallId,
		toolName: step.capability,
	};
	return [
		{ type: "tool_execution_start", ...identity, args: step.args, via: VIA_GATEWAY },
		{
			type: "tool_execution_end",
			...identity,
			result: step.result,
			isError: step.isError,
			via: VIA_GATEWAY,
			...(step.outcome !== undefined ? { outcome: step.outcome } : {}),
			...(step.actionClass !== undefined ? { actionClass: step.actionClass } : {}),
			...(step.decision !== undefined ? { decision: step.decision } : {}),
			...(step.blockReason !== undefined ? { blockReason: step.blockReason } : {}),
			...(step.bindingError !== undefined ? { bindingError: step.bindingError } : {}),
		},
	];
}

/**
 * Replace the content blocks a reader has already received as deltas.
 *
 * Only an assistant message streams: its `text` and `thinking` blocks arrive
 * incrementally as `text_delta` and `thinking_delta` keyed by the same
 * `contentIndex` this array is indexed by, so a reader reassembles them itself.
 * Provider replay signatures stay in the durable session, not this observation
 * stream; encrypted signatures can dwarf the actual answer on every turn.
 * `toolCall` blocks never stream and are kept whole. A `user` or `toolResult`
 * message is returned untouched, because no delta ever carried it.
 */
function withoutStreamedContent<T>(message: T): T {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
	const content = message.content.map((block: unknown) => {
		if (!isRecord(block)) return block;
		if (block.type === "text" && typeof block.text === "string") {
			const { text: _text, textSignature: _signature, ...rest } = block;
			return { ...rest, streamed: true, textLength: block.text.length };
		}
		if (block.type === "thinking" && typeof block.thinking === "string") {
			const { thinking: _thinking, thinkingSignature: _signature, ...rest } = block;
			return { ...rest, streamed: true, thinkingLength: block.thinking.length };
		}
		return block;
	});
	return { ...message, content } as T;
}

/**
 * Projection for the dispatch `--json` stream, whose events come off a worker
 * rather than out of the chat loop.
 *
 * The two streams name streaming increments differently by design: a worker
 * publishes them as `message_update` deltas already slimmed of their
 * cumulative snapshots at the worker stdout seam, and the chat loop publishes
 * them as `text_delta`. They make the same promise about content crossing
 * once, and `agent_end` was breaking it here: it carried the segment's entire
 * transcript, every message of which had already crossed as its own
 * `message_end`. It now carries the same segment summary the main-agent stream
 * carries, which is also what lets a reader check the per-segment and
 * per-message accounts of one run against each other.
 */
export function projectDispatchJsonEvent(event: unknown): unknown {
	if (!isRecord(event) || event.type !== "agent_end" || !Array.isArray(event.messages)) return event;
	const { messages: _messages, ...rest } = event;
	return { ...rest, ...segmentSummary("agent_end", event.messages as AgentMessage[]) };
}

function segmentSummary(type: string, messages: ReadonlyArray<AgentMessage>): Record<string, unknown> {
	const usage = sumRunUsage(messages);
	return {
		type,
		messageCount: messages.length,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			reasoning: usage.reasoning,
			totalTokens: usage.tokens,
			costUsd: usage.costUsd,
			apiCalls: usage.apiCalls,
			measured: usage.hadUsage,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
