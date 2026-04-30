import type { DomainModule } from "../../core/domain-loader.js";
import type { MiddlewareContract } from "./contract.js";
import { createMiddlewareBundle } from "./extension.js";
import { MiddlewareManifest } from "./manifest.js";

export const MiddlewareDomainModule: DomainModule<MiddlewareContract> = {
	manifest: MiddlewareManifest,
	createExtension: createMiddlewareBundle,
};

export type { MiddlewareContract } from "./contract.js";
export { createMiddlewareBundle } from "./extension.js";
export { MiddlewareManifest } from "./manifest.js";
export { BUILTIN_MIDDLEWARE_RULE_IDS, listMiddlewareRules } from "./rules.js";
export { runMiddlewareHook } from "./runtime.js";
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
	MIDDLEWARE_HOOKS,
	MIDDLEWARE_REMINDER_SEVERITIES,
} from "./types.js";
export type {
	MiddlewareEffectValidationResult,
	MiddlewareRuleValidationResult,
	MiddlewareValidationIssue,
} from "./validate.js";
export { validateMiddlewareEffect, validateMiddlewareRule } from "./validate.js";
