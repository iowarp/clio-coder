import { threadId } from "node:worker_threads";
import { resolvePackageRoot } from "../../../../../src/core/package-root.js";

/** Test-only packaging diagnostics use the same cached root as real domain adapters. */
export function runtimeInfo(entry: string) {
	return { entry, packageRoot: resolvePackageRoot(), execArgv: process.execArgv, threadId };
}
