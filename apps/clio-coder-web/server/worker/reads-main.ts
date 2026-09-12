import { workerData } from "node:worker_threads";
import { DocsAdapter } from "../clio/adapters/docs.js";
import { runtimeInfo } from "../clio/adapters/runtime.js";
import { sessionHistory } from "../clio/adapters/sessions.js";
import { toolchainAdapter } from "../clio/adapters/toolchain.js";
import { TraceAdapter } from "../clio/adapters/traces.js";
import { restrictNetwork } from "../network-policy.js";
import { AppProblem } from "../services/problem.js";
import type { WorkerSettings } from "./protocol.js";
import { serveWorker } from "./serve.js";

const settings = workerData as WorkerSettings;
declare const __CLIO_WEB_BUNDLED__: boolean;
restrictNetwork();
const fixture =
	(typeof __CLIO_WEB_BUNDLED__ === "undefined" || !__CLIO_WEB_BUNDLED__) && settings.fixture
		? await import("../../tests/fixtures/toolchain.js")
		: undefined;
const adapter = toolchainAdapter(fixture?.fixtureOptions(settings));
const traces = new TraceAdapter();
const docs = new DocsAdapter(settings.fixture ? settings.fixtureDocsPackageRoot : undefined);
serveWorker(async (call) => {
	if (call.method === "runtime.info" && process.env.NODE_ENV === "test") return runtimeInfo(import.meta.url);
	if (call.method === "system.read" || call.method === "interop.read") {
		const { inspectSystem, inspectInterop } = await import("../clio/adapters/system.js");
		return call.method === "system.read" ? inspectSystem() : inspectInterop(call.params.cwd, settings.fixture);
	}
	if (call.method === "library.read") {
		const { readLibrary } = await import("../clio/adapters/library.js");
		return readLibrary(call.params);
	}
	if (call.method === "evals.read") {
		const { readEvals } = await import("../clio/adapters/evals.js");
		return readEvals(call.params);
	}
	if (call.method === "evidence.read") {
		const { readEvidence } = await import("../clio/adapters/evidence.js");
		return readEvidence(call.params);
	}
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
	if (call.method === "sessions.list") return sessionHistory(call.params.cwd);
	if (call.method === "traces.read") return traces.read(call.params);
	if (call.method !== "tools.list") throw new AppProblem("unsupported", "Method is not available in the reads worker.");
	if (settings.fixture && settings.readDelayMs)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settings.readDelayMs);
	if (settings.fixture && settings.crashRead) process.exit(7);
	return adapter.list();
});
