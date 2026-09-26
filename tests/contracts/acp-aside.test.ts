import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcpAsideControl } from "../../src/engine/acp/aside.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

/**
 * `/btw` and `/draft` over ACP: out-of-turn rounds that answer the operator
 * and never enter the session. The server owns one round at a time, lets the
 * client cancel it, and reports refusals as the chat loop words them.
 */
async function peer(aside: AcpAsideControl) {
	const handlers = new Map<string, (params: unknown) => unknown>();
	const updates: unknown[] = [];
	let close: () => void = () => {};
	let streaming = false;
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push(params);
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
	const served = serveClioAcpAgent({
		transport,
		cwd: process.cwd(),
		autonomy: () => "default",
		aside,
		chat: {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => streaming,
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
		updates,
		set streaming(value: boolean) {
			streaming = value;
		},
		stop: async () => {
			close();
			await served;
		},
	};
}

test("a side question is announced, answered beside the session, and bounded", async () => {
	const asked: string[] = [];
	const agent = await peer({
		ask: async (question) => {
			asked.push(question);
			return { status: "answered", text: `It landed in src/report.ts.\u0007${"x".repeat(70 * 1024)}` };
		},
		draft: async () => ({ status: "refused", reason: "unused" }),
	});
	try {
		const meta = (agent.init.agentCapabilities as { _meta: Record<string, unknown> })._meta;
		assert.deepEqual(meta["clio-coder/aside"], {
			version: 1,
			ask: "_clio-coder/aside/ask",
			draft: "_clio-coder/aside/draft",
			cancel: "_clio-coder/aside/cancel",
			draftCounts: { min: 1, max: 4, default: 3 },
		});
		const answer = (await agent.call("_clio-coder/aside/ask", {
			sessionId: agent.sessionId,
			question: "  which file did the report land in?  ",
		})) as { status: string; text: string; truncated: boolean };
		assert.deepEqual(asked, ["which file did the report land in?"]);
		assert.equal(answer.status, "answered");
		assert.match(answer.text, /^It landed in src\/report\.ts\. x/);
		assert.equal(answer.truncated, true);
		assert.ok(Buffer.byteLength(answer.text) <= 64 * 1024);
		// Nothing about the round reaches the session's update stream.
		assert.deepEqual(
			agent.updates.filter((row) => JSON.stringify(row).includes("report")),
			[],
		);
		await assert.rejects(
			agent.call("_clio-coder/aside/ask", { sessionId: agent.sessionId, question: "   " }),
			(error: unknown) => error instanceof AcpRequestError && error.detail.code === "invalid_params",
		);
	} finally {
		await agent.stop();
	}
});

test("one round at a time, and cancel aborts the one in flight", async () => {
	let release: (() => void) | undefined;
	let signalled: AbortSignal | undefined;
	const agent = await peer({
		ask: (_question, signal) => {
			signalled = signal;
			return new Promise((resolve) => {
				release = () => resolve({ status: "aborted", text: "partial" });
				signal.addEventListener("abort", () => release?.());
			});
		},
		draft: async () => ({ status: "refused", reason: "unused" }),
	});
	try {
		const pending = agent.call("_clio-coder/aside/ask", { sessionId: agent.sessionId, question: "first" });
		await assert.rejects(
			agent.call("_clio-coder/aside/draft", { sessionId: agent.sessionId, request: "second", count: 2 }),
			(error: unknown) => error instanceof AcpRequestError && error.detail.code === "aside_active",
		);
		assert.deepEqual(await agent.call("_clio-coder/aside/cancel", { sessionId: agent.sessionId }), {
			cancelled: true,
		});
		assert.equal(signalled?.aborted, true);
		assert.deepEqual(await pending, { status: "aborted", text: "partial", truncated: false });
		assert.deepEqual(await agent.call("_clio-coder/aside/cancel", { sessionId: agent.sessionId }), {
			cancelled: false,
		});
	} finally {
		await agent.stop();
	}
});

test("drafts come back labelled with the judge's verdict, or the reason there is none", async () => {
	const seen: Array<[string, number]> = [];
	const agent = await peer({
		ask: async () => ({ status: "refused", reason: "unused" }),
		draft: async (request, count) => {
			seen.push([request, count]);
			return {
				status: "drafted",
				aborted: false,
				candidates: [
					{ status: "drafted", text: "Use a table." },
					{ status: "failed", reason: "endpoint reset" },
					{ status: "drafted", text: "Use a list." },
				],
				judgment: {
					verdict: {
						picked: "A",
						probabilities: { A: 0.8, B: 0, C: 0.2 },
						sound: { A: true, B: null, C: false },
						source: "jev/sys1",
						elapsedMs: 264,
					},
				},
			};
		},
	});
	try {
		const drafted = await agent.call("_clio-coder/aside/draft", {
			sessionId: agent.sessionId,
			request: "How should the report show readings?",
			count: 3,
		});
		assert.deepEqual(seen, [["How should the report show readings?", 3]]);
		assert.deepEqual(drafted, {
			status: "drafted",
			aborted: false,
			candidates: [
				{ label: "A", status: "drafted", text: "Use a table.", truncated: false },
				{ label: "B", status: "failed", reason: "endpoint reset" },
				{ label: "C", status: "drafted", text: "Use a list.", truncated: false },
			],
			judgment: {
				status: "judged",
				picked: "A",
				probabilities: { A: 0.8, B: 0, C: 0.2 },
				sound: { A: true, B: null, C: false },
				source: "jev/sys1",
				elapsedMs: 264,
			},
		});
		await assert.rejects(
			agent.call("_clio-coder/aside/draft", { sessionId: agent.sessionId, request: "x", count: 5 }),
			(error: unknown) => error instanceof AcpRequestError && error.detail.code === "invalid_params",
		);
	} finally {
		await agent.stop();
	}
});

test("a refusal from the chat loop is reported, not thrown", async () => {
	const agent = await peer({
		ask: async () => ({
			status: "refused",
			reason: "a turn is in flight; /btw runs beside the session, not in its queue",
		}),
		draft: async () => ({
			status: "refused",
			reason: "a turn is in flight; /draft runs beside the session, not in its queue",
		}),
	});
	try {
		assert.deepEqual(await agent.call("_clio-coder/aside/ask", { sessionId: agent.sessionId, question: "q" }), {
			status: "refused",
			reason: "a turn is in flight; /btw runs beside the session, not in its queue",
		});
		assert.deepEqual(
			await agent.call("_clio-coder/aside/draft", { sessionId: agent.sessionId, request: "r", count: 2 }),
			{ status: "refused", reason: "a turn is in flight; /draft runs beside the session, not in its queue" },
		);
	} finally {
		await agent.stop();
	}
});
