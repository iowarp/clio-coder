import type { AgentMessage, ToolRoundRecord } from "../../engine/types.js";
import type { MiddlewareEffect } from "./types.js";

export type MiddlewareToolChoice = { kind: "auto" } | { kind: "required"; toolName: string } | { kind: "none" };
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Small mutable bridge between middleware hooks and the provider payload.
 *
 * Tool hooks run inside the registry, after a provider response has already
 * been emitted. Their routing effects therefore apply to the *next* provider
 * round. A required tool clears only when that exact tool starts; a text-only
 * lock wins over later requirements and lasts until the next submitted turn.
 */
export interface MiddlewareToolChoiceControl {
	apply(effects: ReadonlyArray<MiddlewareEffect>): void;
	current(): MiddlewareToolChoice;
	toolStarted(toolName: string): void;
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
		toolStarted(toolName) {
			if (choice.kind === "required" && choice.toolName === toolName) choice = { kind: "auto" };
		},
		completeRound(message) {
			if (choice.kind !== "required" || message.stopReason === "error" || message.stopReason === "aborted") return null;
			// `choice` is reassigned by sibling methods, so its narrowing does not reach the callbacks below.
			const toolName = choice.toolName;
			const records = (message as AssistantMessage & { toolRounds?: ToolRoundRecord[] }).toolRounds;
			const record = records?.at(-1);
			if (record?.kind !== "required" || record.toolName !== toolName || record.choice !== "auto") return null;
			if (followUpUsed) record.enforcement = "follow-up";
			if (message.content.some((block) => block.type === "toolCall" && block.name === toolName)) return null;
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
