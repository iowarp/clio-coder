import { Worker } from "node:worker_threads";
import type { WorkerKind, WorkerSettings } from "./worker/protocol.js";

/** All application-owned process/thread creation enters here. Root seams own their internal probes. */
export function startDomainWorker(
	kind: WorkerKind,
	settings: WorkerSettings = {},
	env: NodeJS.ProcessEnv = process.env,
): Worker {
	const entry =
		kind === "reads"
			? new URL("./worker/reads-main.ts", import.meta.url)
			: new URL("./worker/ops-main.ts", import.meta.url);
	return new Worker(entry, { workerData: settings, env });
}
