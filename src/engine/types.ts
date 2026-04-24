/**
 * Re-exports of pi-mono 0.69.0 types consumed by Clio. Frozen against
 * docs/architecture/pi-mono-boundary-0.69.0.md.
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
