import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import llamacpp from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { usageCallsFromAttempts } from "../../src/domains/session/journal-usage.js";
import { ledgerCallFailureCounts, ledgerUsageCalls } from "../../src/domains/session/usage.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { streamSimple } from "../../src/engine/ai.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import { runPrewarmRound } from "../../src/engine/prewarm.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";

test("warm and real agent requests share transforms, ordered tools, payload replacement and session identity", async () => {
	const fixture = await startGatewayThinkingFixture();
	registerClioApiProviders();
	try {
		const model = litellm.synthesizeModel({ id: "gateway", runtime: "litellm", url: fixture.url }, fixture.modelId, null);
		const sessionIds: Array<string | undefined> = [];
		let toolsExecuted = 0;
		const { agent } = createEngineAgent({
			sessionId: "actual-session-resource",
			initialState: {
				model,
				thinkingLevel: "off",
				systemPrompt: "Authorized instructions.",
				tools: [
					{
						name: "inspect",
						label: "inspect",
						description: "Inspect only authorized paths.",
						parameters: Type.Object({ path: Type.String() }),
						execute: async () => {
							toolsExecuted += 1;
							return { content: [], details: {} };
						},
					},
				],
				messages: [
					{ role: "user", content: "evicted", timestamp: 0 },
					{ role: "user", content: "retained", timestamp: 1 },
				],
			},
			getApiKey: () => "fixture",
			transformContext: async (messages) => {
				const selected = messages.filter((message) => !(message.role === "user" && message.content === "evicted"));
				const system = selected[0];
				if (system?.role === "system") {
					system.content = "Transformed authorized instructions.";
					system.sections = { policy: "Keep source private." };
				}
				const first = selected.find((message) => message.role === "user");
				if (first?.role === "user") first.content = "transformed retained context";
				return selected;
			},
			onPayload: (payload) => ({
				...(payload as object),
				reasoning_effort: "none",
				allowed_openai_params: ["reasoning_effort"],
				tool_choice: "none",
			}),
			streamFn: (currentModel, context, options) => {
				sessionIds.push(options?.sessionId);
				return streamSimple(currentModel, context, options);
			},
		});
		// A changed executable loadout must be declared before transforms in both paths.
		agent.state.tools = agent.state.tools.map((tool) => ({ ...tool, description: "Updated authorized paths." }));
		const convert = agent.convertToLlm;
		let conversions = 0;
		agent.convertToLlm = async (messages) => {
			conversions += 1;
			return await convert(messages);
		};
		const warm = await runPrewarmRound({ model, state: agent.state, agent, apiKey: "fixture" });
		strictEqual(warm.errorMessage, null);
		strictEqual(agent.state.messages.length, 3, "warm output never enters history");
		strictEqual((agent.state.messages[2] as { content: string }).content, "retained", "warm transforms own a copy");
		await agent.prompt("Actual task suffix");
		strictEqual(conversions, 2);
		deepStrictEqual(sessionIds, ["actual-session-resource", "actual-session-resource"]);
		strictEqual(toolsExecuted, 0);
		const [warmed, actual] = fixture.requests;
		ok(warmed && actual);
		deepStrictEqual((warmed.messages as unknown[]).slice(0, -1), (actual.messages as unknown[]).slice(0, -1));
		deepStrictEqual(warmed.tools, actual.tools);
		ok(JSON.stringify(warmed.messages).includes("Transformed authorized instructions."));
		ok(JSON.stringify(warmed.messages).includes("Keep source private."));
		ok(JSON.stringify(warmed.tools).includes("Updated authorized paths."));
		strictEqual(warmed.tool_choice, actual.tool_choice);
		strictEqual(warmed.reasoning_effort, actual.reasoning_effort);
		strictEqual(warmed.max_tokens ?? warmed.max_completion_tokens, 1);
		ok((warm.usage?.totalTokens ?? 0) > 0);
		ok(warm.timing.ttftMs !== null);
	} finally {
		await fixture.close();
	}
});

test("terminal-only warm reports no TTFT and absent provider usage remains unknown", async () => {
	const fixture = await startGatewayThinkingFixture(undefined, "fixture", undefined, "");
	try {
		const model = litellm.synthesizeModel({ id: "gateway", runtime: "litellm", url: fixture.url }, fixture.modelId, null);
		const { agent } = createEngineAgent({
			initialState: { model, thinkingLevel: "off" },
			onPayload: (payload) => ({
				...(payload as object),
				reasoning_effort: "none",
				allowed_openai_params: ["reasoning_effort"],
			}),
		});
		const result = await runPrewarmRound({ model, state: agent.state, agent, apiKey: "fixture" });
		strictEqual(result.errorMessage, null);
		strictEqual(result.timing.ttftMs, null, "a done event is not a token");
		const aborted = await runPrewarmRound({
			model,
			state: agent.state,
			agent,
			apiKey: "fixture",
			signal: AbortSignal.abort(),
		});
		strictEqual(aborted.usage, null);
		strictEqual(aborted.aborted, true);
		strictEqual(fixture.requests.length, 1);
	} finally {
		await fixture.close();
	}
});

test("native warm cannot administer residency or JIT-load a model and applies its input bound after transforms", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "prewarm-journal-"));
	const journals = createSessionJournals(stateDir, () => {});
	const live: CallSettled[] = [];
	const telemetry = {
		onSettled: (call: CallSettled) => {
			live.push(call);
		},
		origin: { id: "prewarm-session", cwdHash: "repo" },
		acquire: journals.acquire,
		label: "prewarm" as const,
		targetId: "local",
		runtimeId: "llamacpp",
		costProvenance: "known_free" as const,
	};

	const paths: string[] = [];
	let body: Record<string, unknown> | undefined;
	const server = createServer(async (req, res) => {
		paths.push(`${req.method} ${req.url}`);
		if (req.url !== "/v1/chat/completions?autoload=false") {
			res.writeHead(404);
			return res.end("{}");
		}
		let raw = "";
		for await (const chunk of req) raw += chunk;
		body = JSON.parse(raw);
		res.setHeader("content-type", "text/event-stream");
		res.end(
			'data: {"id":"fixture","model":"fixture","choices":[{"index":0,"delta":{"content":"."}}]}\n\ndata: {"id":"fixture","model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\ndata: [DONE]\n\n',
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const model = llamacpp.synthesizeModel(
			{
				id: "local",
				runtime: "llamacpp",
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				lifecycle: "clio-coder-managed",
			},
			"fixture",
			null,
		);
		const { agent } = createEngineAgent({ initialState: { model, thinkingLevel: "off", systemPrompt: "instructions" } });
		const result = await runPrewarmRound({
			model,
			state: agent.state,
			agent,
			apiKey: "fixture",
			maxInputTokens: 100,
			telemetry,
		});
		strictEqual(result.errorMessage, null);
		deepStrictEqual(paths, ["POST /v1/chat/completions?autoload=false"]);
		strictEqual(body?.cache_prompt, true);
		strictEqual(
			(model as { clioCoder?: { lifecycle?: string } }).clioCoder?.lifecycle,
			"clio-coder-managed",
			"foreground authority is unchanged",
		);
		agent.transformContext = async (messages) => [{ role: "user", content: "x".repeat(1000), timestamp: 0 }, ...messages];
		const refused = await runPrewarmRound({
			model,
			state: agent.state,
			agent,
			apiKey: "fixture",
			maxInputTokens: 100,
			telemetry,
		});
		ok(refused.errorMessage?.includes("token budget"));
		strictEqual(paths.length, 1, "oversized transformed warm never reaches the server");
		const records = (await readCallJournal(join(stateDir, "sessions", "repo", "prewarm-session"))).records.map(
			({ record }) => record,
		);
		const calls = records.filter((record) => record.k === "call.settled");
		strictEqual(result.callId, calls[0]?.data.callId);
		strictEqual(refused.callId, calls[1]?.data.callId);
		strictEqual(result.attemptId, calls[0]?.data.attemptId);
		strictEqual(live.length, 2);
		deepStrictEqual(
			ledgerUsageCalls([], {}, records),
			usageCallsFromAttempts(live.map((settled) => ({ started: settled, settled }))),
		);
		strictEqual(ledgerCallFailureCounts([], records).neverInvokedCalls, 1);
		strictEqual(calls.length, 2);
		strictEqual(calls[0]?.data.disposition, "settled");
		strictEqual(calls[1]?.data.disposition, "never_sent");
		strictEqual(calls[1]?.data.usage, null);
		ok(calls.every((record) => record.data.label === "prewarm"));
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await journals.flush();
		await rm(stateDir, { recursive: true, force: true });
	}
});
