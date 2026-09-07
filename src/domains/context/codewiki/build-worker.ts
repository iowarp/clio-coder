import { parentPort, workerData } from "node:worker_threads";
import { executeCodewikiBuildOutcome } from "./build-operation.js";
import type { CodewikiBuildWorkerMessage, CodewikiBuildWorkerRequest } from "./build-worker-protocol.js";

const port = parentPort;
if (!port) throw new Error("codewiki build worker requires a worker_threads parent");

executeCodewikiBuildOutcome(workerData as CodewikiBuildWorkerRequest).then(
	(result) => {
		port.postMessage({ ok: true, result } satisfies CodewikiBuildWorkerMessage);
		port.close();
	},
	(error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		port.postMessage({
			ok: false,
			error: message,
			...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
		} satisfies CodewikiBuildWorkerMessage);
		port.close();
	},
);
