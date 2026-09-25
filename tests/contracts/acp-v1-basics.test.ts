import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AcpRequestError } from "../../src/engine/acp/errors.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import { type AcpJsonRpcPeerTransport, createStdioServerTransport } from "../../src/engine/acp/transport.js";

function server() {
	const requests = new Map<string, (params: unknown) => unknown>();
	const notifications = new Map<string, (params: unknown) => void>();
	let close: () => void = () => {};
	let submitted = "";
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: () => {},
		onRequest: (method, handler) => {
			requests.set(method, handler);
			return () => requests.delete(method);
		},
		onNotification: (method, handler) => {
			notifications.set(method, handler);
			return () => notifications.delete(method);
		},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const done = serveClioAcpAgent({
		transport,
		chat: {
			submit: async (text) => {
				submitted = text;
			},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => false,
			getSessionId: () => null,
		},
	});
	return {
		requests,
		notifications,
		get submitted() {
			return submitted;
		},
		call: async (method: string, params: unknown) => {
			const handler = requests.get(method);
			if (!handler) throw new Error(`missing handler: ${method}`);
			return await handler(params);
		},
		stop: async () => {
			close();
			await done;
		},
	};
}

test("ACP v1 negotiates the supported version and terminal auth only with client support", async () => {
	for (const terminal of [false, true]) {
		const peer = server();
		try {
			const response = (await peer.call("initialize", {
				protocolVersion: 42,
				clientCapabilities: { auth: { terminal } },
				_meta: { fixture: true },
			})) as {
				protocolVersion: number;
				authMethods: Array<{ args?: string[] }>;
				agentCapabilities: { sessionCapabilities: { close?: object }; auth: { logout?: object } };
			};
			strictEqual(response.protocolVersion, 1);
			deepStrictEqual(
				response.authMethods.map((method) => method.args),
				terminal ? [["auth", "login"]] : [],
			);
			strictEqual(response.agentCapabilities.sessionCapabilities.close !== undefined, true);
			strictEqual(response.agentCapabilities.auth.logout !== undefined, true);
			await rejects(peer.call("authenticate", { methodId: "unknown", _meta: {} }), (error: unknown) => {
				strictEqual((error as AcpRequestError).rpcCode, -32602);
				return true;
			});
			deepStrictEqual(await peer.call("logout", { _meta: {} }), {});
			await rejects(peer.call("session/new", { cwd: process.cwd(), mcpServers: [] }), (error: unknown) => {
				strictEqual((error as AcpRequestError).rpcCode, -32000);
				return true;
			});
		} finally {
			await peer.stop();
		}
	}
});

test("ACP accepts metadata and resource links, and registers only prefixed extensions", async () => {
	const peer = server();
	try {
		await peer.call("initialize", { protocolVersion: 1 });
		await rejects(peer.call("_clio-coder/settings/get_safe", { _meta: {} }), (error: unknown) => {
			strictEqual((error as AcpRequestError).rpcCode, -32601);
			return true;
		});
		strictEqual(peer.requests.has("_clio-coder/settings/get_safe"), true);
		strictEqual(peer.requests.has("clio-coder/settings/get_safe"), false);
		for (const method of peer.requests.keys()) {
			if (!method.startsWith("session/") && !["initialize", "authenticate", "logout"].includes(method)) {
				strictEqual(method.startsWith("_clio-coder/"), true, method);
			}
		}
		await rejects(peer.call("session/new", { cwd: "relative", mcpServers: [] }), (error: unknown) => {
			strictEqual((error as AcpRequestError).rpcCode, -32602);
			return true;
		});
		await rejects(peer.call("session/close", { sessionId: "missing" }), (error: unknown) => {
			strictEqual((error as AcpRequestError).rpcCode, -32002);
			return true;
		});
		const opened = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [], _meta: {} })) as {
			sessionId: string;
		};
		await rejects(peer.call("session/new", { cwd: process.cwd(), mcpServers: [] }), (error: unknown) => {
			strictEqual((error as AcpRequestError).rpcCode, -32602);
			return true;
		});
		await peer.call("session/prompt", {
			sessionId: opened.sessionId,
			prompt: [
				{ type: "text", text: "Inspect" },
				{ type: "resource_link", name: "guide", uri: "file:///repo/guide.md" },
			],
			_meta: {},
		});
		strictEqual(peer.submitted.includes("file:///repo/guide.md"), true);
		peer.notifications.get("session/cancel")?.({ sessionId: opened.sessionId, _meta: {} });
	} finally {
		await peer.stop();
	}
});

test("ACP transport reports unclassified handler failures as internal errors", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const transport = createStdioServerTransport({ input, output });
	try {
		transport.onRequest("explode", () => {
			throw new Error("private failure detail");
		});
		const response = once(output, "data");
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "explode", params: {} })}\n`);
		const [chunk] = await response;
		const frame = JSON.parse(String(chunk)) as { error: { code: number; message: string } };
		strictEqual(frame.error.code, -32603);
		strictEqual(frame.error.message, "internal error");
	} finally {
		transport.close();
		input.destroy();
		output.destroy();
	}
});
