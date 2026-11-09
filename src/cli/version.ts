import { readClioVersionLabel, runningBuildId } from "../core/build-info.js";
import { printError } from "./argv.js";

const HELP = `clio-coder version [--worker-specs | --build]

Print the Clio Coder version; clio-coder --version and -v are the same. --worker-specs
prints the worker spec versions this install's worker reads, space separated. --build
prints the id of this build, or unknown for a source run.
`;

/**
 * `--build` prints the id of the running build, or `unknown`, so fleet
 * preflight can tell two builds of one `-dev` version apart. A build older
 * than the flag rejects it, which preflight reads as an unknown build.
 * `--worker-specs` prints the worker spec versions this install's worker
 * reads, space separated, for fleet preflight. A build older than the flag
 * ignores it and prints its version line, which preflight reads as unreported.
 */
export async function runVersionCommand(args: ReadonlyArray<string> = []): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const unknown = args.find((arg) => arg !== "--worker-specs" && arg !== "--build");
	if (unknown !== undefined) {
		printError(unknown.startsWith("-") ? `unknown flag: ${unknown}` : `unexpected argument: ${unknown}`);
		process.stderr.write(HELP);
		return 2;
	}
	if (args.includes("--build")) {
		process.stdout.write(`${runningBuildId ?? "unknown"}\n`);
		return 0;
	}
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
