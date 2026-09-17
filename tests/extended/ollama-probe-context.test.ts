import { strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, it } from "node:test";
import ollamaNativeRuntime from "../../src/domains/providers/runtimes/local-native/ollama-native.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { closeServer } from "../harness/openai-compat-fixture.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

/** Serves the two bodies the ollama-native probe reads. `ps` is sent verbatim. */
async function fixture(ps: unknown): Promise<string> {
	const server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/tags") {
			res.end(JSON.stringify({ models: [{ name: "qwen3:30b-a3b-instruct" }] }));
			return;
		}
		strictEqual(req.url, "/api/ps");
		res.end(JSON.stringify(ps));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function context(): ProbeContext {
	return { credentialsPresent: new Set<string>(), httpTimeoutMs: 2_000 };
}

it("reports the window a resident Ollama model is actually served at", async () => {
	const url = await fixture({
		models: [
			{
				model: "qwen3:30b-a3b-instruct",
				name: "qwen3:30b-a3b-instruct",
				size: 20_330_336_746,
				size_vram: 20_330_336_746,
				context_length: 32_768,
			},
		],
	});

	const result = await ollamaNativeRuntime.probe?.({ url } as TargetDescriptor, context());

	strictEqual(result?.ok, true);
	const status = result?.modelStates?.["qwen3:30b-a3b-instruct"];
	strictEqual(status?.state, "loaded");
	// The serving window, not the model's 262144 maximum, is what a run is planned against.
	strictEqual(status?.contextLength, 32_768);
	strictEqual(status?.sizeVramBytes, 20_330_336_746);
});

it("omits the context window when Ollama does not report a usable one", async () => {
	const url = await fixture({
		models: [
			{ model: "a", name: "a", context_length: 0 },
			{ model: "b", name: "b" },
			{ model: "c", name: "c", context_length: "32768" },
		],
	});

	const result = await ollamaNativeRuntime.probe?.({ url } as TargetDescriptor, context());

	strictEqual(result?.ok, true);
	for (const id of ["a", "b", "c"]) {
		strictEqual(result?.modelStates?.[id]?.state, "loaded");
		strictEqual(result?.modelStates?.[id]?.contextLength, undefined);
	}
});
