import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	closeServer,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../../../../tests/harness/openai-compat-fixture.js";
import { scratchHome } from "./scratch-home.js";
export const realCli = fileURLToPath(new URL("../../../../dist/cli/index.js", import.meta.url));
export async function realAcpHome() {
	const home = await scratchHome(),
		provider = await startOpenAICompatFixture("Hello from the real Clio CLI.", {
			replyChunks: ["Hello ", "from the ", "real Clio ", "CLI."],
			chunkDelayMs: 100,
		});
	const env = {
		...home.env,
		PATH: process.env.PATH ?? "",
		CLIO_CODER_WEB_CLI: realCli,
		CLIO_CODER_TEST_OPENAI_KEY: "fixture-test-key",
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, [realCli, "doctor", "--fix"], {
				env,
				cwd: home.path,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.once("error", reject);
			child.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`Scratch initialization failed (${code}): ${stderr}`)),
			);
		});
		seedOpenAICompatToolOrchestrator(join(home.path, "config"), provider.url, "suggest");
	} catch (error) {
		await closeServer(provider.server);
		await home.close();
		throw error;
	}
	return {
		home,
		env,
		provider,
		async close() {
			await closeServer(provider.server);
			await home.close();
		},
	};
}
