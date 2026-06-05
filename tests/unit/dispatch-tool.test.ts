import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";

function makeReceipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		runId: "run-1",
		agentId: "implementer",
		task: "say hi",
		endpointId: "dynamo",
		wireModelId: "nemotron-cascade-2-30b-a3b-i1",
		runtimeId: "openai-compatible",
		runtimeKind: "http",
		startedAt: "2026-05-17T00:00:00.000Z",
		endedAt: "2026-05-17T00:00:01.000Z",
		exitCode: 0,
		tokenCount: 12,
		reasoningTokenCount: 3,
		costUsd: 0,
		compiledPromptHash: "prompt-hash",
		staticCompositionHash: null,
		clioVersion: "0.1.9",
		piMonoVersion: "0.78.1",
		platform: "linux",
		nodeVersion: "v24.0.0",
		toolCalls: 0,
		toolStats: [],
		sessionId: null,
		integrity: { version: 1, algorithm: "sha256", digest: "digest" },
		...overrides,
	};
}

function makeDispatch(events: ReadonlyArray<unknown> = []): {
	dispatch: DispatchContract;
	requests: DispatchRequest[];
} {
	const requests: DispatchRequest[] = [];
	const dispatch: DispatchContract = {
		async dispatch(req) {
			requests.push(req);
			return {
				runId: "run-1",
				events: (async function* () {
					for (const event of events) yield event;
				})(),
				finalPromise: Promise.resolve(
					makeReceipt({
						agentId: req.agentId,
						task: req.task,
						endpointId: req.endpoint ?? "dynamo",
						wireModelId: req.model ?? "nemotron-cascade-2-30b-a3b-i1",
					}),
				),
			};
		},
		listRuns: () => [],
		getRun: (runId) =>
			runId === "run-1"
				? ({
						id: runId,
						agentId: "implementer",
						task: "say hi",
						endpointId: "dynamo",
						wireModelId: "nemotron-cascade-2-30b-a3b-i1",
						runtimeId: "openai-compatible",
						runtimeKind: "http",
						startedAt: "2026-05-17T00:00:00.000Z",
						endedAt: "2026-05-17T00:00:01.000Z",
						status: "completed",
						exitCode: 0,
						pid: null,
						heartbeatAt: null,
						receiptPath: "/tmp/clio/receipts/run-1.json",
						sessionId: null,
						cwd: "/repo",
						tokenCount: 12,
						costUsd: 0,
					} satisfies RunEnvelope)
				: null,
		abort: () => {},
		drain: async () => {},
	};
	return { dispatch, requests };
}

describe("tools/dispatch", () => {
	it("delegates to the native dispatch contract and returns agent output", async () => {
		const bus = createSafeEventBus();
		const progress: unknown[] = [];
		bus.on(BusChannels.DispatchProgress, (payload) => {
			progress.push(payload);
		});
		const { dispatch, requests } = makeDispatch([
			{ type: "heartbeat" },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "worker-hi" }] } },
		]);
		const tool = createDispatchTool({ dispatch, bus });

		const result = await tool.run({ task: "say hi", target: "dynamo", thinking_level: "high" });

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		deepStrictEqual(requests, [
			{
				agentId: "implementer",
				task: "say hi",
				supervised: true,
				endpoint: "dynamo",
				thinkingLevel: "high",
			},
		]);
		ok(result.output.includes("agent output:\nworker-hi"), result.output);
		strictEqual(result.details?.runId, "run-1");
		strictEqual(result.details?.receiptPath, "/tmp/clio/receipts/run-1.json");
		strictEqual(progress.length, 1);
	});

	it("reports invalid arguments before dispatching", async () => {
		const { dispatch, requests } = makeDispatch();
		const tool = createDispatchTool({ dispatch });

		const result = await tool.run({ task: "say hi", thinking_level: "extreme" });

		strictEqual(result.kind, "error");
		if (result.kind === "error") ok(result.message.includes("thinking_level"));
		deepStrictEqual(requests, []);
	});
});
