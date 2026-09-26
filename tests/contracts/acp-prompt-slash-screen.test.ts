import assert from "node:assert/strict";
import { test } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

const refuse = (member: string) =>
	new Proxy(
		{},
		{
			get() {
				throw new Error(`test host: ${member} was reached`);
			},
		},
	);

/**
 * A `/name` line typed into an ACP prompt is screened the way the terminal's
 * editor screens it: a loaded prompt template or plain text goes to the model,
 * a command-shaped token nothing owns is refused, and nothing reaches the model
 * for either refusal. Before this, `/model gpt` and `/tpyo` were sent to the
 * model as prose.
 */
async function peer() {
	const submitted: string[] = [];
	const updates: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push(params as Record<string, unknown>);
		},
		onNotification: () => () => {},
		onRequest: (method, handler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const chat: AcpServerChat = {
		submit: async (text) => {
			submitted.push(text);
		},
		whenSettled: async () => {},
		cancel: () => {},
		onEvent: () => () => {},
		isStreaming: () => false,
		getSessionId: () => null,
	};
	const commands = acpCommandControl({
		dispatch: refuse("dispatch") as AcpCommandHost["dispatch"],
		bus: createSafeEventBus(),
		providers: refuse("providers") as AcpCommandHost["providers"],
		runDoctor: async () => ({ level: "info", text: "ok" }),
		listPromptNames: () => ["review-pr", "cheatsheet", "locked"],
		expandPromptTemplate: (text) => {
			if (text.startsWith("/review-pr")) return { expanded: true };
			if (text.startsWith("/cheatsheet"))
				return { expanded: false, display: { template: { name: "cheatsheet" }, text: "Keys:\nctrl+o opens output" } };
			if (text.startsWith("/locked"))
				return {
					expanded: false,
					refusal: { message: "/locked needs a trusted project before it can expand" },
				};
			return { expanded: false };
		},
	});
	const served = serveClioAcpAgent({ transport, chat, commands, autonomy: () => "default", cwd: process.cwd() });
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", { protocolVersion: 1 });
	const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	const prompt = (text: string) => call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
	return {
		call,
		prompt,
		submitted,
		updates,
		stop: async () => {
			close();
			await served;
		},
	};
}

const refusedWith = (code: string, message: RegExp) => (error: unknown) =>
	error instanceof AcpRequestError && error.detail.code === code && message.test(error.message);

test("an unowned command-shaped token is refused and never reaches the model", async () => {
	const agent = await peer();
	try {
		await assert.rejects(agent.prompt("/tpyo fix the build"), refusedWith("unknown_command", /\/tpyo is not a command/));
		await assert.rejects(
			agent.prompt("/model gpt-5"),
			refusedWith("command_unavailable", /\/model is a terminal command/),
		);
		await assert.rejects(agent.prompt("/locked"), refusedWith("unknown_command", /needs a trusted project/));
		assert.deepEqual(agent.submitted, []);
	} finally {
		await agent.stop();
	}
});

test("templates, escaped slashes and paths still reach the model", async () => {
	const agent = await peer();
	try {
		await agent.prompt("/review-pr 42");
		await agent.prompt("\\/tmp is full again");
		await agent.prompt("/home/user/notes.md explains the layout");
		await agent.prompt("why does this fail?");
		assert.deepEqual(agent.submitted, [
			"/review-pr 42",
			"/tmp is full again",
			"/home/user/notes.md explains the layout",
			"why does this fail?",
		]);
	} finally {
		await agent.stop();
	}
});

test("a display-only template answers the operator and starts no turn", async () => {
	const agent = await peer();
	try {
		const result = (await agent.prompt("/cheatsheet")) as { stopReason: string };
		assert.equal(result.stopReason, "end_turn");
		assert.deepEqual(agent.submitted, []);
		const text = agent.updates
			.map((row) => row.update as { sessionUpdate: string; content?: { text?: string } })
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => update.content?.text ?? "")
			.join("");
		assert.match(text, /\/cheatsheet[\s\S]*ctrl\+o opens output/);
	} finally {
		await agent.stop();
	}
});

test("the command list names the prompt templates a composer can accept", async () => {
	const agent = await peer();
	try {
		const listed = (await agent.call("_clio-coder/commands/list", {})) as { prompts?: string[] };
		assert.deepEqual(listed.prompts, ["review-pr", "cheatsheet", "locked"]);
	} finally {
		await agent.stop();
	}
});
