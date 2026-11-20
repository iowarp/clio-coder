import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { beginCall, registerTelemetrySink } from "../../src/core/telemetry/producer.js";
import type { BackgroundStepFacts } from "../../src/domains/memory/background-budget.js";
import { decideBackgroundStep, SIDE_SHARE_FREE_CALLS } from "../../src/domains/memory/background-budget.js";
import { createBackgroundCallJournal } from "../../src/domains/memory/background-route.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { createTaskMemoryTelemetrySink, type TaskMemoryTelemetryStep } from "../../src/domains/memory/memory-events.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { readTaskMemorySpendSummary } from "../../src/domains/memory/task-memory-spend.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const ZERO = { added: 0, updated: 0, deleted: 0 };
const STEP: TaskMemoryTelemetryStep = {
	triggerReasons: ["interval"],
	tier: "llm",
	bankDelta: { status: ZERO, knowledge: ZERO, procedural: ZERO },
	decision: "silent",
	reason: "model_silent",
	bankOperations: 0,
	droppedOperations: 0,
	citedEntries: 0,
	inputTokens: { kind: "measured", value: 1_317, source: "provider" },
	outputTokens: { kind: "measured", value: 12, source: "provider" },
	latencyMs: 40,
};

test("a step journals the resolved route, call references and its owning context", () => {
	const records: PendingTelemetry[] = [];
	const unregister = registerTelemetrySink("original", {
		enqueue: (record) => {
			records.push(record);
			return true;
		},
	});
	try {
		const route = { targetId: "zbook-lemonade", modelId: "Gemma-4-26B-A4B-it-MTP-GGUF" };
		const call = { sessionId: "original", repoIdentity: "repo", callId: newCallId(), attemptId: newAttemptId() };
		createTaskMemoryTelemetrySink().record({ ...STEP, route, calls: [call] });
		const row = records[0];
		ok(row?.kind === "memory.step_decided");
		deepStrictEqual(row.ctx, { sessionId: "original", agent: { role: "memory", id: "original" } });
		deepStrictEqual(row.data.route, route);
		deepStrictEqual(row.data.calls, [{ callId: call.callId, attemptId: call.attemptId }]);
		strictEqual(validPayload(row.kind, row.data), true);
	} finally {
		unregister();
	}
});

test("rules and model steps retain their launching owner without inventing a provider call", async () => {
	const rows: TaskMemoryTelemetryStep[] = [];
	let useModel = false;
	const registration = createMemoryInterventionRegistration({
		bank: new TaskMemoryBank(),
		getModelClient: () =>
			useModel
				? {
						complete: async () => {
							await Promise.resolve();
							registration.evaluate({ hook: "before_tool", sessionId: "session-b", turnId: "next-turn" });
							return { text: "<operations>[]</operations><no_intervention/>" };
						},
					}
				: null,
		telemetry: { record: (step) => rows.push(step) },
	});
	try {
		registration.evaluate({ hook: "turn_start", sessionId: "session-a", turnId: "turn-a" });
		await registration.runPromptedStep({ deterministicTrigger: true });
		strictEqual(rows.length > 0, true);
		ok(rows[0]);
		deepStrictEqual(rows[0].context, {
			sessionId: "session-a",
			turnId: "turn-a",
			agent: { role: "memory", id: "session-a" },
		});
		strictEqual(rows[0].calls, undefined);
		registration.reset();
		rows.length = 0;
		useModel = true;
		registration.evaluate({ hook: "turn_start", sessionId: "session-b", turnId: "turn-b" });
		await registration.runPromptedStep({ deterministicTrigger: true });
		strictEqual(rows[0]?.context?.sessionId, "session-b");
		strictEqual(rows[0]?.context?.turnId, "turn-b");
		strictEqual(rows[0]?.tier, "llm");
	} finally {
		registration.dispose();
	}
});

test("linked memory spend follows late journal settlements and deduplicates repeated step references", async (t) => {
	const home = makeScratchHome("clio-coder-memory-journal-");
	t.after(home.cleanup);
	const context = { sessionId: "session", agent: { role: "memory" as const, id: "session" } };
	const journal = await openCallJournal({
		directory: telemetrySessionDirectory(home.dir, "session"),
		context,
		writer: { clioCoderVersion: "fixture", piVersion: "fixture" },
	});
	try {
		const call = beginCall(
			{
				roundKind: "tools-removed",
				toolChoice: "none",
				target: {
					targetId: "target",
					runtimeId: "runtime",
					api: "fixture",
					requestedModel: "model",
					reportedModel: { kind: "unknown", reason: "not-observed" },
				},
			},
			context,
		);
		const sink = createTaskMemoryTelemetrySink();
		const step = {
			...STEP,
			context,
			calls: [{ sessionId: "session", repoIdentity: "repo", callId: call.callId, attemptId: call.attemptId }],
		};
		sink.record(step);
		sink.record(step);
		await journal.flush();
		const pending = readTaskMemorySpendSummary(home.dir);
		strictEqual(pending.totalTokens.measured, 0);
		strictEqual(pending.unresolvedCalls, 1);
		strictEqual(pending.totalTokens.unknownCount, 1, "an open attempt leaves usage unknown");
		strictEqual(readTaskMemorySpendSummary(home.dir), pending);
		call.settle(
			callSettlementFromMessage(
				{
					stopReason: "stop",
					usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, clioExternal: { tokenUsage: "provider-reported" } },
				},
				"none",
			),
		);
		await journal.flush();
		const settled = readTaskMemorySpendSummary(home.dir);
		strictEqual(settled.totalTokens.measured, 7);
		strictEqual(settled.llmSteps, 2);
		strictEqual(settled.unresolvedCalls ?? 0, 0);
		strictEqual(readTaskMemorySpendSummary(home.dir), settled);
	} finally {
		await journal.close();
	}
});

test("the side-share governor admits three free calls, then refuses automatic calls over the share; the rules tiers make no model step", () => {
	const measured = (value: number) => ({ kind: "measured" as const, value, source: "provider" as const });
	const settled = (
		role: "main" | "memory",
		output: number | null,
		extra: Record<string, unknown> = {},
	): TelemetryRecord =>
		({
			k: "call.settled",
			ctx: { sessionId: "s", agent: { role, id: "s" } },
			data: {
				callId: newCallId(),
				attemptId: newAttemptId(),
				disposition: output === null ? "settled_no_usage" : "settled",
				usage: output === null ? null : { output: measured(output) },
				...(role === "memory" ? { purpose: "memory.lesson" } : {}),
				...extra,
			},
		}) as unknown as TelemetryRecord;
	let records: TelemetryRecord[] = [];
	const journal = () =>
		createBackgroundCallJournal(
			{} as ProvidersContract,
			() => undefined,
			() => undefined,
			() => records,
		);
	let governor = journal().sideShare;
	ok(governor);
	const memory = { ...DEFAULT_SETTINGS.context.memory, sideShare: 0.15, maxOutputTokens: 2000 };
	const step = (purpose: "memory.lesson" | "memory.classify" = "memory.lesson"): BackgroundStepFacts => ({
		route: { pricedBy: "free", rates: null, runtime: { auth: "none", tier: "local-native" }, quotaProviderId: null },
		inputTokens: 100,
		maxOutputTokens: 2000,
		timeoutCapMs: 1000,
		nowMs: 0,
		session: { spendUsd: 0, ceilingUsd: 0 },
		quota: null,
		endpoint: { occupied: 0, admissionLimit: 1, prefillTokensPerSecond: null, generationTokensPerSecond: null },
		sideShare: governor?.facts(purpose, memory) ?? assertNever(),
	});
	const reason = (facts: BackgroundStepFacts) => {
		const decision = decideBackgroundStep(facts);
		return decision.admit ? "admit" : decision.reason;
	};
	// Cold start with no main output: the free calls run, the next automatic one is refused.
	const holds: Array<() => void> = [];
	for (let call = 0; call < SIDE_SHARE_FREE_CALLS; call += 1) {
		strictEqual(reason(step()), "admit");
		// Concurrent admission: an admitted call holds its output budget, so the next decision counts it.
		holds.push(governor.hold("memory.lesson", 2000));
	}
	strictEqual(reason(step()), "side_share", "a zero main denominator admits only the free calls");
	strictEqual(reason(step("memory.classify")), "admit", "an operator-requested call is exempt");
	for (const release of holds) release();
	// The calls settle: one reported no usage and counts its budget, never zero.
	records = [settled("memory", 100), settled("memory", 100), settled("memory", null), settled("main", 10_000)];
	strictEqual(governor.facts("memory.lesson", memory).sideOutputTokens, 2200);
	strictEqual(reason(step()), "side_share", "2200 over 10000 is past 0.15; a fourth useful call is still refused");
	// Resume: a fresh governor folds the same journal and continues the count.
	governor = journal().sideShare;
	ok(governor);
	strictEqual(governor.facts("memory.lesson", memory).automaticCalls, 3);
	records.push(settled("main", 10_000));
	strictEqual(reason(step()), "admit", "2200 over 20000 is under the share");
	// Premium units, where reported, must also be under the share.
	records = records.map((record) =>
		record.k === "call.settled"
			? ({
					...record,
					data: { ...record.data, billing: { premiumRequests: measured(1) } },
				} as TelemetryRecord)
			: record,
	);
	strictEqual(reason(step()), "side_share", "3 memory premium units over 2 main is past the share");
	strictEqual(
		reason({ ...step(), sideShare: { ...governor.facts("memory.lesson", memory), share: 0 } }),
		"admit",
		"0 turns it off",
	);

	// The switches: the default rules tiers arm no model step on an error streak or the tool cadence; `model` does.
	for (const surfaces of [undefined, { correct: "model" as const }, { bank: "model" as const }]) {
		const registration = createMemoryInterventionRegistration({
			bank: new TaskMemoryBank(),
			everyNTools: 2,
			...(surfaces ? { surfaces } : {}),
		});
		try {
			registration.evaluate({ hook: "turn_start", sessionId: "switch", turnId: "t" });
			for (const command of ["false", "false --again"])
				registration.evaluate({
					hook: "after_tool",
					sessionId: "switch",
					turnId: "t",
					toolName: "bash",
					toolArgs: { command },
					metadata: { resultKind: "error" },
				});
			registration.signalLoop();
			strictEqual(registration.owesBoundaryStep(), surfaces !== undefined, JSON.stringify(surfaces ?? "rules"));
		} finally {
			registration.dispose();
		}
	}
});

function assertNever(): never {
	throw new Error("governor missing");
}
