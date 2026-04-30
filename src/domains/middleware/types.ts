export const MIDDLEWARE_HOOKS = [
	"before_model",
	"after_model",
	"before_tool",
	"after_tool",
	"before_finish",
	"after_finish",
	"on_blocked_tool",
	"on_retry",
	"on_compaction",
	"on_dispatch_start",
	"on_dispatch_end",
] as const;

export type MiddlewareHook = (typeof MIDDLEWARE_HOOKS)[number];

export const MIDDLEWARE_EFFECT_KINDS = [
	"inject_reminder",
	"annotate_tool_result",
	"block_tool",
	"protect_path",
	"require_validation",
	"record_memory_candidate",
] as const;

export type MiddlewareEffectKind = (typeof MIDDLEWARE_EFFECT_KINDS)[number];

export const MIDDLEWARE_REMINDER_SEVERITIES = ["info", "warn", "hard-block"] as const;

export type MiddlewareReminderSeverity = (typeof MIDDLEWARE_REMINDER_SEVERITIES)[number];

export const MIDDLEWARE_ANNOTATION_SEVERITIES = ["info", "warn"] as const;

export type MiddlewareAnnotationSeverity = (typeof MIDDLEWARE_ANNOTATION_SEVERITIES)[number];

export type MiddlewareEffect =
	| { kind: "inject_reminder"; message: string; severity?: MiddlewareReminderSeverity }
	| { kind: "annotate_tool_result"; message: string; severity?: MiddlewareAnnotationSeverity }
	| { kind: "block_tool"; reason: string; severity: "hard-block" }
	| { kind: "protect_path"; path: string; reason: string }
	| { kind: "require_validation"; reason: string }
	| { kind: "record_memory_candidate"; lesson: string; evidenceRefs: string[] };

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
}

export interface MiddlewareHookResult {
	hook: MiddlewareHook;
	input: MiddlewareHookInput;
	effects: ReadonlyArray<MiddlewareEffect>;
	ruleIds: ReadonlyArray<string>;
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
