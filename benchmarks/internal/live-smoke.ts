/**
 * Live smoke: one real headless turn through the built binary.
 *
 * Proves that the configured target answers through Clio's own provider path:
 * `--version`, `doctor --fix` against an empty home, then `run` with a prompt
 * whose expected reply is known. `--delegation` adds the external ACP agents
 * (opencode, copilot), which must be installed locally.
 *
 *   npm run live:smoke -- --target <id> [--model <id>] [--thinking <level>] [--delegation] [--keep]
 */
import {
	clio,
	parseLiveArgs,
	prepareLiveHome,
	rejectUnknown,
	requireBuild,
	runDriver,
	takeSwitch,
} from "./live-target.js";

const USAGE = `usage: npm run live:smoke -- --target <id> [--model <wireId>] [--thinking <level>] [--delegation] [--keep]

One real headless turn against a configured target. Needs dist/ (npm run build).
--delegation also drives the opencode and copilot ACP agents, which must be on PATH.
`;

const DELEGATION_AGENTS = [
	{ id: "opencode", command: "opencode", args: ["acp", "--cwd", "."], toolGovernance: "clio-policy" as const },
	{ id: "copilot", command: "copilot", args: ["--acp"], toolGovernance: "clio-policy" as const },
];

await runDriver(USAGE, async () => {
	requireBuild();
	const args = parseLiveArgs(process.argv.slice(2));
	const delegation = takeSwitch(args.rest, "--delegation");
	rejectUnknown(args.rest);

	const home = prepareLiveHome(args, {
		prefix: "clio-live-smoke-",
		autonomy: "full-auto",
		settings(settings) {
			if (delegation) settings.delegation.agents = DELEGATION_AGENTS.map((agent) => ({ ...agent }));
		},
	});
	process.stdout.write(`live smoke: target=${home.target.id} runtime=${home.target.runtime} model=${home.model}\n`);

	let passed = false;
	try {
		const expect = async (label: string, cliArgs: string[], timeoutMs: number, needle: string | null): Promise<void> => {
			process.stdout.write(`\n$ clio-coder ${cliArgs.join(" ")}\n`);
			const result = await clio(home, cliArgs, { timeoutMs });
			const stdout = home.redact(result.stdout);
			const stderr = home.redact(result.stderr);
			process.stdout.write(stdout);
			if (stderr.trim()) process.stderr.write(stderr);
			if (result.code !== 0) throw new Error(`${label} exited ${String(result.code)}`);
			if (needle && !stdout.toLowerCase().includes(needle)) throw new Error(`${label} did not print "${needle}"`);
		};

		await expect("--version", ["--version"], 15_000, null);
		await expect("doctor --fix", ["doctor", "--fix"], 30_000, null);
		await expect("run", ["--no-context-files", "run", "Reply with exactly: clio-live-ok"], 180_000, "clio-live-ok");
		if (delegation) {
			for (const agent of ["opencode", "copilot"]) {
				await expect(
					`run --agent ${agent}`,
					["run", "--agent", agent, `Reply with exactly: clio-${agent}-ok`],
					180_000,
					`clio-${agent}-ok`,
				);
				await expect(
					`run --agent ${agent} (tool use)`,
					[
						"run",
						"--agent",
						agent,
						`Create a file named scratch/live-smoke-${agent}.txt containing '${agent}-tool-ok', then read it back and print it.`,
					],
					180_000,
					`${agent}-tool-ok`,
				);
			}
		}
		passed = true;
		process.stdout.write("\nlive smoke: PASS\n");
	} catch (error) {
		process.stderr.write(`\nlive smoke: FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
	} finally {
		home.cleanup(passed);
	}
	return passed;
});
