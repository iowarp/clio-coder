/**
 * Every leaf command answers `--help` the way the routers and most leaves do:
 * its usage on stdout, exit 0, and nothing executed. These leaves used to run
 * their strict argument loop first, so `--help` came back as an unknown flag
 * with exit 2, or as "--help needs a value" from `telemetry share`, whose
 * parser asked any unknown flag for a value before naming it as unknown.
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
	{ args: ["session", "list", "--help"], usage: /clio-coder session list / },
	{ args: ["session", "terminate", "some-session", "--help"], usage: /clio-coder session terminate / },
	{ args: ["interop", "inspect", "--help"], usage: /clio-coder interop <subcommand>/ },
	{ args: ["interop", "adopt", "claude-code", "--yes", "--help"], usage: /clio-coder interop <subcommand>/ },
	{ args: ["verifiers", "inspect", "--help"], usage: /clio-coder verifiers inspect --json/ },
	{ args: ["version", "--help"], usage: /clio-coder version \[--worker-specs \| --build\]/ },
	...["run", "show", "vote", "list", "standings"].map((leaf) => ({
		args: ["arena", leaf, "--help"],
		usage: /clio-coder arena run --contender /,
	})),
	...["start", "status", "report", "list"].map((leaf) => ({
		args: ["research", leaf, "--help"],
		usage: new RegExp(`clio-coder research ${leaf} `),
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

describe("telemetry share names the flag it refuses", { concurrency: 2 }, () => {
	for (const [args, refusal] of [
		[["telemetry", "share", "--bogus"], /error: unknown flag: --bogus\n/],
		[["telemetry", "share", "--repo", "a", "--repo", "b"], /error: repeated flag --repo\n/],
	] as const) {
		it(`clio-coder ${args.join(" ")} exits 2 naming it`, async () => {
			const result = await cli(args);
			equal(result.status, 2, result.stderr);
			match(result.stderr, refusal);
		});
	}
});

describe("config and version refuse what they do not take", { concurrency: 2 }, () => {
	for (const [args, refusal] of [
		[["config", "--jsn"], /error: unknown flag: --jsn\n/],
		[["config", "inspect", "extra"], /error: unexpected argument: extra\n/],
		[["version", "--bogus"], /error: unknown flag: --bogus\n/],
	] as const) {
		it(`clio-coder ${args.join(" ")} exits 2 naming it`, async () => {
			const result = await cli(args);
			equal(result.status, 2, result.stdout);
			equal(result.stdout, "");
			match(result.stderr, refusal);
		});
	}
});
