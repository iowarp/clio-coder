import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import {
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
	ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
} from "../../src/engine/acp/types.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

/** An in-memory peer: the test plays the client and calls the server's handlers directly. */
function fakeTransport() {
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
	return { transport, notifications, call };
}

interface TurnScript {
	emit(event: unknown): void;
	/** Moves the injected clock forward; the interval floor measures against it. */
	advance(ms: number): void;
}

function scriptedChat(script: (turn: TurnScript) => void, advance: (ms: number) => void): AcpServerChat {
	let emit: (event: unknown) => void = () => {};
	return {
		submit: async () => {
			script({ emit: (event) => emit(event), advance });
		},
		cancel: () => {},
		onEvent: (handler) => {
			emit = handler;
			return () => {
				emit = () => {};
			};
		},
		isStreaming: () => false,
		getSessionId: () => null,
	};
}

const TOOL_START = {
	type: "tool_execution_start",
	toolCallId: "call-1",
	toolName: "bash",
	args: { command: "make -j" },
};

const TOOL_END = {
	type: "tool_execution_end",
	toolCallId: "call-1",
	toolName: "bash",
	result: { output: "build ok" },
	isError: false,
};

function progressEvent(output: string, toolCallId = "call-1"): Record<string, unknown> {
	return { type: "tool_execution_update", toolCallId, toolName: "bash", partialResult: { output } };
}

async function runTurn(input: { optIn: boolean | { capability: unknown }; script: (turn: TurnScript) => void }) {
	const peer = fakeTransport();
	let clock = 1_000_000;
	const served = serveClioAcpAgent({
		transport: peer.transport,
		chat: scriptedChat(input.script, (ms) => {
			clock += ms;
		}),
		cwd: process.cwd(),
		now: () => clock,
	});
	// `true` is the documented opt-in; an object carries a deliberately wrong one,
	// and `false` sends no client capabilities at all.
	const capability = input.optIn === true ? { version: 1 } : input.optIn === false ? null : input.optIn.capability;
	const init = (await peer.call("initialize", {
		protocolVersion: 1,
		...(capability === null ? {} : { clientCapabilities: { _meta: { "clio-coder/toolProgress": capability } } }),
	})) as { agentCapabilities: { _meta: Record<string, unknown> } };
	const session = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await peer.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "build" }] });
	peer.transport.close();
	strictEqual(await served, 0);
	const updates = peer.notifications
		.filter((entry) => entry.method === "session/update")
		.map((entry) => (entry.params as { update: Record<string, unknown> }).update);
	return {
		init,
		updates,
		progress: updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.status === "in_progress"),
		terminal: updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed"),
	};
}

/** The text of one `toolCallContent` payload. */
function progressText(update: Record<string, unknown>): string {
	const content = update.content as Array<{ content: { text: string } }>;
	return content[0]?.content.text ?? "";
}

describe("contracts/acp streams a running tool's cumulative output only to a client that opted in", () => {
	it("sends no in-progress frames to a client that did not opt in, and still sends the terminal update", async () => {
		const turn = await runTurn({
			optIn: false,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				for (const snapshot of ["a", "ab", "abc"]) {
					advance(1000);
					emit(progressEvent(snapshot));
				}
				emit(TOOL_END);
			},
		});
		strictEqual(turn.progress.length, 0);
		strictEqual(turn.terminal.length, 1);
	});

	// A near-miss opt-in is the dangerous case: a client that sent one believes it
	// asked for nothing, so honouring it would leak an unrequested stream to a
	// strict client. Only the exact `{version: 1}` record turns the stream on.
	for (const [label, capability] of [
		["a version this build does not speak", { version: 2 }],
		["a version that is a string", { version: "1" }],
		["a record with no version at all", {}],
		["a bare true", true],
		["an array", [{ version: 1 }]],
		["an explicit null", null],
	] as Array<[string, unknown]>) {
		it(`sends no in-progress frames when the opt-in is ${label}`, async () => {
			const turn = await runTurn({
				optIn: { capability },
				script: ({ emit, advance }) => {
					emit(TOOL_START);
					for (const snapshot of ["a", "ab", "abc"]) {
						advance(1000);
						emit(progressEvent(snapshot));
					}
					emit(TOOL_END);
				},
			});
			strictEqual(turn.progress.length, 0);
			strictEqual(turn.terminal.length, 1);
		});
	}

	it("announces its bounds and forwards each distinct snapshot as a non-terminal tool_call_update", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				for (const snapshot of ["a", "ab", "abc"]) {
					advance(1000);
					emit(progressEvent(snapshot));
				}
				emit(TOOL_END);
			},
		});
		deepStrictEqual(turn.init.agentCapabilities._meta["clio-coder/toolProgress"], {
			version: 1,
			minIntervalMs: ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
			maxFramesPerCall: ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
			maxContentBytes: ACP_MAX_CHUNK_BYTES,
		});
		deepStrictEqual(turn.progress.map(progressText), ["a", "ab", "abc"]);
		for (const frame of turn.progress) strictEqual(frame.toolCallId, "call-1");
		// The terminal update is unaffected: it still arrives exactly once, after
		// every progress frame, and it is the last word on the call.
		strictEqual(turn.terminal.length, 1);
		strictEqual(turn.updates.indexOf(turn.terminal[0] as Record<string, unknown>), turn.updates.length - 1);
	});

	it("stops at the per-call frame ceiling instead of streaming a long-running tool without end", async () => {
		const total = ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL + 6;
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				for (let index = 0; index < total; index += 1) {
					advance(1000);
					emit(progressEvent(`line ${index}`));
				}
				emit(TOOL_END);
			},
		});
		strictEqual(turn.progress.length, ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL);
		strictEqual(progressText(turn.progress[0] as Record<string, unknown>), "line 0");
		strictEqual(
			progressText(turn.progress[ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL - 1] as Record<string, unknown>),
			`line ${ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL - 1}`,
		);
		strictEqual(turn.terminal.length, 1);
	});

	it("holds the interval floor, so a burst under it collapses to the snapshot that crosses it", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				emit(progressEvent("first"));
				advance(ACP_MIN_TOOL_PROGRESS_INTERVAL_MS - 1);
				emit(progressEvent("second"));
				advance(1);
				emit(progressEvent("third"));
				emit(TOOL_END);
			},
		});
		deepStrictEqual(turn.progress.map(progressText), ["first", "third"]);
	});

	it("does not re-send a cumulative snapshot the client already has", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				emit(progressEvent("same"));
				advance(1000);
				emit(progressEvent("same"));
				advance(1000);
				emit(progressEvent("changed"));
				emit(TOOL_END);
			},
		});
		deepStrictEqual(turn.progress.map(progressText), ["same", "changed"]);
	});

	it("drops a frame that names no open call rather than inventing one", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				// Before the call opens, for a call that never opened, and after the
				// call has already reached its terminal update.
				emit(progressEvent("early"));
				emit(TOOL_START);
				advance(1000);
				emit(progressEvent("other", "call-9"));
				emit(TOOL_END);
				advance(1000);
				emit(progressEvent("late"));
			},
		});
		strictEqual(turn.progress.length, 0);
		strictEqual(turn.terminal.length, 1);
		ok(turn.updates.every((update) => update.toolCallId === undefined || update.toolCallId === "call-1"));
	});
});
