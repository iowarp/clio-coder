/**
 * Re-exports of Clio engine-boundary types consumed by the rest of the codebase.
 *
 * Importing engine package types from anywhere else in the codebase violates the engine boundary.
 * Add new re-exports here when domains need additional engine types, and update the audit
 * document in the same commit.
 */

export type {
	AgentEvent,
	AgentMessage,
	AgentOptions,
	AgentState,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "@earendil-works/pi-agent-core";
export { Agent } from "@earendil-works/pi-agent-core";

import type { AgentState as PiAgentState } from "@earendil-works/pi-agent-core";

/**
 * Writable view onto the engine AgentState. The public typings mark
 * `errorMessage` as readonly because the agent itself is the canonical
 * mutator, but the chat-loop legitimately needs to clear it before retrying
 * after a recoverable failure (overflow recovery, transient retry chains).
 * Pi's runtime assigns to `_state.errorMessage = undefined` in the same
 * shape, so the field is writable in practice. Exposing the writable view
 * here keeps the engine boundary clean and lets call sites avoid `as unknown`
 * casts on the private surface.
 */
export type MutableAgentState = Omit<PiAgentState, "errorMessage"> & {
	errorMessage?: string | undefined;
};

export type {
	Api,
	ImageContent,
	KnownProvider,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
export type {
	EditorOptions,
	EditorTheme,
	SelectItem,
	SelectListLayoutOptions,
	SelectListTheme,
	SettingItem,
	SettingsListTheme,
} from "@earendil-works/pi-tui";
export { TUI } from "@earendil-works/pi-tui";
