import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
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

const HEALTH_KINDS = [
	"compaction.ended",
	"context.warning_raised",
	"safety.tool_budget_exceeded",
	"provider.health_changed",
];

function eventsOf(peer: ReturnType<typeof fakeTransport>): Array<Record<string, unknown>> {
	return peer.notifications
		.filter((entry) => entry.method === "_clio-coder/event")
		.map((entry) => entry.params as Record<string, unknown>);
}

async function openSession(kinds: ReadonlyArray<string>) {
	const bus = createTelemetryHub();
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
	it("announces all fourteen kinds and keeps each one the engine's own bus channel name", async () => {
		const { peer, served, init } = await openSession(HEALTH_KINDS);
		const announced = init.agentCapabilities._meta["clio-coder/events"]?.kinds ?? [];
		strictEqual(announced.length, 14);
		ok(announced.includes("job.changed"));
		for (const kind of HEALTH_KINDS) ok(announced.includes(kind), `${kind} is not announced`);
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("forwards compaction and a context warning with its clearing edge intact", async () => {
		const { bus, peer, served, sessionId } = await openSession(HEALTH_KINDS);
		bus.emit("compaction.ended", { trigger: "threshold", at: Date.now() });
		bus.emit("context.warning_raised", { warning: "Context window is 85% full." });
		bus.emit("context.warning_raised", { warning: null });

		const events = eventsOf(peer);
		strictEqual(events.length, 3);
		strictEqual(events[0]?.kind, "compaction.ended");
		strictEqual(events[0]?.sessionId, sessionId);
		strictEqual(events[0]?.terminal, false);
		// `at` is a producer timestamp the client would only re-stamp on arrival.
		deepStrictEqual(events[0]?.payload, { trigger: "threshold" });
		deepStrictEqual(events[1]?.payload, { warning: "Context window is 85% full." });
		// The clear has to cross as itself, or a client's banner never comes down.
		deepStrictEqual(events[2]?.payload, { warning: null });
		for (const outcome of ["completed", "unchanged", "failed", "cancelled"] as const) {
			bus.emit("compaction.ended", { trigger: "threshold", at: Date.now(), outcome });
			deepStrictEqual(eventsOf(peer).at(-1)?.payload, { trigger: "threshold", outcome });
		}
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("forwards a dispatch scope notice as its code and message, without the path list", async () => {
		const { bus, peer, served } = await openSession([...HEALTH_KINDS, "run.scope_notice_raised"]);
		const message = '[dispatch scope] intent.write_roots "." names the whole workspace, so it sets no write boundary.';
		bus.emit("run.scope_notice_raised", { code: "write_root_dot_unconfined", level: "warning", message });
		bus.emit("run.scope_notice_raised", {
			code: "legacy_scope_inferred",
			level: "warning",
			agentId: "scout",
			paths: [{ path: "../x", policy: "working-context", provenance: "inferred", source: "task", confidence: "low" }],
			message: "[dispatch scope] a path token was resolved.",
		});
		// A payload that is not a scope notice crosses nothing.
		bus.emit("run.scope_notice_raised", { code: "made_up", level: "warning", message: "x" } as never);
		const events = eventsOf(peer);
		strictEqual(events.length, 2);
		strictEqual(events[0]?.kind, "run.scope_notice_raised");
		deepStrictEqual(events[0]?.payload, { code: "write_root_dot_unconfined", level: "warning", message });
		deepStrictEqual(events[1]?.payload, {
			code: "legacy_scope_inferred",
			level: "warning",
			message: "[dispatch scope] a path token was resolved.",
		});
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("drops a tool-budget event outside a turn and marks the hard ceiling terminal", async () => {
		const { bus, peer, served } = await openSession(HEALTH_KINDS);
		const budget = { tool: "bash", callsThisTurn: 41, softBudget: 40, hardCeiling: 60, at: Date.now() };
		// No prompt is running here, and the budget it names is per-turn.
		bus.emit("safety.tool_budget_exceeded", { ...budget, interrupted: false });
		strictEqual(eventsOf(peer).length, 0);
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("keeps provider prose behind and forwards only the health taxonomy", async () => {
		const { bus, peer, served } = await openSession(HEALTH_KINDS);
		bus.emit("provider.health_changed", {
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
		bus.emit("provider.health_changed", {
			id: "local-lmstudio",
			status: {
				available: false,
				reason: "",
				health: { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null },
			},
		} as never);
		deepStrictEqual(eventsOf(peer).at(-1)?.payload, {
			targetId: "local-lmstudio",
			status: "unknown",
			available: false,
			latencyMs: null,
		});
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("sends nothing to a client that opted into the dispatch kinds only", async () => {
		const { bus, peer, served } = await openSession(["run.completed"]);
		bus.emit("compaction.ended", { trigger: "threshold", at: Date.now() });
		bus.emit("context.warning_raised", { warning: "close to full" });
		bus.emit("provider.health_changed", {
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
		bus.emit("compaction.ended", { trigger: "thresh\u0007old", at: Date.now() });
		bus.emit("provider.health_changed", {
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

it("forwards bounded failure codes and reasons for withheld and idle workers", async () => {
	const { bus, peer, served } = await openSession(["run.failed"]);
	for (const outcomeCode of ["worker_no_work", "merge_withheld"] as const) {
		bus.emit("run.failed", {
			runId: outcomeCode,
			agentId: "coder",
			targetId: "fixture",
			wireModelId: "fixture",
			runtimeId: "fixture",
			runtimeKind: "http",
			requestOrigin: "agent",
			outcome: "failed",
			reason: "failed",
			outcomeCode,
			outcomeDetail: `Host check also fails on base abc; branch preserved. ${"x".repeat(4000)}`,
		});
	}
	const events = eventsOf(peer);
	deepStrictEqual(
		events.map((event) => (event.payload as Record<string, unknown>).outcomeCode),
		["worker_no_work", "merge_withheld"],
	);
	for (const event of events) {
		const detail = (event.payload as { outcomeDetail: string }).outcomeDetail;
		ok(detail.startsWith("Host check also fails on base abc; branch preserved."));
		ok(Buffer.byteLength(detail) <= 2048);
	}
	peer.transport.close();
	strictEqual(await served, 0);
});

it("words a finished run's tokens with its call coverage, never a partly counted run as whole (#434 §11.3)", async () => {
	const { bus, peer, served } = await openSession(["run.completed"]);
	const completed = (runId: string, coverage: Record<string, number>) =>
		bus.emit("run.completed", {
			runId,
			agentId: "coder",
			targetId: "fixture",
			wireModelId: "fixture",
			runtimeId: "fixture",
			runtimeKind: "http",
			requestOrigin: "agent",
			outcome: "succeeded",
			outcomeCode: null,
			outcomeDetail: null,
			durationMs: 10,
			tokenCount: 1_200,
			...coverage,
		} as never);
	completed("partial", { apiCalls: 3, missingTokenCalls: 1 });
	completed("whole", { apiCalls: 3, missingTokenCalls: 0 });
	completed("legacy", {});
	deepStrictEqual(
		eventsOf(peer).map((event) => {
			const { apiCalls, missingTokenCalls, tokenDisplay } = event.payload as Record<string, unknown>;
			return { apiCalls, missingTokenCalls, tokenDisplay };
		}),
		[
			{ apiCalls: 3, missingTokenCalls: 1, tokenDisplay: "≥1,200 (1 call unknown)" },
			{ apiCalls: 3, missingTokenCalls: 0, tokenDisplay: "1,200" },
			{ apiCalls: null, missingTokenCalls: null, tokenDisplay: "≥1,200 (call coverage not recorded)" },
		],
	);
	peer.transport.close();
	strictEqual(await served, 0);
});
