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

export interface OpenAICompatFixtureOptions {
	models?: Array<Record<string, unknown> & { id: string }>;
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
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-clio-print",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: [{ index: 0, delta: { content: reply } }],
			})}\n\n`,
		);
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
				"      apiKeyEnvVar: CLIO_TEST_OPENAI_KEY",
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

export function seedOpenAICompatFleetDefault(configDir: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml
		.replace(/^ {4}target: null$/m, "    target: mock-chat")
		.replace(/^ {4}model: null$/m, "    model: mock-model");
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
