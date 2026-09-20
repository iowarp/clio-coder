import { deepStrictEqual, doesNotThrow, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	type Context,
	fauxAssistantMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createEngineAgent, replaceEngineMessages, setEngineSystemPrompt } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { estimateInputTokensFromContext } from "../../src/engine/apis/output-budget.js";
import { resolvedRequestContext } from "../../src/engine/context.js";
import type { AgentMessage, AgentTool } from "../../src/engine/types.js";
import { runSideQuestion, SIDE_QUESTION_SYSTEM_PROMPT } from "../../src/interactive/side-question.js";

const user: AgentMessage = { role: "user", content: "retained task", timestamp: 1 };
const tool: AgentTool = {
	name: "inspect",
	label: "Inspect",
	description: "Inspect sources",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "evidence" }], details: {} }),
};

test("Pi resolves system sections and tool deltas once for legacy transports and budgeting", () => {
	const context: Context = {
		messages: [
			{
				role: "system",
				content: "base",
				sections: { policy: "old", obsolete: "remove" },
				toolsAdded: [tool],
				timestamp: 0,
			},
			user,
			{
				role: "system",
				content: "update",
				sections: { policy: "new", obsolete: null },
				toolsRemoved: [{ name: "inspect" }],
				timestamp: 2,
			},
		],
	};
	const resolved = resolvedRequestContext(context);
	strictEqual(resolved.systemPrompt, getCurrentSystemPrompt(context.messages));
	ok(resolved.systemPrompt?.includes("new"));
	ok(!resolved.systemPrompt?.includes("old"));
	ok(!resolved.systemPrompt?.includes("remove"));
	deepStrictEqual(resolved.tools, []);
	deepStrictEqual(resolved.messages, [user]);
	deepStrictEqual(resolvedRequestContext(resolved), resolved);
	strictEqual(estimateInputTokensFromContext(context), estimateInputTokensFromContext(resolved));
});

test("replay and compiled prompt replacement retain one portable Pi baseline and conversation identity", () => {
	const { agent } = createEngineAgent({ initialState: { systemPrompt: "old", tools: [tool], messages: [user] } });
	setEngineSystemPrompt(agent, "compiled");
	replaceEngineMessages(agent, agent.state.messages);
	setEngineSystemPrompt(agent, "compiled again");
	strictEqual(agent.state.systemPrompt, "compiled again");
	strictEqual(agent.state.messages.filter((message) => message.role === "system").length, 1);
	strictEqual(agent.state.messages[1], user);
	doesNotThrow(() => structuredClone(agent.state.messages));
	const declarations = getCurrentTools(agent.state.messages);
	deepStrictEqual(
		declarations.map(({ name }) => name),
		["inspect"],
	);
	const declaration = declarations[0];
	ok(declaration);
	ok(!("execute" in declaration));
	ok(!("label" in declaration));
	strictEqual(agent.state.tools[0]?.execute, tool.execute);
});

test("native dispatch retains system transcript updates, and continuation uses the rebuilt prompt/tool baseline", async () => {
	const calls: Context[] = [];
	const provider = registerEngineFauxProvider({
		api: "clio-transcript-contract",
		models: [{ id: "fixture" }],
	});
	provider.setResponses([
		fauxAssistantMessage(
			{ type: "toolCall", id: "inspect-1", name: "inspect", arguments: {} },
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	try {
		const { agent } = createEngineAgent({
			initialState: { model: provider.getModel(), systemPrompt: "first", tools: [tool] },
			prepareNextTurn: () => {
				setEngineSystemPrompt(agent, "compacted");
				agent.state.tools = [];
				return { context: { messages: [...agent.state.messages], tools: [] } };
			},
		});
		const nativeStream = agent.streamFunction;
		agent.streamFunction = (model, context, options) => {
			calls.push(structuredClone(context));
			return nativeStream(model, context, options);
		};
		await agent.prompt("inspect");
		strictEqual(calls.length, 2);
		const [initial, continuation] = calls;
		ok(initial && continuation);
		strictEqual(getCurrentSystemPrompt(initial.messages), "first");
		strictEqual(getCurrentSystemPrompt(continuation.messages), "compacted");
		deepStrictEqual(getCurrentTools(continuation.messages), []);
		strictEqual(
			continuation.messages.filter((message) => message.role === "system" && message.content === "compacted").length,
			1,
		);
		ok(continuation.messages.some((message) => message.role === "toolResult"));
		deepStrictEqual(normalizeContext(continuation), continuation);
		strictEqual(agent.state.errorMessage, undefined);
	} finally {
		provider.unregister();
	}
});

test("side questions replace session prompts and tool declarations without changing live history", async () => {
	const provider = registerEngineFauxProvider({ api: "side-transcript-contract", models: [{ id: "fixture" }] });
	try {
		const { agent } = createEngineAgent({
			initialState: { model: provider.getModel(), systemPrompt: "working policy", tools: [tool], messages: [user] },
		});
		const before = structuredClone(agent.state.messages);
		provider.setResponses([
			(context) => {
				strictEqual(getCurrentSystemPrompt(context.messages), SIDE_QUESTION_SYSTEM_PROMPT);
				deepStrictEqual(getCurrentTools(context.messages), []);
				deepStrictEqual(context.messages.filter((message) => message.role === "user").slice(0, -1), [user]);
				return fauxAssistantMessage("side answer");
			},
		]);
		const answer = await runSideQuestion({
			model: agent.state.model,
			messages: agent.state.messages,
			question: "where?",
		});
		strictEqual(answer.text, "side answer");
		deepStrictEqual(agent.state.messages, before);
	} finally {
		provider.unregister();
	}
});
