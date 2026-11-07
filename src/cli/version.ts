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
	// The version stays alone on the first line: fleet preflight reads only that one.
	const { findPinnedTool } = await import("../domains/toolchain/registry.js");
	const herdr = findPinnedTool("herdr");
	const credit = herdr === null ? "" : `Panes powered by herdr ${herdr.version} (${herdr.license})\n`;
	process.stdout.write(`Clio Coder ${readClioVersionLabel()}\n${credit}`);
	return 0;
}
