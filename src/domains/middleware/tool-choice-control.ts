import type { MiddlewareEffect } from "./types.js";

export type MiddlewareToolChoice = { kind: "auto" } | { kind: "required"; toolName: string } | { kind: "none" };

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
	reset(): void;
}

export function createMiddlewareToolChoiceControl(): MiddlewareToolChoiceControl {
	let choice: MiddlewareToolChoice = { kind: "auto" };
	return {
		apply(effects) {
			for (const effect of effects) {
				if (effect.kind === "lock_tools") {
					choice = { kind: "none" };
					continue;
				}
				if (effect.kind === "require_tool" && choice.kind !== "none") {
					choice = { kind: "required", toolName: effect.toolName };
				}
			}
		},
		current: () => choice,
		toolStarted(toolName) {
			if (choice.kind === "required" && choice.toolName === toolName) choice = { kind: "auto" };
		},
		reset() {
			choice = { kind: "auto" };
		},
	};
}
