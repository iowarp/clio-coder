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

const EVIDENCE = {
	runId: "run-7",
	evidenceId: "ev-7",
	firstPassSuccess: true,
	findingCount: 2,
	tags: ["validated", "lint"],
};

function eventsOf(peer: ReturnType<typeof fakeTransport>): Array<Record<string, unknown>> {
	return peer.notifications
		.filter((entry) => entry.method === "clio-coder/event")
		.map((entry) => entry.params as Record<string, unknown>);
}

describe("contracts/acp forwards accountability.evidenceReady only to a client that opted in", () => {
	it("advertises the kind, forwards the projection's evidence summary verbatim, and marks it terminal", async () => {
		const bus = createSafeEventBus();
		const peer = fakeTransport();
		const served = serveClioAcpAgent({ transport: peer.transport, chat, bus, cwd: process.cwd() });
		const init = (await peer.call("initialize", {
			protocolVersion: 1,
			clientCapabilities: { _meta: { "clio-coder/events": { version: 1, kinds: ["accountability.evidenceReady"] } } },
		})) as { agentCapabilities: { _meta: Record<string, { kinds: string[] }> } };
		ok(init.agentCapabilities._meta["clio-coder/events"]?.kinds.includes("accountability.evidenceReady"));
		const session = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };

		bus.emit(BusChannels.AccountabilityEvidenceReady, EVIDENCE);
		// Tags that are not bounded identifiers (a control character, over 64
		// bytes) are dropped, never truncated into new ones.
		bus.emit(BusChannels.AccountabilityEvidenceReady, {
			...EVIDENCE,
			runId: "run-8",
			tags: ["ok", "bad\u0007tag", "x".repeat(65)],
		});

		const events = eventsOf(peer);
		strictEqual(events.length, 2);
		const first = events[0] ?? {};
		strictEqual(first.kind, "accountability.evidenceReady");
		strictEqual(first.sessionId, session.sessionId);
		strictEqual(first.terminal, true);
		strictEqual(first.turnId, null);
		deepStrictEqual(first.payload, EVIDENCE);
		const second = events[1]?.payload as { tags: string[] };
		deepStrictEqual(second.tags, ["ok"]);

		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("sends nothing to a client that opted into the dispatch kinds but not this one", async () => {
		const bus = createSafeEventBus();
		const peer = fakeTransport();
		const served = serveClioAcpAgent({ transport: peer.transport, chat, bus, cwd: process.cwd() });
		await peer.call("initialize", {
			protocolVersion: 1,
			clientCapabilities: { _meta: { "clio-coder/events": { version: 1, kinds: ["dispatch.completed"] } } },
		});
		await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] });
		bus.emit(BusChannels.AccountabilityEvidenceReady, EVIDENCE);
		strictEqual(eventsOf(peer).length, 0);
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("drops an event whose run or evidence id cannot be represented instead of repairing it", async () => {
		const bus = createSafeEventBus();
		const peer = fakeTransport();
		const served = serveClioAcpAgent({ transport: peer.transport, chat, bus, cwd: process.cwd() });
		await peer.call("initialize", {
			protocolVersion: 1,
			clientCapabilities: { _meta: { "clio-coder/events": { version: 1, kinds: ["accountability.evidenceReady"] } } },
		});
		await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] });
		bus.emit(BusChannels.AccountabilityEvidenceReady, { ...EVIDENCE, evidenceId: "ev\u001bid" });
		strictEqual(eventsOf(peer).length, 0);
		peer.transport.close();
		strictEqual(await served, 0);
	});
});
