import { parentPort, workerData } from "node:worker_threads";
import type { HandbookCompileWorkerData, HandbookCompileWorkerMessage } from "./compiled-handbook.js";
import { compileHandbookCache } from "./compiled-handbook-compile.js";

const port = parentPort;
if (!port) throw new Error("handbook compile worker requires a worker_threads parent");
const { root } = workerData as HandbookCompileWorkerData;

let message: HandbookCompileWorkerMessage;
try {
	message = { ok: true, inputs: compileHandbookCache(root) };
} catch (error) {
	message = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
port.postMessage(message);
port.close();
