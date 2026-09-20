// Node 22 does not install the parent's tsx hooks in Worker entry modules.
// Register inside the worker before importing either TypeScript entry.
import { workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
if (workerData.kind === "reads") await import("./reads-main.ts");
else if (workerData.kind === "ops") await import("./ops-main.ts");
else throw new Error("Unknown domain worker kind.");
