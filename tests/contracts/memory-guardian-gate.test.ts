import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BackgroundStepDecision, BackgroundStepFacts } from "../../src/domains/memory/background-budget.js";
import { decideBackgroundStep } from "../../src/domains/memory/background-budget.js";
import { evaluateMemoryGate, recordMemoryObservations } from "../../src/domains/memory/guardian-gate.js";
import { approveMemoryRecord, canonicalMemoryRepositoryIdentity } from "../../src/domains/memory/operations.js";
import { proposeMemoryPromotion } from "../../src/domains/memory/promotion.js";
import { selectMemoryForPrompt } from "../../src/domains/memory/prompt-section.js";
import { loadMemoryRecords } from "../../src/domains/memory/store.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { loadTaskBankSnapshot, saveTaskBankSnapshot } from "../../src/domains/memory/task-bank-store.js";
import { resolveEffectivePricing } from "../../src/domains/providers/catalog.js";
import anthropic from "../../src/domains/providers/runtimes/cloud/anthropic.js";

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-memory-gate-"));
	roots.push(root);
	return root;
}

async function propose(dataDir: string, repo: string, kind: "knowledge" | "procedural", sessionId = "s1") {
	const bank = new TaskMemoryBank();
	const entry =
		kind === "knowledge"
			? bank.saveKnowledge("routing runs through placement")
			: bank.saveProcedural("build failed twice");
	const repository = canonicalMemoryRepositoryIdentity(repo);
	if (repository === null) throw new Error("scratch repository has no identity");
	const { record } = await proposeMemoryPromotion(
		dataDir,
		{ kind: "task-bank-entry", sessionId, evidenceRefs: [`session:${sessionId}`], entry },
		{ scope: "repo", repository },
	);
	return { record, repository };
}

describe("memory guardian gate", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("approves a knowledge lesson once a session reports it held, and it reaches the prompt", async () => {
		const dataDir = scratch();
		const { record, repository } = await propose(dataDir, scratch(), "knowledge");
		strictEqual(evaluateMemoryGate(record), "hold");
		const delivered = await recordMemoryObservations(dataDir, [
			{ memoryId: record.id, sessionId: "s1", kind: "delivered" },
		]);
		deepStrictEqual(delivered.approved, []);
		const held = await recordMemoryObservations(dataDir, [{ memoryId: record.id, sessionId: "s1", kind: "held" }]);
		deepStrictEqual(
			held.approved.map((item) => [item.id, item.approval?.by]),
			[[record.id, "guardian"]],
		);
		const selected = selectMemoryForPrompt(await loadMemoryRecords(dataDir), { activeRepository: repository });
		deepStrictEqual(
			selected.map((item) => item.id),
			[record.id],
		);
	});

	it("keeps a procedural proposal pending however many sessions hold, and concurrent observations all persist", async () => {
		const dataDir = scratch();
		const repo = scratch();
		const { record } = await propose(dataDir, repo, "procedural");
		const second = await propose(dataDir, repo, "procedural", "s2");
		// The record id carries the session, so a second session cannot corroborate the first record.
		strictEqual(second.record.id === record.id, false);
		const outcomes = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				recordMemoryObservations(dataDir, [{ memoryId: record.id, sessionId: `s${index}`, kind: "held" }]),
			),
		);
		deepStrictEqual(
			outcomes.flatMap((outcome) => outcome.approved),
			[],
		);
		const stored = (await loadMemoryRecords(dataDir)).find((item) => item.id === record.id);
		strictEqual(stored?.observations?.length, 12);
		strictEqual(stored?.approved, false);
	});

	it("demotes its own approval on a later contradiction and leaves operator decisions alone", async () => {
		const dataDir = scratch();
		const repo = scratch();
		const { record, repository } = await propose(dataDir, repo, "knowledge");
		await recordMemoryObservations(
			dataDir,
			[{ memoryId: record.id, sessionId: "s1", kind: "held" }],
			new Date("2026-10-04T00:00:00Z"),
		);
		const demoted = await recordMemoryObservations(
			dataDir,
			[{ memoryId: record.id, sessionId: "s2", kind: "contradicted" }],
			new Date("2026-10-05T00:00:00Z"),
		);
		deepStrictEqual(
			demoted.demoted.map((item) => item.id),
			[record.id],
		);
		strictEqual(selectMemoryForPrompt(await loadMemoryRecords(dataDir), { activeRepository: repository }).length, 0);

		await approveMemoryRecord(dataDir, record.id, new Date("2026-10-06T00:00:00Z"));
		const after = await recordMemoryObservations(
			dataDir,
			[{ memoryId: record.id, sessionId: "s3", kind: "contradicted" }],
			new Date("2026-10-07T00:00:00Z"),
		);
		deepStrictEqual(after.demoted, []);
		strictEqual((await loadMemoryRecords(dataDir))[0]?.approved, true);
	});

	it("round-trips a parked bank with its entry ids", () => {
		const stateDir = scratch();
		const bank = new TaskMemoryBank();
		bank.updateStatus("mapping the call chain");
		const kept = bank.saveKnowledge("placement.ts picks the target");
		strictEqual(saveTaskBankSnapshot(stateDir, "session-1", bank.snapshot()), true);
		const restored = new TaskMemoryBank();
		const snapshot = loadTaskBankSnapshot(stateDir, "session-1");
		if (snapshot === null) throw new Error("snapshot did not load");
		restored.restore(snapshot);
		deepStrictEqual(restored.snapshot(), bank.snapshot());
		strictEqual(restored.saveKnowledge("a new fact").id === kept.id, false);
		strictEqual(loadTaskBankSnapshot(stateDir, "../escape"), null);
		// A bank emptied by branch navigation retires the older snapshot instead of leaving it to be resumed.
		strictEqual(saveTaskBankSnapshot(stateDir, "session-1", new TaskMemoryBank().snapshot()), false);
		strictEqual(loadTaskBankSnapshot(stateDir, "session-1"), null);
	});

	it("decides a background step from what its route costs", () => {
		const nowMs = Date.parse("2026-10-06T12:00:00.000Z");
		const resetsAt = "2026-10-08T00:00:00.000Z";
		const metered = {
			provenance: "known",
			rates: { input: 3, output: 15 },
			runtime: { auth: "api-key", tier: "cloud" },
			quotaProviderId: null,
		} as const;
		const quota = {
			provenance: "estimated",
			rates: { input: 3, output: 15 },
			runtime: { auth: "oauth", tier: "cloud" },
			quotaProviderId: "codex",
		} as const;
		const local = {
			provenance: "known_free",
			rates: { input: 0, output: 0 },
			runtime: { auth: "api-key", tier: "local-native" },
			quotaProviderId: null,
		} as const;
		const unpriced = {
			provenance: "unknown",
			rates: null,
			runtime: { auth: "api-key", tier: "protocol" },
			quotaProviderId: null,
		} as const;
		const window = (usedPct: number) => ({
			snapshot: {
				providerId: "codex",
				displayName: "Codex",
				status: "ok" as const,
				windows: [{ key: "weekly", label: "Weekly", usedPct, resetsAt }],
				fetchedAt: "2026-10-06T11:58:00.000Z",
			},
			stale: false,
			retryUntil: null,
		});
		// 10k prompt tokens and 2k output: $0.06 at $3/$15 per million, and 10 s
		// prefill plus 40 s generation at 1,000 and 50 tokens per second.
		const base: BackgroundStepFacts = {
			route: metered,
			inputTokens: 10_000,
			maxOutputTokens: 2_000,
			timeoutCapMs: 60_000,
			nowMs,
			session: { spendUsd: 1, ceilingUsd: 5 },
			quota: null,
			endpoint: { occupied: 0, admissionLimit: 1, prefillTokensPerSecond: null, generationTokensPerSecond: null },
		};
		const measured = { occupied: 0, admissionLimit: 1, prefillTokensPerSecond: 1_000 };
		const haiku = {
			...metered,
			...resolveEffectivePricing({ id: "api", runtime: "anthropic" }, anthropic, "claude-haiku-5-5"),
		};
		const cases: ReadonlyArray<[string, Partial<BackgroundStepFacts>, BackgroundStepDecision]> = [
			["metered under the ceiling", {}, { admit: true, kind: "metered", timeoutMs: 60_000 }],
			[
				"metered whose projected cost reaches the ceiling",
				{ session: { spendUsd: 4.95, ceilingUsd: 5 } },
				{ admit: false, kind: "metered", reason: "cost_ceiling" },
			],
			[
				"metered with no ceiling",
				{ session: { spendUsd: 400, ceilingUsd: 0 } },
				{ admit: true, kind: "metered", timeoutMs: 60_000 },
			],
			["quota below warning", { route: quota, quota: window(79) }, { admit: true, kind: "quota", timeoutMs: 60_000 }],
			[
				"catalog prompt at the tier threshold",
				{ route: haiku, inputTokens: 100_000, session: { spendUsd: 1, ceilingUsd: 1.02 } },
				{ admit: true, kind: "metered", timeoutMs: 60_000 },
			],
			[
				"catalog prompt above the tier threshold",
				{ route: haiku, inputTokens: 100_001, session: { spendUsd: 1, ceilingUsd: 1.02 } },
				{ admit: false, kind: "metered", reason: "cost_ceiling" },
			],
			[
				"quota at warning",
				{ route: quota, quota: window(80) },
				{ admit: false, kind: "quota", reason: "quota_window", resumeAt: resetsAt },
			],
			[
				"quota in a 429 retry window",
				{ route: quota, quota: { ...window(10), retryUntil: "2026-10-06T12:05:00.000Z" } },
				{ admit: false, kind: "quota", reason: "quota_retry", resumeAt: "2026-10-06T12:05:00.000Z" },
			],
			[
				"quota with a stale reading",
				{ route: quota, quota: { ...window(99), stale: true } },
				{ admit: true, kind: "quota", timeoutMs: 60_000 },
			],
			["local without a measurement", { route: local }, { admit: true, kind: "local", timeoutMs: 60_000 }],
			[
				"local with a measurement",
				{ route: local, endpoint: { ...measured, generationTokensPerSecond: 50 } },
				{ admit: true, kind: "local", timeoutMs: 50_000 },
			],
			[
				"local too slow to finish inside the cap",
				{ route: local, endpoint: { ...measured, generationTokensPerSecond: 20 } },
				{ admit: false, kind: "local", reason: "time_budget" },
			],
			[
				"local endpoint with no free slot",
				{ route: local, endpoint: { ...measured, occupied: 1, generationTokensPerSecond: 50 } },
				{ admit: false, kind: "local", reason: "endpoint_busy" },
			],
			[
				"unpriced proxy",
				{ route: unpriced, session: { spendUsd: 400, ceilingUsd: 5 } },
				{ admit: true, kind: "unpriced", timeoutMs: 60_000 },
			],
		];
		for (const [label, facts, expected] of cases) {
			deepStrictEqual(decideBackgroundStep({ ...base, ...facts }), expected, label);
		}
	});
});
