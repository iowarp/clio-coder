import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 1 Front 3 diag: XDG permutation + install/doctor error matrix.
 *
 * Exercises clio install + clio doctor across the full directory-override
 * permutation surface:
 *   (1) CLIO_HOME only
 *   (2) CLIO_CONFIG_DIR + CLIO_DATA_DIR + CLIO_CACHE_DIR split
 *   (3) XDG_* env vars (Linux only; skipped with a clear message elsewhere)
 *   (4) fresh HOME fallback (no overrides at all)
 *
 * Each permutation:
 *   - runs `clio install` and asserts the expected tree (config + data +
 *     cache dirs, sessions/audit/state/agents/prompts/receipts subdirs under
 *     data, settings.yaml under config, credentials.yaml under config at
 *     0600, install.json under data),
 *   - parses install.json and asserts shape (version, installedAt, platform,
 *     nodeVersion),
 *   - runs `clio doctor` and asserts exit 0 with a fresh install.
 *
 * Then runs three breakage rounds against a dedicated CLIO_HOME:
 *   (A) delete settings.yaml         -> doctor settings.yaml row goes red
 *   (B) chmod credentials.yaml 0644  -> doctor credentials mode row goes red
 *   (C) corrupt install.json         -> doctor install metadata row goes red
 * Between breakages the previous damage is repaired so findings don't mask
 * one another. Every broken doctor run must exit non-zero.
 *
 * Success: clean all ephemeral dirs and exit 0.
 * Failure: keep the ephemeral dirs on disk, log their paths, dump child
 * stdout/stderr, and exit 1.
 */

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const SUBDIRS = ["sessions", "audit", "state", "agents", "prompts", "receipts"] as const;
const CLIO_ENV_VARS = ["CLIO_HOME", "CLIO_CONFIG_DIR", "CLIO_DATA_DIR", "CLIO_CACHE_DIR"] as const;
const XDG_ENV_VARS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

// Any ephemeral tmp dir we created. On failure we keep them; on success we remove.
const createdTmpDirs: string[] = [];

function log(msg: string): void {
	process.stdout.write(`[diag-xdg] ${msg}\n`);
}

function cleanTmpDirs(): void {
	for (const d of createdTmpDirs) {
		rmSync(d, { recursive: true, force: true });
	}
	if (createdTmpDirs.length > 0) log(`cleaned ${createdTmpDirs.length} ephemeral tmp dir(s)`);
}

function fail(msg: string, detail?: string): never {
	process.stderr.write(`[diag-xdg] FAIL: ${msg}\n`);
	if (detail) process.stderr.write(`${detail}\n`);
	if (createdTmpDirs.length > 0) {
		process.stderr.write("[diag-xdg] keeping ephemeral tmp dirs for post-mortem:\n");
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

function mkEphemeral(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), `clio-diag-xdg-${prefix}-`));
	createdTmpDirs.push(d);
	return d;
}

/**
 * Build a clean env. Starts from process.env, then strips every CLIO_* and
 * XDG_* var so a leaked value in the parent shell cannot contaminate a
 * permutation. Callers then layer their intended overrides on top.
 */
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

function assertExists(path: string, label: string): void {
	if (!existsSync(path)) fail(`${label}: expected ${path} to exist`);
}

function assertMode(path: string, expected: number, label: string): void {
	const st = statSync(path);
	const mode = st.mode & 0o777;
	if (mode !== expected) {
		fail(`${label}: expected mode 0o${expected.toString(8)} at ${path}, got 0o${mode.toString(8)}`);
	}
}

interface ExpectedTree {
	configDir: string;
	dataDir: string;
	cacheDir: string;
}

function assertTree(expect: ExpectedTree, label: string): void {
	assertExists(expect.configDir, `${label}: configDir`);
	assertExists(expect.dataDir, `${label}: dataDir`);
	assertExists(expect.cacheDir, `${label}: cacheDir`);
	for (const sub of SUBDIRS) {
		assertExists(join(expect.dataDir, sub), `${label}: ${sub} subdir`);
	}
	const settings = join(expect.configDir, "settings.yaml");
	assertExists(settings, `${label}: settings.yaml`);
	const creds = join(expect.configDir, "credentials.yaml");
	assertExists(creds, `${label}: credentials.yaml`);
	assertMode(creds, 0o600, `${label}: credentials mode`);
	assertExists(join(expect.dataDir, "install.json"), `${label}: install.json`);
}

function assertInstallJson(dataDir: string, label: string): void {
	const path = join(dataDir, "install.json");
	const raw = readFileSync(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		fail(`${label}: install.json failed to parse`, err instanceof Error ? err.message : String(err));
	}
	if (typeof parsed !== "object" || parsed === null) {
		fail(`${label}: install.json is not an object`, raw);
	}
	const obj = parsed as Record<string, unknown>;
	for (const key of ["version", "installedAt", "platform", "nodeVersion"] as const) {
		if (typeof obj[key] !== "string" || (obj[key] as string).length === 0) {
			fail(`${label}: install.json missing or empty ${key}`, raw);
		}
	}
}

interface Permutation {
	id: string;
	label: string;
	env: NodeJS.ProcessEnv;
	expect: ExpectedTree;
}

function permCLIO_HOME(): Permutation {
	const home = mkEphemeral("clio-home");
	const env = cleanEnv();
	env.CLIO_HOME = home;
	return {
		id: "clio-home",
		label: "CLIO_HOME only",
		env,
		expect: {
			configDir: home,
			dataDir: join(home, "data"),
			cacheDir: join(home, "cache"),
		},
	};
}

function permSplit(): Permutation {
	const base = mkEphemeral("split");
	const env = cleanEnv();
	const configDir = join(base, "C");
	const dataDir = join(base, "D");
	const cacheDir = join(base, "X");
	env.CLIO_CONFIG_DIR = configDir;
	env.CLIO_DATA_DIR = dataDir;
	env.CLIO_CACHE_DIR = cacheDir;
	return {
		id: "split",
		label: "split CLIO_CONFIG_DIR / CLIO_DATA_DIR / CLIO_CACHE_DIR",
		env,
		expect: { configDir, dataDir, cacheDir },
	};
}

function permXDG(): Permutation | null {
	if (platform() !== "linux") return null;
	const base = mkEphemeral("xdg");
	const env = cleanEnv();
	const xdgConfig = join(base, "xc");
	const xdgData = join(base, "xd");
	const xdgCache = join(base, "xx");
	const fakeHome = join(base, "xhome");
	env.XDG_CONFIG_HOME = xdgConfig;
	env.XDG_DATA_HOME = xdgData;
	env.XDG_CACHE_HOME = xdgCache;
	env.HOME = fakeHome;
	return {
		id: "xdg",
		label: "XDG_* env vars (linux)",
		env,
		expect: {
			configDir: join(xdgConfig, "clio"),
			dataDir: join(xdgData, "clio"),
			cacheDir: join(xdgCache, "clio"),
		},
	};
}

function permFreshHome(): Permutation | null {
	// Fallback semantics differ by platform. We only assert Linux + macOS.
	const p = platform();
	if (p !== "linux" && p !== "darwin") return null;
	const home = mkEphemeral("freshhome");
	const env = cleanEnv();
	env.HOME = home;
	if (p === "linux") {
		return {
			id: "fresh-home",
			label: "fresh HOME fallback (linux XDG defaults)",
			env,
			expect: {
				configDir: join(home, ".config", "clio"),
				dataDir: join(home, ".local", "share", "clio"),
				cacheDir: join(home, ".cache", "clio"),
			},
		};
	}
	// darwin
	return {
		id: "fresh-home",
		label: "fresh HOME fallback (darwin ~/Library)",
		env,
		expect: {
			configDir: join(home, "Library", "Application Support", "clio"),
			dataDir: join(home, "Library", "Application Support", "clio"),
			cacheDir: join(home, "Library", "Caches", "clio"),
		},
	};
}

function runInstallPermutation(p: Permutation): void {
	log(`perm ${p.id}: ${p.label}`);
	const first = runCli(["install"], p.env);
	if (first.exitCode !== 0) {
		fail(`perm ${p.id}: clio install exited ${first.exitCode}`, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
	}
	if (!first.stdout.includes("created")) {
		fail(`perm ${p.id}: clio install (first) did not report created paths`, first.stdout);
	}
	// Second install must be idempotent.
	const second = runCli(["install"], p.env);
	if (second.exitCode !== 0) {
		fail(`perm ${p.id}: clio install (second) exited ${second.exitCode}`, second.stdout);
	}
	if (!second.stdout.includes("already installed")) {
		fail(`perm ${p.id}: clio install (second) not idempotent`, second.stdout);
	}
	assertTree(p.expect, `perm ${p.id}`);
	assertInstallJson(p.expect.dataDir, `perm ${p.id}`);
	// Doctor must pass on a fresh install.
	const doctor = runCli(["doctor"], p.env);
	if (doctor.exitCode !== 0) {
		fail(
			`perm ${p.id}: clio doctor exited ${doctor.exitCode} on a fresh install`,
			`stdout:\n${doctor.stdout}\nstderr:\n${doctor.stderr}`,
		);
	}
	if (!doctor.stdout.includes("clio version")) {
		fail(`perm ${p.id}: clio doctor missing 'clio version' row`, doctor.stdout);
	}
	log(`perm ${p.id}: install + doctor PASS`);
}

/**
 * Breakage matrix. Uses a dedicated CLIO_HOME so side effects never leak into
 * the permutation runs. Each round repairs its own damage so later rounds
 * observe isolated failures.
 */
function runBreakageMatrix(): void {
	const home = mkEphemeral("break");
	const env = cleanEnv();
	env.CLIO_HOME = home;
	const expect: ExpectedTree = {
		configDir: home,
		dataDir: join(home, "data"),
		cacheDir: join(home, "cache"),
	};

	const install = runCli(["install"], env);
	if (install.exitCode !== 0) {
		fail(`breakage setup: clio install exited ${install.exitCode}`, install.stdout);
	}
	assertTree(expect, "breakage setup");

	const settingsFile = join(expect.configDir, "settings.yaml");
	const credsFile = join(expect.configDir, "credentials.yaml");
	const installJson = join(expect.dataDir, "install.json");

	// Round A: delete settings.yaml.
	const settingsBackup = readFileSync(settingsFile, "utf8");
	rmSync(settingsFile);
	{
		const r = runCli(["doctor"], env);
		if (r.exitCode === 0) {
			fail("breakage A: expected clio doctor to exit non-zero with settings.yaml missing", r.stdout);
		}
		// Row must be red ("!!") and mention the "missing" phrase.
		// The formatter emits lines like `!! settings.yaml           missing (run ...)`.
		const line = r.stdout.split("\n").find((l) => l.includes("settings.yaml"));
		if (!line || !line.startsWith("!!") || !line.includes("missing")) {
			fail("breakage A: settings.yaml row not flagged red as missing", r.stdout);
		}
		log("breakage A (missing settings.yaml): PASS");
	}
	// Repair: put settings back exactly as it was.
	writeFileSync(settingsFile, settingsBackup, { encoding: "utf8", mode: 0o644 });

	// Round B: wrong credentials mode (0644 instead of 0600).
	chmodSync(credsFile, 0o644);
	{
		const r = runCli(["doctor"], env);
		if (r.exitCode === 0) {
			fail("breakage B: expected clio doctor to exit non-zero with credentials mode 0644", r.stdout);
		}
		const line = r.stdout.split("\n").find((l) => l.includes("credentials mode"));
		if (!line || !line.startsWith("!!") || !line.includes("644")) {
			fail("breakage B: credentials mode row not flagged red with detail '644'", r.stdout);
		}
		log("breakage B (credentials mode 0644): PASS");
	}
	// Repair.
	chmodSync(credsFile, 0o600);

	// Round C: corrupt install.json (garbage bytes).
	const installBackup = readFileSync(installJson, "utf8");
	writeFileSync(installJson, "this is not json {{{");
	{
		const r = runCli(["doctor"], env);
		if (r.exitCode === 0) {
			fail("breakage C: expected clio doctor to exit non-zero with corrupt install.json", r.stdout);
		}
		const line = r.stdout.split("\n").find((l) => l.includes("install metadata"));
		if (!line || !line.startsWith("!!") || !line.includes("missing")) {
			fail("breakage C: install metadata row not flagged red with detail 'missing'", r.stdout);
		}
		log("breakage C (corrupt install.json): PASS");
	}
	// Repair (idempotent reinstall would not rewrite; restore manually).
	writeFileSync(installJson, installBackup, "utf8");

	// Sanity: doctor must be green again after all repairs.
	const after = runCli(["doctor"], env);
	if (after.exitCode !== 0) {
		fail(
			`breakage cleanup: expected doctor to pass after repairs but exited ${after.exitCode}`,
			`stdout:\n${after.stdout}\nstderr:\n${after.stderr}`,
		);
	}
	log("breakage cleanup: doctor green after repairs");
}

function main(): void {
	ensureBuilt();

	const permutations: Permutation[] = [];
	permutations.push(permCLIO_HOME());
	permutations.push(permSplit());
	const xdg = permXDG();
	if (xdg) permutations.push(xdg);
	else log(`perm xdg: SKIPPED on platform ${platform()}`);
	const fresh = permFreshHome();
	if (fresh) permutations.push(fresh);
	else log(`perm fresh-home: SKIPPED on platform ${platform()}`);

	for (const p of permutations) runInstallPermutation(p);
	runBreakageMatrix();

	log(`PASS: ${permutations.length} permutation(s) + 3 breakage rounds`);
	cleanTmpDirs();
	process.exit(0);
}

try {
	main();
} catch (err) {
	process.stderr.write(`[diag-xdg] unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
	if (createdTmpDirs.length > 0) {
		process.stderr.write("[diag-xdg] keeping ephemeral tmp dirs for post-mortem:\n");
		for (const d of createdTmpDirs) process.stderr.write(`  ${d}\n`);
	}
	process.exit(1);
}
