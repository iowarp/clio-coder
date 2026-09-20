import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export async function seedFleet(cwd: string, env: NodeJS.ProcessEnv) {
	const result = await promisify(execFile)(
		process.execPath,
		["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../fixtures/fleet-seed.ts", import.meta.url)), cwd],
		{ env, timeout: 15_000, maxBuffer: 1024 * 1024 },
	);
	return JSON.parse(result.stdout) as { count: number; gateId: string };
}
