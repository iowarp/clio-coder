import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { CallObservation } from "../../src/core/call-failure.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { journalUsageWindow, usageCallsFromAttempts } from "../../src/domains/session/journal-usage.js";
import { ledgerCallFailureCounts, ledgerUsageCalls } from "../../src/domains/session/usage.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import {
	closePendingToolCalls,
	runOutOfTurnRound,
	runSideQuestion,
	SIDE_QUESTION_TOOL_CALL_NOTE,
} from "../../src/session-control/side-question.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

test("/btw answers while a turn is streaming and leaves the turn's history alone (#415)", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	assert.ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	let release!: () => void;
	const turnHeld = new Promise<void>((resolve) => {
		release = resolve;
	});
	let live: AgentMessage[] = [];
	let sent: ReadonlyArray<AgentMessage> | null = null;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			const state = options?.initialState as { messages: AgentMessage[] };
			live = state.messages;
			return {
				agent: {
					state,
					subscribe: () => () => {},
					abort() {},
					async prompt() {
						await turnHeld;
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
		runSideQuestion: async (input) => {
			sent = input.messages;
			return { text: "beside the turn", usage: null, aborted: false };
		},
	});
	try {
		const turn = loop.submit("long running turn");
		for (let i = 0; i < 1000 && !loop.isStreaming(); i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(loop.isStreaming(), true);
		const before = [...live];
		assert.deepEqual(await loop.askSideQuestion("which file?"), { status: "answered", text: "beside the turn" });
		assert.ok(sent);
		assert.notEqual(sent, live, "the round reads a snapshot, not the live list");
		assert.deepEqual(live, before);
		assert.equal(loop.isStreaming(), true, "the turn is still running");
		const handoff = await loop.extractHandoff("continue");
		assert.equal(handoff.status, "refused");
		release();
		await turn;
	} finally {
		release();
		loop.dispose();
		await loop.whenSettled();
	}
});

test("a side answer that is only tool-call markup is replaced by a note (#415)", async () => {
	const provider = registerEngineFauxProvider({ api: "side-tool-call-contract", models: [{ id: "fixture" }] });
	try {
		const { agent } = createEngineAgent({ initialState: { model: provider.getModel(), messages: [] } });
		provider.setResponses([
			fauxAssistantMessage('<tool_call>{"name":"read","arguments":{"path":"src/index.ts"}}</tool_call>'),
		]);
		const answer = await runSideQuestion({
			model: agent.state.model,
			messages: [{ role: "user", content: "read it", timestamp: 1 }],
			question: "what did it say?",
			thinkingLevel: "off",
		});
		assert.equal(answer.text, SIDE_QUESTION_TOOL_CALL_NOTE);
	} finally {
		provider.unregister();
	}
});

test("only a mid-turn call that is still running gets a synthetic result (#415)", () => {
	const pending = (stopReason: string) =>
		[
			{ role: "user", content: "write it", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }],
				stopReason,
				timestamp: 2,
			},
		] as unknown as AgentMessage[];
	// Esc during a streamed call stores the aborted partial; Pi drops it on the
	// wire, so a result after it would be an orphan.
	assert.deepEqual(
		closePendingToolCalls(pending("aborted"), true).map((m) => m.role),
		["user", "assistant"],
	);
	assert.deepEqual(
		closePendingToolCalls(pending("toolUse"), false).map((m) => m.role),
		["user", "assistant"],
	);
	const closed = closePendingToolCalls(pending("toolUse"), true);
	assert.deepEqual(
		closed.map((m) => m.role),
		["user", "assistant", "toolResult"],
	);
	assert.equal((closed[2] as { toolCallId?: unknown }).toolCallId, "call_1");
});

test("side rounds journal schema retries once and preserve never-sent admission failures", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "side-journal-"));
	const journals = createSessionJournals(stateDir, () => {});
	const provider = registerEngineFauxProvider({ api: "side-journal-contract", models: [{ id: "fixture" }] });
	const live: CallSettled[] = [];
	const observations: CallObservation[] = [];
	const telemetry = {
		onSettled: (facts: CallSettled) => {
			live.push(facts);
		},
		origin: { id: "side-session", cwdHash: "repo" },
		acquire: journals.acquire,
		role: "btw" as const,
		targetId: "fixture",
		runtimeId: "llamacpp",
		costProvenance: "unknown" as const,
	};
	try {
		provider.setResponses([
			{
				...fauxAssistantMessage(""),
				stopReason: "error",
				errorMessage: "HTTP 400 response_format json_schema is not supported",
			},
			fauxAssistantMessage("answer"),
		]);
		const input = {
			model: provider.getModel(),
			messages: [],
			systemPrompt: "side",
			userText: "ask",
			thinkingLevel: "off" as const,
			runtimeId: "llamacpp",
			telemetry,
			onUsage: (_usage: unknown, observation?: CallObservation) => {
				if (observation) observations.push(observation);
			},
			responseSchema: { name: "answer", schema: { type: "object" } },
		};
		assert.equal((await runOutOfTurnRound(input)).text, "answer");
		await assert.rejects(runOutOfTurnRound({ ...input, admitFlow: () => "refused" }), /refused/);
		const records = (await readCallJournal(telemetrySessionDirectory(stateDir, "side-session"))).records.map(
			({ record }) => record,
		);
		const calls = records.filter((record) => record.k === "call.settled");
		assert.equal(calls.length, 3);
		assert.equal(live.length, 3);
		assert.deepEqual(
			observations.map((row) => [row.callId, row.attemptId]),
			live.map((call) => [call.callId, call.attemptId]),
		);
		assert.deepEqual(
			ledgerUsageCalls([], records),
			usageCallsFromAttempts(live.map((settled) => ({ started: settled, settled }))),
		);
		assert.equal(ledgerCallFailureCounts([], records).neverInvokedCalls, 1);
		const shifted = records.map((row) => ({
			...row,
			t: row.k === "call.settled" ? "2026-01-02T00:00:00.000Z" : "2026-01-01T23:00:00.000Z",
		}));
		const inWindow = journalUsageWindow(
			shifted,
			Date.parse("2026-01-02T00:00:00.000Z"),
			Date.parse("2026-01-03T00:00:00.000Z"),
		);
		assert.equal(ledgerUsageCalls([], inWindow).length, 2);
		const outside = journalUsageWindow(
			shifted,
			Date.parse("2026-01-03T00:00:00.000Z"),
			Date.parse("2026-01-04T00:00:00.000Z"),
		);
		assert.equal(ledgerUsageCalls([], outside).length, 0);
		assert.equal(calls[0]?.data.callId, calls[1]?.data.callId);
		assert.notEqual(calls[0]?.data.attemptId, calls[1]?.data.attemptId);
		assert.equal(calls[1]?.data.attempt, 1);
		assert.equal(calls[2]?.data.disposition, "never_sent");
		assert.equal(calls[2]?.data.usage, null);
		// The engine seam times a side call's handoff and first token; a refused call never reaches it (#434).
		assert.ok(calls[1]?.data.stages.send && calls[1].data.stages.firstToken !== undefined, JSON.stringify(calls[1]));
		assert.equal(calls[2]?.data.stages.send, undefined);
		assert.ok(calls.every((record) => record.ctx.sessionId === "side-session" && record.ctx.agent.role === "btw"));
	} finally {
		provider.unregister();
		await journals.flush();
		await rm(stateDir, { recursive: true, force: true });
	}
});
