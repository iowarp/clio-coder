/**
 * Bootstrap Clio's config/data/state/cache directories on first install.
 * Creates the full directory tree required by subsequent domains and writes
 * defaults when absent. Idempotent.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	/**
	 * When Clio was first installed on this machine, present only when that is
	 * actually known. Absent on a record this process had to synthesize over a
	 * state root that already existed, where the install time is unrecoverable.
	 */
	installedAt?: string;
	upgradedAt?: string;
	/**
	 * When this record was rebuilt because it was missing or unreadable. A repair
	 * is not an install and must never be written into `installedAt`: `clio-coder
	 * doctor --fix` over a wiped state root reported the repair minute as the day
	 * the user installed Clio, and every later run repeated it as fact.
	 */
	repairedAt?: string;
	/**
	 * The version on record before the most recent version change, kept so the
	 * first interactive launch after an upgrade can say where it came from and
	 * `doctor` can show it. Absent on a home that has never changed version.
	 */
	upgradedFrom?: string;
	/**
	 * The version whose upgrade notice the operator has already seen. Written
	 * by the interactive boot, once per version, so the notice never repeats.
	 */
	noticedVersion?: string;
	platform: string;
	nodeVersion: string;
}

export function initializeClioHome(): InitReport {
	enforceHomePrefixGuard();

	// Probed from the resolved paths, before the accessors below create them:
	// clioStateDir() makes the directory it is being asked about, so anything
	// checked after it reports a first install on every run. A root that is
	// already there means whatever this call is about to write is a repair.
	const resolved = resolveClioDirs();
	const preexistingHome = existsSync(resolved.state) || existsSync(resolved.config) || existsSync(resolved.data);

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

	// Structure only: an existing settings.yaml is never read, validated, or
	// rewritten here. Content validation belongs to readSettings/doctor.
	const settingsPath = join(configDir, "settings.yaml");
	let touched = false;
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, DEFAULT_SETTINGS_YAML, { encoding: "utf8", mode: 0o644 });
		created.push(settingsPath);
		touched = true;
	}

	const credentialsPath = join(configDir, "credentials.yaml");
	if (!existsSync(credentialsPath)) {
		writeFileSync(
			credentialsPath,
			"# Managed via `clio-coder auth`. Do not edit manually unless you know what you are doing.\n{}\n",
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		chmodSync(credentialsPath, 0o600);
		created.push(credentialsPath);
	}

	// installedAt is written exactly once, at first install. Any later
	// version/platform/node change preserves it and stamps upgradedAt instead.
	const installPath = join(stateDir, "install.json");
	const installMetadata = readInstallMetadata(installPath);
	const currentVersion = readClioVersion();
	if (!installMetadata) {
		const payload: InstallMetadata = {
			version: currentVersion,
			// A first install knows when it happened. A repair does not, and saying
			// `installedAt: now` there is a fact this process invented.
			...(preexistingHome ? { repairedAt: new Date().toISOString() } : { installedAt: new Date().toISOString() }),
			platform: process.platform,
			nodeVersion: process.version,
		};
		writeFileSync(installPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		created.push(installPath);
	} else if (
		installMetadata.version !== currentVersion ||
		installMetadata.platform !== process.platform ||
		installMetadata.nodeVersion !== process.version
	) {
		// A version change is the upgrade the record is about; a node or platform
		// change alone keeps whatever earlier transition was on record.
		const upgradedFrom =
			installMetadata.version !== currentVersion ? installMetadata.version : installMetadata.upgradedFrom;
		const payload: InstallMetadata = {
			version: currentVersion,
			...(installMetadata.installedAt !== undefined ? { installedAt: installMetadata.installedAt } : {}),
			...(installMetadata.repairedAt !== undefined ? { repairedAt: installMetadata.repairedAt } : {}),
			...(upgradedFrom !== undefined ? { upgradedFrom } : {}),
			...(installMetadata.noticedVersion !== undefined ? { noticedVersion: installMetadata.noticedVersion } : {}),
			upgradedAt: new Date().toISOString(),
			platform: process.platform,
			nodeVersion: process.version,
		};
		writeFileSync(installPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	}

	return { configDir, dataDir, stateDir, cacheDir, createdPaths: created, touchedSettings: touched };
}

function readInstallMetadata(path: string): InstallMetadata | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallMetadata>;
		// Either stamp is enough to call the record ours. Requiring installedAt
		// would make every repaired record look corrupt and get re-synthesized on
		// the next run, moving the repair time forward each time.
		if (
			typeof parsed.version === "string" &&
			(typeof parsed.installedAt === "string" || typeof parsed.repairedAt === "string") &&
			typeof parsed.platform === "string" &&
			typeof parsed.nodeVersion === "string"
		) {
			return {
				version: parsed.version,
				...(typeof parsed.installedAt === "string" ? { installedAt: parsed.installedAt } : {}),
				...(typeof parsed.upgradedAt === "string" ? { upgradedAt: parsed.upgradedAt } : {}),
				...(typeof parsed.repairedAt === "string" ? { repairedAt: parsed.repairedAt } : {}),
				...(typeof parsed.upgradedFrom === "string" ? { upgradedFrom: parsed.upgradedFrom } : {}),
				...(typeof parsed.noticedVersion === "string" ? { noticedVersion: parsed.noticedVersion } : {}),
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
 * sandbox when the parent has CLIO_CODER_CONFIG_DIR/CLIO_CODER_DATA_DIR/CLIO_CODER_STATE_DIR/
 * CLIO_CODER_CACHE_DIR set and the test only overrides CLIO_CODER_HOME. Individual env
 * vars take precedence over CLIO_CODER_HOME inside resolveClioDirs, so a test that
 * forgets to override all five will silently inherit the parent's paths and
 * write into the wrong sandbox.
 *
 * Enable by setting CLIO_CODER_REQUIRE_HOME_PREFIX=1 in the test env. The test
 * harness in tests/harness/spawn.ts opts in by default. We deliberately do
 * not enable this in production because dev installs may legitimately point
 * individual dirs outside CLIO_CODER_HOME.
 */
function enforceHomePrefixGuard(): void {
	if (process.env.CLIO_CODER_REQUIRE_HOME_PREFIX !== "1") return;
	const home = process.env.CLIO_CODER_HOME?.trim();
	if (!home) return;
	const dirs = resolveClioDirs();
	const offenders: string[] = [];
	if (!dirs.config.startsWith(home)) offenders.push(`configDir=${dirs.config}`);
	if (!dirs.data.startsWith(home)) offenders.push(`dataDir=${dirs.data}`);
	if (!dirs.state.startsWith(home)) offenders.push(`stateDir=${dirs.state}`);
	if (!dirs.cache.startsWith(home)) offenders.push(`cacheDir=${dirs.cache}`);
	if (offenders.length === 0) return;
	throw new Error(
		`CLIO_CODER_REQUIRE_HOME_PREFIX guardrail tripped: resolved Clio directories escape CLIO_CODER_HOME=${home}. ` +
			`Offending paths: ${offenders.join(", ")}. ` +
			`Individual overrides CLIO_CODER_CONFIG_DIR, CLIO_CODER_DATA_DIR, CLIO_CODER_STATE_DIR, and CLIO_CODER_CACHE_DIR take precedence ` +
			`over CLIO_CODER_HOME, so a test that sets only CLIO_CODER_HOME inherits whatever the parent process configured. ` +
			`Override all five env vars in lockstep to scratch subdirs (CLIO_CODER_HOME plus CLIO_CODER_CONFIG_DIR, ` +
			`CLIO_CODER_DATA_DIR, CLIO_CODER_STATE_DIR, CLIO_CODER_CACHE_DIR pointing under it), then call resetXdgCache().`,
	);
}
