import {
	isMiddlewareAnnotationSeverity,
	isMiddlewareEffectKind,
	isMiddlewareReminderSeverity,
	type MiddlewareEffect,
} from "./types.js";

export interface MiddlewareValidationIssue {
	path: string;
	message: string;
}

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

export function validateMiddlewareEffect(value: unknown, source = "$"): MiddlewareEffectValidationResult {
	const issues: MiddlewareValidationIssue[] = [];
	const effect = readMiddlewareEffect(value, source, issues);
	if (issues.length > 0 || effect === null) return { valid: false, issues };
	return { valid: true, effect, issues: [] };
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
		case "request_continuation":
			return readRequestContinuation(value, path, issues);
		case "require_tool":
			return readRequireTool(value, path, issues);
		case "lock_tools":
			rejectUnexpectedFields(value, path, ["kind"], issues);
			return { kind: "lock_tools" };
		case "notify_operator": {
			rejectUnexpectedFields(value, path, ["kind", "message", "key"], issues);
			const message = readRequiredString(value, `${path}.message`, issues);
			const key = readRequiredString(value, `${path}.key`, issues);
			return message === null || key === null ? null : { kind: "notify_operator", message, key };
		}
	}
}

function readRequireTool(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	rejectUnexpectedFields(record, path, ["kind", "toolName"], issues);
	const toolName = readRequiredString(record, `${path}.toolName`, issues);
	return toolName === null ? null : { kind: "require_tool", toolName };
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
		issues.push({ path: `${path}.severity`, message: "expected info, advisory, warn, or hard-block" });
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

function readRequestContinuation(
	record: Record<string, unknown>,
	path: string,
	issues: MiddlewareValidationIssue[],
): MiddlewareEffect | null {
	rejectUnexpectedFields(record, path, ["kind", "message"], issues);
	const message = readRequiredString(record, `${path}.message`, issues);
	if (message === null) return null;
	return { kind: "request_continuation", message };
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
