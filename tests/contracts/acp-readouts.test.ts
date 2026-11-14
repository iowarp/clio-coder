import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { AutonomyStatus } from "../../src/domains/safety/autonomy-window.js";
import type { AcpAutonomyPosture } from "../../src/engine/acp/readouts.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import {
	ACP_ADMISSION_META_KEY,
	ACP_READOUTS_NOTIFICATION,
	type AcpReadoutsNotification as AcpReadoutsFrame,
	AcpReadoutsNotification,
} from "../../src/engine/acp/types.js";

type AdmissionListener = (event: { toolCallId: string; state: "judging" | "admitted" }) => void;

interface Turn {
	emit(event: unknown): void;
	/** Sets the injected clock the throttle measures against. */
	at(ms: number): void;
	admission(event: Parameters<AdmissionListener>[0]): void;
	/** Readouts frames sent so far. */
	frames(): AcpReadoutsFrame[];
}

const TICK = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A served agent the test plays the client to: handlers are called directly and every notification is kept. */
function harness(input: { optIn: boolean }) {
	const requests = new Map<string, (params: unknown) => unknown>();
	const sent: Array<{ method: string; params: unknown }> = [];
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			sent.push({ method, params });
		},
		onRequest: (method, handler) => {
			requests.set(method, handler);
			return () => requests.delete(method);
		},
		onNotification: () => () => {},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	let clock = 0;
	let script: (turn: Turn) => void = () => {};
	let admission: AdmissionListener = () => {};
	const handlers = new Set<(event: unknown) => void>();
	const state = {
		posture: { confinement: "contained", osSandbox: true } as AcpAutonomyPosture,
		status: null as AutonomyStatus | null,
		skills: [] as string[],
	};
	const frames = (): AcpReadoutsFrame[] =>
		sent.filter((entry) => entry.method === ACP_READOUTS_NOTIFICATION).map((entry) => entry.params as AcpReadoutsFrame);
	const chat: AcpServerChat = {
		submit: async () => {
			script({
				emit: (event) => {
					for (const handler of [...handlers]) handler(event);
				},
				at: (ms) => {
					clock = ms;
				},
				admission: (event) => admission(event),
				frames,
			});
		},
		cancel: () => {},
		onEvent: (handler) => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		isStreaming: () => false,
		getSessionId: () => null,
		autonomyStatus: () => state.status,
		activeSkillSurface: () => state.skills,
	};
	const done = serveClioAcpAgent({
		transport,
		chat,
		cwd: process.cwd(),
		now: () => clock,
		autonomyPosture: () => state.posture,
		toolRegistry: {
			onPermissionRequired: () => () => {},
			onAdmissionReview: (listener: AdmissionListener) => {
				admission = listener;
				return () => {
					admission = () => {};
				};
			},
			cancelParkedCalls: () => {},
		} as never,
	});
	const call = async (method: string, params: unknown): Promise<unknown> => {
		const handler = requests.get(method);
		if (!handler) throw new Error(`missing handler: ${method}`);
		return await handler(params);
	};
	return {
		sent,
		state,
		frames,
		call,
		initialize: () =>
			call("initialize", {
				protocolVersion: 1,
				...(input.optIn ? { clientCapabilities: { _meta: { "clio-coder/readouts": { version: 1 } } } } : {}),
			}) as Promise<{ agentCapabilities: { _meta: Record<string, unknown> } }>,
		open: async (): Promise<string> => {
			const opened = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
			await TICK();
			return opened.sessionId;
		},
		prompt: async (sessionId: string, turn: (turn: Turn) => void) => {
			script = turn;
			return await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		},
		stop: async () => {
			close();
			strictEqual(await done, 0);
		},
	};
}

function delta(text: string): Record<string, unknown> {
	return {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: {
			type: "text_delta",
			delta: text.slice(-1),
			partial: { role: "assistant", content: [{ type: "text", text }] },
		},
	};
}

const AGENT_START = { type: "agent_start" };
const MESSAGE_START = { type: "message_start", message: { role: "assistant" } };
const TOOL_START = { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } };
const TOOL_END = {
	type: "tool_execution_end",
	toolCallId: "call-1",
	toolName: "bash",
	result: { output: "ok" },
	isError: false,
};
const WAITING = {
	type: "retry_status",
	status: { phase: "waiting", seconds: 4, attempt: 1, maxAttempts: 3, errorMessage: "HTTP 503 secret body" },
};
const RECOVERED = { type: "retry_status", status: { phase: "recovered", attempt: 1, maxAttempts: 3 } };

function assertWellFormed(frames: AcpReadoutsFrame[]): void {
	for (const frame of frames) ok(Value.Check(AcpReadoutsNotification, frame), JSON.stringify(frame));
	for (let i = 1; i < frames.length; i += 1) {
		const previous = frames[i - 1];
		const current = frames[i];
		ok(previous !== undefined && current !== undefined);
		strictEqual(current.sequence, previous.sequence + 1);
		if (current.sessionId === previous.sessionId)
			ok(JSON.stringify(current.readouts) !== JSON.stringify(previous.readouts), "two identical frames in a row");
	}
}

describe("contracts/acp pushes live readouts and judge admission to a client that opted in", () => {
	it("advertises the readouts capability", async () => {
		const agent = harness({ optIn: false });
		const init = await agent.initialize();
		deepStrictEqual(init.agentCapabilities._meta["clio-coder/readouts"], {
			version: 1,
			notification: "_clio-coder/session/readouts",
			minIntervalMs: 250,
			admission: "clio-coder/admission",
		});
		await agent.stop();
	});

	it("sends nothing new to a client that did not opt in", async () => {
		const agent = harness({ optIn: false });
		await agent.initialize();
		const sessionId = await agent.open();
		await agent.call("session/set_mode", { sessionId, modeId: "yolo" });
		await agent.prompt(sessionId, (turn) => {
			turn.emit(AGENT_START);
			turn.emit(MESSAGE_START);
			turn.emit(WAITING);
			turn.emit(TOOL_START);
			turn.admission({ toolCallId: "call-1", state: "judging" });
			turn.admission({ toolCallId: "call-1", state: "admitted" });
			turn.emit(TOOL_END);
			turn.emit({ type: "agent_end" });
		});
		await TICK();
		strictEqual(agent.frames().length, 0);
		ok(!JSON.stringify(agent.sent).includes(ACP_ADMISSION_META_KEY));
		await agent.stop();
	});

	it("opens a session with one frame, null autonomy outside yolo, and names the armed skills", async () => {
		const agent = harness({ optIn: true });
		agent.state.skills = ["review", "tdd"];
		await agent.initialize();
		const sessionId = await agent.open();
		const frames = agent.frames();
		strictEqual(frames.length, 1);
		assertWellFormed(frames);
		strictEqual(frames[0]?.sessionId, sessionId);
		strictEqual(frames[0]?.readouts.autonomy, null);
		strictEqual(frames[0]?.readouts.throughput, null);
		strictEqual(frames[0]?.readouts.retry, null);
		deepStrictEqual(frames[0]?.readouts.skills, { names: ["review", "tdd"], display: "skill review, tdd" });
		agent.state.skills = [];
		await agent.call("session/set_mode", { sessionId, modeId: "yolo" });
		strictEqual(agent.frames().at(-1)?.readouts.skills, null);
		assertWellFormed(agent.frames());
		await agent.stop();
	});

	it("labels the yolo posture after each mode change", async () => {
		const agent = harness({ optIn: true });
		await agent.initialize();
		const sessionId = await agent.open();
		const cases: Array<[AcpAutonomyPosture, string, string]> = [
			[{ confinement: "contained", osSandbox: true }, "YOLO · contained", "warning"],
			[{ confinement: "contained", osSandbox: false }, "YOLO · contained (no OS sandbox)", "warning"],
			[{ confinement: "unconfined", osSandbox: true }, "YOLO · UNCONFINED", "error"],
		];
		for (const [posture, label, tone] of cases) {
			agent.state.posture = posture;
			await agent.call("session/set_mode", { sessionId, modeId: "yolo" });
			const autonomy = agent.frames().at(-1)?.readouts.autonomy;
			strictEqual(autonomy?.label, label);
			strictEqual(autonomy?.tone, tone);
			strictEqual(autonomy?.confinement, posture.confinement);
			strictEqual(autonomy?.osSandbox, posture.osSandbox);
			await agent.call("session/set_mode", { sessionId, modeId: "default" });
			strictEqual(agent.frames().at(-1)?.readouts.autonomy, null);
		}
		assertWellFormed(agent.frames());
		await agent.stop();
	});

	it("carries the yolo window while it runs and the pause once it halts", async () => {
		const agent = harness({ optIn: true });
		await agent.initialize();
		const sessionId = await agent.open();
		await agent.call("session/set_mode", { sessionId, modeId: "yolo" });
		const usage = { toolCalls: 412, activeMs: 38 * 60_000, tokens: 1_900_000 };
		agent.state.status = {
			usage,
			caps: { toolCalls: 600, minutes: 120, tokens: 5_000_000 },
			halted: null,
			osSandbox: true,
		};
		let running: AcpReadoutsFrame | undefined;
		await agent.prompt(sessionId, (turn) => {
			turn.emit(AGENT_START);
			running = turn.frames().at(-1);
			const status = agent.state.status;
			ok(status !== null);
			agent.state.status = {
				...status,
				halted: { kind: "calls", limit: 600, detail: "the run reached 600 tool calls.", usage },
			};
			turn.emit({ type: "agent_end" });
		});
		const window = running?.readouts.autonomy?.window;
		strictEqual(window?.display, "412/600 calls · 38/120 min · 1.9M/5M tok");
		strictEqual(window?.halted, false);
		const halted = agent.frames().at(-1)?.readouts.autonomy?.window;
		strictEqual(halted?.halted, true);
		ok(halted?.haltDetail?.startsWith("yolo paused:"), halted?.haltDetail);
		assertWellFormed(agent.frames());
		await agent.stop();
	});

	it("throttles a rate-only change to the interval and sends a stop in the flow at once", async () => {
		const agent = harness({ optIn: true });
		await agent.initialize();
		const sessionId = await agent.open();
		const counts: number[] = [];
		await agent.prompt(sessionId, (turn) => {
			// No rate reads until 500 ms of generation, so the 100/300/310 ms steps start there.
			turn.at(0);
			turn.emit(AGENT_START);
			turn.emit(MESSAGE_START);
			turn.emit(delta("x".repeat(40)));
			const before = turn.frames().length;
			turn.at(600);
			turn.emit(delta("x".repeat(400)));
			turn.at(700);
			turn.emit(delta("x".repeat(440)));
			counts.push(turn.frames().length - before);
			turn.at(900);
			turn.emit(delta("x".repeat(800)));
			counts.push(turn.frames().length - before);
			turn.at(910);
			turn.emit(TOOL_START);
			counts.push(turn.frames().length - before);
			turn.emit(TOOL_END);
			turn.emit({ type: "agent_end" });
		});
		deepStrictEqual(counts, [1, 2, 3]);
		const rates = agent
			.frames()
			.map((frame) => frame.readouts.throughput)
			.filter((throughput) => throughput !== null);
		strictEqual(rates[0]?.flowing, true);
		strictEqual(rates[1]?.flowing, true);
		strictEqual(rates[2]?.flowing, false);
		ok(rates[2]?.display.startsWith("last "), rates[2]?.display);
		assertWellFormed(agent.frames());
		await agent.stop();
	});

	it("closes the turn with a frame after its last update and before the response, with no rate or retry", async () => {
		const agent = harness({ optIn: true });
		await agent.initialize();
		const sessionId = await agent.open();
		await agent.prompt(sessionId, (turn) => {
			turn.emit(AGENT_START);
			turn.emit(MESSAGE_START);
			turn.at(0);
			turn.emit(delta("x".repeat(40)));
			turn.at(800);
			turn.emit(delta("x".repeat(800)));
			turn.emit(WAITING);
			turn.emit({ type: "agent_end" });
		});
		// The handler resolving is the response: everything it sent precedes it.
		const sentAtResponse = agent.sent.length;
		const methods = agent.sent.map((entry) => entry.method);
		const lastUpdate = methods.lastIndexOf("session/update");
		const lastFrame = methods.lastIndexOf(ACP_READOUTS_NOTIFICATION);
		ok(lastFrame > lastUpdate, "the closing frame follows the turn's last update");
		ok(lastFrame < sentAtResponse, "the closing frame precedes the response");
		const closing = agent.sent[lastFrame]?.params as AcpReadoutsFrame;
		strictEqual(closing.readouts.throughput, null);
		strictEqual(closing.readouts.retry, null);
		assertWellFormed(agent.frames());
		await agent.stop();
	});

	it("shows a provider retry in the terminal's words and never its error text", async () => {
		const agent = harness({ optIn: true });
		await agent.initialize();
		const sessionId = await agent.open();
		let waiting: AcpReadoutsFrame | undefined;
		let recovered: AcpReadoutsFrame | undefined;
		await agent.prompt(sessionId, (turn) => {
			turn.emit(AGENT_START);
			turn.emit(WAITING);
			waiting = turn.frames().at(-1);
			turn.emit(RECOVERED);
			recovered = turn.frames().at(-1);
			turn.emit({ type: "agent_end" });
		});
		deepStrictEqual(waiting?.readouts.retry, {
			phase: "waiting",
			active: true,
			display: "provider retry 1/3 in 4s",
		});
		ok(!JSON.stringify(waiting).includes("secret"));
		strictEqual(recovered?.readouts.retry?.phase, "recovered");
		strictEqual(recovered?.readouts.retry?.active, false);
		ok(!JSON.stringify(agent.frames()).includes("secret"));
		assertWellFormed(agent.frames());
		await agent.stop();
	});

	it("marks a call the judge holds on its open row, and nothing for a call the client never saw", async () => {
		const agent = harness({ optIn: true });
		await agent.initialize();
		const sessionId = await agent.open();
		await agent.prompt(sessionId, (turn) => {
			turn.emit(AGENT_START);
			turn.emit(TOOL_START);
			turn.admission({ toolCallId: "call-1", state: "judging" });
			turn.admission({ toolCallId: "call-1", state: "admitted" });
			turn.admission({ toolCallId: "never-drawn", state: "judging" });
			turn.emit(TOOL_END);
			turn.emit({ type: "agent_end" });
		});
		const updates = agent.sent
			.filter((entry) => entry.method === "session/update")
			.map((entry) => (entry.params as { update: Record<string, unknown> }).update);
		const drawn = updates.find((update) => update.sessionUpdate === "tool_call");
		ok(drawn !== undefined);
		const admissions = updates.filter(
			(update) => (update._meta as Record<string, unknown> | undefined)?.[ACP_ADMISSION_META_KEY] !== undefined,
		);
		strictEqual(admissions.length, 2);
		for (const update of admissions) {
			strictEqual(update.sessionUpdate, "tool_call_update");
			strictEqual(update.status, "in_progress");
			strictEqual(update.toolCallId, drawn.toolCallId);
		}
		deepStrictEqual((admissions[0]?._meta as Record<string, unknown>)[ACP_ADMISSION_META_KEY], {
			version: 1,
			state: "judging",
			display: "waiting for the safety judge",
		});
		deepStrictEqual((admissions[1]?._meta as Record<string, unknown>)[ACP_ADMISSION_META_KEY], {
			version: 1,
			state: "admitted",
		});
		await agent.stop();
	});
});
