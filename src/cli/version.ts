import { readClioVersionLabel } from "../core/build-info.js";

/**
 * `--worker-specs` prints the worker spec versions this install's worker
 * reads, space separated, for fleet preflight. A build older than the flag
 * ignores it and prints its version line, which preflight reads as unreported.
 */
export async function runVersionCommand(args: ReadonlyArray<string> = []): Promise<number> {
	if (args.includes("--worker-specs")) {
		const { WORKER_SPEC_VERSIONS } = await import("../worker/spec-contract.js");
		process.stdout.write(`${WORKER_SPEC_VERSIONS.join(" ")}\n`);
		return 0;
	}
	process.stdout.write(`Clio Coder ${readClioVersionLabel()}\n`);
	return 0;
}
