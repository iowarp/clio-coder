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
export async function libraryOracle(cwd: string, env: NodeJS.ProcessEnv) {
	const cli = fileURLToPath(new URL("../../../../dist/cli/index.js", import.meta.url));
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
		run(["library", "recipes", "--json"]),
		run(["library", "list", "--json"]),
		run(["agents", "--json"]),
		run(["extensions", "list", "--all", "--json"]),
		run(["verifiers", "inspect", "--json"]),
	]);
	return { recipes, packages, agents, extensions, verifiers };
}
