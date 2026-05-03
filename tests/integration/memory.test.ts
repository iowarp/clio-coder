import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { EvidenceFinding, EvidenceOverview } from "../../src/domains/evidence/index.js";
import {
	approveMemoryRecord,
	loadMemoryRecords,
	type MemoryRecord,
	memoryIdFromEvidence,
	memoryRoot,
	memoryStatus,
	memoryStorePath,
	proposeMemoryFromEvidence,
	pruneStaleMemory,
	rejectMemoryRecord,
	selectApprovedMemory,
	validateMemoryRecord,
	writeMemoryRecords,
} from "../../src/domains/memory/index.js";

describe("memory domain", () => {
	let scratch: string;
	let dataDir: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-memory-"));
		dataDir = join(scratch, "data");
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("validates memory records with scoped, evidence-linked fields", () => {
		const valid = validateMemoryRecord(memoryRecord(), "$");
		strictEqual(valid.valid, true);

		const invalid = validateMemoryRecord(
			{
				...memoryRecord(),
				id: "bad",
				scope: "everything",
				evidenceRefs: [],
				confidence: 2,
				extra: true,
			},
			"$",
		);
		strictEqual(invalid.valid, false);
		if (invalid.valid) throw new Error("expected invalid memory record");
		const issues = invalid.issues.map((issue) => `${issue.path}: ${issue.message}`);
		ok(issues.includes("$.extra: unknown field"));
		ok(issues.includes("$.id: expected mem- followed by 16 lowercase hex characters"));
		ok(issues.includes("$.scope: expected memory scope"));
		ok(issues.includes("$.evidenceRefs: expected at least one evidence ref"));
		ok(issues.includes("$.confidence: expected number between 0 and 1"));
	});

	it("persists records under the local memory store with deterministic ordering", async () => {
		const second = memoryRecord({
			id: memoryIdFromEvidence("run-b"),
			scope: "repo",
			key: "evidence:run-b",
			createdAt: "2026-04-29T00:00:02.000Z",
			evidenceRefs: ["run-b"],
		});
		const first = memoryRecord({
			id: memoryIdFromEvidence("run-a"),
			scope: "global",
			key: "evidence:run-a",
			createdAt: "2026-04-29T00:00:01.000Z",
			evidenceRefs: ["run-a"],
		});

		await writeMemoryRecords(dataDir, [second, first]);

		ok(existsSync(memoryStorePath(dataDir)));
		ok(existsSync(memoryRoot(dataDir)));
		deepStrictEqual(
			(await loadMemoryRecords(dataDir)).map((record) => record.id),
			[first.id, second.id],
		);
		const raw = readFileSync(memoryStorePath(dataDir), "utf8");
		match(raw, /"version": 1/);
	});

	it("proposes deterministic memory from evidence metadata without changing existing state", async () => {
		writeEvidenceArtifact(dataDir, evidenceOverview("run-evidence"), [
			{
				id: "finding-001",
				severity: "warn",
				tag: "test-failure",
				runId: "run-1",
				message: "run exited with code 1",
			},
		]);

		const first = await proposeMemoryFromEvidence(dataDir, "run-evidence");
		const second = await proposeMemoryFromEvidence(dataDir, "run-evidence");

		strictEqual(first.created, true);
		strictEqual(second.created, false);
		strictEqual(first.record.id, memoryIdFromEvidence("run-evidence"));
		strictEqual(first.record.id, second.record.id);
		strictEqual(first.record.scope, "repo");
		strictEqual(first.record.approved, false);
		deepStrictEqual(first.record.evidenceRefs, ["run-evidence"]);
		ok(first.record.lesson.includes("validation failure"));
		deepStrictEqual(
			(await loadMemoryRecords(dataDir)).map((record) => record.id),
			[first.record.id],
		);
	});

	it("reports missing evidence and memory ids clearly", async () => {
		await rejects(
			proposeMemoryFromEvidence(dataDir, "missing-evidence"),
			/evidence artifact not found: missing-evidence/,
		);
		await rejects(approveMemoryRecord(dataDir, "mem-0000000000000000"), /memory record not found: mem-0000000000000000/);
	});

	it("applies approve and reject transitions deterministically", async () => {
		const record = memoryRecord({ id: memoryIdFromEvidence("run-transition"), evidenceRefs: ["run-transition"] });
		await writeMemoryRecords(dataDir, [record]);

		const approved = await approveMemoryRecord(dataDir, record.id, new Date("2026-04-29T00:05:00.000Z"));
		strictEqual(approved.approved, true);
		strictEqual(approved.lastVerifiedAt, "2026-04-29T00:05:00.000Z");
		strictEqual(memoryStatus(approved), "approved");

		const rejected = await rejectMemoryRecord(dataDir, record.id, new Date("2026-04-29T00:06:00.000Z"));
		strictEqual(rejected.approved, false);
		strictEqual(rejected.rejectedAt, "2026-04-29T00:06:00.000Z");
		strictEqual(memoryStatus(rejected), "rejected");
	});

	it("prunes stale records while keeping fresh memory", async () => {
		const oldProposal = memoryRecord({
			id: memoryIdFromEvidence("old-proposal"),
			key: "evidence:old-proposal",
			evidenceRefs: ["old-proposal"],
			createdAt: "2026-03-01T00:00:00.000Z",
		});
		const oldApproved = memoryRecord({
			id: memoryIdFromEvidence("old-approved"),
			key: "evidence:old-approved",
			evidenceRefs: ["old-approved"],
			createdAt: "2025-01-01T00:00:00.000Z",
			lastVerifiedAt: "2025-10-01T00:00:00.000Z",
			approved: true,
		});
		const fresh = memoryRecord({
			id: memoryIdFromEvidence("fresh"),
			key: "evidence:fresh",
			evidenceRefs: ["fresh"],
			createdAt: "2026-04-20T00:00:00.000Z",
		});
		await writeMemoryRecords(dataDir, [fresh, oldApproved, oldProposal]);

		const pruned = await pruneStaleMemory(dataDir, new Date("2026-04-29T00:00:00.000Z"));

		deepStrictEqual(pruned.map((record) => record.id).sort(), [oldApproved.id, oldProposal.id].sort());
		deepStrictEqual(
			(await loadMemoryRecords(dataDir)).map((record) => record.id),
			[fresh.id],
		);
	});

	it("retrieves only approved, non-regressed memory under a token budget", () => {
		const approved = memoryRecord({
			id: memoryIdFromEvidence("approved"),
			evidenceRefs: ["approved"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:00:00.000Z",
			lesson: "Use the repo-local verifier before completion.",
		});
		const regressed = memoryRecord({
			id: memoryIdFromEvidence("regressed"),
			evidenceRefs: ["regressed"],
			approved: true,
			lastVerifiedAt: "2026-04-29T00:01:00.000Z",
			regressions: ["eval-regression"],
		});
		const proposed = memoryRecord({
			id: memoryIdFromEvidence("proposed"),
			evidenceRefs: ["proposed"],
			approved: false,
		});

		deepStrictEqual(selectApprovedMemory([approved, regressed, proposed], { tokenBudget: 1000 }), [approved]);
		deepStrictEqual(selectApprovedMemory([approved], { tokenBudget: 1 }), []);
	});
});

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id: memoryIdFromEvidence("default"),
		scope: "repo",
		key: "evidence:default",
		lesson: "Use cited evidence before preserving this workflow lesson.",
		evidenceRefs: ["default"],
		appliesWhen: ["cwd:/repo", "tag:test-failure"],
		avoidWhen: [],
		confidence: 0.6,
		createdAt: "2026-04-29T00:00:00.000Z",
		approved: false,
		...overrides,
	};
}

function evidenceOverview(evidenceId: string): EvidenceOverview {
	return {
		version: 1,
		evidenceId,
		source: { kind: "run", runId: "run-1" },
		generatedAt: "2026-04-29T00:00:00.000Z",
		runIds: ["run-1"],
		sessionId: "session-1",
		statuses: ["failed"],
		startedAt: "2026-04-29T00:00:00.000Z",
		endedAt: "2026-04-29T00:00:01.000Z",
		tasks: ["npm test fails"],
		cwds: ["/repo"],
		agentIds: ["scout"],
		endpointIds: ["local"],
		runtimeIds: ["openai"],
		modelIds: ["model-a"],
		totals: {
			runs: 1,
			receipts: 1,
			toolCalls: 1,
			toolErrors: 1,
			blockedToolCalls: 0,
			sessionEntries: 0,
			auditRows: 0,
			toolEvents: 1,
			linkedToolEvents: 0,
			protectedArtifacts: 0,
			tokens: 0,
			costUsd: 0,
			wallTimeMs: 1000,
		},
		tags: ["test-failure"],
		files: ["overview.json", "findings.json"],
	};
}

function writeEvidenceArtifact(
	dataDir: string,
	overview: EvidenceOverview,
	findings: ReadonlyArray<EvidenceFinding>,
): void {
	const dir = join(dataDir, "evidence", overview.evidenceId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "overview.json"), `${JSON.stringify(overview, null, 2)}\n`, "utf8");
	writeFileSync(
		join(dir, "findings.json"),
		`${JSON.stringify({ version: 1, evidenceId: overview.evidenceId, findings }, null, 2)}\n`,
		"utf8",
	);
}
