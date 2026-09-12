import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { it } from "node:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { asDirectoryPathBoundary } from "../../src/core/path-boundary.js";
import { ToolNames } from "../../src/core/tool-names.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { setGlobalDefaultMaxOutputTokens } from "../../src/engine/apis/output-budget.js";
import { startWorkerRun, type WorkerRunHandle } from "../../src/engine/worker-runtime.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const modelId = "dynamo/qwen3.8-27b";
const usage = {
	prompt_tokens: 20965,
	completion_tokens: 8192,
	total_tokens: 29157,
	completion_tokens_details: { reasoning_tokens: 6215 },
};

/** Sanitized wire shape from the captured wiki failure, with the real finish/usage. */
function responseBody(args: string[], finishReason = "length"): string {
	const chunks = [
		{
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: args.map((argumentsText, index) => ({
							index,
							id: `${finishReason}-${index}`,
							type: "function",
							function: { name: "write", arguments: argumentsText },
						})),
					},
				},
			],
		},
		{ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage },
	];
	return `${chunks.map((chunk) => `data: ${JSON.stringify({ id: "captured-length", model: modelId, ...chunk })}\n\n`).join("")}data: [DONE]\n\n`;
}

const context: Context = {
	messages: [{ role: "user", content: "Write the page.", timestamp: 0 }],
	tools: [
		{
			name: "write",
			description: "Write a file",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		},
	],
};

for (const finishReason of ["length", "tool_calls"] as const) {
	it(`keeps the terminal ${finishReason} diagnosis and usage for empty required tool arguments`, async () => {
		const model = litellm.synthesizeModel(
			{ id: "fixture", runtime: "litellm", url: "http://fixture.invalid" },
			modelId,
			null,
		) as Model<"openai-completions">;
		const events: AssistantMessageEvent[] = [];
		for await (const event of openAICompletionsApiProvider.streamSimple(model, context, {
			apiKey: "fixture",
			maxTokens: 8192,
			fetch: async () =>
				new Response(responseBody([""], finishReason), { headers: { "content-type": "text/event-stream" } }),
		}))
			events.push(event);
		const terminal = events.at(-1);
		ok(terminal?.type === "done" || terminal?.type === "error");
		const message = terminal.type === "done" ? terminal.message : terminal.error;
		strictEqual(message.usage.output, 8192);
		strictEqual(message.usage.totalTokens, 29157);
		strictEqual(message.rawStopReason, finishReason);
		if (finishReason === "length") {
			strictEqual(terminal.type, "done");
			strictEqual(message.stopReason, "length");
			strictEqual(message.errorMessage, undefined);
		} else {
			strictEqual(terminal.type, "error");
			strictEqual(message.stopReason, "error");
			match(message.errorMessage ?? "", /empty tool-call arguments/u);
		}
	});
}

for (const abortRecovery of [false, true]) {
	it(`real worker refuses every truncated write and ${abortRecovery ? "honors explicit abort" : "continues to a grounded artifact result"}`, {
		timeout: 10000,
	}, async () => {
		const env = await isolateClioEnv("clio-coder-output-length-");
		const originalCwd = process.cwd();
		process.chdir(env.dir);
		const output = join(env.dir, "page.md");
		const partial = join(env.dir, "partial.md");
		const apparentlyComplete = join(env.dir, "not-executed.md");
		const requests: Array<Record<string, unknown>> = [];
		const checks: boolean[] = [];
		let worker: WorkerRunHandle | undefined;
		let blockedWrites = 0;
		const server = createServer(async (req, res) => {
			if (req.url !== "/v1/chat/completions") {
				res.writeHead(404);
				res.end();
				return;
			}
			const request = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
			requests.push(request);
			res.setHeader("content-type", "text/event-stream");
			if (requests.length === 1) {
				// Even a JSON-salvaged or complete-looking call from this length stop
				// must never reach the real filesystem tool.
				res.end(
					responseBody([
						"",
						`{"path":${JSON.stringify(partial)},"content":"partial`,
						JSON.stringify({ path: apparentlyComplete, content: "poison" }),
					]),
				);
			} else if (requests.length === 2) {
				checks.push(!existsSync(output) && !existsSync(partial) && !existsSync(apparentlyComplete));
				res.end(
					responseBody([JSON.stringify({ path: output, content: "# Page\n\nGrounded fixture content.\n" })], "tool_calls"),
				);
			} else {
				res.end(
					`data: ${JSON.stringify({ model: modelId, choices: [{ index: 0, delta: { content: "Wrote page.md." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				);
			}
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.chat.maxOutputTokens = 8192;
			mkdirSync(join(env.dir, "config"), { recursive: true });
			writeFileSync(join(env.dir, "config", "settings.yaml"), JSON.stringify(settings));
			worker = startWorkerRun(
				{
					agentId: "wiki-writer",
					systemPrompt: "Write the requested artifact and finish with one factual line.",
					task: "Write page.md.",
					target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
					runtime: litellm,
					wireModelId: modelId,
					apiKey: "fixture",
					thinkingLevel: "medium",
					modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true },
					allowedTools: [ToolNames.Write],
					budget: { mode: "advisory", toolCalls: 40, readReserve: 0, synthesis: true, hardCap: 60 },
					resultContract: { kind: "artifact-report" },
					product: "orientation",
					noSkills: true,
					cwd: env.dir,
					autonomy: "full-auto",
					writeRoots: [asDirectoryPathBoundary(env.dir)],
				},
				(event) => {
					if (event.type === "tool_execution_end" && event.isError) {
						blockedWrites += 1;
						if (abortRecovery) worker?.abort();
					}
				},
			);
			const result = await worker.promise;
			ok(blockedWrites >= 3, "every truncated call receives refusal, including parsed arguments");
			strictEqual(existsSync(partial), false);
			strictEqual(existsSync(apparentlyComplete), false);
			for (const request of requests)
				strictEqual(request.max_tokens, 8192, "continuation keeps the configured per-call cap");
			if (abortRecovery) {
				strictEqual(existsSync(output), false);
				strictEqual(requests.length, 1, "abort prevents the recovery request");
			} else {
				strictEqual(result.exitCode, 0);
				deepStrictEqual(checks, [true]);
				ok(existsSync(output), `valid continuation must write: ${JSON.stringify(result.messages)}`);
				strictEqual(readFileSync(output, "utf8"), "# Page\n\nGrounded fixture content.\n");
				strictEqual(requests.length, 3, "no premature result-contract repair after a truncated tool turn");
				match(JSON.stringify(requests[1]?.messages), /was not executed: the response hit the output token limit/u);
				const final = result.messages.at(-1);
				ok(final?.role === "assistant");
				strictEqual(final.stopReason, "stop");
				deepStrictEqual(final.content, [{ type: "text", text: "Wrote page.md." }]);
			}
		} finally {
			worker?.abort();
			await worker?.promise;
			await closeServer(server);
			setGlobalDefaultMaxOutputTokens(DEFAULT_SETTINGS.chat.maxOutputTokens);
			process.chdir(originalCwd);
			env.restore();
		}
	});
}
