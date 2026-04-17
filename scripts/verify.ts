import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 1 verification script. Builds once, then runs:
 *   clio --version
 *   clio install  (into an ephemeral CLIO_HOME)
 *   clio doctor   (against the install)
 *   clio          (orchestrator boot stub against the install)
 *
 * Exits 0 on success. Any step that deviates from expected output exits 1.
 */

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");

function log(msg: string): void {
	process.stdout.write(`[verify] ${msg}\n`);
}

function fail(msg: string, detail?: string): never {
	process.stderr.write(`[verify] FAIL: ${msg}\n`);
	if (detail) process.stderr.write(`${detail}\n`);
	process.exit(1);
}

function ensureBuilt(): void {
	if (!existsSync(cliPath)) {
		log("dist/cli/index.js missing; running tsup build");
		execFileSync("npm", ["run", "build"], { stdio: "inherit" });
	}
}

function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [cliPath, ...args], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, exitCode: 0 };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; status?: number };
		return {
			stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? ""),
			exitCode: e.status ?? 1,
		};
	}
}

function checkVersion(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["--version"], env);
	if (exitCode !== 0) fail(`clio --version exited ${exitCode}`, stdout);
	if (!stdout.includes("clio ")) fail("clio --version missing 'clio' line", stdout);
	if (!stdout.includes("pi-agent-core")) fail("clio --version missing pi-agent-core line", stdout);
	log("clio --version OK");
}

function checkInstall(home: string, env: NodeJS.ProcessEnv): void {
	const first = runCli(["install"], env);
	if (first.exitCode !== 0) fail(`clio install (first) exited ${first.exitCode}`, first.stdout);
	if (!first.stdout.includes("created")) fail("clio install (first) did not report created paths", first.stdout);

	const second = runCli(["install"], env);
	if (second.exitCode !== 0) fail(`clio install (second) exited ${second.exitCode}`, second.stdout);
	if (!second.stdout.includes("already installed")) fail("clio install (second) not idempotent", second.stdout);

	const settings = join(home, "settings.yaml");
	if (!existsSync(settings)) fail(`expected ${settings} to exist after install`);

	const installJsonDataDir = join(home, "data", "install.json");
	const installJsonDirect = join(home, "install.json");
	if (!existsSync(installJsonDataDir) && !existsSync(installJsonDirect)) {
		fail(`expected install.json under ${installJsonDataDir} or ${installJsonDirect}`);
	}
	log("clio install OK (idempotent)");
}

function checkDoctor(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["doctor"], env);
	if (exitCode !== 0) fail(`clio doctor exited ${exitCode}`, stdout);
	if (!stdout.includes("clio version")) fail("clio doctor missing 'clio version' row", stdout);
	if (!stdout.includes("settings.yaml")) fail("clio doctor missing settings.yaml row", stdout);
	log("clio doctor OK");
}

function checkBoot(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli([], env);
	if (exitCode !== 0) fail(`clio (default) exited ${exitCode}`, stdout);
	if (!stdout.includes("◆ clio")) fail("banner missing from clio default output", stdout);
	log("clio (orchestrator boot) OK");
}

function main(): void {
	ensureBuilt();
	const home = mkdtempSync(join(tmpdir(), "clio-verify-"));
	const env: NodeJS.ProcessEnv = { ...process.env, CLIO_HOME: home };
	log(`ephemeral CLIO_HOME=${home}`);
	checkVersion(env);
	checkInstall(home, env);
	checkDoctor(env);
	checkBoot(env);
	log("all checks passed");
}

main();
