import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import {
	closePendingToolCalls,
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
