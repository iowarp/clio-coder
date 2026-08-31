import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
	BusChannels,
	type DispatchCompletedPayload,
	type DispatchEnqueuedPayload,
	type DispatchFailedPayload,
	type DispatchProgressPayload,
	type DispatchStartedPayload,
} from "../../src/core/bus-events.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import { createStdioServerTransport } from "../../src/engine/acp/transport.js";

/**
 * Contract coverage for the two additive ACP server surfaces that let a client
 * draw a truthful fleet board: the dispatch lifecycle on the opt-in
 * `clio-coder/event` stream, and per-frame agent attribution on
 * `session/update`. Both are additive: a client that reads neither observes the
 * same frames it observed before.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RpcClient {
	request<T>(method: string, params?: unknown): Promise<T>;
	notifications: Array<Record<string, unknown>>;
	close(): void;
}

function createRpcClient(input: PassThrough, output: PassThrough): RpcClient {
	let nextId = 1;
	let buffer = "";
	const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
	const notifications: Array<Record<string, unknown>> = [];
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const idx = buffer.indexOf("\n");
			if (idx === -1) break;
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.trim().length === 0) continue;
			const message = JSON.parse(line) as Record<string, unknown>;
			if ("id" in message && ("result" in message || "error" in message)) {
				const entry = pending.get(Number(message.id));
				if (!entry) continue;
				pending.delete(Number(message.id));
				if (isRecord(message.error)) entry.reject(new Error(String(message.error.message ?? "RPC error")));
				else entry.resolve(message.result);
				continue;
			}
			notifications.push(message);
		}
	});
	return {
		notifications,
		request<T>(method: string, params?: unknown): Promise<T> {
			const id = nextId++;
			const answer = new Promise<T>((resolve, reject) => {
				pending.set(id, { resolve: (value) => resolve(value as T), reject });
			});
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return answer;
		},
		close(): void {
			input.end();
		},
	};
}

interface Harness {
	client: RpcClient;
	server: Promise<number>;
}

function startAcpServer(input: { chat: AcpServerChat; bus?: SafeEventBus }): Harness {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
	const server = serveClioAcpAgent({ cwd: process.cwd(), version: "test", ...input, transport });
	return { client: createRpcClient(clientToServer, serverToClient), server };
}

/** One assistant turn that opens a `dispatch` tool call, then closes it. */
function createDispatchingChat(duringTool: () => void): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "delegated" }],
		stopReason: "stop",
		usage: { input: 1, output: 1 },
	};
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			emit({ type: "text_delta", delta: "delegated" });
			emit({ type: "tool_execution_start", toolCallId: "engine-call-1", toolName: "dispatch", args: { agent: "x" } });
			duringTool();
			emit({
				type: "tool_execution_end",
				toolCallId: "engine-call-1",
				toolName: "dispatch",
				result: "ok",
				isError: false,
			});
			emit({ type: "message_end", message: assistant });
			emit({ type: "agent_end", messages: [assistant] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: unknown) => void): () => void {
			listeners.add(handler as (event: Record<string, unknown>) => void);
			return () => listeners.delete(handler as (event: Record<string, unknown>) => void);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
		dispose: () => {},
	};
}

const ALL_EVENT_KINDS = [
	"safety.loopBlocked",
	"dispatch.enqueued",
	"dispatch.started",
	"dispatch.progress",
	"dispatch.completed",
	"dispatch.failed",
];

function initializeParams(kinds: readonly string[] | null): Record<string, unknown> {
	return {
		protocolVersion: 1,
		...(kinds === null ? {} : { clientCapabilities: { _meta: { "clio-coder/events": { version: 1, kinds } } } }),
	};
}

function eventFrames(client: RpcClient): Array<Record<string, unknown>> {
	return client.notifications
		.filter((frame) => frame.method === "clio-coder/event")
		.map((frame) => frame.params as Record<string, unknown>);
}

function updateFrames(client: RpcClient): Array<Record<string, unknown>> {
	return client.notifications
		.filter((frame) => frame.method === "session/update")
		.map((frame) => frame.params as Record<string, unknown>);
}

const RUN_IDENTITY = {
	runId: "run-1",
	agentId: "explorer",
	targetId: "target-a",
	wireModelId: "model-a",
	runtimeId: "runtime-a",
	runtimeKind: "subprocess",
} as const;

function enqueued(task: string): DispatchEnqueuedPayload {
	return { ...RUN_IDENTITY, task, requestOrigin: "agent" };
}

function started(task: string): DispatchStartedPayload {
	return {
		...enqueued(task),
		pid: 4242,
		assignmentId: "assignment-1",
		attempt: 0,
		parentToolCallId: "engine-call-1",
		node: "blade",
	};
}

function progress(): DispatchProgressPayload {
	return { runId: RUN_IDENTITY.runId, agentId: RUN_IDENTITY.agentId, event: { type: "text_delta", delta: "secret" } };
}

const TERMINAL_STATS = {
	lineage: { parentRunId: null, rootRunId: "run-1", attempt: 0, depth: 1 },
	tokenCount: 120,
	inputTokenCount: 100,
	outputTokenCount: 20,
	cacheReadTokenCount: 0,
	cacheWriteTokenCount: 0,
	reasoningTokenCount: 0,
	staticShellHash: null,
	sessionShellHash: null,
	dynamicHash: null,
	costUsd: 0,
	durationMs: 900,
	exitCode: 0,
	toolActivity: null,
} as const;

function completed(): DispatchCompletedPayload {
	return {
		...enqueued("run the suite"),
		...TERMINAL_STATS,
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
	};
}

function failed(): DispatchFailedPayload {
	return {
		...enqueued("run the suite"),
		outcome: "timed_out",
		outcomeCode: null,
		outcomeDetail: "/home/operator/secrets.env could not be read",
		reason: "timed_out",
		durationMs: 400,
	};
}

describe("contracts/acp-fleet-events", () => {
	it("forwards the dispatch lifecycle only to a client that opted into each kind", async () => {
		for (const kinds of [null, ["safety.loopBlocked"], ALL_EVENT_KINDS]) {
			const bus = createSafeEventBus();
			const harness = startAcpServer({
				bus,
				chat: createDispatchingChat(() => {
					bus.emit(BusChannels.DispatchEnqueued, enqueued("audit the crash"));
					bus.emit(BusChannels.DispatchStarted, started("audit the crash"));
					bus.emit(BusChannels.DispatchProgress, progress());
					bus.emit(BusChannels.DispatchCompleted, completed());
				}),
			});
			try {
				await harness.client.request("initialize", initializeParams(kinds));
				const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
				await harness.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "go" }] });
				const frames = eventFrames(harness.client);
				if (kinds === null || kinds.length === 1) {
					strictEqual(frames.length, 0, "a client that did not ask for dispatch kinds receives none");
					continue;
				}
				deepStrictEqual(
					frames.map((frame) => frame.kind),
					["dispatch.enqueued", "dispatch.started", "dispatch.progress", "dispatch.completed"],
				);
				deepStrictEqual(
					frames.map((frame) => frame.sequence),
					[1, 2, 3, 4],
				);
				for (const frame of frames) {
					strictEqual(frame.version, 1);
					strictEqual(frame.sessionId, id);
					strictEqual(frame.turnId, null);
				}
				strictEqual(frames[0]?.terminal, false);
				strictEqual(frames[3]?.terminal, true, "a completed run is a terminal fact");
			} finally {
				harness.client.close();
				await harness.server;
			}
		}
	});

	it("sanitizes and bounds the task and never forwards free-form failure prose", async () => {
		const bus = createSafeEventBus();
		const rawTask = `line one\nline two ${"z".repeat(400)}`;
		const harness = startAcpServer({
			bus,
			chat: createDispatchingChat(() => {
				bus.emit(BusChannels.DispatchEnqueued, enqueued(rawTask));
				bus.emit(BusChannels.DispatchFailed, failed());
			}),
		});
		try {
			await harness.client.request("initialize", initializeParams(ALL_EVENT_KINDS));
			const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
			await harness.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "go" }] });
			const frames = eventFrames(harness.client);
			const enqueuedPayload = frames[0]?.payload as Record<string, unknown>;
			const preview = enqueuedPayload.taskPreview as string;
			ok(preview.startsWith("line one line two"), "control characters become spaces rather than crossing raw");
			ok(!preview.includes("\n"), "no newline reaches the wire");
			ok(Buffer.byteLength(preview, "utf8") <= 160, "the preview is byte bounded");
			ok(preview.endsWith("…[truncated]"), "truncation is announced, not silent");
			ok(preview !== rawTask, "the exact task never crosses");
			const failedPayload = frames[1]?.payload as Record<string, unknown>;
			deepStrictEqual(failedPayload, {
				runId: "run-1",
				agentId: "explorer",
				outcome: "timed_out",
				reason: "timed_out",
				durationMs: 400,
			});
			ok(!JSON.stringify(frames).includes("secrets.env"), "outcomeDetail prose stays host side");
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("drops the worker event stream and caps a run's forwarded progress", async () => {
		const bus = createSafeEventBus();
		const harness = startAcpServer({
			bus,
			chat: createDispatchingChat(() => {
				for (let index = 0; index < 300; index += 1) bus.emit(BusChannels.DispatchProgress, progress());
			}),
		});
		try {
			await harness.client.request("initialize", initializeParams(ALL_EVENT_KINDS));
			const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
			await harness.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "go" }] });
			const frames = eventFrames(harness.client);
			strictEqual(frames.length, 257, "256 progress frames plus one truncation marker");
			deepStrictEqual(frames[0]?.payload, {
				runId: "run-1",
				agentId: "explorer",
				progressCount: 1,
				truncated: false,
			});
			deepStrictEqual(frames[256]?.payload, {
				runId: "run-1",
				agentId: "explorer",
				progressCount: 257,
				truncated: true,
			});
			ok(!JSON.stringify(frames).includes("secret"), "the untyped worker event never crosses");
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("refuses the whole opt-in when any requested kind is unrepresentable", async () => {
		const bus = createSafeEventBus();
		const harness = startAcpServer({
			bus,
			chat: createDispatchingChat(() => {
				bus.emit(BusChannels.DispatchStarted, started("audit"));
			}),
		});
		try {
			await harness.client.request("initialize", initializeParams(["dispatch.started", "x".repeat(65)]));
			const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
			await harness.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "go" }] });
			strictEqual(eventFrames(harness.client).length, 0);
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("advertises every forwardable kind at initialize", async () => {
		const bus = createSafeEventBus();
		const harness = startAcpServer({ bus, chat: createDispatchingChat(() => {}) });
		try {
			const init = await harness.client.request<Record<string, unknown>>("initialize", initializeParams(null));
			const meta = (init.agentCapabilities as Record<string, unknown>)._meta as Record<string, unknown>;
			const events = meta["clio-coder/events"] as Record<string, unknown>;
			strictEqual(events.version, 1);
			strictEqual(events.notification, "clio-coder/event");
			deepStrictEqual(events.kinds, ALL_EVENT_KINDS);
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("forwards a dispatch run that outlives the turn that started it", async () => {
		const bus = createSafeEventBus();
		const harness = startAcpServer({ bus, chat: createDispatchingChat(() => {}) });
		try {
			await harness.client.request("initialize", initializeParams(ALL_EVENT_KINDS));
			const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
			await harness.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "go" }] });
			// The prompt has settled. A detached run's own completion is still a fact
			// about this session, so it crosses; a loop block is not, so it does not.
			bus.emit(BusChannels.DispatchCompleted, completed());
			bus.emit(BusChannels.LoopBlocked, {
				tool: "bash",
				repeatCount: 3,
				blocksThisTurn: 1,
				budget: 3,
				interrupted: false,
				disposition: "block",
				at: Date.now(),
				turnId: "turn-1",
			});
			const frames = eventFrames(harness.client);
			deepStrictEqual(
				frames.map((frame) => frame.kind),
				["dispatch.completed"],
			);
			deepStrictEqual(frames[0]?.payload, {
				runId: "run-1",
				agentId: "explorer",
				outcome: "succeeded",
				outcomeCode: null,
				durationMs: 900,
				tokenCount: 120,
			});
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("attributes every live session update and labels the tool call a worker ran under", async () => {
		const bus = createSafeEventBus();
		const harness = startAcpServer({
			bus,
			chat: createDispatchingChat(() => {
				bus.emit(BusChannels.DispatchStarted, started("audit the crash"));
			}),
		});
		try {
			await harness.client.request("initialize", initializeParams(null));
			const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
			await harness.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "go" }] });
			const frames = updateFrames(harness.client);
			const orchestrator = { version: 1, role: "orchestrator", agentId: "orchestrator" };
			for (const frame of frames) {
				const meta = frame._meta as Record<string, unknown>;
				const agents = meta["clio-coder/agent"] as Array<Record<string, unknown>>;
				ok(Array.isArray(agents) && agents.length >= 1, "every live frame names who produced it");
				deepStrictEqual(agents[0], orchestrator, "the orchestrator is always the first attribution");
			}
			const kinds = frames.map((frame) => (frame.update as Record<string, unknown>).sessionUpdate);
			deepStrictEqual(kinds, ["agent_message_chunk", "tool_call", "tool_call_update", "tool_call_update"]);
			const worker = {
				version: 1,
				role: "worker",
				agentId: "explorer",
				runId: "run-1",
				node: "blade",
			};
			// The `tool_call` was already on the wire when the worker started, so the
			// attribution arrives as an in-progress re-announcement of the same call.
			const announce = frames[2] as Record<string, unknown>;
			deepStrictEqual((announce._meta as Record<string, unknown>)["clio-coder/agent"], [orchestrator, worker]);
			deepStrictEqual(announce.update, {
				sessionUpdate: "tool_call_update",
				toolCallId: "engine-call-1",
				title: "dispatch",
				kind: "other",
				status: "in_progress",
			});
			// The terminal update for that call carries the same attribution.
			const terminal = frames[3] as Record<string, unknown>;
			deepStrictEqual((terminal._meta as Record<string, unknown>)["clio-coder/agent"], [orchestrator, worker]);
			strictEqual((terminal.update as Record<string, unknown>).status, "completed");
			// Attribution is additive: it lives in `_meta`, never inside `update`.
			for (const frame of frames) {
				ok(!Object.hasOwn(frame.update as Record<string, unknown>, "_meta"));
			}
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("binds a delegated agent only to a tool call the client already saw start", async () => {
		const bus = createSafeEventBus();
		const harness = startAcpServer({
			bus,
			chat: createDispatchingChat(() => {
				bus.emit(BusChannels.DispatchStarted, { ...started("audit"), parentToolCallId: "engine-call-unknown" });
			}),
		});
		try {
			await harness.client.request("initialize", initializeParams(null));
			const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
			await harness.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "go" }] });
			const frames = updateFrames(harness.client);
			deepStrictEqual(
				frames.map((frame) => (frame.update as Record<string, unknown>).sessionUpdate),
				["agent_message_chunk", "tool_call", "tool_call_update"],
				"an unbindable parent mints nothing",
			);
			for (const frame of frames) {
				const agents = (frame._meta as Record<string, unknown>)["clio-coder/agent"] as unknown[];
				strictEqual(agents.length, 1, "no call is labelled with an agent it did not start");
			}
		} finally {
			harness.client.close();
			await harness.server;
		}
	});
});
