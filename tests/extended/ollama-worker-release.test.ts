import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	approvedIdentityForSpec,
	CONTROL_FRAME_PREFIX,
	parseControlFrame,
} from "../../src/domains/dispatch/worker-protocol.js";
import { type SpawnedWorker, spawnWorkerProcess } from "../../src/domains/dispatch/worker-spawn.js";
import ollamaNativeRuntime from "../../src/domains/providers/runtimes/local-native/ollama-native.js";
import { releaseClioLoadedModelsOnExit } from "../../src/engine/apis/residency.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";

const MODEL = "worker:latest";
const servers: Server[] = [];

beforeEach(() => isolateDispatchState());
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => closeServer(server)));
	restoreDispatchState();
});

/** A recording Ollama server; `/api/generate` is how Ollama releases a model. */
async function ollamaFixture() {
	const resident = new Set<string>();
	const releases: Array<{ model: string; keep_alive: unknown }> = [];
	const server = createServer(async (req, res) => {
		const raw = req.method === "POST" ? await readRequestBody(req) : "";
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/ps") {
			res.end(JSON.stringify({ models: [...resident].map((model) => ({ model, name: model })) }));
			return;
		}
		if (req.url === "/api/tags") {
			res.end(JSON.stringify({ models: [{ model: MODEL, name: MODEL }] }));
			return;
		}
		if (req.url === "/api/version") {
			res.end(JSON.stringify({ version: "0.34.0" }));
			return;
		}
		if (req.url === "/api/show") {
			res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "x.context_length": 32768 } }));
			return;
		}
		if (req.url === "/api/generate") {
			const body = JSON.parse(raw) as { model: string; keep_alive: unknown };
			releases.push({ model: body.model, keep_alive: body.keep_alive });
			resident.delete(body.model);
			res.end(JSON.stringify({ done: true }));
			return;
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ error: "not found" }));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, resident, releases };
}

// Stands in for a worker whose Ollama request loaded MODEL: it announces the
// approved identity, reports the load over the control lane the way the
// worker entry does, and exits. It never reaches a model itself.
const CHILD = `
const readline = require("node:readline");
const identity = JSON.parse(process.argv[1]);
const prefix = process.argv[2];
const load = JSON.parse(process.argv[3]);
readline.createInterface({ input: process.stdin }).once("line", () => {
  const unknown = { known: false };
  const attestation = {
    ...identity, protocolVersion: 1, pid: process.pid, processGroupId: process.pid, host: "load-fixture",
    resources: { labels: [], cpuCount: unknown, totalMemoryBytes: unknown,
      freeMemoryBytes: unknown, gpuCount: unknown, vramBytes: unknown, residentModels: unknown }
  };
  process.stderr.write(prefix + JSON.stringify({ kind: "announce", attestation }) + "\\n");
  process.stderr.write(prefix + JSON.stringify({ kind: "model_loaded", load }) + "\\n", () => process.exit(0));
});
`;

async function dispatchReportingWorker(url: string, load: Record<string, unknown>): Promise<void> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.targets = [{ id: "ollama-t", runtime: "ollama-native", url, defaultModel: MODEL }];
	settings.fleet.default.target = "ollama-t";
	settings.fleet.default.model = MODEL;
	let worker: SpawnedWorker | undefined;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: ollamaNativeRuntime }), {
		spawnWorker: (spec, options) => {
			worker = spawnWorkerProcess(
				process.execPath,
				["-e", CHILD, JSON.stringify(approvedIdentityForSpec(spec)), CONTROL_FRAME_PREFIX, JSON.stringify(load)],
				spec,
				options,
			);
			return worker;
		},
	});
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: "scout",
			task: "Inspect the fixture input and report available evidence.",
			executionRole: "researcher",
			requestOrigin: "internal",
			target: "ollama-t",
			model: MODEL,
		});
		ok(worker);
		await worker.promise;
		await run.finalPromise;
	} finally {
		await bundle.extension.stop?.();
	}
}

it("releases at orchestrator exit a model a dispatched worker reported loading (#379)", {
	timeout: 30_000,
}, async () => {
	const fixture = await ollamaFixture();
	fixture.resident.add(MODEL);
	fixture.resident.add("operator:latest");
	await dispatchReportingWorker(fixture.url, { targetId: "ollama-t", modelId: MODEL, aliasIds: [] });
	deepStrictEqual(fixture.releases, [], "a worker exit releases nothing by itself");
	await releaseClioLoadedModelsOnExit();
	deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
	strictEqual(fixture.resident.has("operator:latest"), true);
});

it("ignores a worker report naming a target the dispatch did not admit (#379)", { timeout: 30_000 }, async () => {
	const fixture = await ollamaFixture();
	fixture.resident.add(MODEL);
	await dispatchReportingWorker(fixture.url, { targetId: "elsewhere", modelId: MODEL, aliasIds: [] });
	await releaseClioLoadedModelsOnExit();
	deepStrictEqual(fixture.releases, []);
});

it("parses a model load report as ids only and refuses an unbounded one (#379)", () => {
	const line = (load: unknown) => `${CONTROL_FRAME_PREFIX}${JSON.stringify({ kind: "model_loaded", load })}`;
	const parsed = parseControlFrame(
		line({ targetId: "ollama-t", modelId: MODEL, aliasIds: [], headers: { authorization: "Bearer secret" } }),
	);
	deepStrictEqual(parsed, {
		ok: true,
		value: { kind: "model_loaded", load: { targetId: "ollama-t", modelId: MODEL, aliasIds: [] } },
	});
	strictEqual(
		parseControlFrame(line({ targetId: "ollama-t", modelId: MODEL, aliasIds: Array(9).fill(MODEL) })).ok,
		false,
	);
	strictEqual(parseControlFrame(line({ targetId: "ollama-t", modelId: "m".repeat(257), aliasIds: [] })).ok, false);
});
