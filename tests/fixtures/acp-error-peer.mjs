import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

const mode = process.argv[2];
const thoughtOption = mode === "thought-option" || mode === "thought-refuse";
const targetFirst = mode === "target-first";
const modelPin = mode === "model-pin" || mode === "model-variants" || targetFirst || thoughtOption;
const legacyModels = mode === "legacy-models";
// agy-like (live 1.5.13 shape): model families in `model`, and a `thought_level` option whose levels depend on the
// selected model and which is absent for a model without levels. argv: agy-levels <start model> <expected model/level>.
const agyLevels = mode === "agy-levels";
const AGY_LEVELS = {
	"gemini-3.8-flash": ["low", "medium", "high"],
	"gemini-3.8-pro": ["low", "high", "xhigh"],
	"claude-sonnet-4-6": [],
};
let selectedModel = agyLevels
	? process.argv[3] || "gemini-3.8-flash"
	: thoughtOption
		? "gpt-6-astra"
		: "gpt-6-astra[medium]";
let selectedThought = "medium";
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
	if (agyLevels) {
		const levels = AGY_LEVELS[selectedModel];
		return [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: selectedModel,
				options: Object.keys(AGY_LEVELS).map(modelValue),
			},
			...(levels.length > 0
				? [
						{
							id: "thought_level",
							name: "Thinking level",
							category: "thought_level",
							type: "select",
							currentValue: selectedThought,
							options: levels.map(modelValue),
						},
					]
				: []),
		];
	}
	const values = thoughtOption
		? [modelValue("gpt-6-astra"), modelValue("gpt-6-luna")]
		: [
				modelValue("gpt-6-astra[medium]"),
				modelValue("gpt-6-luna[medium]"),
				...(mode === "model-variants" ? [modelValue("gpt-6-luna[high]")] : []),
			];
	const model = {
		id: targetFirst ? "model" : "peer-model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: selectedModel,
		options: mode === "model-variants" ? [{ group: "gpt-6", name: "GPT-6", options: values }] : values,
	};
	if (thoughtOption) {
		return [
			model,
			{
				id: "peer-thinking",
				name: "Thinking level",
				category: "thought_level",
				type: "select",
				currentValue: selectedThought,
				options: [{ group: "effort", name: "Effort", options: [modelValue("medium"), modelValue("high")] }],
			},
		];
	}
	// A 0.6.2 Clio peer announced its `target` option in category `model` ahead of `model`.
	if (targetFirst) {
		return [
			{
				id: "target",
				name: "Target",
				category: "model",
				type: "select",
				currentValue: "local",
				options: [modelValue("local")],
			},
			model,
		];
	}
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

/**
 * An `agy acp` 1.5 stand-in: argv is `agy <log> <version> <ok|auth|abort|null>`. Every frame it receives is appended
 * to the log. The first prompt asks a fixed-choice question; in `ok` mode it first sends `interaction_` requests:
 * tool-shaped ones (an execute command, a path or a URL under kind other or none) and questions whose locations are
 * null or empty. In `ok` mode the first steer prompt ends at max_tokens; the second makes the turn answer end_turn,
 * then a later update arrives, then the second steer fails. In `abort` mode a steer makes the turn answer end_turn and
 * is never answered itself. In `null` mode a steer is answered with a null result, then the turn with end_turn.
 */
const agyState = { firstPrompt: undefined, steers: 0, answered: false };
function agyUpdate(text) {
	send({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "agy-session",
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
		},
	});
}
function agy(request) {
	appendFileSync(process.argv[3], `${JSON.stringify(request)}\n`);
	const scenario = process.argv[5];
	if (request.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: 1,
				agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
				agentInfo: { name: "Antigravity ACP Server", version: process.argv[4] },
			},
		});
	} else if (request.method === "session/new") {
		send(
			scenario === "auth"
				? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } }
				: {
						jsonrpc: "2.0",
						id: request.id,
						result: {
							sessionId: "agy-session",
							...(scenario === "abort"
								? {
										configOptions: [
											{
												id: "mode",
												name: "Mode",
												category: "mode",
												type: "select",
												currentValue: "plan",
												options: [
													{ value: "default", name: "Default" },
													{ value: "plan", name: "Plan" },
												],
											},
										],
									}
								: {
										modes: {
											currentModeId: "accept-edits",
											availableModes: [
												{ id: "default", name: "Default" },
												{ id: "accept-edits", name: "Accept edits" },
											],
										},
									}),
						},
					},
		);
	} else if (request.method === "session/set_mode" || request.method === "session/set_config_option") {
		send({ jsonrpc: "2.0", id: request.id, result: {} });
	} else if (request.method === "session/cancel") {
		if (!agyState.answered) send({ jsonrpc: "2.0", id: agyState.firstPrompt, result: { stopReason: "cancelled" } });
	} else if (request.method === "session/prompt" && agyState.firstPrompt === undefined) {
		agyState.firstPrompt = request.id;
		const ask = (id, toolCall) =>
			send({
				jsonrpc: "2.0",
				id,
				method: "session/request_permission",
				params: {
					sessionId: "agy-session",
					toolCall,
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "reject", name: "Reject", kind: "reject_once" },
					],
				},
			});
		if (scenario === "ok") {
			ask("tool-1", { toolCallId: "interaction_2", title: "Run it", kind: "execute", rawInput: { command: "echo hi" } });
			ask("tool-2", { toolCallId: "interaction_3", title: "Read it", kind: "other", rawInput: { path: "README.md" } });
			ask("tool-3", { toolCallId: "interaction_4", title: "Fetch it", rawInput: { url: "https://example.com" } });
			ask("question-2", { toolCallId: "interaction_5", title: "Null locations?", kind: "other", locations: null });
			ask("question-3", { toolCallId: "interaction_6", title: "No locations?", locations: [] });
		}
		send({
			jsonrpc: "2.0",
			id: "question-1",
			method: "session/request_permission",
			params: {
				sessionId: "agy-session",
				toolCall: { toolCallId: "interaction_1", title: "Which branch?", kind: "other" },
				options: [
					{ optionId: "main", name: "main", kind: "allow_once", _meta: { "agy.security.warning": "pushes to main" } },
					{ optionId: "topic", name: "topic", kind: "allow_once" },
				],
			},
		});
	} else if (request.method === "session/prompt" && scenario === "ok") {
		agyState.steers += 1;
		if (agyState.steers === 1) {
			agyUpdate("steered");
			send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "max_tokens", usage: { inputTokens: 5 } } });
			return;
		}
		send({ jsonrpc: "2.0", id: agyState.firstPrompt, result: { stopReason: "end_turn", usage: { inputTokens: 7 } } });
		setTimeout(50).then(() => agyUpdate("initial-done"));
		setTimeout(150).then(() => send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "steer lost" } }));
	} else if (request.method === "session/prompt" && scenario === "abort") {
		// The turn answers while this steer stays pending; the test aborts on the update that follows.
		agyState.answered = true;
		send({ jsonrpc: "2.0", id: agyState.firstPrompt, result: { stopReason: "end_turn" } });
		agyUpdate("turn-answered");
	} else if (request.method === "session/prompt" && scenario === "null") {
		send({ jsonrpc: "2.0", id: request.id, result: null });
		send({ jsonrpc: "2.0", id: agyState.firstPrompt, result: { stopReason: "end_turn" } });
	}
}

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (mode === "cancel-connect") appendFileSync(process.argv[3], `${request.method}\n`);
	if (mode === "agy") {
		agy(request);
		continue;
	}
	if (request.id === undefined) continue;
	if (request.method === "initialize") {
		if (mode === "cancel-connect" && process.argv[4]) while (!existsSync(process.argv[4])) await setTimeout(5);
		if (advertisesClientCapability(request.params?.clientCapabilities)) {
			send({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32602, message: "unimplemented client capability advertised" },
			});
			continue;
		}
		const agentInfo = agyLevels ? { name: "Antigravity ACP Server", version: "1.5.13" } : { name: "error-fixture" };
		send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentInfo } });
	} else if (request.method === "session/new") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				sessionId: "error-session",
				...(modelPin || agyLevels ? { configOptions: configOptions() } : {}),
				// Live agy reports its modes; starting in `default` needs no set_mode.
				...(agyLevels ? { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } : {}),
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
		if (!option || typeof request.params?.value !== "string") {
			send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unknown config option" } });
			continue;
		}
		if (agyLevels) {
			if (option.category === "model") {
				selectedModel = request.params.value;
				// Like agy, a model switch falls back to medium, else the lowest level, when the old one is not offered.
				const levels = AGY_LEVELS[selectedModel] ?? [];
				if (!levels.includes(selectedThought)) selectedThought = levels.includes("medium") ? "medium" : levels[0];
			} else if (!AGY_LEVELS[selectedModel].includes(request.params.value)) {
				const message = `Thinking level "${request.params.value}" is not offered for model "${selectedModel}"`;
				send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message } });
				continue;
			} else selectedThought = request.params.value;
			send({ jsonrpc: "2.0", id: request.id, result: { configOptions: configOptions() } });
			continue;
		}
		if (option.category === "model") selectedModel = request.params.value;
		else if (option.category === "thought_level" && mode !== "thought-refuse") selectedThought = request.params.value;
		send({ jsonrpc: "2.0", id: request.id, result: { configOptions: configOptions() } });
	} else if (request.method === "session/set_model") {
		setModelCalled = true;
		send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found: session/set_model" } });
	} else if (request.method === "session/prompt") {
		if (setModelCalled) {
			send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "refusal" } });
			continue;
		}
		if (agyLevels) {
			const stopReason = `${selectedModel}/${selectedThought}` === process.argv[4] ? "end_turn" : "refusal";
			send({ jsonrpc: "2.0", id: request.id, result: { stopReason } });
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
				result: {
					stopReason: thoughtOption
						? selectedThought === "high"
							? "end_turn"
							: "refusal"
						: selectedModel.startsWith("gpt-6-luna[")
							? "end_turn"
							: "refusal",
				},
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
