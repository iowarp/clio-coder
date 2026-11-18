import type { AcpCommandHost } from "../../src/engine/acp/commands.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

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
