import { createInterface } from "node:readline";

const mode = process.argv[2];
const modelPin = mode === "model-pin" || mode === "model-variants";
const legacyModels = mode === "legacy-models";
let selectedModel = "gpt-6-astra[medium]";
let setModelCalled = false;

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function modelValue(value) {
	return { value, name: value };
}

/**
 * The stable model selector: a `select` config option in category `model`.
 * The variants mode groups its values, which the schema allows, and puts an
 * unrelated option first so the client must pick by category, not position.
 */
function configOptions() {
	const values = [
		modelValue("gpt-6-astra[medium]"),
		modelValue("gpt-6-luna[medium]"),
		...(mode === "model-variants" ? [modelValue("gpt-6-luna[high]")] : []),
	];
	const model = {
		id: "peer-model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: selectedModel,
		options: mode === "model-variants" ? [{ group: "gpt-6", name: "GPT-6", options: values }] : values,
	};
	return mode === "model-variants"
		? [
				{
					id: "peer-mode",
					name: "Mode",
					category: "mode",
					type: "select",
					currentValue: "ask",
					options: [modelValue("ask")],
				},
				model,
			]
		: [model];
}

/** A client that implements no client-side method must advertise none. */
function advertisesClientCapability(capabilities) {
	if (capabilities === undefined || capabilities === null) return false;
	const walk = (value) =>
		value === true || (typeof value === "object" && value !== null && Object.values(value).some((item) => walk(item)));
	return walk(capabilities);
}

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	if (request.method === "initialize") {
		if (advertisesClientCapability(request.params?.clientCapabilities)) {
			send({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32602, message: "unimplemented client capability advertised" },
			});
			continue;
		}
		send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentInfo: { name: "error-fixture" } } });
	} else if (request.method === "session/new") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				sessionId: "error-session",
				...(modelPin ? { configOptions: configOptions() } : {}),
				// The unstable `models` field is not in the v1 schema; a client
				// that still reads it would pick a model here.
				...(legacyModels
					? {
							models: {
								currentModelId: selectedModel,
								availableModels: [{ modelId: selectedModel }, { modelId: "gpt-6-luna[medium]" }],
							},
						}
					: {}),
			},
		});
	} else if (request.method === "session/set_config_option") {
		const option = configOptions().find((candidate) => candidate.id === request.params?.configId);
		if (option?.category !== "model" || typeof request.params?.value !== "string") {
			send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unknown config option" } });
			continue;
		}
		selectedModel = request.params.value;
		send({ jsonrpc: "2.0", id: request.id, result: { configOptions: configOptions() } });
	} else if (request.method === "session/set_model") {
		setModelCalled = true;
		send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found: session/set_model" } });
	} else if (request.method === "session/prompt") {
		if (setModelCalled) {
			send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "refusal" } });
			continue;
		}
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
