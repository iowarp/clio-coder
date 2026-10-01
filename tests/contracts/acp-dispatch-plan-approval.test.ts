import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	ACP_DISPATCH_PLAN_MAX_TASKS,
	type AcpDispatchPlanMeta,
	projectDispatchPlanMeta,
} from "../../src/engine/acp/dispatch-plan-meta.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { describeDispatchPlan } from "../../src/tools/dispatch-plan.js";
import { createRegistry, type PermissionRequiredMeta, type ToolSpec } from "../../src/tools/registry.js";

const PLAN = {
	tasks: [
		{ agent: "scout", task: "Survey the soil samples" },
		{ agent: "writer", task: "Draft the comparison report" },
	],
	intent: "research",
};

/** The dispatch tool's admission surface without its runner: the registry renders the plan itself. */
const dispatchStub = (runs: string[]): ToolSpec => ({
	name: ToolNames.Dispatch,
	description: "stub dispatch",
	parameters: Type.Object({}, { additionalProperties: true }),
	baseActionClass: "dispatch",
	async run(args) {
		runs.push(JSON.stringify(args));
		return { kind: "ok", output: "dispatched" };
	},
});

async function askOnce(
	args: Record<string, unknown>,
	answer: "allow-once" | "reject-once",
	toolName: "dispatch" | "bash" = "dispatch",
) {
	const safety = createWorkerSafety({ cwd: process.cwd() });
	const registry = createRegistry({ safety, autonomy: () => "default" });
	const runs: string[] = [];
	registry.register(toolName === "bash" ? bashTool : dispatchStub(runs));
	const parked: PermissionRequiredMeta[] = [];
	registry.onPermissionRequired((_call, _decision, meta) => parked.push(meta));
	const asks: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async (_method, params) => {
			asks.push(params as Record<string, unknown>);
			return { outcome: { outcome: "selected", optionId: answer } } as never;
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
	let verdict = "";
	const chat: AcpServerChat = {
		submit: async () => {
			emit({ type: "tool_execution_start", toolCallId: "call-1", toolName, args });
			const result = await registry.invoke({ tool: toolName, args }, { toolCallId: "call-1" });
			verdict = result.kind;
			emit({ type: "tool_execution_end", toolCallId: "call-1", toolName, result, isError: false });
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
	const served = serveClioAcpAgent({
		transport,
		chat,
		toolRegistry: registry,
		autonomy: () => "default",
		cwd: process.cwd(),
	});
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", { protocolVersion: 1 });
	const session = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });
	close();
	await served;
	return { ask: asks[0], parked: parked[0], runs, verdict };
}

test("a plan-scale dispatch ask carries the plan admission rendered, with the hash its run seals", async () => {
	const turn = await askOnce(PLAN, "reject-once");
	ok(turn.parked?.dispatchPlan, "the registry hands its admission view to the listener");
	const expected = describeDispatchPlan(PLAN);
	strictEqual(turn.parked.dispatchPlan.hash, expected.hash);
	const meta = (turn.ask?._meta as Record<string, AcpDispatchPlanMeta>)["clio-coder/dispatchPlan"];
	ok(meta, "the ask carries the plan projection");
	strictEqual(meta.version, 1);
	strictEqual(meta.planScale, true);
	strictEqual(meta.taskCount, 2);
	strictEqual(meta.hash, expected.hash);
	deepStrictEqual(
		meta.tasks.map((task) => [task.agent, task.task]),
		[
			["scout", "Survey the soil samples"],
			["writer", "Draft the comparison report"],
		],
	);
	ok((turn.ask?._meta as Record<string, unknown>)["clio-coder/decision"], "the decision facts still ride beside it");
	strictEqual(turn.runs.length, 0, "a rejected plan runs nothing");
});

test("a bash ask carries the sentences the host wrote from the whole command", async () => {
	const turn = await askOnce({ command: "git push origin main" }, "reject-once", "bash");
	const meta = (turn.ask?._meta as Record<string, Record<string, unknown>>)["clio-coder/decision"] ?? {};
	deepStrictEqual(meta.consequenceLines, ["Publishes to origin"]);
	// A dispatch ask has no command to describe, so it sends no sentences.
	const dispatch = await askOnce(PLAN, "reject-once");
	const dispatchMeta = (dispatch.ask?._meta as Record<string, Record<string, unknown>>)["clio-coder/decision"] ?? {};
	strictEqual("consequenceLines" in dispatchMeta, false);
});

test("an approved plan runs exactly once through the same ask", async () => {
	const turn = await askOnce(PLAN, "allow-once");
	strictEqual(turn.runs.length, 1);
	strictEqual(turn.verdict, "ok");
});

test("the plan projection bounds tasks and strings and strips control characters", () => {
	const view = describeDispatchPlan({
		tasks: Array.from({ length: ACP_DISPATCH_PLAN_MAX_TASKS + 5 }, (_, index) => ({
			agent: `agent-${index}\u0007`,
			task: `${"x".repeat(3000)}\u001b[31m`,
		})),
	});
	const meta = projectDispatchPlanMeta(view);
	strictEqual(meta.truncated, true);
	strictEqual(meta.tasks.length, ACP_DISPATCH_PLAN_MAX_TASKS);
	strictEqual(meta.taskCount, ACP_DISPATCH_PLAN_MAX_TASKS + 5);
	ok(meta.tasks.every((task) => Buffer.byteLength(task.task) <= 1024));
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is that none survive.
	ok(meta.tasks.every((task) => !/[\u0000-\u0009\u000b-\u001f]/u.test(task.agent + task.task)));
	ok(JSON.stringify(meta).length < 64 * 1024);
});

/**
 * One turn with a running dispatch call, a worker that escalates while it runs,
 * and a client that either answers the forwarded ask or leaves it open.
 */
async function forwardWorkerAsk(input: {
	advertise: boolean;
	answer: "allow-once" | "reject-once" | "reject-and-stop" | "never" | "cancelled" | "failed";
	settleElsewhere?: boolean;
	cancelPending?: boolean;
	secondAsk?: boolean;
	foreignSession?: boolean;
}) {
	const bus = createSafeEventBus();
	const resolved: Array<[string, string, string]> = [];
	const asks: Array<Record<string, unknown>> = [];
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	let cancelled = false;
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async (_method, params) => {
			asks.push(params as Record<string, unknown>);
			if (input.answer === "failed") throw new Error("Client disconnected");
			if (input.answer === "cancelled") return { outcome: { outcome: "cancelled" } } as never;
			if (input.answer === "never") return await new Promise<never>(() => {});
			return { outcome: { outcome: "selected", optionId: input.answer } } as never;
		},
		notify: (method, params) => notifications.push({ method, params: params as Record<string, unknown> }),
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
			emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "dispatch", args: { agent: "scout" } });
			bus.emit(BusChannels.PermissionRequested, {
				tool: "bash",
				actionClass: "execute",
				requestedBy: "run-7",
				requestId: "req-1",
				origin: "worker:run-7",
				...(input.foreignSession ? { sessionId: "another-session" } : {}),
				agentId: "scout",
				target: "git push origin main",
				consequence: ["Publishes to origin"],
				timeoutMs: 60_000,
				fallback: "deny",
				escalation: true,
				approvalAuthority: "operator",
			});
			if (input.secondAsk)
				bus.emit(BusChannels.PermissionRequested, {
					tool: "bash",
					actionClass: "execute",
					requestedBy: "run-7",
					requestId: "req-2",
					origin: "worker:run-7",
					escalation: true,
					timeoutMs: 60_000,
				});
			await new Promise((resolve) => setTimeout(resolve, 50));
			if (input.cancelPending) {
				await handlers.get("session/cancel")?.({ sessionId: (asks[0] as { sessionId: string }).sessionId });
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (input.settleElsewhere) {
				bus.emit(BusChannels.PermissionResolved, { status: "expired", requestId: "req-1", decidedBy: "timeout" });
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "dispatch",
				result: { kind: "ok" },
				isError: false,
			});
		},
		cancel: () => {
			cancelled = true;
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
		bus,
		cwd: process.cwd(),
		workerPermissions: { resolve: (runId, requestId, decision) => resolved.push([runId, requestId, decision]) },
	});
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", {
		protocolVersion: 1,
		...(input.advertise
			? {
					clientCapabilities: {
						_meta: {
							"clio-coder/workerPermissions": { version: 1, withdraw: "_clio-coder/permission/withdraw" },
						},
					},
				}
			: {}),
	});
	const session = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });
	close();
	await served;
	return { asks, resolved, notifications, cancelled };
}

test("an attended client is asked about a worker's escalation under the dispatch call and answers the worker", async () => {
	const turn = await forwardWorkerAsk({ advertise: true, answer: "allow-once" });
	strictEqual(turn.asks.length, 1);
	strictEqual((turn.asks[0]?.toolCall as { toolCallId: string }).toolCallId, "call-1");
	const meta = turn.asks[0]?._meta as Record<string, Record<string, unknown>>;
	deepStrictEqual(meta["clio-coder/workerAsk"], {
		version: 1,
		requestId: "req-1",
		requestedBy: "run-7",
		agentId: "scout",
		approvalAuthority: "operator",
		forwardedByMain: false,
		fallback: "deny",
		timeoutMs: 60_000,
	});
	strictEqual(meta["clio-coder/decision"]?.tier, "worker");
	deepStrictEqual(meta["clio-coder/decision"]?.origin, { kind: "worker", agentId: "scout", runId: "run-7" });
	deepStrictEqual(meta["clio-coder/decision"]?.consequenceLines, ["Publishes to origin"]);
	deepStrictEqual(turn.resolved, [["run-7", "req-1", "approve"]]);
});

test("denying and stopping a worker ask denies the worker and cancels the turn", async () => {
	const turn = await forwardWorkerAsk({ advertise: true, answer: "reject-and-stop" });
	deepStrictEqual(turn.resolved, [["run-7", "req-1", "deny"]]);
	strictEqual(turn.cancelled, true);
});

test("a worker ask the worker already settled is withdrawn from the client and never answered", async () => {
	const turn = await forwardWorkerAsk({ advertise: true, answer: "never", settleElsewhere: true });
	deepStrictEqual(turn.resolved, []);
	const withdrawn = turn.notifications.filter((note) => note.method === "_clio-coder/permission/withdraw");
	strictEqual(withdrawn.length, 1);
	strictEqual(withdrawn[0]?.params.requestId, "req-1");
});

test("a client that did not advertise worker permissions is never asked", async () => {
	const turn = await forwardWorkerAsk({ advertise: false, answer: "allow-once" });
	strictEqual(turn.asks.length, 0);
	deepStrictEqual(turn.resolved, []);
});

test("worker non-answers never manufacture an operator denial", async () => {
	for (const answer of ["cancelled", "failed"] as const) {
		const turn = await forwardWorkerAsk({ advertise: true, answer });
		deepStrictEqual(turn.resolved, []);
		strictEqual(turn.notifications.filter((note) => note.method === "_clio-coder/permission/withdraw").length, 1);
	}
});

test("cancellation withdraws the active worker ask and drops queued worker asks", async () => {
	const turn = await forwardWorkerAsk({ advertise: true, answer: "never", cancelPending: true, secondAsk: true });
	strictEqual(turn.asks.length, 1);
	deepStrictEqual(turn.resolved, []);
	strictEqual(turn.notifications.filter((note) => note.method === "_clio-coder/permission/withdraw").length, 1);
});

test("worker asks owned by another session never reach the client", async () => {
	const turn = await forwardWorkerAsk({ advertise: true, answer: "allow-once", foreignSession: true });
	strictEqual(turn.asks.length, 0);
	deepStrictEqual(turn.resolved, []);
});
