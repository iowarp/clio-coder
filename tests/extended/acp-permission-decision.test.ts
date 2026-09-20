import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

/**
 * An in-memory peer that also plays the client side of
 * `session/request_permission`: the ask is a server-to-client request, so the
 * answer is what this transport returns.
 */
function fakeTransport(answer: (params: Record<string, unknown>) => unknown) {
	const handlers = new Map<string, RequestHandler>();
	const asks: Array<Record<string, unknown>> = [];
	const closeHandlers: Array<() => void> = [];
	let closed = false;
	const transport: AcpJsonRpcPeerTransport = {
		get closed() {
			return closed;
		},
		request: async (method, params) => {
			if (method !== "session/request_permission") throw new Error(`unexpected client request ${method}`);
			const ask = params as Record<string, unknown>;
			asks.push(ask);
			return answer(ask) as never;
		},
		notify: () => {},
		onNotification: () => () => {},
		onRequest: (method, handler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		},
		onClose: (handler) => {
			closeHandlers.push(handler);
			return () => {};
		},
		close: () => {
			closed = true;
			for (const handler of closeHandlers) handler();
		},
	};
	const call = async (method: string, params: unknown): Promise<unknown> => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`no handler registered for ${method}`);
		return await handler(params);
	};
	return { transport, asks, call };
}

/**
 * Drives one turn that parks a real `bash` call on the real registry. Autonomy
 * `suggest` is what makes an execute call ask, so the presentation the bridge
 * attaches is the one the policy actually produced rather than a fixture.
 */
async function askOnce(answer: (params: Record<string, unknown>) => unknown) {
	const safety = createWorkerSafety({ cwd: process.cwd() });
	const registry = createRegistry({ safety, autonomy: () => "suggest" });
	registry.register(bashTool);
	const peer = fakeTransport(answer);
	let verdictKind = "";
	const chat: AcpServerChat = {
		submit: async () => {
			emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } });
			const verdict = await registry.invoke({ tool: "bash", args: { command: "echo hi" } }, { toolCallId: "call-1" });
			verdictKind = verdict.kind;
			emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: verdict, isError: false });
		},
		cancel: () => {},
		onEvent: (handler) => {
			emit = handler;
			return () => {
				emit = () => {};
			};
		},
		isStreaming: () => false,
		getSessionId: () => null,
	};
	let emit: (event: unknown) => void = () => {};
	const served = serveClioAcpAgent({
		transport: peer.transport,
		chat,
		toolRegistry: registry,
		autonomy: () => "suggest",
		cwd: process.cwd(),
	});
	const init = (await peer.call("initialize", { protocolVersion: 1 })) as {
		agentCapabilities: { _meta: Record<string, unknown> };
	};
	const session = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	const prompt = (await peer.call("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "run it" }],
	})) as { stopReason: string };
	peer.transport.close();
	strictEqual(await served, 0);
	return { init, ask: peer.asks[0], prompt, verdictKind };
}

const deny = (): unknown => ({ outcome: { outcome: "selected", optionId: "reject-once" } });

describe("contracts/acp attaches the decision facts it already computed to the permission ask", () => {
	it("offers three options and announces their ids", async () => {
		const turn = await askOnce(deny);
		const options = turn.ask?.options as Array<{ optionId: string; name: string; kind: string }>;
		deepStrictEqual(
			options.map((option) => option.optionId),
			["allow-once", "reject-once", "reject-and-stop"],
		);
		deepStrictEqual(
			options.map((option) => option.kind),
			["allow_once", "reject_once", "reject_once"],
		);
		// The third option's label is the classifier's own `stop` action, not a
		// string invented at this seam.
		strictEqual(options[2]?.name, "Deny and stop");
		deepStrictEqual(turn.init.agentCapabilities._meta["clio-coder/decision"], {
			version: 1,
			meta: "clio-coder/decision",
			options: ["allow-once", "reject-once", "reject-and-stop"],
		});
	});

	it("carries the tier, the copy, and the call target the ask used to discard", async () => {
		const turn = await askOnce(deny);
		const meta = (turn.ask?._meta as Record<string, Record<string, unknown>>)["clio-coder/decision"] ?? {};
		strictEqual(meta.version, 1);
		strictEqual(meta.tier, "workspace");
		strictEqual(meta.tierLabel, "Workspace authority");
		strictEqual(meta.semanticToken, "action");
		strictEqual(meta.actionClass, "execute");
		deepStrictEqual(meta.axis, { kind: "autonomy", level: "suggest" });
		deepStrictEqual(meta.origin, { kind: "main" });
		strictEqual(meta.exposure, "local");
		strictEqual(meta.reversibility, "limited");
		ok(String(meta.authorizationCopy).includes("one execute call to bash"));
		ok(String(meta.consequenceCopy).length > 0);
		ok(String(meta.reversibilityCopy).startsWith("Reversible:"));
		ok(String(meta.requestedByCopy).includes("autonomy level (suggest)"));
		ok(String(meta.target).includes("echo hi"));
	});

	it("denies the whole turn on reject-and-stop instead of only the request in front of the operator", async () => {
		const turn = await askOnce(() => ({ outcome: { outcome: "selected", optionId: "reject-and-stop" } }));
		strictEqual(turn.verdictKind, "blocked");
		strictEqual(turn.prompt.stopReason, "cancelled");
	});

	it("still denies only the presented request on reject-once", async () => {
		const turn = await askOnce(deny);
		strictEqual(turn.verdictKind, "blocked");
		strictEqual(turn.prompt.stopReason, "end_turn");
	});
});
