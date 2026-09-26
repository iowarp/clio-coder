import assert from "node:assert/strict";
import { test } from "node:test";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import type { AcpUsageSource } from "../../src/engine/acp/usage.js";

/**
 * `_clio-coder/usage/read`: the terminal's /usage numbers for an ACP client.
 * Session cost and tokens are Clio Coder's own accounting, folded per provider
 * and model the way the overlay folds them, and quota is each provider's own
 * report. Unknown and estimated cost stay flagged; a quota read that fails is
 * reported as failed rather than as an empty plan.
 */
async function peer(usage: AcpUsageSource) {
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

const aggregate = (knownUsd: number, extra: Partial<Record<string, unknown>> = {}) => ({
	knownUsd,
	hasEstimated: false,
	hasUnknown: false,
	allKnownFree: false,
	calls: 1,
	...extra,
});

test("usage reads the session's own accounting per provider and model, and each provider's quota", async () => {
	const agent = await peer({
		session: () => ({
			cost: aggregate(0.42, { calls: 3, hasEstimated: true }),
			rows: [
				{
					providerId: "anthropic",
					attributedModelId: "claude-sonnet-5",
					runs: 2,
					apiCalls: 3,
					tokens: 5200,
					input: 4000,
					output: 1000,
					cacheRead: 150,
					cacheWrite: 50,
					reasoningTokens: 0,
					sideQuestions: 1,
					handoffs: 0,
					prewarms: 0,
					backgroundMemory: 0,
					cost: aggregate(0.42, { calls: 3, hasEstimated: true }),
				},
			],
		}),
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
	});
	try {
		const meta = (agent.init.agentCapabilities as { _meta: Record<string, unknown> })._meta;
		assert.deepEqual(meta["clio-coder/accounting"], { version: 1, read: "_clio-coder/usage/read" });
		const read = await agent.call("_clio-coder/usage/read", { sessionId: agent.sessionId });
		assert.deepEqual(read.session, {
			cost: { knownUsd: 0.42, calls: 3, estimated: true, unknown: false, free: false },
			tokens: 5200,
			rows: [
				{
					provider: "anthropic",
					model: "claude-sonnet-5",
					runs: 2,
					calls: 3,
					tokens: { input: 4000, output: 1000, cacheRead: 150, cacheWrite: 50, reasoning: 0, total: 5200 },
					beside: { sideQuestions: 1, handoffs: 0, prewarms: 0, backgroundMemory: 0 },
					cost: { knownUsd: 0.42, calls: 3, estimated: true, unknown: false, free: false },
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
		session: () => ({ cost: aggregate(0, { calls: 0 }), rows: [] }),
		quota: async () => {
			throw new Error("quota cache locked");
		},
	});
	try {
		const read = await agent.call("_clio-coder/usage/read", { sessionId: agent.sessionId });
		assert.deepEqual(read.quota, { status: "failed", reason: "quota cache locked" });
		assert.deepEqual(read.session, {
			cost: { knownUsd: 0, calls: 0, estimated: false, unknown: false, free: false },
			tokens: 0,
			rows: [],
			truncated: false,
		});
	} finally {
		await agent.stop();
	}
});
