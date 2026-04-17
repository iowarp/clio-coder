import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hermetic diag for `clio upgrade` and the state-migration scaffolding.
 *
 * Stages an ephemeral CLIO_HOME, bootstraps it with `clio install`, then
 * exercises the three upgrade modes under CLIO_TEST_UPGRADE_NO_NETWORK so no
 * actual npm traffic is generated:
 *
 *   A. `clio upgrade --dry-run --skip-migrations`
 *      Must exit 0 and print the literal word `would` (dry-run contract).
 *   B. `clio upgrade --skip-migrations`
 *      Must exit 0. Migration manifest must NOT appear because the flag
 *      short-circuits the runner.
 *   C. `clio upgrade` (no flags)
 *      Must exit 0, apply the initial migration, and write a manifest at
 *      `<dataDir>/state/migrations.json` whose `applied` array contains the
 *      initial migration id.
 */

const CLIO_ENV_VARS = ["CLIO_HOME", "CLIO_CONFIG_DIR", "CLIO_DATA_DIR", "CLIO_CACHE_DIR"] as const;
const XDG_ENV_VARS = [
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"XDG_DATA_DIRS",
	"XDG_CONFIG_DIRS",
] as const;

const INITIAL_MIGRATION_ID = "2026-04-17-initial";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const createdTmpDirs: string[] = [];

function log(msg: string): void {
	process.stdout.write(`[diag-upgrade] ${msg}\n`);
}

function cleanTmpDirs(): void {
	for (const d of createdTmpDirs) rmSync(d, { recursive: true, force: true });
	if (createdTmpDirs.length > 0) log(`cleaned ${createdTmpDirs.length} ephemeral tmp dir(s)`);
}

function fail(msg: string, detail?: string): never {
	process.stderr.write(`[diag-upgrade] FAIL: ${msg}\n`);
	if (detail) process.stderr.write(`${detail}\n`);
	if (createdTmpDirs.length > 0) {
		process.stderr.write("[diag-upgrade] keeping ephemeral tmp dirs for post-mortem:\n");
		for (const d of createdTmpDirs) process.stderr.write(`  ${d}\n`);
	}
	process.exit(1);
}

function ensureBuilt(): void {
	if (!existsSync(cliPath)) {
		log("dist/cli/index.js missing; running tsup build");
		execFileSync("npm", ["run", "build"], { stdio: "inherit" });
	}
}

function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of CLIO_ENV_VARS) delete env[k];
	for (const k of XDG_ENV_VARS) delete env[k];
	return env;
}

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): RunResult {
	try {
		const stdout = execFileSync("node", [cliPath, ...args], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			stdout?: Buffer | string;
			stderr?: Buffer | string;
			status?: number;
		};
		const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
		const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
		return { stdout, stderr, exitCode: e.status ?? 1 };
	}
}

function mkEphemeralHome(): { home: string; dataDir: string } {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-upgrade-"));
	createdTmpDirs.push(home);
	return { home, dataDir: join(home, "data") };
}

function main(): void {
	ensureBuilt();

	const { home, dataDir } = mkEphemeralHome();
	const env = cleanEnv();
	env.CLIO_HOME = home;
	env.CLIO_TEST_UPGRADE_NO_NETWORK = "1";

	const install = runCli(["install"], env);
	if (install.exitCode !== 0) {
		fail(`clio install exited ${install.exitCode}`, `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`);
	}

	// Case A: dry-run with --skip-migrations must include the word "would".
	const a = runCli(["upgrade", "--dry-run", "--skip-migrations"], env);
	if (a.exitCode !== 0) {
		fail(`case A: clio upgrade --dry-run exited ${a.exitCode}`, `stdout:\n${a.stdout}\nstderr:\n${a.stderr}`);
	}
	if (!/\bwould\b/.test(a.stdout)) {
		fail("case A: dry-run stdout missing literal 'would'", a.stdout);
	}
	const manifestPath = join(dataDir, "state", "migrations.json");
	if (existsSync(manifestPath)) {
		fail("case A: dry-run must not write migrations.json", `found ${manifestPath}`);
	}
	log("case A (dry-run --skip-migrations): PASS");

	// Case B: --skip-migrations, no network. Exit 0, still no manifest.
	const b = runCli(["upgrade", "--skip-migrations"], env);
	if (b.exitCode !== 0) {
		fail(`case B: clio upgrade --skip-migrations exited ${b.exitCode}`, `stdout:\n${b.stdout}\nstderr:\n${b.stderr}`);
	}
	if (existsSync(manifestPath)) {
		fail("case B: --skip-migrations must not write migrations.json", `found ${manifestPath}`);
	}
	log("case B (--skip-migrations): PASS");

	// Case C: no flags. Must run the initial migration and write manifest.
	const c = runCli(["upgrade"], env);
	if (c.exitCode !== 0) {
		fail(`case C: clio upgrade exited ${c.exitCode}`, `stdout:\n${c.stdout}\nstderr:\n${c.stderr}`);
	}
	if (!existsSync(manifestPath)) {
		fail("case C: expected migrations.json to exist", `looked at ${manifestPath}\nstdout:\n${c.stdout}`);
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (err) {
		fail("case C: migrations.json failed to parse", err instanceof Error ? err.message : String(err));
	}
	const applied = (manifest as { applied?: unknown[] })?.applied;
	if (!Array.isArray(applied) || !applied.includes(INITIAL_MIGRATION_ID)) {
		fail(
			`case C: migrations.json missing initial migration id '${INITIAL_MIGRATION_ID}'`,
			JSON.stringify(manifest, null, 2),
		);
	}
	if (!c.stdout.includes(`applied migration ${INITIAL_MIGRATION_ID}`)) {
		fail("case C: stdout missing 'applied migration' line", c.stdout);
	}
	log("case C (apply initial migration): PASS");

	// Case D: idempotency. A second invocation must not re-apply the same id.
	const d = runCli(["upgrade"], env);
	if (d.exitCode !== 0) {
		fail(`case D: second clio upgrade exited ${d.exitCode}`, `stdout:\n${d.stdout}\nstderr:\n${d.stderr}`);
	}
	if (!d.stdout.includes("no pending migrations")) {
		fail("case D: expected 'no pending migrations' on second invocation", d.stdout);
	}
	log("case D (idempotent re-run): PASS");

	log("PASS: 4 upgrade cases exercised");
	cleanTmpDirs();
	process.exit(0);
}

try {
	main();
} catch (err) {
	process.stderr.write(`[diag-upgrade] unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
	if (createdTmpDirs.length > 0) {
		process.stderr.write("[diag-upgrade] keeping ephemeral tmp dirs for post-mortem:\n");
		for (const d of createdTmpDirs) process.stderr.write(`  ${d}\n`);
	}
	process.exit(1);
}
