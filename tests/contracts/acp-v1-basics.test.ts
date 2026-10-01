import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readDispatchScopeNotice } from "../../src/core/dispatch-scope-notice.js";
import type { AcpRequestError } from "../../src/engine/acp/errors.js";
import { createAcpInterviewChannel } from "../../src/engine/acp/host-members.js";
import { createAcpHandshake, serveClioAcpAgent } from "../../src/engine/acp/server.js";
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

test("ACP counts a client as attended only when it advertises interviews at initialize", () => {
	const features = {
		session: true,
		loadSession: false,
		settings: false,
		providers: false,
		steer: false,
		dispatch: false,
		toolRegistry: false,
		bus: false,
		interviews: true,
		workerPermissions: true,
	};
	const request = "_clio-coder/interview/request";
	const initialize = (meta: Record<string, unknown> | undefined) => {
		const handshake = createAcpHandshake(features);
		const response = handshake.initialize({
			protocolVersion: 1,
			...(meta !== undefined ? { clientCapabilities: { _meta: meta } } : {}),
		});
		return {
			handshake,
			announced: (response.agentCapabilities?._meta as Record<string, unknown> | undefined)?.["clio-coder/interviews"],
		};
	};
	const plain = initialize(undefined);
	strictEqual(plain.handshake.interviewsEnabled, false);
	strictEqual(plain.handshake.workerPermissionsEnabled, false);
	strictEqual(plain.announced, undefined);
	const attended = initialize({
		"clio-coder/interviews": { version: 1, request },
		"clio-coder/workerPermissions": { version: 1, withdraw: "_clio-coder/permission/withdraw" },
	});
	strictEqual(attended.handshake.interviewsEnabled, true);
	strictEqual(attended.handshake.workerPermissionsEnabled, true);
	deepStrictEqual(attended.announced, { version: 1, request, cancel: "_clio-coder/interview/cancel" });
	// A client that cannot take a withdrawn ask would be left holding a stale card, so it is not asked.
	strictEqual(initialize({ "clio-coder/workerPermissions": { version: 1 } }).handshake.workerPermissionsEnabled, false);
	// A client naming a request method this host does not speak is not attended.
	strictEqual(
		initialize({ "clio-coder/interviews": { version: 1, request: "other/request" } }).handshake.interviewsEnabled,
		false,
	);
});

test("ACP interview channel maps the client's reply, its cancel and a turn abort onto ask_user results", async () => {
	const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	let enabled = true;
	let reply: unknown = { answers: [{ question: "Merge?", answer: "Keep branch", options: ["Keep branch"] }] };
	const channel = createAcpInterviewChannel();
	channel.attach({
		transport: {
			request: async <T>(method: string, params?: unknown) => {
				requests.push({ method, params: params as Record<string, unknown> });
				return (typeof reply === "function" ? await (reply as () => Promise<unknown>)() : reply) as T;
			},
			notify: (method, params) => notifications.push({ method, params: params as Record<string, unknown> }),
		},
		sessionId: () => "session-1",
		enabled: () => enabled,
	});
	const question = {
		question: "Merge?",
		header: "Merge task branch?",
		defaultOption: 1,
		options: [{ label: "Merge" }, { label: "Keep branch", description: "Leave it." }],
	};
	deepStrictEqual(await channel.ask([question]), reply);
	strictEqual(requests[0]?.method, "_clio-coder/interview/request");
	strictEqual(requests[0]?.params.sessionId, "session-1");
	// The wire question has no field for the harness-only default focus.
	deepStrictEqual((requests[0]?.params.questions as unknown[])[0], {
		question: "Merge?",
		header: "Merge task branch?",
		options: [{ label: "Merge" }, { label: "Keep branch", description: "Leave it." }],
	});

	reply = { answers: [], cancelled: true };
	deepStrictEqual(await channel.ask([question]), { answers: [], cancelled: true });
	reply = { answers: "not a list" };
	deepStrictEqual(await channel.ask([question]), { answers: [], cancelled: true });

	const controller = new AbortController();
	reply = () => new Promise(() => {});
	const aborted = channel.ask([question], { signal: controller.signal });
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	deepStrictEqual(await aborted, { answers: [], cancelled: true });
	strictEqual(notifications[0]?.method, "_clio-coder/interview/cancel");
	strictEqual(notifications[0]?.params.interviewId, requests.at(-1)?.params.interviewId);

	enabled = false;
	const asked = requests.length;
	deepStrictEqual(await channel.ask([question]), { answers: [], cancelled: true });
	strictEqual(requests.length, asked);
});

test("shared scope notice text neutralizes display controls and bounds long path prose", () => {
	const notice = readDispatchScopeNotice({
		code: "legacy_scope_inferred",
		message: "\u001b[31mScope\u001b[0m \u202e" + "x".repeat(8192),
	});
	strictEqual(notice?.message.startsWith("Scope \\u{202e}"), true);
	strictEqual(notice?.message.length, 4096);
});

test("ACP interview text neutralizes display controls before applying wire bounds", async () => {
	let sent: Record<string, unknown> | undefined;
	const channel = createAcpInterviewChannel();
	channel.attach({
		transport: {
			request: async <T>(_method: string, params?: unknown) => {
				sent = params as Record<string, unknown>;
				return { answers: [], cancelled: true } as T;
			},
			notify: () => {},
		},
		sessionId: () => "session-1",
		enabled: () => true,
	});
	await channel.ask([
		{
			question: "\u001b[31mDelete\u001b[0m \u202efile?",
			header: "Choice\u009b",
			options: [{ label: "Keep\u202e", description: "\u001b]0;spoof\u0007Leave\u200b it." }],
		},
		{ question: "\u202e".repeat(8192), options: [{ label: "\u202e".repeat(512) }] },
	]);
	const questions = sent?.questions as Array<{
		question: string;
		header?: string;
		options: Array<{ label: string; description?: string }>;
	}>;
	deepStrictEqual(questions[0], {
		question: "Delete \\u{202e}file?",
		header: "Choice\\u{9b}",
		options: [{ label: "Keep\\u{202e}", description: "Leave\\u{200b} it." }],
	});
	strictEqual(questions[1]?.question.length, 8192);
	strictEqual(questions[1]?.options[0]?.label.length, 512);
});
