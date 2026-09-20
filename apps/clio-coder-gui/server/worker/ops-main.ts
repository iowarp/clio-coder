import { workerData } from "node:worker_threads";
import { libraryLifecycleAdapter } from "../clio/adapters/library-lifecycle.js";
import { runtimeInfo } from "../clio/adapters/runtime.js";
import { toolchainAdapter, toolDownloader } from "../clio/adapters/toolchain.js";
import { restrictNetwork } from "../network-policy.js";
import { AppProblem } from "../services/problem.js";
import type { WorkerSettings } from "./protocol.js";
import { serveWorker } from "./serve.js";

const settings = workerData as WorkerSettings;
declare const __CLIO_GUI_BUNDLED__: boolean;
const download = restrictNetwork();
const fixture =
	(typeof __CLIO_GUI_BUNDLED__ === "undefined" || !__CLIO_GUI_BUNDLED__) && settings.fixture
		? await import("../../tests/fixtures/toolchain.js")
		: undefined;
const adapter = toolchainAdapter(fixture?.fixtureOptions(settings) ?? { fetcher: toolDownloader(download) });
const library = libraryLifecycleAdapter();
serveWorker(async (call, progress) => {
	if (call.method === "runtime.info" && process.env.NODE_ENV === "test") return runtimeInfo(import.meta.url);
	if (call.method === "tools.install") return adapter.install(call.params.id, call.params.force, progress);
	if (call.method === "tools.remove") return adapter.remove(call.params.id);
	if (call.method === "library.plan") return library.plan(call.params.cwd, call.params.request);
	if (call.method === "library.apply") return library.apply(call.params.cwd, call.params.planId);
	if (call.method === "library.release") return library.release(call.params.cwd, call.params.planId);
	if (call.method === "settings.write") {
		const { writeSettingControl } = await import("../clio/adapters/settings-controls.js");
		return writeSettingControl(call.params.cwd, call.params.write);
	}
	throw new AppProblem("unsupported", "Method is not available in the ops worker.");
});
