import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

const mode = process.argv[2];
const thoughtOption = mode === "thought-option" || mode === "thought-refuse";
const targetFirst = mode === "target-first";
const modelPin = mode === "model-pin" || mode === "model-variants" || targetFirst || thoughtOption;
const legacyModels = mode === "legacy-models";
let selectedModel = thoughtOption ? "gpt-6-astra" : "gpt-6-astra[medium]";
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
 * is never answered itself. In `null` mode a steer is answered with a null result, then the turn with end_turn. In
 * `sideband` mode the turn records a quota error and a thinking-signature error in agy's store under
 * `$HOME/.gemini/antigravity-cli` (the 1.5.13 `steps` DDL), keeps the store open as agy does, and answers end_turn.
 */
const agyState = { firstPrompt: undefined, steers: 0, answered: false, store: undefined };
function recordAgyErrorSteps() {
	const conversations = join(process.env.HOME, ".gemini", "antigravity-cli", "conversations");
	mkdirSync(conversations, { recursive: true });
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
	const store = new DatabaseSync(join(conversations, "agy-session.db"));
	store.exec("PRAGMA journal_mode = WAL");
	store.exec(
		"CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
	);
	const insert = store.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)");
	insert.run(0, 14, Buffer.from("user input"));
	insert.run(
		1,
		17,
		Buffer.from(
			'429 {"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"QUOTA_EXHAUSTED","metadata":{"model":"gemini-x-high","quotaResetDelay":"2h","quotaResetTimeStamp":"2026-11-21T01:00:00Z"}} {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"7s"}',
		),
	);
	insert.run(2, 17, Buffer.from("API error: INVALID_ARGUMENT (code 400): INVALID_THINKING_SIGNATURE"));
	agyState.store = store;
}
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
		if (scenario === "sideband") {
			recordAgyErrorSteps();
			send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
		}
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
		if (!option || typeof request.params?.value !== "string") {
			send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unknown config option" } });
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
