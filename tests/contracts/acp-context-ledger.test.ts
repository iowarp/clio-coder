import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextLedger } from "../../src/domains/session/context-ledger.js";
import { projectContextLedger } from "../../src/engine/acp/context-ledger.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

const LEDGER: ContextLedger = {
	provider: "mini",
	model: "gemma",
	contextWindow: 131072,
	contextWindowSource: "loaded",
	contextWindowSlots: { totalContextSize: 524288, slots: 4 },
	usedTokens: 20480,
	reserveTokens: 16384,
	freeTokens: 94208,
	percent: 15.625,
	measured: true,
	compactionThreshold: 0.8,
	compactionAuto: true,
	projectPreload: "handbook",
	projectHandbookFiles: ["CLIO-CODER.md"],
	toolCount: 14,
	groups: [
		{ category: "system", label: "System prompt", tokens: 4096, percent: 3.125 },
		{ category: "messages", label: "Conversation", tokens: 16384, percent: 12.5 },
	],
	meter: [],
	lastCompaction: { stage: "summary", tokensBefore: 90000, tokensAfter: 12000, trigger: "auto" },
	promptCache: {
		shellReused: true,
		cacheReadTokens: 8000,
		cacheWriteTokens: null,
		uncachedInputTokens: 400,
		backend: null,
		uncachedPrefillTokens: null,
		backendVerdict: "hot",
	},
	prewarm: null,
};

test("the context ledger projection keeps the accounting and keeps unknown unknown", () => {
	const projected = projectContextLedger(LEDGER);
	assert.equal(projected.usedTokens, 20480);
	assert.equal(projected.measured, true);
	assert.deepEqual(projected.contextWindowSlots, { slots: 4, totalTokens: 524288 });
	assert.deepEqual(
		projected.groups.map((group) => [group.category, group.tokens]),
		[
			["system", 4096],
			["messages", 16384],
		],
	);
	assert.equal(projected.promptCache?.backendVerdict, "hot");
	const unknown = projectContextLedger({
		...LEDGER,
		contextWindow: 0,
		percent: null,
		measured: false,
		contextWindowSlots: null,
		promptCache: null,
		lastCompaction: null,
		groups: Array.from({ length: 40 }, (_, index) => ({
			category: "messages" as const,
			label: `group ${index}\u0007`,
			tokens: Number.NaN,
			percent: null,
		})),
	});
	assert.equal(unknown.contextWindow, 0);
	assert.equal(unknown.percent, null, "an unknown window is not zero percent");
	assert.equal(unknown.measured, false);
	assert.equal(unknown.groups.length, 32);
	assert.ok(unknown.groups.every((group) => group.tokens === 0 && !group.label.includes("\u0007")));
});

test("the ledger method answers for the bound session and is absent without a ledger source", async () => {
	for (const wired of [true, false]) {
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
			...(wired ? { contextLedger: () => LEDGER } : {}),
			chat: {
				submit: async () => {},
				cancel: () => {},
				onEvent: () => () => {},
				isStreaming: () => false,
				getSessionId: () => null,
			},
		});
		const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
		const init = (await call("initialize", { protocolVersion: 1 })) as {
			agentCapabilities: { _meta: Record<string, unknown> };
		};
		const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
		if (wired) {
			assert.deepEqual(init.agentCapabilities._meta["clio-coder/context"], {
				version: 1,
				ledger: "_clio-coder/context/ledger",
				status: "_clio-coder/context/status",
			});
			const ledger = (await call("_clio-coder/context/ledger", { sessionId })) as { usedTokens: number };
			assert.equal(ledger.usedTokens, 20480);
			assert.deepEqual(await call("_clio-coder/context/status", { sessionId }), {
				version: 1,
				active: null,
				latest: null,
			});
		} else {
			assert.equal(init.agentCapabilities._meta["clio-coder/context"], undefined);
			await assert.rejects(
				call("_clio-coder/context/ledger", { sessionId }),
				(error: unknown) => error instanceof AcpRequestError && error.detail.code === "method_not_found",
			);
		}
		close();
		await served;
	}
});

test("a long turn streams usage_update per model response with the meter rising and totals matching the response", async () => {
	const handlers = new Map<string, (params: unknown) => unknown>();
	const updates: Array<Record<string, unknown>> = [];
	let close: () => void = () => {};
	let onEvent: (event: unknown) => void = () => {};
	let used = 1000;
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push((params as { update: Record<string, unknown> }).update);
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
	const response = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 100, output: 20, cacheRead: 50, totalTokens: 170, cost: { total: 0.25 }, costProvenance: "known" },
	});
	const served = serveClioAcpAgent({
		transport,
		cwd: process.cwd(),
		autonomy: () => "default",
		contextLedger: () => ({ ...LEDGER, usedTokens: used }),
		usage: {
			session: () => ({
				cost: { knownUsd: 1, hasEstimated: false, hasUnknown: false, allKnownFree: false, calls: 2 },
				rows: [],
			}),
			quota: async () => [],
		},
		chat: {
			submit: async () => {
				for (const text of ["one", "two", "three"]) {
					used += 4000;
					onEvent({ type: "message_end", message: response(text) });
					await new Promise((resolve) => setImmediate(resolve));
				}
				// A burst in one tick is one frame.
				used += 4000;
				onEvent({ type: "message_end", message: response("four") });
				onEvent({ type: "message_end", message: response("five") });
			},
			cancel: () => {},
			onEvent: (handler) => {
				onEvent = handler;
				return () => {
					onEvent = () => {};
				};
			},
			isStreaming: () => false,
			getSessionId: () => null,
		},
	});
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", { protocolVersion: 1 });
	const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	assert.equal(updates.filter((update) => update.sessionUpdate === "usage_update").length, 0, "a new session is quiet");
	const result = (await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })) as {
		_meta: Record<string, unknown>;
	};
	const frames = updates.filter((update) => update.sessionUpdate === "usage_update") as Array<{
		used: number;
		size: number;
		cost?: { amount: number; currency: string };
		_meta: Record<string, Record<string, unknown>>;
	}>;
	assert.deepEqual(
		frames.map((frame) => frame.used),
		[5000, 9000, 13000, 17000],
	);
	assert.ok(frames.every((frame) => frame.size === 131072));
	assert.equal(frames[0]?._meta["clio-coder/context"]?.compactionThreshold, 0.8);
	const last = frames.at(-1);
	const { session, ...turn } = last?._meta["clio-coder/usage"] ?? {};
	assert.deepEqual(turn, result._meta["clio-coder/usage"]);
	assert.equal((turn as { output: number }).output, 100);
	assert.deepEqual(session, {
		input: 500,
		output: 100,
		cacheRead: 250,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 850,
		costUsd: 2.25,
		costProvenance: "known",
	});
	assert.deepEqual(last?.cost, { amount: 2.25, currency: "USD" });
	close();
	await served;
});
