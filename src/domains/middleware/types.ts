import type { ToolResultDigest } from "../../tools/result-disposition.js";

/**
 * The five lifecycle events of the unified middleware layer (w3 cutover).
 * Every event has a live producer: the registry fires before_tool/after_tool
 * in runSpec, the chat-loop fires turn_start on prompt acceptance, turn_end
 * when the final assistant message of a run lands, and on_compaction
 * (observe-only) before each compaction stage.
 */
export const MIDDLEWARE_HOOKS = ["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"] as const;

export type MiddlewareHook = (typeof MIDDLEWARE_HOOKS)[number];

export const MIDDLEWARE_EFFECT_KINDS = [
	"inject_reminder",
	"annotate_tool_result",
	"block_tool",
	"protect_path",
	"request_continuation",
	"require_tool",
	"lock_tools",
] as const;

export type MiddlewareEffectKind = (typeof MIDDLEWARE_EFFECT_KINDS)[number];

export const MIDDLEWARE_REMINDER_SEVERITIES = ["info", "advisory", "warn", "hard-block"] as const;

export type MiddlewareReminderSeverity = (typeof MIDDLEWARE_REMINDER_SEVERITIES)[number];

export const MIDDLEWARE_ANNOTATION_SEVERITIES = ["info", "warn"] as const;

export type MiddlewareAnnotationSeverity = (typeof MIDDLEWARE_ANNOTATION_SEVERITIES)[number];

export type MiddlewareEffect =
	| { kind: "inject_reminder"; message: string; severity?: MiddlewareReminderSeverity }
	| { kind: "annotate_tool_result"; message: string; severity?: MiddlewareAnnotationSeverity }
	| { kind: "block_tool"; reason: string; severity: "hard-block" }
	| { kind: "protect_path"; path: string; reason: string }
	| { kind: "request_continuation"; message: string }
	| { kind: "require_tool"; toolName: string }
	| { kind: "lock_tools" };

export type MiddlewareRuleSource = "builtin";

export interface MiddlewareRule {
	id: string;
	source: MiddlewareRuleSource;
	description: string;
	enabled: boolean;
	hooks: ReadonlyArray<MiddlewareHook>;
	effectKinds: ReadonlyArray<MiddlewareEffectKind>;
}

export interface MiddlewareSnapshot {
	version: 1;
	rules: ReadonlyArray<MiddlewareRule>;
}

export type MiddlewareMetadataValue = string | number | boolean | null;

export type MiddlewareMetadata = Readonly<Record<string, MiddlewareMetadataValue>>;

/**
 * Cap for `MiddlewareHookInput.text`, in characters. The runtime truncates
 * longer payloads from the head when cloning inputs, so no registration ever
 * evaluates unbounded text. Producers report the true length out of band
 * (chat-loop sets `metadata.assistantTextChars` on turn_end).
 */
export const MIDDLEWARE_HOOK_TEXT_MAX_CHARS = 16_000;

export interface MiddlewareHookInput {
	hook: MiddlewareHook;
	runId?: string;
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	correlationId?: string;
	toolName?: string;
	modelId?: string;
	metadata?: MiddlewareMetadata;
	/**
	 * Tool-call arguments, supplied by the registry on before_tool and
	 * after_tool. Read-only by contract: the runtime shallow-copies the record
	 * per evaluation, and registrations must never mutate nested values. The
	 * typed-field route (rather than JSON in `metadata`) follows the Q3
	 * decision for `turn_end` text.
	 */
	toolArgs?: Readonly<Record<string, unknown>>;
	/** Structured result details, supplied by the registry on after_tool. Read-only by contract. */
	toolResultDetails?: Readonly<Record<string, unknown>>;
	/** Bounded deterministic diagnostic supplied by the result-disposition layer on after_tool. */
	toolResultDigest?: Readonly<ToolResultDigest>;
	/**
	 * Free text attached to the hook occurrence; on turn_end this is the final
	 * assistant message text. The one typed exception to the scalar `metadata`
	 * contract (Q3 decision), capped at MIDDLEWARE_HOOK_TEXT_MAX_CHARS by the
	 * runtime when inputs are cloned.
	 */
	text?: string;
}

export interface MiddlewareHookResult {
	hook: MiddlewareHook;
	input: MiddlewareHookInput;
	effects: ReadonlyArray<MiddlewareEffect>;
	ruleIds: ReadonlyArray<string>;
}

/**
 * Read a finite number out of a hook input's metadata, or null.
 *
 * Metadata is an open bag a caller fills in, so a missing key, a string, a
 * boolean, and a NaN are all the same answer: this hook was not told. Null is
 * that answer; a zero would be a count the caller never reported.
 */
export function metadataNumber(input: MiddlewareHookInput, key: string): number | null {
	const value = input.metadata?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The string under `key`, or null when the caller did not report one. */
export function metadataString(input: MiddlewareHookInput, key: string): string | null {
	const value = input.metadata?.[key];
	return typeof value === "string" ? value : null;
}

export function isMiddlewareHook(value: string): value is MiddlewareHook {
	return (MIDDLEWARE_HOOKS as ReadonlyArray<string>).includes(value);
}

export function isMiddlewareEffectKind(value: string): value is MiddlewareEffectKind {
	return (MIDDLEWARE_EFFECT_KINDS as ReadonlyArray<string>).includes(value);
}

export function isMiddlewareReminderSeverity(value: string): value is MiddlewareReminderSeverity {
	return (MIDDLEWARE_REMINDER_SEVERITIES as ReadonlyArray<string>).includes(value);
}

export function isMiddlewareAnnotationSeverity(value: string): value is MiddlewareAnnotationSeverity {
	return (MIDDLEWARE_ANNOTATION_SEVERITIES as ReadonlyArray<string>).includes(value);
}
