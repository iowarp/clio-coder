import { workerData } from "node:worker_threads";
import { DocsAdapter } from "../clio/adapters/docs.js";
import { sessionHistory } from "../clio/adapters/sessions.js";
import { toolchainAdapter } from "../clio/adapters/toolchain.js";
import { TraceAdapter } from "../clio/adapters/traces.js";
import { AppProblem } from "../services/problem.js";
import type { WorkerSettings } from "./protocol.js";
import { serveWorker } from "./serve.js";

const settings = workerData as WorkerSettings;
const fixture = settings.fixture ? await import("../../tests/fixtures/toolchain.js") : undefined;
const adapter = toolchainAdapter(fixture?.fixtureOptions(settings));
const traces = new TraceAdapter();
const docs = new DocsAdapter(settings.fixture ? settings.fixtureDocsPackageRoot : undefined);
serveWorker(async (call) => {
	if (call.method === "fleet.read") {
		const { readFleet } = await import("../clio/adapters/fleet.js");
		return readFleet(call.params);
	}
	if (call.method === "settings.read") {
		const { inspectSettings } = await import("../clio/adapters/settings.js");
		return inspectSettings(call.params.cwd);
	}
	if (call.method === "config.graph") {
		if (settings.fixture && settings.fixtureGraphDelayMs)
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settings.fixtureGraphDelayMs);
		const { inspectConfigGraph } = await import("../clio/adapters/config-graph.js");
		return inspectConfigGraph(call.params.cwd);
	}
	if (call.method === "docs.read") return docs.read(call.params);
	if (call.method === "docs.blueprint") return docs.blueprint(call.params.path);
	if (call.method === "sessions.list") return sessionHistory(call.params.cwd);
	if (call.method === "traces.read") return traces.read(call.params);
	if (call.method !== "tools.list") throw new AppProblem("unsupported", "Method is not available in the reads worker.");
	if (settings.fixture && settings.readDelayMs)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settings.readDelayMs);
	if (settings.fixture && settings.crashRead) process.exit(7);
	return adapter.list();
});
