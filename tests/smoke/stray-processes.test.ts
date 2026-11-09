import { ok } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { processAlive, stopProcessesCarrying } from "../harness/stray-processes.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TMP_ROOT_HARNESS = join(ROOT, "tests", "harness", "tmp-root.ts");

/**
 * Starts a stand-in pane host the way a launcher does: detached, by a process
 * that exits at once, so nothing in the tree leads back to whoever started it.
 * Its argv reads `herdr ... server`, which is what the stray scan matches.
 */
const ABANDON_HOST = `
const { spawn } = require("node:child_process");
const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "server"], {
	argv0: "herdr",
	detached: true,
	stdio: "ignore",
});
host.unref();
process.stdout.write(String(host.pid));
`;

function abandonHost(env: NodeJS.ProcessEnv): number {
	const result = spawnSync(process.execPath, ["-e", ABANDON_HOST], { env, encoding: "utf8" });
	const pid = Number(result.stdout);
	ok(Number.isInteger(pid) && pid > 0, result.stderr);
	return pid;
}

function killQuietly(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

describe("stray pane hosts", { skip: process.platform !== "linux" }, () => {
	it("stopProcessesCarrying returns only once an abandoned host has exited", async () => {
		const home = mkdtempSync(join(tmpdir(), "clio-coder-stray-home-"));
		const pid = abandonHost({ ...process.env, CLIO_CODER_HOME: home });
		try {
			ok(processAlive(pid), "the stand-in host is running");
			const stopped = await stopProcessesCarrying("CLIO_CODER_HOME", home);
			ok(
				stopped.some((stray) => stray.pid === pid && stray.herdrHost),
				"the scan names it as a pane host",
			);
			ok(!processAlive(pid), "the host has exited when the stop returns");
		} finally {
			killQuietly(pid);
			rmSync(home, { recursive: true, force: true });
		}
	});

	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		it(`a run stopped by ${signal} still stops the pane host a test abandoned`, async () => {
			// A fresh run root nested in this run's, owned by the child below.
			const parent = mkdtempSync(join(tmpdir(), "clio-coder-stray-run-"));
			const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: parent };
			delete env.CLIO_CODER_TEST_TMP_ROOT;
			const runner = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					"--import",
					TMP_ROOT_HARNESS,
					"-e",
					"process.stdout.write(process.env.CLIO_CODER_TEST_TMP_ROOT + '\\n'); setInterval(() => {}, 1000);",
				],
				{ env, stdio: ["ignore", "pipe", "pipe"] },
			);
			let host = 0;
			let stderr = "";
			runner.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			try {
				const root = await new Promise<string>((resolve, reject) => {
					let out = "";
					runner.stdout.on("data", (chunk: Buffer) => {
						out += chunk.toString();
						if (out.includes("\n")) resolve(out.trim());
					});
					runner.once("exit", (code) => reject(new Error(`runner exited ${code} before it was ready`)));
				});
				host = abandonHost({ ...process.env, CLIO_CODER_TEST_TMP_ROOT: root });
				ok(processAlive(host), "the stand-in host is running");
				// "close", not "exit": stderr has drained once it fires.
				const exited = new Promise((resolve) => runner.once("close", resolve));
				runner.kill(signal);
				await exited;
				const deadline = Date.now() + 2_000;
				while (processAlive(host) && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 25));
				ok(!processAlive(host), `the run's ${signal} teardown left pane host ${host} running`);
				ok(stderr.includes(`${host} herdr`), `the run reports the host it stopped:\n${stderr}`);
			} finally {
				runner.kill("SIGKILL");
				if (host > 0) killQuietly(host);
				rmSync(parent, { recursive: true, force: true });
			}
		});
	}
});
