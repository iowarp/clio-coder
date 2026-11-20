import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { beginCall, registerTelemetrySink } from "../../src/core/telemetry/producer.js";
import type { SideShareFacts } from "../../src/domains/memory/background-budget.js";
import {
	decideBackgroundStep,
	foldSideShare,
	SIDE_SHARE_FREE_CALLS,
} from "../../src/domains/memory/background-budget.js";
import { createBackgroundCallJournal } from "../../src/domains/memory/background-route.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { createTaskMemoryTelemetrySink, type TaskMemoryTelemetryStep } from "../../src/domains/memory/memory-events.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { readTaskMemorySpendSummary } from "../../src/domains/memory/task-memory-spend.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createLiveTelemetryModel } from "../../src/domains/telemetry/telemetry-live.js";
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

test("the side-share governor admits three free calls, then refuses automatic calls over the share; the rules tiers make no model step", async (t) => {
	const home = makeScratchHome("clio-coder-side-share-");
	t.after(home.cleanup);
	const sessionId = "share";
	const memoryContext = { sessionId, agent: { role: "memory" as const, id: sessionId } };
	const mainContext = { sessionId, agent: { role: "main" as const, id: sessionId } };
	const target = {
		targetId: "copilot",
		runtimeId: "copilot-sdk",
		api: "fixture",
		requestedModel: "gpt-0x",
		reportedModel: { kind: "unknown" as const, reason: "not-observed" as const },
	};
	const journal = await openCallJournal({
		directory: telemetrySessionDirectory(home.dir, sessionId),
		context: memoryContext,
		writer: { clioCoderVersion: "fixture", piVersion: "fixture" },
	});
	const begin = (context: typeof memoryContext | typeof mainContext, purpose?: "memory.lesson") =>
		beginCall({ roundKind: "tools-removed", toolChoice: "none", target, ...(purpose ? { purpose } : {}) }, context);
	// Every call bills like a 0x Copilot model: premium units measured, and zero.
	const settle = (call: ReturnType<typeof begin>, output: number | null, extra: Record<string, unknown> = {}) =>
		call.settle(
			callSettlementFromMessage(
				{
					stopReason: "stop",
					...(output === null
						? {}
						: {
								usage: {
									input: 1,
									output,
									cacheRead: 0,
									cacheWrite: 0,
									clioExternal: { tokenUsage: "provider-reported" },
								},
							}),
					copilotBilling: { premiumRequests: 0, nanoAiu: 0, modelCalls: 1 },
					...extra,
				},
				"none",
			),
		);
	// One process's governor over the real live read model, behind the settle barrier the telemetry contract has.
	const processGovernor = () => {
		const model = createLiveTelemetryModel({ stateDir: () => home.dir });
		model.bind(sessionId);
		const telemetry = {
			settledSessionSpend: async () => {
				await journal.flush();
				return model.settled();
			},
			read: model,
		};
		const governor = createBackgroundCallJournal(
			{} as ProvidersContract,
			() => undefined,
			() => undefined,
			() => telemetry,
		).sideShare;
		ok(governor);
		return { governor, model };
	};
	type Governor = ReturnType<typeof processGovernor>["governor"];
	const memory = { ...DEFAULT_SETTINGS.context.memory, sideShare: 0.15, maxOutputTokens: 2000 };
	const decideWith = (facts: SideShareFacts) => {
		const decision = decideBackgroundStep({
			route: { pricedBy: "free", rates: null, runtime: { auth: "none", tier: "local-native" }, quotaProviderId: null },
			inputTokens: 100,
			maxOutputTokens: 2000,
			timeoutCapMs: 1000,
			nowMs: 0,
			session: { spendUsd: 0, ceilingUsd: 0 },
			quota: null,
			endpoint: { occupied: 0, admissionLimit: 1, prefillTokensPerSecond: null, generationTokensPerSecond: null },
			sideShare: facts,
		});
		return decision.admit ? "admit" : decision.reason;
	};
	const decide = async (governor: Governor, purpose: "memory.lesson" | "memory.classify" = "memory.lesson") => {
		const facts = governor.facts(await governor.journal(), purpose, memory);
		return { facts, reason: decideWith(facts) };
	};
	const first = processGovernor();
	try {
		const { governor } = first;
		// Cold start, zero main output: the free calls run, held ones count for the next decision, then refusal.
		const holds: Array<() => void> = [];
		for (let call = 0; call < SIDE_SHARE_FREE_CALLS; call += 1) {
			strictEqual((await decide(governor)).reason, "admit");
			holds.push(governor.hold("memory.lesson", 2000, undefined));
		}
		strictEqual((await decide(governor)).reason, "side_share", "a zero main denominator admits only the free calls");
		strictEqual((await decide(governor, "memory.classify")).reason, "admit", "an operator-requested call is exempt");
		// A call another session holds is that session's spend.
		const elsewhere = governor.hold("memory.lesson", 2000, { sessionId: "other", attemptId: newAttemptId() });
		for (const release of holds) release();
		strictEqual((await decide(governor)).facts.automaticCalls, 0, "unjournaled holds end with their call");
		elsewhere();

		settle(begin(mainContext), 10_000);
		// Three journaled memory calls; the one without usage is charged its own request budget (500), not the setting.
		for (const [index, output] of [100, 100, null].entries()) {
			const call = begin(memoryContext, "memory.lesson");
			const release = governor.hold("memory.lesson", output === null ? 500 : 2000, {
				sessionId,
				attemptId: call.attemptId,
			});
			if (index < 2) {
				settle(call, output);
				release();
				continue;
			}
			// Released before its settlement reached the journal: still counted, never between held and recorded.
			release();
			strictEqual(
				(await decide(governor)).facts.automaticCalls,
				3,
				"a released call counts until its settle is journaled",
			);
			settle(call, output);
		}
		// A never-sent attempt spent nothing and is no call.
		settle(begin(memoryContext, "memory.lesson"), null, { callInvoked: false });
		const settled = await decide(governor);
		strictEqual(settled.facts.automaticCalls, 3, "counted once from the journal after it settles");
		strictEqual(settled.facts.sideOutputTokens, 700);
		deepStrictEqual(settled.facts.premium, { side: 0, main: 0 });
		strictEqual(settled.reason, "admit", "700 over 10000 is under the share, and a 0x route's zero units refuse nothing");
		// A replayed settlement folds once.
		const records = (await governor.journal()).records;
		deepStrictEqual(
			foldSideShare([...records, ...records], [], () => 2000).facts,
			foldSideShare(records, [], () => 2000).facts,
		);
		settle(begin(memoryContext, "memory.lesson"), 2000);
		strictEqual((await decide(governor)).reason, "side_share", "2700 over 10000: a fourth useful call is refused");
	} finally {
		first.model.stop();
	}
	// Resume in a new process: the unseeded live view is waited out, so the count continues.
	const second = processGovernor();
	try {
		const resumed = await decide(second.governor);
		strictEqual(resumed.facts.automaticCalls, 4, "a resumed session continues its count");
		strictEqual(resumed.reason, "side_share");
		const under = { ...resumed.facts, sideOutputTokens: 1 };
		strictEqual(
			decideWith({ ...under, premium: { side: 1, main: 0 } }),
			"side_share",
			"memory units over zero main units",
		);
		strictEqual(decideWith({ ...under, premium: { side: 0, main: 0 } }), "admit", "zero memory units refuse nothing");
		strictEqual(decideWith({ ...resumed.facts, share: 0 }), "admit", "0 turns it off");
	} finally {
		second.model.stop();
		await journal.close();
	}

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
