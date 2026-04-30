import { createHash } from "node:crypto";
import type { EvidenceFinding, EvidenceOverview, EvidenceTag } from "../evidence/index.js";
import { inspectEvidence } from "../evidence/index.js";
import { loadMemoryRecords, upsertMemoryRecord } from "./store.js";
import type { MemoryProposalResult, MemoryRecord, MemoryScope } from "./types.js";

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
	"cwd-missing",
	"destructive-cleanup",
	"unknown",
] as const satisfies ReadonlyArray<EvidenceTag>;

export async function proposeMemoryFromEvidence(dataDir: string, evidenceId: string): Promise<MemoryProposalResult> {
	const evidence = await inspectEvidenceForMemory(dataDir, evidenceId);
	const existing = (await loadMemoryRecords(dataDir)).find((record) => record.id === memoryIdFromEvidence(evidenceId));
	if (existing !== undefined) return { record: existing, created: false };

	const record = memoryRecordFromEvidence(evidence.overview, evidence.findings);
	await upsertMemoryRecord(dataDir, record);
	return { record, created: true };
}

export function memoryIdFromEvidence(evidenceId: string): string {
	const digest = createHash("sha256").update(evidenceId, "utf8").digest("hex").slice(0, 16);
	return `mem-${digest}`;
}

export function memoryRecordFromEvidence(
	overview: EvidenceOverview,
	findings: ReadonlyArray<EvidenceFinding>,
): MemoryRecord {
	const tags = overview.tags;
	const primaryTag = primaryEvidenceTag(tags);
	const scope = inferScope(overview);
	const record: MemoryRecord = {
		id: memoryIdFromEvidence(overview.evidenceId),
		scope,
		key: `evidence:${overview.evidenceId}`,
		lesson: truncateText(buildLesson(overview, findings, primaryTag), LESSON_MAX_CHARS),
		evidenceRefs: [overview.evidenceId],
		appliesWhen: appliesWhen(overview),
		avoidWhen: avoidWhen(overview),
		confidence: confidenceForEvidence(overview, findings),
		createdAt: overview.generatedAt,
		approved: false,
	};
	return record;
}

function inferScope(overview: EvidenceOverview): MemoryScope {
	if (overview.source.kind === "eval") return "task-family";
	if (overview.cwds.length > 0) return "repo";
	if (overview.runtimeIds.length > 0) return "runtime";
	if (overview.agentIds.length > 0) return "agent";
	return "global";
}

function primaryEvidenceTag(tags: ReadonlyArray<EvidenceTag>): EvidenceTag | null {
	for (const tag of TAG_PRIORITY) {
		if (tags.includes(tag)) return tag;
	}
	return tags[0] ?? null;
}

function buildLesson(
	overview: EvidenceOverview,
	findings: ReadonlyArray<EvidenceFinding>,
	primaryTag: EvidenceTag | null,
): string {
	const task = overview.tasks[0] ?? "the cited workflow";
	const finding = findings.find((item) => item.severity === "warn") ?? findings[0] ?? null;
	const findingText = finding === null ? "" : ` Finding: ${finding.message}`;
	if (primaryTag === "test-failure") {
		return `Evidence ${overview.evidenceId} shows validation failure around "${task}". Recheck the failing validation path before claiming completion.${findingText}`;
	}
	if (primaryTag === "build-failure") {
		return `Evidence ${overview.evidenceId} shows build failure around "${task}". Rebuild before treating related changes as complete.${findingText}`;
	}
	if (primaryTag === "blocked-tool") {
		return `Evidence ${overview.evidenceId} shows blocked tool activity around "${task}". Adjust the workflow to respect tool and safety policy.${findingText}`;
	}
	if (primaryTag === "protected-artifact") {
		return `Evidence ${overview.evidenceId} includes protected artifacts for "${task}". Preserve validated artifacts unless newer validation supersedes them.${findingText}`;
	}
	if (primaryTag === "timeout") {
		return `Evidence ${overview.evidenceId} shows timeout risk around "${task}". Prefer bounded validation steps and explicit limits.${findingText}`;
	}
	if (primaryTag === "context-overflow") {
		return `Evidence ${overview.evidenceId} shows context pressure around "${task}". Prefer scoped retrieval or compaction over prompt growth.${findingText}`;
	}
	if (primaryTag === "missing-dependency") {
		return `Evidence ${overview.evidenceId} shows a missing dependency around "${task}". Verify local prerequisites before rerunning the workflow.${findingText}`;
	}
	if (primaryTag === "wrong-runtime") {
		return `Evidence ${overview.evidenceId} shows runtime mismatch around "${task}". Confirm the configured runtime and model before dispatch.${findingText}`;
	}
	if (primaryTag === "auth-failure") {
		return `Evidence ${overview.evidenceId} shows auth failure around "${task}". Check target credentials before repeating the workflow.${findingText}`;
	}
	if (primaryTag === "cwd-missing") {
		return `Evidence ${overview.evidenceId} shows missing working-directory state around "${task}". Confirm repo-local cwd paths before running commands.${findingText}`;
	}
	if (primaryTag === "destructive-cleanup") {
		return `Evidence ${overview.evidenceId} shows destructive cleanup risk around "${task}". Keep validated artifacts protected until replacement validation exists.${findingText}`;
	}
	const tagText = overview.tags.length === 0 ? "no failure tags" : `tags ${overview.tags.join(", ")}`;
	return `Evidence ${overview.evidenceId} records ${tagText} for "${task}". Keep this as memory only after human approval.${findingText}`;
}

function appliesWhen(overview: EvidenceOverview): string[] {
	return uniqueStrings([
		`source:${formatSource(overview)}`,
		...overview.tasks.map((task) => `task:${truncateText(task, APPLY_MAX_CHARS)}`),
		...overview.cwds.map((cwd) => `cwd:${truncateText(cwd, APPLY_MAX_CHARS)}`),
		...overview.tags.map((tag) => `tag:${tag}`),
		...overview.runtimeIds.map((runtimeId) => `runtime:${runtimeId}`),
		...overview.modelIds.map((modelId) => `model:${modelId}`),
	]);
}

function avoidWhen(overview: EvidenceOverview): string[] {
	if (overview.cwds.length === 0 && overview.runtimeIds.length === 0 && overview.tags.length === 0) return [];
	return ["current task, repo, runtime, or failure mode differs from cited evidence"];
}

function confidenceForEvidence(overview: EvidenceOverview, findings: ReadonlyArray<EvidenceFinding>): number {
	let value = 0.45;
	if (overview.totals.runs > 0) value += 0.05;
	if (overview.totals.receipts > 0 || overview.source.kind === "eval") value += 0.05;
	if (overview.tags.length > 0) value += 0.05;
	if (findings.some((finding) => finding.severity === "warn")) value += 0.05;
	if (overview.totals.linkedToolEvents > 0 || overview.totals.toolEvents > 0) value += 0.05;
	return Math.min(0.75, Number(value.toFixed(2)));
}

function formatSource(overview: EvidenceOverview): string {
	if (overview.source.kind === "run") return `run:${overview.source.runId}`;
	if (overview.source.kind === "session") return `session:${overview.source.sessionId}`;
	return `eval:${overview.source.evalId}`;
}

async function inspectEvidenceForMemory(
	dataDir: string,
	evidenceId: string,
): Promise<{ overview: EvidenceOverview; findings: EvidenceFinding[] }> {
	try {
		return await inspectEvidence(dataDir, evidenceId);
	} catch (error) {
		if (isErrorWithCode(error) && error.code === "ENOENT") throw new Error(`evidence artifact not found: ${evidenceId}`);
		throw error;
	}
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

function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}
