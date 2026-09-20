import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

/** An in-memory peer: the test plays the client and calls the server's handlers directly. */
function fakeTransport() {
	const handlers = new Map<string, RequestHandler>();
	const notifications: Array<{ method: string; params: unknown }> = [];
	const closeHandlers: Array<() => void> = [];
	let closed = false;
	const transport: AcpJsonRpcPeerTransport = {
		get closed() {
			return closed;
		},
		request: async () => {
			throw new Error("the server sends no client requests in this test");
		},
		notify: (method, params) => {
			notifications.push({ method, params });
		},
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
	return { transport, notifications, call };
}

const chat: AcpServerChat = {
	submit: async () => {},
	cancel: () => {},
	onEvent: () => () => {},
	isStreaming: () => false,
	getSessionId: () => null,
};

const HEALTH_KINDS = ["compaction.end", "context.warning", "safety.toolBudgetExceeded", "provider.health"];

function eventsOf(peer: ReturnType<typeof fakeTransport>): Array<Record<string, unknown>> {
	return peer.notifications
		.filter((entry) => entry.method === "clio-coder/event")
		.map((entry) => entry.params as Record<string, unknown>);
}

async function openSession(kinds: ReadonlyArray<string>) {
	const bus = createSafeEventBus();
	const peer = fakeTransport();
	const served = serveClioAcpAgent({ transport: peer.transport, chat, bus, cwd: process.cwd() });
	const init = (await peer.call("initialize", {
		protocolVersion: 1,
		clientCapabilities: { _meta: { "clio-coder/events": { version: 1, kinds: [...kinds] } } },
	})) as { agentCapabilities: { _meta: Record<string, { kinds: string[] }> } };
	const session = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	return { bus, peer, served, init, sessionId: session.sessionId };
}

describe("contracts/acp forwards the four session-health kinds", () => {
	it("announces all eleven kinds and keeps each one the engine's own bus channel name", async () => {
		const { peer, served, init } = await openSession(HEALTH_KINDS);
		const announced = init.agentCapabilities._meta["clio-coder/events"]?.kinds ?? [];
		strictEqual(announced.length, 11);
		for (const kind of HEALTH_KINDS) ok(announced.includes(kind), `${kind} is not announced`);
		// The bus channel table is the vocabulary; a renamed kind would hide the
		// producer from anyone grepping a captured frame.
		strictEqual(BusChannels.CompactionEnd, "compaction.end");
		strictEqual(BusChannels.ContextWarning, "context.warning");
		strictEqual(BusChannels.ToolBudgetExceeded, "safety.toolBudgetExceeded");
		strictEqual(BusChannels.ProviderHealth, "provider.health");
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("forwards compaction and a context warning with its clearing edge intact", async () => {
		const { bus, peer, served, sessionId } = await openSession(HEALTH_KINDS);
		bus.emit(BusChannels.CompactionEnd, { trigger: "threshold", at: Date.now() });
		bus.emit(BusChannels.ContextWarning, { warning: "Context window is 85% full." });
		bus.emit(BusChannels.ContextWarning, { warning: null });

		const events = eventsOf(peer);
		strictEqual(events.length, 3);
		strictEqual(events[0]?.kind, "compaction.end");
		strictEqual(events[0]?.sessionId, sessionId);
		strictEqual(events[0]?.terminal, false);
		// `at` is a producer timestamp the client would only re-stamp on arrival.
		deepStrictEqual(events[0]?.payload, { trigger: "threshold" });
		deepStrictEqual(events[1]?.payload, { warning: "Context window is 85% full." });
		// The clear has to cross as itself, or a client's banner never comes down.
		deepStrictEqual(events[2]?.payload, { warning: null });
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("drops a tool-budget event outside a turn and marks the hard ceiling terminal", async () => {
		const { bus, peer, served } = await openSession(HEALTH_KINDS);
		const budget = { tool: "bash", callsThisTurn: 41, softBudget: 40, hardCeiling: 60, at: Date.now() };
		// No prompt is running here, and the budget it names is per-turn.
		bus.emit(BusChannels.ToolBudgetExceeded, { ...budget, interrupted: false });
		strictEqual(eventsOf(peer).length, 0);
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("keeps provider prose behind and forwards only the health taxonomy", async () => {
		const { bus, peer, served } = await openSession(HEALTH_KINDS);
		bus.emit(BusChannels.ProviderHealth, {
			id: "local-lmstudio",
			status: {
				available: true,
				reason: "",
				health: {
					status: "degraded",
					lastCheckAt: "2026-01-01T00:00:00.000Z",
					lastError: 'HTTP 500: {"key":"sk-must-not-cross"}',
					latencyMs: 812,
				},
			},
		} as never);
		const events = eventsOf(peer);
		strictEqual(events.length, 1);
		deepStrictEqual(events[0]?.payload, {
			targetId: "local-lmstudio",
			status: "degraded",
			available: true,
			latencyMs: 812,
		});
		ok(!JSON.stringify(events[0]).includes("sk-must-not-cross"));
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("sends nothing to a client that opted into the dispatch kinds only", async () => {
		const { bus, peer, served } = await openSession(["dispatch.completed"]);
		bus.emit(BusChannels.CompactionEnd, { trigger: "threshold", at: Date.now() });
		bus.emit(BusChannels.ContextWarning, { warning: "close to full" });
		bus.emit(BusChannels.ProviderHealth, {
			id: "t",
			status: {
				available: false,
				reason: "",
				health: { status: "down", lastCheckAt: null, lastError: null, latencyMs: null },
			},
		} as never);
		strictEqual(eventsOf(peer).length, 0);
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("drops a health event whose identity cannot be represented instead of repairing it", async () => {
		const { bus, peer, served } = await openSession(HEALTH_KINDS);
		bus.emit(BusChannels.CompactionEnd, { trigger: "thresh\u0007old", at: Date.now() });
		bus.emit(BusChannels.ProviderHealth, {
			id: "target",
			status: {
				available: true,
				reason: "",
				health: { status: "sideways", lastCheckAt: null, lastError: null, latencyMs: null },
			},
		} as never);
		strictEqual(eventsOf(peer).length, 0);
		peer.transport.close();
		strictEqual(await served, 0);
	});
});
