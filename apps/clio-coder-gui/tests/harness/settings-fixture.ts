import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export async function seedSettings(cwd: string, env: NodeJS.ProcessEnv, targetId = "fixture-target") {
	const result = await promisify(execFile)(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			fileURLToPath(new URL("../fixtures/settings-seed.ts", import.meta.url)),
			cwd,
			targetId,
		],
		{ env, timeout: 15_000, maxBuffer: 1024 * 1024 },
	);
	return JSON.parse(result.stdout) as { settingsKeys: string[]; controlPaths: string[]; categories: string[] };
}
