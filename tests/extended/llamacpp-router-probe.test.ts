import { strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import llamacppRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";

const ctx: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 2_000 };

describe("llama.cpp router probe", () => {
	let server: Server;
	let url = "";
	let state = "unloaded";
	let workerPropsHits = 0;

	before(async () => {
		server = createServer((request, response) => {
			const path = request.url ?? "/";
			const json = (body: unknown, status = 200) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
			};
			if (path === "/health") return json({ status: "ok" });
			if (path === "/v1/models") {
				return json({
					object: "list",
					data: [
						{
							id: "ornith",
							object: "model",
							status: { value: state, args: ["llama-server", "--parallel", "4", "--ctx-size", "786432", "--jinja"] },
						},
					],
				});
			}
			if (path === "/props") return json({ build_info: "router-b1", max_instances: 1 });
			if (path.startsWith("/props?model=")) {
				workerPropsHits += 1;
				return json({ total_slots: 4, default_generation_settings: { n_ctx: 196_608 }, build_info: "worker-b1" });
			}
			return json({ error: "not found" }, 404);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	after(() => new Promise<void>((resolve) => server.close(() => resolve())));

	it("reads an unloaded model's slots from the router list instead of loading it for /props", async () => {
		// Asking /props?model=<id> makes the router load the model; with
		// --models-max 1 that evicts the resident chat model and the next turn
		// prefills from zero. The list already carries --parallel.
		state = "unloaded";
		workerPropsHits = 0;
		const target = { id: "mini", runtime: "llamacpp", url, defaultModel: "ornith" };
		const result = await llamacppRuntime.probe?.(target, ctx);
		strictEqual(result?.ok, true);
		strictEqual(result?.ok === true ? result.discoveredCapabilities?.parallelSlots : undefined, 4);
		strictEqual(workerPropsHits, 0, "an unloaded model must not be loaded to answer a probe");

		state = "loaded";
		const loaded = await llamacppRuntime.probe?.(target, ctx);
		strictEqual(loaded?.ok, true);
		strictEqual(loaded?.ok === true ? loaded.discoveredCapabilities?.parallelSlots : undefined, 4);
		strictEqual(workerPropsHits, 1, "a resident model's worker props are still read");
	});
});
