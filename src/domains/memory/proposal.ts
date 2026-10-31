import { createHash } from "node:crypto";
import type { EvidenceTag, RunEvidence } from "../evidence/index.js";
import { inspectRunEvidence } from "../evidence/index.js";
import { canonicalMemoryRepositoryIdentity } from "./operations.js";
import {
	applyScopeIdentity,
	type MemoryScopeSelection,
	memoryScopeIdentityKey,
	validateMemoryScopeSelection,
} from "./promotion.js";
import { insertMemoryRecordIfAbsent } from "./store.js";
import type { MemoryProposalResult, MemoryRecord } from "./types.js";
import { validateMemoryRecord } from "./validate.js";

const LESSON_MAX_CHARS = 240;
const APPLY_MAX_CHARS = 160;

const TAG_PRIORITY = [
	"test-failure",
	"build-failure",
	"blocked-tool",
	"protected-artifact",
	"timeout",
	"context-overflow",
	"missing-dependency",
	"wrong-runtime",
	"auth-failure",
	"destructive-cleanup",
	"unknown",
] as const satisfies ReadonlyArray<EvidenceTag>;

/**
 * What the run ledger says of the run it proposes from: its task and workspace. They scope and word the lesson only;
 * every claim the lesson makes comes from the run's sealed evidence (#434).
 */
export interface EvidenceRunContext {
	task: string | null;
	cwd: string | null;
}

export async function proposeMemoryFromEvidence(
	dataDir: string,
	stateDir: string,
	runId: string,
	context: EvidenceRunContext,
	selection?: MemoryScopeSelection,
): Promise<MemoryProposalResult> {
	const evidence = await inspectRunEvidence(stateDir, runId);
	if (evidence.assessedAt === null)
		throw new Error(
			`run ${runId} has no sealed assessment to propose from: ${evidence.integrity.state === "verified" ? "not assessed" : evidence.integrity.reason}`,
		);
	return insertMemoryRecordIfAbsent(dataDir, memoryRecordFromEvidence(evidence, context, selection));
}

export function memoryIdFromEvidence(runId: string): string {
	const digest = createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 16);
	return `mem-${digest}`;
}

export function memoryRecordFromEvidence(
	evidence: RunEvidence,
	context: EvidenceRunContext,
	selection?: MemoryScopeSelection,
): MemoryRecord {
	const tags = evidence.tags;
	const primaryTag = primaryEvidenceTag(tags);
	const repository = context.cwd === null ? null : canonicalMemoryRepositoryIdentity(context.cwd);
	const runtimeIds = evidence.settled ? [evidence.settled.runtimeId] : [];
	const agentIds = evidence.settled ? [evidence.settled.agentId] : [];
	const validatedSelection =
		selection === undefined ? undefined : validateMemoryScopeSelection(selection, { runtimeIds, agentIds });
	const scope =
		validatedSelection?.scope ??
		(repository !== null ? "repo" : runtimeIds.length > 0 ? "runtime" : agentIds.length > 0 ? "agent" : "global");
	const record: MemoryRecord = {
		id:
			validatedSelection === undefined
				? memoryIdFromEvidence(evidence.runId)
				: memoryIdFromEvidenceScope(evidence.runId, memoryScopeIdentityKey(validatedSelection)),
		scope,
		key: `evidence:${evidence.runId}`,
		lesson: truncateText(buildLesson(evidence, context, primaryTag), LESSON_MAX_CHARS),
		evidenceRefs: [evidence.runId],
		appliesWhen: appliesWhen(evidence, context),
		avoidWhen:
			context.cwd === null && runtimeIds.length === 0 && tags.length === 0
				? []
				: ["current task, repo, runtime, or failure mode differs from cited evidence"],
		confidence: confidenceForEvidence(evidence),
		createdAt: evidence.assessedAt ?? evidence.settled?.at ?? new Date(0).toISOString(),
		approved: false,
		provenance: {
			sourceKind: "evidence",
			evidenceId: evidence.runId,
			...(evidence.sessionId === null ? {} : { sourceSessionId: evidence.sessionId }),
		},
	};
	if (validatedSelection !== undefined) applyScopeIdentity(record, validatedSelection);
	else if (scope === "repo" && repository !== null) record.repository = repository;
	else if (scope === "runtime" && runtimeIds[0] !== undefined) record.runtime = { kind: "runtime", key: runtimeIds[0] };
	else if (scope === "agent" && agentIds[0] !== undefined) record.agent = { kind: "agent", key: agentIds[0] };
	const validated = validateMemoryRecord(record);
	if (!validated.valid) {
		throw new Error(
			`evidence memory record invalid: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
		);
	}
	return validated.record;
}

function memoryIdFromEvidenceScope(evidenceId: string, scopeKey: string): string {
	const digest = createHash("sha256").update(`${evidenceId}\n${scopeKey}`, "utf8").digest("hex").slice(0, 16);
	return `mem-${digest}`;
}

function primaryEvidenceTag(tags: ReadonlyArray<EvidenceTag>): EvidenceTag | null {
	for (const tag of TAG_PRIORITY) {
		if (tags.includes(tag)) return tag;
	}
	return tags[0] ?? null;
}

function buildLesson(evidence: RunEvidence, context: EvidenceRunContext, primaryTag: EvidenceTag | null): string {
	const task = context.task ?? "the cited workflow";
	const findings = evidence.findings;
	const finding = findings.find((item) => item.severity === "warn") ?? findings[0] ?? null;
	const findingText = finding === null ? "" : ` Finding: ${finding.message}`;
	if (primaryTag === "test-failure") {
		return `Evidence ${evidence.runId} shows validation failure around "${task}". Recheck the failing validation path before claiming completion.${findingText}`;
	}
	if (primaryTag === "build-failure") {
		return `Evidence ${evidence.runId} shows build failure around "${task}". Rebuild before treating related changes as complete.${findingText}`;
	}
	if (primaryTag === "blocked-tool") {
		return `Evidence ${evidence.runId} shows blocked tool activity around "${task}". Adjust the workflow to respect tool and safety policy.${findingText}`;
	}
	if (primaryTag === "protected-artifact") {
		return `Evidence ${evidence.runId} includes protected artifacts for "${task}". Preserve validated artifacts unless newer validation supersedes them.${findingText}`;
	}
	if (primaryTag === "timeout") {
		return `Evidence ${evidence.runId} shows timeout risk around "${task}". Prefer bounded validation steps and explicit limits.${findingText}`;
	}
	if (primaryTag === "context-overflow") {
		return `Evidence ${evidence.runId} shows context pressure around "${task}". Prefer scoped retrieval or compaction over prompt growth.${findingText}`;
	}
	if (primaryTag === "missing-dependency") {
		return `Evidence ${evidence.runId} shows a missing dependency around "${task}". Verify local prerequisites before rerunning the workflow.${findingText}`;
	}
	if (primaryTag === "wrong-runtime") {
		return `Evidence ${evidence.runId} shows runtime mismatch around "${task}". Confirm the configured runtime and model before dispatch.${findingText}`;
	}
	if (primaryTag === "auth-failure") {
		return `Evidence ${evidence.runId} shows auth failure around "${task}". Check target credentials before repeating the workflow.${findingText}`;
	}
	if (primaryTag === "destructive-cleanup") {
		return `Evidence ${evidence.runId} shows destructive cleanup risk around "${task}". Keep validated artifacts protected until replacement validation exists.${findingText}`;
	}
	const tagText = evidence.tags.length === 0 ? "no failure tags" : `tags ${evidence.tags.join(", ")}`;
	return `Evidence ${evidence.runId} records ${tagText} for "${task}". Keep this as memory only after human approval.${findingText}`;
}

function appliesWhen(evidence: RunEvidence, context: EvidenceRunContext): string[] {
	return uniqueStrings([
		`source:run:${evidence.runId}`,
		...(context.task === null ? [] : [`task:${truncateText(context.task, APPLY_MAX_CHARS)}`]),
		...(context.cwd === null ? [] : [`cwd:${truncateText(context.cwd, APPLY_MAX_CHARS)}`]),
		...evidence.tags.map((tag) => `tag:${tag}`),
		...(evidence.settled ? [`runtime:${evidence.settled.runtimeId}`, `model:${evidence.settled.wireModelId}`] : []),
	]);
}

function confidenceForEvidence(evidence: RunEvidence): number {
	let value = 0.55;
	if (evidence.tags.length > 0) value += 0.05;
	if (evidence.findings.some((finding) => finding.severity === "warn")) value += 0.05;
	if ((evidence.totals?.toolCalls ?? 0) > 0) value += 0.05;
	return Math.min(0.75, Number(value.toFixed(2)));
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	if (maxChars <= 3) return value.slice(0, maxChars);
	return `${value.slice(0, maxChars - 3)}...`;
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
	return [...new Set(values.filter((value) => value.length > 0))].sort(compareStrings);
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}
