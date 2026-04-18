import { ok, strictEqual } from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Context, Model } from "@mariozechner/pi-ai";

import { ollamaNativeApiProvider } from "../../../src/engine/apis/ollama-native.js";

interface NdjsonChunk {
	done: boolean;
	text?: string;
	toolCall?: {
		name: string;
		arguments: Record<string, unknown>;
	};
	prompt_eval_count?: number;
	eval_count?: number;
	done_reason?: string;
}

let server: Server | null = null;
let baseUrl = "";
let respondWith: NdjsonChunk[] = [];
let lastBodyString = "";

beforeEach(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST" || !req.url?.startsWith("/api/chat")) {
			res.statusCode = 404;
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			lastBodyString = Buffer.concat(chunks).toString("utf8");
			res.setHeader("content-type", "application/x-ndjson");
			res.statusCode = 200;
			for (const c of respondWith) {
				const payload: Record<string, unknown> = {
					model: "ollama-test-model",
					created_at: new Date().toISOString(),
					done: c.done,
				};
				const message: Record<string, unknown> = { role: "assistant", content: c.text ?? "" };
				if (c.toolCall) {
					message.tool_calls = [
						{ function: { name: c.toolCall.name, arguments: c.toolCall.arguments } },
					];
				}
				payload.message = message;
				if (c.done) {
					payload.done_reason = c.done_reason ?? "stop";
					payload.prompt_eval_count = c.prompt_eval_count ?? 5;
					payload.eval_count = c.eval_count ?? 7;
				}
				res.write(`${JSON.stringify(payload)}\n`);
			}
			res.end();
		});
	});
	await new Promise<void>((resolve) => {
		server?.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server?.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => {
		if (!server) return resolve();
		server.close(() => resolve());
	});
	server = null;
	respondWith = [];
	lastBodyString = "";
});

function makeModel(): Model<"ollama-native"> {
	return {
		id: "ollama-test-model",
		name: "ollama-test-model",
		api: "ollama-native",
		provider: "ollama",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
	} as Model<"ollama-native">;
}

function makeContext(): Context {
	return {
		systemPrompt: "",
		messages: [{ role: "user", content: "hi" }],
		tools: [],
	} as unknown as Context;
}

async function collect(stream: AsyncIterable<{ type: string } & Record<string, unknown>>): Promise<string[]> {
	const types: string[] = [];
	for await (const ev of stream) {
		types.push(ev.type);
	}
	return types;
}

describe("engine/apis ollamaNativeApiProvider.stream", () => {
	it("translates a text-only NDJSON stream into start → text_start → text_delta×N → text_end → done", async () => {
		respondWith = [
			{ done: false, text: "he" },
			{ done: false, text: "llo" },
			{ done: true, done_reason: "stop" },
		];
		const stream = ollamaNativeApiProvider.stream(makeModel(), makeContext(), undefined);
		const types = await collect(
			stream as AsyncIterable<{ type: string } & Record<string, unknown>>,
		);
		strictEqual(types[0], "start");
		strictEqual(types[1], "text_start");
		const deltas = types.filter((t) => t === "text_delta");
		strictEqual(deltas.length, 2);
		ok(types.includes("text_end"));
		strictEqual(types.at(-1), "done");
		ok(lastBodyString.includes("hi"), "the /api/chat request body should include the user text");
	});

	it("emits toolcall_start / toolcall_delta / toolcall_end when the final chunk carries a tool_call", async () => {
		respondWith = [
			{ done: false, text: "pre-call" },
			{
				done: true,
				toolCall: { name: "shell", arguments: { cmd: "ls" } },
				done_reason: "stop",
			},
		];
		const stream = ollamaNativeApiProvider.stream(makeModel(), makeContext(), undefined);
		const types = await collect(
			stream as AsyncIterable<{ type: string } & Record<string, unknown>>,
		);
		ok(types.includes("toolcall_start"));
		ok(types.includes("toolcall_delta"));
		ok(types.includes("toolcall_end"));
		strictEqual(types.at(-1), "done");
	});
});
