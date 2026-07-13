import type { DomainModule } from "../../core/domain-loader.js";
import type { MiddlewareContract } from "./contract.js";
import { createMiddlewareBundle } from "./extension.js";
import { MiddlewareManifest } from "./manifest.js";

export const MiddlewareDomainModule: DomainModule<MiddlewareContract> = {
	manifest: MiddlewareManifest,
	createExtension: () => createMiddlewareBundle(),
};

export {
	createHookBudgetTracker,
	DEFAULT_HOOK_BUDGET_THRESHOLD,
	DEFAULT_HOOK_BUDGET_WARMUP_CALLS,
	DEFAULT_HOOK_BUDGET_WINDOW,
	DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS,
	type HookBudgetMap,
	type HookBudgetOutcome,
	type HookBudgetStats,
	type HookBudgetTracker,
	type HookBudgetTrackerOptions,
	resolveHookBudgetsFromEnv,
	resolveHookBudgetTunablesFromEnv,
} from "./budget.js";
export type { MiddlewareContract } from "./contract.js";
export {
	buildDetachedBatchesMessage,
	buildReadOnlyExplorationMessage,
	type CreateDetachedDispatchNudgeRegistrationOptions,
	createDetachedDispatchNudgeRegistration,
	createReadOnlyExplorationNudgeRegistration,
	DETACHED_DISPATCH_NUDGE_REGISTRATION_ID,
	type DetachedBatchNudgeView,
	openDetachedBatchViews,
	READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD,
	READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID,
} from "./dispatch-nudge.js";
export type { MiddlewareBundleOptions } from "./extension.js";
export { createEnvHookBudgetTracker, createMiddlewareBundle } from "./extension.js";
export { createHookReceiptLog, HOOK_RECEIPT_LOG_CAPACITY, type HookReceiptLog } from "./hook-receipts.js";
export type {
	HookReceipt,
	HookReceiptSink,
	NormalizedUserHook,
	UserHookCommandResult,
	UserHookCommandRunner,
	UserHookDeclarationBatch,
	UserHookKind,
	UserHookLoadIssue,
	UserHookLoadResult,
	UserHookOrigin,
	UserHookOutcome,
	UserHookSource,
} from "./hooks.js";
export {
	loadUserHooks,
	normalizeUserHook,
	USER_HOOK_COMMAND_OUTPUT_MAX_CHARS,
	USER_HOOK_COMMAND_TIMEOUT_DEFAULT_MS,
	USER_HOOK_ORIGIN_ORDER,
	USER_HOOK_PROMPT_MAX_CHARS,
	userHookToRegistration,
} from "./hooks.js";
export {
	type ExtensionHookRoot,
	type HookFileIssue,
	type InstallUserHooksResult,
	installUserHooks,
	readHookSources,
	spawnSyncCommandRunner,
} from "./hooks-io.js";
export { MiddlewareManifest } from "./manifest.js";
export { BUILTIN_MIDDLEWARE_RULE_IDS, listMiddlewareRuleDefinitions, listMiddlewareRules } from "./rules.js";
export type {
	MiddlewareDiagnostic,
	MiddlewareDiagnosticSink,
	MiddlewareHookEvaluationContext,
	MiddlewareHookRegistration,
	MiddlewareRuleDefinition,
	RunMiddlewareRegistrationsOptions,
} from "./runtime.js";
export {
	MIDDLEWARE_HOOK_BUDGET_MS,
	registrationFromRuleDefinition,
	runMiddlewareHook,
	runMiddlewareRegistrations,
	writeMiddlewareDiagnosticToStderr,
} from "./runtime.js";
export {
	createSkillsReminderRegistration,
	SKILL_SUGGESTION_ANCHOR,
	SKILLS_REMINDER_REGISTRATION_ID,
	type SkillsReminderDeps,
	skillsReminderMessage,
} from "./skills-reminder.js";
export { createMiddlewareContractFromSnapshot, createMiddlewareSnapshot } from "./snapshot.js";
export {
	countEnumeratedSteps,
	createTaskBoardReminderRegistration,
	TASK_BOARD_REMINDER_REGISTRATION_ID,
	taskBoardReminderMessage,
} from "./task-board-reminder.js";
export {
	buildOpenTasksMessage,
	type CreateTaskNudgeRegistrationOptions,
	createTaskNudgeRegistration,
	TASK_NUDGE_REGISTRATION_ID,
} from "./task-nudge.js";
export {
	createMiddlewareToolChoiceControl,
	type MiddlewareToolChoice,
	type MiddlewareToolChoiceControl,
} from "./tool-choice-control.js";
export type {
	MiddlewareAnnotationSeverity,
	MiddlewareEffect,
	MiddlewareEffectKind,
	MiddlewareHook,
	MiddlewareHookInput,
	MiddlewareHookResult,
	MiddlewareMetadata,
	MiddlewareMetadataValue,
	MiddlewareReminderSeverity,
	MiddlewareRule,
	MiddlewareRuleSource,
	MiddlewareSnapshot,
} from "./types.js";
export {
	isMiddlewareAnnotationSeverity,
	isMiddlewareEffectKind,
	isMiddlewareHook,
	isMiddlewareReminderSeverity,
	MIDDLEWARE_ANNOTATION_SEVERITIES,
	MIDDLEWARE_EFFECT_KINDS,
	MIDDLEWARE_HOOK_TEXT_MAX_CHARS,
	MIDDLEWARE_HOOKS,
	MIDDLEWARE_REMINDER_SEVERITIES,
} from "./types.js";
export type {
	MiddlewareEffectValidationResult,
	MiddlewareRuleValidationResult,
	MiddlewareValidationIssue,
} from "./validate.js";
export { validateMiddlewareEffect, validateMiddlewareRule } from "./validate.js";
