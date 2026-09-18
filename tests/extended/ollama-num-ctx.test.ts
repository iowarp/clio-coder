import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { validateSettings } from "../../src/core/config.js";
import { resolveContextWindowDetails } from "../../src/domains/providers/runtime-resolution.js";
import ollamaNativeRuntime from "../../src/domains/providers/runtimes/local-native/ollama-native.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { ollamaNativeApiProvider } from "../../src/engine/apis/ollama-native.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
const servers: ReturnType<typeof createServer>[] = [];

beforeEach(async () => {
	env = await isolateClioEnv("ollama-num-ctx-");
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
	env.restore();
});

const MODEL = "qwen3:30b-a3b-instruct";

/** An Ollama that records every `/api/chat` body and answers with one done line. */
async function ollama(): Promise<{ url: string; chats: Array<{ options?: Record<string, unknown> }> }> {
	const chats: Array<{ options?: Record<string, unknown> }> = [];
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [] }));
		chats.push(JSON.parse(await readRequestBody(req)));
		res.end(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content: "ok" }, done: true })}\n`);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats };
}

async function chat(target: TargetDescriptor): Promise<void> {
	const model = ollamaNativeRuntime.synthesizeModel?.(target, MODEL, null) as Model<"ollama-native">;
	const result = await ollamaNativeApiProvider
		.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] })
		.result();
	strictEqual(result.stopReason, "stop");
}

it("sends a configured numCtx as options.num_ctx", async () => {
	const server = await ollama();

	await chat({ id: "o", runtime: "ollama-native", url: server.url, defaultModel: MODEL, ollama: { numCtx: 65_536 } });

	strictEqual(server.chats[0]?.options?.num_ctx, 65_536);
});

it("sends no num_ctx when none is configured, so a shared server is not made to reload", async () => {
	const server = await ollama();

	await chat({ id: "o", runtime: "ollama-native", url: server.url, defaultModel: MODEL });

	strictEqual(server.chats.length, 1);
	strictEqual("num_ctx" in (server.chats[0]?.options ?? {}), false);
});

function plan(target: TargetDescriptor, maximum: number | null, loaded: number | null) {
	return resolveContextWindowDetails(target, ollamaNativeRuntime, MODEL, null, maximum, loaded);
}

it("plans against numCtx over the loaded window the next request will replace", () => {
	const target: TargetDescriptor = { id: "o", runtime: "ollama-native", ollama: { numCtx: 65_536 } };

	const details = plan(target, 262_144, 32_768);

	strictEqual(details.effectiveContextWindow, 65_536);
	strictEqual(details.contextWindowSource, "target-override");
});

it("caps numCtx at the model maximum and at a smaller explicit window", () => {
	const target: TargetDescriptor = { id: "o", runtime: "ollama-native", ollama: { numCtx: 524_288 } };
	const capped = plan(target, 262_144, null);
	strictEqual(capped.effectiveContextWindow, 262_144);
	strictEqual(capped.contextWindowSource, "probe");

	const overridden = plan({ ...target, capabilities: { contextWindow: 40_960 } }, 262_144, null);
	strictEqual(overridden.effectiveContextWindow, 40_960);
});

it("keeps the loaded window in charge when numCtx is unset", () => {
	const details = plan({ id: "o", runtime: "ollama-native" }, 262_144, 32_768);

	strictEqual(details.effectiveContextWindow, 32_768);
	strictEqual(details.contextWindowSource, "loaded");
});

it("validates targets[].ollama.numCtx as a positive integer", () => {
	const target = (ollama: unknown) => ({
		targets: [{ id: "o", runtime: "ollama-native", url: "http://127.0.0.1:11434", ollama }],
	});

	const valid = validateSettings(target({ numCtx: 65_536 }));
	deepStrictEqual(valid.issues, []);
	deepStrictEqual(valid.settings.targets[0]?.ollama, { numCtx: 65_536 });

	for (const bad of [{ numCtx: 0 }, { numCtx: 1.5 }, { numCtx: "65536" }, { numCtx: 1, keepAlive: 1 }]) {
		const result = validateSettings(target(bad));
		strictEqual(result.issues.length > 0, true, JSON.stringify(bad));
	}
});

it("plans a cold model at the 131072 cap, not a larger model maximum", () => {
	const details = plan({ id: "o", runtime: "ollama-native" }, 262_144, null);

	strictEqual(details.effectiveContextWindow, 131_072);
	strictEqual(details.contextWindowSource, "probe");
});

it("plans a cold model whose maximum is below the cap at that maximum", () => {
	strictEqual(plan({ id: "o", runtime: "ollama-native" }, 32_768, null).effectiveContextWindow, 32_768);
});

it("plans a loaded model at its loaded window, not the cold cap", () => {
	const details = plan({ id: "o", runtime: "ollama-native" }, 262_144, 32_768);

	strictEqual(details.effectiveContextWindow, 32_768);
	strictEqual(details.contextWindowSource, "loaded");
});

it("plans a cold model at a configured numCtx", () => {
	const target: TargetDescriptor = { id: "o", runtime: "ollama-native", ollama: { numCtx: 65_536 } };

	strictEqual(plan(target, 262_144, null).effectiveContextWindow, 65_536);
});
