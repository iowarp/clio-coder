import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { type AcpDispatchControl, type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

/** An in-memory peer: the test plays the client and calls the server's handlers directly. */
function fakeTransport() {
	const handlers = new Map<string, RequestHandler>();
	const closeHandlers: Array<() => void> = [];
	let closed = false;
	const transport: AcpJsonRpcPeerTransport = {
		get closed() {
			return closed;
		},
		request: async () => {
			throw new Error("the server sends no client requests in this test");
		},
		notify: () => {},
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
	return { transport, call };
}

/**
 * A chat whose run the test starts and stops by hand. `submit` stays pending
 * exactly as the real loop does while a turn streams, which is the only state
 * in which the engine admits a steer.
 */
function fakeChat(overrides: Partial<AcpServerChat> = {}) {
	const steer: string[] = [];
	const followUp: string[] = [];
	let streaming = false;
	let release: () => void = () => {};
	let interruptRefusal: string | null = null;
	let cancels = 0;
	const chat: AcpServerChat = {
		submit: async () => {
			streaming = true;
			await new Promise<void>((resolve) => {
				release = () => {
					streaming = false;
					resolve();
				};
			});
		},
		cancel: () => {
			cancels += 1;
			release();
		},
		onEvent: () => () => {},
		isStreaming: () => streaming,
		getSessionId: () => null,
		steer: (text) => {
			if (!streaming) return false;
			steer.push(text);
			return true;
		},
		queueFollowUp: (text) => {
			if (!streaming) return false;
			followUp.push(text);
			return true;
		},
		queuedMessages: () => ({ steer: [...steer], followUp: [...followUp] }),
		clearQueuedFollowUps: () => {
			const drained = [...steer, ...followUp];
			steer.length = 0;
			followUp.length = 0;
			return drained;
		},
		interruptRefusal: () => interruptRefusal,
		...overrides,
	};
	return {
		chat,
		get cancels() {
			return cancels;
		},
		refuseInterrupt(reason: string | null) {
			interruptRefusal = reason;
		},
		finish() {
			release();
		},
	};
}

async function openSession(peer: ReturnType<typeof fakeTransport>): Promise<string> {
	await peer.call("initialize", { protocolVersion: 1 });
	const created = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	return created.sessionId;
}

/**
 * Starts a prompt without awaiting it and returns once the run is streaming.
 * The pending request is handed back inside a box: awaiting a promise that
 * resolves to a promise would chain onto the turn this helper is meant to leave
 * running.
 */
async function startPrompt(
	peer: ReturnType<typeof fakeTransport>,
	sessionId: string,
): Promise<{ prompt: Promise<unknown> }> {
	const prompt = peer.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
	await tick();
	return { prompt };
}

describe("contracts/acp exposes the engine steering queues without a second prompt", () => {
	it("queues a steer on the queue its mode names and reads both queues back", async () => {
		const peer = fakeTransport();
		const loop = fakeChat();
		const served = serveClioAcpAgent({ transport: peer.transport, chat: loop.chat, cwd: process.cwd() });
		const sessionId = await openSession(peer);
		const { prompt } = await startPrompt(peer, sessionId);

		deepStrictEqual(await peer.call("_clio-coder/session/steer", { sessionId, text: "use the cached index" }), {
			accepted: true,
			queue: "steer",
		});
		deepStrictEqual(
			await peer.call("_clio-coder/session/steer", {
				sessionId,
				text: "then write the report",
				mode: "end-of-turn",
			}),
			{ accepted: true, queue: "follow-up" },
		);
		deepStrictEqual(await peer.call("_clio-coder/session/queue", { sessionId }), {
			steer: ["use the cached index"],
			followUp: ["then write the report"],
		});

		loop.finish();
		await prompt;
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("refuses a steer while nothing is streaming instead of throwing or queueing it", async () => {
		const peer = fakeTransport();
		const loop = fakeChat();
		const served = serveClioAcpAgent({ transport: peer.transport, chat: loop.chat, cwd: process.cwd() });
		const sessionId = await openSession(peer);

		const idle = (await peer.call("_clio-coder/session/steer", { sessionId, text: "too early" })) as {
			accepted: boolean;
			queue: string;
			refusal: string;
		};
		strictEqual(idle.accepted, false);
		strictEqual(idle.queue, "steer");
		ok(idle.refusal.includes("no prompt is active"));
		deepStrictEqual(await peer.call("_clio-coder/session/queue", { sessionId }), { steer: [], followUp: [] });

		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("refuses an unknown steering mode rather than defaulting it", async () => {
		const peer = fakeTransport();
		const loop = fakeChat();
		const served = serveClioAcpAgent({ transport: peer.transport, chat: loop.chat, cwd: process.cwd() });
		const sessionId = await openSession(peer);
		// `interrupt` is a real engine mode and is deliberately not admitted here:
		// it would resubmit the text as a turn this client never requested.
		await rejects(
			peer.call("_clio-coder/session/steer", { sessionId, text: "now", mode: "interrupt" }),
			(error: unknown) => {
				ok(error instanceof AcpRequestError);
				strictEqual(error.detail.code, "invalid_params");
				return true;
			},
		);
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("hands back everything queue_clear drained so the client owns the text", async () => {
		const peer = fakeTransport();
		const loop = fakeChat();
		const served = serveClioAcpAgent({ transport: peer.transport, chat: loop.chat, cwd: process.cwd() });
		const sessionId = await openSession(peer);
		const { prompt } = await startPrompt(peer, sessionId);

		await peer.call("_clio-coder/session/steer", { sessionId, text: "first" });
		await peer.call("_clio-coder/session/steer", { sessionId, text: "second", mode: "end-of-turn" });
		deepStrictEqual(await peer.call("_clio-coder/session/queue_clear", { sessionId }), {
			restored: ["first", "second"],
		});
		deepStrictEqual(await peer.call("_clio-coder/session/queue", { sessionId }), { steer: [], followUp: [] });

		loop.finish();
		await prompt;
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("cancels on interrupt and lets the outstanding prompt return stopReason cancelled", async () => {
		const peer = fakeTransport();
		const loop = fakeChat();
		const served = serveClioAcpAgent({ transport: peer.transport, chat: loop.chat, cwd: process.cwd() });
		const sessionId = await openSession(peer);
		const { prompt } = await startPrompt(peer, sessionId);

		deepStrictEqual(await peer.call("_clio-coder/session/interrupt", { sessionId, reason: "wrong file" }), {
			cancelled: true,
		});
		strictEqual(loop.cancels, 1);
		const response = (await prompt) as { stopReason: string };
		strictEqual(response.stopReason, "cancelled");
		// A steer after the interrupt is refused: the engine would strand it and
		// resubmit it as a fresh prompt with no request to answer.
		const afterwards = (await peer.call("_clio-coder/session/steer", { sessionId, text: "one more" })) as {
			accepted: boolean;
		};
		strictEqual(afterwards.accepted, false);

		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("reports the engine's refusal instead of cancelling, and reports an idle session", async () => {
		const peer = fakeTransport();
		const loop = fakeChat();
		const served = serveClioAcpAgent({ transport: peer.transport, chat: loop.chat, cwd: process.cwd() });
		const sessionId = await openSession(peer);

		deepStrictEqual(await peer.call("_clio-coder/session/interrupt", { sessionId }), {
			cancelled: false,
			refusal: "no prompt is active on this session",
		});

		const { prompt } = await startPrompt(peer, sessionId);
		loop.refuseInterrupt("an attached dispatch is running");
		deepStrictEqual(await peer.call("_clio-coder/session/interrupt", { sessionId }), {
			cancelled: false,
			refusal: "an attached dispatch is running",
		});
		strictEqual(loop.cancels, 0);

		loop.finish();
		await prompt;
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("refuses cleanly when the chat this server was given cannot steer at all", async () => {
		const peer = fakeTransport();
		const narrow: AcpServerChat = {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => false,
			getSessionId: () => null,
		};
		const served = serveClioAcpAgent({ transport: peer.transport, chat: narrow, cwd: process.cwd() });
		await peer.call("initialize", { protocolVersion: 1 });
		const created = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
		const sessionId = created.sessionId;

		const refused = (await peer.call("_clio-coder/session/steer", { sessionId, text: "steer me" })) as {
			accepted: boolean;
			refusal: string;
		};
		strictEqual(refused.accepted, false);
		ok(refused.refusal.includes("does not expose"));
		// A queue read has no field to carry a refusal, so an unreadable queue
		// fails the request rather than reporting two empty lists it never saw.
		for (const method of ["_clio-coder/session/queue", "_clio-coder/session/queue_clear"]) {
			await rejects(peer.call(method, { sessionId }), (error: unknown) => {
				ok(error instanceof AcpRequestError);
				strictEqual(error.detail.code, "internal_error");
				return true;
			});
		}
		deepStrictEqual(await peer.call("_clio-coder/session/interrupt", { sessionId }), {
			cancelled: false,
			refusal: "no prompt is active on this session",
		});

		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("announces the wired queues in initialize _meta", async () => {
		const wired = fakeTransport();
		const loop = fakeChat();
		const servedWired = serveClioAcpAgent({ transport: wired.transport, chat: loop.chat, cwd: process.cwd() });
		const init = (await wired.call("initialize", { protocolVersion: 1 })) as {
			protocolVersion: number;
			agentCapabilities: { _meta: Record<string, Record<string, unknown>> };
		};
		strictEqual(init.protocolVersion, 1);
		const steering = init.agentCapabilities._meta["clio-coder/steering"];
		strictEqual(steering?.version, 1);
		strictEqual(steering?.main, true);
		strictEqual(steering?.dispatch, false);
		strictEqual(steering?.interrupt, true);
		deepStrictEqual(steering?.modes, ["next-slot", "end-of-turn"]);
		deepStrictEqual(steering?.methods, {
			steer: "_clio-coder/session/steer",
			queue: "_clio-coder/session/queue",
			clear: "_clio-coder/session/queue_clear",
			interrupt: "_clio-coder/session/interrupt",
			dispatch: "_clio-coder/dispatch/steer",
		});
		wired.transport.close();
		strictEqual(await servedWired, 0);

		const narrow = fakeTransport();
		const servedNarrow = serveClioAcpAgent({
			transport: narrow.transport,
			chat: {
				submit: async () => {},
				cancel: () => {},
				onEvent: () => () => {},
				isStreaming: () => false,
				getSessionId: () => null,
			},
			cwd: process.cwd(),
		});
		const narrowInit = (await narrow.call("initialize", { protocolVersion: 1 })) as {
			agentCapabilities: { _meta: Record<string, Record<string, unknown>> };
		};
		strictEqual(narrowInit.agentCapabilities._meta["clio-coder/steering"]?.main, false);
		narrow.transport.close();
		strictEqual(await servedNarrow, 0);
	});
});

describe("contracts/acp reports dispatch steering as queued, never as delivered", () => {
	const fleet = (overrides: Partial<AcpDispatchControl> = {}) => {
		const steers: Array<{ runId: string; text: string }> = [];
		const aborts: string[] = [];
		const control: AcpDispatchControl = {
			steer: (runId, text) => {
				steers.push({ runId, text });
			},
			abort: (runId) => {
				aborts.push(runId);
			},
			snapshot: () => ({ running: [{ runId: "run-live", runtimeKind: "http" }], retrying: [] }),
			...overrides,
		};
		return { control, steers, aborts };
	};

	it("queues guidance for a live worker and refuses a kind that cannot be steered", async () => {
		const peer = fakeTransport();
		const loop = fakeChat();
		const dispatch = fleet();
		const served = serveClioAcpAgent({
			transport: peer.transport,
			chat: loop.chat,
			dispatch: dispatch.control,
			cwd: process.cwd(),
		});
		const init = (await peer.call("initialize", { protocolVersion: 1 })) as {
			agentCapabilities: { _meta: Record<string, Record<string, unknown>> };
		};
		strictEqual(init.agentCapabilities._meta["clio-coder/steering"]?.dispatch, true);
		const created = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
		const sessionId = created.sessionId;

		deepStrictEqual(
			await peer.call("_clio-coder/dispatch/steer", {
				sessionId,
				runId: "run-live",
				action: "guide",
				message: "prefer the smaller fixture",
			}),
			{ accepted: true },
		);
		deepStrictEqual(dispatch.steers, [{ runId: "run-live", text: "prefer the smaller fixture" }]);

		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("maps each dispatch refusal to its own reason and never echoes the thrown prose", async () => {
		const cases: Array<[string, string]> = [
			["steer: run 'r' (subprocess:codex) does not support live steering", "steering-unsupported"],
			["steer: run 'r' (http:local) has no input channel", "no-input-channel"],
			["steer: run 'r' no longer accepts input; the worker has exited or its stdin is closed", "input-closed"],
			["steer: run 'r' is aborting and cannot be steered", "run-terminating"],
			["steer: run or assignment 'r' is not active; only running HTTP/SDK workers accept guidance", "run-not-active"],
			["steer: the stdin writer threw", "steer-failed"],
		];
		for (const [thrown, reason] of cases) {
			const peer = fakeTransport();
			const loop = fakeChat();
			const dispatch = fleet({
				steer: () => {
					throw new Error(thrown);
				},
			});
			const diagnostics: string[] = [];
			const served = serveClioAcpAgent({
				transport: peer.transport,
				chat: loop.chat,
				dispatch: dispatch.control,
				cwd: process.cwd(),
				diagnostics: (line) => diagnostics.push(line),
			});
			const sessionId = await openSession(peer);
			deepStrictEqual(
				await peer.call("_clio-coder/dispatch/steer", {
					sessionId,
					runId: "run-live",
					action: "guide",
					message: "hello",
				}),
				{ accepted: false, reason },
			);
			strictEqual(diagnostics.length, 1);
			peer.transport.close();
			strictEqual(await served, 0);
		}
	});

	it("cancels only a run the fleet reports, and refuses when no fleet is wired", async () => {
		const peer = fakeTransport();
		const loop = fakeChat();
		const dispatch = fleet();
		const served = serveClioAcpAgent({
			transport: peer.transport,
			chat: loop.chat,
			dispatch: dispatch.control,
			cwd: process.cwd(),
		});
		const sessionId = await openSession(peer);

		deepStrictEqual(await peer.call("_clio-coder/dispatch/steer", { sessionId, runId: "run-live", action: "cancel" }), {
			accepted: true,
		});
		deepStrictEqual(dispatch.aborts, ["run-live"]);
		deepStrictEqual(await peer.call("_clio-coder/dispatch/steer", { sessionId, runId: "run-gone", action: "cancel" }), {
			accepted: false,
			reason: "run-not-active",
		});
		deepStrictEqual(dispatch.aborts, ["run-live"]);
		await rejects(
			peer.call("_clio-coder/dispatch/steer", {
				sessionId,
				runId: "run-live",
				action: "cancel",
				message: "why",
			}),
			(error: unknown) => {
				ok(error instanceof AcpRequestError);
				strictEqual(error.detail.code, "invalid_params");
				return true;
			},
		);
		peer.transport.close();
		strictEqual(await served, 0);

		const bare = fakeTransport();
		const servedBare = serveClioAcpAgent({ transport: bare.transport, chat: fakeChat().chat, cwd: process.cwd() });
		const bareSession = await openSession(bare);
		deepStrictEqual(
			await bare.call("_clio-coder/dispatch/steer", { sessionId: bareSession, runId: "run-live", action: "cancel" }),
			{ accepted: false, reason: "dispatch-unavailable" },
		);
		bare.transport.close();
		strictEqual(await servedBare, 0);
	});
});
