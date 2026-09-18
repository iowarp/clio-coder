import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { RunNodeIdentity } from "../../src/domains/dispatch/types.js";
import { adoptWorkerModelLoad, type WorkerModelLoadRoute } from "../../src/domains/dispatch/worker-model-loads.js";
import ollamaNativeRuntime from "../../src/domains/providers/runtimes/local-native/ollama-native.js";
import { ollamaNativeApiProvider, releaseClioLoadedOllamaModels } from "../../src/engine/apis/ollama-native.js";
import {
	type ClioModelLoad,
	releaseClioLoadedModelsOnExit,
	setModelLoadReportSink,
} from "../../src/engine/apis/residency.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
const servers: ReturnType<typeof createServer>[] = [];

beforeEach(async () => {
	env = await isolateClioEnv("ollama-residency-");
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
	env.restore();
});

async function fixture() {
	const resident = new Set<string>();
	const unloads: string[] = [];
	const failedChats = new Set<string>();
	const failedUnloads = new Set<string>();
	const hang = { unloads: false };
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/ps") {
			res.end(JSON.stringify({ models: [...resident].map((model) => ({ model, name: model })) }));
			return;
		}
		const body = JSON.parse(await readRequestBody(req)) as { model: string; keep_alive: number };
		if (req.url === "/api/generate") {
			strictEqual(body.keep_alive, 0);
			unloads.push(body.model);
			if (hang.unloads) return;
			if (failedUnloads.has(body.model)) {
				res.statusCode = 500;
				res.end(JSON.stringify({ error: "unload failed" }));
				return;
			}
			resident.delete(body.model);
			res.end(JSON.stringify({ done: true }));
			return;
		}
		strictEqual(req.url, "/api/chat");
		strictEqual(body.keep_alive, -1);
		if (failedChats.has(body.model)) {
			res.end(`${JSON.stringify({ error: "load failed" })}\n`);
			return;
		}
		resident.add(body.model);
		res.end(`${JSON.stringify({ model: body.model, message: { role: "assistant", content: "ready" }, done: true })}\n`);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, resident, unloads, failedChats, failedUnloads, hang };
}

async function chat(baseUrl: string, id: string): Promise<string> {
	const model: Model<"ollama-native"> = {
		id,
		name: id,
		api: "ollama-native",
		provider: "ollama",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 128,
	};
	const stream = ollamaNativeApiProvider.stream(model, {
		messages: [{ role: "user", content: "Reply ready", timestamp: 0 }],
	});
	return (await stream.result()).stopReason;
}

it("preserves operator models and unloads models Clio pinned on a model switch", async () => {
	const target = await fixture();
	target.resident.add("operator:latest");
	strictEqual(await chat(target.url, "first:latest"), "stop");
	strictEqual(await chat(target.url, "second:latest"), "stop");
	deepStrictEqual(target.unloads, ["first:latest"]);
	strictEqual(target.resident.has("operator:latest"), true);
});

it("does not claim a failed load when an operator subsequently loads that model", async () => {
	const target = await fixture();
	target.failedChats.add("foreign:latest");
	strictEqual(await chat(target.url, "foreign:latest"), "error");
	target.resident.add("foreign:latest");
	strictEqual(await chat(target.url, "next:latest"), "stop");
	deepStrictEqual(target.unloads, []);
});

it("does not transfer ownership between servers", async () => {
	const first = await fixture();
	const second = await fixture();
	strictEqual(await chat(first.url, "shared:latest"), "stop");
	second.failedChats.add("shared:latest");
	strictEqual(await chat(second.url, "shared:latest"), "error");
	second.resident.add("shared:latest");
	strictEqual(await chat(second.url, "next:latest"), "stop");
	deepStrictEqual(second.unloads, []);
});

it("forgets successful unloads and retains ownership after failed unloads", async () => {
	const target = await fixture();
	strictEqual(await chat(target.url, "first:latest"), "stop");
	target.failedUnloads.add("first:latest");
	strictEqual(await chat(target.url, "second:latest"), "stop");
	target.failedUnloads.clear();
	strictEqual(await chat(target.url, "third:latest"), "stop");
	deepStrictEqual(target.unloads, ["first:latest", "first:latest", "second:latest"]);
	target.failedChats.add("first:latest");
	strictEqual(await chat(target.url, "first:latest"), "error");
	target.resident.add("first:latest");
	const before = target.unloads.length;
	strictEqual(await chat(target.url, "fourth:latest"), "stop");
	deepStrictEqual(target.unloads.slice(before), []);
});

it("releases on exit only the model Clio loaded, once, after a model switch", async () => {
	const target = await fixture();
	target.resident.add("operator:latest");
	strictEqual(await chat(target.url, "first:latest"), "stop");
	strictEqual(await chat(target.url, "second:latest"), "stop");
	strictEqual(await chat(target.url, "operator:latest"), "stop");
	deepStrictEqual(target.unloads, ["first:latest"]);
	await releaseClioLoadedOllamaModels();
	deepStrictEqual(target.unloads, ["first:latest", "second:latest"]);
	strictEqual(target.resident.has("operator:latest"), true);
	await releaseClioLoadedOllamaModels();
	deepStrictEqual(target.unloads, ["first:latest", "second:latest"]);
});

it("bounds the release on exit when the server never answers", async () => {
	const target = await fixture();
	strictEqual(await chat(target.url, "stuck:latest"), "stop");
	target.hang.unloads = true;
	const startedAt = performance.now();
	await releaseClioLoadedOllamaModels({ timeoutMs: 200 });
	const elapsedMs = performance.now() - startedAt;
	deepStrictEqual(target.unloads, ["stuck:latest"]);
	ok(elapsedMs < 1_500, `release took ${elapsedMs}ms against a 200ms bound`);
});

it("reports a model the worker's request loaded, once, and never one that was already resident", async () => {
	const target = await fixture();
	target.resident.add("warm:latest");
	const reports: ClioModelLoad[] = [];
	setModelLoadReportSink((load) => reports.push(load));
	try {
		strictEqual(await chat(target.url, "cold:latest"), "stop");
		strictEqual(await chat(target.url, "cold:latest"), "stop");
		strictEqual(await chat(target.url, "warm:latest"), "stop");
	} finally {
		setModelLoadReportSink(null);
	}
	deepStrictEqual(reports, [{ runtimeId: "ollama-native", targetId: "ollama", modelId: "cold:latest", aliasIds: [] }]);
});

function workerRoute(url: string, node: RunNodeIdentity = { id: "local", kind: "local" }): WorkerModelLoadRoute {
	return {
		target: { id: "ollama-t", runtime: "ollama-native", url },
		runtime: ollamaNativeRuntime,
		wireModelId: "worker:latest",
		node,
	};
}

it("releases at exit a model a worker reported, and only that one", async () => {
	const target = await fixture();
	target.resident.add("operator:latest");
	target.resident.add("worker:latest");
	ok(adoptWorkerModelLoad({ targetId: "ollama-t", modelId: "worker:latest", aliasIds: [] }, workerRoute(target.url)));
	await releaseClioLoadedModelsOnExit();
	deepStrictEqual(target.unloads, ["worker:latest"]);
	strictEqual(target.resident.has("operator:latest"), true);
});

it("refuses a worker report for another target, another model, or a remote node's loopback server", async () => {
	const target = await fixture();
	target.resident.add("worker:latest");
	const load = { targetId: "ollama-t", modelId: "worker:latest", aliasIds: [] };
	strictEqual(adoptWorkerModelLoad({ ...load, targetId: "other" }, workerRoute(target.url)), false);
	strictEqual(adoptWorkerModelLoad({ ...load, modelId: "operator:latest" }, workerRoute(target.url)), false);
	strictEqual(adoptWorkerModelLoad(load, workerRoute(target.url, { id: "dragon", kind: "ssh" })), false);
	await releaseClioLoadedModelsOnExit();
	deepStrictEqual(target.unloads, []);
});

it("never evicts a worker-reported model as a Clio straggler mid-session", async () => {
	const target = await fixture();
	target.resident.add("worker:latest");
	ok(adoptWorkerModelLoad({ targetId: "ollama-t", modelId: "worker:latest", aliasIds: [] }, workerRoute(target.url)));
	strictEqual(await chat(target.url, "chat:latest"), "stop");
	strictEqual(await chat(target.url, "chat2:latest"), "stop");
	deepStrictEqual(target.unloads, ["chat:latest"]);
	strictEqual(target.resident.has("worker:latest"), true);
	await releaseClioLoadedModelsOnExit();
	deepStrictEqual([...target.unloads].sort(), ["chat2:latest", "chat:latest", "worker:latest"]);
});
