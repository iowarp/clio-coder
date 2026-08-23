import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export type FakeLmStudioMode = "0.4" | "0.3";

export interface FakeLmStudioRequest {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body?: Record<string, unknown>;
}

export interface FakeLmStudioFixture {
	server: Server;
	url: string;
	requests: FakeLmStudioRequest[];
	requestsFor(path: string): FakeLmStudioRequest[];
	failNextLoads(count?: number): void;
	close(): Promise<void>;
}

interface FakeInstance {
	id: string;
	config: Record<string, unknown>;
}

interface FakeModel {
	key: string;
	type: string;
	max_context_length: number;
	capabilities: Record<string, unknown>;
	loaded_instances: FakeInstance[];
}

async function readBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown> | undefined> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	if (chunks.length === 0) return undefined;
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: undefined;
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

function sse(
	response: import("node:http").ServerResponse,
	values: ReadonlyArray<unknown>,
	contentType = "text/event-stream",
): void {
	response.writeHead(200, { "content-type": contentType });
	for (const value of values) response.write(`data: ${JSON.stringify(value)}\n\n`);
	response.end("data: [DONE]\n\n");
}

export async function startFakeLmStudioServer(
	options: {
		mode?: FakeLmStudioMode;
		authToken?: string;
		greeting?: boolean;
		failLoads?: number;
		hostIdentity?: "dynamo" | "zbook";
		/** `model` field stamped on every chat completion chunk; an LM Link peer reports its own id. */
		reportedModelId?: string;
		/** Overrides the chat response content type for adapter boundary tests. */
		chatContentType?: string;
	} = {},
): Promise<FakeLmStudioFixture> {
	const mode = options.mode ?? "0.4";
	let remainingLoadFailures = options.failLoads ?? 0;
	const requests: FakeLmStudioRequest[] = [];
	const models: FakeModel[] = [
		{
			key: "qwen3.8-27b",
			type: "llm",
			max_context_length: 262_144,
			capabilities: {
				vision: true,
				trained_for_tool_use: true,
				reasoning: { allowed_options: ["off", "on"], default: "on" },
			},
			loaded_instances: [
				{
					id: "qwen3.8-27b-zbook",
					config: {
						context_length: 262_144,
						eval_batch_size: 2048,
						physical_batch_size: 512,
						flash_attention: true,
						parallel: 4,
						context_checkpoints: 32,
						reasoning_budget_message: "",
						speculative_draft_mtp: true,
						speculative_draft_simple: false,
						speculative_draft_model: "",
						speculative_draft_max_tokens: 2,
						speculative_draft_min_tokens: 0,
						speculative_draft_min_continue_probability: 0.75,
						offload_kv_cache_to_gpu: true,
					},
				},
			],
		},
		{
			key: "qwen3.8-27b",
			type: "llm",
			max_context_length: 262_144,
			capabilities: {
				vision: true,
				trained_for_tool_use: true,
			},
			loaded_instances: [
				{
					id: "qwen3.8-27b-dynamo",
					config: {
						context_length: 131_072,
						eval_batch_size: 2048,
						physical_batch_size: 512,
						parallel: 4,
						flash_attention: true,
						context_checkpoints: 32,
						reasoning_budget_message: "",
						speculative_draft_mtp: true,
						speculative_draft_simple: false,
						speculative_draft_model: "",
						speculative_draft_max_tokens: 2,
						speculative_draft_min_tokens: 0,
						speculative_draft_min_continue_probability: 0.75,
						offload_kv_cache_to_gpu: true,
					},
				},
			],
		},
		{
			key: "coder-unloaded",
			type: "llm",
			max_context_length: 65_536,
			capabilities: {
				vision: false,
				trained_for_tool_use: true,
				reasoning: { allowed_options: ["off", "on"] },
			},
			loaded_instances: [],
		},
		{
			key: "embedding-model",
			type: "embedding",
			max_context_length: 8192,
			capabilities: {},
			loaded_instances: [],
		},
	];
	if (options.hostIdentity === "dynamo") {
		const localIndex = models.findIndex((model) => model.loaded_instances[0]?.id === "qwen3.8-27b-dynamo");
		const local = localIndex >= 0 ? models.splice(localIndex, 1)[0] : undefined;
		if (local) models.unshift(local);
	}

	const server = createServer(async (request, response) => {
		const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const body = await readBody(request);
		requests.push({
			method: request.method ?? "GET",
			path,
			headers: request.headers,
			...(body ? { body } : {}),
		});
		if (path === "/lmstudio-greeting") {
			if (options.greeting === false) return json(response, 200, { service: "not-lmstudio" });
			return json(response, 200, { lmstudio: true });
		}
		if (options.authToken && request.headers.authorization !== `Bearer ${options.authToken}`) {
			return json(response, 401, { error: "Authentication required" });
		}
		if (path === "/api/v1/models" && mode === "0.4" && request.method === "GET") {
			return json(response, 200, { models });
		}
		if (path === "/api/v1/models/load" && mode === "0.4" && request.method === "POST") {
			if (remainingLoadFailures > 0) {
				remainingLoadFailures -= 1;
				return json(response, 507, { error: "insufficient VRAM" });
			}
			const key = typeof body?.model === "string" ? body.model : "";
			const model = models.find((entry) => entry.key === key);
			if (!model) return json(response, 404, { error: "model not found" });
			const config = Object.fromEntries(
				Object.entries(body ?? {}).filter(([field]) => field !== "model" && field !== "echo_load_config"),
			);
			model.loaded_instances.push({ id: `${key}:clio`, config });
			return json(response, 200, { instance_id: `${key}:clio`, load_config: config });
		}
		if (path === "/api/v1/models/unload" && mode === "0.4" && request.method === "POST") {
			const id = typeof body?.instance_id === "string" ? body.instance_id : "";
			for (const model of models) model.loaded_instances = model.loaded_instances.filter((entry) => entry.id !== id);
			return json(response, 200, { unloaded: id });
		}
		if (path === "/api/v0/models" && request.method === "GET") {
			const byKey = new Map<string, FakeModel[]>();
			for (const model of models) {
				const entries = byKey.get(model.key) ?? [];
				entries.push(model);
				byKey.set(model.key, entries);
			}
			return json(response, 200, {
				data: [...byKey.values()].flatMap((entries) => {
					const representative = entries[0];
					if (!representative) return [];
					const instances = entries.flatMap((model) => model.loaded_instances);
					const shared = {
						compatibility_type: "gguf",
						max_context_length: representative.max_context_length,
						type: representative.type,
						capabilities: representative.capabilities.trained_for_tool_use ? ["tool_use"] : [],
					};
					if (instances.length === 0) return [{ id: representative.key, state: "not-loaded", ...shared }];
					return [
						...instances.map((instance) => ({
							id: instance.id,
							state: "loaded",
							loaded_context_length: instance.config.context_length,
							...shared,
						})),
						{ id: representative.key, state: "not-loaded", ...shared },
					];
				}),
			});
		}
		if (path === "/v1/models" && request.method === "GET") {
			return json(response, 200, {
				data: models.flatMap((model) => [
					{ id: model.key, object: "model" },
					...model.loaded_instances.map((instance) => ({ id: instance.id, object: "model" })),
				]),
			});
		}
		if (path === "/v1/chat/completions" && request.method === "POST") {
			const messages = Array.isArray(body?.messages) ? body.messages : [];
			const reasoningEffort = typeof body?.reasoning_effort === "string" ? body.reasoning_effort : undefined;
			const reasoningEnabled = reasoningEffort !== undefined && reasoningEffort !== "none";
			const hasToolResult = messages.some(
				(message) => typeof message === "object" && message !== null && (message as { role?: unknown }).role === "tool",
			);
			if (Array.isArray(body?.tools) && body.tools.length > 0 && !hasToolResult) {
				return sse(
					response,
					[
						...(reasoningEnabled
							? [{ choices: [{ index: 0, delta: { role: "assistant", reasoning: "I should use the tool." } }] }]
							: []),
						{
							choices: [
								{
									index: 0,
									delta: {
										tool_calls: [
											{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } },
										],
									},
								},
							],
						},
						{
							choices: [
								{
									index: 0,
									delta: { tool_calls: [{ index: 0, function: { arguments: '"Chicago"}' } }] },
									finish_reason: "tool_calls",
								},
							],
						},
						{ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
					],
					options.chatContentType,
				);
			}
			const reportedModel = options.reportedModelId !== undefined ? { model: options.reportedModelId } : {};
			return sse(
				response,
				[
					...(reasoningEnabled
						? [{ ...reportedModel, choices: [{ index: 0, delta: { role: "assistant", reasoning: "Short thought." } }] }]
						: []),
					{ ...reportedModel, choices: [{ index: 0, delta: { content: "Visible answer." }, finish_reason: "stop" }] },
					{ ...reportedModel, choices: [], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } },
				],
				options.chatContentType,
			);
		}
		if (path.startsWith("/api/v1/")) return json(response, 404, { error: "Not found" });
		return json(response, 200, { error: `Unexpected endpoint or method. (${request.method} ${path})` });
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fake LM Studio server did not bind an HTTP port");
	return {
		server,
		url: `http://127.0.0.1:${address.port}`,
		requests,
		requestsFor(path: string) {
			return requests.filter((entry) => entry.path === path);
		},
		failNextLoads(count = 1) {
			remainingLoadFailures += count;
		},
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}
