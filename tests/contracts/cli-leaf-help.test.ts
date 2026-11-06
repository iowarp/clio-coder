/**
 * Every leaf command answers `--help` the way the routers and most leaves do:
 * its usage on stdout, exit 0, and nothing executed. These leaves used to run
 * their strict argument loop first, so `--help` came back as an unknown flag
 * with exit 2, or as "--help needs a value" from `telemetry share`.
 */
import { equal, match } from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeScratchHome } from "../harness/scratch-env.js";

const ENTRY = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const home = makeScratchHome("clio-coder-leaf-help-");
after(() => home.cleanup());

function cli(args: ReadonlyArray<string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ENTRY, ...args], {
			cwd: home.dir,
			env: { ...process.env, ...home.env, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

const CASES: ReadonlyArray<{ args: string[]; usage: RegExp }> = [
	...["inspect", "calls", "cost", "cache", "timeline", "why-stopped", "explain"].map((leaf) => ({
		args: ["telemetry", leaf, "--help"],
		usage: new RegExp(`clio-coder telemetry ${leaf} `),
	})),
	{ args: ["telemetry", "cost", "some-session", "-h"], usage: /clio-coder telemetry cost / },
	...["insights", "consent", "share", "import", "prune", "doctor"].map((leaf) => ({
		args: ["telemetry", leaf, "--help"],
		usage: new RegExp(`clio-coder telemetry ${leaf} `),
	})),
];

describe("leaf commands answer --help", { concurrency: 4 }, () => {
	for (const { args, usage } of CASES) {
		it(`clio-coder ${args.join(" ")} prints its usage and exits 0`, async () => {
			const result = await cli(args);
			equal(result.stderr, "", `${args.join(" ")} wrote to stderr`);
			equal(result.status, 0, result.stdout);
			match(result.stdout, usage);
		});
	}
});
