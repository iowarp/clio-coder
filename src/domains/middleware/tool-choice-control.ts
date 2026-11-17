import { gatewayCallCapability } from "../../core/gateway-envelope.js";
import { ToolNames } from "../../core/tool-names.js";
import type { AgentMessage, ToolRoundRecord } from "../../engine/types.js";
import type { MiddlewareEffect } from "./types.js";

/**
 * A capability behind the gateway (an extension or MCP tool) starts as
 * `gateway(op="call", capability=<name>)`, so a requirement naming that
 * capability is met by the gateway call that carries it, read as the gateway
 * reads it (an `args`-only shorthand is a call).
 */
function satisfiesRequired(required: string, toolName: string, args: unknown): boolean {
	if (toolName === required) return true;
	return toolName === ToolNames.Gateway && gatewayCallCapability(args) === required;
}

export type MiddlewareToolChoice = { kind: "auto" } | { kind: "required"; toolName: string } | { kind: "none" };
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Small mutable bridge between middleware hooks and the provider payload.
 *
 * Tool hooks run inside the registry, after a provider response has already
 * been emitted. Their routing effects therefore apply to the *next* provider
 * round. A required tool clears only when that tool starts, directly or as the
 * capability of a gateway call; a text-only
 * lock wins over later requirements and lasts until the next submitted turn.
 */
export interface MiddlewareToolChoiceControl {
	apply(effects: ReadonlyArray<MiddlewareEffect>): void;
	current(): MiddlewareToolChoice;
	toolStarted(toolName: string, args?: unknown): void;
	completeRound(message: AssistantMessage): string | null;
	reset(): void;
}

export function createMiddlewareToolChoiceControl(): MiddlewareToolChoiceControl {
	let choice: MiddlewareToolChoice = { kind: "auto" };
	let followUpUsed = false;
	return {
		apply(effects) {
			for (const effect of effects) {
				if (effect.kind === "lock_tools") {
					choice = { kind: "none" };
					continue;
				}
				if (effect.kind === "require_tool" && choice.kind !== "none") {
					if (choice.kind !== "required" || choice.toolName !== effect.toolName) followUpUsed = false;
					choice = { kind: "required", toolName: effect.toolName };
				}
			}
		},
		current: () => choice,
		toolStarted(toolName, args) {
			if (choice.kind === "required" && satisfiesRequired(choice.toolName, toolName, args)) choice = { kind: "auto" };
		},
		completeRound(message) {
			if (choice.kind !== "required" || message.stopReason === "error" || message.stopReason === "aborted") return null;
			// `choice` is reassigned by sibling methods, so its narrowing does not reach the callbacks below.
			const toolName = choice.toolName;
			const records = (message as AssistantMessage & { toolRounds?: ToolRoundRecord[] }).toolRounds;
			const record = records?.at(-1);
			if (record?.kind !== "required" || record.toolName !== toolName || record.choice !== "auto") return null;
			if (followUpUsed) record.enforcement = "follow-up";
			if (
				message.content.some(
					(block) => block.type === "toolCall" && satisfiesRequired(toolName, block.name, block.arguments),
				)
			)
				return null;
			if (followUpUsed) {
				record.enforcement = "unmet";
				return null;
			}
			followUpUsed = true;
			record.enforcement = "follow-up";
			return `<system-reminder>Call the ${toolName} tool now. This tool is required before answering.</system-reminder>`;
		},
		reset() {
			choice = { kind: "auto" };
			followUpUsed = false;
		},
	};
}
