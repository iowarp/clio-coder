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
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";

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
	AnthropicMessagesCompat,
	Api,
	AuthOperationOptions,
	ImageContent,
	KnownProvider,
	Model,
	OpenAICompletionsCompat,
	Usage,
} from "@earendil-works/pi-ai";

import type { Api as PiApi, Model as PiModel } from "@earendil-works/pi-ai";

/**
 * The one Clio-facing model shape. Runtime descriptors synthesize
 * `Model<Api>` values and every consumer (chat loop, orchestrator, worker
 * runtime, payload patchers) holds this erased view; `Model<never>` and the
 * `as unknown as` casts it forced are banned.
 */
export type EngineModel = PiModel<PiApi>;
export type {
	EditorTheme,
	SelectItem,
	SelectListLayoutOptions,
	SelectListTheme,
	SettingItem,
	SettingsListTheme,
	TUI,
} from "@earendil-works/pi-tui";

/** Sanitized same-request Codex plan windows. No credential or raw account identity. */
export interface CodexQuotaObservation {
	accountScope: string;
	observedAt: string;
	windows: Array<{ windowMinutes: number; usedPercent: number; resetsAt: string | null }>;
	plan: string | null;
	credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
	allowed: boolean | null;
	limitReached: boolean | null;
}

/** Sanitized per-call Anthropic response facts for #423. No credential or raw org/workspace id. */
export interface AnthropicResponseObservation {
	observedAt: string;
	status: number | null;
	attempts: number;
	requestId: string | null;
	accountScope: string | null;
	retryAfterSeconds: number | null;
	/** Unified rate-limit headers retain provider extensions for consumers (#423). */
	rateLimit: Record<string, string>;
	/** Preserve message_start diagnostics without response content (#423). */
	messageStart: Record<string, unknown> | null;
}

/** Codex context generation; positions are durable ledger user-turn ids (#423). */
export interface CodexConfiguration {
	initialEffort: string;
	updates: ReadonlyArray<{ position: string; effort: string }>;
}

/** Effective routing attempts retained in existing run records and receipts (#426). */
export interface ToolRoundRecord {
	kind: "required" | "text-only" | "tools-removed";
	toolName?: string;
	choice: unknown;
	attempt: 0 | 1;
	downgradeReason?: string;
}

/** #423: physical WebSocket sends, not provider usage or SSE HTTP retry counts. */
export interface CodexTransportCounters {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	fullContextRequests: number;
	deltaRequests: number;
	websocketFailures: number;
	sseFallbacks: number;
}

/** #423 / #427 AC4: sanitized per-call transport attribution and safe-boundary recovery. */
export interface CodexTransportObservation {
	mode: "websocket" | "sse" | "unknown";
	request: "full" | "delta" | "unknown";
	attribution: "exclusive" | "overlap" | "no_session" | "counter_reset";
	counters: CodexTransportCounters | null;
	lastInputItems: number | null;
	fallbackActive: boolean;
	reason?: string;
	cooldownMs?: number | null;
	retryAt?: string | null;
	recovery?: {
		action: "cooldown_reset" | "auth_reset";
		countersBeforeReset: CodexTransportCounters;
		outcome: "eligible" | "recovered" | "failed" | "unknown";
	};
}
