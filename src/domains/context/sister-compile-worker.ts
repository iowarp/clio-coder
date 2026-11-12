import { parentPort, workerData } from "node:worker_threads";
import {
	compileSisterRules,
	type SisterCompileInput,
	type SisterCompileWorkerMessage,
} from "./sister-repository-compile.js";

const port = parentPort;
if (!port) throw new Error("sister compile worker requires a worker_threads parent");

let message: SisterCompileWorkerMessage;
try {
	message = { ok: true, result: compileSisterRules(workerData as SisterCompileInput) };
} catch (error) {
	message = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
port.postMessage(message);
port.close();
