/**
 * An attended remote client (a person answering from another device, often
 * minutes later) learns everything over ACP: the window it is given, when an
 * ask it still shows was abandoned, and a launch cap on autonomy.
 */
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { parseAcpFlags } from "../../src/cli/acp.js";
import { launchAutonomyRefusal } from "../../src/core/yolo-host.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { AcpTimeoutError } from "../../src/engine/acp/errors.js";
import { createAcpInterviewChannel } from "../../src/engine/acp/host-members.js";
import { type AcpServerChat, createAcpHandshake, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";

const INTERVIEWS = { version: 1, request: "_clio-coder/interview/request" };
const WORKER_PERMISSIONS = { version: 1, withdraw: "_clio-coder/permission/withdraw" };
const FEATURES = {
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
/** A write outside the workspace, which default autonomy parks for approval. */
const OUTSIDE_WRITE = { path: "../clio-coder-acp-remote-probe.txt", content: "hello\n" };

test("a client negotiates both request windows at initialize; the operator's flag wins and a bad value refuses the opt-in", () => {
	const initialize = (meta: Record<string, unknown>, pinnedTimeoutMs?: number) => {
		const handshake = createAcpHandshake({
			...FEATURES,
			...(pinnedTimeoutMs !== undefined ? { pinnedTimeoutMs } : {}),
		});
		const response = handshake.initialize({ protocolVersion: 1, clientCapabilities: { _meta: meta } });
		return { handshake, echo: response.agentCapabilities?._meta as Record<string, unknown> };
	};
	const negotiated = initialize({
		"clio-coder/interviews": { ...INTERVIEWS, timeoutMs: 900_000 },
		"clio-coder/workerPermissions": { ...WORKER_PERMISSIONS, timeoutMs: 600_000 },
	});
	strictEqual(negotiated.handshake.interviewTimeoutMs, 900_000);
	strictEqual(negotiated.handshake.permissionRequestTimeoutMs, 600_000);
	deepStrictEqual(negotiated.echo["clio-coder/interviews"], {
		...INTERVIEWS,
		cancel: "_clio-coder/interview/cancel",
		timeoutMs: 900_000,
	});
	deepStrictEqual(negotiated.echo["clio-coder/workerPermissions"], { ...WORKER_PERMISSIONS, timeoutMs: 600_000 });

	// Without timeoutMs the host keeps its configured window and echoes none.
	const plain = initialize({ "clio-coder/interviews": INTERVIEWS, "clio-coder/workerPermissions": WORKER_PERMISSIONS });
	strictEqual(plain.handshake.interviewTimeoutMs, null);
	strictEqual(plain.handshake.permissionRequestTimeoutMs, null);
	deepStrictEqual(plain.echo["clio-coder/interviews"], { ...INTERVIEWS, cancel: "_clio-coder/interview/cancel" });
	deepStrictEqual(plain.echo["clio-coder/workerPermissions"], WORKER_PERMISSIONS);

	// The operator's explicit --permission-timeout is applied and echoed instead.
	const pinned = initialize(
		{
			"clio-coder/interviews": { ...INTERVIEWS, timeoutMs: 900_000 },
			"clio-coder/workerPermissions": { ...WORKER_PERMISSIONS, timeoutMs: 600_000 },
		},
		30_000,
	);
	strictEqual(pinned.handshake.interviewTimeoutMs, 30_000);
	strictEqual(pinned.handshake.permissionRequestTimeoutMs, 30_000);
	strictEqual((pinned.echo["clio-coder/workerPermissions"] as { timeoutMs: number }).timeoutMs, 30_000);

	for (const bad of [0, -1, 1.5, "60000", 2 ** 31, null]) {
		const refused = initialize({
			"clio-coder/interviews": { ...INTERVIEWS, timeoutMs: bad },
			"clio-coder/workerPermissions": { ...WORKER_PERMISSIONS, timeoutMs: bad },
		});
		strictEqual(refused.handshake.interviewsEnabled, false, `interviews refused for ${String(bad)}`);
		strictEqual(refused.handshake.workerPermissionsEnabled, false, `workerPermissions refused for ${String(bad)}`);
		strictEqual(refused.echo["clio-coder/interviews"], undefined);
		strictEqual(refused.echo["clio-coder/workerPermissions"], undefined);
	}
});

interface RemoteHarness {
	asks: Array<{ params: Record<string, unknown>; timeoutMs: number | undefined }>;
	notifications: Array<{ method: string; params: Record<string, unknown> }>;
	verdict: string;
	expired: boolean;
}

/**
 * One prompt whose write parks for approval, against a client that opted in
 * (or not) and answers the ask the way `answer` says.
 */
async function remoteAsk(input: {
	clientMeta: Record<string, unknown>;
	answer: "timeout" | "never";
	/** Settle the parked call some other way once the ask is out. */
	settleElsewhere?: boolean;
}): Promise<RemoteHarness> {
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }), autonomy: () => "default" });
	registry.register(writeTool);
	const harness: RemoteHarness = { asks: [], notifications: [], verdict: "", expired: false };
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	let asked: () => void = () => {};
	const askSent = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async (_method, params, timeoutMs) => {
			harness.asks.push({ params: params as Record<string, unknown>, timeoutMs });
			asked();
			if (input.answer === "timeout") throw new AcpTimeoutError("ACP request timed out");
			return await new Promise<never>(() => {});
		},
		notify: (method, params) => harness.notifications.push({ method, params: params as Record<string, unknown> }),
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
	let emit: (event: unknown) => void = () => {};
	const chat: AcpServerChat = {
		submit: async () => {
			emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "write", args: OUTSIDE_WRITE });
			const pending = registry.invoke({ tool: "write", args: OUTSIDE_WRITE }, { toolCallId: "call-1" });
			if (input.settleElsewhere) {
				await askSent;
				registry.cancelParkedCalls("the turn ended elsewhere");
			}
			const result = await pending;
			harness.verdict = result.kind;
			emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "write", result, isError: false });
		},
		cancel: () => {
			harness.expired = true;
		},
		onEvent: (handler) => {
			emit = handler;
			return () => {
				emit = () => {};
			};
		},
		isStreaming: () => false,
		getSessionId: () => null,
	};
	const served = serveClioAcpAgent({
		transport,
		chat,
		toolRegistry: registry,
		autonomy: () => "default",
		cwd: process.cwd(),
		permissionTimeoutMs: 120_000,
		workerPermissions: { resolve: () => {} },
	});
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", { protocolVersion: 1, clientCapabilities: { _meta: input.clientMeta } });
	const session = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	try {
		await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });
	} catch (err) {
		// An expired approval ends the prompt with `permission approval expired`, as it always has.
		strictEqual(input.answer, "timeout", String(err));
	}
	// The settled-elsewhere poll runs on its own timer.
	for (let tries = 0; tries < 40 && !harness.notifications.some((n) => n.method.endsWith("/withdraw")); tries += 1) {
		if (!input.settleElsewhere) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	close();
	await served;
	return harness;
}

test("a main-session ask that times out is withdrawn by the id it carried, under the negotiated window", async () => {
	const turn = await remoteAsk({
		clientMeta: { "clio-coder/workerPermissions": { ...WORKER_PERMISSIONS, timeoutMs: 4242 } },
		answer: "timeout",
	});
	const ask = turn.asks[0];
	ok(ask, "the write was asked over session/request_permission");
	strictEqual(ask.timeoutMs, 4242, "the request ran under the client's negotiated window");
	const askMeta = (ask.params._meta as Record<string, { version: number; requestId: string }>)[
		"clio-coder/permissionAsk"
	];
	ok(askMeta?.requestId, "the request names an id the client can match");
	strictEqual(askMeta.version, 1);
	const withdrawn = turn.notifications.filter((frame) => frame.method === "_clio-coder/permission/withdraw");
	deepStrictEqual(
		withdrawn.map((frame) => frame.params),
		[{ sessionId: ask.params.sessionId, requestId: askMeta.requestId }],
	);
	strictEqual(turn.expired, true, "the expiry still ends the turn as before");
});

test("a main-session ask settled elsewhere is withdrawn while the client still holds it", async () => {
	const turn = await remoteAsk({
		clientMeta: { "clio-coder/workerPermissions": WORKER_PERMISSIONS },
		answer: "never",
		settleElsewhere: true,
	});
	const requestId = (turn.asks[0]?.params._meta as Record<string, { requestId: string }>)["clio-coder/permissionAsk"]
		?.requestId;
	ok(requestId);
	deepStrictEqual(
		turn.notifications
			.filter((frame) => frame.method === "_clio-coder/permission/withdraw")
			.map((f) => f.params.requestId),
		[requestId],
	);
	strictEqual(turn.asks[0]?.timeoutMs, 120_000, "without a negotiated window the configured one applies");
});

test("a client that did not opt in sees the main-session ask exactly as before", async () => {
	const turn = await remoteAsk({ clientMeta: {}, answer: "timeout" });
	const meta = turn.asks[0]?.params._meta as Record<string, unknown>;
	ok(meta?.["clio-coder/decision"]);
	strictEqual("clio-coder/permissionAsk" in meta, false);
	strictEqual(turn.notifications.filter((frame) => frame.method === "_clio-coder/permission/withdraw").length, 0);
	strictEqual(turn.asks[0]?.timeoutMs, 120_000);
});

test("an interview round runs under the window the client negotiated", async () => {
	const handlers = new Map<string, (params: unknown) => unknown>();
	const timeouts: Array<number | undefined> = [];
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async (_method, _params, timeoutMs) => {
			timeouts.push(timeoutMs);
			return { answers: [], cancelled: true } as never;
		},
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
	const interviews = createAcpInterviewChannel();
	const served = serveClioAcpAgent({
		transport,
		chat: {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => false,
			getSessionId: () => null,
		},
		cwd: process.cwd(),
		permissionTimeoutMs: 120_000,
		interviews,
	});
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", {
		protocolVersion: 1,
		clientCapabilities: { _meta: { "clio-coder/interviews": { ...INTERVIEWS, timeoutMs: 4343 } } },
	});
	await call("session/new", { cwd: process.cwd(), mcpServers: [] });
	await interviews.ask([{ question: "Continue?" }]);
	close();
	await served;
	deepStrictEqual(timeouts, [4343]);
});

test("an interview names the option the host recommends in _meta, leaving the question shape unchanged", async () => {
	const sent: Array<Record<string, unknown>> = [];
	const channel = createAcpInterviewChannel();
	channel.attach({
		transport: {
			request: async <T>(_method: string, params?: unknown) => {
				sent.push(params as Record<string, unknown>);
				return { answers: [], cancelled: true } as T;
			},
			notify: () => {},
		},
		sessionId: () => "session-1",
		enabled: () => true,
	});
	await channel.ask([
		// The harness's preselection wins, counted after an empty label is dropped.
		{ question: "Merge?", defaultOption: 2, options: [{ label: "\u0007" }, { label: "Merge" }, { label: "Keep" }] },
		// Else the label that says so, else the first.
		{ question: "Scope?", options: [{ label: "All" }, { label: "Phase 1 (Recommended)" }] },
		{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] },
		{ question: "Anything else?" },
	]);
	deepStrictEqual(sent[0]?._meta, {
		"clio-coder/interview": { version: 1, operatorOnly: false, recommended: [1, 1, 0, null] },
	});
	deepStrictEqual((sent[0]?.questions as unknown[])[0], {
		question: "Merge?",
		options: [{ label: "Merge" }, { label: "Keep" }],
	});
});

test("acp --autonomy default caps the process: yolo is refused, and a write asks over session/request_permission", async () => {
	deepStrictEqual(parseAcpFlags(["--autonomy", "default"]), { autonomyCeiling: "default" });
	strictEqual(typeof parseAcpFlags(["--autonomy", "max"]), "string");
	strictEqual(launchAutonomyRefusal("yolo"), null);
	const refusal = launchAutonomyRefusal("default");
	ok(refusal?.includes("--autonomy default"));

	// What the orchestrator resolves under the cap: its baseline reads yolo from
	// settings and the launch refusal turns it to default (resolveBaselineAutonomy).
	const settingsAutonomy: AutonomyLevel = "yolo";
	const baseline = (): AutonomyLevel => (settingsAutonomy === "yolo" && refusal !== null ? "default" : settingsAutonomy);
	let sessionLevel: AutonomyLevel | null = null;
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd: process.cwd() }),
		autonomy: () => sessionLevel ?? baseline(),
	});
	registry.register(writeTool);
	const asks: string[] = [];
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async (method) => {
			asks.push(method);
			return { outcome: { outcome: "selected", optionId: "reject-once" } } as never;
		},
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
	let emit: (event: unknown) => void = () => {};
	const served = serveClioAcpAgent({
		transport,
		chat: {
			submit: async () => {
				emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "write", args: OUTSIDE_WRITE });
				const result = await registry.invoke({ tool: "write", args: OUTSIDE_WRITE }, { toolCallId: "call-1" });
				emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "write", result, isError: false });
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
		},
		toolRegistry: registry,
		cwd: process.cwd(),
		autonomy: baseline,
		yoloRefusal: () => refusal,
		onActiveSessionAutonomyChange: (level) => {
			sessionLevel = level;
		},
	});
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", { protocolVersion: 1 });
	const session = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as {
		sessionId: string;
		modes: { currentModeId: string };
	};
	strictEqual(session.modes.currentModeId, "default", "the session starts under the cap, not at the settings' yolo");
	await rejects(
		Promise.resolve(call("session/set_mode", { sessionId: session.sessionId, modeId: "yolo" })),
		(err: { detail?: { code?: string } }) => err.detail?.code === "yolo_refused",
	);
	await rejects(
		Promise.resolve(
			call("session/set_config_option", { sessionId: session.sessionId, configId: "autonomy", value: "yolo" }),
		),
		(err: { detail?: { code?: string } }) => err.detail?.code === "yolo_refused",
	);
	await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "write it" }] });
	close();
	await served;
	deepStrictEqual(asks, ["session/request_permission"]);
});
