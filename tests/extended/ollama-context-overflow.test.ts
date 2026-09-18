import { match, notStrictEqual, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { toContextOverflowError } from "../../src/domains/providers/errors.js";
import { ollamaNativeApiProvider } from "../../src/engine/apis/ollama-native.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
const servers: ReturnType<typeof createServer>[] = [];

beforeEach(async () => {
	env = await isolateClioEnv("ollama-overflow-");
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
	env.restore();
});

// The body Ollama 0.34.0 returned for a prompt past the serving window,
// verbatim from issue #375. `error` is an object, not the string the ollama SDK
// expects.
const OVERFLOW_BODY = {
	error: {
		code: 400,
		message: "request (8009 tokens) exceeds the available context size (2048 tokens), try increasing it",
		type: "exceed_context_size_error",
		n_prompt_tokens: 8009,
		n_ctx: 2048,
	},
};

/** An Ollama whose `/api/chat` answers with `status` and the NDJSON `lines`. */
async function ollama(status: number, lines: unknown[]): Promise<string> {
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [] }));
		await readRequestBody(req);
		strictEqual(req.url, "/api/chat");
		res.statusCode = status;
		res.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function chatError(baseUrl: string): Promise<string | undefined> {
	const model: Model<"ollama-native"> = {
		id: "qwen3:30b-a3b-instruct",
		name: "qwen3:30b-a3b-instruct",
		api: "ollama-native",
		provider: "ollama",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 128,
	};
	const result = await ollamaNativeApiProvider
		.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] })
		.result();
	strictEqual(result.stopReason, "error");
	return result.errorMessage;
}

it("classifies Ollama's HTTP 400 exceed_context_size_error as a context overflow", async () => {
	const message = await chatError(await ollama(400, [OVERFLOW_BODY]));

	match(message ?? "", /exceeds the available context size \(2048 tokens\)/);
	notStrictEqual(toContextOverflowError(message), null);
});

it("keeps an unrelated structured error readable and unclassified", async () => {
	const message = await chatError(
		await ollama(400, [{ error: { code: 400, message: "invalid tool schema", type: "invalid_request_error" } }]),
	);

	match(message ?? "", /invalid tool schema/);
	strictEqual(toContextOverflowError(message), null);
});
