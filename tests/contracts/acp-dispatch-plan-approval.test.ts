import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	ACP_DISPATCH_PLAN_MAX_TASKS,
	type AcpDispatchPlanMeta,
	projectDispatchPlanMeta,
} from "../../src/engine/acp/dispatch-plan-meta.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { describeDispatchPlan } from "../../src/tools/dispatch-plan.js";
import { bashTool } from "../../src/tools/bash.js";
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
