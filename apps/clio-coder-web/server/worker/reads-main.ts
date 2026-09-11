import { workerData } from "node:worker_threads";
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
serveWorker((call) => {
	if (call.method === "sessions.list") return sessionHistory(call.params.cwd);
	if (call.method === "traces.read") return traces.read(call.params);
	if (call.method !== "tools.list") throw new AppProblem("unsupported", "Method is not available in the reads worker.");
	if (settings.fixture && settings.readDelayMs)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settings.readDelayMs);
	if (settings.fixture && settings.crashRead) process.exit(7);
	return adapter.list();
});
