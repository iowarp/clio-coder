import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { EvidenceOverview } from "../../src/domains/evidence/types.js";
import type {
	MemoryPromotionSource,
	MemoryRecord,
	MemoryRepositoryIdentity,
	ReviewedTaskMemoryHandoffSnapshot,
} from "../../src/domains/memory/index.js";
import {
	approveMemoryRecord,
	buildMemoryPromptSection,
	canonicalMemoryRepositoryIdentity,
	loadMemoryRecords,
	memoryAgentIdentity,
	memoryRecordFromEvidence,
	memoryRecordFromPromotion,
	memoryRuntimeIdentity,
	memoryStorePath,
	parseTaskMemoryHandoffSnapshot,
	proposeMemoryPromotion,
	renderTaskMemoryHandoffSnapshot,
	selectApprovedMemory,
	TaskMemoryBank,
	taskMemoryHandoffSnapshot,
	validateMemoryRecord,
	validateMemoryScopeSelection,
} from "../../src/domains/memory/index.js";

const scratchRoots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-memory-promotion-"));
	scratchRoots.push(root);
	return root;
}

function repository(path: string): MemoryRepositoryIdentity {
	mkdirSync(path, { recursive: true });
	const identity = canonicalMemoryRepositoryIdentity(path);
	if (identity === null) throw new Error(`could not canonicalize ${path}`);
	return identity;
}

function source(
	entry: MemoryPromotionSource["entry"],
	overrides: Partial<MemoryPromotionSource> = {},
): MemoryPromotionSource {
	return {
		kind: "task-bank-entry",
		sessionId: "session-origin",
		evidenceRefs: ["session-session-origin", "run-source"],
		entry,
		runtimeIds: ["openai"],
		agentIds: ["coder"],
		...overrides,
	};
}

function approved(record: MemoryRecord): MemoryRecord {
	return { ...record, approved: true, lastVerifiedAt: "2026-08-23T12:00:00.000Z" };
}

function overview(cwd: string): EvidenceOverview {
	return {
		version: 1,
		evidenceId: "run-origin",
		source: { kind: "run", runId: "origin" },
		generatedAt: "2026-08-23T10:00:00.000Z",
		runIds: ["origin"],
		sessionId: "session-origin",
		statuses: ["succeeded"],
		startedAt: "2026-08-23T09:00:00.000Z",
		endedAt: "2026-08-23T10:00:00.000Z",
		tasks: ["Remember the reviewed lesson."],
		cwds: [cwd],
		agentIds: ["coder"],
		targetIds: ["local"],
		runtimeIds: ["openai"],
		modelIds: ["fixture"],
		totals: {
			runs: 1,
			receipts: 1,
			toolCalls: 1,
			toolErrors: 0,
			blockedToolCalls: 0,
			sessionEntries: 2,
			auditRows: 1,
			toolEvents: 1,
			linkedToolEvents: 1,
			protectedArtifacts: 0,
			tokens: 100,
			costUsd: 0,
			wallTimeMs: 1_000,
		},
		tags: [],
		files: ["overview.json"],
	};
}

describe("contracts/reviewed memory promotion", () => {
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("redacts before persistence, preserves provenance, and waits for approval", async () => {
		const root = scratch();
		const dataDir = join(root, "data");
		const repoA = repository(join(root, "repo-a"));
		const bank = new TaskMemoryBank({ now: () => new Date("2026-08-23T09:00:00.000Z") });
		const entry = bank.saveKnowledge("Use api_key=super-secret-value only in the isolated fixture.");

		const result = await proposeMemoryPromotion(
			dataDir,
			source(entry),
			{ scope: "repo", repository: repoA },
			new Date("2026-08-23T11:00:00.000Z"),
		);
		strictEqual(result.created, true);
		strictEqual(result.record.approved, false);
		strictEqual(result.record.scope, "repo");
		deepStrictEqual(result.record.repository, repoA);
		deepStrictEqual(result.record.evidenceRefs, ["run-source", "session-session-origin"]);
		strictEqual(result.record.provenance?.sourceSessionId, "session-origin");
		strictEqual(result.record.provenance?.sourceEntryId, entry.id);
		strictEqual(result.record.provenance?.sourceEntryKind, "knowledge");
		strictEqual(result.record.provenance?.redaction?.appliedBeforePersistence, true);
		strictEqual(result.record.provenance?.redaction?.replacementCount, 1);
		deepStrictEqual(result.record.provenance?.redaction?.sourceFields, ["content"]);
		ok(result.record.lesson.includes("[redacted:assignment]"));

		const persisted = readFileSync(memoryStorePath(dataDir), "utf8");
		strictEqual(persisted.includes("super-secret-value"), false);
		strictEqual(
			buildMemoryPromptSection(await loadMemoryRecords(dataDir), { activeRepository: repoA }).records.length,
			0,
			"a proposal is not injected before approval",
		);

		await approveMemoryRecord(dataDir, result.record.id, new Date("2026-08-23T12:00:00.000Z"));
		const freshRecords = await loadMemoryRecords(dataDir);
		strictEqual(freshRecords[0]?.provenance?.sourceSessionId, "session-origin", "approval preserves provenance");
		strictEqual(freshRecords[0]?.provenance?.redaction?.replacementCount, 1, "approval preserves redaction facts");
	});

	it("injects promoted records in fresh sessions only at exact repository paths", async () => {
		const root = scratch();
		const dataDir = join(root, "data");
		const repoA = repository(join(root, "repo-a"));
		const repoB = repository(join(root, "repo-b"));
		const repoASubdirectory = repository(join(root, "repo-a", "nested"));
		const bank = new TaskMemoryBank({ now: () => new Date("2026-08-23T09:00:00.000Z") });
		const proposal = await proposeMemoryPromotion(
			dataDir,
			source(bank.saveProcedural("Run the focused contract first.")),
			{
				scope: "repo",
				repository: repoA,
			},
		);
		await approveMemoryRecord(dataDir, proposal.record.id);

		const freshSessionA = buildMemoryPromptSection(await loadMemoryRecords(dataDir), {
			activeRepository: repoA,
			tokenBudget: 10_000,
		});
		const freshSessionB = buildMemoryPromptSection(await loadMemoryRecords(dataDir), {
			activeRepository: repoB,
			tokenBudget: 10_000,
		});
		const freshNestedSession = buildMemoryPromptSection(await loadMemoryRecords(dataDir), {
			activeRepository: repoASubdirectory,
			tokenBudget: 10_000,
		});
		deepStrictEqual(
			freshSessionA.records.map((record) => record.id),
			[proposal.record.id],
		);
		strictEqual(freshSessionA.section.includes("Run the focused contract first."), true);
		deepStrictEqual(freshSessionB.records, []);
		deepStrictEqual(freshNestedSession.records, []);
	});

	it("requires explicit valid scope identities and never promotes private status", () => {
		const root = scratch();
		const repo = repository(join(root, "repo"));
		const bank = new TaskMemoryBank({ now: () => new Date("2026-08-23T09:00:00.000Z") });
		const knowledge = bank.saveKnowledge("Keep the exact identity.");
		const status = bank.updateStatus("PRIVATE STATUS SENTINEL");
		const promotionSource = source(knowledge);

		deepStrictEqual(validateMemoryScopeSelection({ scope: "repo", repository: repo }, promotionSource), {
			scope: "repo",
			repository: repo,
		});
		throws(
			() =>
				validateMemoryScopeSelection(
					{ scope: "global", acknowledgeGlobal: false } as unknown as Parameters<typeof validateMemoryScopeSelection>[0],
					promotionSource,
				),
			/global scope requires a separate operator acknowledgement/u,
		);
		throws(
			() =>
				validateMemoryScopeSelection(
					{ scope: "repo", repository: { kind: "canonical-path", key: `${repo.key}/../repo` } },
					promotionSource,
				),
			/canonical absolute repository identity/u,
		);
		throws(
			() => memoryRecordFromPromotion(source(status), { scope: "repo", repository: repo }),
			/private task-memory status cannot be promoted/u,
		);
		throws(() => memoryRuntimeIdentity(""), /runtime scope requires a valid runtime identity/u);
		throws(() => memoryAgentIdentity("agent with spaces"), /agent scope requires a valid agent identity/u);
	});

	it("matches runtime and agent identities for validation, filtering, and injection", () => {
		const bank = new TaskMemoryBank({ now: () => new Date("2026-08-23T09:00:00.000Z") });
		const entry = bank.saveProcedural("Use the matching runtime and agent only.");
		const promotionSource = source(entry);
		const runtimeRecord = approved(
			memoryRecordFromPromotion(promotionSource, { scope: "runtime", runtime: memoryRuntimeIdentity("openai") }),
		);
		const agentRecord = approved(
			memoryRecordFromPromotion(promotionSource, { scope: "agent", agent: memoryAgentIdentity("coder") }),
		);

		throws(
			() =>
				memoryRecordFromPromotion(promotionSource, {
					scope: "runtime",
					runtime: memoryRuntimeIdentity("anthropic"),
				}),
			/does not match the promotion source/u,
		);
		throws(
			() =>
				memoryRecordFromPromotion(promotionSource, {
					scope: "agent",
					agent: memoryAgentIdentity("tester"),
				}),
			/does not match the promotion source/u,
		);

		deepStrictEqual(
			selectApprovedMemory([runtimeRecord, agentRecord], {
				scopes: ["runtime", "agent"],
				tokenBudget: 10_000,
				activeRuntime: memoryRuntimeIdentity("openai"),
				activeAgent: memoryAgentIdentity("coder"),
			})
				.map((record) => record.id)
				.sort(),
			[runtimeRecord.id, agentRecord.id].sort(),
		);
		deepStrictEqual(
			selectApprovedMemory([runtimeRecord, agentRecord], {
				scopes: ["runtime", "agent"],
				tokenBudget: 10_000,
				activeRuntime: memoryRuntimeIdentity("anthropic"),
				activeAgent: memoryAgentIdentity("tester"),
			}),
			[],
		);

		const built = buildMemoryPromptSection([runtimeRecord, agentRecord], {
			scopes: ["runtime", "agent"],
			tokenBudget: 10_000,
			activeRuntime: memoryRuntimeIdentity("openai"),
			activeAgent: memoryAgentIdentity("coder"),
		});
		ok(built.section.includes('runtime="openai"'));
		ok(built.section.includes('agent="coder"'));
		ok(validateMemoryRecord(runtimeRecord).valid);
		ok(validateMemoryRecord(agentRecord).valid);
		ok(!validateMemoryRecord({ ...runtimeRecord, runtime: undefined }).valid);
		ok(!validateMemoryRecord({ ...agentRecord, agent: undefined }).valid);
	});

	it("keeps evidence inference by default and applies only reviewed overrides", () => {
		const root = scratch();
		const repoA = repository(join(root, "repo-a"));
		const repoB = repository(join(root, "repo-b"));
		const evidence = overview(repoA.key);
		const inferred = memoryRecordFromEvidence(evidence, []);
		strictEqual(inferred.scope, "repo");
		deepStrictEqual(inferred.repository, repoA);
		strictEqual(inferred.provenance?.sourceSessionId, "session-origin");

		const rescoped = memoryRecordFromEvidence(evidence, [], { scope: "repo", repository: repoB });
		strictEqual(rescoped.scope, "repo");
		deepStrictEqual(rescoped.repository, repoB);
		ok(rescoped.id !== inferred.id);
		const global = memoryRecordFromEvidence(evidence, [], { scope: "global", acknowledgeGlobal: true });
		strictEqual(global.scope, "global");
		strictEqual(global.repository, undefined);
		const runtime = memoryRecordFromEvidence(evidence, [], {
			scope: "runtime",
			runtime: memoryRuntimeIdentity("openai"),
		});
		deepStrictEqual(runtime.runtime, memoryRuntimeIdentity("openai"));
		throws(
			() =>
				memoryRecordFromEvidence(evidence, [], {
					scope: "agent",
					agent: memoryAgentIdentity("tester"),
				}),
			/does not match the promotion source/u,
		);
		throws(
			() => memoryRecordFromEvidence({ ...evidence, cwds: [], runtimeIds: ["invalid runtime"] }, []),
			/evidence memory record invalid/u,
		);
	});

	it("carries handoff redaction facts into the durable proposal", () => {
		const bank = new TaskMemoryBank({ now: () => new Date("2026-08-23T09:00:00.000Z") });
		bank.saveKnowledge("Use token=super-secret-value for the fixture.");
		const rendered = renderTaskMemoryHandoffSnapshot(
			taskMemoryHandoffSnapshot(bank.snapshot(), {
				sessionId: "session-handoff",
				evidenceRefs: ["session-session-handoff"],
				runtimeIds: ["openai"],
				agentIds: ["coder"],
			}),
		);
		strictEqual(rendered.includes("super-secret-value"), false);
		const parsed = parseTaskMemoryHandoffSnapshot(rendered);
		ok(parsed !== null && parsed.version === 2);
		const reviewed = parsed as ReviewedTaskMemoryHandoffSnapshot;
		strictEqual(reviewed.redaction.replacementCount, 1);
		const entry = reviewed.knowledge[0];
		if (!entry?.createdAt || !entry.lastTouchedAt) throw new Error("reviewed handoff entry missing");
		const record = memoryRecordFromPromotion(
			{
				kind: "handoff-snapshot",
				sessionId: reviewed.source.sessionId,
				evidenceRefs: reviewed.source.evidenceRefs,
				runtimeIds: reviewed.source.runtimeIds,
				agentIds: reviewed.source.agentIds,
				redaction: reviewed.redaction,
				entry: { ...entry, kind: "knowledge", createdAt: entry.createdAt, lastTouchedAt: entry.lastTouchedAt },
			},
			{ scope: "global", acknowledgeGlobal: true },
		);
		strictEqual(record.provenance?.sourceKind, "handoff-snapshot");
		strictEqual(record.provenance?.redaction?.replacementCount, 1);
		deepStrictEqual(record.provenance?.redaction?.sourceFields, ["knowledge[0].content"]);
	});
});
