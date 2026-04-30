import {
	isMiddlewareAnnotationSeverity,
	isMiddlewareEffectKind,
	isMiddlewareHook,
	isMiddlewareReminderSeverity,
	type MiddlewareEffect,
	type MiddlewareEffectKind,
	type MiddlewareHook,
	type MiddlewareRule,
	type MiddlewareRuleSource,
} from "./types.js";

export interface MiddlewareValidationIssue {
	path: string;
	message: string;
}

export type MiddlewareRuleValidationResult =
	| {
			valid: true;
			rule: MiddlewareRule;
			issues: [];
	  }
	| {
			valid: false;
			issues: MiddlewareValidationIssue[];
			rule?: undefined;
	  };

export type MiddlewareEffectValidationResult =
	| {
			valid: true;
			effect: MiddlewareEffect;
			issues: [];
	  }
	| {
			valid: false;
			issues: MiddlewareValidationIssue[];
			effect?: undefined;
	  };

export function validateMiddlewareRule(value: unknown, source = "$"): MiddlewareRuleValidationResult {
	const issues: MiddlewareValidationIssue[] = [];
	const rule = readMiddlewareRule(value, source, issues);
	if (issues.length > 0 || rule === null) return { valid: false, issues };
	return { valid: true, rule, issues: [] };
}

export function validateMiddlewareEffect(value: unknown, source = "$"): MiddlewareEffectValidationResult {
	const issues: MiddlewareValidationIssue[] = [];
	const effect = readMiddlewareEffect(value, source, issues);
	if (issues.length > 0 || effect === null) return { valid: false, issues };
	return { valid: true, effect, issues: [] };
}

function readMiddlewareRule(value: unknown, path: string, issues: MiddlewareValidationIssue[]): MiddlewareRule | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected middleware rule object" });
		return null;
	}
	rejectUnexpectedFields(value, path, ["id", "source", "description", "enabled", "hooks", "effectKinds"], issues);
	const id = readRequiredString(value, `${path}.id`, issues);
	const source = readRuleSource(value, `${path}.source`, issues);
	const description = readRequiredString(value, `${path}.description`, issues);
	const enabled = readRequiredBoolean(value, `${path}.enabled`, issues);
	const hooks = readHookArray(value, `${path}.hooks`, issues);
	const effectKinds = readEffectKindArray(value, `${path}.effectKinds`, issues);
	if (id !== null && !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(id)) {
		issues.push({
			path: `${path}.id`,
			message: "expected lowercase kebab-case id with optional dot-separated namespace",
		});
	}
	if (
		id === null ||
		source === null ||
		description === null ||
		enabled === null ||
		hooks === null ||
		effectKinds === null
	) {
		return null;
	}
	return {
		id,
		source,
		description,
		enabled,
		hooks,
		effectKinds,
	};
}

function readMiddlewareEffect(
	value: unknown,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected middleware effect object" });
		return null;
	}
	const kindValue = value.kind;
	if (typeof kindValue !== "string" || !isMiddlewareEffectKind(kindValue)) {
		issues.push({ path: `${path}.kind`, message: "expected known middleware effect kind" });
		return null;
	}
	switch (kindValue) {
		case "inject_reminder":
			return readInjectReminder(value, path, issues);
		case "annotate_tool_result":
			return readAnnotateToolResult(value, path, issues);
		case "block_tool":
			return readBlockTool(value, path, issues);
		case "protect_path":
			return readProtectPath(value, path, issues);
		case "require_validation":
			return readRequireValidation(value, path, issues);
		case "record_memory_candidate":
			return readRecordMemoryCandidate(value, path, issues);
	}
}

function readInjectReminder(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	rejectUnexpectedFields(record, path, ["kind", "message", "severity"], issues);
	const message = readRequiredString(record, `${path}.message`, issues);
	const severity = readOptionalString(record, `${path}.severity`, issues);
	if (severity !== undefined && !isMiddlewareReminderSeverity(severity)) {
		issues.push({ path: `${path}.severity`, message: "expected info, warn, or hard-block" });
	}
	if (message === null) return null;
	const effect: MiddlewareEffect = { kind: "inject_reminder", message };
	if (severity !== undefined && isMiddlewareReminderSeverity(severity)) effect.severity = severity;
	return effect;
}

function readAnnotateToolResult(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	rejectUnexpectedFields(record, path, ["kind", "message", "severity"], issues);
	const message = readRequiredString(record, `${path}.message`, issues);
	const severity = readOptionalString(record, `${path}.severity`, issues);
	if (severity !== undefined && !isMiddlewareAnnotationSeverity(severity)) {
		issues.push({ path: `${path}.severity`, message: "expected info or warn" });
	}
	if (message === null) return null;
	const effect: MiddlewareEffect = { kind: "annotate_tool_result", message };
	if (severity !== undefined && isMiddlewareAnnotationSeverity(severity)) effect.severity = severity;
	return effect;
}

function readBlockTool(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	rejectUnexpectedFields(record, path, ["kind", "reason", "severity"], issues);
	const reason = readRequiredString(record, `${path}.reason`, issues);
	const severity = readRequiredString(record, `${path}.severity`, issues);
	if (severity !== null && severity !== "hard-block") {
		issues.push({ path: `${path}.severity`, message: "expected hard-block" });
	}
	if (reason === null || severity !== "hard-block") return null;
	return { kind: "block_tool", reason, severity };
}

function readProtectPath(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	rejectUnexpectedFields(record, path, ["kind", "path", "reason"], issues);
	const protectedPath = readRequiredString(record, `${path}.path`, issues);
	const reason = readRequiredString(record, `${path}.reason`, issues);
	if (protectedPath === null || reason === null) return null;
	return { kind: "protect_path", path: protectedPath, reason };
}

function readRequireValidation(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	rejectUnexpectedFields(record, path, ["kind", "reason"], issues);
	const reason = readRequiredString(record, `${path}.reason`, issues);
	if (reason === null) return null;
	return { kind: "require_validation", reason };
}

function readRecordMemoryCandidate(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	rejectUnexpectedFields(record, path, ["kind", "lesson", "evidenceRefs"], issues);
	const lesson = readRequiredString(record, `${path}.lesson`, issues);
	const evidenceRefs = readRequiredStringArray(record, `${path}.evidenceRefs`, issues);
	if (lesson === null || evidenceRefs === null) return null;
	return { kind: "record_memory_candidate", lesson, evidenceRefs };
}

function readRuleSource(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareRuleSource | null {
	const field = pathField(path);
	const value = record[field];
	if (value !== "builtin") {
		issues.push({ path, message: "expected builtin" });
		return null;
	}
	return value;
}

function readHookArray(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareHook[] | null {
	return readEnumArray(record, path, isMiddlewareHook, "expected known middleware hook", issues);
}

function readEffectKindArray(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffectKind[] | null {
	return readEnumArray(record, path, isMiddlewareEffectKind, "expected known middleware effect kind", issues);
}

function readEnumArray<T extends string>(
	record: Record<string, unknown>,
	path: string,
	isValue: (value: string) => value is T,
	message: string,
	issues: MiddlewareValidationIssue[],
): T[] | null {
	const field = pathField(path);
	const value = record[field];
	if (!Array.isArray(value) || value.length === 0) {
		issues.push({ path, message: "expected non-empty string array" });
		return null;
	}
	const seen = new Set<T>();
	const parsed: T[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string" || !isValue(item)) {
			issues.push({ path: `${path}[${index}]`, message });
			continue;
		}
		if (seen.has(item)) {
			issues.push({ path: `${path}[${index}]`, message: "duplicate entry" });
			continue;
		}
		seen.add(item);
		parsed.push(item);
	}
	return parsed;
}

function readRequiredString(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): string | null {
	const value = record[pathField(path)];
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push({ path, message: "expected non-empty string" });
		return null;
	}
	return value;
}

function readOptionalString(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): string | undefined {
	const field = pathField(path);
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push({ path, message: "expected non-empty string" });
		return undefined;
	}
	return value;
}

function readRequiredBoolean(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): boolean | null {
	const value = record[pathField(path)];
	if (typeof value !== "boolean") {
		issues.push({ path, message: "expected boolean" });
		return null;
	}
	return value;
}

function readRequiredStringArray(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): string[] | null {
	const field = pathField(path);
	const value = record[field];
	if (!Array.isArray(value)) {
		issues.push({ path, message: "expected string array" });
		return null;
	}
	const strings: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string" || item.trim().length === 0) {
			issues.push({ path: `${path}[${index}]`, message: "expected non-empty string" });
			continue;
		}
		strings.push(item);
	}
	return strings;
}

function rejectUnexpectedFields(
	record: Record<string, unknown>,
	path: string,
	allowedFields: ReadonlyArray<string>,
	issues: MiddlewareValidationIssue[],
): void {
	const allowed = new Set(allowedFields);
	for (const field of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
		if (!allowed.has(field)) issues.push({ path: `${path}.${field}`, message: "unexpected field" });
	}
}

function pathField(path: string): string {
	return path.slice(path.lastIndexOf(".") + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
