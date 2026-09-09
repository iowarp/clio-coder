import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioStateDir } from "../../../core/xdg.js";
import { parseWorkerContextSeed } from "../../../worker/context-seed.js";
import type { WorkerContextSeed } from "./contract.js";

/** Content-addressed evidence, independent of the parent's live session writer. */
export function persistWorkerContextSeed(input: WorkerContextSeed): string {
	const seed = parseWorkerContextSeed(input);
	const file = join(clioStateDir(), "context-seeds", `${seed.provenance.contentHash}.json`);
	safeResourceWrite(file, `${JSON.stringify(seed)}\n`, { mode: 0o600 });
	// A successful dispatch never names an artifact that was not durably materialized.
	parseWorkerContextSeed(JSON.parse(readFileSync(file, "utf8")));
	return file;
}
