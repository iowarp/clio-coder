/**
 * Intake for the models dispatched workers load (#379). A worker pins every
 * Ollama model it loads with `keep_alive: -1` and exits without releasing it,
 * because releasing on each worker exit would reload the model for every
 * sequential dispatch and pull it out from under a parallel sibling. The
 * orchestrator owns the release instead: each worker report is adopted into
 * this process's residency registries, which keeps the model out of mid-session
 * eviction and lets the release on exit reclaim it.
 *
 * A report carries ids only. The endpoint and any headers come from this
 * process's own resolved target, never from the worker.
 */

import { adoptWorkerLoadedModel } from "../../engine/apis/residency.js";
import type { RuntimeDescriptor, TargetDescriptor } from "../providers/index.js";
import type { RunNodeIdentity } from "./types.js";
import type { WorkerModelLoad } from "./worker-protocol.js";

export interface WorkerModelLoadRoute {
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	node: RunNodeIdentity;
}

function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "[::1]" ||
		host === "0.0.0.0" ||
		/^127(\.\d{1,3}){3}$/u.test(host)
	);
}

/**
 * Adopt one worker report for the route the orchestrator admitted. Returns
 * false, adopting nothing, when the report names another target or model than
 * the admitted route, or when this process cannot reach the server the worker
 * loaded on: a loopback URL on a remote fleet node resolves to that node, not
 * to this host.
 */
export function adoptWorkerModelLoad(load: WorkerModelLoad, route: WorkerModelLoadRoute): boolean {
	if (load.targetId !== route.target.id || load.modelId !== route.wireModelId) return false;
	let baseUrl: string | undefined;
	let headers: Record<string, string> = {};
	let api: string;
	try {
		const model = route.runtime.synthesizeModel(route.target, route.wireModelId, null);
		baseUrl = model.baseUrl;
		headers = { ...(model.headers ?? {}) };
		api = model.api;
	} catch {
		return false;
	}
	if (!baseUrl) return false;
	if (route.node.kind !== "local" && isLoopbackUrl(baseUrl)) return false;
	return adoptWorkerLoadedModel(
		{ runtimeId: api, baseUrl, headers },
		{ modelId: load.modelId, aliasIds: [...load.aliasIds] },
	);
}
