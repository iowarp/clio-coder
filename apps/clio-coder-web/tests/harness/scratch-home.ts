import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function scratchHome() {
	const path = await mkdtemp(join(tmpdir(), "clio-coder-web-test-"));
	const env = {
		...process.env,
		PATH: "",
		CLIO_CODER_HOME: path,
		...Object.fromEntries(
			["CONFIG", "DATA", "STATE", "CACHE"].map((role) => [`CLIO_CODER_${role}_DIR`, join(path, role.toLowerCase())]),
		),
	};
	return { path, env, close: () => rm(path, { recursive: true, force: true }) };
}
