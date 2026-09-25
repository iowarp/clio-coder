import { createInterface } from "node:readline";

const mode = process.argv[2];
const modelPin = mode === "model-pin" || mode === "model-variants";
let selectedModel = "gpt-6-astra[medium]";

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	if (request.method === "initialize") {
		send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentInfo: { name: "error-fixture" } } });
	} else if (request.method === "session/new") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				sessionId: "error-session",
				...(modelPin
					? {
							models: {
								currentModelId: selectedModel,
								availableModels: [
									{ modelId: selectedModel },
									{ modelId: "gpt-6-luna[medium]" },
									...(mode === "model-variants" ? [{ modelId: "gpt-6-luna[high]" }] : []),
								],
							},
						}
					: {}),
			},
		});
	} else if (request.method === "session/set_model") {
		selectedModel = request.params.modelId;
		send({ jsonrpc: "2.0", id: request.id, result: {} });
	} else if (request.method === "session/prompt") {
		if (modelPin) {
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "error-session",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Selected ${selectedModel}` } },
				},
			});
			send({
				jsonrpc: "2.0",
				id: request.id,
				result: { stopReason: selectedModel.startsWith("gpt-6-luna[") ? "end_turn" : "refusal" },
			});
			continue;
		}
		if (mode === "missing-stop-reason") {
			send({ jsonrpc: "2.0", id: request.id, result: {} });
			continue;
		}
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: "error-session",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text:
							mode === "anthropic-error"
								? '{"type":"error","error":{"type":"invalid_request_error","message":"The model is not supported."}}'
								: 'Warning: model metadata missing.\n{"type":"error","status":400,"error":{"message":"The model is not supported."}}',
					},
				},
			},
		});
		send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
	}
}
