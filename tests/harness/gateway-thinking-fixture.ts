import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { closeServer } from "./openai-compat-fixture.js";

/** Controlled reproduction of LiteLLM filtering before an LM Studio upstream. */
export async function startGatewayThinkingFixture(
	runtime: string | undefined = "lm-studio",
	modelId = "dynamo/qwen3.8-27b",
	beforeMetadata?: () => Promise<void>,
) {
	const requests: Array<Record<string, unknown>> = [];
	const paths: string[] = [];
	const server = createServer(async (req, res) => {
		paths.push(req.url ?? "");
		res.setHeader("content-type", "application/json");
		if (req.url === "/health/liveliness") return res.end("{}");
		if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: modelId }] }));
		if (req.url === "/v1/model/info") {
			// Delay the body after headers to exercise late metadata, too.
			if (beforeMetadata) res.flushHeaders();
			await beforeMetadata?.();
			return res.end(
				JSON.stringify({
					data: [
						{
							model_name: modelId,
							model_info: {
								runtime,
								mode: "chat",
								supports_reasoning: true,
								supports_function_calling: true,
								max_input_tokens: 32768,
								max_output_tokens: 1024,
							},
						},
					],
				}),
			);
		}
		if (req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			return res.end("{}");
		}
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw) as Record<string, unknown>;
		requests.push(body);
		// LiteLLM's generic OpenAI adapter drops effort unless explicitly allowed.
		// LM Studio's HTTP route ignores the template switch. Keep both seams in
		// the fixture: merely adding none or hiding returned thinking cannot pass.
		const allowed = Array.isArray(body.allowed_openai_params) && body.allowed_openai_params.includes("reasoning_effort");
		const thinking = !allowed || body.reasoning_effort !== "none";
		const usage = {
			prompt_tokens: 7,
			completion_tokens: thinking ? 9 : 1,
			total_tokens: thinking ? 16 : 8,
			completion_tokens_details: { reasoning_tokens: thinking ? 8 : 0 },
		};
		if (body.stream === false) {
			return res.end(
				JSON.stringify({
					id: "fixture",
					object: "chat.completion",
					model: modelId,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "323", ...(thinking ? { reasoning_content: "Fixture reasoning." } : {}) },
							finish_reason: "stop",
						},
					],
					usage,
				}),
			);
		}
		res.setHeader("content-type", "text/event-stream");
		const chunks = [
			...(thinking ? [{ choices: [{ index: 0, delta: { reasoning_content: "Fixture reasoning." } }] }] : []),
			{ choices: [{ index: 0, delta: { content: "323" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
		];
		for (const chunk of chunks) res.write(`data: ${JSON.stringify({ id: "fixture", model: modelId, ...chunk })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		modelId,
		requests,
		paths,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () => closeServer(server),
	};
}
