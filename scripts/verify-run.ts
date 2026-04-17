import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = [
	"CLIO_HOME",
	"CLIO_DATA_DIR",
	"CLIO_CONFIG_DIR",
	"CLIO_CACHE_DIR",
	"CLIO_WORKER_FAUX",
	"CLIO_WORKER_FAUX_MODEL",
	"CLIO_WORKER_FAUX_TEXT",
] as const;

async function main(): Promise<void> {
	const projectRoot = process.cwd();
	const cliPath = join(projectRoot, "dist", "cli", "index.js");
	if (!existsSync(cliPath)) {
		process.stdout.write("verify-run: dist missing; running npm run build\n");
		execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	}

	const home = mkdtempSync(join(tmpdir(), "clio-verify-run-"));
	const snapshot = new Map<string, string | undefined>();
	for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);
	for (const key of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[key];
	}
	process.env.CLIO_HOME = home;
	process.env.CLIO_WORKER_FAUX = "1";
	process.env.CLIO_WORKER_FAUX_MODEL = "faux-model";
	process.env.CLIO_WORKER_FAUX_TEXT = "hello from faux worker";

	try {
		let stdout = "";
		let exitCode = 0;
		try {
			stdout = execFileSync("node", [cliPath, "run", "scout", "--faux", "hello"], {
				env: process.env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; status?: number };
			stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
			exitCode = e.status ?? 1;
		}
		assert.equal(exitCode, 0, `clio run exit=${exitCode}\n${stdout}`);
		assert.ok(stdout.includes("receipt:"), `missing receipt line:\n${stdout}`);
		assert.ok(stdout.includes("agent_end") || stdout.includes("agent="), `missing worker event output:\n${stdout}`);
		process.stdout.write("verify-run: OK\n");
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		for (const [key, value] of snapshot) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
