import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { createHostToolEvents, runHostDispatch } from "../../src/engine/acp/host-members.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

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
 * `/council` over ACP: the council is the dispatch call a model would make,
 * announced in the prompt turn so its plan approval binds to a call the client
 * can see. The dispatch tool is a stub; admission, the park and the bridge are
 * the real ones.
 */
async function councilPeer(answer: "allow-once" | "reject-once") {
	const safety = createWorkerSafety({ cwd: process.cwd() });
	const registry = createRegistry({ safety, autonomy: () => "default" });
	const runs: Array<Record<string, unknown>> = [];
	const dispatchStub: ToolSpec = {
		name: ToolNames.Dispatch,
		description: "stub dispatch",
		parameters: Type.Object({}, { additionalProperties: true }),
		baseActionClass: "dispatch",
		async run(args) {
			runs.push(args);
			return { kind: "ok", output: "council dispatched: 2 members" };
		},
	};
	registry.register(dispatchStub);
	const hostEvents = createHostToolEvents();
	const commands = acpCommandControl({
		dispatch: refuse("dispatch") as AcpCommandHost["dispatch"],
		bus: createSafeEventBus(),
		providers: refuse("providers") as AcpCommandHost["providers"],
		isTurnInFlight: () => false,
		getWorkerRosters: () => ({ review: [{ target: "mini", model: "gemma" }] }) as never,
		runCouncilDispatch: (args) => runHostDispatch(registry, hostEvents, args),
	});
	const updates: Array<Record<string, unknown>> = [];
	const asks: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async (method, params) => {
			if (method !== "session/request_permission") throw new Error(`unexpected ${method}`);
			asks.push(params as Record<string, unknown>);
			return { outcome: { outcome: "selected", optionId: answer } } as never;
		},
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
		submit: async () => {},
		whenSettled: async () => {},
		cancel: () => {},
		onEvent: () => () => {},
		isStreaming: () => false,
		getSessionId: () => null,
	};
	const served = serveClioAcpAgent({
		transport,
		chat,
		commands,
		toolRegistry: registry,
		hostToolEvents: hostEvents,
		autonomy: () => "default",
		cwd: process.cwd(),
	});
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", { protocolVersion: 1 });
	const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	return {
		sessionId,
		call,
		updates,
		asks,
		runs,
		stop: async () => {
			close();
			await served;
		},
	};
}

const toolCalls = (updates: ReadonlyArray<Record<string, unknown>>) =>
	updates
		.map((row) => row.update as Record<string, unknown>)
		.filter((update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update");

test("a council sent as a prompt shows its dispatch call and binds the plan approval to it", async () => {
	const peer = await councilPeer("allow-once");
	try {
		const catalog = (await peer.call("_clio-coder/commands/list", {})) as { commands: Array<Record<string, unknown>> };
		assert.equal(catalog.commands.find((row) => row.name === "council")?.promptTurn, true);
		const result = (await peer.call("session/prompt", {
			sessionId: peer.sessionId,
			prompt: [{ type: "text", text: "/council --roster review Compare the two soil samples" }],
		})) as { stopReason: string };
		assert.equal(result.stopReason, "end_turn");
		const calls = toolCalls(peer.updates);
		const opened = calls.find((update) => update.sessionUpdate === "tool_call");
		assert.equal(opened?.title, "dispatch");
		assert.deepEqual((opened?.rawInput as Record<string, unknown>)?.mode, "council");
		assert.equal(peer.asks.length, 1, "the plan-scale council parked for one approval");
		const ask = peer.asks[0] as { toolCall: { toolCallId: string }; _meta: Record<string, { topology?: string }> };
		assert.equal(ask.toolCall.toolCallId, opened?.toolCallId, "the approval names the call the client was shown");
		assert.equal(ask._meta["clio-coder/dispatchPlan"]?.topology, "council");
		assert.equal(peer.runs.length, 1, "an approved council runs once");
		const settled = calls.find((update) => update.sessionUpdate === "tool_call_update");
		assert.equal(settled?.status, "completed");
	} finally {
		await peer.stop();
	}
});

test("a denied council runs nothing and says so, and invoking it outside a prompt is refused", async () => {
	const peer = await councilPeer("reject-once");
	try {
		await peer.call("session/prompt", {
			sessionId: peer.sessionId,
			prompt: [{ type: "text", text: "/council --roster review Compare the two soil samples" }],
		});
		assert.equal(peer.runs.length, 0);
		const text = peer.updates
			.map((row) => row.update as { sessionUpdate?: string; content?: { text?: string } })
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => update.content?.text ?? "")
			.join("");
		assert.match(text, /\/council was not admitted/);
		assert.equal(toolCalls(peer.updates).find((update) => update.sessionUpdate === "tool_call_update")?.status, "failed");
		await assert.rejects(
			peer.call("_clio-coder/commands/invoke", {
				sessionId: peer.sessionId,
				command: "council",
				argv: ["--roster", "review", "Compare"],
			}),
			(error: unknown) => error instanceof AcpRequestError && error.detail.code === "prompt_turn_required",
		);
	} finally {
		await peer.stop();
	}
});
