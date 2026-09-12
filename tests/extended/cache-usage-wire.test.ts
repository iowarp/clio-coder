import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createCostTracker } from "../../src/domains/observability/cost.js";
import { appendOutOfTurnUsageRow, readOutOfTurnUsageRows } from "../../src/domains/observability/out-of-turn-usage.js";
import { TraceReader, TraceStore } from "../../src/domains/observability/trace-store.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { ledgerUsageCalls } from "../../src/domains/session/usage.js";
import { completeEngineText, streamSimple } from "../../src/engine/ai.js";
import type { EngineModel } from "../../src/engine/types.js";
import { sideQuestionUsage } from "../../src/interactive/side-question.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const api of ["openai-responses", "anthropic-messages"] as const) {
	test(`${api}: normalize on the wire once and preserve cache buckets through usage stores`, async () => {
		const env = await isolateClioEnv("clio-cache-usage-");
		const server = createServer(async (request, response) => {
			for await (const _chunk of request) {
				/* consume request before responding */
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			const send = (value: { type: string; [key: string]: unknown }) =>
				response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
			if (api === "openai-responses") {
				send({
					type: "response.completed",
					response: {
						id: "fixture",
						model: "fixture",
						status: "completed",
						output: [],
						usage: {
							input_tokens: 10000,
							output_tokens: 100,
							total_tokens: 10100,
							input_tokens_details: { cached_tokens: 6000, cache_write_tokens: 2000 },
						},
					},
				});
			} else {
				send({
					type: "message_start",
					message: {
						id: "fixture",
						model: "fixture",
						role: "assistant",
						type: "message",
						content: [],
						stop_reason: null,
						usage: {
							input_tokens: 2000,
							output_tokens: 0,
							cache_read_input_tokens: 6000,
							cache_creation_input_tokens: 2000,
							cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
						},
					},
				});
				send({
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 100 },
				});
				send({ type: "message_stop" });
			}
			response.end();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		ok(address && typeof address !== "string");
		const model: EngineModel = {
			api,
			provider: api === "anthropic-messages" ? "anthropic" : "openai",
			id: "fixture",
			name: "fixture",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: false,
			input: ["text"],
			contextWindow: 32000,
			maxTokens: 1000,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		};
		try {
			const assistant = await streamSimple(
				model,
				{ systemPrompt: "Preserve authority.", messages: [{ role: "user", content: "Inspect fixture.", timestamp: 0 }] },
				{ apiKey: "fixture", maxTokens: 100, cacheRetention: "long" },
			).result();
			strictEqual(assistant.stopReason, "stop", assistant.errorMessage);
			const usage = assistant.usage;
			deepStrictEqual(
				[usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.totalTokens],
				[2000, 6000, 2000, 100, 10100],
			);
			const long = api === "anthropic-messages" ? 500 : undefined;
			strictEqual(usage.cacheWrite1h, long);
			const expectedCost = (2000 * 3 + 6000 * 0.3 + (2000 - (long ?? 0)) * 3.75 + (long ?? 0) * 6 + 100 * 15) / 1e6;
			ok(Math.abs(usage.cost.total - expectedCost) < 1e-12);
			const completion = await completeEngineText({
				model,
				apiKey: "fixture",
				systemPrompt: "Preserve authority.",
				userPrompt: "Inspect fixture.",
				thinkingLevel: "off",
				maxTokens: 100,
				signal: new AbortController().signal,
				timeoutMs: 5000,
			});
			strictEqual(completion.usage.cacheWrite1h, long);
			strictEqual(completion.usage.costUsd, usage.cost.total);
			for (const stopReason of ["stop", "error", "aborted"]) {
				const calls = ledgerUsageCalls([
					{
						kind: "message",
						role: "assistant",
						turnId: "fixture",
						parentTurnId: null,
						timestamp: new Date(0).toISOString(),
						payload: { ...assistant, stopReason },
					} as SessionEntry,
				]);
				strictEqual(calls.length, 1, "reported spend survives terminal failure");
				strictEqual(calls[0]?.cacheWrite1h, long);
				strictEqual(calls[0]?.totalTokens, 10100);
			}
			const side = sideQuestionUsage(usage);
			ok(side);
			const tracker = createCostTracker();
			tracker.accumulate("fixture", "fixture", side.totalTokens, side.costUsd, side, "estimated");
			strictEqual(tracker.sessionTokens().cacheWrite1h, long);
			strictEqual(tracker.sessionTokens().totalTokens, 10100);
			appendOutOfTurnUsageRow(env.dir, {
				label: "prewarm",
				sessionId: "fixture",
				repoIdentity: "fixture",
				timestamp: new Date(0).toISOString(),
				target: "fixture",
				attributedModelId: "fixture",
				usage: { ...side, costProvenance: "estimated" },
			});
			const archived = readOutOfTurnUsageRows(env.dir);
			deepStrictEqual(archived.errors, []);
			strictEqual(archived.rows[0]?.usage.cacheWrite1h, long);
			strictEqual(archived.rows[0]?.usage.totalTokens, 10100);
			const tracePath = join(env.dir, "cache.sqlite");
			const trace = new TraceStore(tracePath);
			try {
				trace.recordSessionTurn({
					kind: "start",
					runId: "cache",
					agent: "main",
					target: "fixture",
					model: model.id,
					runtime: api,
					prompt: null,
					at: new Date(0).toISOString(),
				});
				trace.recordSessionTurn({
					kind: "finish",
					runId: "cache",
					status: "success",
					error: null,
					at: new Date(1).toISOString(),
					usage: {
						inputTokens: usage.input,
						outputTokens: usage.output,
						cacheReadTokens: usage.cacheRead,
						cacheWriteTokens: usage.cacheWrite,
						...(long === undefined ? {} : { cacheWrite1hTokens: long }),
						reasoningTokens: 0,
						totalTokens: usage.totalTokens,
						costUsd: usage.cost.total,
					},
				});
			} finally {
				trace.close();
			}
			const reader = new TraceReader(tracePath);
			try {
				strictEqual(reader.phases("cache")[0]?.cache_write_1h_tokens, long ?? null);
			} finally {
				reader.close();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			env.restore();
		}
	});
}
