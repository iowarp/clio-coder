import { strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import lemonadeRuntime from "../../src/domains/providers/runtimes/local-native/lemonade-openai.js";
import lmstudioRuntime from "../../src/domains/providers/runtimes/local-native/lmstudio.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";

const context: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 2_000 };

async function serverFor(responses: Record<string, unknown>): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((request, response) => {
		const body = responses[request.url ?? ""];
		response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
		response.end(JSON.stringify(body ?? { error: "not found" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

it("uses LM Studio's loaded 880,128 context per request at parallel four", async () => {
	const server = await serverFor({
		"/lmstudio-greeting": { lmstudio: true },
		"/api/v1/models": {
			models: [
				{
					key: "nemotron",
					type: "llm",
					max_context_length: 1_048_576,
					loaded_instances: [{ id: "nemotron", config: { context_length: 880_128, parallel: 4 } }],
				},
				{ key: "cold", type: "llm", max_context_length: 1_048_576, loaded_instances: [] },
			],
		},
	});
	try {
		const probed = await lmstudioRuntime.probe?.(
			{ id: "studio", runtime: "lmstudio", url: server.url, defaultModel: "nemotron" },
			context,
		);
		strictEqual(probed?.ok, true);
		strictEqual(probed?.modelCapabilities?.nemotron?.contextWindow, 880_128);
		strictEqual(probed?.modelStates?.nemotron?.contextLength, 880_128);
		strictEqual(probed?.modelStates?.nemotron?.modelMaxContextLength, 1_048_576);
		strictEqual(probed?.discoveredCapabilities?.parallelSlots, 4);
		strictEqual(probed?.modelCapabilities?.cold?.contextWindow, undefined);
		strictEqual(probed?.modelStates?.cold?.modelMaxContextLength, 1_048_576);
	} finally {
		await server.close();
	}
});

it("uses Lemonade's loaded instance ahead of a larger catalog maximum", async () => {
	const server = await serverFor({
		"/v1/models": {
			data: [
				{
					id: "lemon",
					owned_by: "lemonade",
					labels: ["chat"],
					max_context_length: 262_144,
					loaded_instance: { config: { context_length: 32_768 } },
				},
			],
		},
	});
	try {
		const probed = await lemonadeRuntime.probe?.(
			{ id: "lemonade", runtime: "lemonade", url: server.url, defaultModel: "lemon" },
			context,
		);
		strictEqual(probed?.ok, true);
		strictEqual(probed?.modelCapabilities?.lemon?.contextWindow, 32_768);
		strictEqual(probed?.modelStates?.lemon?.contextLength, 32_768);
		strictEqual(probed?.modelStates?.lemon?.modelMaxContextLength, 262_144);
	} finally {
		await server.close();
	}
});
