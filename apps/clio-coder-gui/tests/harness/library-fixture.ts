import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * A hang guard for one source CLI, not a performance budget. With the run's tsx
 * cache shared (tests/harness/tmp-root.ts) the slowest oracle CLI took 2.5 s and
 * the seed 0.4 s at load ~19; on a cold cache, as on a fresh CI host, 7.6 s and
 * 0.8 s. Before the cache was shared every run paid the cold cost. 30 s is 4x the
 * cold worst case and 12x the warm one.
 */
const CLI_HANG_GUARD_MS = 30_000;
export async function seedLibrary(cwd: string, env: NodeJS.ProcessEnv) {
	await promisify(execFile)(
		process.execPath,
		["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../fixtures/library-seed.ts", import.meta.url)), cwd],
		{ env, timeout: CLI_HANG_GUARD_MS, maxBuffer: 1024 * 1024 },
	);
}
/**
 * The CLI both sides of a library comparison run: the server through `CLIO_CODER_WEB_CLI`, the oracle directly.
 * It is the checkout's source, so a missing or stale `dist/` cannot make the server answer with a problem or
 * agree with old code.
 */
export const sourceCli = fileURLToPath(new URL("../fixtures/source-cli.mjs", import.meta.url));
export const sourceCliEnv = { CLIO_CODER_WEB_CLI: sourceCli } as const;

export async function libraryOracle(cwd: string, env: NodeJS.ProcessEnv) {
	const cli = sourceCli;
	const run = async (argv: string[]) =>
		JSON.parse(
			(
				await promisify(execFile)(process.execPath, [cli, ...argv], {
					cwd,
					env,
					timeout: CLI_HANG_GUARD_MS,
					maxBuffer: 8 * 1024 * 1024,
				})
			).stdout,
		);
	const [recipes, packages, agents, extensions, verifiers] = await Promise.all([
		run(["library", "components", "--json"]),
		run(["library", "list", "--json"]),
		run(["agents", "--json"]),
		run(["extensions", "list", "--all", "--json"]),
		run(["verifiers", "inspect", "--json"]),
	]);
	return { recipes, packages, agents, extensions, verifiers };
}
