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
			});
			const ledger = (await call("_clio-coder/context/ledger", { sessionId })) as { usedTokens: number };
			assert.equal(ledger.usedTokens, 20480);
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
