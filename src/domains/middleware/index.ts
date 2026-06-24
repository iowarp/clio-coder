import type { DomainModule } from "../../core/domain-loader.js";
import type { MiddlewareContract } from "./contract.js";
import { createMiddlewareBundle } from "./extension.js";
import { MiddlewareManifest } from "./manifest.js";

export const MiddlewareDomainModule: DomainModule<MiddlewareContract> = {
	manifest: MiddlewareManifest,
	createExtension: () => createMiddlewareBundle(),
};

export type { MiddlewareContract } from "./contract.js";
export type { MiddlewareBundleOptions } from "./extension.js";
export { createMiddlewareBundle } from "./extension.js";
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
export { createMiddlewareContractFromSnapshot, createMiddlewareSnapshot } from "./snapshot.js";
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
