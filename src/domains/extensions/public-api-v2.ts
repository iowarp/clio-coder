/**
 * Operator runtime API v2. Import these types only; Clio injects the API.
 *
 * The shape is event in, data out. A tick, a file change, a press and an
 * interview answer all arrive as events, and every handler returns what the
 * host should show. Nothing is pushed, so a reload is a process swap and a
 * handler can be tested by calling it.
 */
import type { ExtensionRuntimeSnapshot, ExtensionStatus, ExtensionTone } from "./public-api.js";
import type { View, ViewTone } from "./view.js";

export type ExtensionObservationEventV2 =
	| "session_open"
	| "session_close"
	| "turn_start"
	| "turn_end"
	| "tool_end"
	| "permission_requested"
	| "permission_resolved"
	| "dispatch_started"
	| "dispatch_completed"
	| "dispatch_failed"
	| "compaction_end"
	| "budget_alert"
	| "safety_blocked"
	| "fs_changed"
	| "workspace_enter"
	| "workspace_leave"
	| "tick";

export type ExtensionHookPoint = "prompt_submit" | "before_tool" | "after_tool" | "turn_start" | "turn_end";

/** Content families that cross the boundary only when the manifest declares them. */
export type ExtensionContentAccess = "prompt" | "tool-args" | "tool-results" | "assistant-text";

export type WorkspaceRegion = "header" | "board" | "rail" | "footer";

export interface ExtensionRuntimeSnapshotV2 extends ExtensionRuntimeSnapshot {
	/** Id of this extension's workspace that holds the screen, or null. `workspace` stays the project directory. */
	activeWorkspace: string | null;
}

/** Token counts as the provider reported them; cost is null unless the target declares pricing. */
export interface ExtensionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number | null;
	model: string | null;
	target: string | null;
}

/**
 * Fields marked with an access class are present only when the manifest
 * declares that class. Everything else is metadata every extension may see.
 */
export type ExtensionObservationV2 =
	| { event: "session_open"; reason: "startup" | "reload" | "session-change" }
	| { event: "session_close"; reason: "exit" | "reload" | "session-change" }
	| {
			event: "turn_start";
			turnId: string;
			/** access: prompt */
			text?: string;
	  }
	| {
			event: "turn_end";
			turnId: string;
			outcome: "completed" | "aborted" | "error";
			usage: ExtensionUsage | null;
			/** access: assistant-text */
			text?: string;
	  }
	| {
			event: "tool_end";
			turnId: string | null;
			tool: string;
			outcome: "ok" | "error" | "blocked";
			durationMs: number;
			/** access: tool-args */
			args?: unknown;
			/** access: tool-results */
			result?: string;
	  }
	| { event: "permission_requested"; tool: string }
	| { event: "permission_resolved"; tool: string; decision: "allowed" | "denied" }
	| { event: "dispatch_started"; runId: string; agentId: string }
	| { event: "dispatch_completed"; runId: string; agentId: string; durationMs: number; usage: ExtensionUsage | null }
	| { event: "dispatch_failed"; runId: string; agentId: string; reason: string }
	| { event: "compaction_end"; outcome: "ok" | "failed" }
	| { event: "budget_alert"; costUsd: number | null }
	| { event: "safety_blocked"; tool: string }
	| { event: "fs_changed"; paths: string[] }
	| { event: "workspace_enter"; workspace: string }
	| { event: "workspace_leave"; workspace: string }
	| { event: "tick"; intervalMs: number };

export type ExtensionHookEvent =
	| {
			point: "prompt_submit";
			/** access: prompt */
			text?: string;
	  }
	| {
			point: "before_tool";
			tool: string;
			turnId: string | null;
			/** access: tool-args */
			args?: unknown;
	  }
	| {
			point: "after_tool";
			tool: string;
			turnId: string | null;
			outcome: "ok" | "error";
			durationMs: number;
			/** access: tool-args */
			args?: unknown;
			/** access: tool-results */
			result?: string;
	  }
	| {
			point: "turn_start";
			turnId: string;
			/** access: prompt */
			text?: string;
	  }
	| {
			point: "turn_end";
			turnId: string;
			outcome: "completed" | "aborted" | "error";
			/** access: assistant-text */
			text?: string;
	  };

/**
 * Effects an awaited hook may return. Each applies only at the points the
 * middleware table allows; one returned elsewhere is refused at load. A
 * rewritten input is validated against the tool schema and classified again,
 * so an effect can narrow or redirect a call and never widen its authority.
 */
export type ExtensionEffect =
	| { kind: "block_tool"; reason: string }
	| { kind: "annotate_tool_result"; message: string; severity?: "info" | "warn" }
	| { kind: "inject_reminder"; message: string; severity?: "info" | "advisory" | "warn"; audience?: "model" }
	| { kind: "require_tool"; toolName: string }
	| { kind: "lock_tools" }
	| { kind: "notify_operator"; message: string; key: string }
	| { kind: "protect_path"; path: string; reason: string }
	| { kind: "request_continuation"; message: string; note?: string }
	| { kind: "rewrite_tool_input"; args: Record<string, unknown>; reason: string }
	| { kind: "rewrite_prompt"; text: string; reason: string }
	| { kind: "block_prompt"; reason: string };

export type ExtensionEffectKind = ExtensionEffect["kind"];

export interface ExtensionToast {
	text: string;
	tone?: ExtensionTone;
}

export interface ExtensionPanelV2 {
	title: string;
	meta?: string;
	view: View;
}

/** A floating framed card. `key` is stable across updates so the host can keep its place. */
export interface ExtensionIsland {
	key: string;
	title: string;
	meta?: string;
	tone?: ViewTone;
	view: View;
}

/**
 * `initial` is a draft the operator still has to submit; it never answers a
 * question by itself. Option values and labels are unique within a question,
 * because the overlay reports a selection by its label.
 */
export interface InterviewQuestion {
	id: string;
	label: string;
	help?: string;
	kind: "single" | "multi" | "text";
	options?: Array<{ value: string; label: string; detail?: string }>;
	initial?: string | string[];
}

export interface InterviewStep {
	key: string;
	title?: string;
	/** Context shown above the questions. Display only: its actions are not pressable here. */
	intro?: View;
	questions: InterviewQuestion[];
}

/** `id` names the registered interview handler that receives each step's answers. */
export interface Interview {
	id: string;
	title: string;
	/** Step count for the position strip, when known ahead. */
	total?: number;
	step: InterviewStep;
}

export interface InterviewAnswer {
	id: string;
	step: string;
	answers: Record<string, string | string[]>;
	/** `back` is reserved: the overlay cannot return to a resolved step yet, so the host never sends it. */
	nav: "next" | "back" | "cancel";
	/** Set with `nav: "cancel"` when no operator could answer. */
	reason?: "operator" | "headless" | "preempted";
}

export type InterviewNext = { step: InterviewStep; total?: number } | ({ done: true } & ExtensionOutputV2);

/**
 * What a handler returns. `text` is always the headless fallback. The fields
 * in the last group are honored only from a command or an action (and
 * `interview` also from a tool): a background handler cannot open a panel,
 * take the screen, start an interview or touch the prompt.
 */
export interface ExtensionOutputV2 {
	text: string;
	status?: ExtensionStatus | null;
	band?: View | null;
	card?: View;
	toast?: ExtensionToast;
	/** Updates an open panel from any handler; opens one only from a command or an action. */
	panel?: ExtensionPanelV2;
	dock?: View | null;
	/** Drawn only while one of this extension's workspaces is active. */
	regions?: Partial<Record<WorkspaceRegion, View | null>>;
	islands?: ExtensionIsland[] | null;

	workspace?: { enter: string } | { leave: true };
	interview?: Interview;
	prompt?: { fill: string } | { submit: string };
}

export interface ExtensionHookResult {
	effects?: ExtensionEffect[];
	ui?: Omit<ExtensionOutputV2, "text" | "workspace" | "interview" | "prompt">;
}

/** A tool that returns `interview` parks until the operator finishes it; the answers become the result. */
export interface ExtensionToolResult {
	text: string;
	data?: unknown;
	isError?: boolean;
	card?: View;
	interview?: Interview;
}

export interface ExtensionUiAction {
	id: string;
	/** Row, card or node key when the press came from a table, list, board or tree. */
	key?: string;
	source: "band" | "card" | "panel" | "dock" | "header" | "board" | "island" | "footer" | "leader";
}

export interface ExtensionKeyValue {
	get<T = unknown>(key: string): Promise<{ value: T | undefined; version: number }>;
	/** With `ifVersion`, the write lands only when the stored version still matches. */
	set(key: string, value: unknown, options?: { ifVersion?: number }): Promise<{ ok: boolean; version: number }>;
	delete(key: string): Promise<void>;
	keys(): Promise<string[]>;
}

export interface ExtensionContextV2 {
	readonly snapshot: Readonly<ExtensionRuntimeSnapshotV2>;
	readonly requestId: string;
	readonly signal: AbortSignal;
	/** Values of the manifest's `config` fields, defaults filled in. */
	readonly options: Readonly<Record<string, string | number | boolean>>;
	/** This session. Survives a reload and a restart that resumes the session. */
	readonly state: ExtensionKeyValue;
	/** This extension, across sessions on this machine. */
	readonly store: ExtensionKeyValue;
}

type MaybePromise<T> = T | Promise<T>;

export interface ExtensionApiV2 {
	readonly apiVersion: 2;
	/** A slash command: `/ext:<id>:<name>`, or `/<plugin>:<name>` when a bundle declares `replaces: prompt`. */
	handle(name: string, handler: (args: string, context: ExtensionContextV2) => MaybePromise<ExtensionOutputV2>): void;
	/** Passive observation. It cannot block or rewrite. */
	on(
		event: ExtensionObservationEventV2,
		handler: (event: ExtensionObservationV2, context: ExtensionContextV2) => MaybePromise<ExtensionOutputV2 | undefined>,
	): void;
	/** Awaited hook under the deadline and failure mode the manifest declares. */
	hook(
		point: ExtensionHookPoint,
		handler: (event: ExtensionHookEvent, context: ExtensionContextV2) => MaybePromise<ExtensionHookResult>,
	): void;
	/** A gateway tool this runtime serves, reached as `extension_<id>__<name>`. */
	tool(name: string, handler: (input: unknown, context: ExtensionContextV2) => MaybePromise<ExtensionToolResult>): void;
	/** A press on something the host drew for this extension. */
	action(
		id: string,
		handler: (event: ExtensionUiAction, context: ExtensionContextV2) => MaybePromise<ExtensionOutputV2>,
	): void;
	interview(
		id: string,
		handler: (event: InterviewAnswer, context: ExtensionContextV2) => MaybePromise<InterviewNext>,
	): void;
	onDispose(handler: (reason: string) => void | Promise<void>): void;
}

export type ExtensionFactoryV2 = (api: ExtensionApiV2) => void | Promise<void>;

/**
 * A workspace's skin file. Palette keys are Clio palette color names; each
 * override gives the value for a dark and a light terminal background. The
 * host refuses overrides of the error, warning and approval colors and any
 * value below a 4.5 contrast ratio against its background.
 */
export interface ExtensionSkin {
	palette?: Record<string, { dark: string; light: string }>;
	glyphs?: { brand?: string };
	/** How this package's own agent recipes are named on its islands. */
	agents?: Record<string, { label?: string; glyph?: string }>;
}
