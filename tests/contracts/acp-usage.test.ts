import assert from "node:assert/strict";
import { test } from "node:test";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { TelemetryReadModel } from "../../src/domains/observability/contract.js";
import { sessionUsageTotals } from "../../src/engine/acp/live-telemetry.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import type { AcpUsageSource } from "../../src/engine/acp/usage.js";
import { sessionUsageV1 } from "../../src/engine/acp/usage.js";
import { readModelOf, telemetryCall, telemetryViewOf } from "../harness/telemetry-view.js";

/**
 * `_clio-coder/usage/read`: the terminal's /usage numbers for an ACP client.
 * Session cost and tokens are the telemetry read model's, per target and model
 * as its cost report groups them, and quota is each provider's own report.
 * Unknown and estimated cost stay flagged; a quota read that fails is reported
 * as failed rather than as an empty plan.
 */
async function peer(
	usage: AcpUsageSource,
	telemetryReadModel?: (sessionId: () => string | null) => TelemetryReadModel,
) {
	let bound: string | null = null;
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: () => {},
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
	const served = serveClioAcpAgent({
		transport,
		cwd: process.cwd(),
		autonomy: () => "default",
		usage,
		...(telemetryReadModel ? { telemetryReadModel: telemetryReadModel(() => bound) } : {}),
		chat: {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => false,
			getSessionId: () => null,
		},
	});
	const call = async (method: string, params: unknown) =>
		(await handlers.get(method)?.(params)) as Record<string, unknown>;
	const init = await call("initialize", { protocolVersion: 1 });
	const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	bound = sessionId;
	return {
		init,
		sessionId,
		call,
		stop: async () => {
			close();
			await served;
		},
	};
}

test("usage reads the session's spend per target and model from the read model, and each provider's quota", async () => {
	const at = { targetId: "anthropic", model: "claude-sonnet-5", pricedBy: "catalog" as const };
	// The session's own calls: a main call, a side question, and a System One call whose usage went unreported.
	const own = (sessionId: string): TelemetryRecord[] => [
		...telemetryCall(sessionId, {
			...at,
			usage: { input: 3000, output: 800, cacheRead: 150, cacheWrite: 50 },
			usd: 0.25,
		}),
		...telemetryCall(sessionId, { ...at, label: "btw", usage: { input: 500, output: 100 }, usd: 0.125 }),
		...telemetryCall(sessionId, { ...at, label: "system-one", usage: { input: null, output: null }, usd: null }),
	];
	// One worker run on the same model.
	const worker = telemetryCall("worker", { ...at, label: "worker", usage: { input: 500, output: 100 }, usd: 0.125 });
	const ownRecords = own("usage-session");
	const agent = await peer(
		{
			quota: async () => [
				{
					providerId: "anthropic-max",
					displayName: "Claude Max\u001b[31m",
					status: "ok",
					plan: "Max 5X",
					fetchedAt: "2026-09-26T10:00:00.000Z",
					stale: false,
					windows: [
						{ key: "session", label: "5h", usedPct: 142, resetsAt: "2026-09-26T13:00:00.000Z", active: true },
						{ key: "weekly", label: "Weekly", usedPct: 12.5, resetsAt: null, scope: "Opus" },
					],
				},
				{ providerId: "codex", displayName: "Codex", status: "no_credentials", windows: [], fetchedAt: null },
			],
		},
		(bound) =>
			readModelOf(
				bound,
				() => ownRecords,
				() => new Map([["run-1", worker]]),
			),
	);
	try {
		const meta = (agent.init.agentCapabilities as { _meta: Record<string, unknown> })._meta;
		assert.deepEqual(meta["clio-coder/accounting"], { version: 1, read: "_clio-coder/usage/read" });
		const read = await agent.call("_clio-coder/usage/read", { sessionId: agent.sessionId });
		// The v1 numbers are the known parts; the unreported call rides beside them (#434 §11.3).
		const cost = { display: "~$0.50 +?", knownUsd: 0.5, calls: 4, estimated: true, unknown: true, free: false };
		assert.deepEqual(read.session, {
			cost,
			tokens: 5200,
			missingTokenCalls: 1,
			rows: [
				{
					provider: "anthropic",
					model: "claude-sonnet-5",
					runs: 4,
					calls: 4,
					missingTokenCalls: 1,
					tokens: { input: 4000, output: 1000, cacheRead: 150, cacheWrite: 50, reasoning: 0, total: 5200 },
					beside: { sideQuestions: 1, handoffs: 0, prewarms: 0, backgroundMemory: 0, systemOne: 1, workers: 1 },
					cost,
				},
			],
			truncated: false,
		});
		assert.deepEqual(read.quota, {
			status: "read",
			providers: [
				{
					provider: "anthropic-max",
					name: "Claude Max [31m",
					status: "ok",
					plan: "Max 5X",
					message: null,
					credits: null,
					stale: false,
					fetchedAt: "2026-09-26T10:00:00.000Z",
					retryAfterSeconds: null,
					windows: [
						{ label: "5h", usedPct: 100, resetsAt: "2026-09-26T13:00:00.000Z", scope: null, active: true },
						{ label: "Weekly", usedPct: 12.5, resetsAt: null, scope: "Opus", active: false },
					],
				},
				{
					provider: "codex",
					name: "Codex",
					status: "no_credentials",
					plan: null,
					message: null,
					credits: null,
					stale: false,
					fetchedAt: null,
					retryAfterSeconds: null,
					windows: [],
				},
			],
		});
	} finally {
		await agent.stop();
	}
});

test("a quota read that throws is reported as failed, and the session numbers still come back", async () => {
	const agent = await peer({
		quota: async () => {
			throw new Error("quota cache locked");
		},
	});
	try {
		const read = await agent.call("_clio-coder/usage/read", { sessionId: agent.sessionId });
		assert.deepEqual(read.quota, { status: "failed", reason: "quota cache locked" });
		assert.deepEqual(read.session, {
			cost: { display: "not measured", knownUsd: 0, calls: 0, estimated: false, unknown: false, free: false },
			tokens: 0,
			rows: [],
			truncated: false,
		});
	} finally {
		await agent.stop();
	}
});

test("live accounting distinguishes no calls from measured free calls", () => {
	const empty = sessionUsageTotals(telemetryViewOf("no-calls", []));
	assert.equal(empty.costProvenance, "unknown");
	assert.equal(empty.costDisplay, "not measured");
	const free = sessionUsageTotals(
		telemetryViewOf("free-calls", telemetryCall("free-calls", { usage: { input: 10 }, usd: 0, pricedBy: "free" })),
	);
	assert.equal(free.costProvenance, "known_free");
	assert.equal(free.costDisplay, "$0.00 local");
});

test("a worker run that recorded no call telemetry is named beside the v1 call count, never folded into it as 0", () => {
	const view = telemetryViewOf(
		"lost-run",
		telemetryCall("lost-run", { usage: { input: 10, output: 2 }, usd: 0.01 }),
		new Map([["lost", []]]),
	);
	const read = sessionUsageV1(view);
	assert.equal(read.cost.calls, 1, "the known part");
	assert.equal(read.cost.unknownCallCoverageRuns, 1);
	assert.equal(read.cost.unknown, true);
	const live = sessionUsageTotals(view);
	assert.equal(live.calls, 1);
	assert.equal(live.unknownCallCoverageRuns, 1);
});
