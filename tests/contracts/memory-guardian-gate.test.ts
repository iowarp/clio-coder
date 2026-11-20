import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BackgroundStepDecision, BackgroundStepFacts } from "../../src/domains/memory/background-budget.js";
import { decideBackgroundStep } from "../../src/domains/memory/background-budget.js";
import { commandEvidenceRef, commandSegment } from "../../src/domains/memory/command-evidence.js";
import {
	type ClaimReceipt,
	claimDemonstration,
	evaluateMemoryGate,
	memorySubjectIndex,
	recordClaimSession,
	recordMemoryObservations,
} from "../../src/domains/memory/guardian-gate.js";
import { approveMemoryRecord, canonicalMemoryRepositoryIdentity } from "../../src/domains/memory/operations.js";
import { claimCommand, claimPathRefusal, proposeMemoryPromotion } from "../../src/domains/memory/promotion.js";
import { selectMemoryForPrompt } from "../../src/domains/memory/prompt-section.js";
import { insertMemoryRecordIfAbsent, loadMemoryRecords } from "../../src/domains/memory/store.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { proposeInjectedTaskMemory } from "../../src/domains/memory/task-bank-promotion.js";
import { loadTaskBankSnapshot, saveTaskBankSnapshot } from "../../src/domains/memory/task-bank-store.js";
import type { MemoryClaim, MemoryRecord } from "../../src/domains/memory/types.js";
import { resolveEffectivePricing } from "../../src/domains/providers/catalog.js";
import anthropic from "../../src/domains/providers/runtimes/cloud/anthropic.js";

const roots: string[] = [];
const VALIDATE = "node check.mjs --mode native";

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-memory-gate-"));
	roots.push(root);
	return root;
}

async function propose(dataDir: string, repo: string, kind: "knowledge" | "procedural", sessionId = "s1") {
	const bank = new TaskMemoryBank();
	const entry =
		kind === "knowledge"
			? bank.saveKnowledge(`Validate routing with \`${VALIDATE}\`.`)
			: bank.saveProcedural("build failed twice");
	const repository = canonicalMemoryRepositoryIdentity(repo);
	if (repository === null) throw new Error("scratch repository has no identity");
	const { record } = await proposeMemoryPromotion(
		dataDir,
		{
			kind: "task-bank-entry",
			sessionId,
			evidenceRefs: [`session:${sessionId}`, ...(kind === "knowledge" ? [commandEvidenceRef(VALIDATE)] : [])],
			entry,
		},
		{ scope: "repo", repository },
	);
	return { record, repository };
}

describe("memory guardian gate", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("approves a command lesson once two later sessions report it held, and it reaches the prompt", async () => {
		const dataDir = scratch();
		const { record, repository } = await propose(dataDir, scratch(), "knowledge");
		strictEqual(evaluateMemoryGate(record), "hold");
		const delivered = await recordMemoryObservations(dataDir, [
			{ memoryId: record.id, sessionId: "s1", kind: "delivered" },
			{ memoryId: record.id, sessionId: "s1", kind: "held" },
			{ memoryId: record.id, sessionId: "s2", kind: "held" },
		]);
		deepStrictEqual(delivered.approved, [], "the author's own verdict never counts");
		const held = await recordMemoryObservations(dataDir, [{ memoryId: record.id, sessionId: "s3", kind: "held" }]);
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
			[
				{ memoryId: record.id, sessionId: "s2", kind: "held" },
				{ memoryId: record.id, sessionId: "s3", kind: "held" },
			],
			new Date("2026-10-04T00:00:00Z"),
		);
		const demoted = await recordMemoryObservations(
			dataDir,
			[{ memoryId: record.id, sessionId: "s4", kind: "contradicted" }],
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
			[{ memoryId: record.id, sessionId: "s5", kind: "contradicted" }],
			new Date("2026-10-07T00:00:00Z"),
		);
		deepStrictEqual(after.demoted, []);
		strictEqual((await loadMemoryRecords(dataDir))[0]?.approved, true);
	});

	it("files one record per claim and promotes it on two non-author demonstrations of one revision (card D)", async () => {
		const dataDir = scratch();
		const repo = realpathSync(scratch());
		writeFileSync(join(repo, "fixture.mjs"), "process.exit(0);\n");
		const checkout = (branch: string) => {
			mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
			writeFileSync(join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
			writeFileSync(join(repo, ".git", "refs", "heads", branch), `${branch === "a" ? "a" : "b"}${"0".repeat(39)}\n`);
		};
		checkout("a");
		const run = (mode: string) => `node fixture.mjs --mode ${mode}`;
		const pattern = (command: string, scratchParameter?: number) => {
			const segment = commandSegment(command, repo);
			const claimed = segment === null ? null : claimCommand(segment, scratchParameter);
			if (claimed === null) throw new Error(`no claim for ${command}`);
			return claimed;
		};
		const session = (sessionId: string, claim: MemoryClaim, receipts: ClaimReceipt[], extra = {}) =>
			recordClaimSession(dataDir, {
				sessionId,
				cwd: repo,
				lesson:
					claim.kind === "fix"
						? `When \`${claim.failed.argv.join(" ")}\` fails, run \`${claim.fixed.argv.join(" ")}\`.`
						: `Use \`${claim.kind === "command" ? claim.command.argv.join(" ") : ""}\` here.`,
				claim,
				receipts,
				...extra,
			});
		const passed = (mode: string) => ({ command: run(mode), ok: true });
		const failed = (mode: string) => ({ command: run(mode), ok: false });

		// Seeded receipts, no capture: three sessions demonstrate one fix claim and leave one record.
		const fix: MemoryClaim = { kind: "fix", failed: pattern(run("legacy")), fixed: pattern(run("strict")) };
		const pair = [failed("legacy"), passed("strict")];
		const first = await session("s1", fix, pair);
		strictEqual(first.created, true);
		strictEqual(
			(await session("s2", fix, [failed("legacy"), passed("other")])).verdict,
			null,
			"an unrelated later success on the same subject is not a demonstration",
		);
		strictEqual((await session("s2", fix, [passed("strict")])).verdict, null, "the fixed pattern alone is not the pair");
		strictEqual((await session("s2", fix, pair, { prompted: true })).gate, "hold", "one non-author demonstration");
		const third = await session("s3", fix, pair);
		strictEqual(third.gate, "approve", "a prompted fix demonstration counts: both halves were observed");
		strictEqual(third.record?.id, first.record?.id);
		deepStrictEqual(
			third.record?.observations?.map((item) => [item.sessionId, item.branch, item.head?.slice(0, 1)]),
			[
				["s1", "a", "a"],
				["s2", "a", "a"],
				["s3", "a", "a"],
			],
		);

		// D-R fork: task A keeps `strict` on branch a, task B keeps `compat` on branch b. One subject, two claims.
		const strict: MemoryClaim = { kind: "command", command: pattern(run("strict")) };
		const compat: MemoryClaim = { kind: "command", command: pattern(run("compat")) };
		const strictNote = await session("s4", strict, [passed("strict")]);
		for (const sessionId of ["s5", "s6"])
			strictEqual((await session(sessionId, strict, [passed("strict")], { prompted: true })).gate, "hold");
		checkout("b");
		for (const sessionId of ["s7", "s8", "s9"]) await session(sessionId, compat, [passed("compat")]);
		strictEqual(claimDemonstration(strict, [passed("compat")], repo), null, "a compat success says nothing of strict");
		const fork = await loadMemoryRecords(dataDir);
		strictEqual(fork.length, 3, "opposing facts are not merged");
		const stored = (id: string | undefined) => fork.find((item) => item.id === id);
		strictEqual(stored(strictNote.record?.id)?.approved, false, "prompted successes of a plain command do not promote");
		strictEqual(fork.filter((item) => item.approved).length, 2);
		deepStrictEqual(
			[...memorySubjectIndex(fork, repo).values()].map((items) => items.length),
			[3],
			"the subject finds every claim on it and vouches for none",
		);

		// Evidence changed after the first confirmation is a new revision, and the count starts again.
		const entry = (quote?: string) =>
			new TaskMemoryBank().saveKnowledge(`Check the fixture with \`${run("check")}\`.`, {
				durable: true,
				evidenceCommand: run("check"),
				...(quote ? { evidenceSource: { path: "fixture.mjs", quote } } : {}),
			});
		const file = async (sessionId: string, quote?: string) => {
			const item = entry(quote);
			return (
				await proposeInjectedTaskMemory(dataDir, {
					sessionId,
					cwd: repo,
					entries: [item],
					observation: "held",
					commandVerified: new Set([item.id]),
				})
			).records[0];
		};
		const t1 = await file("t1");
		await file("t2");
		strictEqual((await file("t3", "process.exit(0);"))?.id, t1?.id, "one claim, a second revision");
		strictEqual((await file("t4", "process.exit(0);"))?.approved, false, "t2 confirmed the earlier revision");
		const revised = await file("t5", "process.exit(0);");
		strictEqual(revised?.approved, true);
		strictEqual(revised?.revisions?.length, 2);

		// A contradiction outlives 33 later deliveries and 33 later verdicts.
		const compatId = fork.find((item) => item.approved && item.claim?.kind === "command")?.id ?? "";
		const contradiction = await recordMemoryObservations(
			dataDir,
			[{ memoryId: compatId, sessionId: "x", kind: "contradicted" }],
			new Date("2099-01-01T00:00:00.000Z"),
		);
		strictEqual(contradiction.demoted.length, 1);
		for (let index = 0; index < 33; index++)
			await recordMemoryObservations(dataDir, [
				{ memoryId: compatId, sessionId: `d${index}`, kind: "delivered" },
				{ memoryId: compatId, sessionId: `d${index}`, kind: "held" },
			]);
		const survived = (await loadMemoryRecords(dataDir)).find((item) => item.id === compatId);
		strictEqual(survived?.deliveredCount, 33);
		strictEqual(survived?.observations?.length, 32);
		strictEqual(survived?.observations?.filter((item) => item.kind === "contradicted").length, 1);

		// A note binds no path outside its checkout, except a declared scratch parameter.
		const out = `node fixture.mjs --out ${join(tmpdir(), "elsewhere", "out.txt")}`;
		await rejects(session("s10", { kind: "command", command: pattern(out) }, []), /outside its repository/u);
		strictEqual(claimPathRefusal({ kind: "command", command: pattern(out, 3) }, repo), null);

		// The legacy reader: a store written before claims is read as it is, and its first mutation keeps the count.
		const legacyDir = scratch();
		const legacy: MemoryRecord = {
			id: "mem-00000000000000a1",
			scope: "repo",
			key: "legacy",
			lesson: `Run \`${VALIDATE}\`.`,
			evidenceRefs: [commandEvidenceRef(VALIDATE)],
			appliesWhen: [],
			avoidWhen: [],
			confidence: 0.6,
			createdAt: "2026-10-01T00:00:00.000Z",
			approved: false,
			repository: { kind: "canonical-path", key: repo },
			observations: ["2026-10-02", "2026-10-03", "2026-10-04"].map((day, index) => ({
				at: `${day}T00:00:00.000Z`,
				sessionId: `l${index}`,
				kind: "delivered",
			})),
		};
		const legacyPath = join(legacyDir, "memory", "records.json");
		mkdirSync(join(legacyDir, "memory"), { recursive: true });
		const legacyText = `${JSON.stringify({ version: 1, records: [legacy] }, null, 2)}\n`;
		writeFileSync(legacyPath, legacyText);
		deepStrictEqual(await loadMemoryRecords(legacyDir), [legacy]);
		strictEqual(readFileSync(legacyPath, "utf8"), legacyText, "nothing is rewritten on load");
		await recordMemoryObservations(legacyDir, [{ memoryId: legacy.id, sessionId: "l9", kind: "held" }]);
		const migrated = JSON.parse(readFileSync(legacyPath, "utf8"));
		strictEqual(migrated.version, 2);
		strictEqual(migrated.records[0].deliveredCount, 3);
		strictEqual(migrated.records[0].lastDeliveredAt, "2026-10-04T00:00:00.000Z");
		deepStrictEqual(
			migrated.records[0].observations.map((item: { kind: string }) => item.kind),
			["held"],
		);

		// At capacity: every operator decision and lesson stays, a note with no evidence goes before an older one with it.
		const fullDir = scratch();
		const note = (index: number, patch: Partial<MemoryRecord>): MemoryRecord => ({
			...legacy,
			id: `mem-${index.toString(16).padStart(16, "0")}`,
			key: `note-${index}`,
			observations: [],
			...patch,
		});
		const recent = "2026-11-01T00:00:00.000Z";
		const decided = [
			note(1, { approved: true }),
			note(2, { approved: true, approval: { by: "operator", at: recent } }),
			note(3, { approved: true, approval: { by: "guardian", at: recent } }),
			note(4, { rejectedAt: recent, evidenceRefs: ["session:old"] }),
		];
		const notes = Array.from({ length: 496 }, (_, index) =>
			note(index + 5, index === 0 ? { evidenceRefs: ["session:a"], createdAt: recent } : {}),
		);
		mkdirSync(join(fullDir, "memory"), { recursive: true });
		writeFileSync(
			join(fullDir, "memory", "records.json"),
			JSON.stringify({ version: 1, records: [...decided, ...notes] }),
		);
		await insertMemoryRecordIfAbsent(fullDir, note(999, {}));
		const kept = new Set((await loadMemoryRecords(fullDir)).map((item) => item.id));
		strictEqual(kept.size, 500);
		ok(decided.every((item) => kept.has(item.id)));
		strictEqual(kept.has(notes[0]?.id ?? ""), false, "the note with no evidence goes first");
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
			pricedBy: "target-rates",
			rates: { input: 3, output: 15 },
			runtime: { auth: "api-key", tier: "cloud" },
			quotaProviderId: null,
		} as const;
		const quota = {
			pricedBy: "catalog",
			rates: { input: 3, output: 15 },
			runtime: { auth: "oauth", tier: "cloud" },
			quotaProviderId: "codex",
		} as const;
		const local = {
			pricedBy: "free",
			rates: { input: 0, output: 0 },
			runtime: { auth: "api-key", tier: "local-native" },
			quotaProviderId: null,
		} as const;
		const unpriced = {
			pricedBy: "none",
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
				{ admit: false, kind: "quota", reason: "quota_unknown" },
			],
			["quota unknown", { route: quota }, { admit: false, kind: "quota", reason: "quota_unknown" }],
			[
				"quota error",
				{ route: quota, quota: { ...window(10), snapshot: { ...window(10).snapshot, status: "error" } } },
				{ admit: false, kind: "quota", reason: "quota_unknown" },
			],
			[
				"quota no windows",
				{ route: quota, quota: { ...window(10), snapshot: { ...window(10).snapshot, windows: [] } } },
				{ admit: false, kind: "quota", reason: "quota_unknown" },
			],
			[
				"quota expired",
				{
					route: quota,
					quota: {
						...window(99),
						snapshot: {
							...window(99).snapshot,
							windows: [{ key: "weekly", label: "Weekly", usedPct: 99, resetsAt: new Date(nowMs - 1).toISOString() }],
						},
					},
				},
				{ admit: false, kind: "quota", reason: "quota_unknown" },
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
