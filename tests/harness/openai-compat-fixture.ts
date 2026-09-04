/**
 * In-process mock OpenAI-compatible provider for smoke tests that drive the
 * built binary against a fake fleet endpoint, plus the settings.yaml seeders
 * that point a scratch config at it. Extracted from cli.test.ts so eval-fleet
 * and any future binary-driving test can reuse the same fixture.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export async function closeServer(server: Server | null): Promise<void> {
	if (!server) return;
	// undici keeps idle keep-alive sockets open after a 404 (a residency probe
	// that fell through /api/v1/models), and close() waits for them.
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
	});
}

/**
 * Scripts one OpenAI `tool_calls` round trip out of the fixture. The first
 * streaming completion of a turn answers with a single function tool call and
 * `finish_reason:"tool_calls"`; every completion that already carries a tool
 * result answers with the fixture's plain text reply, so a turn always
 * terminates after exactly one tool call no matter how the agent loop is
 * scheduled.
 */
export interface OpenAICompatToolCallScript {
	/** Tool name the model asks for. */
	name: string;
	/** Arguments object; serialized into the `function.arguments` delta verbatim. */
	arguments: Record<string, unknown>;
	/** Wire id for the call. Defaults to `call-clio-tool-1`. */
	id?: string;
}

export interface OpenAICompatFixtureOptions {
	models?: Array<Record<string, unknown> & { id: string }>;
	/** Fail the first streaming requests before following the normal script. */
	initialErrors?: { count: number; status: number; message: string };
	/** Split a text reply into provider-visible SSE deltas for pacing/ordering tests. */
	replyChunks?: readonly string[];
	/** Optional deterministic delay between text chunks. */
	chunkDelayMs?: number;
	/**
	 * When set, answer the tool-free completion of every turn with this tool
	 * call instead of text. Absent, the fixture behaves exactly as before.
	 */
	toolCall?: OpenAICompatToolCallScript;
	/**
	 * Reasoning text streamed before the reply, one SSE delta per chunk, under
	 * `reasoningField`. LM Studio spells the field `reasoning` for gpt-oss and
	 * `reasoning_content` for the rest; llama.cpp always `reasoning_content`.
	 */
	reasoningChunks?: readonly string[];
	reasoningField?: "reasoning" | "reasoning_content" | "reasoning_text";
}

/** True once a request's message history carries a tool result or a tool call. */
function hasToolExchange(request: Record<string, unknown>): boolean {
	const messages = request.messages;
	if (!Array.isArray(messages)) return false;
	return messages.some((message) => {
		if (typeof message !== "object" || message === null) return false;
		const record = message as Record<string, unknown>;
		if (record.role === "tool") return true;
		return Array.isArray(record.tool_calls) && record.tool_calls.length > 0;
	});
}

export interface OpenAICompatFixture {
	server: Server;
	url: string;
	requests: Array<Record<string, unknown>>;
}

/**
 * Start a mock OpenAI-compat server that answers `GET /v1/models` and both
 * streaming and non-streaming `POST /v1/chat/completions` with a fixed reply,
 * recording every chat request for assertions. Listens on an ephemeral port.
 */
export async function startOpenAICompatFixture(
	reply: string,
	options: OpenAICompatFixtureOptions = {},
): Promise<OpenAICompatFixture> {
	const models = options.models ?? [{ id: "mock-model", object: "model" }];
	const requests: Array<Record<string, unknown>> = [];
	let streamingRequests = 0;
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: models }));
			return;
		}
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const raw = await readRequestBody(req);
		const request = JSON.parse(raw) as Record<string, unknown>;
		requests.push(request);
		if (request.stream === false) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "chatcmpl-clio-probe",
					object: "chat.completion",
					model: request.model ?? "mock-model",
					choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
				}),
			);
			return;
		}
		streamingRequests += 1;
		if (options.initialErrors !== undefined && streamingRequests <= options.initialErrors.count) {
			res.writeHead(options.initialErrors.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: options.initialErrors.message, type: "fixture_error" } }));
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		if (options.toolCall !== undefined && !hasToolExchange(request)) {
			const script = options.toolCall;
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-clio-tool",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: script.id ?? "call-clio-tool-1",
										type: "function",
										function: { name: script.name, arguments: JSON.stringify(script.arguments) },
									},
								],
							},
						},
					],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-clio-tool",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
			return;
		}
		for (const chunk of options.reasoningChunks ?? []) {
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-clio-print",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: { [options.reasoningField ?? "reasoning_content"]: chunk } }],
				})}\n\n`,
			);
		}
		const replyChunks = options.replyChunks ?? [reply];
		for (let index = 0; index < replyChunks.length; index += 1) {
			const chunk = replyChunks[index] ?? "";
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-clio-print",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: { content: chunk } }],
				})}\n\n`,
			);
			if ((options.chunkDelayMs ?? 0) > 0 && index + 1 < replyChunks.length) {
				await new Promise<void>((resolve) => setTimeout(resolve, options.chunkDelayMs));
			}
		}
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-clio-print",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${addr.port}`, requests };
}

export function seedOpenAICompatOrchestrator(configDir: string, url: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml
		.replace(
			/^targets:.*$/m,
			[
				"targets:",
				"  - id: mock-chat",
				"    runtime: openai-compat",
				`    url: ${url}`,
				"    defaultModel: mock-model",
				"    auth:",
				"      apiKeyEnvVar: CLIO_CODER_TEST_OPENAI_KEY",
				"    capabilities:",
				"      vision: true",
				"    wireModels:",
				"      - mock-model",
			].join("\n"),
		)
		.replace(/^ {2}target: null$/m, "  target: mock-chat")
		.replace(/^ {2}model: null$/m, "  model: mock-model");
	writeFileSync(p, patched, "utf8");
}

/**
 * The orchestrator seed above plus the capability keys a tool-calling turn
 * needs, and an optional autonomy level. `suggest` is the level at which a
 * mutating built-in such as `write` parks for approval instead of running, so a
 * test that wants to observe a permission request seeds it here rather than
 * reaching into the running process.
 */
export function seedOpenAICompatToolOrchestrator(configDir: string, url: string, autonomy?: string): void {
	seedOpenAICompatOrchestrator(configDir, url);
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	let patched = yaml.replace(
		["    capabilities:", "      vision: true"].join("\n"),
		[
			"    capabilities:",
			"      chat: true",
			"      tools: true",
			"      toolCallFormat: openai",
			"      vision: true",
			"      contextWindow: 32768",
			"      maxTokens: 4096",
		].join("\n"),
	);
	if (autonomy !== undefined) patched = patched.replace(/^autonomy: .*$/m, `autonomy: ${autonomy}`);
	writeFileSync(p, patched, "utf8");
}

export function seedOpenAICompatFleetDefault(configDir: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml
		.replace(/^ {4}target: null$/m, "    target: mock-chat")
		.replace(/^ {4}model: null$/m, "    model: mock-model")
		.replace(
			"      vision: true",
			["      chat: true", "      tools: true", "      toolCallFormat: openai", "      vision: true"].join("\n"),
		);
	writeFileSync(p, patched, "utf8");
}

/**
 * Seed two tool-capable Scout targets over one HTTP fixture. The llama.cpp
 * target exercises the native response-schema wire contract; the generic
 * OpenAI target exercises the bounded prompt-parser fallback. No ambient Scout
 * binding is seeded: explicit CLI routing must stand on its own.
 */
export function seedBootstrapTransportTargets(configDir: string, url: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const targets = [
		"targets:",
		"  - id: fixture-llama",
		"    runtime: llamacpp",
		`    url: ${url}`,
		"    defaultModel: mock-model",
		"    wireModels:",
		"      - mock-model",
		"    lifecycle: user-managed",
		"    capabilities:",
		"      chat: true",
		"      tools: true",
		"      toolCallFormat: openai",
		"      structuredOutputs: json-schema",
		"      contextWindow: 32768",
		"      maxTokens: 4096",
		"  - id: fixture-openai-scout",
		"    runtime: openai-compat",
		`    url: ${url}`,
		"    defaultModel: mock-model",
		"    wireModels:",
		"      - mock-model",
		"    capabilities:",
		"      chat: true",
		"      tools: true",
		"      toolCallFormat: openai",
		"      structuredOutputs: none",
		"      contextWindow: 32768",
		"      maxTokens: 4096",
	].join("\n");
	const patched = yaml.replace(/^targets:.*$/m, targets);
	writeFileSync(p, patched, "utf8");
}

export function seedUnregisteredRuntimeTarget(configDir: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml.replace(
		/^targets:.*$/m,
		[
			"targets:",
			"  - id: codex-worker",
			"    runtime: codex-cli",
			"    defaultModel: gpt-5.4",
			"    wireModels:",
			"      - gpt-5.4",
		].join("\n"),
	);
	writeFileSync(p, patched, "utf8");
}
