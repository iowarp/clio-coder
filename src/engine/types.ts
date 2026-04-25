/**
 * Re-exports of pi SDK 0.70.x types consumed by Clio. Frozen against
 * docs/.superpowers/boundaries/pi-sdk-boundary-0.70.x.md.
 *
 * Importing pi-* types from anywhere else in the codebase violates the engine boundary.
 * Add new re-exports here when domains need additional pi types, and update the audit
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
} from "@mariozechner/pi-agent-core";
export { Agent } from "@mariozechner/pi-agent-core";

export type {
	Api,
	KnownProvider,
	Model,
	Usage,
} from "@mariozechner/pi-ai";
export type {
	EditorOptions,
	EditorTheme,
	SelectItem,
	SelectListLayoutOptions,
	SelectListTheme,
	SettingItem,
	SettingsListTheme,
} from "@mariozechner/pi-tui";
export { TUI } from "@mariozechner/pi-tui";
