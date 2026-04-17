import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Verification script. Builds once, then runs:
 *   clio --version
 *   clio install  (into an ephemeral CLIO_HOME)
 *   clio doctor   (against the install)
 *   clio          (orchestrator boot stub against the install)
 *   verify-prompt.ts
 *   verify-session.ts
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

function checkSettingsTemplate(home: string): void {
	const settingsPath = join(home, "settings.yaml");
	const body = readFileSync(settingsPath, "utf8");
	const requiredLiterals = ["# Example: llama.cpp on the homelab", "mini:", "dynamo:", "# api_key:"];
	for (const literal of requiredLiterals) {
		if (!body.includes(literal)) {
			fail(`settings.yaml missing literal ${JSON.stringify(literal)}; regression of first-install example block`, body);
		}
	}
	try {
		parseYaml(body);
	} catch (err) {
		fail("settings.yaml did not parse after install", (err as Error).message);
	}
	log("settings.yaml example block OK");
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

function checkRegistryPaths(env: NodeJS.ProcessEnv): void {
	// Spawn scripts/diag-registry.ts through tsx so the registry exercises the
	// real domain loader across a subprocess boundary, mirroring the CLI.
	const script = join(projectRoot, "scripts", "diag-registry.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("registry allow + block paths OK");
	} catch (err) {
		fail("registry diag failed", (err as Error).message);
	}
}

function checkPromptCompile(env: NodeJS.ProcessEnv): void {
	const script = join(projectRoot, "scripts", "verify-prompt.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("prompt compile OK");
	} catch (err) {
		fail("prompt compile check failed", (err as Error).message);
	}
}

function checkSessionRoundTrip(env: NodeJS.ProcessEnv): void {
	const script = join(projectRoot, "scripts", "verify-session.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("session round-trip OK");
	} catch (err) {
		fail("session round-trip check failed", (err as Error).message);
	}
}

function checkProvidersCommand(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["providers"], env);
	if (exitCode !== 0) fail(`clio providers exited ${exitCode}`, stdout);
	if (!stdout.includes("anthropic")) fail("clio providers missing anthropic row", stdout);
	if (!stdout.includes("llamacpp")) fail("clio providers missing llamacpp row", stdout);
	log("clio providers OK");
}

function checkAgentsCommand(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["agents"], env);
	if (exitCode !== 0) fail(`clio agents exited ${exitCode}`, stdout);
	if (!stdout.includes("scout")) fail("clio agents missing scout row", stdout);
	if (!stdout.includes("worker")) fail("clio agents missing worker row", stdout);
	log("clio agents OK");
}

function checkToolAdmission(env: NodeJS.ProcessEnv): void {
	const script = join(projectRoot, "scripts", "diag-tools.ts");
	try {
		execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
		log("tool admission OK");
	} catch (err) {
		fail("tool admission diag failed", (err as Error).message);
	}
}

function checkRunCommand(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["run", "scout", "--faux", "hello"], {
		...env,
		CLIO_WORKER_FAUX: "1",
	});
	if (exitCode !== 0) fail(`clio run exited ${exitCode}`, stdout);
	if (!stdout.includes("receipt:")) fail("clio run missing receipt output", stdout);
	if (!stdout.includes("agent_end") && !stdout.includes("agent=")) fail("clio run missing event output", stdout);
	log("clio run (faux) OK");
}

function main(): void {
	ensureBuilt();
	const home = mkdtempSync(join(tmpdir(), "clio-verify-"));
	const env: NodeJS.ProcessEnv = { ...process.env, CLIO_HOME: home };
	log(`ephemeral CLIO_HOME=${home}`);
	checkVersion(env);
	checkInstall(home, env);
	checkSettingsTemplate(home);
	checkDoctor(env);
	checkBoot(env);
	checkRegistryPaths(env);
	checkPromptCompile(env);
	checkSessionRoundTrip(env);
	checkProvidersCommand(env);
	checkAgentsCommand(env);
	checkToolAdmission(env);
	checkRunCommand(env);
	log("all checks passed");
}

main();
