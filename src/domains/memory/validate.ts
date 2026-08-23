import { isAbsolute, resolve } from "node:path";
import {
	MEMORY_SCOPES,
	MEMORY_VERSION,
	type MemoryAgentIdentity,
	type MemoryPromotionRedaction,
	type MemoryRecord,
	type MemoryRecordProvenance,
	type MemoryRecordValidationResult,
	type MemoryRepositoryIdentity,
	type MemoryRuntimeIdentity,
	type MemoryScope,
	type MemoryStoreValidationResult,
	type MemoryValidationIssue,
} from "./types.js";

const ID_PATTERN = /^mem-[a-f0-9]{16}$/;

function isMemoryScope(value: string): value is MemoryScope {
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
			"repository",
			"runtime",
			"agent",
			"provenance",
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
	const repository = readOptionalMemoryRepositoryIdentity(value, `${path}.repository`, issues);
	const runtime = readOptionalNamedIdentity(value, `${path}.runtime`, "runtime", issues);
	const agent = readOptionalNamedIdentity(value, `${path}.agent`, "agent", issues);
	const provenance = readOptionalMemoryProvenance(value, `${path}.provenance`, issues);
	if (approved === true && rejectedAt !== undefined) {
		issues.push({ path: `${path}.rejectedAt`, message: "approved records must not be rejected" });
	}
	if (repository !== undefined && scope !== null && scope !== "repo") {
		issues.push({ path: `${path}.repository`, message: "repository applicability requires repo scope" });
	}
	if (repository === undefined && scope === "repo") {
		issues.push({ path: `${path}.repository`, message: "repo scope requires repository applicability" });
	}
	if (runtime !== undefined && scope !== null && scope !== "runtime") {
		issues.push({ path: `${path}.runtime`, message: "runtime applicability requires runtime scope" });
	}
	if (runtime === undefined && scope === "runtime") {
		issues.push({ path: `${path}.runtime`, message: "runtime scope requires runtime applicability" });
	}
	if (agent !== undefined && scope !== null && scope !== "agent") {
		issues.push({ path: `${path}.agent`, message: "agent applicability requires agent scope" });
	}
	if (agent === undefined && scope === "agent") {
		issues.push({ path: `${path}.agent`, message: "agent scope requires agent applicability" });
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
	if (repository !== undefined) record.repository = repository;
	if (runtime !== undefined) record.runtime = runtime;
	if (agent !== undefined) record.agent = agent;
	if (provenance !== undefined) record.provenance = provenance;
	return record;
}

function readOptionalMemoryRepositoryIdentity(
	record: Record<string, unknown>,
	path: string,
	issues: MemoryValidationIssue[],
): MemoryRepositoryIdentity | undefined {
	const field = fieldName(path);
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return undefined;
	}
	rejectUnexpectedFields(value, path, ["kind", "key"], issues);
	const kind = readString(value, `${path}.kind`, issues);
	if (kind !== null && kind !== "canonical-path") {
		issues.push({ path: `${path}.kind`, message: "expected canonical-path" });
	}
	const key = readString(value, `${path}.key`, issues);
	if (key !== null && !isNormalizedAbsoluteRepositoryPath(key)) {
		issues.push({ path: `${path}.key`, message: "expected normalized absolute repository path" });
	}
	if (kind !== "canonical-path" || key === null || !isNormalizedAbsoluteRepositoryPath(key)) return undefined;
	return { kind, key };
}

function readOptionalNamedIdentity<T extends "runtime" | "agent">(
	record: Record<string, unknown>,
	path: string,
	kind: T,
	issues: MemoryValidationIssue[],
): (T extends "runtime" ? MemoryRuntimeIdentity : MemoryAgentIdentity) | undefined {
	const field = fieldName(path);
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return undefined;
	}
	rejectUnexpectedFields(value, path, ["kind", "key"], issues);
	const actualKind = readString(value, `${path}.kind`, issues);
	if (actualKind !== null && actualKind !== kind) {
		issues.push({ path: `${path}.kind`, message: `expected ${kind}` });
	}
	const key = readString(value, `${path}.key`, issues);
	if (key !== null && !isValidNamedIdentityKey(key)) {
		issues.push({ path: `${path}.key`, message: `expected valid ${kind} identity` });
	}
	if (actualKind !== kind || key === null || !isValidNamedIdentityKey(key)) return undefined;
	return { kind, key } as T extends "runtime" ? MemoryRuntimeIdentity : MemoryAgentIdentity;
}

function readOptionalMemoryProvenance(
	record: Record<string, unknown>,
	path: string,
	issues: MemoryValidationIssue[],
): MemoryRecordProvenance | undefined {
	const field = fieldName(path);
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return undefined;
	}
	rejectUnexpectedFields(
		value,
		path,
		[
			"sourceKind",
			"evidenceId",
			"sourceSessionId",
			"sourceEntryId",
			"sourceEntryKind",
			"sourceEntryCreatedAt",
			"sourceEntryLastTouchedAt",
			"redaction",
		],
		issues,
	);
	const sourceKind = readString(value, `${path}.sourceKind`, issues);
	if (sourceKind !== null && !["evidence", "task-bank-entry", "handoff-snapshot"].includes(sourceKind)) {
		issues.push({ path: `${path}.sourceKind`, message: "expected evidence, task-bank-entry, or handoff-snapshot" });
	}
	const evidenceId = readOptionalSourceString(value, `${path}.evidenceId`, issues);
	const sourceSessionId = readOptionalSourceString(value, `${path}.sourceSessionId`, issues);
	const sourceEntryId = readOptionalSourceString(value, `${path}.sourceEntryId`, issues);
	const sourceEntryKind = readOptionalSourceString(value, `${path}.sourceEntryKind`, issues);
	if (sourceEntryKind !== undefined && sourceEntryKind !== "knowledge" && sourceEntryKind !== "procedural") {
		issues.push({ path: `${path}.sourceEntryKind`, message: "expected knowledge or procedural" });
	}
	const sourceEntryCreatedAt = readOptionalIsoString(value, `${path}.sourceEntryCreatedAt`, issues);
	const sourceEntryLastTouchedAt = readOptionalIsoString(value, `${path}.sourceEntryLastTouchedAt`, issues);
	const redaction = readOptionalPromotionRedaction(value, `${path}.redaction`, issues);
	if (sourceKind === "evidence") {
		if (evidenceId === undefined)
			issues.push({ path: `${path}.evidenceId`, message: "evidence source requires evidence id" });
		if (sourceEntryId !== undefined || sourceEntryKind !== undefined) {
			issues.push({ path, message: "evidence source must not carry task-memory entry fields" });
		}
	}
	if (sourceKind === "task-bank-entry" || sourceKind === "handoff-snapshot") {
		if (sourceSessionId === undefined) {
			issues.push({ path: `${path}.sourceSessionId`, message: "promotion source requires session id" });
		}
		if (sourceEntryId === undefined) {
			issues.push({ path: `${path}.sourceEntryId`, message: "promotion source requires entry id" });
		}
		if (sourceEntryKind !== "knowledge" && sourceEntryKind !== "procedural") {
			issues.push({ path: `${path}.sourceEntryKind`, message: "promotion source requires entry kind" });
		}
		if (redaction === undefined) {
			issues.push({ path: `${path}.redaction`, message: "promotion source requires redaction provenance" });
		}
	}
	if (sourceKind === null || !["evidence", "task-bank-entry", "handoff-snapshot"].includes(sourceKind)) {
		return undefined;
	}
	const provenance: MemoryRecordProvenance = { sourceKind: sourceKind as MemoryRecordProvenance["sourceKind"] };
	if (evidenceId !== undefined) provenance.evidenceId = evidenceId;
	if (sourceSessionId !== undefined) provenance.sourceSessionId = sourceSessionId;
	if (sourceEntryId !== undefined) provenance.sourceEntryId = sourceEntryId;
	if (sourceEntryKind === "knowledge" || sourceEntryKind === "procedural") {
		provenance.sourceEntryKind = sourceEntryKind;
	}
	if (sourceEntryCreatedAt !== undefined) provenance.sourceEntryCreatedAt = sourceEntryCreatedAt;
	if (sourceEntryLastTouchedAt !== undefined) provenance.sourceEntryLastTouchedAt = sourceEntryLastTouchedAt;
	if (redaction !== undefined) provenance.redaction = redaction;
	return provenance;
}

function readOptionalPromotionRedaction(
	record: Record<string, unknown>,
	path: string,
	issues: MemoryValidationIssue[],
): MemoryPromotionRedaction | undefined {
	const field = fieldName(path);
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return undefined;
	}
	rejectUnexpectedFields(value, path, ["appliedBeforePersistence", "replacementCount", "sourceFields"], issues);
	const appliedBeforePersistence = readBoolean(value, `${path}.appliedBeforePersistence`, issues);
	if (appliedBeforePersistence !== null && appliedBeforePersistence !== true) {
		issues.push({ path: `${path}.appliedBeforePersistence`, message: "expected true" });
	}
	const replacementCount = readNumber(value, `${path}.replacementCount`, issues);
	if (replacementCount !== null && (!Number.isInteger(replacementCount) || replacementCount < 0)) {
		issues.push({ path: `${path}.replacementCount`, message: "expected non-negative integer" });
	}
	const sourceFields = readStringArray(value, `${path}.sourceFields`, issues);
	if (appliedBeforePersistence !== true || replacementCount === null || sourceFields === null) return undefined;
	return { appliedBeforePersistence, replacementCount, sourceFields };
}

function readOptionalSourceString(
	record: Record<string, unknown>,
	path: string,
	issues: MemoryValidationIssue[],
): string | undefined {
	const field = fieldName(path);
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (typeof value !== "string" || !isValidSourceValue(value)) {
		issues.push({ path, message: "expected valid non-empty source value" });
		return undefined;
	}
	return value;
}

function isNormalizedAbsoluteRepositoryPath(value: string): boolean {
	return !/[\0\r\n]/u.test(value) && isAbsolute(value) && resolve(value) === value;
}

function isValidNamedIdentityKey(value: string): boolean {
	return value.length > 0 && value.length <= 256 && value.trim() === value && !/[\0\r\n\t ]/u.test(value);
}

function isValidSourceValue(value: string): boolean {
	return value.length > 0 && value.length <= 1_024 && value.trim() === value && !/[\0\r\n]/u.test(value);
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
