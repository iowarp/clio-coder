/** Pi 1.4 identifies requests as pi unless the host names a ClientIdentity; Clio's requests must name Clio. */
import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	type AssistantMessage,
	type ClientIdentity,
	createAssistantMessageEventStream,
	getIdentityHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createEngineAgent } from "../../src/engine/agent.js";
import { engineStreamSimple, registerEngineApiProvider } from "../../src/engine/api-registry.js";
import type { EngineModel } from "../../src/engine/types.js";

const MODEL: EngineModel = {
	id: "identity-fixture",
	name: "identity fixture",
	api: "clio-identity-probe",
	provider: "fixture",
	baseUrl: "https://fixture.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function reply(): ReturnType<typeof createAssistantMessageEventStream> {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

function assertClio(identity: ClientIdentity | undefined): void {
	ok(identity, "request carries an identity");
	strictEqual(identity.attribution?.name, "Clio Coder");
	const headers = getIdentityHeaders({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, identity);
	match(headers["User-Agent"] ?? "", /^clio-coder\//u);
	strictEqual(headers["HTTP-Referer"], "https://github.com/iowarp/clio-coder");
	strictEqual(headers["X-OpenRouter-Title"], "Clio Coder");
}

test("agent turns override Pi's default pi attribution with Clio's identity", async () => {
	let seen: SimpleStreamOptions | undefined;
	const { agent } = createEngineAgent({
		initialState: { model: MODEL, thinkingLevel: "off", systemPrompt: "fixture", tools: [] },
		transcriptStreamFn(_model, _context, options) {
			seen = options;
			return reply();
		},
	});
	await agent.prompt("hello");
	assertClio(seen?.identity);
});

test("engine dispatch names Clio on side requests that carry no identity", async () => {
	let seen: SimpleStreamOptions | undefined;
	const capture = (_model: unknown, _context: unknown, options?: SimpleStreamOptions) => {
		seen = options;
		return reply();
	};
	registerEngineApiProvider({ api: MODEL.api, stream: capture, streamSimple: capture }, "identity-probe");
	await engineStreamSimple(MODEL, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }).result();
	assertClio(seen?.identity);
});
