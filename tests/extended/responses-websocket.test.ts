import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { engineStreamSimple } from "../../src/engine/api-registry.js";
import {
	closeResponsesWebSockets,
	newTransportCall,
	responsesWebSocketFetch,
} from "../../src/engine/apis/responses-websocket.js";
import { engineModels } from "../../src/engine/models.js";
import type { CodexTransportObservation, EngineModel } from "../../src/engine/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

type Payload = Record<string, unknown>;

const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
const apiKey = `e30.${account.toString("base64url")}.sig`;
const usage = { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } };

function frameOf(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) header = Buffer.from([0x80 | opcode, length]);
	else if (length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

interface Connection {
	send(event: Payload): void;
	close(code: number): void;
}

interface Fixture {
	url: string;
	frames: Payload[];
	upgrades: IncomingMessage[];
	posts: number;
	close(): Promise<void>;
}

/** A Responses backend on loopback: a hand-rolled RFC 6455 endpoint for the socket and plain SSE for `POST`. */
async function backend(options: {
	onFrame: (frame: Payload, connection: Connection, index: number) => void;
	handshake?: Record<string, string>;
	rejectUpgrade?: boolean;
	sse?: Payload[];
}): Promise<Fixture> {
	const frames: Payload[] = [];
	const upgrades: IncomingMessage[] = [];
	const sockets = new Set<Socket>();
	let posts = 0;
	const server: Server = createServer((request, response) => {
		posts += 1;
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of options.sse ?? []) response.write(`data: ${JSON.stringify(event)}\n\n`);
			response.end();
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (request, socket: Socket) => {
		upgrades.push(request);
		if (options.rejectUpgrade) {
			socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		const accept = createHash("sha1")
			.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		const extra = Object.entries(options.handshake ?? {}).map(([name, value]) => `${name}: ${value}\r\n`);
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extra.join("")}\r\n`,
		);
		const connection: Connection = {
			send: (event) => socket.write(frameOf(1, Buffer.from(JSON.stringify(event)))),
			close: (code) => {
				const body = Buffer.alloc(2);
				body.writeUInt16BE(code, 0);
				socket.end(frameOf(8, body));
			},
		};
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < 2) return;
				const opcode = (buffer[0] ?? 0) & 0x0f;
				const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
				let length = (buffer[1] ?? 0) & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.length < 4) return;
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffer.length < 10) return;
					length = Number(buffer.readBigUInt64BE(2));
					offset = 10;
				}
				const maskAt = offset;
				if (masked) offset += 4;
				if (buffer.length < offset + length) return;
				let payload = Buffer.from(buffer.subarray(offset, offset + length));
				if (masked) {
					const mask = buffer.subarray(maskAt, maskAt + 4);
					payload = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
				}
				buffer = buffer.subarray(offset + length);
				if (opcode === 1) {
					const frame = JSON.parse(payload.toString("utf8")) as Payload;
					frames.push(frame);
					options.onFrame(frame, connection, frames.length - 1);
				} else if (opcode === 8) {
					if (!socket.writableEnded) socket.end(frameOf(8, payload.subarray(0, 2)));
				} else if (opcode === 9 && !socket.writableEnded) socket.write(frameOf(10, payload));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		frames,
		upgrades,
		get posts() {
			return posts;
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function textEvents(id: string, text: string): Payload[] {
	const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed" };
	return [
		{ type: "response.created", response: { id, status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { ...item, content: [{ type: "output_text", text, annotations: [] }] },
		},
		{ type: "response.completed", response: { id, status: "completed", usage } },
	];
}

function toolCallEvents(id: string): Payload[] {
	const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' };
	return [
		{ type: "response.created", response: { id, status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
		{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: item.arguments },
		{ type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
		{ type: "response.completed", response: { id, status: "completed", usage } },
	];
}

function codexAt(url: string): EngineModel {
	const model = engineModels.getModel("openai-codex" as never, "gpt-6-luna") as EngineModel | undefined;
	ok(model, "the catalog carries openai-codex gpt-6-luna");
	return { ...model, baseUrl: url };
}

const user = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });
const tools = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];

async function call(model: EngineModel, context: Context, sessionId: string, extra: Payload = {}) {
	const message = await engineStreamSimple(model, context, { apiKey, sessionId, ...extra }).result();
	return { message, transport: (message as { codexTransport?: CodexTransportObservation }).codexTransport };
}

afterEach(() => closeResponsesWebSockets());

test("a tool round continues on the same socket as a delta and replays the handshake's turn state", async (t) => {
	const env = await isolateClioEnv("clio-coder-responses-ws-");
	t.after(() => env.restore());
	const server = await backend({
		handshake: { "x-codex-turn-state": "ts-1" },
		onFrame: (_frame, connection, index) => {
			for (const event of index === 0 ? toolCallEvents("resp_1") : textEvents("resp_2", "done")) connection.send(event);
		},
	});
	t.after(() => server.close());
	const model = codexAt(server.url);
	const first: Context = { systemPrompt: "Fixture.", tools, messages: [user("inspect", 1)] };
	const a = await call(model, first, "ws-turn");
	strictEqual(a.message.stopReason, "toolUse", a.message.errorMessage);
	strictEqual(a.transport?.mode, "websocket");
	strictEqual(a.transport?.request, "full");
	strictEqual(a.transport?.counters?.connectionsCreated, 1);
	const toolCall = a.message.content.find((part) => part.type === "toolCall");
	ok(toolCall && toolCall.type === "toolCall");
	const second: Context = {
		...first,
		messages: [
			...first.messages,
			a.message,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 2,
			},
		],
	};
	const b = await call(model, second, "ws-turn");
	strictEqual(b.message.stopReason, "stop", b.message.errorMessage);
	strictEqual(server.upgrades.length, 1, "the second request reuses the first socket");
	strictEqual(b.transport?.request, "delta");
	strictEqual(b.transport?.counters?.connectionsReused, 1);
	const [opening, continued] = server.frames;
	strictEqual(opening?.type, "response.create");
	strictEqual(opening?.previous_response_id, undefined);
	strictEqual((opening?.client_metadata as Payload | undefined)?.["x-codex-turn-state"], undefined);
	strictEqual(continued?.previous_response_id, "resp_1");
	deepStrictEqual(
		(continued?.input as Payload[]).map((item) => item.type),
		["function_call_output"],
		"only the tool result is new to the provider",
	);
	strictEqual((continued?.client_metadata as Payload)["x-codex-turn-state"], "ts-1");
	strictEqual(server.upgrades[0]?.headers["x-codex-turn-state"], undefined, "the token never rides the handshake");
	strictEqual(server.upgrades[0]?.headers["openai-beta"], "responses_websockets=2026-02-06");
	strictEqual(server.posts, 0);
});

test("the turn after a generate:false warm chains to the warm response with only the new message", async (t) => {
	const env = await isolateClioEnv("clio-coder-responses-ws-");
	t.after(() => env.restore());
	const server = await backend({
		onFrame: (_frame, connection, index) => {
			const events =
				index === 0
					? [
							{ type: "response.created", response: { id: "warm_1", status: "in_progress" } },
							{ type: "response.completed", response: { id: "warm_1", status: "completed", output: [], usage } },
						]
					: textEvents("resp_2", "hello");
			for (const event of events) connection.send(event);
		},
	});
	t.after(() => server.close());
	const model = codexAt(server.url);
	const history: Context = { systemPrompt: "Fixture.", tools, messages: [user("earlier", 1)] };
	await call(model, history, "ws-warm", {
		onPayload: (payload: unknown) => ({ ...(payload as Payload), generate: false }),
	});
	const turn = await call(model, { ...history, messages: [...history.messages, user("now", 2)] }, "ws-warm");
	strictEqual(turn.message.stopReason, "stop", turn.message.errorMessage);
	strictEqual(server.frames[0]?.generate, false);
	strictEqual(server.frames[1]?.previous_response_id, "warm_1");
	strictEqual(server.frames[1]?.generate, undefined);
	strictEqual((server.frames[1]?.input as unknown[]).length, 1);
	strictEqual(turn.transport?.request, "delta");
});

test("a lost continuation resends the request in full once, and the call succeeds", async (t) => {
	const env = await isolateClioEnv("clio-coder-responses-ws-");
	t.after(() => env.restore());
	const server = await backend({
		onFrame: (frame, connection, index) => {
			if (index === 1) {
				ok(frame.previous_response_id, "the second request tried a delta");
				connection.send({ type: "error", error: { code: "previous_response_not_found", message: "gone" } });
				return;
			}
			for (const event of textEvents(`resp_${index + 1}`, "ok")) connection.send(event);
		},
	});
	t.after(() => server.close());
	const model = codexAt(server.url);
	const first: Context = { systemPrompt: "Fixture.", tools, messages: [user("one", 1)] };
	const a = await call(model, first, "ws-lost");
	const b = await call(model, { ...first, messages: [...first.messages, a.message, user("two", 2)] }, "ws-lost");
	strictEqual(b.message.stopReason, "stop", b.message.errorMessage);
	strictEqual(server.frames.length, 3);
	strictEqual(server.frames[2]?.previous_response_id, undefined);
	strictEqual(
		(server.frames[2]?.input as unknown[]).length,
		(server.frames[0]?.input as unknown[]).length + 2,
		"the resend carries the whole conversation",
	);
	strictEqual(b.transport?.counters?.deltaRequests, 1);
	strictEqual(b.transport?.counters?.fullContextRequests, 1);
	strictEqual(b.transport?.request, "full");
	strictEqual(server.posts, 0, "recovery stays on the socket");
});

test("a refused handshake sends the request over SSE and pins the session for the cooldown", async (t) => {
	const env = await isolateClioEnv("clio-coder-responses-ws-");
	t.after(() => env.restore());
	const server = await backend({ rejectUpgrade: true, onFrame: () => {}, sse: textEvents("resp_sse", "via http") });
	t.after(() => server.close());
	const model = codexAt(server.url);
	const context: Context = { systemPrompt: "Fixture.", tools, messages: [user("hi", 1)] };
	const a = await call(model, context, "ws-refused");
	strictEqual(a.message.stopReason, "stop", a.message.errorMessage);
	strictEqual(a.transport?.mode, "sse");
	strictEqual(a.transport?.fallbackActive, true);
	strictEqual(a.transport?.reason, "transport_failure");
	strictEqual(a.transport?.counters?.websocketFailures, 1);
	strictEqual(a.transport?.counters?.sseFallbacks, 1);
	const b = await call(
		model,
		{ ...context, messages: [...context.messages, a.message, user("again", 2)] },
		"ws-refused",
	);
	strictEqual(b.message.stopReason, "stop", b.message.errorMessage);
	strictEqual(server.upgrades.length, 1, "the cooled session does not retry the socket");
	strictEqual(b.transport?.fallbackActive, true);
	strictEqual(server.posts, 2);
});

test("a frame too big for the socket goes over SSE without pinning the session", async (t) => {
	const env = await isolateClioEnv("clio-coder-responses-ws-");
	t.after(() => env.restore());
	const server = await backend({
		onFrame: (_frame, connection) => connection.close(1009),
		sse: textEvents("resp_sse", "via http"),
	});
	t.after(() => server.close());
	const model = codexAt(server.url);
	const a = await call(model, { systemPrompt: "Fixture.", tools, messages: [user("big", 1)] }, "ws-big");
	strictEqual(a.message.stopReason, "stop", a.message.errorMessage);
	strictEqual(a.transport?.mode, "sse");
	strictEqual(a.transport?.fallbackActive, false);
	strictEqual(a.transport?.counters?.websocketFailures, 0);
	strictEqual(server.posts, 1);
});

test("the public API's frame drops the HTTP-only fields and streams back as SSE", async (t) => {
	const server = await backend({
		onFrame: (_frame, connection) => {
			for (const event of textEvents("resp_public", "hi")) connection.send(event);
		},
	});
	t.after(() => server.close());
	const transport = newTransportCall();
	const fetch = responsesWebSocketFetch({
		flavor: "public",
		base: () => Promise.reject(new Error("no HTTP expected")),
		continuation: true,
		session: "public-1",
		call: transport,
	});
	const response = await fetch(`${server.url}/v1/responses`, {
		method: "POST",
		headers: { authorization: "Bearer test", "content-type": "application/json" },
		body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "hi" }], stream: true, store: false }),
	});
	const text = await response.text();
	strictEqual(response.headers.get("content-type"), "text/event-stream");
	ok(text.includes('"response.completed"'), text);
	strictEqual(server.frames[0]?.stream, undefined);
	strictEqual(server.frames[0]?.store, false);
	strictEqual(server.upgrades[0]?.headers["openai-beta"], undefined);
	strictEqual(transport.mode, "websocket");
	strictEqual(transport.counters.connectionsCreated, 1);
});
