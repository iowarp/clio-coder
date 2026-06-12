/**
 * Bootstrap Clio's config/data/state/cache directories on first install.
 * Creates the full directory tree required by subsequent domains and writes
 * defaults when absent. Idempotent.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS_YAML } from "./defaults.js";
import { readClioVersion } from "./package-root.js";
import { clioCacheDir, clioConfigDir, clioDataDir, clioStateDir, resolveClioDirs } from "./xdg.js";

export interface InitReport {
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	createdPaths: string[];
	touchedSettings: boolean;
}

const CONFIG_SUBDIRS = ["agents"] as const;
const DATA_SUBDIRS = ["memory", "evidence", "evals"] as const;
const STATE_SUBDIRS = ["sessions", "audit", "receipts", "interviews", "scratch"] as const;

interface InstallMetadata {
	version: string;
	installedAt: string;
	platform: string;
	nodeVersion: string;
}

export function initializeClioHome(): InitReport {
	enforceHomePrefixGuard();

	const configDir = clioConfigDir();
	const dataDir = clioDataDir();
	const stateDir = clioStateDir();
	const cacheDir = clioCacheDir();

	const created: string[] = [];

	for (const dir of [configDir, dataDir, stateDir, cacheDir]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			created.push(dir);
		}
	}

	const subdirSets: ReadonlyArray<[string, ReadonlyArray<string>]> = [
		[configDir, CONFIG_SUBDIRS],
		[dataDir, DATA_SUBDIRS],
		[stateDir, STATE_SUBDIRS],
	];
	for (const [root, subs] of subdirSets) {
		for (const sub of subs) {
			const full = join(root, sub);
			if (!existsSync(full)) {
				mkdirSync(full, { recursive: true });
				created.push(full);
			}
		}
	}

	const settingsPath = join(configDir, "settings.yaml");
	let touched = false;
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, DEFAULT_SETTINGS_YAML, { encoding: "utf8", mode: 0o644 });
		created.push(settingsPath);
		touched = true;
	} else {
		// Sanity check: parse to catch broken edits; leave the file untouched.
		parseYaml(readFileSync(settingsPath, "utf8"));
	}

	const credentialsPath = join(configDir, "credentials.yaml");
	if (!existsSync(credentialsPath)) {
		writeFileSync(
			credentialsPath,
			"# Managed via `clio auth`. Do not edit manually unless you know what you are doing.\n{}\n",
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		chmodSync(credentialsPath, 0o600);
		created.push(credentialsPath);
	}

	const installPath = join(stateDir, "install.json");
	const installMetadata = readInstallMetadata(installPath);
	const currentVersion = readClioVersion();
	if (
		!installMetadata ||
		installMetadata.version !== currentVersion ||
		installMetadata.platform !== process.platform ||
		installMetadata.nodeVersion !== process.version
	) {
		const payload = {
			version: currentVersion,
			installedAt: new Date().toISOString(),
			platform: process.platform,
			nodeVersion: process.version,
		};
		writeFileSync(installPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		if (!installMetadata) created.push(installPath);
	}

	return { configDir, dataDir, stateDir, cacheDir, createdPaths: created, touchedSettings: touched };
}

function readInstallMetadata(path: string): InstallMetadata | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallMetadata>;
		if (
			typeof parsed.version === "string" &&
			typeof parsed.installedAt === "string" &&
			typeof parsed.platform === "string" &&
			typeof parsed.nodeVersion === "string"
		) {
			return {
				version: parsed.version,
				installedAt: parsed.installedAt,
				platform: parsed.platform,
				nodeVersion: parsed.nodeVersion,
			};
		}
	} catch {
		// Repaired below by overwriting install.json with current metadata.
	}
	return null;
}

/**
 * Opt-in safety check that prevents tests from clobbering a parent process's
 * sandbox when the parent has CLIO_CONFIG_DIR/CLIO_DATA_DIR/CLIO_STATE_DIR/
 * CLIO_CACHE_DIR set and the test only overrides CLIO_HOME. Individual env
 * vars take precedence over CLIO_HOME inside resolveClioDirs, so a test that
 * forgets to override all five will silently inherit the parent's paths and
 * write into the wrong sandbox.
 *
 * Enable by setting CLIO_REQUIRE_HOME_PREFIX=1 in the test env. The test
 * harness in tests/harness/spawn.ts opts in by default. We deliberately do
 * not enable this in production because dev installs may legitimately point
 * individual dirs outside CLIO_HOME.
 */
function enforceHomePrefixGuard(): void {
	if (process.env.CLIO_REQUIRE_HOME_PREFIX !== "1") return;
	const home = process.env.CLIO_HOME?.trim();
	if (!home) return;
	const dirs = resolveClioDirs();
	const offenders: string[] = [];
	if (!dirs.config.startsWith(home)) offenders.push(`configDir=${dirs.config}`);
	if (!dirs.data.startsWith(home)) offenders.push(`dataDir=${dirs.data}`);
	if (!dirs.state.startsWith(home)) offenders.push(`stateDir=${dirs.state}`);
	if (!dirs.cache.startsWith(home)) offenders.push(`cacheDir=${dirs.cache}`);
	if (offenders.length === 0) return;
	throw new Error(
		`CLIO_REQUIRE_HOME_PREFIX guardrail tripped: resolved Clio directories escape CLIO_HOME=${home}. ` +
			`Offending paths: ${offenders.join(", ")}. ` +
			`Individual overrides CLIO_CONFIG_DIR, CLIO_DATA_DIR, CLIO_STATE_DIR, and CLIO_CACHE_DIR take precedence ` +
			`over CLIO_HOME, so a test that sets only CLIO_HOME inherits whatever the parent process configured. ` +
			`Override all five env vars in lockstep to scratch subdirs (CLIO_HOME plus CLIO_CONFIG_DIR, ` +
			`CLIO_DATA_DIR, CLIO_STATE_DIR, CLIO_CACHE_DIR pointing under it), then call resetXdgCache().`,
	);
}
