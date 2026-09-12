import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { observeCacheDeployment } from "../../src/domains/providers/cache-deployment.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";

test("deployment discovery stays read-only, separates credentials, and invalidates route/build/residency evidence", async () => {
	let root = "";
	let state = "loaded";
	let build = "b1-c841aee";
	let deploymentId = "deployment-A";
	let busy = false;
	const requests: Array<{ path: string; auth: string | undefined; method: string | undefined }> = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", root);
		requests.push({ path: url.pathname + url.search, auth: req.headers.authorization, method: req.method });
		res.setHeader("content-type", "application/json");
		if (url.pathname === "/gateway/v1/model/info")
			return res.end(
				JSON.stringify({
					data: [
						{
							model_name: "route/model",
							model_info: { id: deploymentId },
							litellm_params: { model: "openai/model", api_base: `${root}/native/v1` },
						},
					],
				}),
			);
		if (url.pathname === "/native/version") return res.end(JSON.stringify({ version: "0.10.0" }));
		if (url.pathname === "/native/models")
			return res.end(JSON.stringify({ data: [{ id: "model", status: { value: state } }] }));
		if (url.pathname === "/native/props")
			return res.end(
				JSON.stringify(
					url.searchParams.has("model")
						? { model_alias: "model", build_info: build, is_sleeping: false }
						: { role: "router" },
				),
			);
		if (url.pathname === "/native/slots") return res.end(JSON.stringify([{ is_processing: busy }]));
		res.writeHead(404);
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const target: TargetDescriptor = {
		id: "native",
		runtime: "llamacpp",
		url: `${root}/native/v1`,
		cache: {
			deployment: { backend: "llamacpp", controlUrl: `${root}/native`, model: "model", build },
		},
	};
	try {
		const binding = target.cache?.deployment;
		ok(binding);
		const ready = await observeCacheDeployment(target, "model");
		strictEqual(ready.warm, "bounded");
		strictEqual(ready.epoch, null, "build identity is not a restart epoch");
		strictEqual(ready.administration, "unsupported");
		deepStrictEqual(ready.requestControls, ["cache_prompt"]);
		busy = true;
		strictEqual((await observeCacheDeployment(target, "model")).reason, "endpoint-busy-or-unknown");
		busy = false;
		state = "sleeping";
		requests.length = 0;
		strictEqual((await observeCacheDeployment(target, "model")).reason, "model-not-loaded");
		deepStrictEqual(
			requests.map((r) => r.path),
			["/native/props", "/native/models"],
			"no model-qualified request can wake a sleeping worker",
		);
		state = "loaded";
		build = "replaced-build";
		strictEqual((await observeCacheDeployment(target, "model")).reason, "deployment-build-mismatch");
		build = "b1-c841aee";
		const gateway: TargetDescriptor = {
			...target,
			runtime: "litellm",
			url: `${root}/gateway`,
			cache: { deployment: { ...binding, gatewayDeploymentId: "deployment-A" } },
		};
		requests.length = 0;
		strictEqual(
			(await observeCacheDeployment(gateway, "route/model", { gatewayApiKey: "gateway-fixture-key" })).reason,
			"gateway-cache-transport-unverified",
		);
		strictEqual(requests[0]?.auth, "Bearer gateway-fixture-key");
		strictEqual(
			requests.slice(1).every((r) => r.auth === undefined),
			true,
			"gateway credential never reaches control plane",
		);
		strictEqual(
			requests.every((r) => r.method === "GET"),
			true,
		);
		deploymentId = "deployment-B";
		requests.length = 0;
		strictEqual((await observeCacheDeployment(gateway, "route/model")).reason, "gateway-route-mismatch");
		strictEqual(requests.length, 1, "route failover prevents native discovery");
		const vllm: TargetDescriptor = {
			...target,
			runtime: "vllm",
			cache: { deployment: { ...binding, backend: "vllm", build: "0.10.0" } },
		};
		const scheduler = await observeCacheDeployment(vllm, "model");
		strictEqual(scheduler.warm, "unsupported");
		strictEqual(scheduler.reason, "vllm-scheduler-unverified");
		deepStrictEqual(scheduler.requestControls, []);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("unbound and unsafe control URLs remain passive without network access", async () => {
	let calls = 0;
	const fetchImpl: typeof fetch = async () => {
		calls += 1;
		throw new Error("must not be reached");
	};
	strictEqual(
		(await observeCacheDeployment({ id: "mini", runtime: "litellm", url: "http://localhost" }, "model", { fetchImpl }))
			.warm,
		"unsupported",
	);
	strictEqual(
		(
			await observeCacheDeployment(
				{
					id: "mini",
					runtime: "llamacpp",
					cache: {
						deployment: { backend: "llamacpp", controlUrl: "http://user:password@localhost", model: "model", build: "build" },
					},
				},
				"model",
				{ fetchImpl },
			)
		).reason,
		"deployment-invalid",
	);
	strictEqual(calls, 0);
});
