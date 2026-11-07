import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
export async function seedLibrary(cwd: string, env: NodeJS.ProcessEnv) {
	await promisify(execFile)(
		process.execPath,
		["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../fixtures/library-seed.ts", import.meta.url)), cwd],
		{ env, timeout: 30_000, maxBuffer: 1024 * 1024 },
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
					timeout: 30_000,
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
