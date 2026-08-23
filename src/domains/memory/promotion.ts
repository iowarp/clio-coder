import { createHash } from "node:crypto";
import { createRedactionTally, redactSecretsText } from "../evidence/redact.js";
import { canonicalMemoryRepositoryIdentity } from "./operations.js";
import { loadMemoryRecords, upsertMemoryRecord } from "./store.js";
import type { TaskMemoryEntry, TaskMemoryRenderableClass } from "./task-bank.js";
import type {
	MemoryAgentIdentity,
	MemoryProposalResult,
	MemoryRecord,
	MemoryRepositoryIdentity,
	MemoryRuntimeIdentity,
} from "./types.js";
import { validateMemoryRecord } from "./validate.js";

export const MEMORY_PROMOTION_SCOPES = ["repo", "global", "runtime", "agent"] as const;
export type MemoryPromotionScope = (typeof MEMORY_PROMOTION_SCOPES)[number];

export type MemoryScopeSelection =
	| { scope: "repo"; repository: MemoryRepositoryIdentity }
	| { scope: "global"; acknowledgeGlobal: true }
	| { scope: "runtime"; runtime: MemoryRuntimeIdentity }
	| { scope: "agent"; agent: MemoryAgentIdentity };

export interface MemoryPromotionSourceRedaction {
	replacementCount: number;
	sourceFields: ReadonlyArray<string>;
}

export interface MemoryPromotionSource {
	kind: "task-bank-entry" | "handoff-snapshot";
	sessionId: string;
	evidenceRefs: ReadonlyArray<string>;
	entry: TaskMemoryEntry;
	runtimeIds?: ReadonlyArray<string>;
	agentIds?: ReadonlyArray<string>;
	redaction?: MemoryPromotionSourceRedaction;
}

interface ScopeSourceIdentities {
	runtimeIds: ReadonlyArray<string>;
	agentIds: ReadonlyArray<string>;
}

/**
 * Validate an operator-selected scope without inferring or widening it.
 * Runtime and agent scopes must name identities carried by the source.
 */
export function validateMemoryScopeSelection(
	selection: MemoryScopeSelection,
	source: ScopeSourceIdentities,
): MemoryScopeSelection {
	switch (selection.scope) {
		case "repo": {
			const repository = canonicalMemoryRepositoryIdentity(selection.repository.key);
			if (
				selection.repository.kind !== "canonical-path" ||
				repository === null ||
				repository.key !== selection.repository.key
			) {
				throw new Error("repo scope requires an existing canonical absolute repository identity");
			}
			return { scope: "repo", repository };
		}
		case "global":
			if (selection.acknowledgeGlobal !== true) {
				throw new Error("global scope requires a separate operator acknowledgement");
			}
			return selection;
		case "runtime": {
			const runtime = normalizeNamedIdentity(selection.runtime, "runtime");
			if (!source.runtimeIds.includes(runtime.key)) {
				throw new Error(`runtime identity '${runtime.key}' does not match the promotion source`);
			}
			return { scope: "runtime", runtime };
		}
		case "agent": {
			const agent = normalizeNamedIdentity(selection.agent, "agent");
			if (!source.agentIds.includes(agent.key)) {
				throw new Error(`agent identity '${agent.key}' does not match the promotion source`);
			}
			return { scope: "agent", agent };
		}
	}
}

export function memoryRuntimeIdentity(key: string): MemoryRuntimeIdentity {
	return normalizeNamedIdentity({ kind: "runtime", key }, "runtime");
}

export function memoryAgentIdentity(key: string): MemoryAgentIdentity {
	return normalizeNamedIdentity({ kind: "agent", key }, "agent");
}

/** Create one reviewable proposal from a selected non-private task-bank entry. */
export async function proposeMemoryPromotion(
	dataDir: string,
	source: MemoryPromotionSource,
	selection: MemoryScopeSelection,
	now: Date = new Date(),
): Promise<MemoryProposalResult> {
	validatePromotionSource(source);
	const validatedScope = validateMemoryScopeSelection(selection, {
		runtimeIds: source.runtimeIds ?? [],
		agentIds: source.agentIds ?? [],
	});
	const record = memoryRecordFromPromotion(source, validatedScope, now);
	const existing = (await loadMemoryRecords(dataDir)).find((candidate) => candidate.id === record.id);
	if (existing !== undefined) return { record: existing, created: false };
	await upsertMemoryRecord(dataDir, record);
	return { record, created: true };
}

export function memoryRecordFromPromotion(
	source: MemoryPromotionSource,
	selection: MemoryScopeSelection,
	now: Date = new Date(),
): MemoryRecord {
	validatePromotionSource(source);
	const entryKind = source.entry.kind;
	if (entryKind === "status") throw new Error("private task-memory status cannot be promoted");
	const validatedScope = validateMemoryScopeSelection(selection, {
		runtimeIds: source.runtimeIds ?? [],
		agentIds: source.agentIds ?? [],
	});
	const tally = createRedactionTally();
	const lesson = redactPromotionText(source.entry.content, tally).replace(/\s+/gu, " ").trim();
	const sourceFields = new Set(source.redaction?.sourceFields ?? []);
	if (lesson !== source.entry.content) sourceFields.add("content");
	const replacementCount = (source.redaction?.replacementCount ?? 0) + tally.count;
	const scopeKey = memoryScopeIdentityKey(validatedScope);
	const record: MemoryRecord = {
		id: promotedMemoryId({
			sourceKind: source.kind,
			sessionId: source.sessionId,
			entryId: source.entry.id,
			entryKind,
			evidenceRefs: uniqueStrings(source.evidenceRefs),
			lesson,
			scopeKey,
		}),
		scope: validatedScope.scope,
		key: `promotion:${source.kind}:${source.sessionId}:${source.entry.id}`,
		lesson,
		evidenceRefs: uniqueStrings(source.evidenceRefs),
		appliesWhen: scopeApplicability(validatedScope),
		avoidWhen: [],
		confidence: 0.6,
		createdAt: now.toISOString(),
		approved: false,
		provenance: {
			sourceKind: source.kind,
			sourceSessionId: source.sessionId,
			sourceEntryId: source.entry.id,
			sourceEntryKind: entryKind,
			sourceEntryCreatedAt: source.entry.createdAt,
			sourceEntryLastTouchedAt: source.entry.lastTouchedAt,
			redaction: {
				appliedBeforePersistence: true,
				replacementCount,
				sourceFields: [...sourceFields].sort(compareStrings),
			},
		},
	};
	applyScopeIdentity(record, validatedScope);
	const validated = validateMemoryRecord(record);
	if (!validated.valid) {
		throw new Error(
			`promoted memory record invalid: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
		);
	}
	return validated.record;
}

export function applyScopeIdentity(record: MemoryRecord, selection: MemoryScopeSelection): void {
	if (selection.scope === "repo") record.repository = { ...selection.repository };
	if (selection.scope === "runtime") record.runtime = { ...selection.runtime };
	if (selection.scope === "agent") record.agent = { ...selection.agent };
}

export function memoryScopeIdentityKey(selection: MemoryScopeSelection): string {
	switch (selection.scope) {
		case "repo":
			return `repo:${selection.repository.kind}:${selection.repository.key}`;
		case "global":
			return "global:acknowledged";
		case "runtime":
			return `runtime:${selection.runtime.key}`;
		case "agent":
			return `agent:${selection.agent.key}`;
	}
}

function validatePromotionSource(source: MemoryPromotionSource): void {
	if (!validSourceValue(source.sessionId)) throw new Error("promotion requires a valid source session id");
	if (source.evidenceRefs.length === 0 || source.evidenceRefs.some((value) => !validSourceValue(value))) {
		throw new Error("promotion requires at least one valid source evidence ref");
	}
	if (source.entry.kind === "status") throw new Error("private task-memory status cannot be promoted");
	if (source.entry.kind !== "knowledge" && source.entry.kind !== "procedural") {
		throw new Error("promotion requires a knowledge or procedural task-memory entry");
	}
	if (!validSourceValue(source.entry.id) || source.entry.content.trim().length === 0) {
		throw new Error("promotion requires a valid task-memory entry");
	}
	for (const runtimeId of source.runtimeIds ?? []) memoryRuntimeIdentity(runtimeId);
	for (const agentId of source.agentIds ?? []) memoryAgentIdentity(agentId);
	if (source.redaction !== undefined) {
		if (!Number.isInteger(source.redaction.replacementCount) || source.redaction.replacementCount < 0) {
			throw new Error("promotion source redaction count must be a non-negative integer");
		}
		if (source.redaction.sourceFields.some((field) => !validSourceValue(field))) {
			throw new Error("promotion source redaction fields must be valid non-empty strings");
		}
	}
}

function normalizeNamedIdentity<T extends "runtime" | "agent">(
	identity: { kind: T; key: string },
	kind: T,
): { kind: T; key: string } {
	if (identity.kind !== kind || !validNamedIdentityKey(identity.key)) {
		throw new Error(`${kind} scope requires a valid ${kind} identity`);
	}
	return { kind, key: identity.key };
}

function validNamedIdentityKey(value: string): boolean {
	return value.length > 0 && value.length <= 256 && value.trim() === value && !/[\0\r\n\t ]/u.test(value);
}

function validSourceValue(value: string): boolean {
	return value.length > 0 && value.length <= 1_024 && value.trim() === value && !/[\0\r\n]/u.test(value);
}

function scopeApplicability(selection: MemoryScopeSelection): string[] {
	switch (selection.scope) {
		case "repo":
			return [`repository:${selection.repository.kind}:${selection.repository.key}`];
		case "global":
			return [];
		case "runtime":
			return [`runtime:${selection.runtime.key}`];
		case "agent":
			return [`agent:${selection.agent.key}`];
	}
}

function promotedMemoryId(value: {
	sourceKind: MemoryPromotionSource["kind"];
	sessionId: string;
	entryId: string;
	entryKind: TaskMemoryRenderableClass;
	evidenceRefs: string[];
	lesson: string;
	scopeKey: string;
}): string {
	const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 16);
	return `mem-${digest}`;
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function redactPromotionText(text: string, tally: ReturnType<typeof createRedactionTally>): string {
	const markers: string[] = [];
	const masked = text.replace(/\[redacted:[a-z-]+\]/gu, (marker) => {
		const token = `\uE000${String.fromCharCode(0xe100 + markers.length)}`;
		markers.push(marker);
		return token;
	});
	let redacted = redactSecretsText(masked, tally);
	for (let index = 0; index < markers.length; index += 1) {
		redacted = redacted.replaceAll(`\uE000${String.fromCharCode(0xe100 + index)}`, markers[index] ?? "");
	}
	return redacted;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
