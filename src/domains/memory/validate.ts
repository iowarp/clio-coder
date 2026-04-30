import {
	MEMORY_SCOPES,
	MEMORY_VERSION,
	type MemoryRecord,
	type MemoryRecordValidationResult,
	type MemoryScope,
	type MemoryStoreValidationResult,
	type MemoryValidationIssue,
} from "./types.js";

const ID_PATTERN = /^mem-[a-f0-9]{16}$/;

export function isMemoryScope(value: string): value is MemoryScope {
	return (MEMORY_SCOPES as ReadonlyArray<string>).includes(value);
}

export function validateMemoryRecord(value: unknown, source = "$"): MemoryRecordValidationResult {
	const issues: MemoryValidationIssue[] = [];
	const record = readMemoryRecord(value, source, issues);
	if (record === null || issues.length > 0) return { valid: false, issues };
	return { valid: true, record };
}

export function validateMemoryStore(value: unknown, source = "$"): MemoryStoreValidationResult {
	const issues: MemoryValidationIssue[] = [];
	if (!isRecord(value)) return { valid: false, issues: [{ path: source, message: "expected object" }] };
	rejectUnexpectedFields(value, source, ["version", "records"], issues);
	if (value.version !== MEMORY_VERSION) issues.push({ path: `${source}.version`, message: "expected 1" });
	const rawRecords = value.records;
	if (!Array.isArray(rawRecords)) {
		issues.push({ path: `${source}.records`, message: "expected array" });
		return { valid: false, issues };
	}
	const records: MemoryRecord[] = [];
	for (let index = 0; index < rawRecords.length; index += 1) {
		const record = readMemoryRecord(rawRecords[index], `${source}.records[${index}]`, issues);
		if (record !== null) records.push(record);
	}
	if (issues.length > 0) return { valid: false, issues };
	return { valid: true, store: { version: MEMORY_VERSION, records } };
}

function readMemoryRecord(value: unknown, path: string, issues: MemoryValidationIssue[]): MemoryRecord | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return null;
	}
	rejectUnexpectedFields(
		value,
		path,
		[
			"id",
			"scope",
			"key",
			"lesson",
			"evidenceRefs",
			"appliesWhen",
			"avoidWhen",
			"confidence",
			"createdAt",
			"lastVerifiedAt",
			"regressions",
			"approved",
			"rejectedAt",
		],
		issues,
	);
	const id = readString(value, `${path}.id`, issues);
	if (id !== null && !ID_PATTERN.test(id)) {
		issues.push({ path: `${path}.id`, message: "expected mem- followed by 16 lowercase hex characters" });
	}
	const scopeValue = readString(value, `${path}.scope`, issues);
	const scope = scopeValue !== null && isMemoryScope(scopeValue) ? scopeValue : null;
	if (scopeValue !== null && scope === null) issues.push({ path: `${path}.scope`, message: "expected memory scope" });
	const key = readString(value, `${path}.key`, issues);
	const lesson = readString(value, `${path}.lesson`, issues);
	const evidenceRefs = readStringArray(value, `${path}.evidenceRefs`, issues);
	if (evidenceRefs !== null && evidenceRefs.length === 0) {
		issues.push({ path: `${path}.evidenceRefs`, message: "expected at least one evidence ref" });
	}
	const appliesWhen = readStringArray(value, `${path}.appliesWhen`, issues);
	const avoidWhen = readStringArray(value, `${path}.avoidWhen`, issues);
	const confidence = readNumber(value, `${path}.confidence`, issues);
	if (confidence !== null && (confidence < 0 || confidence > 1)) {
		issues.push({ path: `${path}.confidence`, message: "expected number between 0 and 1" });
	}
	const createdAt = readIsoString(value, `${path}.createdAt`, issues);
	const lastVerifiedAt = readOptionalIsoString(value, `${path}.lastVerifiedAt`, issues);
	const regressions = readOptionalStringArray(value, `${path}.regressions`, issues);
	const approved = readBoolean(value, `${path}.approved`, issues);
	const rejectedAt = readOptionalIsoString(value, `${path}.rejectedAt`, issues);
	if (approved === true && rejectedAt !== undefined) {
		issues.push({ path: `${path}.rejectedAt`, message: "approved records must not be rejected" });
	}
	if (
		id === null ||
		scope === null ||
		key === null ||
		lesson === null ||
		evidenceRefs === null ||
		appliesWhen === null ||
		avoidWhen === null ||
		confidence === null ||
		createdAt === null ||
		approved === null
	) {
		return null;
	}
	const record: MemoryRecord = {
		id,
		scope,
		key,
		lesson,
		evidenceRefs,
		appliesWhen,
		avoidWhen,
		confidence,
		createdAt,
		approved,
	};
	if (lastVerifiedAt !== undefined) record.lastVerifiedAt = lastVerifiedAt;
	if (regressions !== undefined) record.regressions = regressions;
	if (rejectedAt !== undefined) record.rejectedAt = rejectedAt;
	return record;
}

function rejectUnexpectedFields(
	record: Record<string, unknown>,
	path: string,
	allowed: ReadonlyArray<string>,
	issues: MemoryValidationIssue[],
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(record).sort(compareStrings)) {
		if (!allowedSet.has(key)) issues.push({ path: `${path}.${key}`, message: "unknown field" });
	}
}

function readString(record: Record<string, unknown>, path: string, issues: MemoryValidationIssue[]): string | null {
	const value = readField(record, path, issues);
	if (typeof value !== "string" || value.length === 0) {
		issues.push({ path, message: "expected non-empty string" });
		return null;
	}
	return value;
}

function readIsoString(record: Record<string, unknown>, path: string, issues: MemoryValidationIssue[]): string | null {
	const value = readString(record, path, issues);
	if (value === null) return null;
	if (!isValidIsoTimestamp(value)) issues.push({ path, message: "expected ISO timestamp" });
	return value;
}

function readOptionalIsoString(
	record: Record<string, unknown>,
	path: string,
	issues: MemoryValidationIssue[],
): string | undefined {
	const key = fieldName(path);
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		issues.push({ path, message: "expected non-empty string" });
		return undefined;
	}
	if (!isValidIsoTimestamp(value)) issues.push({ path, message: "expected ISO timestamp" });
	return value;
}

function readStringArray(
	record: Record<string, unknown>,
	path: string,
	issues: MemoryValidationIssue[],
): string[] | null {
	const value = readField(record, path, issues);
	if (!Array.isArray(value)) {
		issues.push({ path, message: "expected string array" });
		return null;
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string" || item.length === 0) {
			issues.push({ path: `${path}[${index}]`, message: "expected non-empty string" });
			continue;
		}
		out.push(item);
	}
	return out;
}

function readOptionalStringArray(
	record: Record<string, unknown>,
	path: string,
	issues: MemoryValidationIssue[],
): string[] | undefined {
	const key = fieldName(path);
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	if (!Array.isArray(value)) {
		issues.push({ path, message: "expected string array" });
		return undefined;
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string" || item.length === 0) {
			issues.push({ path: `${path}[${index}]`, message: "expected non-empty string" });
			continue;
		}
		out.push(item);
	}
	return out;
}

function readNumber(record: Record<string, unknown>, path: string, issues: MemoryValidationIssue[]): number | null {
	const value = readField(record, path, issues);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		issues.push({ path, message: "expected number" });
		return null;
	}
	return value;
}

function readBoolean(record: Record<string, unknown>, path: string, issues: MemoryValidationIssue[]): boolean | null {
	const value = readField(record, path, issues);
	if (typeof value !== "boolean") {
		issues.push({ path, message: "expected boolean" });
		return null;
	}
	return value;
}

function readField(record: Record<string, unknown>, path: string, issues: MemoryValidationIssue[]): unknown {
	const key = fieldName(path);
	if (!Object.hasOwn(record, key)) issues.push({ path, message: "missing required field" });
	return record[key];
}

function fieldName(path: string): string {
	const parts = path.split(".");
	return parts[parts.length - 1] ?? path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIsoTimestamp(value: string): boolean {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}
