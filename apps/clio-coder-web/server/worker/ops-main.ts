import { workerData } from "node:worker_threads";
import { toolchainAdapter, toolDownloader } from "../clio/adapters/toolchain.js";
import { restrictNetwork } from "../network-policy.js";
import { AppProblem } from "../services/problem.js";
import type { WorkerSettings } from "./protocol.js";
import { serveWorker } from "./serve.js";

const settings = workerData as WorkerSettings;
const download = restrictNetwork();
const fixture = settings.fixture ? await import("../../tests/fixtures/toolchain.js") : undefined;
const adapter = toolchainAdapter(fixture?.fixtureOptions(settings) ?? { fetcher: toolDownloader(download) });
serveWorker((call, progress) => {
	if (call.method === "tools.install") return adapter.install(call.params.id, call.params.force, progress);
	if (call.method === "tools.remove") return adapter.remove(call.params.id);
	throw new AppProblem("unsupported", "Method is not available in the ops worker.");
});
