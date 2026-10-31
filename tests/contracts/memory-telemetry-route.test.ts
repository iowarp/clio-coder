import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { validPayload } from "../../src/core/telemetry/events.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { beginCall, registerTelemetrySink } from "../../src/core/telemetry/producer.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { createTaskMemoryTelemetrySink, type TaskMemoryTelemetryStep } from "../../src/domains/memory/memory-events.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { readTaskMemorySpendSummary } from "../../src/domains/memory/task-memory-spend.js";
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
