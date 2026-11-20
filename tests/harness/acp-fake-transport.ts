import { PassThrough } from "node:stream";
import type { AcpCommandHost } from "../../src/engine/acp/commands.js";
import { type AcpJsonRpcPeerTransport, createStdioServerTransport } from "../../src/engine/acp/transport.js";

/** A JSON-RPC error frame the server wrote, thrown by `stdioPeer().call`. */
export class AcpWireError extends Error {
	constructor(
		readonly code: number,
		readonly data: Record<string, unknown> | undefined,
		message: string,
	) {
		super(message);
	}
}

/**
 * The real stdio server transport over in-memory pipes: the test plays the client and speaks newline-framed JSON-RPC,
 * so a request crosses the same parser and serializer a client's does. `notifications` holds every frame the server
 * sent without an id, in order.
 */
export function stdioPeer() {
	const input = new PassThrough();
	const output = new PassThrough();
	const transport = createStdioServerTransport({ input, output });
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	let buffer = "";
	let nextId = 1;
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
			buffer = buffer.slice(newline + 1);
			if (typeof frame.id === "number" && pending.has(frame.id)) {
				const waiter = pending.get(frame.id);
				pending.delete(frame.id);
				const error = frame.error as { code: number; message: string; data?: Record<string, unknown> } | undefined;
				if (error) waiter?.reject(new AcpWireError(error.code, error.data, error.message));
				else waiter?.resolve(frame.result);
			} else if (typeof frame.method === "string" && frame.id === undefined) {
				notifications.push({ method: frame.method, params: (frame.params ?? {}) as Record<string, unknown> });
			}
		}
	});
	const call = (method: string, params: unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	/** Session updates, newest last; `update` is the ACP `SessionUpdate` and `_meta` sits beside it. */
	const updates = () =>
		notifications
			.filter((frame) => frame.method === "session/update")
			.map(
				(frame) => frame.params as { sessionId: string; update: Record<string, unknown>; _meta?: Record<string, unknown> },
			);
	const close = () => {
		transport.close();
		input.destroy();
		output.destroy();
	};
	return { transport, call, notifications, updates, close };
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

/** An in-memory peer: the test plays the client and calls the server's handlers directly. */
export function fakeTransport() {
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
	return { transport, notifications, call, has: (method: string) => handlers.has(method) };
}

/**
 * A command host whose three required members belong to commands the caller
 * never invokes. Reaching one is a test failure, not a crash to interpret, so
 * each throws.
 */
export function acpCommandHost(overrides: Partial<AcpCommandHost> = {}): AcpCommandHost {
	const refuse = (member: string) =>
		new Proxy(
			{},
			{
				get() {
					throw new Error(`test host: ${member} was reached`);
				},
			},
		);
	return {
		dispatch: refuse("dispatch") as AcpCommandHost["dispatch"],
		bus: refuse("bus") as AcpCommandHost["bus"],
		providers: refuse("providers") as AcpCommandHost["providers"],
		...overrides,
	};
}
